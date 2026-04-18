const { PromptBuilder } = require('../utils/PromptBuilder');
const { SchemaValidator } = require('../utils/SchemaValidator');

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
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseStructuredValidationResult(result.content);
  }

  async validateCharacters(storyId, content, storyBible) {
    let characters = storyBible.characters || [];
    if (characters && typeof characters === 'object' && !Array.isArray(characters)) {
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
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseStructuredValidationResult(result.content);
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

请输出严格 JSON 格式的验证结果：
{
  "verdict": "PASS | PASS_WITH_WARNINGS | FAIL",
  "schema_risk": false,
  "completeness_risk": false,
  "blocking_issues": [],
  "non_blocking_issues": [],
  "suggestions": []
}`;

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseStructuredValidationResult(result.content);
  }

  async comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters = []) {
    const [worldviewCheck, characterCheck, plotCheck] = await Promise.all([
      this.validateWorldview(storyId, content, storyBible),
      this.validateCharacters(storyId, content, storyBible),
      this.validatePlot(storyId, content, storyBible, previousChapters)
    ]);

    const allBlocking = [
      ...worldviewCheck.blockingIssues,
      ...characterCheck.blockingIssues,
      ...plotCheck.blockingIssues
    ];

    const allPassed = worldviewCheck.verdict !== 'FAIL' &&
                      characterCheck.verdict !== 'FAIL' &&
                      plotCheck.verdict !== 'FAIL';

    const hasWarnings = worldviewCheck.verdict === 'PASS_WITH_WARNINGS' ||
                        characterCheck.verdict === 'PASS_WITH_WARNINGS' ||
                        plotCheck.verdict === 'PASS_WITH_WARNINGS';

    const aggregatedVerdict = !allPassed ? 'FAIL' : (hasWarnings ? 'PASS_WITH_WARNINGS' : 'PASS');

    const canPromote = SchemaValidator.canPromoteToValidated(
      { valid: allPassed && allBlocking.length === 0 },
      {
        verdict: aggregatedVerdict,
        schemaRisk: worldviewCheck.schemaRisk || characterCheck.schemaRisk || plotCheck.schemaRisk,
        completenessRisk: worldviewCheck.completenessRisk || characterCheck.completenessRisk || plotCheck.completenessRisk,
        blockingIssues: allBlocking
      }
    );

    return {
      overall: {
        passed: allPassed && allBlocking.length === 0,
        canPromoteToValidated: canPromote,
        hasCriticalIssues: allBlocking.length > 0,
        criticalCount: allBlocking.length
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
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseQualityScore(result.content);
  }

  _parseStructuredValidationResult(content) {
    const empty = {
      verdict: 'FAIL',
      passed: false,
      schemaRisk: false,
      completenessRisk: false,
      blockingIssues: [],
      nonBlockingIssues: [],
      issues: [],
      suggestions: [],
      rawReport: content
    };

    let parsed = null;

    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) ||
                      content.match(/<<<VALIDATION_RESULT开始>>>([\s\S]*?)<<<VALIDATION_RESULT结束>>>/) ||
                      content.match(/(\{[\s\S]*\})/);

    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        try {
          parsed = JSON.parse(jsonMatch[0].trim());
        } catch (e2) {}
      }
    }

    if (!parsed) {
      try {
        parsed = JSON.parse(content);
      } catch (e) {}
    }

    if (parsed && typeof parsed === 'object') {
      const verdict = (parsed.verdict || '').toUpperCase();
      const validVerdicts = ['PASS', 'PASS_WITH_WARNINGS', 'FAIL'];
      const normalizedVerdict = validVerdicts.includes(verdict) ? verdict : this._parseTextValidationResult(content).verdict;

      return {
        verdict: normalizedVerdict,
        passed: normalizedVerdict !== 'FAIL',
        schemaRisk: parsed.schema_risk === true || parsed.schemaRisk === true,
        completenessRisk: parsed.completeness_risk === true || parsed.completenessRisk === true,
        blockingIssues: Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues :
                        Array.isArray(parsed.blockingIssues) ? parsed.blockingIssues : [],
        nonBlockingIssues: Array.isArray(parsed.non_blocking_issues) ? parsed.non_blocking_issues :
                           Array.isArray(parsed.nonBlockingIssues) ? parsed.nonBlockingIssues : [],
        issues: Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues :
                Array.isArray(parsed.blockingIssues) ? parsed.blockingIssues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        rawReport: content
      };
    }

    const textResult = this._parseTextValidationResult(content);
    return {
      ...empty,
      verdict: textResult.verdict,
      passed: textResult.passed,
      blockingIssues: textResult.blockingIssues,
      nonBlockingIssues: textResult.nonBlockingIssues,
      issues: textResult.issues,
      suggestions: textResult.suggestions
    };
  }

  _parseTextValidationResult(content) {
    const result = {
      verdict: 'FAIL',
      passed: false,
      blockingIssues: [],
      nonBlockingIssues: [],
      issues: [],
      suggestions: []
    };

    if (!content || content.trim().length === 0) {
      result.verdict = 'PASS';
      result.passed = true;
      return result;
    }

    const normalized = content.toLowerCase();

    const verdictMatch = content.match(/【验证结果】[\s\n]*(.+?)(?=\n【|$)/s);
    if (verdictMatch) {
      const verdictText = verdictMatch[1].trim().toLowerCase();
      if (verdictText.includes('不通过') || verdictText.includes('失败')) {
        result.verdict = 'FAIL';
        result.passed = false;
      } else if (verdictText.includes('有条件通过') || verdictText.includes('警告')) {
        result.verdict = 'PASS_WITH_WARNINGS';
        result.passed = true;
      } else if (verdictText.includes('通过')) {
        result.verdict = 'PASS';
        result.passed = true;
      }
    } else {
      if (normalized.includes('不通过') || normalized.includes('失败')) {
        result.verdict = 'FAIL';
      } else if (normalized.includes('有条件通过') || normalized.includes('警告')) {
        result.verdict = 'PASS_WITH_WARNINGS';
        result.passed = true;
      } else if (normalized.includes('通过')) {
        result.verdict = 'PASS';
        result.passed = true;
      }
    }

    const sections = [
      { key: 'blockingIssues', patterns: [/【发现的冲突】[\s\n]*([\s\S]*?)(?=【|$)/, /【ooc问题清单】[\s\n]*([\s\S]*?)(?=【|$)/i] },
      { key: 'suggestions', patterns: [/【修正建议】[\s\n]*([\s\S]*?)(?=【|$)/] }
    ];

    for (const section of sections) {
      for (const pattern of section.patterns) {
        const match = content.match(pattern);
        if (match) {
          const lines = match[1]
            .split('\n')
            .map(l => l.replace(/^\s*[-•*\d.]+\s*/, '').trim())
            .filter(l => l.length > 0);
          result[section.key].push(...lines);
          break;
        }
      }
    }

    result.issues = result.blockingIssues;
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

  _summarize(content) {
    if (!content) return '';
    const text = typeof content === 'string' ? content : content.content || '';
    return text.substring(0, 200).replace(/\n/g, ' ') + '...';
  }
}

module.exports = { ContentValidator };
