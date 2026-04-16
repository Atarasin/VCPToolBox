class SchemaValidator {
  static validateWorldview(worldview) {
    const result = {
      valid: false,
      schemaValid: false,
      completenessValid: false,
      errors: [],
      warnings: []
    };

    if (!worldview || typeof worldview !== 'object') {
      result.errors.push('worldview 必须是对象');
      return result;
    }

    const allowedTopKeys = ['setting', 'rules', 'factions', 'history', 'sceneNorms', 'secrets'];
    const topKeys = Object.keys(worldview);
    const extraKeys = topKeys.filter(k => !allowedTopKeys.includes(k));
    if (extraKeys.length > 0) {
      result.errors.push(`顶层存在非法字段: ${extraKeys.join(', ')}`);
    }

    if (worldview.rules && typeof worldview.rules === 'object') {
      const allowedRulesKeys = ['physical', 'special', 'limitations'];
      const rulesKeys = Object.keys(worldview.rules);
      const extraRulesKeys = rulesKeys.filter(k => !allowedRulesKeys.includes(k));
      if (extraRulesKeys.length > 0) {
        result.errors.push(`rules 内存在非法嵌套字段: ${extraRulesKeys.join(', ')}`);
      }

      const dangerousKeys = ['factions', 'history', 'sceneNorms', 'secrets'];
      for (const dk of dangerousKeys) {
        if (worldview.rules[dk] !== undefined) {
          result.errors.push(`rules 中不允许包含 ${dk} 字段（结构漂移风险）`);
        }
      }
    }

    if (!worldview.setting || typeof worldview.setting !== 'string') {
      result.errors.push('缺少 setting 字段或类型错误');
    }
    if (!worldview.rules || typeof worldview.rules !== 'object') {
      result.errors.push('缺少 rules 字段或类型错误');
    }
    if (!Array.isArray(worldview.factions)) {
      result.errors.push('factions 必须是数组');
    }
    if (!worldview.history || typeof worldview.history !== 'object') {
      result.errors.push('history 必须是对象');
    }
    if (!Array.isArray(worldview.sceneNorms)) {
      result.errors.push('sceneNorms 必须是数组');
    }
    if (!Array.isArray(worldview.secrets)) {
      result.errors.push('secrets 必须是数组');
    }

    result.schemaValid = result.errors.length === 0;

    if (typeof worldview.setting === 'string' && worldview.setting.length < 20) {
      result.warnings.push('setting 长度过短，内容可能不完整');
    }
    if (Array.isArray(worldview.factions) && worldview.factions.length < 1) {
      result.warnings.push('factions 数量不足，建议至少 1 个');
    }
    if (worldview.history && Array.isArray(worldview.history.keyEvents) && worldview.history.keyEvents.length < 1) {
      result.warnings.push('history.keyEvents 数量不足，建议至少 1 条');
    }
    if (Array.isArray(worldview.sceneNorms) && worldview.sceneNorms.length < 1) {
      result.warnings.push('sceneNorms 数量不足，建议至少 1 条');
    }

    const allStrings = this._extractAllStrings(worldview);
    for (const str of allStrings) {
      if (this._looksTruncated(str)) {
        result.warnings.push(`检测到疑似截断的文本内容`);
        break;
      }
    }

    if (result.schemaValid) {
      result.completenessValid = result.warnings.filter(w => !w.includes('截断')).length === 0;
    } else {
      result.completenessValid = false;
    }

    result.valid = result.schemaValid;
    return result;
  }

  static validateCharacters(characters) {
    const result = {
      valid: false,
      schemaValid: false,
      completenessValid: false,
      errors: [],
      warnings: []
    };

    if (!characters || typeof characters !== 'object') {
      result.errors.push('characters 必须是对象');
      return result;
    }

    const allowedKeys = ['protagonists', 'supportingCharacters', 'antagonists', 'relationshipNetwork', 'oocRules'];
    const extraKeys = Object.keys(characters).filter(k => !allowedKeys.includes(k));
    if (extraKeys.length > 0) {
      result.warnings.push(`characters 中存在未预期的字段: ${extraKeys.join(', ')}`);
    }

    if (!Array.isArray(characters.protagonists) || characters.protagonists.length < 1) {
      result.errors.push('protagonists 必须是非空数组');
    }

    result.schemaValid = result.errors.length === 0;

    if (Array.isArray(characters.protagonists)) {
      const validProtags = characters.protagonists.filter(p => p && typeof p === 'object' && p.name && typeof p.name === 'string');
      if (validProtags.length < 1) {
        result.errors.push('protagonists 中缺少有效 name 字段');
      }
    }

    if (result.schemaValid) {
      result.completenessValid = result.errors.length === 0;
    } else {
      result.completenessValid = false;
    }

    result.valid = result.schemaValid && result.completenessValid;
    return result;
  }

  static validateOutline(outline) {
    const result = {
      valid: false,
      schemaValid: false,
      completenessValid: false,
      errors: [],
      warnings: []
    };

    if (!outline || typeof outline !== 'object') {
      result.errors.push('outline 必须是对象');
      return result;
    }

    if (!Array.isArray(outline.chapters) || outline.chapters.length < 1) {
      result.errors.push('outline.chapters 必须是非空数组');
    } else {
      for (let i = 0; i < outline.chapters.length; i++) {
        const ch = outline.chapters[i];
        if (!ch || typeof ch !== 'object') {
          result.errors.push(`第 ${i + 1} 章格式错误`);
          continue;
        }
        if (!ch.title || typeof ch.title !== 'string') {
          result.warnings.push(`第 ${i + 1} 章缺少 title`);
        }
        if (!ch.coreEvent || typeof ch.coreEvent !== 'string' || ch.coreEvent.trim().length < 5) {
          result.warnings.push(`第 ${i + 1} 章 coreEvent 缺失或太短`);
        }
      }
    }

    result.schemaValid = result.errors.length === 0;
    result.completenessValid = result.schemaValid && result.warnings.filter(w => w.includes('coreEvent')).length === 0;
    result.valid = result.schemaValid;
    return result;
  }

  static canPromoteToValidated(schemaResult, structuredVerdict) {
    if (!schemaResult || !structuredVerdict) {
      return false;
    }

    let allValid = false;
    if (schemaResult.valid !== undefined) {
      allValid = schemaResult.valid === true;
    } else {
      const parts = Object.values(schemaResult).filter(v => v && typeof v === 'object');
      if (parts.length === 0) return false;
      allValid = parts.every(p => p.valid === true);
    }

    if (!allValid) {
      return false;
    }
    if (structuredVerdict.verdict === 'FAIL') {
      return false;
    }
    if (structuredVerdict.schemaRisk === true) {
      return false;
    }
    if (structuredVerdict.completenessRisk === true) {
      return false;
    }
    if (Array.isArray(structuredVerdict.blockingIssues) && structuredVerdict.blockingIssues.length > 0) {
      return false;
    }
    if (structuredVerdict.verdict === 'PASS_WITH_WARNINGS') {
      return false;
    }
    return structuredVerdict.verdict === 'PASS';
  }

  static _extractAllStrings(obj) {
    const strings = [];
    const walk = (value) => {
      if (typeof value === 'string') {
        strings.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(obj);
    return strings;
  }

  static _looksTruncated(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (trimmed.length < 10) return false;

    const lastSentence = trimmed.split(/[。！？.!?]/).pop().trim();
    if (lastSentence.length > 50 && !/[。！？.!?]\s*$/.test(trimmed) && trimmed.length > 80) return true;

    return false;
  }
}

module.exports = { SchemaValidator };
