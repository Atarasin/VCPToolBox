/**
 * 文件状态存储模块：统一管理项目状态、唤醒任务、计数器、人工介入与审计数据。
 *
 * 存储结构：
 * - projects/：项目状态文件，每个项目一个 JSON 文件
 * - wakeups/：唤醒任务文件，每个任务一个 JSON 文件
 * - counters/：计数器文件，每个项目一个 JSON 文件
 * - quality_reports/：质量报告，按项目+章节+时间戳命名
 * - manual_review/：人工介入记录，每个项目一个 JSON 文件
 * - inbox/：收件箱，存放待消费的 ACK 和人工回复
 * - checkpoints/：项目检查点快照，按项目+时间戳命名
 * - audit/：审计日志，记录 tick 和执行历史
 *
 * 并发安全：所有写入操作均使用文件锁（acquireFileLock）避免并发冲突
 * 原子写入：使用"先写临时文件再 rename"的模式确保数据一致性
 *
 * @module storage/stateStore
 * @requires fs/promises
 * @requires path
 * @requires crypto
 * @requires ./fileLock
 * @requires ./serializers
 * @requires ../utils/time
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { acquireFileLock } = require('./fileLock');
const { toStablePrettyJson } = require('./serializers');
const { toLocalIsoString, toLocalCompactTimestamp } = require('../utils/time');

/**
 * 构建存储目录路径集合。
 * 所有子目录均位于 storageRoot 下，便于统一管理和清理
 *
 * @param {string} storageRoot 存储根目录
 * @returns {object} 各存储子目录的绝对路径
 * @property {string} root 存储根目录
 * @property {string} projects 项目状态目录
 * @property {string} wakeups 唤醒任务目录
 * @property {string} counters 计数器目录
 * @property {string} qualityReports 质量报告目录
 * @property {string} manualReview 人工介入记录目录
 * @property {string} inbox 收件箱目录
 * @property {string} checkpoints 检查点目录
 * @property {string} audit 审计日志目录
 *
 * @example
 * buildStoragePaths('/data/workflow/storage')
 * // 返回
 * // {
 * //   root: '/data/workflow/storage',
 * //   projects: '/data/workflow/storage/projects',
 * //   wakeups: '/data/workflow/storage/wakeups',
 * //   ...
 * // }
 */
function buildStoragePaths(storageRoot) {
  return {
    root: storageRoot,
    projects: path.join(storageRoot, 'projects'),
    wakeups: path.join(storageRoot, 'wakeups'),
    counters: path.join(storageRoot, 'counters'),
    qualityReports: path.join(storageRoot, 'quality_reports'),
    manualReview: path.join(storageRoot, 'manual_review'),
    inbox: path.join(storageRoot, 'inbox'),
    checkpoints: path.join(storageRoot, 'checkpoints'),
    audit: path.join(storageRoot, 'audit')
  };
}

/**
 * 确保目录存在。
 * 使用 recursive: true 自动创建嵌套目录，不会因目录已存在而报错
 *
 * @param {string} dirPath 目录路径
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDir('/data/storage/projects'); // 创建 projects 目录
 * await ensureDir('/data/storage/a/b/c'); // 递归创建 a/b/c 目录
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 读取 JSON 文件。
 * 异常处理策略：
 * - 文件不存在（ENOENT）时返回默认值，不抛错
 * - 其他 IO 错误或 JSON 解析错误直接向上抛出
 *
 * @param {string} filePath 文件路径
 * @param {any} [defaultValue=null] 文件不存在时返回的默认值
 * @returns {Promise<any>} 解析后的 JSON 对象，或默认值
 * @throws {Error} 文件存在但内容非合法 JSON 时抛出 SyntaxError
 *
 * @example
 * const data = await readJson('/data/config.json', { default: true });
 * // 文件存在且合法：返回解析后的对象
 * // 文件不存在：返回 { default: true }
 */
async function readJson(filePath, defaultValue = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return defaultValue;
    }
    throw error;
  }
}

/**
 * 构造唤醒任务文件路径。
 * 文件命名格式：{wakeupId}.json
 *
 * @param {string} wakeupId 唤醒任务 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径，如 /storage/wakeups/wk_xxx.json
 */
function buildWakeupFilePath(wakeupId, paths) {
  return path.join(paths.wakeups, `${wakeupId}.json`);
}

/**
 * 构造计数器文件路径。
 * 文件命名格式：{projectId}.json
 *
 * @param {string} projectId 项目 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径，如 /storage/counters/project_001.json
 */
function buildCounterFilePath(projectId, paths) {
  return path.join(paths.counters, `${projectId}.json`);
}

/**
 * 构造人工介入记录文件路径。
 * 文件命名格式：{projectId}.json
 *
 * @param {string} projectId 项目 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径，如 /storage/manual_review/project_001.json
 */
function buildManualReviewFilePath(projectId, paths) {
  return path.join(paths.manualReview, `${projectId}.json`);
}

/**
 * 构造收件箱文件路径。
 *
 * @param {string} name 文件名（不含扩展名）
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径，如 /storage/inbox/acks.json
 */
function buildInboxFilePath(name, paths) {
  return path.join(paths.inbox, `${name}.json`);
}

/**
 * 原子写入 JSON 文件。
 * 关键算法：先写临时文件（.tmp 后缀），再 rename 到目标路径。
 * 优势：
 * 1. rename 操作在 POSIX 系统上是原子的
 * 2. 即使写入中途崩溃，原始文件不会被污染
 * 3. 临时文件使用进程ID+随机UUID命名，避免多进程冲突
 *
 * @param {string} filePath 目标文件路径
 * @param {object} payload 待写入对象（会被序列化为稳定排序的 JSON）
 * @returns {Promise<void>}
 *
 * @example
 * await atomicWriteJson('/data/item.json', { a: 1, b: 2 });
 * // 1. 写入 /data/item.json.{pid}.{uuid}.tmp
 * // 2. rename 到 /data/item.json
 */
async function atomicWriteJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, toStablePrettyJson(payload), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * 创建默认计数器结构。
 * 计数器用于追踪：
 * 1. 各设定阶段的辩论轮次（setupDebateRounds）
 * 2. 章节创作迭代次数（chapterIterations）
 *
 * @param {string} projectId 项目 ID
 * @returns {object} 默认计数器对象
 * @property {string} projectId 项目标识
 * @property {object} setupDebateRounds 各设定阶段辩论轮次计数
 * @property {object} chapterIterations 各章节迭代次数
 * @property {string} updatedAt 最后更新时间
 */
function createDefaultCounters(projectId) {
  return {
    projectId,
    setupDebateRounds: {
      world: 0,
      character: 0,
      volume: 0,
      chapter: 0
    },
    chapterIterations: {
      default_chapter: 0
    },
    updatedAt: toLocalIsoString(new Date())
  };
}

/**
 * 创建默认项目状态。
 * 新项目从 INIT 状态开始，经过设定阶段（SETUP_WORLD/CHARACTER/VOLUME/CHAPTER）
 * 最终进入 CHAPTER_CREATION 创作阶段
 *
 * @param {string} projectId 项目 ID
 * @param {Date} now 当前时间
 * @param {object} [options={}] 初始化配置
 * @param {string} [options.communityId] 关联社区 ID
 * @param {object} [options.requirements] 需求文档
 * @param {number} [options.setupPassThreshold] 设定阶段通过分数阈值
 * @param {number} [options.setupMaxDebateRounds] 设定最大辩论轮次
 * @param {number} [options.chapterMaxIterations] 章节最大迭代次数
 * @param {number} [options.stagnantTickThreshold] 停滞 tick 阈值
 * @returns {object} 默认项目状态对象
 */
function createDefaultProjectState(projectId, now, options = {}) {
  const timestamp = toLocalIsoString(now);
  return {
    projectId,
    state: 'INIT',
    substate: null,
    communityId: options.communityId || '',
    requirements: options.requirements || {},
    qualityPolicy: {
      setupPassThreshold: options.setupPassThreshold ?? 85,
      setupMaxDebateRounds: options.setupMaxDebateRounds ?? 3,
      chapterMaxIterations: options.chapterMaxIterations ?? 3
    },
    stagnation: {
      unchangedTicks: 0,
      threshold: options.stagnantTickThreshold ?? 3
    },
    manualReview: {
      status: 'none',
      requestedAt: null,
      resumeStage: null
    },
    debate: {
      role: 'designer',
      round: 0,
      maxRounds: options.setupMaxDebateRounds ?? 3,
      lastDesignerWakeupId: null,
      lastCriticWakeupId: null
    },
    activeWakeupId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/**
 * 创建状态存储实例。
 * 返回一个包含所有存储操作方法的对象，支持项目状态、唤醒任务、计数器等的管理
 *
 * @param {object} options 初始化参数
 * @param {string} options.pluginRoot 插件根目录（用于解析相对路径）
 * @param {string} options.storageRoot 存储根目录（支持绝对路径或相对于 pluginRoot 的相对路径）
 * @returns {object} 状态存储 API 对象
 *
 * @example
 * const store = createStateStore({
 *   pluginRoot: '/path/to/plugin',
 *   storageRoot: 'storage'  // 实际路径为 /path/to/plugin/storage
 * });
 * await store.ensureStorageLayout();
 * await store.putProjectState({ projectId: 'p1', state: 'INIT' });
 */
function createStateStore(options) {
  const storageRoot = path.isAbsolute(options.storageRoot)
    ? options.storageRoot
    : path.join(options.pluginRoot, options.storageRoot);
  const paths = buildStoragePaths(storageRoot);

  /**
   * 初始化全部存储目录。
   * 在首次使用存储前必须调用，确保所有子目录已创建
   *
   * @returns {Promise<void>}
   */
  async function ensureStorageLayout() {
    await Promise.all(Object.values(paths).map(ensureDir));
  }

  /**
   * 列出已存在项目 ID。
   * 扫描 projects 目录，返回所有 .json 文件名（去掉扩展名）
   *
   * @returns {Promise<string[]>} 项目 ID 列表
   *
   * @example
   * // projects 目录包含 p1.json, p2.json, temp.txt
   * await listProjectIds(); // 返回 ['p1', 'p2']
   */
  async function listProjectIds() {
    await ensureStorageLayout();
    const files = await fs.readdir(paths.projects, { withFileTypes: true });
    return files
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5));
  }

  /**
   * 读取项目状态。
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object|null>} 项目状态对象，不存在则返回 null
   */
  async function getProjectState(projectId) {
    return readJson(path.join(paths.projects, `${projectId}.json`));
  }

  /**
   * 写入项目状态。
   * 使用文件锁实现并发安全：获取锁 → 写入 → 释放锁
   *
   * @param {object} projectState 项目状态对象
   * @param {string} projectState.projectId 项目 ID
   * @returns {Promise<void>}
   *
   * @example
   * await putProjectState({ projectId: 'p1', state: 'SETUP_WORLD' });
   */
  async function putProjectState(projectState) {
    const lockPath = path.join(paths.projects, `${projectState.projectId}.lock`);
    const lock = await acquireFileLock(lockPath);
    try {
      await atomicWriteJson(path.join(paths.projects, `${projectState.projectId}.json`), projectState);
    } finally {
      await lock.release();
    }
  }

  /**
   * 批量加载项目状态。
   *
   * @param {number} [limit=100] 最大加载数量，默认100
   * @returns {Promise<object[]>} 项目状态列表（按文件名字母序）
   */
  async function loadProjects(limit = 100) {
    const ids = await listProjectIds();
    const selected = ids.slice(0, Math.max(limit, 0));
    const projects = await Promise.all(selected.map(getProjectState));
    return projects.filter(Boolean);
  }

  /**
   * 当项目不存在时写入默认状态。
   * 用于引导新项目进入工作流，防止空项目导致的异常
   *
   * @param {string} projectId 项目 ID
   * @param {object} [options={}] 默认状态选项
   * @returns {Promise<{created: boolean, project: object}|null>}
   *   - created: true 表示新创建，false 表示已存在
   *   - project: 项目状态对象
   *   - projectId 为空时返回 null
   *
   * @example
   * const result = await bootstrapProjectIfNeeded('p1', { setupMaxDebateRounds: 5 });
   * if (result.created) {
   *   console.log('新项目已创建');
   * }
   */
  async function bootstrapProjectIfNeeded(projectId, options = {}) {
    if (!projectId) {
      return null;
    }
    const existing = await getProjectState(projectId);
    if (existing) {
      return { created: false, project: existing };
    }
    const project = createDefaultProjectState(projectId, new Date(), options);
    await putProjectState(project);
    return { created: true, project };
  }

  /**
   * 写入项目检查点快照。
   * 用于记录项目在特定时刻的完整状态，便于问题追溯和回滚
   *
   * @param {string} projectId 项目 ID
   * @param {object} payload 快照数据（通常包含 tickId、state、counters 等）
   * @param {Date} [now] 当前时间，默认 new Date()
   * @returns {Promise<string>} 检查点文件路径
   *
   * @example
   * const path = await writeCheckpoint('p1', {
   *   tickId: '20240101_abc123',
   *   state: 'SETUP_WORLD',
   *   counters: {...}
   * });
   * // 文件名格式：p1_20240101120000.json
   */
  async function writeCheckpoint(projectId, payload, now = new Date()) {
    const ts = toLocalCompactTimestamp(now);
    const filePath = path.join(paths.checkpoints, `${projectId}_${ts}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
  }

  /**
   * 写入 tick 审计日志。
   * 记录每个 tick 的输入、配置和输出，用于离线分析和问题定位
   *
   * @param {string} tickId tick 标识
   * @param {object} payload 审计内容
   * @returns {Promise<string>} 审计文件路径
   */
  async function writeAudit(tickId, payload) {
    const filePath = path.join(paths.audit, `tick_${tickId}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
  }

  /**
   * 写入唤醒任务。
   * 使用文件锁确保并发写入安全
   *
   * @param {object} task 唤醒任务对象
   * @param {string} task.wakeupId 任务 ID
   * @returns {Promise<void>}
   */
  async function putWakeupTask(task) {
    const lockPath = path.join(paths.wakeups, `${task.wakeupId}.lock`);
    const lock = await acquireFileLock(lockPath);
    try {
      await atomicWriteJson(buildWakeupFilePath(task.wakeupId, paths), task);
    } finally {
      await lock.release();
    }
  }

  /**
   * 读取唤醒任务。
   *
   * @param {string} wakeupId 唤醒任务 ID
   * @returns {Promise<object|null>} 唤醒任务，不存在则返回 null
   */
  async function getWakeupTask(wakeupId) {
    return readJson(buildWakeupFilePath(wakeupId, paths));
  }

  /**
   * 基于 updater 函数更新唤醒任务。
   * 读取 → 应用 updater → 写回，典型用法如累加计数器
   *
   * @param {string} wakeupId 唤醒任务 ID
   * @param {function} updater 更新函数，接收当前任务对象，返回更新后的任务
   * @returns {Promise<object|null>} 更新后的任务；任务不存在时返回 null
   *
   * @example
   * await updateWakeupTask('wk_xxx', task => ({
   *   ...task,
   *   executionAttempt: task.executionAttempt + 1
   * }));
   */
  async function updateWakeupTask(wakeupId, updater) {
    const current = await getWakeupTask(wakeupId);
    if (!current) {
      return null;
    }
    const next = updater(current);
    await putWakeupTask(next);
    return next;
  }

  /**
   * 查询指定项目的唤醒任务历史。
   * 按派发时间（dispatchedAt）倒序排列
   *
   * @param {string} projectId 项目 ID
   * @param {number} [limit=20] 返回上限
   * @returns {Promise<object[]>} 按时间倒序的任务列表
   */
  async function listWakeupsByProject(projectId, limit = 20) {
    await ensureStorageLayout();
    const files = await fs.readdir(paths.wakeups, { withFileTypes: true });
    const matched = files
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(paths.wakeups, entry.name));
    const loaded = await Promise.all(matched.map(file => readJson(file)));
    return loaded
      .filter(item => item && item.projectId === projectId)
      .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')))
      .slice(0, Math.max(limit, 0));
  }

  /**
   * 列出待执行的唤醒任务。
   * 筛选条件：
   * 1. ackStatus === 'pending'（尚未收到确认）
   * 2. executionStatus === 'queued'（等待执行）
   * 3. nextRetryAt 为空或已到重试时间
   *
   * @param {number} [limit=20] 返回上限
   * @param {Date} [now=new Date()] 当前时间
   * @returns {Promise<object[]>} 待执行任务列表
   */
  async function listPendingWakeups(limit = 20, now = new Date()) {
    await ensureStorageLayout();
    const files = await fs.readdir(paths.wakeups, { withFileTypes: true });
    const matched = files
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(paths.wakeups, entry.name));
    const loaded = await Promise.all(matched.map(file => readJson(file)));
    return loaded
      .filter(item => item && String(item.ackStatus || '') === 'pending')
      .filter(item => {
        const status = String(item.executionStatus || 'queued');
        if (status !== 'queued') {
          return false;
        }
        if (!item.nextRetryAt) {
          return true;
        }
        return Number(new Date(item.nextRetryAt).getTime()) <= Number(now.getTime());
      })
      .sort((a, b) => String(a.dispatchedAt || '').localeCompare(String(b.dispatchedAt || '')))
      .slice(0, Math.max(limit, 0));
  }

  /**
   * 汇总唤醒队列状态。
   * 统计各状态的任务数量，用于监控和告警
   *
   * @param {Date} [now=new Date()] 当前时间
   * @returns {Promise<object>} 队列状态汇总
   * @property {number} pendingTotal 待处理总数（pending 且 queued）
   * @property {number} pendingReady 待处理中可立即执行的（无延迟或延迟已过）
   * @property {number} pendingDelayed 待处理中延迟的（nextRetryAt 未到）
   * @property {number} running 正在执行的
   * @property {number} failed 已失败的
   * @property {number} succeeded 已成功的
   */
  async function summarizeWakeupQueue(now = new Date()) {
    await ensureStorageLayout();
    const files = await fs.readdir(paths.wakeups, { withFileTypes: true });
    const matched = files
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(paths.wakeups, entry.name));
    const loaded = await Promise.all(matched.map(file => readJson(file)));
    let pendingTotal = 0;
    let pendingReady = 0;
    let pendingDelayed = 0;
    let running = 0;
    let failed = 0;
    let succeeded = 0;
    for (const item of loaded) {
      if (!item) {
        continue;
      }
      const ackStatus = String(item.ackStatus || '');
      const executionStatus = String(item.executionStatus || 'queued');
      if (ackStatus === 'pending' && executionStatus === 'queued') {
        pendingTotal += 1;
        if (!item.nextRetryAt || Number(new Date(item.nextRetryAt).getTime()) <= Number(now.getTime())) {
          pendingReady += 1;
        } else {
          pendingDelayed += 1;
        }
      } else if (executionStatus === 'running') {
        running += 1;
      } else if (executionStatus === 'failed') {
        failed += 1;
      } else if (executionStatus === 'succeeded') {
        succeeded += 1;
      }
    }
    return {
      pendingTotal,
      pendingReady,
      pendingDelayed,
      running,
      failed,
      succeeded
    };
  }

  /**
   * 将外部 ACK 写回对应唤醒任务。
   * 用于在执行层返回结果后，更新唤醒任务的状态
   *
   * @param {object} ack ACK 数据
   * @param {string} ack.wakeupId 对应唤醒任务 ID
   * @param {string} [ack.ackStatus] 确认状态
   * @param {Date} [now] 当前时间
   * @returns {Promise<object|null>} 更新后的唤醒任务；无 wakeupId 时返回 null
   */
  async function applyAckToWakeup(ack, now = new Date()) {
    if (!ack || !ack.wakeupId) {
      return null;
    }
    return updateWakeupTask(ack.wakeupId, current => ({
      ...current,
      ackStatus: ack.ackStatus || current.ackStatus || 'unknown',
      ackPayload: ack,
      ackedAt: toLocalIsoString(now)
    }));
  }

  /**
   * 读取项目计数器。
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object|null>} 计数器对象，不存在则返回 null
   */
  async function getCounters(projectId) {
    return readJson(buildCounterFilePath(projectId, paths));
  }

  /**
   * 写入项目计数器。
   * 使用文件锁确保并发安全，自动更新 updatedAt 时间戳
   *
   * @param {string} projectId 项目 ID
   * @param {object} counters 计数器数据
   * @returns {Promise<void>}
   */
  async function putCounters(projectId, counters) {
    const lockPath = path.join(paths.counters, `${projectId}.lock`);
    const lock = await acquireFileLock(lockPath);
    try {
      await atomicWriteJson(buildCounterFilePath(projectId, paths), {
        ...counters,
        projectId,
        updatedAt: toLocalIsoString(new Date())
      });
    } finally {
      await lock.release();
    }
  }

  /**
   * 当计数器不存在时写入默认值。
   * 用于新项目的计数器初始化
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object>} 计数器对象（已存在或新创建的）
   */
  async function bootstrapCountersIfNeeded(projectId) {
    const existing = await getCounters(projectId);
    if (existing) {
      return existing;
    }
    const counters = createDefaultCounters(projectId);
    await putCounters(projectId, counters);
    return counters;
  }

  /**
   * 读取人工介入记录。
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object|null>} 人工介入记录
   */
  async function getManualReview(projectId) {
    return readJson(buildManualReviewFilePath(projectId, paths));
  }

  /**
   * 写入人工介入记录。
   * 用于记录人工介入的原因、状态和回复内容
   *
   * @param {string} projectId 项目 ID
   * @param {object} payload 人工介入内容
   * @returns {Promise<void>}
   */
  async function putManualReview(projectId, payload) {
    const lockPath = path.join(paths.manualReview, `${projectId}.lock`);
    const lock = await acquireFileLock(lockPath);
    try {
      await atomicWriteJson(buildManualReviewFilePath(projectId, paths), payload);
    } finally {
      await lock.release();
    }
  }

  /**
   * 写入质量报告。
   * 在章节评审阶段记录质量评估结果
   *
   * @param {string} projectId 项目 ID
   * @param {string} chapterId 章节 ID
   * @param {object} payload 质量报告（包含 tickId、指标、评估结果等）
   * @param {Date} [now] 当前时间
   * @returns {Promise<string>} 报告文件路径
   */
  async function writeQualityReport(projectId, chapterId, payload, now = new Date()) {
    const ts = toLocalCompactTimestamp(now);
    const filePath = path.join(paths.qualityReports, `${projectId}_${chapterId}_${ts}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
  }

  /**
   * 写入执行审计日志。
   * 记录执行层的执行结果、指标和事件
   *
   * @param {object} payload 审计内容
   * @param {Date} [now] 当前时间
   * @returns {Promise<string>} 审计文件路径
   */
  async function writeExecutionAudit(payload, now = new Date()) {
    const ts = toLocalCompactTimestamp(now);
    const filePath = path.join(paths.audit, `execution_${ts}_${crypto.randomUUID().slice(0, 8)}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
  }

  /**
   * 消费收件箱中的输入。
   * 读取 inbox/acks.json 和 inbox/manual_replies.json，
   * 将内容移动到 audit 目录存档，然后清空收件箱
   *
   * @param {Date} [now] 当前时间
   * @returns {Promise<{acks: Array, manualReplies: Array}>} 消费的内容
   */
  async function consumeInboxInput(now = new Date()) {
    const lockPath = path.join(paths.inbox, 'inbox.lock');
    const lock = await acquireFileLock(lockPath);
    try {
      const ackPayload = await readJson(buildInboxFilePath('acks', paths), { acks: [] });
      const manualPayload = await readJson(buildInboxFilePath('manual_replies', paths), { manualReplies: [] });
      const acks = Array.isArray(ackPayload?.acks)
        ? ackPayload.acks
        : (Array.isArray(ackPayload) ? ackPayload : []);
      const manualReplies = Array.isArray(manualPayload?.manualReplies)
        ? manualPayload.manualReplies
        : (Array.isArray(manualPayload) ? manualPayload : []);

      if (acks.length > 0 || manualReplies.length > 0) {
        const ts = toLocalCompactTimestamp(now);
        const consumedPath = path.join(paths.audit, `inbox_consumed_${ts}_${crypto.randomUUID().slice(0, 8)}.json`);
        await atomicWriteJson(consumedPath, {
          consumedAt: toLocalIsoString(now),
          acks,
          manualReplies
        });
      }

      await atomicWriteJson(buildInboxFilePath('acks', paths), { acks: [] });
      await atomicWriteJson(buildInboxFilePath('manual_replies', paths), { manualReplies: [] });
      return { acks, manualReplies };
    } finally {
      await lock.release();
    }
  }

  /**
   * 向收件箱追加 ACK。
   * 合并策略：按 projectId|wakeupId 去重，后来的 ACK 覆盖先前的
   *
   * @param {Array} acks 待追加的 ACK 列表
   * @param {Date} [now] 当前时间
   * @returns {Promise<{total: number}>} 追加后的 ACK 总数
   */
  async function appendAcksToInbox(acks, now = new Date()) {
    const normalized = Array.isArray(acks) ? acks.filter(Boolean) : [];
    if (normalized.length === 0) {
      return { total: 0 };
    }
    const lockPath = path.join(paths.inbox, 'inbox.lock');
    const lock = await acquireFileLock(lockPath);
    try {
      const current = await readJson(buildInboxFilePath('acks', paths), { acks: [] });
      const existing = Array.isArray(current?.acks) ? current.acks : [];
      const mergedMap = new Map();
      for (const item of existing) {
        if (!item || !item.projectId || !item.wakeupId) {
          continue;
        }
        mergedMap.set(`${item.projectId}|${item.wakeupId}`, item);
      }
      for (const item of normalized) {
        if (!item || !item.projectId || !item.wakeupId) {
          continue;
        }
        mergedMap.set(`${item.projectId}|${item.wakeupId}`, item);
      }
      const merged = Array.from(mergedMap.values());
      await atomicWriteJson(buildInboxFilePath('acks', paths), { acks: merged });
      const ts = toLocalCompactTimestamp(now);
      await atomicWriteJson(path.join(paths.audit, `inbox_append_${ts}_${crypto.randomUUID().slice(0, 8)}.json`), {
        appendedAt: toLocalIsoString(now),
        appended: normalized,
        total: merged.length
      });
      return { total: merged.length };
    } finally {
      await lock.release();
    }
  }

  return {
    paths,
    ensureStorageLayout,
    listProjectIds,
    getProjectState,
    putProjectState,
    loadProjects,
    bootstrapProjectIfNeeded,
    writeCheckpoint,
    writeAudit,
    putWakeupTask,
    getWakeupTask,
    updateWakeupTask,
    listWakeupsByProject,
    listPendingWakeups,
    summarizeWakeupQueue,
    applyAckToWakeup,
    getCounters,
    putCounters,
    bootstrapCountersIfNeeded,
    getManualReview,
    putManualReview,
    writeQualityReport,
    writeExecutionAudit,
    consumeInboxInput,
    appendAcksToInbox
  };
}

module.exports = {
  createStateStore,
  createDefaultProjectState,
  createDefaultCounters
};
