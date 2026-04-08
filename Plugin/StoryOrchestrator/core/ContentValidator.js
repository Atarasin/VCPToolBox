const { PromptBuilder } = require('../utils/PromptBuilder');

class ContentValidator {
  constructor(agentDispatcher) {
    this.agentDispatcher = agentDispatcher;
  }

  async validateWorldview(storyId, content, storyBible) {
    const prompt = PromptBuilder.buildWorldviewValidationPrompt({
      content,
      worldview: storyBible.worldview
    });

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 60000,
      temporaryContact: true
    });

    return this._parseValidationResult(result.content);
  }

  async validateCharacters(storyId, content, storyBible) {
    // Handle nested characters structure from Phase1 output
    let characters = storyBible.characters || [];
    if (characters && typeof characters === 'object' && !Array.isArray(characters)) {
      // Try to extract characters from nested structure
      if (characters.characters && Array.isArray(characters.characters)) {
        characters = characters.characters;
      } else if (characters.protagonists && Array.isArray(characters.protagonists)) {
        characters = characters.protagonists;
      } else {
        characters = [];
      }
    }
    
    const prompt = PromptBuilder.buildCharacterValidationPrompt({
      content,
      characters: characters
    });

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 60000,
      temporaryContact: true
    });

    return this._parseValidationResult(result.content);
  }

  async validatePlot(storyId, content, storyBible, previousChapters = []) {
    const plotContext = {
      mainArc: storyBible.plotSummary?.mainArc,
      keyEvents: storyBible.plotSummary?.keyEvents || [],
      previousChapterSummaries: previousChapters.map((ch, i) => `第${i + 1}章：${this._summarize(ch.content || ch)}`)
    };

    const prompt = `
【情节逻辑验证】

请验证以下内容的情节逻辑是否合理。

=== 主线情节 ===
${JSON.stringify(plotContext, null, 2)}

=== 待验证内容 ===
${content}

=== 验证维度 ===
1. 情节发展是否符合主线
2. 因果关系是否合理
3. 转折是否有铺垫
4. 悬念设置是否恰当
5. 与已发生情节是否矛盾

请输出验证结果。`;

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 60000,
      temporaryContact: true
    });

    return this._parseValidationResult(result.content);
  }

  async comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters = []) {
    const [worldviewCheck, characterCheck, plotCheck] = await Promise.all([
      this.validateWorldview(storyId, content, storyBible),
      this.validateCharacters(storyId, content, storyBible),
      this.validatePlot(storyId, content, storyBible, previousChapters)
    ]);

    const allPassed = worldviewCheck.passed && characterCheck.passed && plotCheck.passed;
    const allCritical = [
      ...worldviewCheck.issues.filter(i => i.severity === 'critical'),
      ...characterCheck.issues.filter(i => i.severity === 'critical'),
      ...plotCheck.issues.filter(i => i.severity === 'critical')
    ];

    return {
      overall: {
        passed: allPassed,
        hasCriticalIssues: allCritical.length > 0,
        criticalCount: allCritical.length
      },
      checks: {
        worldview: worldviewCheck,
        characters: characterCheck,
        plot: plotCheck
      },
      allIssues: [
        ...worldviewCheck.issues,
        ...characterCheck.issues,
        ...plotCheck.issues
      ],
      allSuggestions: [
        ...worldviewCheck.suggestions,
        ...characterCheck.suggestions,
        ...plotCheck.suggestions
      ]
    };
  }

  async qualityScore(content) {
    const prompt = `
【内容质量评分】

请对以下内容进行多维度质量评分（1-10分）。

=== 待评分内容 ===
${content.substring(0, 3000)}...

=== 评分维度 ===
1. 叙事流畅度：情节推进是否自然流畅
2. 描写生动度：场景和人物描写是否生动
3. 对话自然度：对话是否符合人物性格，是否自然
4. 节奏把控：节奏是否张弛有度
5. 吸引力：是否引人入胜

请输出每项得分及简评。`;

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 60000,
      temporaryContact: true
    });

    return this._parseQualityScore(result.content);
  }

  _parseValidationResult(content) {
    const result = {
      passed: true,
      hasWarnings: false,
      issues: [],
      suggestions: [],
      rawReport: content
    };

    if (content.includes('不通过') || content.includes('失败') || content.includes('冲突')) {
      result.passed = false;
    } else if (content.includes('有条件通过') || content.includes('警告')) {
      result.hasWarnings = true;
    }

    const issueMatches = content.match(/[-\d\.\s]*([^\n]*(?:冲突|问题|不符|错误)[^\n]*)/gi) || [];
    result.issues = issueMatches
      .map(line => line.replace(/^[-\d\.\s]+/, '').trim())
      .filter(line => line.length > 5)
      .map(issue => ({
        description: issue,
        severity: this._determineSeverity(issue)
      }));

    const suggestionMatches = content.match(/[-\d\.\s]*([^\n]*(?:建议|修正|改进)[^\n]*)/gi) || [];
    result.suggestions = suggestionMatches
      .map(line => line.replace(/^[-\d\.\s]+/, '').trim())
      .filter(line => line.length > 5);

    return result;
  }

  _parseQualityScore(content) {
    const scores = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      const matches = line.match(/(.+?)[：:]\s*(\d+(?:\.\d+)?)\s*[分\/]/);
      if (matches) {
        const dimension = matches[1].trim();
        const score = parseFloat(matches[2]);
        scores[dimension] = score;
      }
    }

    const values = Object.values(scores);
    const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

    return {
      scores,
      average: Math.round(average * 10) / 10,
      rawReport: content
    };
  }

  _determineSeverity(issue) {
    const lower = issue.toLowerCase();
    if (lower.includes('严重') || lower.includes('关键') || lower.includes('critical')) {
      return 'critical';
    }
    if (lower.includes('重要') || lower.includes('major')) {
      return 'major';
    }
    return 'minor';
  }

  _summarize(content) {
    if (!content) return '';
    const text = typeof content === 'string' ? content : content.content || '';
    return text.substring(0, 200).replace(/\n/g, ' ') + '...';
  }
}

module.exports = { ContentValidator };
