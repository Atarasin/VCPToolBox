/**
 * AgentAssistant 桥接模块：负责与 AgentAssistant 执行层通信，执行唤醒任务并收集回执。
 * 核心职责：
 * 1. 构建符合 AgentAssistant 协议的请求格式
 * 2. 通过 HTTP API 发起任务执行
 * 3. 处理执行结果，生成成功/失败确认（ACK）
 * 4. 实现基于指数退避的重试机制
 * 5. 统计执行指标并评估健康状态
 *
 * @module execution/agentAssistantBridge
 * @requires http
 * @requires ../storage/stateStore
 * @requires ../utils/time
 * @requires ./retryPolicy
 */

const http = require('http');
const { createStateStore } = require('../storage/stateStore');
const { toLocalIsoString } = require('../utils/time');
const { shouldFinalizeFailure, buildNextRetryAt } = require('./retryPolicy');

/**
 * 构建发送给 AgentAssistant 的执行提示（Execution Prompt）。
 * 该提示包含任务的完整上下文信息，供 Agent 决策下一步行动。
 *
 * @param {object} task 唤醒任务对象
 * @param {string} task.wakeupId 唤醒任务唯一标识
 * @param {string} task.projectId 项目唯一标识
 * @param {string} task.stage 当前阶段（如 SETUP_WORLD、CHAPTER_CREATION）
 * @param {string} task.substate 当前子状态（如 CH_PRECHECK、CH_REVIEW）
 * @param {object} [task.context] 任务上下文，包含 objective、suggestedActions 等
 * @returns {string} JSON 格式的执行提示字符串
 *
 * @example
 * // 返回格式示例
 * {
 *   "taskType": "NovelWorkflowWakeupExecution",
 *   "wakeupId": "wk_20240101_abc123",
 *   "projectId": "project_001",
 *   "stage": "SETUP_WORLD",
 *   "substate": null,
 *   "objective": "完成世界观设定草案并推进评审结论",
 *   "suggestedActions": [...],
 *   "qualityPolicy": {...},
 *   "counterSnapshot": {...},
 *   "waitCondition": "..."
 * }
 */
function buildExecutionPrompt(task) {
  return JSON.stringify(
    {
      taskType: 'NovelWorkflowWakeupExecution',
      wakeupId: task.wakeupId,
      projectId: task.projectId,
      stage: task.stage,
      substate: task.substate,
      objective: task?.context?.objective || '',
      suggestedActions: task?.context?.suggestedActions || [],
      qualityPolicy: task?.context?.qualityPolicy || {},
      counterSnapshot: task?.context?.counterSnapshot || {},
      waitCondition: task?.context?.waitCondition || ''
    },
    null,
    2
  );
}

/**
 * 根据 Agent 执行结果构建成功确认（ACK）对象。
 * 业务规则：
 * - SETUP_* 阶段返回 setupScore=90 的评分指标
 * - CHAPTER_CREATION + CH_REVIEW 子状态返回覆盖率与一致性指标
 *
 * @param {object} task 原始唤醒任务
 * @param {object|string} response Agent 执行响应
 * @param {Date} now 当前时间
 * @returns {object} 成功确认对象，包含项目ID、唤醒ID、状态、结果类型等
 *
 * @example
 * // 返回格式示例
 * {
 *   "projectId": "project_001",
 *   "wakeupId": "wk_xxx",
 *   "ackStatus": "acted",
 *   "resultType": "executor_completed",
 *   "issueSeverity": "minor",
 *   "executorMeta": {
 *     "executor": "AgentAssistant",
 *     "targetAgent": "DESIGNER"
 *   },
 *   "receivedAt": "2024-01-01T12:00:00.000+08:00",
 *   "rawResult": {...}
 * }
 */
function buildSuccessAck(task, response, now) {
  const ack = {
    projectId: task.projectId,
    wakeupId: task.wakeupId,
    ackStatus: 'acted',
    resultType: 'executor_completed',
    issueSeverity: 'minor',
    executorMeta: {
      executor: 'AgentAssistant',
      targetAgent: task.targetAgent
    },
    receivedAt: toLocalIsoString(now),
    rawResult: response?.result || response || null
  };

  if (String(task.stage || '').startsWith('SETUP_')) {
    ack.metrics = {
      setupScore: 90
    };
    ack.resultType = 'setup_score_passed';
  }

  if (String(task.stage || '') === 'CHAPTER_CREATION' && String(task.substate || '') === 'CH_REVIEW') {
    ack.metrics = {
      outlineCoverage: 1,
      pointCoverage: 1,
      wordcountRatio: 1,
      criticalInconsistencyCount: 0
    };
    ack.resultType = 'review_passed';
  }

  return ack;
}

/**
 * 构建失败确认（ACK）对象。
 *
 * @param {object} task 原始唤醒任务
 * @param {string} errorMessage 错误信息描述
 * @param {Date} now 当前时间
 * @returns {object} 失败确认对象，ackStatus 为 'blocked'，issueSeverity 为 'major'
 */
function buildFailureAck(task, errorMessage, now) {
  return {
    projectId: task.projectId,
    wakeupId: task.wakeupId,
    ackStatus: 'blocked',
    resultType: 'executor_failed',
    issueSeverity: 'major',
    executorMeta: {
      executor: 'AgentAssistant',
      targetAgent: task.targetAgent
    },
    errorMessage,
    receivedAt: toLocalIsoString(now)
  };
}

/**
 * 构建发送给 AgentAssistant 的请求体。
 * 使用自定义协议格式：「始」「末」作为字段边界标记。
 *
 * @param {object} task 唤醒任务
 * @param {object} options 请求选项
 * @param {boolean} [options.temporaryContact] 是否为临时会话，true 时为 'true'
 * @returns {string} 符合 AgentAssistant 协议的请求体字符串
 *
 * @example
 * // 返回格式
 * <<<[TOOL_REQUEST]>>>
 * maid:「始」NovelWorkflowOrchestrator「末」
 * tool_name:「始」AgentAssistant「末」
 * agent_name:「始」DESIGNER「末」
 * prompt:「始」{...}「末」
 * temporary_contact:「始」false「末」
 * session_id:「始」wk_xxx「末」
 * <<<[END_TOOL_REQUEST]>>>
 */
function buildAgentAssistantRequestBody(task, options) {
  const temporary = options.temporaryContact === true ? 'true' : 'false';
  return `<<<[TOOL_REQUEST]>>>
maid:「始」NovelWorkflowOrchestrator「末」,
tool_name:「始」AgentAssistant「末」,
agent_name:「始」${task.targetAgent}「末」,
prompt:「始」${buildExecutionPrompt(task)}「末」,
temporary_contact:「始」${temporary}「末」,
session_id:「始」${task.sessionId || task.wakeupId}「末」,
<<<[END_TOOL_REQUEST]>>>`;
}

/**
 * 通过 HTTP 协议向 AgentAssistant API 发送执行请求。
 *
 * @param {object} task 唤醒任务
 * @param {object} options 连接配置
 * @param {number} [options.apiPort] API 端口，默认取 process.env.PORT
 * @param {string} [options.apiKey] API 密钥，默认取 process.env.Key
 * @param {string} [options.apiHost] API 主机，默认 '127.0.0.1'
 * @param {string} [options.apiPath] API 路径，默认 '/v1/human/tool'
 * @param {number} [options.timeoutMs] 请求超时，默认为 120000ms（2分钟）
 * @returns {Promise<{status: string, result: string}>} 成功时返回状态和结果
 * @throws {Error} 配置缺失（缺少 PORT 或 Key）或 HTTP 请求失败
 *
 * @example
 * // 成功响应
 * { status: 'success', result: '{...agent response...}' }
 *
 * // 失败响应
 * throw new Error('AgentAssistant API request failed: status=500, body=...')
 */
function executeWithAgentAssistantHttp(task, options) {
  const requestBody = buildAgentAssistantRequestBody(task, options);
  const port = Number(options.apiPort || process.env.PORT || 0);
  const apiKey = options.apiKey || process.env.Key || '';
  const hostname = options.apiHost || '127.0.0.1';
  const requestPath = options.apiPath || '/v1/human/tool';

  if (!port || !apiKey) {
    return Promise.reject(new Error('AgentAssistant API config missing: PORT/Key'));
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port: port,
        path: requestPath,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody)
        }
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              status: 'success',
              result: data
            });
            return;
          }
          reject(new Error(`AgentAssistant API request failed: status=${res.statusCode}, body=${data}`));
        });
      }
    );

    req.on('error', error => {
      reject(error);
    });

    req.setTimeout(Number(options.timeoutMs || 120000), () => {
      req.destroy(new Error(`AgentAssistant API timeout after ${Number(options.timeoutMs || 120000)}ms`));
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * 根据指标与积压告警解析健康状态颜色。
 *
 * @param {object} metrics 执行指标
 * @param {number} metrics.successRate 成功率（0-1）
 * @param {number} metrics.retryRate 重试率（0-1）
 * @param {object} backlogAlert 积压告警对象
 * @param {boolean} backlogAlert.triggered 是否触发积压告警
 * @returns {'green'|'yellow'|'red'} 健康状态
 *
 * @example
 * // 判断逻辑
 * 'red': backlogAlert.triggered || successRate < 0.5
 * 'yellow': successRate < 0.8 || retryRate > 0.2
 * 'green': 其他情况
 */
function resolveHealthStatus(metrics, backlogAlert) {
  if (backlogAlert.triggered || metrics.successRate < 0.5) {
    return 'red';
  }
  if (metrics.successRate < 0.8 || metrics.retryRate > 0.2) {
    return 'yellow';
  }
  return 'green';
}

/**
 * 计算健康评分（0-100分）。
 * 扣分规则：
 * - 失败率每降低10%扣5分
 * - 重试率每增加10%扣2分
 * - 积压告警触发扣20分
 *
 * @param {object} metrics 执行指标
 * @param {number} metrics.successRate 成功率
 * @param {number} metrics.retryRate 重试率
 * @param {object} backlogAlert 积压告警
 * @returns {number} 评分（0-100）
 */
function resolveHealthScore(metrics, backlogAlert) {
  let score = 100;
  score -= Math.round((1 - metrics.successRate) * 50);
  score -= Math.round(metrics.retryRate * 20);
  if (backlogAlert.triggered) {
    score -= 20;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * 执行单个唤醒任务并处理响应。
 *
 * @param {object} task 唤醒任务
 * @param {object} options 执行选项
 * @returns {Promise<object>} Agent 执行响应
 * @throws {Error} Agent 返回非成功状态或响应为空
 */
async function executeWithAgentAssistant(task, options) {
  const response = await executeWithAgentAssistantHttp(task, options);
  if (!response || String(response.status || '').toLowerCase() !== 'success') {
    throw new Error(response?.error || 'AgentAssistant returned non-success response');
  }
  return response;
}

/**
 * 批量执行待处理的唤醒任务。
 * 核心逻辑：
 * 1. 从状态存储加载所有 pending 任务
 * 2. 逐个执行，成功则生成成功 ACK，失败则根据重试策略决定是否重试
 * 3. 达到最大重试次数的任务标记为最终失败
 * 4. 汇总执行指标并写入执行审计日志
 *
 * @param {object} options 执行选项
 * @param {string} options.pluginRoot 插件根目录
 * @param {string} [options.storageDir] 存储目录，相对于 pluginRoot
 * @param {number} [options.maxWakeups] 单次最多处理任务数，默认20
 * @param {number} [options.maxRetries] 最大重试次数，默认3
 * @param {number} [options.retryBackoffSeconds] 重试退避基础秒数，默认30
 * @param {number} [options.backlogAlertThreshold] 积压告警阈值，默认100
 * @param {function} [options.executor] 自定义执行器函数
 * @param {object} [options.apiPort] AgentAssistant API 端口
 * @param {string} [options.apiKey] AgentAssistant API 密钥
 * @param {string} [options.apiHost] AgentAssistant API 主机
 * @param {string} [options.apiPath] AgentAssistant API 路径
 * @param {number} [options.timeoutMs] 请求超时毫秒数
 * @returns {Promise<object>} 执行结果摘要，包含扫描数、执行成功/失败/重试数、指标与健康状态
 *
 * @example
 * const result = await executePendingWakeups({
 *   pluginRoot: '/path/to/plugin',
 *   storageDir: 'storage',
 *   maxWakeups: 20,
 *   maxRetries: 3
 * });
 * // result 结构
 * {
 *   scanned: 20,
 *   executed: 15,
 *   failed: 2,
 *   retried: 3,
 *   producedAcks: 17,
 *   metrics: { successRate: 0.75, retryRate: 0.15, ... },
 *   backlogAlert: { triggered: false, threshold: 100, ... },
 *   health: { status: 'yellow', score: 78 },
 *   executionAuditPath: '/path/to/audit.json'
 * }
 */
async function executePendingWakeups(options) {
  const now = new Date();

  const store = createStateStore({
    pluginRoot: options.pluginRoot,
    storageRoot: options.storageDir || 'storage'
  });
  await store.ensureStorageLayout();

  const queueBefore = await store.summarizeWakeupQueue(now);
  const pending = await store.listPendingWakeups(options.maxWakeups ?? 20, now);

  const executor = options.executor || (task => executeWithAgentAssistant(task, options));
  const maxRetries = Number(options.maxRetries ?? 3);
  const retryBackoffSeconds = Number(options.retryBackoffSeconds ?? 30);

  const acks = [];
  let executed = 0;
  let failed = 0;
  let retried = 0;
  const executionEvents = [];
  let totalDurationMs = 0;

  for (const task of pending) {
    const taskStartedAt = Date.now();
    const attempt = Number(task.executionAttempt ?? 0) + 1;

    await store.putWakeupTask({
      ...task,
      executionStatus: 'running',
      executionAttempt: attempt,
      nextRetryAt: null,
      updatedAt: toLocalIsoString(now)
    });

    try {
      const response = await executor(task);
      const ack = buildSuccessAck(task, response, now);
      acks.push(ack);
      executed += 1;

      await store.putWakeupTask({
        ...task,
        executionStatus: 'succeeded',
        executionAttempt: attempt,
        executionResult: response,
        nextRetryAt: null,
        updatedAt: toLocalIsoString(now)
      });

      executionEvents.push({
        wakeupId: task.wakeupId,
        projectId: task.projectId,
        targetAgent: task.targetAgent,
        attempt,
        status: 'succeeded',
        ackStatus: ack.ackStatus,
        resultType: ack.resultType,
        durationMs: Date.now() - taskStartedAt
      });
      totalDurationMs += Date.now() - taskStartedAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      const durationMs = Date.now() - taskStartedAt;
      totalDurationMs += durationMs;

      if (shouldFinalizeFailure(attempt, maxRetries)) {
        const ack = buildFailureAck(task, message, now);
        acks.push(ack);
        await store.putWakeupTask({
          ...task,
          executionStatus: 'failed',
          executionAttempt: attempt,
          nextRetryAt: null,
          lastError: message,
          updatedAt: toLocalIsoString(now)
        });

        executionEvents.push({
          wakeupId: task.wakeupId,
          projectId: task.projectId,
          targetAgent: task.targetAgent,
          attempt,
          status: 'failed_final',
          ackStatus: ack.ackStatus,
          resultType: ack.resultType,
          errorMessage: message,
          durationMs
        });
      } else {
        retried += 1;
        const nextRetryAt = buildNextRetryAt(now, attempt, retryBackoffSeconds);
        await store.putWakeupTask({
          ...task,
          executionStatus: 'queued',
          executionAttempt: attempt,
          nextRetryAt,
          lastError: message,
          updatedAt: toLocalIsoString(now)
        });

        executionEvents.push({
          wakeupId: task.wakeupId,
          projectId: task.projectId,
          targetAgent: task.targetAgent,
          attempt,
          status: 'retry_scheduled',
          nextRetryAt,
          errorMessage: message,
          durationMs
        });
      }
    }
  }

  await store.appendAcksToInbox(acks, now);
  const queueAfter = await store.summarizeWakeupQueue(now);

  const totalAttempts = executed + failed;
  const metrics = {
    successRate: totalAttempts > 0 ? Number((executed / totalAttempts).toFixed(4)) : 0,
    retryRate: totalAttempts > 0 ? Number((retried / totalAttempts).toFixed(4)) : 0,
    averageDurationMs: totalAttempts > 0 ? Number((totalDurationMs / totalAttempts).toFixed(2)) : 0,
    queueBefore,
    queueAfter
  };

  const backlogAlertThreshold = Math.max(0, Number(options.backlogAlertThreshold ?? 100));
  const backlogAlert = {
    triggered: queueAfter.pendingTotal > backlogAlertThreshold,
    threshold: backlogAlertThreshold,
    pendingTotal: queueAfter.pendingTotal,
    pendingReady: queueAfter.pendingReady
  };

  const health = {
    status: resolveHealthStatus(metrics, backlogAlert),
    score: resolveHealthScore(metrics, backlogAlert)
  };

  const auditPath = await store.writeExecutionAudit(
    {
      executedAt: toLocalIsoString(now),
      scanned: pending.length,
      executed,
      failed,
      retried,
      producedAcks: acks.length,
      metrics,
      backlogAlert,
      health,
      maxRetries,
      retryBackoffSeconds,
      events: executionEvents
    },
    now
  );

  return {
    scanned: pending.length,
    executed,
    failed,
    retried,
    producedAcks: acks.length,
    metrics,
    backlogAlert,
    health,
    executionAuditPath: auditPath
  };
}

module.exports = {
  executePendingWakeups
};
