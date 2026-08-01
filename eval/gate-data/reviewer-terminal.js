#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const reviewer = require('./reviewer');

function parseArgs(argv) {
    const flags = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (token === '--help' || token === '-h') { flags.help = true; continue; }
        if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
        flags[name] = value;
        index++;
    }
    return flags;
}

function defaultOutput(input) {
    return path.resolve(input).replace(/\.jsonl$/iu, '.reviewed.jsonl');
}

function defaultProgress(input) {
    return `${path.resolve(input)}.progress.json`;
}

function loadProgress(progressPath, meta, rows) {
    if (!fs.existsSync(progressPath)) return { decisions: {}, index: 0 };
    const saved = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    if (saved.schemaVersion !== 1 || saved.datasetHash !== meta.datasetHash) {
        throw new Error(`progress file belongs to another dataset: ${progressPath}`);
    }
    const caseIds = new Set(rows.map(row => row.caseId));
    const decisions = Object.fromEntries(Object.entries(saved.decisions || {})
        .filter(([caseId, decision]) => caseIds.has(caseId) && reviewer.LABELS.has(decision?.label)));
    return {
        decisions,
        index: Math.max(0, Math.min(Number(saved.index) || 0, Math.max(0, rows.length - 1)))
    };
}

function saveProgress(progressPath, meta, decisions, index) {
    const absolute = path.resolve(progressPath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 1,
        datasetHash: meta.datasetHash,
        updatedAt: new Date().toISOString(),
        index,
        decisions
    }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, absolute);
}

function help() {
    return `VCP Gate SSH 终端审阅器

用法：
  node eval/gate-data/reviewer-terminal.js \\
    --input <review.jsonl> --reviewer <真实审阅者ID> [--output <reviewed.jsonl>]

命令：
  p / n / a       标为 positive / negative / ambiguous，并前进
  c               接受候选标签，并前进（仍代表你亲自确认）
  group           展示当前 intentGroup 的全部等义改写
  gp/gn/ga/gc     审阅整组后，将组内全部改写标为同一标签
  b / next        上一条 / 下一条
  u               跳到下一条未审样本
  note <文本>     给当前样本添加或替换备注
  show            切换来源正文的精简/完整显示
  goto <序号>     跳到指定序号（从 1 开始）
  export          全部完成后输入人工声明并导出
  q               保存进度并退出
`;
}

function groupRows(rows, row) {
    if (!row?.intentGroup) return [row].filter(Boolean);
    return rows.filter(candidate => candidate.targetType === row.targetType
        && candidate.library === row.library
        && candidate.intentGroup === row.intentGroup);
}

function question(rl, prompt) {
    return new Promise(resolve => rl.question(prompt, answer => resolve(answer)));
}

async function run(flags) {
    if (flags.help) { process.stdout.write(help()); return 0; }
    if (!flags.input) throw new Error('--input is required');
    if (!flags.reviewer) throw new Error('--reviewer is required and must identify the actual human reviewer');
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('terminal reviewer requires an interactive TTY/SSH session');

    const input = path.resolve(flags.input);
    const output = path.resolve(flags.output || defaultOutput(input));
    const progressPath = path.resolve(flags.progress || defaultProgress(input));
    if (output === input) throw new Error('output must not overwrite the review template');
    const loaded = reviewer.parseJsonl(fs.readFileSync(input, 'utf8'));
    const progress = loadProgress(progressPath, loaded.meta, loaded.rows);
    const decisions = progress.decisions;
    let index = progress.index;
    let expanded = false;
    let groupExpanded = false;
    let closed = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    const completeCount = () => loaded.rows.filter(row => reviewer.LABELS.has(decisions[row.caseId]?.label)).length;
    const persist = () => saveProgress(progressPath, loaded.meta, decisions, index);
    const current = () => loaded.rows[index];
    const move = delta => { index = Math.max(0, Math.min(index + delta, loaded.rows.length - 1)); };
    const nextPending = () => {
        const offset = loaded.rows.slice(index + 1).findIndex(row => !reviewer.LABELS.has(decisions[row.caseId]?.label));
        if (offset >= 0) index += offset + 1;
        else {
            const first = loaded.rows.findIndex(row => !reviewer.LABELS.has(decisions[row.caseId]?.label));
            if (first >= 0) index = first;
        }
    };
    const sourceText = row => (row.sourceRefs || []).map(ref => {
        const text = loaded.meta.sourceContexts?.[ref] || '（分片未内嵌正文，请打开原始引用核对。）';
        const limit = expanded ? 6000 : Math.max(400, Number(flags['context-chars']) || 2200);
        return `【${ref}】\n${text.length > limit ? `${text.slice(0, limit)}\n…（输入 show 展开）` : text}`;
    }).join('\n\n');
    const render = () => {
        if (flags['no-clear'] !== 'true') process.stdout.write('\x1b[2J\x1b[H');
        const row = current();
        const decision = decisions[row.caseId];
        const grouped = groupRows(loaded.rows, row);
        const groupSummary = grouped.reduce((counts, item) => {
            const label = decisions[item.caseId]?.label || 'pending';
            counts[label] = (counts[label] || 0) + 1;
            return counts;
        }, {});
        const groupSection = groupExpanded ? [
            '',
            `INTENT GROUP ${row.intentGroup || '(none)'} · ${grouped.length} 条`,
            ...grouped.map((item, groupIndex) => `${groupIndex + 1}. [${decisions[item.caseId]?.label || 'pending'}] ${item.query}`)
        ] : [];
        process.stdout.write([
            `VCP Gate 人工审阅  ${index + 1}/${loaded.rows.length}  已完成 ${completeCount()}/${loaded.rows.length}`,
            `dataset: ${loaded.meta.datasetHash}`,
            `case: ${row.caseId}`,
            `target: ${row.targetType}:${row.library}`,
            `candidate: ${row.candidateLabel}  difficulty: ${row.difficulty}  current: ${decision?.label || '未选择'}`,
            '',
            `QUERY\n${row.query}`,
            ...groupSection,
            '',
            `SOURCE\n${sourceText(row)}`,
            '',
            `notes: ${decision?.notes || '无'}`,
            '',
            '[p]positive [n]negative [a]ambiguous [c]确认候选 [b]上一条 [next]下一条',
            `[group]查看组(${JSON.stringify(groupSummary)}) [gp/gn/ga/gc]整组确认`,
            '[u]下一未审 [note 文本]备注 [show]展开 [goto N]跳转 [export]导出 [q]退出',
            ''
        ].join('\n'));
    };

    const finish = () => {
        if (closed) return;
        closed = true;
        persist();
        rl.close();
    };
    process.once('SIGINT', () => { process.stdout.write('\n已保存进度。\n'); finish(); });

    try {
        for (;;) {
            render();
            const raw = (await question(rl, '> ')).trim();
            const [command, ...rest] = raw.split(/\s+/u);
            if (['p', 'n', 'a', 'c'].includes(command)) {
                const label = command === 'p' ? 'positive'
                    : command === 'n' ? 'negative'
                        : command === 'a' ? 'ambiguous' : current().candidateLabel;
                decisions[current().caseId] = { ...decisions[current().caseId], label };
                if (index < loaded.rows.length - 1) move(1);
                persist();
            } else if (['gp', 'gn', 'ga', 'gc'].includes(command)) {
                const grouped = groupRows(loaded.rows, current());
                const candidateLabels = new Set(grouped.map(row => row.candidateLabel));
                if (command === 'gc' && candidateLabels.size !== 1) {
                    process.stdout.write('\n该组候选标签不一致，不能使用 gc；请用 gp/gn/ga 明确选择。按回车继续。');
                    await question(rl, '');
                    continue;
                }
                const label = command === 'gp' ? 'positive'
                    : command === 'gn' ? 'negative'
                        : command === 'ga' ? 'ambiguous' : current().candidateLabel;
                for (const row of grouped) decisions[row.caseId] = { ...decisions[row.caseId], label };
                groupExpanded = false;
                nextPending();
                persist();
            } else if (command === 'b') {
                move(-1);
            } else if (command === 'next' || command === '') {
                move(1);
            } else if (command === 'u') {
                nextPending();
            } else if (command === 'show') {
                expanded = !expanded;
            } else if (command === 'group') {
                groupExpanded = !groupExpanded;
            } else if (command === 'goto') {
                const requested = Number(rest[0]);
                if (Number.isInteger(requested) && requested >= 1 && requested <= loaded.rows.length) index = requested - 1;
            } else if (command === 'note') {
                decisions[current().caseId] = { ...decisions[current().caseId], notes: rest.join(' ') };
                persist();
            } else if (command === 'export') {
                if (completeCount() !== loaded.rows.length) {
                    process.stdout.write(`\n仍有 ${loaded.rows.length - completeCount()} 条未完成。按回车继续。`);
                    await question(rl, '');
                    continue;
                }
                process.stdout.write(`\n请亲自键入完全一致的声明：\n${reviewer.ATTESTATION}\n`);
                const attestation = await question(rl, 'attestation> ');
                const text = reviewer.buildJsonl(
                    loaded.meta, loaded.rows, decisions, flags.reviewer, attestation, new Date().toISOString()
                );
                fs.mkdirSync(path.dirname(output), { recursive: true });
                fs.writeFileSync(output, text, { mode: 0o600 });
                process.stdout.write(`\n已导出：${output}\n进度文件保留在：${progressPath}\n`);
                finish();
                return 0;
            } else if (command === 'q') {
                process.stdout.write('\n已保存进度。\n');
                finish();
                return 0;
            }
        }
    } finally {
        finish();
    }
}

if (require.main === module) {
    let flags;
    try { flags = parseArgs(process.argv.slice(2)); } catch (error) {
        process.stderr.write(`${error.message}\n\n${help()}`);
        process.exitCode = 1;
    }
    if (flags) run(flags).then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, defaultOutput, defaultProgress, loadProgress, saveProgress, groupRows, help, run };
