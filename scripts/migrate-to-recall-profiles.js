#!/usr/bin/env node
/**
 * migrate-to-recall-profiles.js
 * 将 mcp_agent_memory_policy.json 中的 defaultDiaries 配置迁移为 recall_profiles.json 结构
 *
 * CLI:
 *   node scripts/migrate-to-recall-profiles.js [--dry-run] [--write] [--agent <name>]
 *
 * 默认 --dry-run：仅输出迁移报告，不写文件
 *   --write       ：写入 recall_profiles.json.suggested
 *   --agent <name>：仅迁移指定 agent（可多次使用）
 */

const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '..', 'modules', 'agentGateway', 'config', 'mcp_agent_memory_policy.json');
const OUTPUT_FILENAME = 'recall_profiles.json.suggested';

const ALL_MODIFIERS = [
  'time',
  'group',
  'rerank',
  'tagMemo',
  'timeDecay',
  'truncate',
  'aiMemo',
  'roleValve',
  'base64Memo',
];

const RECOMMENDED_MODIFIERS = ['time', 'group', 'rerank'];

function toKebabCase(str) {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function makeDefaultModifiers() {
  const modifiers = {};
  for (const key of ALL_MODIFIERS) {
    modifiers[key] = false;
  }
  return modifiers;
}

function generateProfileForAgent(agentName, agentConfig) {
  const defaultDiaries = Array.isArray(agentConfig.defaultDiaries)
    ? agentConfig.defaultDiaries
    : [];

  const profileName = `${toKebabCase(agentName)}-default`;

  const rules = [
    {
      baseMode: 'rag',
      targets: {
        diaries: defaultDiaries,
        ...(defaultDiaries.length > 1 ? { aggregate: true } : {}),
        kMultiplier: 1.0,
      },
      projection: {
        emit: 'recall_blocks',
      },
      modifiers: makeDefaultModifiers(),
      _meta: {
        source: 'migrated from mcp_agent_memory_policy.json defaultDiaries',
        recommendedModifiers: RECOMMENDED_MODIFIERS,
        note:
          'Modifiers are disabled by default. ' +
          `Consider enabling: ${RECOMMENDED_MODIFIERS.join(', ')}. ` +
          'Use DSL compiler to express advanced recall strategies.',
      },
    },
  ];

  return {
    defaultProfile: profileName,
    profileName,
    profile: { rules },
  };
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    write: false,
    agents: [],
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
      args.write = false;
    } else if (arg === '--write') {
      args.write = true;
      args.dryRun = false;
    } else if (arg === '--agent') {
      i++;
      if (i < argv.length) {
        args.agents.push(argv[i]);
      }
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/migrate-to-recall-profiles.js [options]

Options:
  --dry-run          Print migration report without writing files (default)
  --write            Write output to ${OUTPUT_FILENAME}
  --agent <name>     Migrate only the specified agent (repeatable)
  --help, -h         Show this help
`);
}

function readSourceConfig(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Source config not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${inputPath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.agents || typeof parsed.agents !== 'object') {
    throw new Error(`Unexpected config structure: missing "agents" object in ${inputPath}`);
  }

  return parsed;
}

function buildMigrationReport(agentName, profile, agentConfig) {
  const defaultDiaries = agentConfig.defaultDiaries || [];
  const allowedDiaries = agentConfig.allowedDiaries || [];
  const profileName = profile.defaultProfile;
  const rules = profile.profile.rules;

  const lines = [
    `┌────────────────────────────────────────────────────────────`,
    `│ Agent: ${agentName}`,
    `├────────────────────────────────────────────────────────────`,
    `│ Current Config:`,
    `│   maid:            ${agentConfig.maid || '(none)'}`,
    `│   defaultDiaries:  ${defaultDiaries.length > 0 ? defaultDiaries.join(', ') : '(none)'}`,
    `│   allowedDiaries:  ${allowedDiaries.length > 0 ? allowedDiaries.join(', ') : '(none)'}`,
    `├────────────────────────────────────────────────────────────`,
    `│ Recommended Profile: "${profileName}"`,
    `│ Rules:`,
  ];

  for (const rule of rules) {
    lines.push(`│   - baseMode: ${rule.baseMode}`);
    lines.push(`│     diaries: [${rule.targets.diaries.map(d => `"${d}"`).join(', ')}]`);
    lines.push(`│     aggregate: ${rule.targets.aggregate === true ? 'true' : 'false'}`);
    const enabledMods = Object.entries(rule.modifiers)
      .filter(([, v]) => v)
      .map(([k]) => k);
    lines.push(`│     modifiers enabled: ${enabledMods.length > 0 ? enabledMods.join(', ') : '(none)'}`);
    if (rule._meta?.recommendedModifiers?.length) {
      lines.push(`│     recommended to enable: ${rule._meta.recommendedModifiers.join(', ')}`);
    }
  }

  lines.push(`└────────────────────────────────────────────────────────────`);
  return lines.join('\n');
}

function migrate(inputPath, options = {}) {
  const { agents: filterAgents } = options;
  const source = readSourceConfig(inputPath);

  const result = { agents: {}, profiles: {} };
  const reports = [];
  const warnings = [];

  const agentNames = Object.keys(source.agents);
  for (const agentName of agentNames) {
    if (filterAgents.length > 0 && !filterAgents.includes(agentName)) {
      continue;
    }

    const agentConfig = source.agents[agentName];
    if (!agentConfig) {
      warnings.push(`Agent "${agentName}" has null/undefined config; skipping.`);
      continue;
    }

    const profile = generateProfileForAgent(agentName, agentConfig);
    const defaultDiaries = Array.isArray(agentConfig.defaultDiaries) ? agentConfig.defaultDiaries : [];
    const allowedDiaries = Array.isArray(agentConfig.allowedDiaries) ? agentConfig.allowedDiaries : [];
    const targets = allowedDiaries.length > 0 ? allowedDiaries : defaultDiaries;

    result.agents[agentName] = {
      defaultProfile: profile.defaultProfile,
      allowedProfiles: [profile.defaultProfile],
      ...(targets.length > 0 ? { targets } : {}),
    };
    result.profiles[profile.profileName] = profile.profile;
    reports.push(buildMigrationReport(agentName, profile, agentConfig));
  }

  return { result, reports, warnings };
}

function main(argv) {
  const args = parseArgs(argv);
  const inputPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH || INPUT_PATH;
  const outputPath = path.join(path.dirname(inputPath), OUTPUT_FILENAME);

  try {
    const { result, reports, warnings } = migrate(inputPath, {
      agents: args.agents,
    });

    const migratedCount = Object.keys(result.agents).length;

    console.log(`Migration Report (${migratedCount} agent(s))`);
    console.log(`Source: ${path.resolve(inputPath)}`);
    console.log(`Mode:   ${args.write ? 'WRITE' : 'DRY-RUN'}`);
    if (args.agents.length > 0) {
      console.log(`Filter: ${args.agents.join(', ')}`);
    }
    console.log('');

    for (const report of reports) {
      console.log(report);
      console.log('');
    }

    if (warnings.length > 0) {
      console.log('Warnings:');
      for (const w of warnings) {
        console.log(`  ⚠ ${w}`);
      }
      console.log('');
    }

    if (args.write) {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');
      console.log(`✅ Written to: ${path.resolve(outputPath)}`);
    } else {
      console.log('💡 Use --write to persist the output.');
    }

    return { migratedCount, outputPath: args.write ? outputPath : null };
  } catch (err) {
    console.error(`❌ Migration failed: ${err.message}`);
    process.exitCode = 1;
    return { error: err.message };
  }
}

// Export for tests and programmatic use
module.exports = {
  migrate,
  generateProfileForAgent,
  readSourceConfig,
  parseArgs,
  ALL_MODIFIERS,
  RECOMMENDED_MODIFIERS,
  toKebabCase,
};

// CLI entry
if (require.main === module) {
  main(process.argv);
}
