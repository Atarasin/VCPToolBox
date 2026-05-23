/**
 * test-dsl-compiler.js — Comprehensive test suite for recall DSL compiler
 *
 * Covers:
 *  - 4 bracket modes (full_text, rag, gated_full_text, gated_rag)
 *  - 9 modifiers individually
 *  - Modifier combinations
 *  - Multi-diary aggregation (| separator)
 *  - K multiplier
 *  - Edge cases (empty, unclosed, unknown brackets, etc.)
 *  - Regression tests for exact examples from the task plan
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDslExpression,
  dslToProfile,
  dslExpressionsToConfig,
  dslSyntaxToProfile,
  BRACKET_MODE_MAP,
  __internal__,
} = require('../../scripts/recall-dsl-compiler.js');

// ─── Helper ──────────────────────────────────────────────────────────────────

function assertSuccess(result, expectedType, expectedDiaries) {
  assert.strictEqual(result.error, null, `Expected success but got error: ${result.error}`);
  assert.ok(result.rule, 'Expected rule to be non-null');
  assert.strictEqual(result.rule.baseMode, expectedType);
  assert.deepStrictEqual(result.rule.targets.diaries, expectedDiaries);
  return result.rule;
}

function assertError(result, expectedErrorSubstr) {
  assert.strictEqual(result.rule, null, 'Expected rule to be null');
  assert.ok(result.error, 'Expected error to be non-null');
  if (expectedErrorSubstr) {
    assert.ok(
      result.error.includes(expectedErrorSubstr),
      `Expected error to contain "${expectedErrorSubstr}", got: "${result.error}"`
    );
  }
}

// ─── Bracket Mode Tests ─────────────────────────────────────────────────────

describe('Bracket modes', () => {
  it('{{...}} → full_text', () => {
    const result = parseDslExpression('{{角色日记本}}');
    assertSuccess(result, 'full_text', ['角色日记本']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.0);
    assert.deepStrictEqual(result.rule.modifiers, {});
    assert.strictEqual(result.rule.gateThreshold, undefined);
  });

  it('[[...]] → rag', () => {
    const result = parseDslExpression('[[角色日记本]]');
    assertSuccess(result, 'rag', ['角色日记本']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.0);
    assert.strictEqual(result.rule.gateThreshold, undefined);
  });

  it('<<...>> → gated_full_text with default gateThreshold 0.35', () => {
    const result = parseDslExpression('<<角色日记本>>');
    assertSuccess(result, 'gated_full_text', ['角色日记本']);
    assert.strictEqual(result.rule.gateThreshold, 0.35);
  });

  it('《《...》》 → gated_rag with default gateThreshold 0.35', () => {
    const result = parseDslExpression('《《角色日记本》》');
    assertSuccess(result, 'gated_rag', ['角色日记本']);
    assert.strictEqual(result.rule.gateThreshold, 0.35);
  });

  it('full_text does not have gateThreshold', () => {
    const result = parseDslExpression('{{日记本}}');
    assert.strictEqual(result.rule.gateThreshold, undefined);
  });

  it('rag does not have gateThreshold', () => {
    const result = parseDslExpression('[[日记本]]');
    assert.strictEqual(result.rule.gateThreshold, undefined);
  });

  it('emits structured baseMode, targets and projection fields', () => {
    const result = parseDslExpression('[[日记本A|日记本B:1.5::Time]]');
    assert.strictEqual(result.rule.baseMode, 'rag');
    assert.deepStrictEqual(result.rule.targets, {
      diaries: ['日记本A', '日记本B'],
      aggregate: true,
      kMultiplier: 1.5,
    });
    assert.deepStrictEqual(result.rule.projection, { emit: 'recall_blocks' });
  });
});

// ─── Modifier: Time ──────────────────────────────────────────────────────────

describe('Modifier: Time', () => {
  it('[[Diary::Time]] → time: true', () => {
    const result = parseDslExpression('[[Diary::Time]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
  });

  it('Time modifier with extra chars is treated as unknown', () => {
    const result = parseDslExpression('[[Diary::Time2]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, undefined);
    assert.ok(result.rule.meta.warnings.length > 0);
  });
});

// ─── Modifier: Group ─────────────────────────────────────────────────────────

describe('Modifier: Group', () => {
  it('[[Diary::Group]] → group: true', () => {
    const result = parseDslExpression('[[Diary::Group]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.group, true);
  });
});

// ─── Modifier: Rerank ────────────────────────────────────────────────────────

describe('Modifier: Rerank', () => {
  it('[[Diary::Rerank]] → { enabled: true, weight: 0.5 }', () => {
    const result = parseDslExpression('[[Diary::Rerank]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.5,
    });
  });

  it('[[Diary::Rerank+0.7]] → { enabled: true, weight: 0.7 }', () => {
    const result = parseDslExpression('[[Diary::Rerank+0.7]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.7,
    });
  });

  it('[[Diary::Rerank+0]] → { enabled: true, weight: 0 }', () => {
    const result = parseDslExpression('[[Diary::Rerank+0]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0,
    });
  });
});

// ─── Modifier: TimeDecay ─────────────────────────────────────────────────────

describe('Modifier: TimeDecay', () => {
  it('[[Diary::TimeDecay30]] → halfLife: 30, minScore: 0, no whitelistTags', () => {
    const result = parseDslExpression('[[Diary::TimeDecay30]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.timeDecay, {
      enabled: true,
      halfLife: 30,
      minScore: 0,
      whitelistTags: [],
    });
  });

  it('[[Diary::TimeDecay30/0.5]] → halfLife: 30, minScore: 0.5', () => {
    const result = parseDslExpression('[[Diary::TimeDecay30/0.5]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.timeDecay, {
      enabled: true,
      halfLife: 30,
      minScore: 0.5,
      whitelistTags: [],
    });
  });

  it('[[Diary::TimeDecay30/0.5/box归档]] → with whitelistTags', () => {
    const result = parseDslExpression('[[Diary::TimeDecay30/0.5/box归档]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.timeDecay, {
      enabled: true,
      halfLife: 30,
      minScore: 0.5,
      whitelistTags: ['box归档'],
    });
  });

  it('[[Diary::TimeDecay30/0.5/tag1,tag2,tag3]] → multiple whitelistTags', () => {
    const result = parseDslExpression('[[Diary::TimeDecay30/0.5/tag1,tag2,tag3]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.timeDecay, {
      enabled: true,
      halfLife: 30,
      minScore: 0.5,
      whitelistTags: ['tag1', 'tag2', 'tag3'],
    });
  });
});

// ─── Modifier: TagMemo ───────────────────────────────────────────────────────

describe('Modifier: TagMemo', () => {
  it('[[Diary::TagMemo]] → { enabled: true, weight: 0.5, geodesic: false }', () => {
    const result = parseDslExpression('[[Diary::TagMemo]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.5,
      geodesic: false,
    });
  });

  it('[[Diary::TagMemo0.3]] → weight: 0.3', () => {
    const result = parseDslExpression('[[Diary::TagMemo0.3]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.3,
      geodesic: false,
    });
  });

  it('[[Diary::TagMemo+]] → geodesic: true', () => {
    const result = parseDslExpression('[[Diary::TagMemo+]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.5,
      geodesic: true,
    });
  });

  it('[[Diary::TagMemo+0.3]] → weight: 0.3, geodesic: true', () => {
    const result = parseDslExpression('[[Diary::TagMemo+0.3]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.3,
      geodesic: true,
    });
  });
});

// ─── Modifier: Truncate ──────────────────────────────────────────────────────

describe('Modifier: Truncate', () => {
  it('[[Diary::Truncate0.5]] → { enabled: true, threshold: 0.5 }', () => {
    const result = parseDslExpression('[[Diary::Truncate0.5]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.truncate, {
      enabled: true,
      threshold: 0.5,
    });
  });

  it('[[Diary::Truncate0]] → threshold: 0', () => {
    const result = parseDslExpression('[[Diary::Truncate0]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.truncate, {
      enabled: true,
      threshold: 0,
    });
  });
});

// ─── Modifier: AIMemo ────────────────────────────────────────────────────────

describe('Modifier: AIMemo', () => {
  it('[[Diary::AIMemo]] → { enabled: true, preset: "default" }', () => {
    const result = parseDslExpression('[[Diary::AIMemo]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.aiMemo, {
      enabled: true,
      preset: 'default',
    });
  });

  it('[[Diary::AIMemo:PresetName]] → preset: "PresetName"', () => {
    const result = parseDslExpression('[[Diary::AIMemo:PresetName]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.aiMemo, {
      enabled: true,
      preset: 'PresetName',
    });
  });
});

// ─── Modifier: RoleValve ─────────────────────────────────────────────────────

describe('Modifier: RoleValve', () => {
  it('[[Diary::RoleValve(@User>=2&@Assistant<5)]] → expression parsed', () => {
    const result = parseDslExpression('[[Diary::RoleValve(@User>=2&@Assistant<5)]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.roleValve, {
      enabled: true,
      expression: '@User>=2&@Assistant<5',
    });
  });

  it('[[Diary::RoleValve(@User>=5|@Assistant<3)]] → OR logic', () => {
    const result = parseDslExpression('[[Diary::RoleValve(@User>=5|@Assistant<3)]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.deepStrictEqual(result.rule.modifiers.roleValve, {
      enabled: true,
      expression: '@User>=5|@Assistant<3',
    });
  });
});

// ─── Modifier: Base64Memo ────────────────────────────────────────────────────

describe('Modifier: Base64Memo', () => {
  it('[[Diary::Base64Memo]] → base64Memo: true', () => {
    const result = parseDslExpression('[[Diary::Base64Memo]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.base64Memo, true);
  });
});

// ─── Modifier Combinations ───────────────────────────────────────────────────

describe('Modifier combinations', () => {
  it('[[Diary::Time::Group]] → both true', () => {
    const result = parseDslExpression('[[Diary::Time::Group]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
  });

  it('[[Diary::Time::Group::Rerank]] → three modifiers', () => {
    const result = parseDslExpression('[[Diary::Time::Group::Rerank]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.5,
    });
  });

  it('[[Diary::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]] → complex combo', () => {
    const result = parseDslExpression(
      '[[Diary::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]]'
    );
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.3,
      geodesic: true,
    });
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.7,
    });
    assert.deepStrictEqual(result.rule.modifiers.truncate, {
      enabled: true,
      threshold: 0.4,
    });
    assert.strictEqual(result.rule.meta.warnings.length, 0);
  });

  it('[[Diary::UnknownMod::Time]] — unknown generates warning, known still parsed', () => {
    const result = parseDslExpression('[[Diary::UnknownMod::Time]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.ok(result.rule.meta.warnings.length > 0);
    assert.ok(result.rule.meta.warnings[0].includes('UnknownMod'));
  });

  it('all 9 modifiers combined in one expression', () => {
    const result = parseDslExpression(
      '[[Diary::Time::Group::Rerank+0.7::TimeDecay30/0.5::TagMemo+0.3::Truncate0.4::AIMemo:myPreset::RoleValve(@User>=2)::Base64Memo]]'
    );
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.deepStrictEqual(result.rule.modifiers.rerank, { enabled: true, weight: 0.7 });
    assert.deepStrictEqual(result.rule.modifiers.timeDecay, {
      enabled: true, halfLife: 30, minScore: 0.5, whitelistTags: [],
    });
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true, weight: 0.3, geodesic: true,
    });
    assert.deepStrictEqual(result.rule.modifiers.truncate, {
      enabled: true, threshold: 0.4,
    });
    assert.deepStrictEqual(result.rule.modifiers.aiMemo, {
      enabled: true, preset: 'myPreset',
    });
    assert.deepStrictEqual(result.rule.modifiers.roleValve, {
      enabled: true, expression: '@User>=2',
    });
    assert.strictEqual(result.rule.modifiers.base64Memo, true);
  });
});

// ─── Multi-Diary Aggregation ─────────────────────────────────────────────────

describe('Multi-diary aggregation', () => {
  it('[[Diary1|Diary2]] → two diaries', () => {
    const result = parseDslExpression('[[Diary1|Diary2]]');
    assertSuccess(result, 'rag', ['Diary1', 'Diary2']);
  });

  it('[[Diary1|Diary2|Diary3]] → three diaries', () => {
    const result = parseDslExpression('[[Diary1|Diary2|Diary3]]');
    assertSuccess(result, 'rag', ['Diary1', 'Diary2', 'Diary3']);
  });

  it('{{D1|D2}} full_text with multi-diary', () => {
    const result = parseDslExpression('{{D1|D2}}');
    assertSuccess(result, 'full_text', ['D1', 'D2']);
  });

  it('《《Diary1|Diary2|Diary3》》 gated_rag with multi-diary', () => {
    const result = parseDslExpression('《《Diary1|Diary2|Diary3》》');
    assertSuccess(result, 'gated_rag', ['Diary1', 'Diary2', 'Diary3']);
    assert.strictEqual(result.rule.gateThreshold, 0.35);
  });
});

// ─── K Multiplier ────────────────────────────────────────────────────────────

describe('K multiplier', () => {
  it('[[Diary:1.5]] → kMultiplier: 1.5', () => {
    const result = parseDslExpression('[[Diary:1.5]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.5);
  });

  it('[[Diary:0.5]] → kMultiplier: 0.5', () => {
    const result = parseDslExpression('[[Diary:0.5]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.targets.kMultiplier, 0.5);
  });

  it('default kMultiplier is 1.0', () => {
    const result = parseDslExpression('[[Diary]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.0);
  });

  it('[[Diary|D2:1.2]] multi-diary with K multiplier', () => {
    const result = parseDslExpression('[[Diary|D2:1.2]]');
    assertSuccess(result, 'rag', ['Diary', 'D2']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.2);
    assert.strictEqual(result.rule.targets.aggregate, true);
  });
});

// ─── Edge Cases: Errors ──────────────────────────────────────────────────────

describe('Edge cases: errors', () => {
  it('empty string → error', () => {
    assertError(parseDslExpression(''), 'Empty DSL expression');
  });

  it('whitespace-only string → error', () => {
    assertError(parseDslExpression('   '), 'Empty DSL expression');
  });

  it('non-string input → error', () => {
    assertError(parseDslExpression(null));
    assertError(parseDslExpression(undefined));
    assertError(parseDslExpression(123));
  });

  it('unclosed brackets {{Diary → error', () => {
    assertError(parseDslExpression('{{Diary'), 'Unclosed brackets');
  });

  it('unclosed brackets [[Diary → error', () => {
    assertError(parseDslExpression('[[Diary'), 'Unclosed brackets');
  });

  it('unclosed brackets <<Diary → error', () => {
    assertError(parseDslExpression('<<Diary'), 'Unclosed brackets');
  });

  it('unclosed brackets 《《Diary → error', () => {
    assertError(parseDslExpression('《《Diary'), 'Unclosed brackets');
  });

  it('unknown bracket type ((Diary)) → error', () => {
    assertError(parseDslExpression('((Diary))'), 'Unknown bracket type');
  });

  it('plain text without brackets → error', () => {
    assertError(parseDslExpression('just plain text'), 'Unknown bracket type');
  });

  it('empty body {{}} → error', () => {
    assertError(parseDslExpression('{{}}'), 'Empty expression body');
  });

  it('empty body [[]] → error', () => {
    assertError(parseDslExpression('[[]]'), 'Empty expression body');
  });

  it('negative K multiplier → error', () => {
    assertError(parseDslExpression('[[Diary:-1.5]]'), 'Invalid K multiplier');
  });

  it('zero K multiplier → error', () => {
    assertError(parseDslExpression('[[Diary:0]]'), 'Invalid K multiplier');
  });

  it('mismatched brackets {{Diary]] → error', () => {
    // "{{" opening expects "}}" closing; "]]" won't match
    assertError(parseDslExpression('{{Diary]]'), 'Unclosed brackets');
  });
});

// ─── Edge Cases: Warnings ────────────────────────────────────────────────────

describe('Edge cases: warnings for unknown modifiers', () => {
  it('unknown modifier generates warning', () => {
    const result = parseDslExpression('[[Diary::FooBar]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.meta.warnings.length, 1);
    assert.ok(result.rule.meta.warnings[0].includes('FooBar'));
  });

  it('multiple unknown modifiers generate multiple warnings', () => {
    const result = parseDslExpression('[[Diary::Foo::Bar::Baz]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.meta.warnings.length, 3);
    assert.ok(result.rule.meta.warnings[0].includes('Foo'));
    assert.ok(result.rule.meta.warnings[1].includes('Bar'));
    assert.ok(result.rule.meta.warnings[2].includes('Baz'));
  });

  it('mix of known and unknown: known parsed, unknown warned', () => {
    const result = parseDslExpression('[[Diary::Time::Foo::Group]]');
    assertSuccess(result, 'rag', ['Diary']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.strictEqual(result.rule.meta.warnings.length, 1);
    assert.ok(result.rule.meta.warnings[0].includes('Foo'));
  });
});

// ─── Edge Cases: Whitespace ──────────────────────────────────────────────────

describe('Edge cases: whitespace handling', () => {
  it('trims whitespace around brackets', () => {
    const result = parseDslExpression('  [[Diary]]  ');
    assertSuccess(result, 'rag', ['Diary']);
  });

  it('trims whitespace in diary names', () => {
    const result = parseDslExpression('{{  Diary  }}');
    assertSuccess(result, 'full_text', ['Diary']);
  });

  it('handles whitespace in multi-diary', () => {
    const result = parseDslExpression('[[ D1 | D2 | D3 ]]');
    assertSuccess(result, 'rag', ['D1', 'D2', 'D3']);
  });
});

// ─── Regression: Exact Task Plan Examples ────────────────────────────────────

describe('Regression: exact task plan examples', () => {
  it('{{角色日记本}} → { type: full_text, diaries: [角色日记本], modifiers: {} }', () => {
    const result = parseDslExpression('{{角色日记本}}');
    assertSuccess(result, 'full_text', ['角色日记本']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.0);
    assert.deepStrictEqual(result.rule.modifiers, {});
    assert.strictEqual(result.rule.gateThreshold, undefined);
  });

  it('[[角色日记本::Time::Group::Rerank]] → rag with 3 modifiers', () => {
    const result = parseDslExpression('[[角色日记本::Time::Group::Rerank]]');
    assertSuccess(result, 'rag', ['角色日记本']);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.5,
    });
  });

  it('[[小克日记本:1.2::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]] → full complex parse', () => {
    const result = parseDslExpression(
      '[[小克日记本:1.2::Time::Group::TagMemo+0.3::Rerank+0.7::Truncate0.4]]'
    );
    assertSuccess(result, 'rag', ['小克日记本']);
    assert.strictEqual(result.rule.targets.kMultiplier, 1.2);
    assert.strictEqual(result.rule.modifiers.time, true);
    assert.strictEqual(result.rule.modifiers.group, true);
    assert.deepStrictEqual(result.rule.modifiers.tagMemo, {
      enabled: true,
      weight: 0.3,
      geodesic: true,
    });
    assert.deepStrictEqual(result.rule.modifiers.rerank, {
      enabled: true,
      weight: 0.7,
    });
    assert.deepStrictEqual(result.rule.modifiers.truncate, {
      enabled: true,
      threshold: 0.4,
    });
    assert.strictEqual(result.rule.meta.warnings.length, 0);
  });
});

// ─── Internal Parser Unit Tests ──────────────────────────────────────────────

describe('Internal parsers (unit)', () => {
  const {
    parseTimeModifier,
    parseGroupModifier,
    parseRerankModifier,
    parseTimeDecayModifier,
    parseTagMemoModifier,
    parseTruncateModifier,
    parseAIMemoModifier,
    parseRoleValveModifier,
    parseBase64MemoModifier,
    detectBracketMode,
  } = __internal__;

  it('parseTimeModifier rejects Time2', () => {
    assert.strictEqual(parseTimeModifier('Time2'), null);
  });

  it('parseGroupModifier rejects Groups', () => {
    assert.strictEqual(parseGroupModifier('Groups'), null);
  });

  it('parseRerankModifier rejects RerankX', () => {
    assert.strictEqual(parseRerankModifier('RerankX'), null);
  });

  it('parseTagMemoModifier rejects TagMemoX', () => {
    assert.strictEqual(parseTagMemoModifier('TagMemoX'), null);
  });

  it('detectBracketMode returns type for each bracket', () => {
    const r1 = detectBracketMode('{{D}}');
    const r2 = detectBracketMode('[[D]]');
    const r3 = detectBracketMode('<<D>>');
    const r4 = detectBracketMode('《《D》》');
    assert.strictEqual(r1.type, 'full_text');
    assert.strictEqual(r2.type, 'rag');
    assert.strictEqual(r3.type, 'gated_full_text');
    assert.strictEqual(r4.type, 'gated_rag');
  });
});

// ─── BRACKET_MODE_MAP Constant ───────────────────────────────────────────────

describe('BRACKET_MODE_MAP constant', () => {
  it('has exactly 4 entries', () => {
    assert.strictEqual(Object.keys(BRACKET_MODE_MAP).length, 4);
  });

  it('{{ → full_text', () => {
    assert.strictEqual(BRACKET_MODE_MAP['{{'], 'full_text');
  });

  it('[[ → rag', () => {
    assert.strictEqual(BRACKET_MODE_MAP['[['], 'rag');
  });

  it('<< → gated_full_text', () => {
    assert.strictEqual(BRACKET_MODE_MAP['<<'], 'gated_full_text');
  });

  it('《《 → gated_rag', () => {
    assert.strictEqual(BRACKET_MODE_MAP['《《'], 'gated_rag');
  });
});

// ─── Meta structure ──────────────────────────────────────────────────────────

describe('Meta structure', () => {
  it('valid expression has meta.warnings array', () => {
    const result = parseDslExpression('[[Diary]]');
    assert.deepStrictEqual(result.rule.meta, { warnings: [] });
  });

  it('expression with unknown modifiers populates meta.warnings', () => {
    const result = parseDslExpression('[[Diary::Unknown]]');
    assert.strictEqual(result.rule.meta.warnings.length, 1);
  });

  it('expression with known modifiers leaves meta.warnings empty', () => {
    const result = parseDslExpression('[[Diary::Time::Group]]');
    assert.deepStrictEqual(result.rule.meta, { warnings: [] });
  });
});

// ─── Profile Generators ─────────────────────────────────────────────────────

describe('dslToProfile', () => {
  it('single expression → profile with one rule', () => {
    const result = dslToProfile(['[[Diary::Time]]'], 'Nexus');
    const rule = result.profiles['nexus-default'].rules[0];
    assert.ok(result.agents.Nexus);
    assert.strictEqual(result.agents.Nexus.defaultProfile, 'nexus-default');
    assert.deepStrictEqual(result.agents.Nexus.allowedProfiles, ['nexus-default']);
    assert.ok(result.profiles['nexus-default']);
    assert.strictEqual(result.profiles['nexus-default'].rules.length, 1);
    assert.strictEqual(rule.baseMode, 'rag');
    assert.deepStrictEqual(rule.targets, {
      diaries: ['Diary'],
      kMultiplier: 1.0,
    });
    assert.deepStrictEqual(rule.projection, { emit: 'recall_blocks' });
    assert.deepStrictEqual(result.warnings, []);
  });

  it('single expression with modifiers → correct rule structure', () => {
    const result = dslToProfile(['{{RoleDiary::Group::Rerank+0.7}}'], 'Nova');
    const rule = result.profiles['nova-default'].rules[0];
    assert.strictEqual(rule.baseMode, 'full_text');
    assert.strictEqual(rule.modifiers.group, true);
    assert.deepStrictEqual(rule.modifiers.rerank, { enabled: true, weight: 0.7 });
    assert.deepStrictEqual(rule.targets, {
      diaries: ['RoleDiary'],
      kMultiplier: 1.0,
    });
    assert.deepStrictEqual(rule.projection, { emit: 'full_text_sections' });
    assert.deepStrictEqual(result.warnings, []);
  });

  it('multiple expressions → profile with multiple rules', () => {
    const expressions = [
      '[[Diary1::Time]]',
      '{{Diary2::Group}}',
      '<<Diary3>>',
    ];
    const result = dslToProfile(expressions, 'Midas');
    assert.strictEqual(result.profiles['midas-default'].rules.length, 3);
    assert.strictEqual(result.profiles['midas-default'].rules[0].baseMode, 'rag');
    assert.strictEqual(result.profiles['midas-default'].rules[1].baseMode, 'full_text');
    assert.strictEqual(result.profiles['midas-default'].rules[2].baseMode, 'gated_full_text');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('multiple expressions preserve kMultiplier and modifiers', () => {
    const expressions = [
      '[[Diary:1.5::TimeDecay30]]',
      '《《Memo::TagMemo+0.3》》',
    ];
    const result = dslToProfile(expressions, 'Agent');
    const rules = result.profiles['agent-default'].rules;
    assert.strictEqual(rules[0].targets.kMultiplier, 1.5);
    assert.ok(rules[0].modifiers.timeDecay);
    assert.strictEqual(rules[1].modifiers.tagMemo.geodesic, true);
  });

  it('mixed valid/invalid expressions collects warnings', () => {
    const expressions = [
      '[[ValidDiary::Time]]',
      'not brackets',
      '{{AnotherValid::Group}}',
      '',
    ];
    const result = dslToProfile(expressions, 'Test');
    assert.strictEqual(result.profiles['test-default'].rules.length, 2);
    assert.strictEqual(result.warnings.length, 2);
    assert.strictEqual(result.warnings[0].index, 1);
    assert.strictEqual(result.warnings[0].expression, 'not brackets');
    assert.ok(result.warnings[0].error);
    assert.strictEqual(result.warnings[1].index, 3);
    assert.strictEqual(result.warnings[1].expression, '');
  });

  it('all invalid expressions → empty rules, all warnings', () => {
    const expressions = ['plain text', '[[unclosed'];
    const result = dslToProfile(expressions, 'X');
    assert.strictEqual(result.profiles['x-default'].rules.length, 0);
    assert.strictEqual(result.warnings.length, 2);
    assert.strictEqual(result.warnings[0].index, 0);
    assert.strictEqual(result.warnings[1].index, 1);
  });

  it('empty array → empty rules, no warnings', () => {
    const result = dslToProfile([], 'Empty');
    assert.strictEqual(result.profiles['empty-default'].rules.length, 0);
    assert.deepStrictEqual(result.warnings, []);
  });
});

describe('dslExpressionsToConfig', () => {
  it('returns correct agent config structure', () => {
    const config = dslExpressionsToConfig(['[[Diary::Time]]'], 'Nexus');
    assert.strictEqual(config.agents.Nexus.defaultProfile, 'nexus-default');
    assert.deepStrictEqual(config.agents.Nexus.allowedProfiles, ['nexus-default']);
    assert.ok(config.profiles['nexus-default']);
    assert.strictEqual(config.profiles['nexus-default'].rules.length, 1);
    assert.strictEqual(config.profiles['nexus-default'].rules[0].baseMode, 'rag');
  });

  it('returns empty rules for empty expressions', () => {
    const config = dslExpressionsToConfig([], 'Nova');
    assert.strictEqual(config.agents.Nova.defaultProfile, 'nova-default');
    assert.strictEqual(config.profiles['nova-default'].rules.length, 0);
  });
});

describe('dslSyntaxToProfile', () => {
  it('converts valid single DSL to profile with rules', () => {
    const result = dslSyntaxToProfile('[[Diary::Time::Group]]', 'Nexus');
    assert.ok(result.agents.Nexus);
    assert.strictEqual(result.agents.Nexus.defaultProfile, 'nexus-default');
    assert.strictEqual(result.rules.length, 1);
    assert.strictEqual(result.rules[0].baseMode, 'rag');
    assert.strictEqual(result.rules[0].modifiers.time, true);
  });

  it('converts gated expression with gateThreshold', () => {
    const result = dslSyntaxToProfile('<<GatedDiary::Rerank+0.9>>', 'Nova');
    assert.strictEqual(result.rules[0].baseMode, 'gated_full_text');
    assert.strictEqual(result.rules[0].gateThreshold, 0.35);
    assert.deepStrictEqual(result.rules[0].modifiers.rerank, { enabled: true, weight: 0.9 });
  });

  it('returns error for invalid DSL string', () => {
    const result = dslSyntaxToProfile('not valid', 'X');
    assert.ok(result.error);
    assert.strictEqual(result.rules, undefined);
    assert.strictEqual(result.X, undefined);
  });
});

describe('Profile name kebab-case conversion', () => {
  it('lowercases agent name', () => {
    const result = dslToProfile(['[[D]]'], 'NEXUS');
    assert.strictEqual(result.agents.NEXUS.defaultProfile, 'nexus-default');
  });

  it('replaces spaces and special chars with hyphens', () => {
    const result = dslToProfile(['[[D]]'], 'My Cool Agent!');
    assert.strictEqual(result.agents['My Cool Agent!'].defaultProfile, 'my-cool-agent-default');
  });
});

describe('Warnings array structure', () => {
  it('warnings contain index, expression, and error fields', () => {
    const expressions = ['[[Good]]', 'bad', '[[AlsoGood::Time]]'];
    const result = dslToProfile(expressions, 'Agent');
    assert.strictEqual(result.warnings.length, 1);
    const w = result.warnings[0];
    assert.strictEqual(w.index, 1);
    assert.strictEqual(w.expression, 'bad');
    assert.ok(typeof w.error === 'string');
    assert.ok(w.error.length > 0);
  });
});
