'use strict';

/**
 * M3 里程碑门禁脚本：「UI 设计专家」端到端——合成 + 注册 + 热更新 + 权限边界。
 *
 * 用法（在仓库根、配好 config.env 的环境）：
 *   FORGE_GATE_MODEL=deepseek-flash node scripts/run-forge-gate-m3.js
 *
 * 检查点：
 * 1. 全流程 job 跑到 trial 桩（blueprint→harvest→distill→synthesize 完成）
 * 2. 四产物：Agent/forge/<name>.txt 人设、agent_map 登记行、受限库白名单、guidance 条目
 * 3. AgentManager 热更新：不重启进程，watcher 生效，getAgentPrompt 读到新人设
 * 4. guidance 快照交叉校验通过（agents ⊆ agent_map）且 bootstrap 渲染包含知识库指引
 * 5. 检索权限：本专家查到自己的库；其他 agentId 403（与 gateway_knowledge_search 同一守卫）
 *
 * 门禁运行使用仓库默认配置路径（真实行为）；结束后由调用方还原
 * modules/agentGateway/config/ 的变更并清理运行数据。
 */

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

process.env.FORGE_LLM_URL = process.env.API_URL || '';
process.env.FORGE_LLM_API = process.env.API_Key || process.env.APIKey || '';
process.env.FORGE_LLM_MODEL = process.env.FORGE_GATE_MODEL || 'deepseek-flash';

const ROOT = path.join(__dirname, '..');
const EXPERT = {
    name: 'UIDesigner',
    displayName: 'UI 设计专家',
    scope: {
        responsibilities: ['落地页/UI 界面设计评审', '组件规范建议', '配色与排版方案'],
        boundaries: ['不做前端代码实现', '不做人机交互研究']
    },
    subskills: [
        { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design', '配色理论 界面设计'] },
        { id: 'layout-typography', title: '版式与排版', searchQueries: ['layout typography principles', 'UI 排版 网格系统'] }
    ],
    sourcePolicy: { preferOfficialDocs: true, minDomainsPerSubskill: 3, qualityFilter: '丢弃营销软文/无实质内容' },
    examOutline: [
        { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 },
        { subskillId: 'layout-typography', conceptQuestions: 1, appliedQuestions: 1 }
    ],
    practicalExam: {
        prompt: '为一个 SaaS 落地页产出设计方案',
        gradingDimensions: ['眼前一亮', '去 AI 味', '可落地']
    },
    acceptanceSample: '能给出一份眼前一亮、去AI味的 UI 设计图'
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
                reject(new Error(`AnySearch 输出不可解析：${stdout.slice(0, 120)} / ${stderr.slice(0, 120)}`));
            }
        });
        child.stdin.write(`${JSON.stringify({ command: 'search', ...args })}\n`);
        child.stdin.end();
    });
}

async function main() {
    if (!process.env.FORGE_LLM_URL || !process.env.FORGE_LLM_API) {
        throw new Error('config.env 缺少 API_URL/API_Key');
    }

    const agentMapPath = path.join(ROOT, 'agent_map.json');
    const policyPath = path.join(ROOT, 'modules', 'agentGateway', 'config', 'mcp_agent_knowledge_policy.json');
    const guidancePath = path.join(ROOT, 'modules', 'agentGateway', 'config', 'agent_guidance.json');

    console.log('[gate-m3] 初始化 TDB…');
    const tdb = require(path.join(ROOT, 'TDBKnowledge'));
    await tdb.initialize();

    // 等初始扫描排空（冷启动进程的既有库文件去重检查会挤占新库索引窗口）
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    for (let attempt = 0; attempt < 60; attempt += 1) {
        let pending = 0;
        try {
            const db = new Database(path.join(ROOT, 'VectorStoreTDB', 'tdb_knowledge_meta.sqlite'), { readonly: true });
            pending = db.prepare("SELECT COUNT(*) AS n FROM ingest_queue WHERE status IN ('pending','retrying','running')").get().n;
            db.close();
        } catch {
            pending = -1;
        }
        if (pending === 0) {
            console.log('[gate-m3] TDB 初始扫描队列已排空');
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (attempt === 59) {
            throw new Error('等待 TDB 初始扫描排空超时');
        }
    }

    // 门禁幂等：清理上次运行残留（knowledge 库 / 人设 / agent_map 行 / policy / guidance）
    const libraryName = `${EXPERT.name}知识库`;
    fs.rmSync(path.join(ROOT, 'knowledge', libraryName), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'Agent', 'forge', `${EXPERT.name}.txt`), { force: true });
    fs.rmSync(path.join(ROOT, 'Agent', 'forge', 'blueprints', `${EXPERT.name}.json`), { force: true });
    if (fs.existsSync(agentMapPath)) {
        const map = JSON.parse(fs.readFileSync(agentMapPath, 'utf8'));
        if (map[EXPERT.name]) {
            delete map[EXPERT.name];
            fs.writeFileSync(agentMapPath, JSON.stringify(map, null, 2));
        }
    }
    for (const configPath of [policyPath, guidancePath]) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let changed = false;
        if (parsed.restrictedLibraries?.[libraryName]) {
            delete parsed.restrictedLibraries[libraryName];
            changed = true;
        }
        if (parsed.agents?.[EXPERT.name]) {
            delete parsed.agents[EXPERT.name];
            changed = true;
        }
        if (changed) {
            fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
        }
    }

    // AgentManager 热更新基线：先于 job 加载（记录 loadMap 前状态）
    console.log('[gate-m3] 初始化 AgentManager（热更新基线）…');
    // 生产环境 agent_map.json 恒存在（watcher 只在启动时文件存在才监听）；
    // worktree 是全新 checkout，需先落一个基线空 map 才能验证热更新语义。
    if (!fs.existsSync(agentMapPath)) {
        // 基线 map 覆盖 guidance 全部既有条目（生产 agent_map 与 guidance 同步演化；
        // worktree 全新 checkout 需人工对齐，否则快照交叉校验拒绝发布）。
        const baselineGuidance = JSON.parse(fs.readFileSync(guidancePath, 'utf8'));
        const baseline = {};
        for (const agentId of Object.keys(baselineGuidance.agents || {})) {
            baseline[agentId] = `forge/gate-baseline-${agentId}.txt`;
            const placeholder = path.join(ROOT, 'Agent', 'forge', `gate-baseline-${agentId}.txt`);
            if (!fs.existsSync(placeholder)) {
                fs.writeFileSync(placeholder, `# ${agentId} gate baseline placeholder\n`);
            }
        }
        fs.writeFileSync(agentMapPath, `${JSON.stringify(baseline, null, 2)}\n`);
    }
    const agentManager = require(path.join(ROOT, 'modules', 'agentManager'));
    const agentDir = path.join(ROOT, 'Agent');
    if (typeof agentManager.setAgentDir === 'function') {
        agentManager.setAgentDir(agentDir);
    }
    if (typeof agentManager.initialize === 'function') {
        await agentManager.initialize();
    }

    const { createJobRuntimeService } = require(path.join(ROOT, 'modules', 'agentGateway', 'services', 'jobRuntimeService'));
    const { createForgeRuntimeService } = require(path.join(ROOT, 'modules', 'agentGateway', 'services', 'forge', 'service'));
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
                return invokeAnySearch(args);
            }
        },
        agentDirectoryPort: {
            ensureLoaded: async () => {
                if (typeof agentManager.loadMap === 'function') {
                    await agentManager.loadMap();
                }
            },
            listAgents: () => Array.from(agentManager.agentMap?.entries?.() || []).map(([alias, sourceFile]) => ({ alias, sourceFile }))
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: () => tdb.listLibraries(),
            search: (query, options) => tdb.search(query, options)
        },
        baseDir: path.join(ROOT, 'Agent', 'forge'),
        llmConfig: { url: process.env.FORGE_LLM_URL, apiKey: process.env.FORGE_LLM_API, model: process.env.FORGE_LLM_MODEL }
    });

    console.log('[gate-m3] 发起 forge.expert.create（UI 设计专家，2 子技能）…');
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: EXPERT,
        budgetCny: 5
    });

    const waitFor = async (predicate, label, timeoutMs = 420000) => {
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

    await waitFor((j) => j.status === 'pending_confirm', 'blueprint 门禁');
    console.log('[gate-m3] 画像已生成，确认继续（采集→提炼→合成）…');
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });

    const job = await waitFor((j) => j.terminal, 'synthesize 完成（止步 trial 桩）');
    const forge = job.metadata.forge;
    console.log(`[gate-m3] job 终态：${job.status}，失败步：${forge.error?.step || '无'}`);
    if (job.status !== 'failed' || forge.error?.step !== 'trial') {
        throw new Error(`门禁失败：期望止步于 trial 桩，实际 ${job.status} @ ${forge.error?.step}（${forge.error?.message}）`);
    }
    console.log(`[gate-m3] harvest：${forge.steps.find((s) => s.id === 'harvest')?.summary}`);
    console.log(`[gate-m3] distill：${forge.steps.find((s) => s.id === 'distill')?.summary}`);
    console.log(`[gate-m3] synthesize：${forge.steps.find((s) => s.id === 'synthesize')?.summary}`);

    // ── 检查点 2：四产物 ──
    const personaPath = path.join(ROOT, 'Agent', 'forge', `${EXPERT.name}.txt`);
    const persona = fs.readFileSync(personaPath, 'utf8');
    if (!persona.includes('# 知识库调用纪律') || !persona.includes(`"agentId": "${EXPERT.name}"`)) {
        throw new Error('门禁失败：人设缺知识库纪律章节或 agentId 规范');
    }
    const map = JSON.parse(fs.readFileSync(agentMapPath, 'utf8'));
    if (map[EXPERT.name] !== `forge/${EXPERT.name}.txt`) {
        throw new Error(`门禁失败：agent_map 未登记（实际 ${JSON.stringify(map[EXPERT.name])}）`);
    }
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const restricted = policy.restrictedLibraries?.[libraryName];
    if (!restricted || !restricted.allowedAgents.includes(EXPERT.name)) {
        throw new Error(`门禁失败：受限库白名单缺失（${JSON.stringify(restricted)}）`);
    }
    const guidance = JSON.parse(fs.readFileSync(guidancePath, 'utf8'));
    if (!guidance.agents?.[EXPERT.name]?.workflow?.some((line) => line.includes('gateway_knowledge_search'))) {
        throw new Error('门禁失败：guidance 条目缺失或不含知识库指引');
    }

    // ── 检查点 3：AgentManager 热更新（不重启）──
    await new Promise((resolve) => setTimeout(resolve, 1500)); // 等 watcher 触发 loadMap
    const prompt = await agentManager.getAgentPrompt(EXPERT.name);
    if (!prompt || prompt.includes('{{agent:')) {
        throw new Error(`门禁失败：AgentManager 热更新未生效（getAgentPrompt=${String(prompt).slice(0, 60)}`);
    }
    if (!prompt.includes('# 知识库调用纪律')) {
        throw new Error('门禁失败：热更新读到的人设不含知识库纪律');
    }
    console.log(`[gate-m3] AgentManager 热更新生效：getAgentPrompt(${EXPERT.name}) → ${prompt.length} 字符`);

    // ── 检查点 4：guidance 快照交叉校验（agents ⊆ agent_map）──
    const { validateAgentGuidanceConfig } = require(path.join(ROOT, 'modules', 'agentGateway', 'policy', 'agentGuidanceConfig'));
    validateAgentGuidanceConfig(guidance);
    for (const agentId of Object.keys(guidance.agents)) {
        if (!map[agentId]) {
            throw new Error(`门禁失败：guidance 条目 ${agentId} 未在 agent_map 注册（交叉校验会拒绝发布快照）`);
        }
    }

    // ── 检查点 5：检索权限（与 gateway_knowledge_search 同一守卫 + 真实 TDB）──
    const { resolveKnowledgeLibraryAccess } = require(path.join(ROOT, 'modules', 'agentGateway', 'policy', 'knowledgeScopeGuard'));
    let searchHits = 0;
    for (let attempt = 1; attempt <= 25; attempt += 1) {
        try {
            const allowed = resolveKnowledgeLibraryAccess({
                requestedLibraries: [libraryName],
                availableLibraries: await tdb.listLibraries(),
                agentId: EXPERT.name,
                policyPath
            });
            const hits = await tdb.search('color theory UI design', { libraries: allowed.targetLibraries, topK: 3 });
            if (hits.length > 0) {
                searchHits = hits.length;
                console.log(`[gate-m3] 本专家检索命中 ${hits.length} 条（第 ${attempt} 次尝试）`);
                break;
            }
        } catch (error) {
            console.log(`[gate-m3] 本专家检索尝试 ${attempt} 异常：${error.message}`);
        }
        if (attempt < 25) {
            await new Promise((resolve) => setTimeout(resolve, 12000));
        }
    }
    if (searchHits === 0) {
        throw new Error('门禁失败：本专家未能检索到自己的知识库');
    }
    let forbidden = null;
    try {
        resolveKnowledgeLibraryAccess({
            requestedLibraries: [libraryName],
            availableLibraries: await tdb.listLibraries(),
            agentId: 'Nexus',
            policyPath
        });
    } catch (error) {
        forbidden = error;
    }
    if (!forbidden || forbidden.status !== 403) {
        throw new Error(`门禁失败：其他 agentId 应得 403，实际 ${forbidden ? forbidden.status : '放行'}`);
    }
    console.log('[gate-m3] 其他 agentId（Nexus）检索受限库 → 403 ✓');

    const detail = await forgeRuntimeService.getJobDetail(jobId);
    const report = {
        gate: 'M3',
        jobId,
        status: 'PASS',
        persona: `Agent/forge/${EXPERT.name}.txt（${persona.length} 字符）`,
        agentMapEntry: map[EXPERT.name],
        restricted: policy.restrictedLibraries[libraryName],
        guidanceWorkflow: guidance.agents[EXPERT.name].workflow.length,
        hotReload: 'OK',
        searchHits,
        forbiddenAgent: 'Nexus → 403',
        cost: detail.cost ? { costSoFarCny: detail.cost.costSoFarCny, budgetCny: detail.cost.budgetCny } : null,
        finishedAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(ROOT, 'Agent', 'forge', 'gate-m3-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log('[gate-m3] ✅ M3 门禁通过：对话可用（人设+热更新）+ 查到自己的知识库 + 权限边界正确');
    process.exit(0);
}

main().catch((error) => {
    console.error('[gate-m3] ❌ M3 门禁失败：', error.message);
    process.exit(1);
});
