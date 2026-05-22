const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  migrate,
  generateProfileForAgent,
  readSourceConfig,
  parseArgs,
  toKebabCase,
  ALL_MODIFIERS,
  RECOMMENDED_MODIFIERS,
} = require('../../scripts/migrate-to-recall-profiles.js');

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeConfig(tmpDir, content) {
  const p = path.join(tmpDir, 'mcp_agent_memory_policy.json');
  fs.writeFileSync(p, JSON.stringify(content, null, 2), 'utf-8');
  return p;
}

// ─── 1. Basic migration with 4 agents ───────────────────────────────
describe('migrate()', () => {
  it('migrates all agents from a full config', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: {
          Nexus: {
            maid: 'Nexus',
            defaultDiaries: ['Nexus日记本', 'Nexus架构设计日记本'],
            allowedDiaries: ['Nexus日记本', 'Nexus架构设计日记本'],
          },
          MCPMidas: {
            maid: '迈达斯',
            defaultDiaries: ['迈达斯日记本'],
            allowedDiaries: ['迈达斯日记本', '迈达斯因子与策略库日记本'],
          },
        },
      });

      const { result, reports, warnings } = migrate(configPath, { agents: [] });

      assert.strictEqual(Object.keys(result.agents).length, 2);
      assert.ok(result.agents.Nexus);
      assert.ok(result.agents.MCPMidas);
      assert.strictEqual(warnings.length, 0);
      assert.strictEqual(reports.length, 2);
    });
  });

  // ─── 2. Dry-run mode (no file write) ───────────────────────────────
  it('dry-run does not write any file', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { Yui: { maid: 'Yui', defaultDiaries: ['Yui'], allowedDiaries: ['Yui'] } },
      });

      const { result } = migrate(configPath, { agents: [] });
      assert.ok(result.agents.Yui);

      const suggestedPath = path.join(tmpDir, 'recall_profiles.json.suggested');
      assert.strictEqual(fs.existsSync(suggestedPath), false);
    });
  });

  // ─── 3. --write mode (file written correctly) ──────────────────────
  it('write mode persists correct JSON structure', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { main: { maid: 'Yui', defaultDiaries: ['Yui'], allowedDiaries: ['Yui'] } },
      });

      const { result } = migrate(configPath, { agents: [] });
      const suggestedPath = path.join(tmpDir, 'recall_profiles.json.suggested');
      fs.writeFileSync(suggestedPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');

      assert.strictEqual(fs.existsSync(suggestedPath), true);
      const written = JSON.parse(fs.readFileSync(suggestedPath, 'utf-8'));
      assert.deepStrictEqual(written, result);
      assert.strictEqual(written.agents.main.defaultProfile, 'main-default');
      assert.strictEqual(written.agents.main.profiles['main-default'].rules[0].type, 'rag');
    });
  });

  // ─── 4. --agent filter (single agent) ─────────────────────────────
  it('filters to a single agent', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: {
          Nexus: { maid: 'Nexus', defaultDiaries: ['A'], allowedDiaries: ['A', 'B'] },
          Yui: { maid: 'Yui', defaultDiaries: ['Yui'], allowedDiaries: ['Yui'] },
        },
      });

      const { result } = migrate(configPath, { agents: ['Yui'] });
      assert.strictEqual(Object.keys(result.agents).length, 1);
      assert.ok(result.agents.Yui);
      assert.strictEqual(result.agents.Nexus, undefined);
    });
  });

  // ─── 5. --agent filter (non-existent agent) ───────────────────────
  it('returns empty result for non-existent agent filter', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { Nexus: { maid: 'Nexus', defaultDiaries: ['A'], allowedDiaries: ['A'] } },
      });

      const { result, reports } = migrate(configPath, { agents: ['GhostAgent'] });
      assert.strictEqual(Object.keys(result.agents).length, 0);
      assert.strictEqual(reports.length, 0);
    });
  });

  // ─── 6. Empty config (no agents) ───────────────────────────────────
  it('handles empty agents object', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, { agents: {} });
      const { result, reports, warnings } = migrate(configPath, { agents: [] });
      assert.strictEqual(Object.keys(result.agents).length, 0);
      assert.strictEqual(reports.length, 0);
      assert.strictEqual(warnings.length, 0);
    });
  });

  // ─── 7. Missing config file ────────────────────────────────────────
  it('throws when source config is missing', () => {
    withTempDir((tmpDir) => {
      const missingPath = path.join(tmpDir, 'nonexistent.json');
      assert.throws(
        () => migrate(missingPath, { agents: [] }),
        /Source config not found/
      );
    });
  });

  // ─── 8. Invalid JSON in config file ────────────────────────────────
  it('throws when config contains invalid JSON', () => {
    withTempDir((tmpDir) => {
      const badPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(badPath, '{ not json }', 'utf-8');
      assert.throws(
        () => migrate(badPath, { agents: [] }),
        /Invalid JSON/
      );
    });
  });

  // ─── 9. Agent with empty defaultDiaries ────────────────────────────
  it('handles agent with empty defaultDiaries', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { TestAgent: { maid: 'Test', defaultDiaries: [], allowedDiaries: ['A'] } },
      });

      const { result } = migrate(configPath, { agents: [] });
      const rule = result.agents.TestAgent.profiles['test-agent-default'].rules[0];
      assert.deepStrictEqual(rule.diaries, []);
    });
  });

  // ─── 10. Agent with no defaultDiaries field ────────────────────────
  it('treats missing defaultDiaries as empty array', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { TestAgent: { maid: 'Test', allowedDiaries: ['A'] } },
      });

      const { result } = migrate(configPath, { agents: [] });
      const rule = result.agents.TestAgent.profiles['test-agent-default'].rules[0];
      assert.deepStrictEqual(rule.diaries, []);
    });
  });

  // ─── 11. Output format verification ────────────────────────────────
  it('produces correct recall_profiles.json structure', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { Alpha: { maid: 'A', defaultDiaries: ['D1', 'D2'], allowedDiaries: ['D1', 'D2'] } },
      });

      const { result } = migrate(configPath, { agents: [] });
      assert.ok(result.agents.Alpha);
      assert.strictEqual(result.agents.Alpha.defaultProfile, 'alpha-default');
      assert.ok(result.agents.Alpha.profiles['alpha-default']);
      assert.ok(Array.isArray(result.agents.Alpha.profiles['alpha-default'].rules));
      assert.strictEqual(result.agents.Alpha.profiles['alpha-default'].rules.length, 1);
    });
  });

  // ─── 12. Modifiers all disabled ────────────────────────────────────
  it('disables all modifiers by default', () => {
    const profile = generateProfileForAgent('Any', { defaultDiaries: ['D'] });
    const rule = profile.profiles['any-default'].rules[0];
    for (const mod of ALL_MODIFIERS) {
      assert.strictEqual(rule.modifiers[mod], false, `modifier ${mod} should be false`);
    }
  });

  // ─── 13. Default profile name generation ───────────────────────────
  it('generates kebab-case profile names', () => {
    assert.strictEqual(toKebabCase('Nexus'), 'nexus');
    assert.strictEqual(toKebabCase('MCPMidas'), 'mcpmidas');
    assert.strictEqual(toKebabCase('SomeAgentName'), 'some-agent-name');
    assert.strictEqual(toKebabCase('Hello World'), 'hello-world');
    assert.strictEqual(toKebabCase('snake_case'), 'snake-case');

    const p1 = generateProfileForAgent('MCPMidas', { defaultDiaries: ['D'] });
    assert.strictEqual(p1.defaultProfile, 'mcpmidas-default');

    const p2 = generateProfileForAgent('MyAgent_v2', { defaultDiaries: ['D'] });
    assert.strictEqual(p2.defaultProfile, 'my-agent-v2-default');
  });

  // ─── 14. Multiple --agent filters ──────────────────────────────────
  it('filters to multiple specified agents', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: {
          A: { maid: 'A', defaultDiaries: ['a'], allowedDiaries: ['a'] },
          B: { maid: 'B', defaultDiaries: ['b'], allowedDiaries: ['b'] },
          C: { maid: 'C', defaultDiaries: ['c'], allowedDiaries: ['c'] },
        },
      });

      const { result } = migrate(configPath, { agents: ['A', 'C'] });
      assert.strictEqual(Object.keys(result.agents).length, 2);
      assert.ok(result.agents.A);
      assert.ok(result.agents.C);
      assert.strictEqual(result.agents.B, undefined);
    });
  });

  // ─── 15. Reports contain readable agent summary ────────────────────
  it('produces human-readable migration reports', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, {
        agents: { X: { maid: 'M', defaultDiaries: ['D1'], allowedDiaries: ['D1', 'D2'] } },
      });

      const { reports } = migrate(configPath, { agents: [] });
      assert.strictEqual(reports.length, 1);
      const report = reports[0];
      assert.ok(report.includes('Agent: X'));
      assert.ok(report.includes('maid:'));
      assert.ok(report.includes('D1'));
      assert.ok(report.includes('x-default'));
    });
  });

  // ─── 16. parseArgs defaults ────────────────────────────────────────
  it('parseArgs defaults to dry-run', () => {
    const args = parseArgs(['node', 'script.js']);
    assert.strictEqual(args.dryRun, true);
    assert.strictEqual(args.write, false);
    assert.deepStrictEqual(args.agents, []);
  });

  it('parseArgs parses --write', () => {
    const args = parseArgs(['node', 'script.js', '--write']);
    assert.strictEqual(args.write, true);
    assert.strictEqual(args.dryRun, false);
  });

  it('parseArgs parses --agent', () => {
    const args = parseArgs(['node', 'script.js', '--agent', 'Nexus', '--agent', 'Yui']);
    assert.deepStrictEqual(args.agents, ['Nexus', 'Yui']);
  });

  // ─── 17. Unexpected config structure ───────────────────────────────
  it('throws when config lacks agents object', () => {
    withTempDir((tmpDir) => {
      const configPath = writeConfig(tmpDir, { version: '1.0' });
      assert.throws(
        () => migrate(configPath, { agents: [] }),
        /Unexpected config structure/
      );
    });
  });

  // ─── 18. RECOMMENDED_MODIFIERS present in _meta ────────────────────
  it('includes recommended modifiers in _meta', () => {
    const profile = generateProfileForAgent('Any', { defaultDiaries: ['D'] });
    const meta = profile.profiles['any-default'].rules[0]._meta;
    assert.ok(Array.isArray(meta.recommendedModifiers));
    assert.deepStrictEqual(meta.recommendedModifiers, RECOMMENDED_MODIFIERS);
  });
});
