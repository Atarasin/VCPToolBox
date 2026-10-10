'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { scanTextForSecrets } = require('./secretScan');
const { detectNameConflicts, listExistingAgentNames, ForgeNameConflictError } = require('./nameConflict');

/**
 * 人设合成（synthesize）与注册绑定（§3.5 / §3.6）。
 *
 * - 人设 = 模板确定性渲染（身份/职责边界来自画像 scope；MCP 规范与知识库
 *   调用纪律为红线级条款，不交给 LLM 自由发挥——保证 agentId 规范与
 *   「自我介绍与画像 scope 一致」的验收确定性）；
 * - 重名门禁（红线 3）：写盘前重查 agent_map 与 Agent/ 同名文件，冲突抛
 *   ForgeNameConflictError 转人工确认（改名或人工明确覆盖），默认绝不覆盖；
 * - 注册绑定：agent_map.json 登记（watcher 热更新生效）+ 知识库权限
 *   restrictedLibraries（D5：默认只对新专家开放）+ guidance 引导条目。
 */

const FALLBACK_TEMPLATE = "# 身份定义\n## 基本信息\n- **Name**: {{displayName}}（{{name}}）\n- **Author**: ForgeMaster（专家铸造炉铸造）\n- **Version**: 1.0\n- **Role**: {{role}}，通过 MCP (Model Context Protocol) 协议为外部客户端提供专业咨询。\n\n## 核心设定\n{{coreSettings}}\n\n## MCP 工具调用强制规范\n\n**所有 MCP 工具调用必须显式传入 `agentId` 参数，且值必须为 `\"{{name}}\"`。** 涉及的工具包括但不限于：\n- `gateway_agent_bootstrap`\n- `gateway_knowledge_search`\n\n示例：\n```json\n{ \"agentId\": \"{{name}}\", \"query\": \"...\", \"libraries\": [\"{{libraryName}}\"] }\n```\n\n# 知识库调用纪律\n\n你的全部专业技能来自专属冷知识库 **{{libraryName}}**（铸造时经检索-蒸馏-溯源入库，每条知识带出处）。使用纪律：\n\n1. **接手问题先查库**：回答专业问题前，先调用 `gateway_knowledge_search`，显式携带 `agentId: \"{{name}}\"` 与 `libraries: [\"{{libraryName}}\"]`；检索结果不足时换关键词再查。\n2. **答完标注出处**：回答中引用知识库内容时，注明来源（URL/抓取时间在知识卡 frontmatter 中）。\n3. **知识不足就登记缺口**：发现自己答不好、知识库查不到、或低置信时，调用 `gateway_gap_report` 登记 `{ agentId: \"{{name}}\", subskillId, question, whyInsufficient }`，等待定向进修补课。\n4. **红线：专业记忆两条线**——你的「本事」只存在于冷知识库，绝不写入任何记忆日记本；日记本记「经历」，知识库存「本事」，两者永不交叉。你不具备任何记忆写工具的调用权限，也不要尝试。\n\n# 子技能清单与考试标准\n\n{{subskillList}}\n\n# 行为准则\n\n1. **谋定而后动**：先查库（`gateway_knowledge_search`），再作答；查不到就明说知识边界，不凭空编造（宁可缺，不可编）。\n2. **专业与溯源**：观点给出依据与出处；多来源冲突时说明分歧，不武断。\n3. **边界意识**：职责范围内的问题深入回答；边界外的问题（{{boundaries}}）明确告知不在专业范围。\n";

function renderPersona(template, blueprint) {
    const libraryName = blueprintLibraryName(blueprint.name);
    const responsibilities = (blueprint.scope?.responsibilities || []).join('、');
    const boundaries = (blueprint.scope?.boundaries || []).join('、');
    const role = `${blueprint.displayName}：${responsibilities || '专业咨询'}`;
    const coreSettings = [
        `- **职责范围**：${responsibilities || '（见画像）'}`,
        `- **明确边界**：${boundaries || '无特殊边界'}`,
        `- **知识来源**：专属冷知识库「${libraryName}」——铸造流水线按子技能检索-蒸馏-溯源入库，每条知识带出处（URL + 抓取时间）。`,
        '- **专业操守**：宁可缺，不可编——知识库没有的不编造，答不好就登记缺口等进修。'
    ].join('\n');
    const subskillList = blueprint.subskills.map((subskill, index) => {
        const outline = blueprint.examOutline.find((entry) => entry.subskillId === subskill.id);
        return `${index + 1}. **${subskill.title}**（${subskill.id}）：${(subskill.searchQueries || []).join(' / ')}——考纲 ${outline ? `${outline.conceptQuestions} 概念题 + ${outline.appliedQuestions} 应用题` : '按画像考纲'}；及格线样例：${blueprint.acceptanceSample}`;
    }).join('\n');
    return template
        .replace(/\{\{name\}\}/g, blueprint.name)
        .replace(/\{\{displayName\}\}/g, blueprint.displayName)
        .replace(/\{\{libraryName\}\}/g, libraryName)
        .replace(/\{\{role\}\}/g, role)
        .replace(/\{\{coreSettings\}\}/g, coreSettings)
        .replace(/\{\{boundaries\}\}/g, boundaries || '见画像边界')
        .replace(/\{\{subskillList\}\}/g, subskillList);
}

function loadTemplate(baseDir) {
    try {
        return fs.readFileSync(path.join(baseDir, 'templates', 'synthesize.txt'), 'utf8');
    } catch {
        return FALLBACK_TEMPLATE;
    }
}

async function writeJsonAtomic(filePath, payload) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpPath, filePath);
}

async function readJsonOr(filePath, fallback) {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallback;
        }
        throw error;
    }
}

// ── 注册绑定三件套（§3.6）────────────────────────────────────────────

async function registerAgentMap({ agentMapPath, name, personaRelPath, overwrite = false }) {
    const map = await readJsonOr(agentMapPath, {});
    const existed = Object.prototype.hasOwnProperty.call(map, name);
    if (existed && map[name] !== personaRelPath && !overwrite) {
        const error = new Error(`agent_map 已存在条目 ${name}=${map[name]}，拒绝覆盖（红线 3；人工明确覆盖须走 overwrite 确认）`);
        error.code = 'FORGE_AGENT_MAP_CONFLICT';
        error.status = 409;
        throw error;
    }
    if (!existed || map[name] !== personaRelPath) {
        map[name] = personaRelPath;
        await writeJsonAtomic(agentMapPath, map);
    }
    return { registered: true, entry: map[name], overwrote: existed && map[name] === personaRelPath };
}

async function restrictKnowledgeLibrary({ policyPath, libraryName, name }) {
    const policy = await readJsonOr(policyPath, { _comment: '', restrictedLibraries: {} });
    if (!policy.restrictedLibraries || typeof policy.restrictedLibraries !== 'object') {
        policy.restrictedLibraries = {};
    }
    const entry = policy.restrictedLibraries[libraryName];
    if (entry && Array.isArray(entry.allowedAgents) && !entry.allowedAgents.includes(name)) {
        entry.allowedAgents.push(name); // 人工先放行的 agent 不剥夺（只增不减，红线 3）。
    } else if (!entry) {
        policy.restrictedLibraries[libraryName] = { allowedAgents: [name] };
    }
    await writeJsonAtomic(policyPath, policy);
    return policy.restrictedLibraries[libraryName];
}

async function registerGuidance({ guidancePath, blueprint }) {
    const guidance = await readJsonOr(guidancePath, { version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} });
    if (!guidance.agents || typeof guidance.agents !== 'object') {
        guidance.agents = {};
    }
    if (guidance.agents[blueprint.name]) {
        return { registered: false }; // 已有条目不覆盖（人工调优优先）。
    }
    const libraryName = blueprintLibraryName(blueprint.name);
    guidance.agents[blueprint.name] = {
        displayName: blueprint.displayName,
        memoryDefaults: {
            tags: [blueprint.name],
            metadata: { source: 'forge', library: libraryName }
        },
        workflow: [
            `新会话首次实质回答前先调 gateway_agent_bootstrap（显式 agentId: "${blueprint.name}"）获取引导。`,
            `回答专业问题前先 gateway_knowledge_search（agentId: "${blueprint.name}"，libraries: ["${libraryName}"]），答完标注出处。`,
            '低置信或知识不足时调用 gateway_gap_report 登记缺口。'
        ],
        skill: {
            domain: `${blueprint.displayName}专业咨询`,
            triggers: [`需要${(blueprint.scope?.responsibilities || []).join('、')}时`],
            notFor: (blueprint.scope?.boundaries || []).length > 0 ? blueprint.scope.boundaries : ['与专业领域无关的闲聊']
        }
    };
    await writeJsonAtomic(guidancePath, guidance);
    return { registered: true };
}

// ── synthesize 步骤 ───────────────────────────────────────────────────

function createSynthesizeStepRunner({ agentMapPath, knowledgePolicyPath, guidanceConfigPath }) {
    return async function runSynthesizeStep(ctx) {
        const { baseDir, agentDirectoryPort } = ctx;
        if (!ctx.blueprintPath) {
            const error = new Error('synthesize 需要 blueprintPath');
            error.code = 'FORGE_BLUEPRINT_MISSING';
            error.status = 400;
            throw error;
        }
        const blueprint = await readBlueprint(ctx.blueprintPath);
        const libraryName = blueprintLibraryName(blueprint.name);

        // 红线 3 最后一道门禁：blueprint 确认后 agent_map 可能已被外部改动。
        if (!ctx.overwriteApproved) {
            const existingAgentNames = await listExistingAgentNames(agentDirectoryPort);
            const conflicts = detectNameConflicts(blueprint.name, { baseDir, existingAgentNames });
            if (conflicts.length > 0) {
                throw new ForgeNameConflictError(blueprint, conflicts);
            }
        }

        const personaBody = renderPersona(loadTemplate(baseDir), blueprint);
        const secretHits = scanTextForSecrets(personaBody);
        if (secretHits.length > 0) {
            const error = new Error('人设内容疑似包含密钥，阻断落盘（红线 2）');
            error.code = 'FORGE_SECRET_DETECTED';
            error.status = 400;
            error.details = { hits: secretHits };
            throw error;
        }
        const personaPath = path.join(baseDir, `${blueprint.name}.txt`);
        const tmpPath = `${personaPath}.tmp-${process.pid}-${Date.now()}`;
        await fsp.mkdir(baseDir, { recursive: true });
        await fsp.writeFile(tmpPath, `${personaBody}\n`, 'utf8');
        await fsp.rename(tmpPath, personaPath);

        // 注册绑定三件套（§3.6）：agent_map（热更新）→ 权限（D5 受限）→ guidance。
        const agentMap = await registerAgentMap({
            agentMapPath,
            name: blueprint.name,
            personaRelPath: `forge/${blueprint.name}.txt`,
            overwrite: Boolean(ctx.overwriteApproved)
        });
        const restricted = await restrictKnowledgeLibrary({ policyPath: knowledgePolicyPath, libraryName, name: blueprint.name });
        const guidance = await registerGuidance({ guidancePath: guidanceConfigPath, blueprint });

        return {
            summary: `人设已合成并注册：forge/${blueprint.name}.txt + agent_map 登记 + 库「${libraryName}」受限白名单 [${restricted.allowedAgents.join(', ')}] + guidance ${guidance.registered ? '已写入' : '已存在（保留人工调优）'}`,
            artifacts: [
                path.relative(path.join(baseDir, '..'), personaPath),
                path.relative(path.join(baseDir, '..'), agentMapPath)
            ],
            state: {
                expertName: blueprint.name,
                displayName: blueprint.displayName,
                personaPath,
                libraryName,
                agentMapEntry: agentMap.entry,
                restrictedAgents: restricted.allowedAgents,
                guidanceRegistered: guidance.registered
            }
        };
    };
}

// synthesize 阶段确认改名（§3.5）：改画像名 + 迁移知识库目录 + 重跑 synthesize。
async function renameAtSynthesize({ baseDir, knowledgeRoot, runRecord, runStore, jobId, newName }) {
    const oldName = runRecord.expertName;
    const oldBlueprintPath = runRecord.blueprintPath;
    const blueprint = await readBlueprint(oldBlueprintPath);
    blueprint.name = newName;

    const newBlueprintPath = path.join(path.dirname(oldBlueprintPath), `${newName}.json`);
    const { writeBlueprint } = require('./blueprint');
    await writeBlueprint(newBlueprintPath, blueprint);
    await fsp.unlink(oldBlueprintPath).catch(() => undefined);

    const oldLibDir = path.join(knowledgeRoot, blueprintLibraryName(oldName));
    const newLibDir = path.join(knowledgeRoot, blueprintLibraryName(newName));
    if (fs.existsSync(oldLibDir) && !fs.existsSync(newLibDir)) {
        await fsp.rename(oldLibDir, newLibDir);
    }

    const oldPersona = path.join(baseDir, `${oldName}.txt`);
    await fsp.unlink(oldPersona).catch(() => undefined);

    await runStore.updateRun(jobId, {
        expertName: newName,
        blueprintPath: newBlueprintPath
    });
    return { newBlueprintPath, newLibDir };
}

module.exports = {
    FALLBACK_TEMPLATE,
    renderPersona,
    loadTemplate,
    createSynthesizeStepRunner,
    registerAgentMap,
    restrictKnowledgeLibrary,
    registerGuidance,
    renameAtSynthesize
};
