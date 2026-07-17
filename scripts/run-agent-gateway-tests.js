#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const AGENT_GATEWAY_TEST_DIR = path.join(ROOT_DIR, 'tests', 'agent-gateway');
const MILESTONE_DIR_PATTERN = /^s0[1-5]$/;

function collectFiles(directoryPath, predicate) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    const files = [];

    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(entryPath, predicate));
        } else if (entry.isFile() && predicate(entry.name)) {
            files.push(entryPath);
        }
    }

    return files;
}

function collectAgentGatewayTests() {
    const testFiles = collectFiles(AGENT_GATEWAY_TEST_DIR, (name) => name.endsWith('.test.js'));
    const testsDir = path.join(ROOT_DIR, 'tests');
    const milestoneDirectories = fs.readdirSync(testsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && MILESTONE_DIR_PATTERN.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));

    for (const milestoneDirectory of milestoneDirectories) {
        testFiles.push(...collectFiles(
            path.join(testsDir, milestoneDirectory.name),
            (name) => name.startsWith('test-') && name.endsWith('.js')
        ));
    }

    return testFiles.sort((left, right) => left.localeCompare(right));
}

function hasConcurrencyArgument(args) {
    return args.some((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
}

function main() {
    const testFiles = collectAgentGatewayTests();
    if (testFiles.length === 0) {
        throw new Error('No Agent Gateway test files were found.');
    }

    const forwardedArgs = process.argv.slice(2);
    const nodeArgs = ['--test'];
    if (!hasConcurrencyArgument(forwardedArgs)) {
        nodeArgs.push('--test-concurrency=1');
    }
    nodeArgs.push(...forwardedArgs, ...testFiles);

    process.stdout.write([
        `[AgentGatewayTests] Node ${process.version}`,
        `[AgentGatewayTests] Files ${testFiles.length}`,
        `[AgentGatewayTests] Concurrency ${hasConcurrencyArgument(forwardedArgs) ? 'custom' : '1 (baseline)'}`
    ].join('\n') + '\n');

    const startedAt = process.hrtime.bigint();
    const reportPath = process.env.AGENT_GATEWAY_TEST_REPORT
        ? path.resolve(ROOT_DIR, process.env.AGENT_GATEWAY_TEST_REPORT)
        : '';
    const result = spawnSync(process.execPath, nodeArgs, {
        cwd: ROOT_DIR,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.stdout.write(`[AgentGatewayTests] Elapsed ${durationMs.toFixed(1)}ms\n`);
    if (reportPath) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, `${result.stdout || ''}${result.stderr || ''}`, 'utf8');
        process.stdout.write(`[AgentGatewayTests] Report ${path.relative(ROOT_DIR, reportPath)}\n`);
    }
    if (result.error) {
        throw result.error;
    }
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
}

try {
    main();
} catch (error) {
    process.stderr.write(`[AgentGatewayTests] ${error.stack || error.message}\n`);
    process.exitCode = 1;
}
