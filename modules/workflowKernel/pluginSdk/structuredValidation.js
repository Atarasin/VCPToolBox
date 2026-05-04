const { resolveInput } = require('../steps/AgentCallStep');

const DEFAULT_VALIDATION_REQUEST_OPTIONS = {
  timeoutMs: 300000,
  temporaryContact: true
};

function buildIssueObjects(blockingIssues = [], nonBlockingIssues = []) {
  return [
    ...blockingIssues.map((issue) => ({ description: issue, severity: 'major' })),
    ...nonBlockingIssues.map((issue) => ({ description: issue, severity: 'minor' }))
  ];
}

function determineIssueSeverity(issue) {
  const lower = issue.toLowerCase();

  if (lower.includes('严重') || lower.includes('关键') || lower.includes('致命')) {
    return 'critical';
  }

  if (lower.includes('重要') || lower.includes('较大')) {
    return 'major';
  }

  return 'minor';
}

function parseStructuredValidationResult(content) {
  const jsonMatch = content.match(/<<<VALIDATION_RESULT开始>>>([\s\S]*?)<<<VALIDATION_RESULT末>>>/);
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  let structuredResult = null;

  if (jsonMatch && jsonMatch[1]) {
    try {
      structuredResult = JSON.parse(jsonMatch[1].trim());
    } catch (error) {}
  } else if (jsonBlockMatch && jsonBlockMatch[1]) {
    try {
      structuredResult = JSON.parse(jsonBlockMatch[1].trim());
    } catch (error) {}
  }

  if (!structuredResult) {
    try {
      structuredResult = JSON.parse(content);
    } catch (error) {}
  }

  if (structuredResult && structuredResult.verdict) {
    const blockingIssues = structuredResult.blockingIssues || structuredResult.blocking_issues || [];
    const nonBlockingIssues = structuredResult.nonBlockingIssues || structuredResult.non_blocking_issues || [];

    return {
      verdict: structuredResult.verdict || 'FAIL',
      passed: structuredResult.verdict !== 'FAIL',
      hasWarnings: structuredResult.verdict === 'PASS_WITH_WARNINGS',
      issues: buildIssueObjects(blockingIssues, nonBlockingIssues),
      suggestions: structuredResult.suggestions || [],
      schemaRisk: structuredResult.schemaRisk ?? structuredResult.schema_risk ?? 'unknown',
      completenessRisk: structuredResult.completenessRisk ?? structuredResult.completeness_risk ?? 'unknown',
      blockingIssues,
      nonBlockingIssues,
      rawReport: content
    };
  }

  const result = {
    verdict: 'PASS',
    passed: true,
    hasWarnings: false,
    issues: [],
    suggestions: [],
    schemaRisk: 'low',
    completenessRisk: 'low',
    blockingIssues: [],
    nonBlockingIssues: [],
    rawReport: content
  };

  const explicitVerdictMatch = content.match(/["']?verdict["']?\s*[:：]\s*["']?(PASS|PASS_WITH_WARNINGS|FAIL)["']?/i);
  if (explicitVerdictMatch) {
    const explicitVerdict = explicitVerdictMatch[1].toUpperCase();
    result.verdict = explicitVerdict;
    result.passed = explicitVerdict !== 'FAIL';
    result.hasWarnings = explicitVerdict === 'PASS_WITH_WARNINGS';
  } else if (content.includes('不通过') || content.includes('失败')) {
    result.passed = false;
    result.verdict = 'FAIL';
  } else if (content.includes('有条件通过') || content.includes('警告')) {
    result.hasWarnings = true;
    result.verdict = 'PASS_WITH_WARNINGS';
  }

  const issueMatches = content.match(/[-*•]\s*([^\n]*(?:问题|冲突|矛盾|不符|错误|风险)[^\n]*)/gi) || [];
  result.issues = issueMatches
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 5)
    .map((issue) => ({ description: issue, severity: determineIssueSeverity(issue) }));
  result.blockingIssues = result.issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'major');
  result.nonBlockingIssues = result.issues.filter((issue) => issue.severity === 'minor');

  const suggestionMatches = content.match(/[-*•]\s*([^\n]*(?:建议|修正|改进|调整)[^\n]*)/gi) || [];
  result.suggestions = suggestionMatches
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 5);

  if (result.blockingIssues.length > 0) {
    result.schemaRisk = 'high';
    result.completenessRisk = 'high';
    result.verdict = 'FAIL';
    result.passed = false;
  } else if (result.nonBlockingIssues.length > 0) {
    result.schemaRisk = 'medium';
    result.completenessRisk = 'medium';
    if (result.verdict === 'PASS') {
      result.verdict = 'PASS_WITH_WARNINGS';
      result.hasWarnings = true;
    }
  }

  return result;
}

function createStructuredValidationStepHandler({
  agentDispatcher,
  buildPrompt,
  parseResult = parseStructuredValidationResult,
  resolveInputFn = resolveInput,
  getAgentType = () => 'logicValidator',
  getRequestOptions = () => DEFAULT_VALIDATION_REQUEST_OPTIONS
} = {}) {
  return async (step, stepContext) => {
    try {
      const input = resolveInputFn(step.input, stepContext.context);
      const prompt = buildPrompt(input, { step, stepContext });
      const result = await agentDispatcher.delegate(
        getAgentType(input, { step, stepContext }),
        prompt,
        getRequestOptions(input, { step, stepContext })
      );

      return {
        status: 'completed',
        output: parseResult(result.content, { input, step, stepContext })
      };
    } catch (error) {
      return {
        status: 'failed',
        error: new Error(`Validation agent failed: ${error.message}`)
      };
    }
  };
}

module.exports = {
  DEFAULT_VALIDATION_REQUEST_OPTIONS,
  buildIssueObjects,
  determineIssueSeverity,
  parseStructuredValidationResult,
  createStructuredValidationStepHandler
};
