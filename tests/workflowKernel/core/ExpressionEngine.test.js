const assert = require('node:assert/strict');
const test = require('node:test');
const { ExpressionEngine, ExpressionError } = require('../../../modules/workflowKernel/core/ExpressionEngine');

const engine = new ExpressionEngine();

function makeContext(values) {
  return {
    inputs: values.inputs || {},
    outputs: values.outputs || {},
    steps: values.steps || {}
  };
}

// --- Basic comparisons (backward compatibility) ---

test('evaluates simple comparison: >=', () => {
  const ctx = makeContext({ steps: { review: { outputs: { score: 95 } } } });
  assert.equal(engine.evaluate('ctx.steps.review.outputs.score >= 90', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.review.outputs.score >= 100', ctx), false);
});

test('evaluates simple comparison: >', () => {
  const ctx = makeContext({ steps: { a: { outputs: { val: 5 } } } });
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val > 3', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val > 5', ctx), false);
});

test('evaluates simple comparison: <=', () => {
  const ctx = makeContext({ steps: { a: { outputs: { val: 5 } } } });
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val <= 10', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val <= 4', ctx), false);
});

test('evaluates simple comparison: <', () => {
  const ctx = makeContext({ steps: { a: { outputs: { val: 5 } } } });
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val < 10', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val < 5', ctx), false);
});

test('evaluates simple comparison: ==', () => {
  const ctx = makeContext({ inputs: { genre: 'sci-fi' }, steps: { a: { outputs: { flag: true } } } });
  assert.equal(engine.evaluate('ctx.inputs.genre == "sci-fi"', ctx), true);
  assert.equal(engine.evaluate('ctx.inputs.genre == "horror"', ctx), false);
  assert.equal(engine.evaluate("ctx.inputs.genre == 'sci-fi'", ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.flag == true', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.flag == false', ctx), false);
});

test('evaluates simple comparison: !=', () => {
  const ctx = makeContext({ inputs: { genre: 'sci-fi' } });
  assert.equal(engine.evaluate('ctx.inputs.genre != "horror"', ctx), true);
  assert.equal(engine.evaluate('ctx.inputs.genre != "sci-fi"', ctx), false);
});

test('evaluates comparison with null', () => {
  const ctx = makeContext({ steps: { a: { outputs: { val: null } } } });
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val == null', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val != null', ctx), false);
});

test('evaluates comparison with number literal', () => {
  const ctx = makeContext({ steps: { a: { outputs: { val: 42 } } } });
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val == 42', ctx), true);
  assert.equal(engine.evaluate('ctx.steps.a.outputs.val == 43', ctx), false);
});

// --- Boolean AND (&&) ---

test('evaluates boolean AND: both true', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: true } },
      b: { outputs: { score: 95 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90', ctx),
    true
  );
});

test('evaluates boolean AND: first false', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: false } },
      b: { outputs: { score: 95 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90', ctx),
    false
  );
});

test('evaluates boolean AND: second false', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: true } },
      b: { outputs: { score: 80 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90', ctx),
    false
  );
});

test('evaluates boolean AND: both false', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: false } },
      b: { outputs: { score: 80 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90', ctx),
    false
  );
});

// --- Boolean OR (||) ---

test('evaluates boolean OR: first true', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: true } },
      b: { outputs: { score: 80 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true || ctx.steps.b.outputs.score >= 90', ctx),
    true
  );
});

test('evaluates boolean OR: second true', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: false } },
      b: { outputs: { score: 95 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true || ctx.steps.b.outputs.score >= 90', ctx),
    true
  );
});

test('evaluates boolean OR: both false', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { valid: false } },
      b: { outputs: { score: 80 } }
    }
  });
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.valid == true || ctx.steps.b.outputs.score >= 90', ctx),
    false
  );
});

// --- Parentheses ---

test('evaluates parentheses grouping', () => {
  const ctx = makeContext({
    inputs: { override: false },
    steps: {
      a: { outputs: { valid: false } },
      b: { outputs: { score: 95 } }
    }
  });
  // (false && true) || false => false || false => false
  assert.equal(
    engine.evaluate('(ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90) || ctx.inputs.override == true', ctx),
    false
  );

  // Change override to true
  ctx.inputs.override = true;
  // (false && true) || true => false || true => true
  assert.equal(
    engine.evaluate('(ctx.steps.a.outputs.valid == true && ctx.steps.b.outputs.score >= 90) || ctx.inputs.override == true', ctx),
    true
  );
});

test('evaluates nested parentheses', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { x: 1 } },
      b: { outputs: { y: 2 } },
      c: { outputs: { z: 3 } }
    }
  });
  // (true && (true || false)) => true
  assert.equal(
    engine.evaluate('(ctx.steps.a.outputs.x == 1 && (ctx.steps.b.outputs.y == 2 || ctx.steps.c.outputs.z == 99))', ctx),
    true
  );
});

// --- Mixed operators ---

test('evaluates mixed && and || without parentheses (left-to-right)', () => {
  const ctx = makeContext({
    steps: {
      a: { outputs: { val: 1 } },
      b: { outputs: { val: 2 } },
      c: { outputs: { val: 3 } }
    }
  });
  // true && false || true => (true && false) || true => false || true => true
  assert.equal(
    engine.evaluate('ctx.steps.a.outputs.val == 1 && ctx.steps.b.outputs.val == 99 || ctx.steps.c.outputs.val == 3', ctx),
    true
  );
});

// --- Error cases ---

test('throws on empty expression', () => {
  assert.throws(() => engine.evaluate('', {}), ExpressionError);
});

test('throws on non-string expression', () => {
  assert.throws(() => engine.evaluate(null, {}), ExpressionError);
});

test('throws on invalid path (not starting with ctx)', () => {
  assert.throws(
    () => engine.evaluate('foo.bar == 1', {}),
    /Path must start with 'ctx'/
  );
});

test('throws on missing property', () => {
  const ctx = makeContext({ steps: {} });
  assert.throws(
    () => engine.evaluate('ctx.steps.missing.outputs.val == 1', ctx),
    /Property 'missing' does not exist/
  );
});

test('throws on unexpected character', () => {
  assert.throws(
    () => engine.evaluate('ctx.a.b @ 1', {}),
    /Unexpected character/
  );
});

test('throws on unterminated string', () => {
  assert.throws(
    () => engine.evaluate('ctx.a.b == "unterminated', {}),
    /Unterminated string literal/
  );
});

test('throws on missing right-hand side', () => {
  assert.throws(
    () => engine.evaluate('ctx.a.b ==', {}),
    ExpressionError
  );
});

test('ExpressionError carries context', () => {
  try {
    engine.evaluate('', {});
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.name, 'ExpressionError');
    assert.ok(err.context);
  }
});
