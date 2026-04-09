/**
 * StoryOrchestratorPanel 路由插件
 *
 * 作用：
 * - 注册前端页面路由，提供StoryOrchestrator的可视化面板
 * - 提供REST API读取StoryOrchestrator的状态文件
 * - 支持WebSocket实时推送
 *
 * 设计要点：
 * - 只读访问StoryOrchestrator的状态文件，不修改原插件数据
 * - 遵循DailyNotePanel的"路由胶水"模式
 */

const path = require('path');
const fs = require('fs').promises;

/**
 * StoryOrchestrator 命令接口（用于面板写操作）
 * 直接调用StoryOrchestrator的核心方法
 */
const StoryOrchestrator = require('../StoryOrchestrator/core/StoryOrchestrator');

// ============================================================================
// DATA NORMALIZATION FUNCTIONS
// ============================================================================
// These functions normalize messy nested story state data before sending to frontend.
// All functions are safe: they handle null/undefined gracefully and don't throw.
// ============================================================================

function safeParseLooseJson(raw, logLabel) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  const startIndex = trimmed.indexOf('{');
  const endIndex = trimmed.lastIndexOf('}');
  const candidates = [];

  if (startIndex !== -1) {
    candidates.push(trimmed.slice(startIndex));
  }

  if (startIndex !== -1 && endIndex > startIndex) {
    candidates.push(trimmed.slice(startIndex, endIndex + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      const repaired = repairTruncatedJson(candidate);
      if (repaired) {
        try {
          return JSON.parse(repaired);
        } catch (repairError) {
        }
      }
    }
  }

  if (logLabel) {
    console.error(`[StoryOrchestratorPanel] Failed to parse ${logLabel}: malformed JSON output`);
  }

  return null;
}

function repairTruncatedJson(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }

  let result = '';
  let inString = false;
  let escaped = false;
  let squareDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    result += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') braceDepth++;
    if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (char === '[') squareDepth++;
    if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
  }

  result = result.replace(/,\s*$/, '');

  if (inString) {
    result += '"';
  }

  while (squareDepth > 0) {
    result = result.replace(/,\s*$/, '');
    result += ']';
    squareDepth--;
  }

  while (braceDepth > 0) {
    result = result.replace(/,\s*$/, '');
    result += '}';
    braceDepth--;
  }

  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Normalize worldview data from various formats into a consistent structure.
 * 
 * @param {*} worldview - Raw worldview data (can be null, string, or object)
 * @returns {Object} Normalized worldview with consistent fields
 * 
 * Expected input shapes:
 *   - null/undefined: Returns empty normalized structure
 *   - { raw: "{...json string...}", setting: "...", ... }: Parses raw string
 *   - { setting: "...", rules: [...], factions: [...], history: [...] }: Already normalized
 *   - "{...json string... }": Raw JSON string
 */
function normalizeWorldview(worldview) {
  const empty = {
    setting: '',
    rules: [],
    factions: [],
    history: [],
    secrets: [],
    summary: '',
    raw: null
  };

  if (worldview == null) {
    return empty;
  }

  let result = { ...empty };

  // Handle raw JSON string input
  if (typeof worldview === 'string') {
    try {
      worldview = safeParseLooseJson(worldview, 'worldview string') || worldview;
    } catch (e) {
      // If it's not valid JSON, treat it as a setting text
      return { ...result, setting: worldview };
    }
  }

  if (typeof worldview !== 'object') {
    return empty;
  }

  // Extract raw for debugging preservation
  result.raw = worldview.raw || null;

  // Parse raw JSON string if present
  if (worldview.raw && typeof worldview.raw === 'string') {
    try {
      const parsedRaw = safeParseLooseJson(worldview.raw, 'worldview raw');
      if (parsedRaw) {
        result = {
          ...result,
          ...parsedRaw,
          setting: parsedRaw.setting || worldview.setting || '',
          rules: parsedRaw.rules || worldview.rules || [],
          factions: parsedRaw.factions || worldview.factions || [],
          history: parsedRaw.history || worldview.history || [],
          secrets: parsedRaw.secrets || worldview.secrets || []
        };
      } else {
        result.setting = worldview.setting || '';
        result.rules = worldview.rules || [];
        result.factions = worldview.factions || [];
        result.history = worldview.history || [];
        result.secrets = worldview.secrets || [];
      }
    } catch (e) {
      // Keep what we have, try direct fields
      result.setting = worldview.setting || '';
      result.rules = worldview.rules || [];
      result.factions = worldview.factions || [];
      result.history = worldview.history || [];
      result.secrets = worldview.secrets || [];
    }
  } else {
    // No raw string, use direct fields
    result.setting = worldview.setting || '';
    result.rules = normalizeArray(worldview.rules);
    result.factions = normalizeArray(worldview.factions);
    result.history = normalizeArray(worldview.history);
    result.secrets = normalizeArray(worldview.secrets);
  }

  // Generate human-readable summary
  result.summary = generateWorldviewSummary(result);

  return result;
}

/**
 * Generate a brief human-readable summary of worldview
 */
function generateWorldviewSummary(worldview) {
  const parts = [];

  if (worldview.setting) {
    const settingPreview = worldview.setting.substring(0, 100);
    parts.push(`设定: ${settingPreview}${worldview.setting.length > 100 ? '...' : ''}`);
  }

  if (worldview.rules && worldview.rules.length > 0) {
    parts.push(`规则: ${worldview.rules.length}条`);
  }

  if (worldview.factions && worldview.factions.length > 0) {
    parts.push(`派系: ${worldview.factions.length}个`);
    const factionNames = worldview.factions.slice(0, 3).map(f => f.name || f).join('、');
    if (worldview.factions.length > 3 || factionNames.length > 50) {
      parts.push(`  主要: ${factionNames.substring(0, 50)}...`);
    } else {
      parts.push(`  主要: ${factionNames}`);
    }
  }

  if (worldview.history && worldview.history.length > 0) {
    parts.push(`历史: ${worldview.history.length}个时代`);
  }

  return parts.join('\n') || '暂无世界观设定';
}

/**
 * Normalize characters data from various formats into a consistent structure.
 * 
 * @param {*} charData - Raw character data (can be null, array, or object)
 * @returns {Object} Normalized characters with flat array and summary
 * 
 * Expected input shapes:
 *   - null/undefined: Returns empty normalized structure
 *   - [{ name: "...", role: "protagonist", ... }]: Old flat array format
 *   - { protagonists: [...], supporting: [...], antagonists: [...] }: New categorized format
 *   - { characters: { protagonists: [...], ... }, raw: "{...}" }: With raw JSON string
 */
function normalizeCharacters(charData) {
  const empty = {
    characters: [],
    summary: { protagonists: 0, supporting: 0, antagonists: 0 }
  };

  if (charData == null) {
    return empty;
  }

  let characters = [];
  let categories = { protagonists: 0, supporting: 0, antagonists: 0 };

  // Handle array format (old format)
  if (Array.isArray(charData)) {
    characters = charData.map(c => normalizeSingleCharacter(c));
  } else if (typeof charData === 'object') {
    let charsObj = charData;

    // Try to get richer data from raw field first
    if (charData.raw && typeof charData.raw === 'string') {
      try {
        const parsedRaw = safeParseLooseJson(charData.raw, 'characters raw');
        if (parsedRaw?.characters) {
          charsObj = parsedRaw.characters;
        } else if (parsedRaw?.protagonists || parsedRaw?.supporting || parsedRaw?.supportingCharacters || parsedRaw?.antagonists) {
          // Raw contains the categories directly
          charsObj = parsedRaw;
        }
      } catch (e) {
        // Fall back to direct fields
      }
    }

    // If characters field is a string, parse it
    if (charsObj === charData && charData.characters) {
      if (typeof charData.characters === 'string') {
        try {
          charsObj = safeParseLooseJson(charData.characters, 'characters string') || charsObj;
        } catch (e) {
          // Keep charsObj as is
        }
      } else if (typeof charData.characters === 'object') {
        charsObj = charData.characters;
      }
    }

    // Extract from all categories
    if (charsObj.protagonists && Array.isArray(charsObj.protagonists)) {
      const normalized = charsObj.protagonists.map(c => normalizeSingleCharacter({ ...c, roleCategory: 'protagonist', roleType: '主角' }));
      characters = characters.concat(normalized);
      categories.protagonists = normalized.length;
    }

    if (charsObj.supportingCharacters && Array.isArray(charsObj.supportingCharacters)) {
      const normalized = charsObj.supportingCharacters.map(c => normalizeSingleCharacter({ ...c, roleCategory: 'supporting', roleType: '配角' }));
      characters = characters.concat(normalized);
      categories.supporting += normalized.length;
    }

    if (charsObj.supporting && Array.isArray(charsObj.supporting)) {
      const normalized = charsObj.supporting.map(c => normalizeSingleCharacter({ ...c, roleCategory: 'supporting', roleType: '配角' }));
      characters = characters.concat(normalized);
      categories.supporting += normalized.length;
    }

    if (charsObj.antagonists && Array.isArray(charsObj.antagonists)) {
      const normalized = charsObj.antagonists.map(c => normalizeSingleCharacter({ ...c, roleCategory: 'antagonist', roleType: '反派' }));
      characters = characters.concat(normalized);
      categories.antagonists = normalized.length;
    }

    // Handle flat characters array if no categories found
    if (characters.length === 0 && charsObj.characters && Array.isArray(charsObj.characters)) {
      characters = charsObj.characters.map(c => normalizeSingleCharacter(c));
    }
  }

  return {
    characters,
    summary: categories
  };
}

function extractCharactersStructure(charData) {
  const empty = {
    protagonists: [],
    supportingCharacters: [],
    antagonists: [],
    relationshipNetwork: {
      direct: [],
      hidden: []
    },
    oocRules: {}
  };

  if (charData == null) {
    return empty;
  }

  if (Array.isArray(charData)) {
    return {
      ...empty,
      protagonists: charData
    };
  }

  let charsObj = charData;

  if (charData.raw && typeof charData.raw === 'string') {
    try {
      const parsedRaw = safeParseLooseJson(charData.raw, 'characters raw');
      if (parsedRaw?.characters) {
        charsObj = parsedRaw.characters;
      } else if (parsedRaw?.protagonists || parsedRaw?.supporting || parsedRaw?.supportingCharacters || parsedRaw?.antagonists) {
        charsObj = parsedRaw;
      }
    } catch (e) {
    }
  }

  if (charsObj === charData && charData.characters) {
    if (typeof charData.characters === 'string') {
      try {
        charsObj = safeParseLooseJson(charData.characters, 'characters string') || charsObj;
      } catch (e) {
      }
    } else if (typeof charData.characters === 'object') {
      charsObj = charData.characters;
    }
  }

  return {
    protagonists: normalizeArray(charsObj?.protagonists),
    supportingCharacters: normalizeArray(charsObj?.supportingCharacters || charsObj?.supporting),
    antagonists: normalizeArray(charsObj?.antagonists),
    relationshipNetwork: charsObj?.relationshipNetwork || empty.relationshipNetwork,
    oocRules: charsObj?.oocRules || {}
  };
}

/**
 * Normalize a single character object to consistent structure
 */
function normalizeSingleCharacter(c) {
  if (typeof c !== 'object' || c === null) {
    return { id: generateId(), name: '未知', roleCategory: 'unknown', roleType: '未知', description: '', traits: [], arc: '' };
  }

  return {
    id: c.id || generateId(),
    name: c.name || c.characterName || '未命名角色',
    roleCategory: c.roleCategory || inferRoleFromName(c.name) || 'supporting',
    roleType: c.roleType || c.role || '配角',
    description: c.description || c.bio || c.background || '',
    traits: normalizeArray(c.traits || c.personalityTraits || c.features),
    arc: c.arc || c.characterArc || c.growth || '',
    relationships: c.relationships || c.relations || [],
    notes: c.notes || c.remarks || ''
  };
}

/**
 * Infer role category from character name (heuristic)
 */
function inferRoleFromName(name) {
  if (!name) return 'supporting';
  const lower = name.toLowerCase();
  if (lower.includes('主角') || lower.includes('hero')) return 'protagonist';
  if (lower.includes('反派') || lower.includes('villain') || lower.includes('antagonist')) return 'antagonist';
  return 'supporting';
}

/**
 * Normalize outline data into a consistent structure.
 * 
 * @param {*} outline - Raw outline data (can be null, string, or object)
 * @returns {Object} Normalized outline with chapterCards, turningPoints, foreshadowing
 */
function normalizeOutline(outline) {
  const empty = {
    chapterCards: [],
    turningPoints: [],
    foreshadowing: [],
    summary: '',
    raw: null
  };

  if (outline == null) {
    return empty;
  }

  let result = { ...empty };

  // Handle raw JSON string
  if (typeof outline === 'string') {
    try {
      outline = JSON.parse(outline);
    } catch (e) {
      // Treat as title/text outline
      return { ...result, summary: outline };
    }
  }

  if (typeof outline !== 'object') {
    return empty;
  }

  result.raw = outline.raw || null;

  // Parse raw if present
  if (outline.raw && typeof outline.raw === 'string') {
    try {
      const parsed = JSON.parse(outline.raw);
      outline = { ...outline, ...parsed };
    } catch (e) {
      // Keep direct fields
    }
  }

  // Extract chapter cards
  result.chapterCards = normalizeArray(outline.chapterCards || outline.chapters || outline.chapterOutline || [])
    .map(ch => normalizeChapterCard(ch));

  // Extract turning points
  result.turningPoints = normalizeArray(outline.turningPoints || outline.turning_points || outline.keyMoments || [])
    .map(tp => ({
      id: tp.id || generateId(),
      chapter: tp.chapter || tp.chapterNumber || 0,
      title: tp.title || tp.name || '转折点',
      description: tp.description || tp.summary || '',
      type: tp.type || 'turning_point'
    }));

  // Extract foreshadowing
  result.foreshadowing = normalizeArray(outline.foreshadowing || outline.foreshadow || [])
    .map(f => ({
      id: f.id || generateId(),
      setup: f.setup || f.setupChapter || '',
      payoff: f.payoff || f.payoffChapter || '',
      description: f.description || f.hint || ''
    }));

  // Generate summary
  result.summary = generateOutlineSummary(result);

  return result;
}

/**
 * Generate human-readable outline summary
 */
function generateOutlineSummary(outline) {
  const parts = [];
  const chapterCount = outline.chapterCards?.length || 0;

  if (chapterCount > 0) {
    parts.push(`共${chapterCount}章`);
    const totalWords = outline.chapterCards.reduce((sum, ch) => sum + (ch.targetWordCount || 0), 0);
    if (totalWords > 0) {
      parts.push(`目标${totalWords.toLocaleString()}字`);
    }
  }

  if (outline.turningPoints?.length > 0) {
    parts.push(`${outline.turningPoints.length}个转折点`);
  }

  if (outline.foreshadowing?.length > 0) {
    parts.push(`${outline.foreshadowing.length}处伏笔`);
  }

  return parts.join(' | ') || '暂无大纲';
}

/**
 * Normalize a chapter card object
 */
function normalizeChapterCard(ch) {
  if (typeof ch !== 'object' || ch === null) {
    return { id: generateId(), number: 0, title: '未知章节', coreEvents: [], scenes: [], targetWordCount: 0 };
  }

  return {
    id: ch.id || generateId(),
    number: ch.number || ch.chapterNum || ch.chapterNumber || 0,
    title: ch.title || ch.chapterTitle || `第${ch.number || 0}章`,
    coreEvents: normalizeArray(ch.coreEvents || ch.events || ch.keyEvents || []),
    scenes: normalizeArray(ch.scenes || ch.sceneList || []),
    targetWordCount: ch.targetWordCount || ch.wordCountTarget || ch.targetWords || 0,
    appearingCharacters: normalizeArray(ch.appearingCharacters || ch.characters || []),
    notes: ch.notes || ch.remarks || ''
  };
}

/**
 * Normalize chapter data into a consistent structure.
 * 
 * @param {*} chapter - Raw chapter data (can be null or object)
 * @returns {Object} Normalized chapter with consistent field names
 */
function normalizeChapter(chapter) {
  const empty = {
    id: null,
    number: 0,
    title: '',
    content: '',
    status: 'unknown',
    wordCount: 0,
    createdAt: null,
    updatedAt: null,
    validation: null,
    metrics: null,
    raw: null
  };

  if (chapter == null) {
    return empty;
  }

  if (typeof chapter !== 'object') {
    return empty;
  }

  let result = { ...empty };

  // Preserve raw for debugging
  if (chapter.content && typeof chapter.content === 'string' && chapter.content.length > 5000) {
    result.raw = chapter.raw || chapter.originalContent || null;
  }

  result.id = chapter.id || chapter.chapterId || null;
  result.number = chapter.number || chapter.chapterNum || chapter.chapterNumber || 0;
  result.title = chapter.title || chapter.chapterTitle || `第${result.number}章`;
  result.content = chapter.content || chapter.text || chapter.body || '';
  result.status = normalizeChapterStatus(chapter.status);
  result.wordCount = chapter.wordCount || chapter.word_count || calculateWordCount(result.content);
  result.createdAt = chapter.createdAt || chapter.createTime || null;
  result.updatedAt = chapter.updatedAt || chapter.updateTime || null;

  // Extract validation if present
  if (chapter.validation || chapter.validations) {
    result.validation = normalizeChapterValidation(chapter.validation || chapter.validations);
  }

  // Extract metrics if present
  if (chapter.metrics || chapter.evaluation || chapter.qualityMetrics) {
    result.metrics = chapter.metrics || chapter.evaluation || chapter.qualityMetrics;
  }

  return result;
}

/**
 * Normalize chapter status to consistent values
 */
function normalizeChapterStatus(status) {
  if (!status) return 'draft';
  const lower = status.toLowerCase();
  if (lower === 'completed' || lower === 'done' || lower === 'final') return 'completed';
  if (lower === 'draft' || lower === '草稿') return 'draft';
  if (lower === 'review' || lower === '审核中') return 'review';
  if (lower === 'revised' || lower === '已修改') return 'revised';
  if (lower === 'polished' || lower === '已润色') return 'polished';
  return 'draft';
}

/**
 * Normalize chapter validation result
 */
function normalizeChapterValidation(validation) {
  if (!validation) return null;
  if (typeof validation === 'string') {
    return { passed: false, issues: [validation], warnings: [] };
  }
  return {
    passed: validation.passed ?? validation.success ?? true,
    issues: normalizeArray(validation.issues || validation.problems || []),
    warnings: normalizeArray(validation.warnings || validation.alerts || [])
  };
}

/**
 * Normalize workflow history into UI-friendly timeline events.
 * 
 * @param {*} history - Raw history array (can be null or array)
 * @returns {Object} Normalized timeline with events and summary
 */
function normalizeWorkflowHistory(history) {
  const empty = {
    events: [],
    summary: { total: 0, byType: {} },
    lastEvent: null
  };

  if (history == null) {
    return empty;
  }

  if (!Array.isArray(history)) {
    return empty;
  }

  const events = history.map(event => normalizeHistoryEvent(event));
  const byType = {};

  events.forEach(event => {
    byType[event.type] = (byType[event.type] || 0) + 1;
  });

  return {
    events,
    summary: {
      total: events.length,
      byType
    },
    lastEvent: events[events.length - 1] || null
  };
}

/**
 * Normalize a single history event to UI-friendly format
 */
function normalizeHistoryEvent(event) {
  if (typeof event !== 'object' || event === null) {
    return { id: generateId(), type: 'unknown', message: '未知事件', timestamp: null, details: null };
  }

  const type = event.type || event.eventType || 'unknown';
  const message = event.message || event.description || generateEventMessage(event);

  return {
    id: event.id || generateId(),
    type,
    phase: event.phase || event.currentPhase || null,
    message,
    timestamp: event.timestamp || event.time || event.createdAt || null,
    user: event.user || event.actor || null,
    details: event.details || event.payload || event.data || null,
    checkpointId: event.checkpointId || event.checkpoint?.id || null,
    checkpointType: event.checkpoint?.type || event.checkpointType || null,
    approved: event.approved ?? event.checkpoint?.approved ?? null,
    rejected: event.rejected ?? event.checkpoint?.rejected ?? null
  };
}

/**
 * Generate human-readable message for history event
 */
function generateEventMessage(event) {
  const type = event.type || event.eventType || '';
  const phase = event.phase || '';

  switch (type) {
    case 'workflow_started':
      return '工作流已启动';
    case 'phase_started':
      return `阶段 ${phase} 开始`;
    case 'phase_completed':
      return `阶段 ${phase} 完成`;
    case 'phase_failed':
      return `阶段 ${phase} 失败`;
    case 'phase_retry':
      return `阶段 ${phase} 重试`;
    case 'checkpoint_pending':
      return '等待检查点审批';
    case 'checkpoint_approved':
      return '检查点已批准';
    case 'checkpoint_rejected':
      return '检查点已拒绝';
    case 'checkpoint_auto_approved':
      return '检查点自动批准';
    case 'workflow_completed':
      return '工作流已完成';
    case 'workflow_recovered':
      return '工作流已恢复';
    default:
      return type;
  }
}

/**
 * Normalize quality scores data.
 * 
 * @param {*} qualityScores - Raw quality scores (can be null, object, or array)
 * @returns {Object} Normalized quality data with dimensions and trends
 */
function normalizeQualityScores(qualityScores) {
  const empty = {
    dimensions: {},
    trends: [],
    overall: null,
    iterationCount: 0,
    summary: ''
  };

  if (qualityScores == null) {
    return empty;
  }

  // Handle array format (multiple iterations)
  if (Array.isArray(qualityScores)) {
    const trends = qualityScores.map(q => normalizeQualityScore(q));
    const latest = trends[trends.length - 1] || {};
    const iterationCount = trends.length;

    return {
      dimensions: latest.dimensions || {},
      trends,
      overall: latest.overall || calculateOverallScore(latest.dimensions),
      iterationCount,
      summary: `迭代${iterationCount}次，最新评分${latest.overall || 'N/A'}`
    };
  }

  if (typeof qualityScores !== 'object') {
    return empty;
  }

  // Single quality score object
  const dimensions = normalizeQualityDimensions(qualityScores.dimensions || qualityScores);

  return {
    dimensions,
    trends: [],
    overall: qualityScores.overall || calculateOverallScore(dimensions),
    iterationCount: qualityScores.iterationCount || qualityScores.iteration || 0,
    summary: `评分${qualityScores.overall || calculateOverallScore(dimensions)}`
  };
}

/**
 * Normalize quality score dimensions
 */
function normalizeQualityDimensions(dims) {
  if (!dims || typeof dims !== 'object') {
    return {};
  }

  const normalized = {};
  const dimensionKeys = ['coherence', 'engagement', 'consistency', 'style', 'dialogue', 'pacing', 'prose', 'originality'];

  dimensionKeys.forEach(key => {
    if (dims[key] != null) {
      normalized[key] = normalizeDimensionScore(dims[key]);
    }
  });

  // Copy any other dimensions not listed
  Object.keys(dims).forEach(key => {
    if (!normalized[key] && typeof dims[key] === 'number') {
      normalized[key] = normalizeDimensionScore(dims[key]);
    }
  });

  return normalized;
}

/**
 * Normalize a single dimension score to 0-100 range
 */
function normalizeDimensionScore(score) {
  if (score == null) return null;
  if (typeof score === 'number') {
    // Assume 0-10 scale, convert to 0-100
    if (score <= 10) return Math.round(score * 10);
    // Already 0-100
    return Math.round(score);
  }
  if (typeof score === 'object') {
    return {
      value: normalizeDimensionScore(score.value ?? score.score ?? score.rating),
      max: score.max || 100
    };
  }
  return null;
}

/**
 * Calculate overall score from dimensions
 */
function calculateOverallScore(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;

  const values = Object.values(dimensions).filter(v => v !== null);
  if (values.length === 0) return null;

  // Handle object scores
  const numericValues = values.map(v => typeof v === 'number' ? v : v.value || 0);
  const sum = numericValues.reduce((a, b) => a + b, 0);
  return Math.round(sum / numericValues.length);
}

/**
 * Extract artifact summary for review queue.
 * Generates human-readable summary of phase artifacts for checkpoint review.
 * 
 * @param {Object} phaseData - Phase data (phase1, phase2, etc.)
 * @param {string} checkpointType - Type of checkpoint (phase1_checkpoint, outline_review, etc.)
 * @returns {Object} Summary object with title, description, keyPoints, warnings
 */
function extractArtifactSummary(phaseData, checkpointType) {
  if (!phaseData) {
    return { title: '无数据', description: '暂无产物数据', keyPoints: [], warnings: [] };
  }

  const checkpointHandlers = {
    'phase1_checkpoint': () => extractPhase1Summary(phaseData),
    'outline_checkpoint': () => extractOutlineSummary(phaseData),
    'content_checkpoint': () => extractContentSummary(phaseData),
    'final_checkpoint': () => extractFinalSummary(phaseData)
  };

  const handler = checkpointHandlers[checkpointType] || (() => ({
    title: '检查点产物',
    description: '请审核以下产物',
    keyPoints: [],
    warnings: []
  }));

  return handler();
}

/**
 * Extract Phase 1 (Worldbuilding) artifact summary
 */
function extractPhase1Summary(phaseData) {
  const worldview = normalizeWorldview(phaseData.worldview);
  const characters = normalizeCharacters(phaseData.characters);

  const keyPoints = [];
  const warnings = [];

  // Worldview key points
  if (worldview.setting) {
    keyPoints.push(`世界设定: ${worldview.setting.substring(0, 80)}...`);
  }
  if (worldview.rules?.length > 0) {
    keyPoints.push(`世界规则: ${worldview.rules.length}条`);
  }
  if (worldview.factions?.length > 0) {
    keyPoints.push(`主要派系: ${worldview.factions.map(f => f.name || f).join('、')}`);
  }

  // Character key points
  keyPoints.push(`角色: ${characters.summary.protagonists}主角 / ${characters.summary.supporting}配角 / ${characters.summary.antagonists}反派`);

  // Validation warnings
  if (phaseData.validation?.issues?.length > 0) {
    warnings.push(...phaseData.validation.issues.slice(0, 3));
  }

  return {
    title: '世界观与角色设定',
    description: `已完成 ${characters.characters.length} 个角色的设定`,
    keyPoints,
    warnings
  };
}

/**
 * Extract Outline artifact summary
 */
function extractOutlineSummary(phaseData) {
  const outline = normalizeOutline(phaseData.outline);
  const chapters = normalizeArray(phaseData.chapters || []).map(ch => normalizeChapter(ch));

  const keyPoints = [];
  const warnings = [];

  // Outline key points
  keyPoints.push(`章节大纲: ${outline.chapterCards.length}章`);
  if (outline.turningPoints?.length > 0) {
    keyPoints.push(`转折点: ${outline.turningPoints.length}处`);
  }
  if (outline.foreshadowing?.length > 0) {
    keyPoints.push(`伏笔: ${outline.foreshadowing.length}处`);
  }

  // Chapter summary
  const totalTargetWords = chapters.reduce((sum, ch) => sum + (ch.targetWordCount || 0), 0);
  if (totalTargetWords > 0) {
    keyPoints.push(`目标字数: ${totalTargetWords.toLocaleString()}`);
  }

  return {
    title: '故事大纲',
    description: `共${outline.chapterCards.length}章的大纲规划`,
    keyPoints,
    warnings
  };
}

/**
 * Extract Content (Chapter Drafts) artifact summary
 */
function extractContentSummary(phaseData) {
  const chapters = normalizeArray(phaseData.chapters || []).map(ch => normalizeChapter(ch));

  const keyPoints = [];
  const warnings = [];

  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);
  const draftCount = chapters.filter(ch => ch.status === 'draft').length;
  const completedCount = chapters.filter(ch => ch.status === 'completed').length;

  keyPoints.push(`章节: ${chapters.length}章 (${completedCount}完成 / ${draftCount}草稿)`);
  keyPoints.push(`累计字数: ${totalWords.toLocaleString()}`);

  // Validation issues
  chapters.forEach(ch => {
    if (ch.validation?.issues?.length > 0) {
      warnings.push(`第${ch.number}章: ${ch.validation.issues[0]}`);
    }
  });

  return {
    title: '章节草稿',
    description: `${completedCount}章已完成，共${totalWords.toLocaleString()}字`,
    keyPoints,
    warnings: warnings.slice(0, 5)
  };
}

/**
 * Extract Final artifact summary
 */
function extractFinalSummary(phaseData) {
  const qualityScores = normalizeQualityScores(phaseData.qualityScores);
  const chapters = normalizeArray(phaseData.polishedChapters || phaseData.chapters || []).map(ch => normalizeChapter(ch));

  const keyPoints = [];
  const warnings = [];

  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);

  if (qualityScores.overall) {
    keyPoints.push(`综合质量评分: ${qualityScores.overall}/100`);
  }

  if (phaseData.iterationCount) {
    keyPoints.push(`润色迭代: ${phaseData.iterationCount}次`);
  }

  keyPoints.push(`最终字数: ${totalWords.toLocaleString()}`);

  if (phaseData.finalEditorOutput) {
    keyPoints.push('最终编辑: 已完成');
  }

  return {
    title: '最终稿件',
    description: `已完成最终润色，共${totalWords.toLocaleString()}字`,
    keyPoints,
    warnings
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalize any value to array
 */
function normalizeArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Generate a simple unique ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Calculate word count (rough Chinese/English estimation)
 */
function calculateWordCount(text) {
  if (!text || typeof text !== 'string') return 0;
  // Chinese characters count as 1 word, English words by space
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  return chineseChars + englishWords;
}

/**
 * Register routes
 * @param {import('express').Express} app
 * @param {import('express').Router} adminApiRouter
 * @param {object} pluginConfig 来自plugin-manifest.json解析后的配置
 * @param {string} projectBasePath VCP主项目根目录
 */
function registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath) {
  const debug = !!pluginConfig.DebugMode;

  const panelPrefix = pluginConfig.PanelPathPrefix || '/AdminPanel/StoryOrchestrator';
  const apiPrefix = pluginConfig.ApiPathPrefix || '/admin_api/story-orchestrator-panel';

  // StoryOrchestrator状态文件目录
  const storiesDir = path.join(projectBasePath, 'Plugin', 'StoryOrchestrator', 'state', 'stories');

  if (debug) {
    console.log(`[StoryOrchestratorPanel] panelPrefix: ${panelPrefix}`);
    console.log(`[StoryOrchestratorPanel] apiPrefix: ${apiPrefix}`);
    console.log(`[StoryOrchestratorPanel] storiesDir: ${storiesDir}`);
  }

  // 1. 挂载前端静态资源
  const frontendDir = path.join(__dirname, 'frontend');
  app.use(panelPrefix, require('express').static(frontendDir));

  // 2. 创建API路由
  const router = require('express').Router();

  /**
   * 获取所有故事列表
   * GET /admin_api/story-orchestrator-panel/stories
   */
  router.get('/stories', async (req, res) => {
    try {
      // 检查目录是否存在
      try {
        await fs.access(storiesDir);
      } catch {
        return res.json({ success: true, stories: [], total: 0 });
      }

      const files = await fs.readdir(storiesDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      const stories = await Promise.all(
        jsonFiles.map(async (file) => {
          try {
            const content = await fs.readFile(path.join(storiesDir, file), 'utf8');
            const data = JSON.parse(content);
            return formatStoryListItem(data);
          } catch (err) {
            if (debug) console.error(`[StoryOrchestratorPanel] Error reading ${file}:`, err.message);
            return null;
          }
        })
      );

      // 过滤掉读取失败的，按更新时间排序
      const validStories = stories
        .filter(s => s !== null)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      res.json({
        success: true,
        stories: validStories,
        total: validStories.length
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error listing stories:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取单个故事详情
   * GET /admin_api/story-orchestrator-panel/stories/:id
   */
  router.get('/stories/:id', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      res.json({
        success: true,
        story: formatStoryDetail(data)
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting story:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/stories/:id/phase1', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);
      const phase1 = data.phase1 || {};
      const worldview = normalizeWorldview(phase1.worldview);
      const characters = extractCharactersStructure(phase1.characters);
      const normalizedCharacters = normalizeCharacters(phase1.characters);

      res.json({
        success: true,
        phase1: {
          worldview,
          characters,
          characterSummary: normalizedCharacters.summary,
          allCharacters: normalizedCharacters.characters,
          validation: phase1.validation || null,
          userConfirmed: phase1.userConfirmed || false,
          checkpointId: phase1.checkpointId || null,
          status: phase1.status || 'pending'
        }
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting phase1 data:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取故事章节列表
   * GET /admin_api/story-orchestrator-panel/stories/:id/chapters
   */
  router.get('/stories/:id/chapters', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      const chapters = data.phase2?.chapters || [];
      const formattedChapters = chapters.map(ch => ({
        number: ch.chapterNum || ch.number,
        title: ch.title || `第${ch.chapterNum || ch.number}章`,
        status: ch.status || 'draft',
        wordCount: ch.wordCount || 0,
        updatedAt: ch.updatedAt
      }));

      res.json({
        success: true,
        chapters: formattedChapters,
        total: formattedChapters.length,
        currentChapter: data.phase2?.currentChapter || 0
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting chapters:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取单个章节详情
   * GET /admin_api/story-orchestrator-panel/stories/:id/chapters/:chapterNumber
   */
  router.get('/stories/:id/chapters/:chapterNumber', async (req, res) => {
    try {
      const storyId = req.params.id;
      const chapterNumber = parseInt(req.params.chapterNumber, 10);
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      const chapters = data.phase2?.chapters || [];
      const chapter = chapters.find(ch => (ch.chapterNum || ch.number) === chapterNumber);

      if (!chapter) {
        return res.status(404).json({ success: false, error: 'Chapter not found' });
      }

      res.json({
        success: true,
        chapter: {
          number: chapter.number,
          title: chapter.title || `第${chapter.number}章`,
          content: chapter.content || '',
          status: chapter.status || 'draft',
          wordCount: chapter.wordCount || 0,
          createdAt: chapter.createdAt,
          updatedAt: chapter.updatedAt
        }
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting chapter:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取角色列表
   * GET /admin_api/story-orchestrator-panel/stories/:id/characters
   */
  router.get('/stories/:id/characters', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      let characters = [];
      const charData = data.phase1?.characters;

      if (charData) {
        if (Array.isArray(charData)) {
          characters = charData;
        } else if (typeof charData === 'object') {
          let charsObj = charData;

          // Try to get richer data from raw field first
          if (charData.raw && typeof charData.raw === 'string') {
            try {
              const parsedRaw = JSON.parse(charData.raw);
              if (parsedRaw.characters) {
                charsObj = parsedRaw.characters;
                console.log('[StoryOrchestratorPanel] Using characters from raw field');
              }
            } catch (e) {
              console.error('[StoryOrchestratorPanel] Failed to parse characters raw:', e.message);
            }
          }

          // If no raw data, try characters field
          if (charsObj === charData && charData.characters && typeof charData.characters === 'string') {
            try {
              charsObj = JSON.parse(charData.characters);
            } catch (e) {
              console.error('[StoryOrchestratorPanel] Failed to parse characters string:', e.message);
            }
          }

          // Extract characters from all categories
          if (charsObj) {
            if (charsObj.protagonists && Array.isArray(charsObj.protagonists)) {
              characters = characters.concat(charsObj.protagonists.map(c => ({...c, roleType: '主角', roleCategory: 'protagonist'})));
            }
            
            // Handle both supporting and supportingCharacters keys
            let supportingList = null;
            if (charsObj.supporting && Array.isArray(charsObj.supporting)) {
                supportingList = charsObj.supporting;
            } else if (charsObj.supportingCharacters && Array.isArray(charsObj.supportingCharacters)) {
                supportingList = charsObj.supportingCharacters;
            }
            
            if (supportingList && Array.isArray(supportingList)) {
              characters = characters.concat(supportingList.map(c => ({...c, roleType: '配角', roleCategory: 'supporting'})));
            }
            
            if (charsObj.antagonists && Array.isArray(charsObj.antagonists)) {
              characters = characters.concat(charsObj.antagonists.map(c => ({...c, roleType: '反派', roleCategory: 'antagonist'})));
            }
          }
        }
      }

      console.log(`[StoryOrchestratorPanel] Returning ${characters.length} characters`);

      res.json({
        success: true,
        characters: characters,
        total: characters.length,
        categories: {
          protagonists: characters.filter(c => c.roleCategory === 'protagonist').length,
          supporting: characters.filter(c => c.roleCategory === 'supporting').length,
          antagonists: characters.filter(c => c.roleCategory === 'antagonist').length
        }
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting characters:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取世界观信息
   * GET /admin_api/story-orchestrator-panel/stories/:id/worldview
   */
  router.get('/stories/:id/worldview', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      let worldview = data.phase1?.worldview || null;

      // Parse the raw JSON string which contains the full worldview structure
      if (worldview && worldview.raw && typeof worldview.raw === 'string') {
        try {
          const parsedRaw = JSON.parse(worldview.raw);
          worldview = {
            ...worldview,
            ...parsedRaw,
            setting: parsedRaw.setting || worldview.setting || '',
            rules: parsedRaw.rules || null,
            factions: parsedRaw.factions || [],
            history: parsedRaw.history || []
          };
          console.log('[StoryOrchestratorPanel] Parsed worldview from raw:', {
            hasSetting: !!parsedRaw.setting,
            factionsCount: parsedRaw.factions?.length || 0,
            hasRules: !!parsedRaw.rules
          });
        } catch (e) {
          console.error('[StoryOrchestratorPanel] Failed to parse worldview raw:', e.message);
        }
      }

      res.json({
        success: true,
        worldview: worldview,
        phase1Status: data.phase1?.status || 'pending',
        userConfirmed: data.phase1?.userConfirmed || false
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting worldview:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取大纲信息
   * GET /admin_api/story-orchestrator-panel/stories/:id/outline
   */
  router.get('/stories/:id/outline', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      res.json({
        success: true,
        outline: data.phase2?.outline || null,
        phase2Status: data.phase2?.status || 'pending',
        userConfirmed: data.phase2?.userConfirmed || false
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting outline:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 获取工作流历史
   * GET /admin_api/story-orchestrator-panel/stories/:id/history
   */
  router.get('/stories/:id/history', async (req, res) => {
    try {
      const storyId = req.params.id;
      const storyPath = path.join(storiesDir, `${storyId}.json`);

      try {
        await fs.access(storyPath);
      } catch {
        return res.status(404).json({ success: false, error: 'Story not found' });
      }

      const content = await fs.readFile(storyPath, 'utf8');
      const data = JSON.parse(content);

      res.json({
        success: true,
        history: data.workflow?.history || [],
        currentState: data.workflow?.state || 'idle',
        currentPhase: data.workflow?.currentPhase || null,
        activeCheckpoint: data.workflow?.activeCheckpoint || null
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error getting history:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 批准检查点
   * POST /admin_api/story-orchestrator-panel/stories/:id/checkpoints/:checkpointId/approve
   */
  router.post('/stories/:id/checkpoints/:checkpointId/approve', async (req, res) => {
    try {
      const { id: storyId, checkpointId } = req.params;
      const { feedback } = req.body || {};

      if (debug) {
        console.log(`[StoryOrchestratorPanel] Approve checkpoint: ${checkpointId} for story: ${storyId}`);
      }

      const result = await StoryOrchestrator.processToolCall({
        command: 'UserConfirmCheckpoint',
        story_id: storyId,
        checkpoint_id: checkpointId,
        approval: true,
        feedback: feedback || ''
      });

      if (result.status === 'error') {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        result: result.result || result
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error approving checkpoint:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 拒绝检查点
   * POST /admin_api/story-orchestrator-panel/stories/:id/checkpoints/:checkpointId/reject
   */
  router.post('/stories/:id/checkpoints/:checkpointId/reject', async (req, res) => {
    try {
      const { id: storyId, checkpointId } = req.params;
      const { feedback } = req.body || {};

      if (debug) {
        console.log(`[StoryOrchestratorPanel] Reject checkpoint: ${checkpointId} for story: ${storyId}`);
      }

      const result = await StoryOrchestrator.processToolCall({
        command: 'UserConfirmCheckpoint',
        story_id: storyId,
        checkpoint_id: checkpointId,
        approval: false,
        feedback: feedback || ''
      });

      if (result.status === 'error') {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        result: result.result || result
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error rejecting checkpoint:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 恢复工作流
   * POST /admin_api/story-orchestrator-panel/stories/:id/recover
   */
  router.post('/stories/:id/recover', async (req, res) => {
    try {
      const { id: storyId } = req.params;
      const { recovery_action, target_phase, target_checkpoint, feedback } = req.body || {};

      if (debug) {
        console.log(`[StoryOrchestratorPanel] Recover story: ${storyId}, action: ${recovery_action}`);
      }

      const result = await StoryOrchestrator.processToolCall({
        command: 'RecoverStoryWorkflow',
        story_id: storyId,
        recovery_action: recovery_action || 'continue',
        target_phase: target_phase || null,
        target_checkpoint: target_checkpoint || null,
        feedback: feedback || null
      });

      if (result.status === 'error') {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        result: result.result || result
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error recovering story:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 重试阶段
   * POST /admin_api/story-orchestrator-panel/stories/:id/retry-phase
   */
  router.post('/stories/:id/retry-phase', async (req, res) => {
    try {
      const { id: storyId } = req.params;
      const { phase_name, reason } = req.body || {};

      if (!phase_name || !['phase1', 'phase2', 'phase3'].includes(phase_name)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or missing phase_name. Must be phase1, phase2, or phase3'
        });
      }

      if (debug) {
        console.log(`[StoryOrchestratorPanel] Retry phase: ${phase_name} for story: ${storyId}`);
      }

      const result = await StoryOrchestrator.processToolCall({
        command: 'RetryPhase',
        story_id: storyId,
        phase_name,
        reason: reason || 'Manual retry requested via panel'
      });

      if (result.status === 'error') {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        result: result.result || result
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error retrying phase:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * 导出故事
   * POST /admin_api/story-orchestrator-panel/stories/:id/export
   */
  router.post('/stories/:id/export', async (req, res) => {
    try {
      const { id: storyId } = req.params;
      const { format } = req.body || {};

      const validFormats = ['markdown', 'txt', 'json'];
      const exportFormat = validFormats.includes(format) ? format : 'markdown';

      if (debug) {
        console.log(`[StoryOrchestratorPanel] Export story: ${storyId}, format: ${exportFormat}`);
      }

      const result = await StoryOrchestrator.processToolCall({
        command: 'ExportStory',
        story_id: storyId,
        format: exportFormat
      });

      if (result.status === 'error') {
        return res.status(400).json({ success: false, error: result.error });
      }

      res.json({
        success: true,
        ...result.result
      });
    } catch (error) {
      console.error('[StoryOrchestratorPanel] Error exporting story:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 挂载API路由
  app.use(apiPrefix, router);

  console.log(`[StoryOrchestratorPanel] Panel served at ${panelPrefix}`);
  console.log(`[StoryOrchestratorPanel] API available at ${apiPrefix}`);
}

/**
 * 格式化故事列表项（摘要信息）
 */
function normalizeTargetWordCount(targetWordCount) {
  if (typeof targetWordCount === 'number' && Number.isFinite(targetWordCount) && targetWordCount > 0) {
    return {
      min: targetWordCount,
      max: targetWordCount
    };
  }

  if (targetWordCount && typeof targetWordCount === 'object') {
    const min = Number(targetWordCount.min ?? targetWordCount.minimum ?? targetWordCount.target ?? 0) || 0;
    const max = Number(targetWordCount.max ?? targetWordCount.maximum ?? targetWordCount.target ?? min) || min;
    const normalizedMin = Math.max(0, Math.min(min || max, max || min));
    const normalizedMax = Math.max(normalizedMin, Math.max(min, max));

    if (normalizedMin > 0 || normalizedMax > 0) {
      return {
        min: normalizedMin,
        max: normalizedMax
      };
    }
  }

  return {
    min: 2500,
    max: 3500
  };
}

function formatTargetWordCountLabel(targetWordCount) {
  const normalized = normalizeTargetWordCount(targetWordCount);

  if (normalized.min === normalized.max) {
    return `${normalized.min.toLocaleString()} 字`;
  }

  return `${normalized.min.toLocaleString()} - ${normalized.max.toLocaleString()} 字`;
}

function extractStoryShortId(storyId) {
  if (typeof storyId !== 'string' || !storyId) {
    return '';
  }

  return storyId.startsWith('story-') ? storyId.slice(6) : storyId;
}

function formatStoryListItem(data) {
  // 计算整体进度
  const progress = calculateProgress(data);
  const targetWordCount = normalizeTargetWordCount(data.config?.targetWordCount);
  const phaseStatuses = {
    phase1: data.phase1?.status,
    phase2: data.phase2?.status,
    phase3: data.phase3?.status
  };
  const retryingPhase = ['phase1', 'phase2', 'phase3'].find(phase => {
    return data.status === `${phase}_retrying` || phaseStatuses[phase] === 'retrying';
  });

  // 确定当前阶段显示
  let phaseDisplay = '未开始';
  let phaseClass = 'pending';

  if (data.workflow?.currentPhase) {
    switch (data.workflow.currentPhase) {
      case 'phase1':
        phaseDisplay = '阶段1: 世界观搭建';
        phaseClass = 'phase1';
        break;
      case 'phase2':
        phaseDisplay = '阶段2: 大纲与正文';
        phaseClass = 'phase2';
        break;
      case 'phase3':
        phaseDisplay = '阶段3: 润色校验';
        phaseClass = 'phase3';
        break;
      default:
        phaseDisplay = data.workflow.currentPhase;
    }
  }

  if (data.status === 'completed') {
    phaseDisplay = '已完成';
    phaseClass = 'completed';
  }

  if (retryingPhase) {
    const retryingLabels = {
      phase1: '阶段1：正在根据退回意见重建设定',
      phase2: '阶段2：正在根据退回意见重写大纲正文',
      phase3: '阶段3：正在根据退回意见重新润色'
    };
    phaseDisplay = retryingLabels[retryingPhase] || '正在重新生成';
    phaseClass = 'retrying';
  }

  // 获取检查点信息
  const hasCheckpoint = !!data.workflow?.activeCheckpoint;
  const checkpointPending = hasCheckpoint && data.workflow.activeCheckpoint.status === 'pending';

  return {
    id: data.id,
    shortId: extractStoryShortId(data.id),
    title: data.config?.title || data.config?.storyPrompt?.substring(0, 50) + '...' || '未命名故事',
    genre: data.config?.genre || 'general',
    targetWordCount,
    targetWordCountLabel: formatTargetWordCountLabel(targetWordCount),
    status: data.status || 'idle',
    phase: data.workflow?.currentPhase || null,
    phaseDisplay,
    phaseClass,
    isRetrying: !!retryingPhase,
    retryingPhase,
    progress,
    checkpointPending,
    checkpointType: data.workflow?.activeCheckpoint?.type || null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

/**
 * 格式化故事详情
 */
function formatStoryDetail(data) {
  const base = formatStoryListItem(data);

  // 章节统计
  const chapters = data.phase2?.chapters || [];
  const isCompleted = (status) => status && (status === 'completed' || status.startsWith('completed'));
  const chapterStats = {
    total: chapters.length,
    completed: chapters.filter(ch => isCompleted(ch.status)).length,
    draft: chapters.filter(ch => ch.status === 'draft').length,
    totalWordCount: chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0)
  };

  // 角色统计（适配新格式）
  let characterCount = 0;
  const charData = data.phase1?.characters;
  if (charData) {
    if (Array.isArray(charData)) {
      characterCount = charData.length;
    } else if (charData.characters) {
      // 新格式：{characters: {protagonists: [...], supporting: [...]}}
      const chars = charData.characters;
      if (chars.protagonists) characterCount += chars.protagonists.length;
      if (chars.supporting) characterCount += chars.supporting.length;
      if (chars.supportingCharacters) characterCount += chars.supportingCharacters.length;
      if (chars.antagonists) characterCount += chars.antagonists.length;
    } else {
      if (charData.protagonists) characterCount += charData.protagonists.length;
      if (charData.supporting) characterCount += charData.supporting.length;
      if (charData.supportingCharacters) characterCount += charData.supportingCharacters.length;
      if (charData.antagonists) characterCount += charData.antagonists.length;
    }
  }

  return {
    ...base,
    storyPrompt: data.config?.storyPrompt || '',
    stylePreference: data.config?.stylePreference || '',
    chapterStats,
    characterCount,
    hasWorldview: !!data.phase1?.worldview,
    hasOutline: !!data.phase2?.outline,
    phase1Completed: data.phase1?.userConfirmed || false,
    phase2Completed: data.phase2?.userConfirmed || false,
    phase3Completed: data.phase3?.userConfirmed || false,
    lastRejectionFeedback: data[base.retryingPhase]?.lastRejectionFeedback || null,
    lastRejectedAt: data[base.retryingPhase]?.lastRejectedAt || null,
    workflow: {
      state: data.workflow?.state || 'idle',
      currentPhase: data.workflow?.currentPhase || null,
      currentStep: data.workflow?.currentStep || null,
      activeCheckpoint: data.workflow?.activeCheckpoint || null,
      retryCount: data.workflow?.retryContext?.attempt || 0
    }
  };
}

/**
 * 计算故事整体进度百分比
 */
function calculateProgress(data) {
  if (data.status === 'completed') return 100;

  const phase = data.workflow?.currentPhase;
  const phaseStatuses = {
    phase1: data.phase1?.status,
    phase2: data.phase2?.status,
    phase3: data.phase3?.status
  };

  // 基础进度（每阶段33%）
  let progress = 0;

  // Phase 1 贡献
  if (phaseStatuses.phase1 === 'completed' || data.phase1?.userConfirmed) {
    progress += 33;
  } else if (phaseStatuses.phase1 === 'running' || phaseStatuses.phase1 === 'retrying') {
    progress += 15;
  }

  // Phase 2 贡献
  if (phaseStatuses.phase2 === 'completed' || data.phase2?.userConfirmed) {
    progress += 33;
  } else if (phaseStatuses.phase2 === 'running' || phaseStatuses.phase2 === 'retrying') {
    const chapters = data.phase2?.chapters || [];
    const totalChapters = chapters.length || 5; // 预估5章
    const isCompleted = (status) => status && (status === 'completed' || status.startsWith('completed'));
    const completedChapters = chapters.filter(ch => isCompleted(ch.status)).length;
    progress += 15 + Math.round((completedChapters / totalChapters) * 18);
  }

  // Phase 3 贡献
  if (phaseStatuses.phase3 === 'completed' || data.phase3?.userConfirmed) {
    progress += 34;
  } else if (phaseStatuses.phase3 === 'running' || phaseStatuses.phase3 === 'retrying') {
    const iteration = data.phase3?.iterationCount || 0;
    const maxIterations = 5;
    progress += Math.round((iteration / maxIterations) * 34);
  }

  return Math.min(progress, 99);
}

module.exports = {
  registerRoutes,
  normalizeWorldview,
  normalizeCharacters,
  normalizeOutline,
  normalizeChapter,
  normalizeWorkflowHistory,
  normalizeQualityScores,
  extractArtifactSummary,
  normalizeTargetWordCount,
  formatTargetWordCountLabel,
  extractStoryShortId
};
