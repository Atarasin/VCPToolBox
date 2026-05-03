/**
 * Built-in parsers for ExtractionLayer.
 *
 * Each parser receives raw markdown and returns either the parsed
 * structured value or `undefined` when it cannot handle the input.
 */

/**
 * Extract JSON from fenced code blocks (```json ... ```)
 */
function jsonBlockParser(markdown) {
  const blockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  const matches = [...markdown.matchAll(blockRegex)];

  for (const match of matches) {
    const candidate = match[1].trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue to next block
    }
  }

  return undefined;
}

/**
 * Extract first top-level JSON object or array from markdown text.
 * Attempts to repair truncated JSON by closing unbalanced braces/brackets
 * and unclosed strings.
 */
function jsonObjectParser(markdown) {
  // Find the first top-level { or [
  const firstBrace = markdown.indexOf('{');
  const firstBracket = markdown.indexOf('[');

  let start = -1;
  let endChar = '';

  if (firstBrace === -1 && firstBracket === -1) {
    return undefined;
  } else if (firstBrace === -1) {
    start = firstBracket;
    endChar = ']';
  } else if (firstBracket === -1) {
    start = firstBrace;
    endChar = '}';
  } else {
    start = Math.min(firstBrace, firstBracket);
    endChar = start === firstBrace ? '}' : ']';
  }

  // Try to find the matching closing bracket by scanning forward
  let depth = 1;
  let inString = false;
  let escaped = false;
  let i = start + 1;

  for (; i < markdown.length; i++) {
    const char = markdown[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        i++; // include the closing bracket
        break;
      }
    }
  }

  // Extract candidate — may be truncated if depth > 0
  const candidate = markdown.slice(start, i);

  try {
    return JSON.parse(candidate);
  } catch {
    // Attempt truncated JSON repair
    const repaired = _repairJson(candidate);
    if (repaired !== undefined) {
      try {
        return JSON.parse(repaired);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Attempt to repair common JSON truncation issues.
 * Returns repaired string or undefined if repair is not possible.
 */
function _repairJson(jsonStr) {
  let repaired = jsonStr.trim();

  // Close unclosed strings
  repaired = _closeUnclosedStrings(repaired);

  // Balance braces and brackets
  repaired = _balanceBrackets(repaired);

  // Remove trailing comma before closing brace/bracket
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // If we made changes, return the repaired string
  if (repaired !== jsonStr.trim()) {
    return repaired;
  }

  return undefined;
}

/**
 * Close unclosed string literals in JSON.
 * If a string is unclosed at the end, either close it or remove the partial property.
 */
function _closeUnclosedStrings(str) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
    }
  }

  if (inString) {
    // String is unclosed. Find if we're mid-property or mid-value.
    // Look backwards for the last colon outside a string to determine context.
    let lastColon = -1;
    let tempInString = false;
    let tempEscaped = false;
    for (let i = 0; i < result.length; i++) {
      const c = result[i];
      if (tempEscaped) { tempEscaped = false; continue; }
      if (c === '\\') { tempEscaped = true; continue; }
      if (c === '"') { tempInString = !tempInString; continue; }
      if (!tempInString && c === ':') lastColon = i;
    }

    if (lastColon > 0) {
      // We're likely in a value — close the quote
      result += '"';
    } else {
      // We're likely in a key — this is harder to repair safely.
      // Remove from the last comma or opening brace to keep the object valid.
      const lastComma = result.lastIndexOf(',');
      const lastBrace = result.lastIndexOf('{');
      const lastBracket = result.lastIndexOf('[');
      const cutPoint = Math.max(lastComma, lastBrace, lastBracket);
      if (cutPoint > 0) {
        result = result.slice(0, cutPoint);
      }
    }
  }

  return result;
}

/**
 * Balance JSON braces {} and brackets [].
 * Adds missing closing brackets at the end.
 */
function _balanceBrackets(str) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      const last = stack[stack.length - 1];
      if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
        stack.pop();
      }
      // Ignore mismatched closing brackets
    }
  }

  // Append missing closing brackets in reverse order
  let result = str;
  while (stack.length > 0) {
    const open = stack.pop();
    result += open === '{' ? '}' : ']';
  }

  return result;
}

/**
 * Extract from XML-like tags (<root>...</root>)
 */
function xmlParser(markdown) {
  const tagRegex = /^\s*<([\w_][\w\d_]*)>([\s\S]*?)<\/\1>/;
  const match = markdown.match(tagRegex);

  if (!match) return undefined;

  // Parse the full matched tag; if it yields a single root key whose value
  // is a non-null object, unwrap it so callers get the inner payload.
  const fullResult = parseXmlToObject(match[0]);
  const keys = Object.keys(fullResult);
  if (keys.length === 1 && typeof fullResult[keys[0]] === 'object' && fullResult[keys[0]] !== null) {
    return fullResult[keys[0]];
  }

  return fullResult;
}

/**
 * Naive XML string to plain object converter.
 * Only handles flat tag structures; nested tags become strings.
 */
function parseXmlToObject(xml) {
  const obj = {};
  const tagRegex = /<([\w_][\w\d_]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tagRegex.exec(xml)) !== null) {
    const key = m[1];
    const value = m[2].trim();
    // Try to parse as JSON first, else keep as string
    try {
      obj[key] = JSON.parse(value);
    } catch {
      // If it contains nested tags, recursively parse
      if (value.includes('<')) {
        const nested = parseXmlToObject(value);
        obj[key] = Object.keys(nested).length > 0 ? nested : value;
      } else {
        obj[key] = value;
      }
    }
  }
  return obj;
}

/**
 * Fallback: return the raw markdown as { raw: markdown }
 */
function fallbackRawParser(markdown) {
  return { raw: markdown };
}

module.exports = {
  jsonBlockParser,
  jsonObjectParser,
  xmlParser,
  fallbackRawParser,
  parseXmlToObject,
  // Exposed for testing
  _repairJson,
  _closeUnclosedStrings,
  _balanceBrackets
};
