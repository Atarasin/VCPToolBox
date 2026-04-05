const { test, describe } = require('node:test');
const assert = require('node:assert');
const { TextMetrics } = require('../utils/TextMetrics');
const { validateInput } = require('../utils/ValidationSchemas');

describe('TextMetrics', () => {
  const metrics = new TextMetrics();

  test('analyze - basic Chinese text', () => {
    const text = '这是一个测试文本。包含中文和English。';
    const result = metrics.analyze(text);
    
    assert(result.chineseChars > 10);
    assert(result.nonWhitespaceChars > 0);
    assert.strictEqual(result.paragraphCount, 1);
  });

  test('analyze - multiple paragraphs', () => {
    const text = '第一段。\n\n第二段内容。\n\n第三段。';
    const result = metrics.analyze(text);
    assert.strictEqual(result.paragraphCount, 3);
  });

  test('validateLength - within range', () => {
    const result = metrics.validateLength(3000, 2500, 3500, 'range');
    assert.strictEqual(result.isQualified, true);
    assert.strictEqual(result.rangeStatus, 'within_range');
  });

  test('validateLength - below min', () => {
    const result = metrics.validateLength(2000, 2500, 3500, 'range');
    assert.strictEqual(result.isQualified, false);
    assert.strictEqual(result.rangeStatus, 'below_min');
    assert.strictEqual(result.deficit, 500);
  });

  test('validateLength - min_only policy', () => {
    const result = metrics.validateLength(4000, 2500, 3500, 'min_only');
    assert.strictEqual(result.isQualified, true);
    assert.strictEqual(result.rangeStatus, 'above_max_ignored');
  });

  test('extractSummary', () => {
    const text = 'a'.repeat(300);
    const summary = metrics.extractSummary(text, 50);
    assert.strictEqual(summary.length, 53);
    assert(summary.endsWith('...'));
  });

  test('analyzeStructure', () => {
    const text = '他说："你好。"\n\n他走开了。\n\n风景很美。';
    const structure = metrics.analyzeStructure(text);
    assert(structure.totalParagraphs >= 2);
  });
});

describe('ValidationSchemas', () => {
  test('validateInput - StartStoryProject valid', () => {
    const result = validateInput('startStoryProject', {
      story_prompt: '这是一个很长的故事梗概，描述了主要情节。'
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  test('validateInput - StartStoryProject missing required', () => {
    const result = validateInput('startStoryProject', {});
    assert.strictEqual(result.valid, false);
    assert(result.errors.some(e => e.includes('story_prompt')));
  });

  test('validateInput - StartStoryProject too short', () => {
    const result = validateInput('startStoryProject', {
      story_prompt: '短'
    });
    assert.strictEqual(result.valid, false);
  });

  test('validateInput - CountChapterMetrics valid', () => {
    const result = validateInput('countChapterMetrics', {
      chapter_content: '测试内容'
    });
    assert.strictEqual(result.valid, true);
  });

  test('validateInput - unknown schema', () => {
    const result = validateInput('unknownSchema', {});
    assert.strictEqual(result.valid, false);
    assert(result.errors.length > 0);
  });
});

console.log('Running tests...');
