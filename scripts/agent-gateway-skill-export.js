#!/usr/bin/env node

'use strict';

/**
 * L3 skill artifact CLI export（§6 / M4.S1.T4）。
 *
 * 离线生成单个 agent 单个/全部 format 的 skill 文件到本地目录。
 * 与在线 endpoint 消费同一 canonical guidance service 与生成器，
 * 生成物零 secret。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { getGatewayServiceBundle } = require('../modules/agentGateway/createGatewayServiceBundle');
const {
    SKILL_FORMATS,
    generateSkillArtifact,
    validatePublicBaseUrl
} = require('../modules/agentGateway/services/skillGeneratorService');
const { createPluginManager } = require('../tests/agent-gateway/helpers/agent-gateway-test-helpers');

function printUsage() {
    process.stdout.write(`Agent Gateway skill export CLI

Usage:
  node scripts/agent-gateway-skill-export.js --agent <agentId> --out <dir> \\
      [--format claude|codex|kimi|all] [--base-url <url>]

Environment:
  AGENT_GATEWAY_PUBLIC_BASE_URL    Public base URL (required unless --base-url)
  AGENT_GATEWAY_GUIDANCE_CONFIG_PATH  Guidance config path

Notes:
  - Generated files contain endpoints and tool guidance only; never tokens.
  - Formats: ${SKILL_FORMATS.join(', ')} (default: all)
`);
}

function parseArgs(argv) {
    const parsed = { agentId: '', outDir: '', format: 'all', baseUrl: '', help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help') {
            parsed.help = true;
            continue;
        }
        const nextValue = argv[index + 1];
        if (!nextValue) throw new Error(`Missing value for ${argument}`);
        if (argument === '--agent') { parsed.agentId = nextValue.trim(); index += 1; continue; }
        if (argument === '--out') { parsed.outDir = nextValue.trim(); index += 1; continue; }
        if (argument === '--format') { parsed.format = nextValue.trim(); index += 1; continue; }
        if (argument === '--base-url') { parsed.baseUrl = nextValue.trim(); index += 1; continue; }
        throw new Error(`Unsupported argument: ${argument}`);
    }
    return parsed;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        printUsage();
        return 0;
    }
    if (!options.agentId || !options.outDir) {
        printUsage();
        process.stderr.write('\n--agent and --out are required\n');
        return 1;
    }
    const formats = options.format === 'all' ? [...SKILL_FORMATS] : [options.format];

    const baseUrlValidation = validatePublicBaseUrl(
        options.baseUrl || process.env.AGENT_GATEWAY_PUBLIC_BASE_URL,
        { allowInsecure: process.env.AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE === 'true' }
    );
    if (!baseUrlValidation.ok) {
        process.stderr.write(`${baseUrlValidation.reason}\n`);
        return 1;
    }

    const pluginManager = createPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const guidanceResult = await bundle.agentGuidanceService.getAgentGuidance(options.agentId);
    if (!guidanceResult.ok) {
        process.stderr.write(`Failed to resolve guidance for "${options.agentId}": ${guidanceResult.reason}\n`);
        return 1;
    }

    for (const format of formats) {
        const artifact = generateSkillArtifact({
            guidance: guidanceResult.guidance,
            format,
            baseUrl: baseUrlValidation.baseUrl
        });
        if (!artifact.ok) {
            process.stderr.write(`Failed to generate ${format} skill: ${artifact.reason}\n`);
            return 1;
        }
        const formatDir = path.join(options.outDir, options.agentId, format);
        await fs.mkdir(formatDir, { recursive: true });
        for (const file of artifact.files) {
            // 文件清单来自固定模板，不含用户输入 path
            await fs.writeFile(path.join(formatDir, file.path), file.content, 'utf8');
        }
        process.stdout.write(`Wrote ${artifact.files.length} files to ${formatDir} (${artifact.manifest.contentHash})\n`);
    }
    return 0;
}

if (require.main === module) {
    main().then((exitCode) => process.exit(exitCode)).catch((error) => {
        process.stderr.write(`${error.message || String(error)}\n`);
        process.exit(1);
    });
}

module.exports = { main, parseArgs };
