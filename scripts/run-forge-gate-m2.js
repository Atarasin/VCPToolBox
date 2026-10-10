'use strict';

/**
 * M2 里程碑门禁脚本：真实小领域（配色理论）完整跑一遍
 * 采集（真实 AnySearch 插件）→ 提炼（真实 LLM）→ 入库（真实 TDB watcher+embedding）→ 可检索。
 *
 * 用法（在仓库根、配好 config.env 的环境）：
 *   node scripts/run-forge-gate-m2.js
 *
 * 说明：
 * - 搜索经子进程直调 Plugin/AnySearch/AnySearch.js 的 stdio JSON 协议
 *   （真实插件代码与真实网络检索；插件桥接层由生产链路覆盖）；
 * - LLM 用 config.env 的 API_URL/API_Key（模型 gemini-2.5-flash），密钥只进
 *   进程内存，不落任何文件；
 * - TDB 用真实单例（watcher + TriviumDB + 真实 embedding）；
 * - synthesize/trial 属 M3/M4，本门禁止步于 distill 完成（job 终态 failed 且
 *   错误步为 synthesize 即符合预期）。
 */

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

process.env.FORGE_LLM_URL = process.env.API_URL || '';
process.env.FORGE_LLM_API = process.env.API_Key || process.env.APIKey || '';
process.env.FORGE_LLM_MODEL = process.env.FORGE_GATE_MODEL || 'gemini-2.5-flash';

const ROOT = path.join(__dirname, '..');
const GATE_BLUEPRINT = {
    name: 'ColorTheoryExpert',
    displayName: '配色理论看门专家',
    scope: {
        responsibilities: ['UI 配色方案建议'],
        boundaries: ['不做前端实现']
    },
    subskills: [
        {
            id: 'color-theory',
            title: '配色理论',
            searchQueries: ['color theory UI design', '配色理论 界面设计'],
            sourceHints: ['官方文档优先']
        }
    ],
    sourcePolicy: {
        preferOfficialDocs: true,
        minDomainsPerSubskill: 3,
        qualityFilter: '丢弃营销软文/无实质内容/严重过时内容'
    },
    examOutline: [
        { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
    ],
    practicalExam: {
        prompt: '为一个 SaaS 落地页给出配色方案',
        gradingDimensions: ['眼前一亮', '去 AI 味', '可落地']
    },
    acceptanceSample: '能给出有依据的配色方案'
};

function invokeAnySearch(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'Plugin', 'AnySearch', 'AnySearch.js')], {
            cwd: path.join(ROOT, 'Plugin', 'AnySearch'),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('AnySearch timeout (60s)'));
        }, 60000);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', () => {
            clearTimeout(timer);
            try {
                const payload = JSON.parse(stdout.trim().split('\n').pop());
                if (payload.status === 'success') {
                    resolve(payload.result);
                } else {
                    reject(new Error(payload.error || 'AnySearch error'));
                }
            } catch (error) {
                reject(new Error(`AnySearch 输出不可解析：${stdout.slice(0, 200)} / ${stderr.slice(0, 200)}`));
            }
        });
        child.stdin.write(`${JSON.stringify({ command: 'search', ...args })}\n`);
        child.stdin.end();
    });
}

async function main() {
    if (!process.env.FORGE_LLM_URL || !process.env.FORGE_LLM_API) {
        throw new Error('config.env 缺少 API_URL/API_Key，无法运行门禁');
    }

    console.log('[gate] 初始化 TDB（真实 watcher + embedding）…');
    const tdb = require(path.join(ROOT, 'TDBKnowledge'));
    await tdb.initialize();

    // 门禁是单进程冷启动：TDB 初始扫描会排队全部既有库文件（去重检查耗时），
    // 若不排空就发起 job，新知识文件的索引会排在 255 个初始扫描文件之后，
    // 挤占 distill 冒烟验证的窗口（生产 watcher 常驻无此竞态）。
    // 此处轮询持久化 ingest_queue 直到排空。
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    await (async () => {
        const queuePath = path.join(ROOT, 'VectorStoreTDB', 'tdb_knowledge_meta.sqlite');
        for (let attempt = 0; attempt < 60; attempt += 1) {
            let pending = 0;
            try {
                const db = new Database(queuePath, { readonly: true });
                pending = db.prepare("SELECT COUNT(*) AS n FROM ingest_queue WHERE status IN ('pending','retrying','running')").get().n;
                db.close();
            } catch {
                pending = -1; // 库尚未创建
            }
            if (pending === 0) {
                console.log('[gate] TDB 初始扫描队列已排空');
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('等待 TDB 初始扫描排空超时（120s）');
    })();

    const { createJobRuntimeService } = require(path.join(ROOT, 'modules', 'agentGateway', 'services', 'jobRuntimeService'));
    const { createForgeRuntimeService } = require(path.join(ROOT, 'modules', 'agentGateway', 'services', 'forge', 'service'));
    const { scanTextForSecrets } = require(path.join(ROOT, 'modules', 'agentGateway', 'services', 'forge', 'secretScan'));

    const axios = require(path.join(ROOT, 'node_modules', 'axios'));
    const jobRuntimeService = createJobRuntimeService();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: {
            available: true,
            async complete(config, payload) {
                const response = await axios.post(`${config.url.replace(/\/$/, '')}/v1/chat/completions`, payload, {
                    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
                    timeout: 120000
                });
                return response;
            }
        },
        toolInvokerPort: {
            invoke: async (toolName, args) => {
                if (toolName !== 'AnySearch') {
                    throw new Error(`门禁只接 AnySearch，收到 ${toolName}`);
                }
                const result = await invokeAnySearch(args);
                return result; // { content: [{ type: 'text', text }] }
            }
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: () => tdb.listLibraries(),
            search: (query, options) => tdb.search(query, options)
        },
        baseDir: path.join(ROOT, 'Agent', 'forge'),
        llmConfig: {
            url: process.env.FORGE_LLM_URL,
            apiKey: process.env.FORGE_LLM_API,
            model: process.env.FORGE_LLM_MODEL
        }
    });

    console.log('[gate] 发起 forge.expert.create（配色理论小领域）…');
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个配色理论专家',
        blueprintOverride: GATE_BLUEPRINT,
        budgetCny: 5
    });

    const waitFor = async (predicate, label, timeoutMs = 300000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const job = jobRuntimeService.pollJob(jobId, null).data.job;
            if (predicate(job)) {
                return job;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(`等待超时：${label}`);
    };

    let job = await waitFor((j) => j.status === 'pending_confirm', 'blueprint 门禁');
    console.log(`[gate] 画像已生成（专家：${job.metadata.forge.expertName}），确认继续…`);
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });

    job = await waitFor((j) => j.terminal, 'harvest+distill 完成（止步于 synthesize 桩）');
    const forge = job.metadata.forge;
    console.log(`[gate] job 终态：${job.status}，失败步：${forge.error?.step || '无'}`);
    if (job.status !== 'failed' || forge.error?.step !== 'synthesize') {
        throw new Error(`门禁失败：期望止步于 synthesize 待接入桩，实际 ${job.status} @ ${forge.error?.step}（${forge.error?.message}）`);
    }

    const steps = Object.fromEntries((forge.steps || []).map((step) => [step.id, step]));
    console.log(`[gate] harvest：${steps.harvest?.summary}`);
    console.log(`[gate] distill：${steps.distill?.summary}`);

    // ── 检查点 1：原始材料 ≥3 域名 + 元数据 ──
    const rawDir = path.join(ROOT, 'Agent', 'forge', 'runs', jobId, 'raw', 'color-theory');
    const manifest = JSON.parse(fs.readFileSync(path.join(rawDir, 'manifest.json'), 'utf8'));
    console.log(`[gate] 材料域名：${manifest.domains.join(', ')}`);
    if (manifest.materials < 3 || manifest.domains.length < 3) {
        throw new Error(`门禁失败：材料/域名不足（${manifest.materials} 份 / ${manifest.domains.length} 域名）`);
    }
    for (const file of fs.readdirSync(rawDir).filter((f) => f.endsWith('.meta.json'))) {
        const meta = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
        if (!meta.url || !meta.fetchedAt || !meta.contentHash?.startsWith('sha256:') || !meta.plugin) {
            throw new Error(`门禁失败：材料元数据不完整（${file}）`);
        }
    }

    // ── 检查点 2：知识文件分流 + 出处 frontmatter ──
    const libDir = path.join(ROOT, 'knowledge', 'ColorTheoryExpert知识库');
    const libFiles = fs.readdirSync(libDir);
    const cards = libFiles.filter((f) => f.startsWith('K_'));
    const longDocs = libFiles.filter((f) => /^\d{2}_/.test(f));
    console.log(`[gate] 知识库文件：${libFiles.join(', ')}`);
    if (cards.length + longDocs.length === 0) {
        throw new Error('门禁失败：知识库无文件');
    }
    for (const card of cards) {
        const raw = fs.readFileSync(path.join(libDir, card), 'utf8');
        if (!/sourceUrls|sources:/.test(raw) || !/url: https?:\/\//.test(raw) || !/fetchedAt:/.test(raw)) {
            throw new Error(`门禁失败：知识卡缺出处（${card}）`);
        }
    }

    // ── 检查点 3：零密钥扫描 ──
    for (const file of libFiles) {
        const hits = scanTextForSecrets(fs.readFileSync(path.join(libDir, file), 'utf8'));
        if (hits.length > 0) {
            throw new Error(`门禁失败：知识文件疑似密钥（${file}）`);
        }
    }

    // ── 检查点 4：TDB 可检索（真实 watcher 已索引；embedding 延迟可达分钟级，脚本侧等待）──
    const detail = await forgeRuntimeService.getJobDetail(jobId);
    console.log('[gate] distill 冒烟结果：', JSON.stringify(steps.distill));
    if (detail.cost) {
        console.log(`[gate] 费用：${detail.cost.costSoFarCny} / ${detail.cost.budgetCny} 元`);
    }

    let searchHits = 0;
    for (let attempt = 1; attempt <= 25; attempt += 1) {
        try {
            const hits = await tdb.search('color theory UI design', { libraries: ['ColorTheoryExpert知识库'], topK: 3 });
            if (hits.length > 0) {
                searchHits = hits.length;
                console.log(`[gate] 检索验证命中 ${hits.length} 条（第 ${attempt} 次尝试，${attempt * 12}s）`);
                break;
            }
        } catch (error) {
            console.log(`[gate] 检索尝试 ${attempt} 异常：${error.message}`);
        }
        if (attempt < 25) {
            await new Promise((resolve) => setTimeout(resolve, 12000));
        }
    }
    if (searchHits === 0) {
        throw new Error('门禁失败：索引稳定后（5 分钟）新库仍不可检索');
    }

    const report = {
        gate: 'M2',
        jobId,
        status: 'PASS',
        materials: manifest.materials,
        domains: manifest.domains,
        knowledgeFiles: libFiles,
        distillSummary: steps.distill?.summary,
        harvestSummary: steps.harvest?.summary,
        cost: detail.cost ? { costSoFarCny: detail.cost.costSoFarCny, budgetCny: detail.cost.budgetCny } : null,
        finishedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(ROOT, 'Agent', 'forge', 'gate-m2-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log('[gate] ✅ M2 门禁通过：采集→提炼→入库→可检索 全链路真实环境验证完成');
    process.exit(0); // TDB watcher/定时器会挂起事件循环，成功路径必须显式退出
}

main().catch((error) => {
    console.error('[gate] ❌ M2 门禁失败：', error.message);
    process.exit(1);
});
