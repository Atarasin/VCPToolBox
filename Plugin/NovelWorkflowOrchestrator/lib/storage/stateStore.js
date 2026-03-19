const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { acquireFileLock } = require('./fileLock');
const { toStablePrettyJson } = require('./serializers');

/**
 * 文件状态存储模块：统一管理项目状态、唤醒任务、计数器、人工介入与审计数据。
 */

/**
 * 构建存储目录路径集合。
 *
 * @param {string} storageRoot 存储根目录
 * @returns {object} 各存储子目录的绝对路径
 */
function buildStoragePaths(storageRoot) {
  return {
    root: storageRoot,
    projects: path.join(storageRoot, 'projects'),
    wakeups: path.join(storageRoot, 'wakeups'),
    counters: path.join(storageRoot, 'counters'),
    qualityReports: path.join(storageRoot, 'quality_reports'),
    manualReview: path.join(storageRoot, 'manual_review'),
    checkpoints: path.join(storageRoot, 'checkpoints'),
    audit: path.join(storageRoot, 'audit')
  };
}

/**
 * 确保目录存在。
 *
 * @param {string} dirPath 目录路径
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 读取 JSON 文件。
 * 异常处理：文件不存在时返回默认值，其他异常直接抛出。
 *
 * @param {string} filePath 文件路径
 * @param {any} [defaultValue=null] 默认返回值
 * @returns {Promise<any>} 解析后的 JSON 对象
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
 *
 * @param {string} wakeupId 唤醒任务 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径
 */
function buildWakeupFilePath(wakeupId, paths) {
  return path.join(paths.wakeups, `${wakeupId}.json`);
}

/**
 * 构造计数器文件路径。
 *
 * @param {string} projectId 项目 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径
 */
function buildCounterFilePath(projectId, paths) {
  return path.join(paths.counters, `${projectId}.json`);
}

/**
 * 构造人工介入记录文件路径。
 *
 * @param {string} projectId 项目 ID
 * @param {object} paths 存储路径集合
 * @returns {string} 文件路径
 */
function buildManualReviewFilePath(projectId, paths) {
  return path.join(paths.manualReview, `${projectId}.json`);
}

/**
 * 原子写入 JSON 文件。
 * 关键逻辑：先写临时文件再 rename，避免半写入状态污染正式文件。
 *
 * @param {string} filePath 目标文件路径
 * @param {object} payload 待写入对象
 * @returns {Promise<void>}
 */
async function atomicWriteJson(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, toStablePrettyJson(payload), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * 创建默认计数器结构。
 *
 * @param {string} projectId 项目 ID
 * @returns {object} 默认计数器
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
    updatedAt: new Date().toISOString()
  };
}

/**
 * 创建默认项目状态。
 *
 * @param {string} projectId 项目 ID
 * @param {Date} now 当前时间
 * @param {object} [options={}] 初始化配置
 * @returns {object} 默认项目状态对象
 */
function createDefaultProjectState(projectId, now, options = {}) {
  const timestamp = now.toISOString();
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
 *
 * @param {object} options 初始化参数
 * @param {string} options.pluginRoot 插件根目录
 * @param {string} options.storageRoot 存储根目录（支持相对路径）
 * @returns {object} 状态存储 API
 */
function createStateStore(options) {
  const storageRoot = path.isAbsolute(options.storageRoot)
    ? options.storageRoot
    : path.join(options.pluginRoot, options.storageRoot);
  const paths = buildStoragePaths(storageRoot);

  /**
   * 初始化全部存储目录。
   *
   * @returns {Promise<void>}
   */
  async function ensureStorageLayout() {
    await Promise.all(Object.values(paths).map(ensureDir));
  }

  /**
   * 列出已存在项目 ID。
   *
   * @returns {Promise<string[]>} 项目 ID 列表
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
   * @returns {Promise<object|null>} 项目状态
   */
  async function getProjectState(projectId) {
    return readJson(path.join(paths.projects, `${projectId}.json`));
  }

  /**
   * 写入项目状态。
   * 关键逻辑：使用文件锁避免并发写覆盖。
   *
   * @param {object} projectState 项目状态
   * @returns {Promise<void>}
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
   * @param {number} [limit=100] 最大加载数量
   * @returns {Promise<object[]>} 项目状态列表
   */
  async function loadProjects(limit = 100) {
    const ids = await listProjectIds();
    const selected = ids.slice(0, Math.max(limit, 0));
    const projects = await Promise.all(selected.map(getProjectState));
    return projects.filter(Boolean);
  }

  /**
   * 当项目不存在时写入默认状态。
   *
   * @param {string} projectId 项目 ID
   * @param {object} [options={}] 默认状态选项
   * @returns {Promise<{created: boolean, project: object}|null>} 初始化结果
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
   *
   * @param {string} projectId 项目 ID
   * @param {object} payload 快照数据
   * @param {Date} [now] 当前时间
   * @returns {Promise<string>} 检查点文件路径
   */
  async function writeCheckpoint(projectId, payload, now = new Date()) {
    const ts = now.toISOString().replace(/[^\d]/g, '').slice(0, 14);
    const filePath = path.join(paths.checkpoints, `${projectId}_${ts}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
  }

  /**
   * 写入 tick 审计日志。
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
   *
   * @param {object} task 唤醒任务对象
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
   * @returns {Promise<object|null>} 唤醒任务
   */
  async function getWakeupTask(wakeupId) {
    return readJson(buildWakeupFilePath(wakeupId, paths));
  }

  /**
   * 基于 updater 更新唤醒任务。
   *
   * @param {string} wakeupId 唤醒任务 ID
   * @param {(current: object) => object} updater 更新函数
   * @returns {Promise<object|null>} 更新后的任务；不存在则返回 null
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
   * 查询指定项目最近的唤醒任务。
   *
   * @param {string} projectId 项目 ID
   * @param {number} [limit=20] 返回上限
   * @returns {Promise<object[]>} 按派发时间倒序排列的任务列表
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
   * 将外部 ACK 写回对应唤醒任务。
   * 异常处理：无 wakeupId 时直接返回 null，不抛错。
   *
   * @param {object} ack ACK 数据
   * @param {Date} [now] 当前时间
   * @returns {Promise<object|null>} 更新后的唤醒任务
   */
  async function applyAckToWakeup(ack, now = new Date()) {
    if (!ack || !ack.wakeupId) {
      return null;
    }
    return updateWakeupTask(ack.wakeupId, current => ({
      ...current,
      ackStatus: ack.ackStatus || current.ackStatus || 'unknown',
      ackPayload: ack,
      ackedAt: now.toISOString()
    }));
  }

  /**
   * 读取项目计数器。
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object|null>} 计数器对象
   */
  async function getCounters(projectId) {
    return readJson(buildCounterFilePath(projectId, paths));
  }

  /**
   * 写入项目计数器。
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
        updatedAt: new Date().toISOString()
      });
    } finally {
      await lock.release();
    }
  }

  /**
   * 当计数器不存在时写入默认值。
   *
   * @param {string} projectId 项目 ID
   * @returns {Promise<object>} 计数器对象
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
   *
   * @param {string} projectId 项目 ID
   * @param {string} chapterId 章节 ID
   * @param {object} payload 质量报告
   * @param {Date} [now] 当前时间
   * @returns {Promise<string>} 报告文件路径
   */
  async function writeQualityReport(projectId, chapterId, payload, now = new Date()) {
    const ts = now.toISOString().replace(/[^\d]/g, '').slice(0, 14);
    const filePath = path.join(paths.qualityReports, `${projectId}_${chapterId}_${ts}.json`);
    await atomicWriteJson(filePath, payload);
    return filePath;
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
    applyAckToWakeup,
    getCounters,
    putCounters,
    bootstrapCountersIfNeeded,
    getManualReview,
    putManualReview,
    writeQualityReport
  };
}

module.exports = {
  createStateStore,
  createDefaultProjectState,
  createDefaultCounters
};
