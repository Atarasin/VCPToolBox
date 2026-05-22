#!/usr/bin/env node
/**
 * recall-dsl-compiler.js — VCPToolBox Recall DSL Expression Parser
 *
 * Parses VCPToolBox's recall DSL expressions (defined in RECALL_METHODS.md)
 * into structured rule objects compatible with recall_profiles.json format.
 *
 * 4 bracket modes:
 *   {{...}}  → full_text
 *   [[...]]  → rag
 *   <<...>>  → gated_full_text (default gateThreshold: 0.35)
 *   《《...》》 → gated_rag       (default gateThreshold: 0.35)
 *
 * 9 modifiers (after :: separator):
 *   Time, Group, Rerank/Rerank+, TimeDecay, TagMemo/TagMemo+,
 *   Truncate, AIMemo, RoleValve, Base64Memo
 *
 * Multi-diary: diary names separated by |
 * K multiplier: :<number> after diary name(s)
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maps opening bracket string → rule type */
const BRACKET_MODE_MAP = {
  '{{': 'full_text',
  '[[': 'rag',
  '<<': 'gated_full_text',
  '《《': 'gated_rag',
};

/** Maps closing bracket string → opening bracket (for validation) */
const CLOSING_TO_OPENING = {
  '}}': '{{',
  ']]': '[[',
  '>>': '<<',
  '》》': '《《',
};

/** Maps rule type → whether gated */
const GATED_TYPES = new Set(['gated_full_text', 'gated_rag']);

/** Module-level parse result with convenience constructor */
class ParseResult {
  /**
   * @param {object|null} rule
   * @param {string|null} error
   */
  constructor(rule, error) {
    this.rule = rule;
    this.error = error;
  }

  static ok(rule) {
    return new ParseResult(rule, null);
  }

  static fail(error) {
    return new ParseResult(null, error);
  }
}

// ─── Phase 1: Bracket Mode Detection ────────────────────────────────────────

/**
 * Detect the bracket mode by examining opening/closing brackets.
 * @param {string} dslString - raw DSL expression string
 * @returns {{ type: string, inner: string, gateThreshold: number|undefined, bracket: string }|ParseResult}
 */
function detectBracketMode(dslString) {
  const trimmed = dslString.trim();

  if (trimmed.length === 0) {
    return ParseResult.fail('Empty DSL expression');
  }

  // Find opening bracket (first 2 chars)
  const opening = trimmed.substring(0, 2);
  const type = BRACKET_MODE_MAP[opening];

  if (!type) {
    return ParseResult.fail(
      `Unknown bracket type: "${opening}". Supported: {{, [[, <<, 《《`
    );
  }

  // Find the matching closing bracket
  let closing;
  for (const [cl, op] of Object.entries(CLOSING_TO_OPENING)) {
    if (op === opening) {
      closing = cl;
      break;
    }
  }

  // Check for closing bracket
  const closeIdx = trimmed.lastIndexOf(closing);
  if (closeIdx === -1 || closeIdx === 0) {
    return ParseResult.fail(
      `Unclosed brackets: expected "${closing}" to close "${opening}"`
    );
  }

  const inner = trimmed.substring(2, closeIdx).trim();

  if (inner.length === 0) {
    return ParseResult.fail('Empty expression body (no diary name specified)');
  }

  const gateThreshold = GATED_TYPES.has(type) ? 0.35 : undefined;

  return { type, inner, gateThreshold, bracket: opening };
}

// ─── Phase 2: Body Parsing ──────────────────────────────────────────────────

/**
 * Parse the inner body of a DSL expression.
 * Splits into: diary names, K multiplier, modifier chain.
 *
 * The first `::` separates (diaries + K) from modifiers.
 * Before `::`: "Diary1|Diary2:1.5" → diaries, kMultiplier
 * After `::`: "Time::Group::Rerank+0.7" → modifier tokens
 *
 * @param {string} inner - content between brackets
 * @returns {{ diaries: string[], kMultiplier: number, modifierTokens: string[] }|ParseResult}
 */
function parseBody(inner) {
  // Find first :: separator
  const sepIndex = inner.indexOf('::');

  let diaryPart, modifierPart;

  if (sepIndex === -1) {
    diaryPart = inner;
    modifierPart = '';
  } else {
    diaryPart = inner.substring(0, sepIndex).trim();
    modifierPart = inner.substring(sepIndex + 2);
  }

  // Parse diary names and optional K multiplier
  // Pattern: Diary1|Diary2:1.5  or  Diary1
  const colonIdx = diaryPart.lastIndexOf(':');

  let diaryStr, kStr;

  if (colonIdx === -1) {
    diaryStr = diaryPart;
    kStr = null;
  } else {
    diaryStr = diaryPart.substring(0, colonIdx).trim();
    kStr = diaryPart.substring(colonIdx + 1).trim();
  }

  // Parse diaries (split by |)
  const diaries = diaryStr
    .split('|')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (diaries.length === 0) {
    return ParseResult.fail('No diary name specified');
  }

  // Parse K multiplier
  let kMultiplier = 1.0;
  if (kStr) {
    const parsed = parseFloat(kStr);
    if (isNaN(parsed) || parsed <= 0) {
      return ParseResult.fail(
        `Invalid K multiplier: "${kStr}". Must be a positive number.`
      );
    }
    kMultiplier = parsed;
  }

  // Parse modifier tokens
  const modifierTokens = modifierPart
    ? modifierPart.split('::').filter((t) => t.trim().length > 0)
    : [];

  return { diaries, kMultiplier, modifierTokens };
}

// ─── Phase 3: Modifier Parsers ──────────────────────────────────────────────

/**
 * Parse time modifier: "Time" → { time: true }
 */
function parseTimeModifier(token) {
  if (token === 'Time') {
    return { key: 'time', value: true };
  }
  return null;
}

/**
 * Parse group modifier: "Group" → { group: true }
 */
function parseGroupModifier(token) {
  if (token === 'Group') {
    return { key: 'group', value: true };
  }
  return null;
}

/**
 * Parse rerank modifier:
 *   "Rerank"     → { enabled: true, weight: 0.5 }
 *   "Rerank+0.7" → { enabled: true, weight: 0.7 }
 */
function parseRerankModifier(token) {
  const match = token.match(/^Rerank(\+(\d+(?:\.\d+)?))?$/);
  if (!match) return null;

  return {
    key: 'rerank',
    value: {
      enabled: true,
      weight: match[2] ? parseFloat(match[2]) : 0.5,
    },
  };
}

/**
 * Parse timeDecay modifier:
 *   "TimeDecay30/0.5/box归档" → { halfLife: 30, minScore: 0.5, whitelistTags: ["box归档"] }
 *   "TimeDecay30"              → { halfLife: 30, minScore: 0, whitelistTags: [] }
 */
function parseTimeDecayModifier(token) {
  const match = token.match(/^TimeDecay(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?(?:\/(.+))?$/);
  if (!match) return null;

  const halfLife = parseFloat(match[1]);
  const minScore = match[2] ? parseFloat(match[2]) : 0;
  const whitelistTags = match[3]
    ? match[3].split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    key: 'timeDecay',
    value: {
      enabled: true,
      halfLife,
      minScore,
      whitelistTags,
    },
  };
}

/**
 * Parse tagMemo modifier:
 *   "TagMemo"       → { enabled: true, weight: 0.5, geodesic: false }
 *   "TagMemo0.3"    → { enabled: true, weight: 0.3, geodesic: false }
 *   "TagMemo+"      → { enabled: true, weight: 0.5, geodesic: true }
 *   "TagMemo+0.3"   → { enabled: true, weight: 0.3, geodesic: true }
 */
function parseTagMemoModifier(token) {
  const match = token.match(/^TagMemo(\+)?(\d+(?:\.\d+)?)?$/);
  if (!match) return null;

  return {
    key: 'tagMemo',
    value: {
      enabled: true,
      weight: match[2] ? parseFloat(match[2]) : 0.5,
      geodesic: !!match[1],
    },
  };
}

/**
 * Parse truncate modifier: "Truncate0.5" → { enabled: true, threshold: 0.5 }
 */
function parseTruncateModifier(token) {
  const match = token.match(/^Truncate(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  return {
    key: 'truncate',
    value: {
      enabled: true,
      threshold: parseFloat(match[1]),
    },
  };
}

/**
 * Parse aiMemo modifier:
 *   "AIMemo"            → { enabled: true, preset: "default" }
 *   "AIMemo:PresetName" → { enabled: true, preset: "PresetName" }
 */
function parseAIMemoModifier(token) {
  const match = token.match(/^AIMemo(?::(.+))?$/);
  if (!match) return null;

  return {
    key: 'aiMemo',
    value: {
      enabled: true,
      preset: match[1] || 'default',
    },
  };
}

/**
 * Parse roleValve modifier:
 *   "RoleValve(@User>=2&@Assistant<5)" → { enabled: true, expression: "@User>=2&@Assistant<5" }
 */
function parseRoleValveModifier(token) {
  const match = token.match(/^RoleValve\((.+)\)$/);
  if (!match) return null;

  return {
    key: 'roleValve',
    value: {
      enabled: true,
      expression: match[1],
    },
  };
}

/**
 * Parse base64Memo modifier: "Base64Memo" → { base64Memo: true }
 */
function parseBase64MemoModifier(token) {
  if (token === 'Base64Memo') {
    return { key: 'base64Memo', value: true };
  }
  return null;
}

/**
 * Ordered array of modifier parsers. Each returns { key, value } or null.
 */
const MODIFIER_PARSERS = [
  parseTimeModifier,
  parseGroupModifier,
  parseRerankModifier,
  parseTimeDecayModifier,
  parseTagMemoModifier,
  parseTruncateModifier,
  parseAIMemoModifier,
  parseRoleValveModifier,
  parseBase64MemoModifier,
];

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Parse a VCPToolBox recall DSL expression into a structured rule object.
 *
 * @param {string} dslString - raw DSL expression, e.g. "[[角色日记本::Time::Group::Rerank]]"
 * @returns {{ rule: object|null, error: string|null }}
 *   On success: { rule: { type, diaries, kMultiplier, gateThreshold?, modifiers, meta } }
 *   On failure: { rule: null, error: "descriptive message" }
 */
function parseDslExpression(dslString) {
  if (typeof dslString !== 'string') {
    return ParseResult.fail('DSL expression must be a string');
  }

  // Phase 1: Bracket mode detection
  const phase1Result = detectBracketMode(dslString);
  if (phase1Result instanceof ParseResult) {
    return phase1Result;
  }

  const { type, inner, gateThreshold } = phase1Result;

  // Phase 2: Body parsing (diaries, K multiplier, modifier tokens)
  const phase2Result = parseBody(inner);
  if (phase2Result instanceof ParseResult) {
    return phase2Result;
  }

  const { diaries, kMultiplier, modifierTokens } = phase2Result;

  // Phase 3: Modifier parsing
  const modifiers = {};
  const warnings = [];

  for (const token of modifierTokens) {
    let recognized = false;

    for (const parser of MODIFIER_PARSERS) {
      const result = parser(token);
      if (result) {
        modifiers[result.key] = result.value;
        recognized = true;
        break;
      }
    }

    if (!recognized) {
      warnings.push(`Unknown modifier: "${token}"`);
    }
  }

  const rule = {
    type,
    diaries,
    kMultiplier,
    modifiers,
    meta: {
      warnings,
    },
  };

  // Only include gateThreshold for gated types
  if (GATED_TYPES.has(type)) {
    rule.gateThreshold = gateThreshold;
  }

  return ParseResult.ok(rule);
}

// ─── Profile Generators ─────────────────────────────────────────────────────

/**
 * Convert a string to kebab-case: lowercase, non-alphanumeric replaced with hyphens.
 * @param {string} str
 * @returns {string}
 */
function toKebabCase(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert an array of DSL expression strings into a recall profile config.
 *
 * @param {string[]} expressions - array of DSL expression strings
 * @param {string} agentName - agent name (e.g. "Nexus")
 * @returns {{ [agentName]: object, warnings: object[] }}
 */
function dslToProfile(expressions, agentName) {
  if (!Array.isArray(expressions)) {
    expressions = [];
  }

  const kebabName = toKebabCase(agentName || '');
  const profileName = `${kebabName}-default`;
  const rules = [];
  const warnings = [];

  for (let i = 0; i < expressions.length; i++) {
    const result = parseDslExpression(expressions[i]);
    if (result.error) {
      warnings.push({ index: i, expression: expressions[i], error: result.error });
    } else {
      rules.push(result.rule);
    }
  }

  return {
    [agentName]: {
      defaultProfile: profileName,
      profiles: {
        [profileName]: { rules },
      },
    },
    warnings,
  };
}

/**
 * Convenience wrapper around dslToProfile returning just the agent config.
 *
 * @param {string[]} expressions - array of DSL expression strings
 * @param {string} agentName - agent name
 * @returns {object} agent config object
 */
function dslExpressionsToConfig(expressions, agentName) {
  return dslToProfile(expressions, agentName)[agentName];
}

/**
 * Quick converter for a single DSL string into a profile config.
 *
 * @param {string} dslString - single DSL expression string
 * @param {string} agentName - agent name
 * @returns {{ [agentName]: object, rules: object[] }|{ error: string }}
 */
function dslSyntaxToProfile(dslString, agentName) {
  const result = parseDslExpression(dslString);
  if (result.error) {
    return { error: result.error };
  }

  const kebabName = toKebabCase(agentName || '');
  const profileName = `${kebabName}-default`;

  return {
    [agentName]: {
      defaultProfile: profileName,
      profiles: {
        [profileName]: { rules: [result.rule] },
      },
    },
    rules: [result.rule],
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  parseDslExpression,
  dslToProfile,
  dslExpressionsToConfig,
  dslSyntaxToProfile,
  // Expose constants for testing and downstream use
  BRACKET_MODE_MAP,
  CLOSING_TO_OPENING,
  GATED_TYPES,
  MODIFIER_PARSERS,
  // Expose internal parsers for unit testing
  __internal__: {
    detectBracketMode,
    parseBody,
    parseTimeModifier,
    parseGroupModifier,
    parseRerankModifier,
    parseTimeDecayModifier,
    parseTagMemoModifier,
    parseTruncateModifier,
    parseAIMemoModifier,
    parseRoleValveModifier,
    parseBase64MemoModifier,
  },
};
