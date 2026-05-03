/**
 * ExpressionEngine — safe expression evaluator with tokenizer and recursive descent parser.
 *
 * Supports:
 *   - Field access: ctx.steps.stepId.outputs.field
 *   - Comparison operators: >=, <=, ==, !=, >, <
 *   - Boolean operators: && (AND), || (OR)
 *   - Parentheses for grouping: (a && b) || c
 *   - Literals: numbers, strings (single/double quotes), null, true, false
 *
 * No eval, no function calls, no arithmetic, no assignment.
 *
 * Examples:
 *   ctx.steps.review.outputs.score >= 90
 *   ctx.inputs.genre == "sci-fi"
 *   (ctx.steps.a.outputs.valid && ctx.steps.b.outputs.score > 80) || ctx.inputs.override == true
 */

const VALID_COMPARISON_OPS = ['>=', '<=', '==', '!=', '>', '<'];

class ExpressionEngine {
  /**
   * Evaluate an expression against a context object.
   * @param {string} expression
   * @param {Object} context
   * @returns {boolean}
   */
  evaluate(expression, context) {
    if (!expression || typeof expression !== 'string') {
      throw new ExpressionError('Expression must be a non-empty string', { expression });
    }

    const tokens = this._tokenize(expression.trim());
    const parser = new Parser(tokens);
    const ast = parser.parse();
    return this._evaluateNode(ast, context);
  }

  /**
   * Tokenize an expression string into a token array.
   * @param {string} expression
   * @returns {Token[]}
   */
  _tokenize(expression) {
    const tokens = [];
    let i = 0;

    while (i < expression.length) {
      const ch = expression[i];

      // Whitespace
      if (/\s/.test(ch)) {
        i++;
        continue;
      }

      // Parentheses
      if (ch === '(') {
        tokens.push({ type: 'LPAREN', value: '(' });
        i++;
        continue;
      }
      if (ch === ')') {
        tokens.push({ type: 'RPAREN', value: ')' });
        i++;
        continue;
      }

      // String literals (single or double quotes)
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let value = '';
        i++;
        while (i < expression.length && expression[i] !== quote) {
          value += expression[i];
          i++;
        }
        if (i >= expression.length) {
          throw new ExpressionError(`Unterminated string literal: ${quote}${value}`, { expression });
        }
        i++; // consume closing quote
        tokens.push({ type: 'STRING', value });
        continue;
      }

      // Numbers
      if (/\d/.test(ch)) {
        let value = '';
        while (i < expression.length && /[\d.]/.test(expression[i])) {
          value += expression[i];
          i++;
        }
        tokens.push({ type: 'NUMBER', value: Number(value) });
        continue;
      }

      // Identifiers and keywords
      if (/[a-zA-Z_]/.test(ch)) {
        let value = '';
        while (i < expression.length && /[a-zA-Z0-9_]/.test(expression[i])) {
          value += expression[i];
          i++;
        }

        if (value === 'true') {
          tokens.push({ type: 'BOOLEAN', value: true });
        } else if (value === 'false') {
          tokens.push({ type: 'BOOLEAN', value: false });
        } else if (value === 'null') {
          tokens.push({ type: 'NULL', value: null });
        } else if (value === 'undefined') {
          tokens.push({ type: 'UNDEFINED', value: undefined });
        } else {
          tokens.push({ type: 'IDENTIFIER', value });
        }
        continue;
      }

      // Operators: >=, <=, ==, !=, &&, ||, >, <
      const twoChar = expression.substring(i, i + 2);
      if (twoChar === '>=' || twoChar === '<=' || twoChar === '==' || twoChar === '!=' || twoChar === '&&' || twoChar === '||') {
        if (twoChar === '&&' || twoChar === '||') {
          tokens.push({ type: 'BOOLEAN_OP', value: twoChar });
        } else {
          tokens.push({ type: 'COMPARISON_OP', value: twoChar });
        }
        i += 2;
        continue;
      }

      if (ch === '>' || ch === '<') {
        tokens.push({ type: 'COMPARISON_OP', value: ch });
        i++;
        continue;
      }

      // Dot operator for path access
      if (ch === '.') {
        tokens.push({ type: 'DOT', value: '.' });
        i++;
        continue;
      }

      throw new ExpressionError(`Unexpected character: '${ch}' at position ${i}`, { expression, position: i });
    }

    tokens.push({ type: 'EOF', value: null });
    return tokens;
  }

  /**
   * Evaluate an AST node against a context object.
   * @param {Object} node
   * @param {Object} context
   * @returns {boolean}
   */
  _evaluateNode(node, context) {
    switch (node.type) {
      case 'boolean_expr': {
        let result = this._evaluateNode(node.left, context);
        for (const op of node.operators) {
          const right = this._evaluateNode(op.right, context);
          if (op.operator === '&&') {
            result = result && right;
          } else if (op.operator === '||') {
            result = result || right;
          }
        }
        return result;
      }

      case 'comparison': {
        const leftValue = this._resolvePath(node.left, context);
        const rightValue = this._resolveLiteral(node.right);
        return this._compare(leftValue, node.operator, rightValue);
      }

      default:
        throw new ExpressionError(`Unknown AST node type: ${node.type}`, { node });
    }
  }

  _resolvePath(pathParts, context) {
    // First part must be 'ctx'
    if (pathParts[0] !== 'ctx') {
      throw new ExpressionError(`Path must start with 'ctx': ${pathParts.join('.')}`, { path: pathParts });
    }

    let current = context;
    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];

      if (current === null || current === undefined) {
        throw new ExpressionError(`Cannot read property '${part}' of ${current} at path: ${pathParts.join('.')}`, { path: pathParts });
      }

      if (typeof current !== 'object') {
        throw new ExpressionError(`Cannot read property '${part}' from non-object at path: ${pathParts.join('.')}`, { path: pathParts });
      }

      if (!(part in current)) {
        throw new ExpressionError(`Property '${part}' does not exist at path: ${pathParts.join('.')}`, { path: pathParts });
      }

      current = current[part];
    }

    return current;
  }

  _resolveLiteral(literalNode) {
    switch (literalNode.type) {
      case 'NUMBER':
        return literalNode.value;
      case 'STRING':
        return literalNode.value;
      case 'BOOLEAN':
        return literalNode.value;
      case 'NULL':
        return null;
      case 'UNDEFINED':
        return undefined;
      case 'IDENTIFIER':
        // Bare identifier treated as string for compatibility
        return literalNode.value;
      default:
        throw new ExpressionError(`Unknown literal type: ${literalNode.type}`, { literalNode });
    }
  }

  _compare(leftValue, operator, rightValue) {
    switch (operator) {
      case '>':
        return leftValue > rightValue;
      case '>=':
        return leftValue >= rightValue;
      case '<':
        return leftValue < rightValue;
      case '<=':
        return leftValue <= rightValue;
      case '==':
        return leftValue === rightValue;
      case '!=':
        return leftValue !== rightValue;
      default:
        throw new ExpressionError(`Unsupported operator: ${operator}`, { operator });
    }
  }
}

/**
 * Recursive descent parser for boolean expressions.
 *
 * Grammar:
 *   expr       := boolean_expr
 *   boolean_expr := comparison ( ('&&' | '||') comparison )*
 *   comparison := path comparison_op literal
 *   path       := identifier ('.' identifier)*
 *   literal    := number | string | boolean | null | undefined | identifier
 */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  consume() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    const token = this.peek();
    if (token.type !== type) {
      throw new ExpressionError(
        `Expected token type '${type}' but got '${token.type}' (${token.value})`,
        { expected: type, got: token }
      );
    }
    return this.consume();
  }

  parse() {
    const result = this.parseBooleanExpr();
    this.expect('EOF');
    return result;
  }

  parseBooleanExpr() {
    const left = this.parseComparison();
    const operators = [];

    while (this.peek().type === 'BOOLEAN_OP') {
      const opToken = this.consume();
      const right = this.parseComparison();
      operators.push({ operator: opToken.value, right });
    }

    if (operators.length === 0) {
      return left;
    }

    return { type: 'boolean_expr', left, operators };
  }

  parseComparison() {
    // Support optional parentheses around comparisons
    if (this.peek().type === 'LPAREN') {
      this.consume(); // (
      const inner = this.parseBooleanExpr();
      this.expect('RPAREN');
      return inner;
    }

    const path = this.parsePath();
    const opToken = this.expect('COMPARISON_OP');
    const literal = this.parseLiteral();

    return { type: 'comparison', left: path, operator: opToken.value, right: literal };
  }

  parsePath() {
    const parts = [];
    parts.push(this.expect('IDENTIFIER').value);

    while (this.peek().type === 'DOT') {
      this.consume(); // .
      parts.push(this.expect('IDENTIFIER').value);
    }

    return parts;
  }

  parseLiteral() {
    const token = this.peek();
    switch (token.type) {
      case 'NUMBER':
        this.consume();
        return { type: 'NUMBER', value: token.value };
      case 'STRING':
        this.consume();
        return { type: 'STRING', value: token.value };
      case 'BOOLEAN':
        this.consume();
        return { type: 'BOOLEAN', value: token.value };
      case 'NULL':
        this.consume();
        return { type: 'NULL', value: null };
      case 'UNDEFINED':
        this.consume();
        return { type: 'UNDEFINED', value: undefined };
      case 'IDENTIFIER':
        this.consume();
        return { type: 'IDENTIFIER', value: token.value };
      default:
        throw new ExpressionError(
          `Expected literal but got '${token.type}' (${token.value})`,
          { token }
        );
    }
  }
}

class ExpressionError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'ExpressionError';
    this.context = context;
  }
}

module.exports = { ExpressionEngine, ExpressionError };
