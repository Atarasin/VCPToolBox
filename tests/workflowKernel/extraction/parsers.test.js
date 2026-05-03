/**
 * Comprehensive parser isolation tests — malformed inputs, retry, and repair.
 * Uses Node.js built-in test runner (node:test / node:assert)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  jsonBlockParser,
  jsonObjectParser,
  xmlParser,
  fallbackRawParser,
  _repairJson,
  _closeUnclosedStrings,
  _balanceBrackets
} = require('../../../modules/workflowKernel/extraction/parsers');
const { ExtractionLayer, ExtractionError } = require('../../../modules/workflowKernel/extraction/ExtractionLayer');

describe('jsonBlockParser — malformed inputs', () => {
  it('should return undefined when no code blocks exist', () => {
    const result = jsonBlockParser('Just plain text with no blocks');
    assert.strictEqual(result, undefined);
  });

  it('should skip malformed JSON and find next valid block', () => {
    const md = '```json\n{truncated\n```\n```json\n{"valid": true}\n```';
    const result = jsonBlockParser(md);
    assert.deepStrictEqual(result, { valid: true });
  });

  it('should handle empty code blocks', () => {
    const result = jsonBlockParser('```json\n\n```');
    assert.strictEqual(result, undefined);
  });

  it('should handle JSON with nested braces', () => {
    const md = '```json\n{"outer": {"inner": 42}}\n```';
    const result = jsonBlockParser(md);
    assert.deepStrictEqual(result, { outer: { inner: 42 } });
  });

  it('should handle multiple valid blocks and return first', () => {
    const md = '```json\n{"first": 1}\n```\n```json\n{"second": 2}\n```';
    const result = jsonBlockParser(md);
    assert.deepStrictEqual(result, { first: 1 });
  });

  it('should handle code block without language tag', () => {
    const md = '```\n{"noLang": true}\n```';
    const result = jsonBlockParser(md);
    assert.deepStrictEqual(result, { noLang: true });
  });

  it('should ignore non-JSON fenced blocks', () => {
    const md = '```python\nprint("hello")\n```';
    const result = jsonBlockParser(md);
    assert.strictEqual(result, undefined);
  });
});

describe('jsonObjectParser — malformed and truncated inputs', () => {
  it('should parse valid inline JSON object', () => {
    const result = jsonObjectParser('text {"a": 1} more');
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('should parse valid inline JSON array', () => {
    const result = jsonObjectParser('text [1, 2, 3] more');
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('should return undefined when no JSON object/array found', () => {
    const result = jsonObjectParser('no json here at all');
    assert.strictEqual(result, undefined);
  });

  it('should repair truncated object missing closing brace', () => {
    const result = jsonObjectParser('{"key": "value"');
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('should repair truncated array missing closing bracket', () => {
    const result = jsonObjectParser('[1, 2, 3');
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('should repair object with unclosed string value', () => {
    const result = jsonObjectParser('{"name": "Alice');
    assert.deepStrictEqual(result, { name: 'Alice' });
  });

  it('should repair nested truncated object', () => {
    const result = jsonObjectParser('{"outer": {"inner": 42');
    assert.deepStrictEqual(result, { outer: { inner: 42 } });
  });

  it('should repair object with trailing comma', () => {
    const result = jsonObjectParser('{"a": 1, "b": 2,}');
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it('should handle deeply nested truncation', () => {
    const result = jsonObjectParser('{"a": {"b": {"c": "deep"');
    assert.deepStrictEqual(result, { a: { b: { c: 'deep' } } });
  });

  it('should not repair severely malformed JSON', () => {
    const result = jsonObjectParser('{{{{{{not json');
    assert.strictEqual(result, undefined);
  });

  it('should parse JSON with escaped quotes', () => {
    const result = jsonObjectParser('{"msg": "say \\"hello\\""}');
    assert.deepStrictEqual(result, { msg: 'say "hello"' });
  });
});

describe('jsonObjectParser — truncated JSON repair helpers', () => {
  it('_balanceBrackets adds missing closing braces', () => {
    assert.strictEqual(_balanceBrackets('{"a": 1'), '{"a": 1}');
  });

  it('_balanceBrackets adds missing closing brackets', () => {
    assert.strictEqual(_balanceBrackets('[1, 2'), '[1, 2]');
  });

  it('_balanceBrackets handles mixed braces and brackets', () => {
    assert.strictEqual(_balanceBrackets('{"arr": [1, 2'), '{"arr": [1, 2]}');
  });

  it('_balanceBrackets ignores brackets inside strings', () => {
    assert.strictEqual(_balanceBrackets('{"a": "[not"'), '{"a": "[not"}');
  });

  it('_closeUnclosedStrings closes unclosed string at end', () => {
    assert.strictEqual(_closeUnclosedStrings('{"key": "val'), '{"key": "val"');
  });

  it('_repairJson combines bracket balancing and string closing', () => {
    const repaired = _repairJson('{"key": "val');
    assert.strictEqual(repaired, '{"key": "val"}');
  });

  it('_repairJson removes trailing comma', () => {
    const repaired = _repairJson('{"a": 1,}');
    assert.strictEqual(repaired, '{"a": 1}');
  });
});

describe('xmlParser — malformed inputs', () => {
  it('should parse flat XML tags', () => {
    const result = xmlParser('<root><name>test</name><count>42</count></root>');
    assert.deepStrictEqual(result, { name: 'test', count: 42 });
  });

  it('should unwrap single-root XML wrapper', () => {
    const result = xmlParser('<wrapper><data>value</data></wrapper>');
    assert.deepStrictEqual(result, { data: 'value' });
  });

  it('should return undefined for no XML', () => {
    const result = xmlParser('no xml here');
    assert.strictEqual(result, undefined);
  });

  it('should parse XML with nested tags as nested object', () => {
    const result = xmlParser('<root><outer><inner>value</inner></outer></root>');
    assert.deepStrictEqual(result, { outer: { inner: 'value' } });
  });

  it('should parse XML with JSON values inside tags', () => {
    const result = xmlParser('<root><data>{"json": true}</data></root>');
    assert.deepStrictEqual(result, { data: { json: true } });
  });

  it('should handle XML with empty tags', () => {
    const result = xmlParser('<root><empty></empty></root>');
    assert.deepStrictEqual(result, { empty: '' });
  });

  it('should return undefined for incomplete XML (no closing tag)', () => {
    const result = xmlParser('<root><data>value</data>');
    assert.strictEqual(result, undefined);
  });
});

describe('fallbackRawParser', () => {
  it('should always return { raw: markdown } for any input', () => {
    const inputs = ['', 'hello', '```json\n{}', '<xml>', null, undefined];
    for (const input of inputs) {
      const result = fallbackRawParser(input);
      assert.deepStrictEqual(result, { raw: input });
    }
  });
});

describe('ExtractionLayer — retry loop and attempt tracking', () => {
  it('should try parsers in order and log each attempt', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('```json\n{"found": true}\n```');
    assert.strictEqual(result.meta.usedParser, 'jsonBlock');
    assert.strictEqual(result.meta.attempts.length, 1);
    assert.strictEqual(result.meta.attempts[0].parser, 'jsonBlock');
    assert.strictEqual(result.meta.attempts[0].success, true);
  });

  it('should log failed attempts before success', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('{"found": true}');
    assert.strictEqual(result.meta.usedParser, 'jsonObject');
    assert.ok(result.meta.attempts.some(a => a.parser === 'jsonBlock' && !a.success));
    assert.ok(result.meta.attempts.some(a => a.parser === 'jsonObject' && a.success));
  });

  it('should log all failures when no parser matches', () => {
    const layer = new ExtractionLayer();
    layer.unregisterParser('fallbackRaw');
    try {
      layer.extract('no structured data');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof ExtractionError);
      assert.strictEqual(err.code, 'NO_MATCH');
      assert.ok(err.details.attempts.length >= 3);
      assert.ok(err.details.attempts.every(a => !a.success));
    }
  });

  it('should retry with next parser when first parser throws', () => {
    const layer = new ExtractionLayer();
    layer.registerParser('thrower', () => { throw new Error('boom'); });
    const result = layer.extract('```json\n{"ok": true}\n```', {
      parserOrder: ['thrower', 'jsonBlock']
    });
    assert.strictEqual(result.meta.usedParser, 'jsonBlock');
    assert.ok(result.meta.attempts.some(a => a.parser === 'thrower' && !a.success));
  });

  it('should respect custom parserOrder fully', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('plain text', {
      parserOrder: ['fallbackRaw', 'jsonBlock', 'jsonObject']
    });
    assert.strictEqual(result.meta.usedParser, 'fallbackRaw');
    assert.strictEqual(result.meta.attempts.length, 1);
  });

  it('should handle parser returning undefined as failure', () => {
    const layer = new ExtractionLayer();
    layer.registerParser('alwaysUndefined', () => undefined);
    const result = layer.extract('{"a": 1}', {
      parserOrder: ['alwaysUndefined', 'jsonObject']
    });
    assert.strictEqual(result.meta.usedParser, 'jsonObject');
    assert.ok(result.meta.attempts.some(a => a.parser === 'alwaysUndefined' && !a.success));
  });
});

describe('ExtractionLayer — schema validation and errors', () => {
  it('should throw ExtractionError with SCHEMA_MISMATCH code', () => {
    const layer = new ExtractionLayer();
    try {
      layer.extract('```json\n{"count": "not a number"}\n```', {
        schema: { type: 'object', properties: { count: { type: 'number' } } }
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof ExtractionError);
      assert.strictEqual(err.code, 'SCHEMA_MISMATCH');
      assert.ok(err.message.includes('count'));
      assert.ok(Array.isArray(err.details.attempts));
    }
  });

  it('should throw ExtractionError with MISSING_FIELDS code', () => {
    const layer = new ExtractionLayer();
    try {
      layer.extract('```json\n{"name": "Alice"}\n```', {
        requiredFields: ['name', 'email']
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof ExtractionError);
      assert.strictEqual(err.code, 'MISSING_FIELDS');
      assert.ok(err.details.missing.includes('email'));
    }
  });

  it('should throw ExtractionError with NO_MATCH code', () => {
    const layer = new ExtractionLayer();
    layer.unregisterParser('fallbackRaw');
    try {
      layer.extract('no structured data here');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof ExtractionError);
      assert.strictEqual(err.code, 'NO_MATCH');
      assert.ok(err.message.includes('No parser'));
    }
  });

  it('should include attempt log in error details', () => {
    const layer = new ExtractionLayer();
    layer.unregisterParser('fallbackRaw');
    try {
      layer.extract('no data');
    } catch (err) {
      assert.ok(Array.isArray(err.details.attempts));
      assert.ok(err.details.attempts.length > 0);
    }
  });

  it('should return defaultValue without throwing when throwOnFailure is false', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('bad data', {
      parserOrder: ['jsonBlock', 'jsonObject', 'xml'],
      throwOnFailure: false,
      defaultValue: { fallback: true }
    });
    assert.deepStrictEqual(result.data, { fallback: true });
    assert.strictEqual(result.meta.usedParser, null);
  });
});

describe('ExtractionLayer — edge cases and boundary conditions', () => {
  it('should handle empty string input', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('');
    assert.deepStrictEqual(result.data, { raw: '' });
    assert.strictEqual(result.meta.usedParser, 'fallbackRaw');
  });

  it('should handle null/undefined-like string input', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('null');
    // jsonObjectParser won't match 'null' (no braces), fallback expected
    assert.deepStrictEqual(result.data, { raw: 'null' });
  });

  it('should handle JSON with unicode characters', () => {
    const layer = new ExtractionLayer();
    const result = layer.extract('```json\n{"emoji": "🎉"}\n```');
    assert.deepStrictEqual(result.data, { emoji: '🎉' });
  });

  it('should handle very large JSON block', () => {
    const largeObj = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) };
    const md = '```json\n' + JSON.stringify(largeObj) + '\n```';
    const layer = new ExtractionLayer();
    const result = layer.extract(md);
    assert.strictEqual(result.data.items.length, 1000);
  });

  it('should handle parser that returns empty object', () => {
    const layer = new ExtractionLayer();
    layer.registerParser('emptyObj', () => ({}));
    const result = layer.extract('anything', { parserOrder: ['emptyObj'] });
    assert.deepStrictEqual(result.data, {});
    assert.strictEqual(result.meta.usedParser, 'emptyObj');
  });

  it('should not mutate parserOrder array', () => {
    const layer = new ExtractionLayer();
    const order = ['jsonBlock', 'jsonObject'];
    layer.extract('{"a": 1}', { parserOrder: order });
    assert.deepStrictEqual(order, ['jsonBlock', 'jsonObject']);
  });
});

describe('ExtractionLayer — logger integration', () => {
  it('should log parser attempts via provided logger', () => {
    const logs = [];
    const logger = {
      log: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg)
    };
    const layer = new ExtractionLayer(logger);
    layer.extract('```json\n{"ok": true}\n```');
    assert.ok(logs.some(l => l.includes('jsonBlock')));
    assert.ok(logs.some(l => l.includes('succeeded')));
  });

  it('should log parser failures via error logger', () => {
    const logs = [];
    const logger = {
      log: () => {},
      error: (msg) => logs.push(msg),
      warn: () => {}
    };
    const layer = new ExtractionLayer(logger);
    layer.registerParser('fail', () => { throw new Error('fail'); });
    layer.extract('test', { parserOrder: ['fail', 'fallbackRaw'] });
    assert.ok(logs.some(l => l.includes('fail')));
  });

  it('should warn about unregistered parsers', () => {
    const logs = [];
    const logger = {
      log: () => {},
      error: () => {},
      warn: (msg) => logs.push(msg)
    };
    const layer = new ExtractionLayer(logger);
    layer.extract('test', { parserOrder: ['missingParser', 'fallbackRaw'] });
    assert.ok(logs.some(l => l.includes('missingParser')));
  });
});
