/**
 * 输入验证模式
 * 用于验证各种输入参数
 */

const ValidationSchemas = {
  /**
   * 启动项目参数验证
   */
  startStoryProject: {
    story_prompt: { type: 'string', required: true, minLength: 10 },
    target_word_count: { type: 'number', required: false, min: 500, max: 50000 },
    genre: { type: 'string', required: false, maxLength: 50 },
    style_preference: { type: 'string', required: false, maxLength: 200 }
  },

  /**
   * 查询状态参数验证
   */
  queryStoryStatus: {
    story_id: { type: 'string', required: true, pattern: /^story-[a-zA-Z0-9]+$/ }
  },

  /**
   * 用户确认检查点参数验证
   */
  userConfirmCheckpoint: {
    story_id: { type: 'string', required: true },
    checkpoint_id: { type: 'string', required: true },
    approval: { type: 'boolean', required: true },
    feedback: { type: 'string', required: false, maxLength: 2000 }
  },

  /**
   * 创建章节草稿参数验证
   */
  createChapterDraft: {
    story_id: { type: 'string', required: true },
    chapter_number: { type: 'number', required: true, min: 1, max: 100 },
    outline_context: { type: 'string', required: true, minLength: 10 },
    target_word_count: { type: 'number', required: false, min: 500, max: 10000 }
  },

  /**
   * 审查章节参数验证
   */
  reviewChapter: {
    story_id: { type: 'string', required: true },
    chapter_number: { type: 'number', required: true, min: 1 },
    chapter_content: { type: 'string', required: true, minLength: 100 },
    review_focus: { type: 'string', required: false, maxLength: 500 }
  },

  /**
   * 修订章节参数验证
   */
  reviseChapter: {
    story_id: { type: 'string', required: true },
    chapter_number: { type: 'number', required: true, min: 1 },
    chapter_content: { type: 'string', required: true, minLength: 100 },
    revision_instructions: { type: 'string', required: true, minLength: 10 },
    issues: { type: 'array', required: false },
    max_rewrite_ratio: { type: 'number', required: false, min: 0, max: 1 }
  },

  /**
   * 润色章节参数验证
   */
  polishChapter: {
    story_id: { type: 'string', required: true },
    chapter_number: { type: 'number', required: true, min: 1 },
    chapter_content: { type: 'string', required: true, minLength: 100 },
    polish_focus: { type: 'string', required: false, maxLength: 500 }
  },

  /**
   * 字数统计参数验证
   */
  countChapterMetrics: {
    chapter_content: { type: 'string', required: true },
    target_min: { type: 'number', required: false, min: 0 },
    target_max: { type: 'number', required: false, min: 0 },
    count_mode: { type: 'string', required: false, enum: ['cn_chars', 'non_whitespace'] },
    length_policy: { type: 'string', required: false, enum: ['range', 'min_only'] }
  },

  /**
   * 导出故事参数验证
   */
  exportStory: {
    story_id: { type: 'string', required: true },
    format: { type: 'string', required: false, enum: ['markdown', 'txt', 'json'] }
  }
};

/**
 * 验证输入数据
 * @param {string} schemaName - 验证模式名称
 * @param {Object} data - 待验证的数据
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateInput(schemaName, data) {
  const schema = ValidationSchemas[schemaName];
  if (!schema) {
    return { valid: false, errors: [`未知的验证模式: ${schemaName}`] };
  }

  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    // 检查必需字段
    if (rules.required && (value === undefined || value === null)) {
      errors.push(`字段 '${field}' 是必需的`);
      continue;
    }

    // 如果字段不存在且非必需，跳过验证
    if (value === undefined || value === null) {
      continue;
    }

    // 类型验证
    if (rules.type && !validateType(value, rules.type)) {
      errors.push(`字段 '${field}' 类型错误，期望 ${rules.type}，实际为 ${typeof value}`);
      continue;
    }

    // 字符串长度验证
    if (rules.type === 'string') {
      if (rules.minLength !== undefined && value.length < rules.minLength) {
        errors.push(`字段 '${field}' 长度不足，最小需要 ${rules.minLength} 字符`);
      }
      if (rules.maxLength !== undefined && value.length > rules.maxLength) {
        errors.push(`字段 '${field}' 长度超过限制，最大允许 ${rules.maxLength} 字符`);
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push(`字段 '${field}' 格式不匹配`);
      }
    }

    // 数值范围验证
    if (rules.type === 'number') {
      if (rules.min !== undefined && value < rules.min) {
        errors.push(`字段 '${field}' 小于最小值 ${rules.min}`);
      }
      if (rules.max !== undefined && value > rules.max) {
        errors.push(`字段 '${field}' 超过最大值 ${rules.max}`);
      }
    }

    // 数组验证
    if (rules.type === 'array' && !Array.isArray(value)) {
      errors.push(`字段 '${field}' 必须是数组`);
    }

    // 枚举验证
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push(`字段 '${field}' 必须是以下值之一: ${rules.enum.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证类型
 * @private
 */
function validateType(value, expectedType) {
  if (expectedType === 'array') {
    return Array.isArray(value);
  }
  return typeof value === expectedType;
}

module.exports = {
  ValidationSchemas,
  validateInput
};
