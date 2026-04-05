/**
 * 文本指标计算工具
 * 提供字数统计、文本分析等功能
 */

class TextMetrics {
  /**
   * 分析文本并返回完整指标
   * @param {string} text - 待分析的文本
   * @returns {Object} 文本指标对象
   */
  analyze(text) {
    if (!text || typeof text !== 'string') {
      return this._emptyMetrics();
    }

    const rawChars = text.length;
    const chineseChars = this._countChineseChars(text);
    const nonWhitespaceChars = this._countNonWhitespaceChars(text);
    const paragraphCount = this._countParagraphs(text);
    const sentenceCount = this._countSentences(text);
    const avgSentenceLength = sentenceCount > 0 ? Math.round(nonWhitespaceChars / sentenceCount) : 0;
    
    return {
      rawChars,
      chineseChars,
      nonWhitespaceChars,
      paragraphCount,
      sentenceCount,
      avgSentenceLength,
      wordDensity: rawChars > 0 ? (nonWhitespaceChars / rawChars).toFixed(2) : '0.00'
    };
  }

  /**
   * 统计中文字符数（不含标点）
   * @param {string} text 
   * @returns {number}
   */
  _countChineseChars(text) {
    // 匹配中文字符（包括中文标点）
    const matches = text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g);
    return matches ? matches.length : 0;
  }

  /**
   * 统计非空白字符数
   * @param {string} text 
   * @returns {number}
   */
  _countNonWhitespaceChars(text) {
    return text.replace(/\s/g, '').length;
  }

  /**
   * 统计段落数
   * @param {string} text 
   * @returns {number}
   */
  _countParagraphs(text) {
    // 按空行分割，过滤空段落
    const paragraphs = text.split(/\n\s*\n/);
    return paragraphs.filter(p => p.trim().length > 0).length;
  }

  /**
   * 统计句子数
   * @param {string} text 
   * @returns {number}
   */
  _countSentences(text) {
    // 按句号、问号、感叹号分割
    const sentences = text.split(/[。！？.!?]+/);
    return sentences.filter(s => s.trim().length > 0).length;
  }

  /**
   * 验证字数是否达标
   * @param {number} actualCount - 实际字数
   * @param {number} targetMin - 目标最小值
   * @param {number} targetMax - 目标最大值
   * @param {string} policy - 策略: 'range' 或 'min_only'
   * @returns {Object} 验证结果
   */
  validateLength(actualCount, targetMin, targetMax, policy = 'range') {
    let isQualified, rangeStatus, suggestion;
    const min = targetMin ?? 0;
    const max = targetMax ?? Number.MAX_SAFE_INTEGER;

    if (policy === 'min_only') {
      if (actualCount < min) {
        rangeStatus = 'below_min';
        isQualified = false;
        suggestion = `字数低于下限，需补充 ${min - actualCount} 字`;
      } else {
        rangeStatus = actualCount > max ? 'above_max_ignored' : 'within_range';
        isQualified = true;
        suggestion = actualCount > max 
          ? '字数超过参考上限，但按min_only策略通过'
          : '字数达标';
      }
    } else {
      if (actualCount < min) {
        rangeStatus = 'below_min';
        isQualified = false;
        suggestion = `字数低于下限，需补充 ${min - actualCount} 字`;
      } else if (actualCount > max) {
        rangeStatus = 'above_max';
        isQualified = false;
        suggestion = `字数超过上限，需精简 ${actualCount - max} 字`;
      } else {
        rangeStatus = 'within_range';
        isQualified = true;
        suggestion = '字数在目标范围内';
      }
    }

    return {
      isQualified,
      rangeStatus,
      suggestion,
      deficit: actualCount < min ? min - actualCount : 0,
      excess: actualCount > max ? actualCount - max : 0,
      actualCount,
      targetRange: { min, max }
    };
  }

  /**
   * 提取文本摘要（前N个字符）
   * @param {string} text 
   * @param {number} maxLength 
   * @returns {string}
   */
  extractSummary(text, maxLength = 200) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /**
   * 分析文本结构
   * @param {string} text 
   * @returns {Object}
   */
  analyzeStructure(text) {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    const structure = {
      totalParagraphs: paragraphs.length,
      dialogueParagraphs: 0,
      descriptionParagraphs: 0,
      actionParagraphs: 0,
      averageParagraphLength: 0
    };

    let totalLength = 0;

    paragraphs.forEach(p => {
      const trimmed = p.trim();
      totalLength += trimmed.length;

      // 检测对话（包含引号）
      if (/[""''"']/.test(trimmed)) {
        structure.dialogueParagraphs++;
      }
      // 检测动作（包含动词短语）
      else if (/\b(跑|走|跳|打|拿|看|说|想)\b/.test(trimmed)) {
        structure.actionParagraphs++;
      }
      // 其他归为描写
      else {
        structure.descriptionParagraphs++;
      }
    });

    structure.averageParagraphLength = paragraphs.length > 0 
      ? Math.round(totalLength / paragraphs.length) 
      : 0;

    return structure;
  }

  /**
   * 返回空指标对象
   * @private
   */
  _emptyMetrics() {
    return {
      rawChars: 0,
      chineseChars: 0,
      nonWhitespaceChars: 0,
      paragraphCount: 0,
      sentenceCount: 0,
      avgSentenceLength: 0,
      wordDensity: '0.00'
    };
  }
}

module.exports = { TextMetrics };
