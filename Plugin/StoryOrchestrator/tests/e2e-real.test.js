'use strict';

/**
 * StoryOrchestrator 真实端到端测试 (e2e-real.test.js)
 * =============================================================================
 *
 * 此测试调用真实的 LLM API 生成一个完整的短篇小说，验证三阶段工作流
 * （世界观搭建 → 大纲与正文创作 → 打磨与终审）在真实 LLM 调用下能够
 * 完整运行。这不是 mock 测试——每次运行都会消耗真实的 API 额度。
 *
 * -------------------------------------------------------------------------
 * 快速开始
 * -------------------------------------------------------------------------
 * 1. 确保 VCP 服务正在运行:
 *      node server.js
 *
 * 2. 确保根目录 config.env 包含有效的 API 密钥:
 *      Key=your-vcp-key
 *      API_Key=your-llm-provider-key
 *      AGENT_ASSISTANT_URL=http://127.0.0.1:6005
 *
 * 3. 运行测试（快捷方式）:
 *      npm run e2e
 *
 *    或完整命令:
 *      RUN_E2E_TESTS=1 node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
 *
 * 4. 使用低价模型降低成本（推荐）:
 *      RUN_E2E_TESTS=1 E2E_AGENT_MODEL=gpt-4o-mini \
 *        node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
 *
 *    或缩短模式:
 *      npm run e2e:short
 *
 * -------------------------------------------------------------------------
 * 环境变量全览
 * -------------------------------------------------------------------------
 *   RUN_E2E_TESTS=1                  【必需】启用 e2e 测试，未设置则跳过
 *   E2E_TARGET_WORD_COUNT=500        目标字数（默认 500，建议 300-800）
 *   E2E_MAX_WAIT_MS=600000           最大等待时间毫秒（默认 10 分钟）
 *   E2E_POLL_INTERVAL_MS=3000        状态轮询间隔毫秒（默认 3 秒）
 *   E2E_USE_KERNEL_PATH=true         是否使用 WorkflowKernel 路径（默认 true）
 *   E2E_AGENT_MODEL=                 统一覆盖所有 Agent 的模型 ID（可选但推荐）
 *   E2E_CLEANUP=true                 测试后是否删除生成的故事（默认 true）
 *
 * -------------------------------------------------------------------------
 * CI 缩短模式
 * -------------------------------------------------------------------------
 * 在 CI 环境中，建议减小字数以缩短运行时间和降低成本：
 *   RUN_E2E_TESTS=1 E2E_TARGET_WORD_COUNT=300 E2E_MAX_WAIT_MS=300000 \
 *     node --test Plugin/StoryOrchestrator/tests/e2e-real.test.js
 *
 * 注意：本测试目前仍调用真实 LLM。如需完全无成本的 CI 测试，需额外
 * 实现一个 mock LLM 模式（参见 docs/e2e-test-guide.md "CI 策略" 章节）。
 *
 * -------------------------------------------------------------------------
 * 两阶段提取配置
 * -------------------------------------------------------------------------
 * 本测试使用的工作流定义 (config/workflow-definition.js) 配置了
 * ExtractionLayer 的两阶段提取：
 *
 *   Phase 1: Agent 输出自由格式 markdown
 *   Phase 2: ExtractionLayer 按优先级尝试解析器:
 *            jsonBlock → jsonObject → xml → fallbackRaw
 *
 * 每个 extraction schema 配置了 throwOnFailure: false 和 defaultValue: null，
 * 确保格式问题不会导致整个工作流崩溃（由下游 schemaValidate 和 storyValidate
 * 处理数据质量）。详见 modules/workflowKernel/extraction/ExtractionLayer.js
 * 和 Plugin/StoryOrchestrator/config/extraction-schemas.js。
 *
 * -------------------------------------------------------------------------
 * 预期运行时间与费用估算
 * -------------------------------------------------------------------------
 *   目标字数 500 字，使用 gpt-4o-mini（默认 Agent 配置）:
 *     - 运行时间: 约 3-8 分钟（取决于上游 LLM 延迟）
 *     - 预估费用: $0.02 - $0.08 USD
 *
 *   目标字数 500 字，使用 gpt-4o:
 *     - 运行时间: 约 2-6 分钟
 *     - 预估费用: $0.20 - $0.60 USD
 *
 *   实际费用取决于:
 *     - 模型选择（通过 E2E_AGENT_MODEL 或各 AGENT_*_MODEL_ID 配置）
 *     - 上游服务定价（NewAPI / OpenRouter / 直连等）
 *     - 输出 token 量（与目标字数正相关）
 *
 * -------------------------------------------------------------------------
 * 常见故障排查
 * -------------------------------------------------------------------------
 * 1. 超时 (Error: Story did not complete within ...)
 *    → 增加 E2E_MAX_WAIT_MS（如 900000 表示 15 分钟）
 *    → 减少 E2E_TARGET_WORD_COUNT 以降低生成量
 *    → 检查上游 LLM 服务是否响应缓慢
 *
 * 2. 解析错误 / 验证失败 (schemaValidate 或 storyValidate 失败)
 *    → 这是正常的 Agent 输出不稳定现象。工作流已配置 retry policy
 *      (maxAttempts: 3) 和自动修订。如果持续失败，检查模型能力:
 *      - 过于便宜/小型模型可能输出格式不稳定
 *      - 建议至少使用 gpt-4o-mini 或同等能力模型
 *
 * 3. 模型不可用 (404 / 模型未找到)
 *    → 确认 config.env 中配置的模型 ID 在上游服务中可用
 *    → 使用 E2E_AGENT_MODEL=统一指定一个确定可用的模型
 *
 * 4. VCP 服务不可达
 *    → 确认 node server.js 已在运行
 *    → 确认 AGENT_ASSISTANT_URL 与 VCP 实际监听地址一致
 *    → 检查防火墙 / 端口占用
 *
 * 5. 密钥错误 (401 / 403)
 *    → 确认根目录 config.env 中 Key 和 API_Key 有效
 *    → Key 用于 VCP 自身鉴权，API_Key 用于上游 LLM 服务
 *
 * 6. 检查点卡住（状态长期为 checkpoint_pending）
 *    → 本测试会自动批准检查点，但如果 approval 消息丢失可能卡住
 *    → 增加 E2E_POLL_INTERVAL_MS 或减少目标字数重试
 *
 * 完整排错指南: docs/e2e-test-guide.md
 * =============================================================================
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const StoryOrchestratorModule = require('../core/StoryOrchestrator');
const StoryOrchestrator = StoryOrchestratorModule.StoryOrchestrator || StoryOrchestratorModule;

const E2E_ENABLED = process.env.RUN_E2E_TESTS === '1';
const E2E_TARGET_WORD_COUNT = parseInt(process.env.E2E_TARGET_WORD_COUNT, 10) || 500;
const E2E_MAX_WAIT_MS = parseInt(process.env.E2E_MAX_WAIT_MS, 10) || 600000;
const E2E_POLL_INTERVAL_MS = parseInt(process.env.E2E_POLL_INTERVAL_MS, 10) || 3000;
const E2E_USE_KERNEL = process.env.E2E_USE_KERNEL_PATH !== 'false';
const E2E_AGENT_MODEL = process.env.E2E_AGENT_MODEL || '';
const E2E_CLEANUP = process.env.E2E_CLEANUP !== 'false';

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkVcpReachable(agentAssistantUrl, vcpKey) {
  return new Promise((resolve) => {
    const parsed = new URL(`${agentAssistantUrl}/v1/models`);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        family: 4,
        headers: { Authorization: `Bearer ${vcpKey}` },
      },
      (res) => {
        // 200 = OK, 401 = 鉴权通过但可能需要其他权限 — 都说明服务在运行
        resolve(res.statusCode === 200 || res.statusCode === 401);
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function loadConfig() {
  const rootConfigPath = path.join(__dirname, '..', '..', '..', 'config.env');
  const pluginConfigPath = path.join(__dirname, '..', 'config.env');

  let config = {};

  if (fs.existsSync(rootConfigPath)) {
    const dotenv = require('dotenv');
    config = { ...config, ...dotenv.parse(fs.readFileSync(rootConfigPath)) };
  }

  if (fs.existsSync(pluginConfigPath)) {
    const dotenv = require('dotenv');
    config = { ...config, ...dotenv.parse(fs.readFileSync(pluginConfigPath)) };
  }

  return config;
}

function applyAgentModelOverride(config, modelId) {
  if (!modelId) return config;
  const agents = [
    'AGENT_WORLD_BUILDER',
    'AGENT_CHARACTER_DESIGNER',
    'AGENT_PLOT_ARCHITECT',
    'AGENT_CHAPTER_WRITER',
    'AGENT_DETAIL_FILLER',
    'AGENT_LOGIC_VALIDATOR',
    'AGENT_STYLE_POLISHER',
    'AGENT_FINAL_EDITOR',
  ];
  const overridden = { ...config };
  for (const prefix of agents) {
    overridden[`${prefix}_MODEL_ID`] = modelId;
  }
  console.log(`[E2E] All agents overridden to model: ${modelId}`);
  return overridden;
}

/* ------------------------------------------------------------------ */
/*  test suite                                                        */
/* ------------------------------------------------------------------ */

describe('StoryOrchestrator E2E — Real LLM Integration', { skip: !E2E_ENABLED }, () => {
  let orchestrator = null;
  let testConfig = {};
  let storyId = null;
  let checkpointCount = 0;

  before(async () => {
    const baseConfig = loadConfig();
    const vcpKey = baseConfig.Key || baseConfig.VCP_Key;
    const port = baseConfig.PORT || 6005;
    const agentAssistantUrl = baseConfig.AGENT_ASSISTANT_URL || `http://127.0.0.1:${port}`;

    if (!vcpKey) {
      throw new Error('No VCP Key found in config.env. Please set Key=... in root config.env');
    }

    const reachable = await checkVcpReachable(agentAssistantUrl, vcpKey);
    if (!reachable) {
      throw new Error(
        `VCP service not reachable at ${agentAssistantUrl}. ` +
        `Please start VCP (node server.js) before running E2E tests.`
      );
    }

    testConfig = {
      ...baseConfig,
      // 内核路径开关
      USE_WORKFLOW_KERNEL: E2E_USE_KERNEL ? 'true' : 'false',
      WORKFLOW_HOT_RELOAD: 'false',
      // 迭代控制：减少 Phase3 打磨轮数
      MAX_PHASE_ITERATIONS: '1',
      // 字数控制：轻量级短篇小说
      DEFAULT_TARGET_WORD_COUNT_MIN: String(Math.floor(E2E_TARGET_WORD_COUNT * 0.8)),
      DEFAULT_TARGET_WORD_COUNT_MAX: String(E2E_TARGET_WORD_COUNT),
      // 检查点超时 fallback（测试会自动批准，此项作为安全网）
      USER_CHECKPOINT_TIMEOUT_MS: '30000',
      // 调试输出
      ORCHESTRATOR_DEBUG_MODE: 'true',
    };

    // 可选：统一覆盖所有 agent 模型（用于使用低价模型降低成本）
    if (E2E_AGENT_MODEL) {
      testConfig = applyAgentModelOverride(testConfig, E2E_AGENT_MODEL);
    }

    orchestrator = new StoryOrchestrator();
    await orchestrator.initialize(testConfig);

    console.log(
      `[E2E] StoryOrchestrator initialized ` +
      `(kernel: ${orchestrator.useKernel}, ` +
      `targetWords: ${E2E_TARGET_WORD_COUNT}, ` +
      `cleanup: ${E2E_CLEANUP})`
    );
  });

  after(async () => {
    if (orchestrator) {
      if (E2E_CLEANUP && storyId) {
        try {
          await orchestrator.stateManager.deleteStory(storyId);
          console.log(`[E2E] Cleaned up story: ${storyId}`);
        } catch (err) {
          console.warn(`[E2E] Failed to cleanup story ${storyId}:`, err.message);
        }
      }
      await orchestrator.shutdown();
      console.log('[E2E] StoryOrchestrator shut down');
    }
  });

  it('generates a complete short story through all 3 phases with real LLM calls', { timeout: E2E_MAX_WAIT_MS + 60000 }, async () => {
    const suiteStart = Date.now();

    /* ---- 1. 启动故事项目 ---- */
    console.log(`[E2E] Starting story project (target: ${E2E_TARGET_WORD_COUNT} words)...`);

    const startResult = await orchestrator.processToolCall({
      command: 'StartStoryProject',
      story_prompt:
        '在2150年的火星殖民地，最后一位人类图书管理员阿琳和一台拥有五十年历史的老旧AI机器人“墨菲”之间，' +
        '发生了一段跨越人类与机器界限的温馨友情。故事要展现阿琳对纸质书籍的执着，' +
        '以及墨菲逐渐理解“情感”含义的过程。请创作一个简洁温暖的科幻短篇。',
      target_word_count: E2E_TARGET_WORD_COUNT,
      genre: '科幻温情',
      style_preference: '简洁温暖，注重情感细节与人物心理变化',
    });

    assert.strictEqual(
      startResult.status,
      'success',
      `StartStoryProject failed: ${JSON.stringify(startResult)}`
    );
    assert.ok(startResult.result?.story_id, 'Should return story_id');

    storyId = startResult.result.story_id;
    console.log(`[E2E] Story started: ${storyId}`);

    /* ---- 2. 轮询 + 自动批准检查点 ---- */
    let finalStatus = null;
    checkpointCount = 0;

    while (Date.now() - suiteStart < E2E_MAX_WAIT_MS) {
      const statusResult = await orchestrator.processToolCall({
        command: 'QueryStoryStatus',
        story_id: storyId,
      });

      assert.strictEqual(
        statusResult.status,
        'success',
        `QueryStoryStatus failed: ${JSON.stringify(statusResult)}`
      );

      const status = statusResult.result;
      finalStatus = status;

      const elapsedSec = ((Date.now() - suiteStart) / 1000).toFixed(1);
      console.log(
        `[E2E] [${elapsedSec}s] phase=${status.phase_name || status.phase} ` +
        `status=${status.status} checkpoint=${status.checkpoint_pending ? 'PENDING' : 'none'} ` +
        `chapters=${status.chapters_completed || 0} ` +
        `words=${status.total_word_count || 0}`
      );

      if (status.status === 'completed') {
        console.log('[E2E] Workflow reported completed.');
        break;
      }

      if (status.checkpoint_pending && status.checkpoint_id) {
        checkpointCount++;
        console.log(
          `[E2E] Auto-approving checkpoint #${checkpointCount}: ${status.checkpoint_id}`
        );

        const approveResult = await orchestrator.processToolCall({
          command: 'UserConfirmCheckpoint',
          story_id: storyId,
          checkpoint_id: status.checkpoint_id,
          approval: true,
          feedback: 'E2E test auto-approval',
        });

        console.log(
          `[E2E] Approval result: ${approveResult.status} — ` +
          `${approveResult.result?.message || approveResult.result?.phase || 'ok'}`
        );

        // 批准后给后台任务一点时间启动
        await sleep(E2E_POLL_INTERVAL_MS);
        continue;
      }

      // 普通等待
      await sleep(E2E_POLL_INTERVAL_MS);
    }

    assert.ok(
      finalStatus?.status === 'completed',
      `Story did not complete within ${E2E_MAX_WAIT_MS}ms. ` +
        `Final status: ${finalStatus?.status}`
    );

    /* ---- 3. 导出并验证 ---- */
    console.log('[E2E] Exporting story...');

    const exportResult = await orchestrator.processToolCall({
      command: 'ExportStory',
      story_id: storyId,
      format: 'markdown',
    });

    assert.strictEqual(
      exportResult.status,
      'success',
      `ExportStory failed: ${JSON.stringify(exportResult)}`
    );

    const exported = exportResult.result;
    assert.ok(exported?.content, 'Export should have content');
    assert.ok(
      exported.word_count > 0,
      `Word count should be > 0, got: ${exported.word_count}`
    );
    assert.ok(
      exported.chapter_count > 0,
      `Chapter count should be > 0, got: ${exported.chapter_count}`
    );

    const totalSec = ((Date.now() - suiteStart) / 1000).toFixed(1);
    console.log(`[E2E] ✅ E2E PASSED — Story generated in ${totalSec}s`);
    console.log(`[E2E]    Word count : ${exported.word_count}`);
    console.log(`[E2E]    Chapters   : ${exported.chapter_count}`);
    console.log(`[E2E]    Checkpoints: ${checkpointCount}`);
    console.log(`[E2E]    Path       : ${E2E_USE_KERNEL ? 'WorkflowKernel' : 'Legacy'}`);
    console.log(
      `[E2E]    Preview    :\n${exported.content.substring(0, 400).trim()}...`
    );
  });
});
