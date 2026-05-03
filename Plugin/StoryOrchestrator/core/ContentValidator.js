const { PromptBuilder } = require('../utils/PromptBuilder');
const { SchemaValidator } = require('../utils/SchemaValidator');

/**
 * ContentValidator keeps story-domain validation prompts in the plugin while
 * making the validation orchestration skeleton explicit.
 *
 * The prompt construction and verdict interpretation below are story-specific.
 * The delegate -> parse -> aggregate pattern is the reusable part that future
 * SDK extraction work may continue to lift out.
 */

class ContentValidator {
  constructor(agentDispatcher) {
    this.agentDispatcher = agentDispatcher;
  }

  async validateWorldview(storyId, content, storyBible) {
    const prompt = PromptBuilder.buildWorldviewValidationPrompt({
      content,
      worldview: storyBible.worldview
    });

    return this._runStructuredValidation(prompt);
  }

  async validateCharacters(storyId, content, storyBible) {
    const characters = this._normalizeCharacterCollection(storyBible.characters);

    const prompt = PromptBuilder.buildCharacterValidationPrompt({
      content,
      characters
    });

    return this._runStructuredValidation(prompt);
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

    return this._runStructuredValidation(prompt);
  }

  async comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters = []) {
    const [worldviewCheck, characterCheck, plotCheck] = await Promise.all([
      this.validateWorldview(storyId, content, storyBible),
      this.validateCharacters(storyId, content, storyBible),
      this.validatePlot(storyId, content, storyBible, previousChapters)
    ]);

    // Keep the reusable aggregation skeleton explicit while leaving each
    // individual check's prompt/rule set story-domain specific.
    const aggregate = this._aggregateValidationChecks([
      worldviewCheck,
      characterCheck,
      plotCheck
    ]);

    const canPromote = SchemaValidator.canPromoteToValidated(
      { valid: aggregate.allPassed && aggregate.allBlocking.length === 0 },
      {
        verdict: aggregate.verdict,
        schemaRisk: aggregate.schemaRisk,
        completenessRisk: aggregate.completenessRisk,
        blockingIssues: aggregate.allBlocking
      }
    );

    return {
      overall: {
        passed: aggregate.allPassed && aggregate.allBlocking.length === 0,
        canPromoteToValidated: canPromote,
        hasCriticalIssues: aggregate.allBlocking.length > 0,
        criticalCount: aggregate.allBlocking.length
      },
      checks: {
        worldview: worldviewCheck,
        characters: characterCheck,
        plot: plotCheck
      },
      allIssues: aggregate.allIssues,
      allSuggestions: aggregate.allSuggestions
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

  async _runStructuredValidation(prompt) {
    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseStructuredValidationResult(result.content);
  }

  _normalizeCharacterCollection(characters) {
    if (!characters) {
      return [];
    }

    if (Array.isArray(characters)) {
      return characters;
    }

    if (typeof characters === 'object') {
      if (Array.isArray(characters.characters)) {
        return characters.characters;
      }

      if (Array.isArray(characters.protagonists)) {
        return characters.protagonists;
      }
    }

    return [];
  }

  _aggregateValidationChecks(checks) {
    const allBlocking = checks.flatMap((check) => check.blockingIssues || []);
    const allIssues = checks.flatMap((check) => check.issues || []);
    const allSuggestions = checks.flatMap((check) => check.suggestions || []);
    const allPassed = checks.every((check) => check.verdict !== 'FAIL');
    const hasWarnings = checks.some((check) => check.verdict === 'PASS_WITH_WARNINGS');

    return {
      allBlocking,
      allIssues,
      allSuggestions,
      allPassed,
      verdict: !allPassed ? 'FAIL' : (hasWarnings ? 'PASS_WITH_WARNINGS' : 'PASS'),
      schemaRisk: checks.some((check) => check.schemaRisk),
      completenessRisk: checks.some((check) => check.completenessRisk)
    };
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

      const blockingIssues = Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues :
        Array.isArray(parsed.blockingIssues) ? parsed.blockingIssues : [];
      const nonBlockingIssues = Array.isArray(parsed.non_blocking_issues) ? parsed.non_blocking_issues :
        Array.isArray(parsed.nonBlockingIssues) ? parsed.nonBlockingIssues : [];

      return {
        verdict: normalizedVerdict,
        passed: normalizedVerdict !== 'FAIL',
        schemaRisk: parsed.schema_risk === true || parsed.schemaRisk === true,
        completenessRisk: parsed.completeness_risk === true || parsed.completenessRisk === true,
        blockingIssues,
        nonBlockingIssues,
        issues: this._buildIssueObjects(blockingIssues, nonBlockingIssues),
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

    result.issues = this._buildIssueObjects(result.blockingIssues, result.nonBlockingIssues);
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

  _buildIssueObjects(blockingIssues = [], nonBlockingIssues = []) {
    return [
      ...blockingIssues.map((issue) => ({ description: issue, severity: 'major' })),
      ...nonBlockingIssues.map((issue) => ({ description: issue, severity: 'minor' }))
    ];
  }
}

module.exports = { ContentValidator };
