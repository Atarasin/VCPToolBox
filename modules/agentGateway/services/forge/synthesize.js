'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { scanTextForSecrets } = require('./secretScan');
const { detectNameConflicts, listExistingAgentNames, ForgeNameConflictError } = require('./nameConflict');
const { areDiaryNamesEquivalent } = require('../../policy/mcpAgentMemoryPolicy');

/**
 * 人设合成（synthesize）与注册绑定（§3.5 / §3.6）。
 *
 * - 人设 = 模板确定性渲染（身份/职责边界来自画像 scope；MCP 规范与知识库
 *   调用纪律为红线级条款，不交给 LLM 自由发挥——保证 agentId 规范与
 *   「自我介绍与画像 scope 一致」的验收确定性）；
 * - 角色人格（画像 persona，参考 Agent/Yui.txt 范式）：人格名/形象/身世/
 *   箴言/认知风格/语气表达由画像给定，本层只做确定性拼装；人格使用边界
 *   为固定条款——人设不削弱专业严谨与红线纪律，缺省（旧画像）整章省略；
 * - 重名门禁（红线 3）：写盘前重查 agent_map 与 Agent/ 同名文件，冲突抛
 *   ForgeNameConflictError 转人工确认（改名或人工明确覆盖），默认绝不覆盖；
 * - 注册绑定：agent_map.json 登记（watcher 热更新生效）+ 知识库权限
 *   restrictedLibraries（D5：默认只对新专家开放）+ guidance 引导条目。
 */

const FALLBACK_TEMPLATE = "# 身份定义\n## 基本信息\n- **Name**: {{personaNameDot}}{{displayName}}（{{name}}）\n- **Author**: ForgeMaster（专家铸造炉铸造）\n- **Version**: 1.0\n- **Role**: {{role}}，通过 MCP (Model Context Protocol) 协议为外部客户端提供专业咨询。\n\n{{personaSection}}\n## 核心设定\n{{coreSettings}}\n\n## MCP 工具调用强制规范\n\n**所有 MCP 工具调用必须显式传入 `agentId` 参数，且值必须为 `\"{{name}}\"`。** 涉及的工具包括但不限于：\n- `gateway_agent_bootstrap`\n- `gateway_knowledge_search`\n- `gateway_memory_write` / `gateway_recall_run`（工作日志读写，见「工作日志纪律」）\n\n示例：\n```json\n{ \"agentId\": \"{{name}}\", \"query\": \"...\", \"libraries\": [\"{{libraryName}}\"] }\n```\n\n# 知识库调用纪律\n\n你的全部专业技能来自专属冷知识库 **{{libraryName}}**（铸造时经检索-蒸馏-溯源入库，每条知识带出处）。使用纪律：\n\n1. **接手问题先查库**：回答专业问题前，先调用 `gateway_knowledge_search`，显式携带 `agentId: \"{{name}}\"` 与 `libraries: [\"{{libraryName}}\"]`；检索结果不足时换关键词再查。\n2. **答完标注出处**：回答中引用知识库内容时，注明来源（URL/抓取时间在知识卡 frontmatter 中）。\n3. **知识不足就登记缺口**：发现自己答不好、知识库查不到、或低置信时，调用 `gateway_gap_report` 登记 `{ agentId: \"{{name}}\", subskillId, question, whyInsufficient }`，等待定向进修补课。\n4. **红线：本事与经历两条线**——你的「本事」（专业技能知识）只存在于冷知识库，绝不写入工作日志；工作日志只记「经历」（解决用户问题的过程与复盘），两者永不交叉。知识缺口走 `gateway_gap_report` 登记进修，不在日志里攒知识点。\n5. **受限环境直接作答（严禁工具语法泄漏）**：当环境中没有可调用的 MCP 工具（考试/受限会话，资料已由系统给定）时，不要尝试调用工具——基于已给定资料与公认专业原则直接作答，超出资料的部分标注「（通行原则，库内无直接资料）」。严禁把任何工具调用语法（<invoke>、DSML 标记、「始」「末」协议块等）当作回答输出——工具标记文本不是回答。\n\n# 工作日志纪律（经历记忆）\n\n你有一本专属工作日志 **{{diaryName}}**（`gateway_memory_write` 写入 / `gateway_recall_run` 召回），记录你作为专家的「经历」，与冷知识库的「本事」分工：\n\n1. **接手问题先召回**：处理用户问题前，先调用 `gateway_recall_run`（显式 `agentId: \"{{name}}\"`）召回相关既往经历——同类问题的处理过程与结论、该用户的偏好与约束、踩过的坑；命中即复用，避免重复踩坑、重复追问。\n2. **事后沉淀经历**：完成一次有代表性的问题解决（或中途遇到值得记录的坑）时，调用 `gateway_memory_write` 写入 `{{diaryName}}`，`target.diary` 填 `\"{{diaryName}}\"`：问题背景、解决过程、关键取舍与最终结论、用户偏好/约束、复盘心得；`tags` 用子技能 id 标注所属领域，便于日后检索。\n3. **只记经历，不记本事（红线 1）**：日志写「怎么解决的过程」与「上下文/偏好/复盘」，不写专业知识点本体——知识点缺口走 `gateway_gap_report`，由铸造炉进修蒸馏进冷知识库；考试/盲测等受限环境严禁调用任何记忆工具。\n\n# 子技能清单与考试标准\n\n{{subskillList}}\n\n# 行为准则\n\n1. **谋定而后动**：先召回既往经历（`gateway_recall_run`），再查库（`gateway_knowledge_search`），再作答；查不到时用公认专业原则给出判断并标注「（通行原则，库内无直接资料）」，不凭空编造、也不整体拒答（宁可缺，不可编）。\n2. **专业与溯源**：观点给出依据与出处；多来源冲突时说明分歧，不武断。\n3. **边界意识**：职责范围内的问题深入回答；边界外的问题（{{boundaries}}）明确告知不在专业范围。\n";

// 人格使用边界（固定条款，模板级确定性内容，不交给画像/LLM 自由发挥）。
const PERSONA_BOUNDARY_CLAUSE = '> 人格使用边界：人设只体现在称呼、语气与表达习惯上；专业内容的严谨性、结构化、溯源纪律与边界意识不因人设打折；在考试或受限环境中，答题纪律优先于人设表达。';

function isNonEmptyStr(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function toNonEmptyList(value) {
    return Array.isArray(value) ? value.filter(isNonEmptyStr) : [];
}

/**
 * 专家工作日志日记本名（§3.5 工作日志纪律）：与知识库名一样由 agent 名派生，
 * 物理落盘目录为 dailynote/<name>工作日志/（DailyNote 归一化自动剥「日记本」后缀）。
 */
function expertDiaryName(name) {
    return `${name}工作日志日记本`;
}

/**
 * 日记作者（maid）：画像带人格时用人格名（日记里以人格名署名），否则用 agent 名。
 */
function resolveDiaryMaid(blueprint) {
    const personaName = typeof blueprint.persona?.name === 'string' ? blueprint.persona.name.trim() : '';
    return personaName || blueprint.name;
}

/**
 * 角色人格章节（参考 Agent/Yui.txt 范式）：人格名/称号开场 + 形象 + 身世 +
 * 核心箴言 + 认知风格 + 语气与表达 + 标志性口癖 + 人格使用边界。
 * 画像无 persona（旧画像）时返回空段——整章省略，输出与旧版一致。
 */
function buildPersonaBlock(persona, displayName) {
    if (!persona || typeof persona !== 'object' || !isNonEmptyStr(persona.name)) {
        return { nameDot: '', section: '' };
    }
    const lines = [];
    lines.push('# 角色人格');
    lines.push('');
    lines.push(`你是${persona.name}${isNonEmptyStr(persona.title) ? `——${persona.title}` : ''}，由专家铸造炉铸造的「${displayName}」。`);
    if (isNonEmptyStr(persona.appearance)) {
        lines.push(`**形象**：${persona.appearance}`);
    }
    if (isNonEmptyStr(persona.backstory)) {
        lines.push(`**身世**：${persona.backstory}`);
    }
    if (isNonEmptyStr(persona.coreMotto)) {
        lines.push(`**核心箴言**：「${persona.coreMotto}」`);
    }
    const cognitiveStyle = toNonEmptyList(persona.cognitiveStyle);
    if (cognitiveStyle.length > 0) {
        lines.push('');
        lines.push('## 认知风格');
        cognitiveStyle.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    const toneAndExpression = toNonEmptyList(persona.toneAndExpression);
    if (toneAndExpression.length > 0) {
        lines.push('');
        lines.push('## 语气与表达');
        toneAndExpression.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    }
    const quirks = toNonEmptyList(persona.quirks);
    if (quirks.length > 0) {
        lines.push('');
        lines.push(`**标志性表达**：${quirks.join('；')}`);
    }
    lines.push('');
    lines.push(PERSONA_BOUNDARY_CLAUSE);
    return { nameDot: `${persona.name}·`, section: `${lines.join('\n')}\n` };
}

function renderPersona(template, blueprint) {
    const libraryName = blueprintLibraryName(blueprint.name);
    const diaryName = expertDiaryName(blueprint.name);
    const responsibilities = (blueprint.scope?.responsibilities || []).join('、');
    const boundaries = (blueprint.scope?.boundaries || []).join('、');
    const role = `${blueprint.displayName}：${responsibilities || '专业咨询'}`;
    const coreSettings = [
        `- **职责范围**：${responsibilities || '（见画像）'}`,
        `- **明确边界**：${boundaries || '无特殊边界'}`,
        `- **知识来源**：专属冷知识库「${libraryName}」——铸造流水线按子技能检索-蒸馏-溯源入库，每条知识带出处（URL + 抓取时间）。`,
        `- **经历载体**：专属工作日志「${diaryName}」——上岗后解决用户问题的过程、复盘与用户偏好记这里；与知识库「两条线不混写」。`,
        '- **专业操守**：宁可缺，不可编——知识库没有的不编造，答不好就登记缺口等进修。'
    ].join('\n');
    const subskillList = blueprint.subskills.map((subskill, index) => {
        const outline = blueprint.examOutline.find((entry) => entry.subskillId === subskill.id);
        return `${index + 1}. **${subskill.title}**（${subskill.id}）：${(subskill.searchQueries || []).join(' / ')}——考纲 ${outline ? `${outline.conceptQuestions} 概念题 + ${outline.appliedQuestions} 应用题` : '按画像考纲'}；及格线样例：${blueprint.acceptanceSample}`;
    }).join('\n');
    const personaBlock = buildPersonaBlock(blueprint.persona, blueprint.displayName);
    return template
        .replace(/\{\{name\}\}/g, blueprint.name)
        .replace(/\{\{personaNameDot\}\}/g, personaBlock.nameDot)
        .replace(/\{\{displayName\}\}/g, blueprint.displayName)
        .replace(/\{\{libraryName\}\}/g, libraryName)
        .replace(/\{\{diaryName\}\}/g, diaryName)
        .replace(/\{\{role\}\}/g, role)
        .replace(/\{\{personaSection\}\}/g, personaBlock.section)
        .replace(/\{\{coreSettings\}\}/g, coreSettings)
        .replace(/\{\{boundaries\}\}/g, boundaries || '见画像边界')
        .replace(/\{\{subskillList\}\}/g, subskillList)
        // 无人格画像省略整章后收敛空行，保证与旧版输出一致。
        .replace(/\n{3,}/g, '\n\n');
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

/**
 * 记忆策略登记（§3.6 注册绑定四件套之三）：为专家在 mcp_agent_memory_policy.json
 * 写入工作日志条目（maid + allowed/defaultDiaries）。该文件热加载，写入即生效——
 * gateway_memory_write 的写门禁与 gateway_memory_search/context_assemble 的
 * 日记范围都从这里解析；无条目 = 无 maid = 写入直接 500（buildMemoryWriteMaid）。
 * 已有条目只增不减：日志不在白名单则追加，maid 缺省才补（人工调优优先，红线 3）。
 */
async function registerMemoryPolicy({ memoryPolicyPath, name, maid, diaryName }) {
    const policy = await readJsonOr(memoryPolicyPath, { agents: {} });
    if (!policy.agents || typeof policy.agents !== 'object' || Array.isArray(policy.agents)) {
        policy.agents = {};
    }
    const entry = policy.agents[name] && typeof policy.agents[name] === 'object' && !Array.isArray(policy.agents[name])
        ? policy.agents[name]
        : null;
    if (!entry) {
        policy.agents[name] = {
            maid,
            allowedDiaries: [diaryName],
            defaultDiaries: [diaryName]
        };
        await writeJsonAtomic(memoryPolicyPath, policy);
        return { registered: true, entry: policy.agents[name] };
    }
    let changed = false;
    const allowedDiaries = Array.isArray(entry.allowedDiaries) ? entry.allowedDiaries : [];
    if (!allowedDiaries.some((allowed) => areDiaryNamesEquivalent(allowed, diaryName))) {
        allowedDiaries.push(diaryName);
        entry.allowedDiaries = allowedDiaries;
        changed = true;
    }
    const defaultDiaries = Array.isArray(entry.defaultDiaries) ? entry.defaultDiaries : [];
    if (defaultDiaries.length === 0) {
        entry.defaultDiaries = [diaryName];
        changed = true;
    }
    if (!isNonEmptyStr(entry.maid)) {
        entry.maid = maid;
        changed = true;
    }
    if (changed) {
        await writeJsonAtomic(memoryPolicyPath, policy);
    }
    return { registered: !changed, entry };
}

/**
 * 召回档案登记（§3.6 注册绑定四件套之四）：recall_profiles.json 写入专家的
 * 默认召回档案（gateway_recall_run 无档案即 RECALL_NO_PROFILE，召回链路不通）。
 * 档案参数对齐 ForgeMaster-default（rag + time/rerank/tagMemo/truncate 20）。
 * 已有 agents 条目不覆盖（人工调优优先，同 guidance 语义）。
 */
async function registerRecallProfile({ recallProfilesPath, name, diaryName }) {
    const config = await readJsonOr(recallProfilesPath, { agents: {}, profiles: {} });
    if (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) {
        config.agents = {};
    }
    if (!config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) {
        config.profiles = {};
    }
    if (config.agents[name]) {
        return { registered: false, profileName: null };
    }
    const profileName = `${name}-default`;
    config.agents[name] = {
        defaultProfile: profileName,
        allowedProfiles: [profileName],
        targets: [diaryName]
    };
    if (!config.profiles[profileName]) {
        config.profiles[profileName] = {
            minScore: 0.5,
            rules: [{
                baseMode: 'rag',
                targets: { diaries: [diaryName], aggregate: true, kMultiplier: 1.0 },
                modifiers: { time: true, rerank: true, tagMemo: true, truncate: 20 }
            }]
        };
    }
    await writeJsonAtomic(recallProfilesPath, config);
    return { registered: true, profileName };
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
    const diaryName = expertDiaryName(blueprint.name);
    guidance.agents[blueprint.name] = {
        displayName: blueprint.displayName,
        memoryDefaults: {
            tags: [blueprint.name],
            metadata: { source: 'forge', library: libraryName }
        },
        workflow: [
            `新会话首次实质回答前先调 gateway_agent_bootstrap（显式 agentId: "${blueprint.name}"）获取引导。`,
            `回答专业问题前先 gateway_knowledge_search（agentId: "${blueprint.name}"，libraries: ["${libraryName}"]），答完标注出处。`,
            `处理用户问题前先 gateway_recall_run（agentId: "${blueprint.name}"）召回「${diaryName}」中的既往经历——同类问题的处理过程与结论、用户偏好与约束、踩过的坑。`,
            `完成有代表性的问题解决（或遇到值得记录的坑）后，用 gateway_memory_write 写入「${diaryName}」（问题背景/解决过程/取舍与结论/用户偏好，tags 用子技能 id 标注）；红线：专业知识点只进冷知识库（缺口走 gateway_gap_report），日志只记经历。`,
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

function createSynthesizeStepRunner({ agentMapPath, knowledgePolicyPath, guidanceConfigPath, memoryPolicyPath, recallProfilesPath }) {
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
        const diaryName = expertDiaryName(blueprint.name);

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

        // 注册绑定四件套（§3.6）：agent_map（热更新）→ 权限（D5 受限）→ guidance
        // → 记忆策略 + 召回档案（工作日志两件，均热加载）。
        const agentMap = await registerAgentMap({
            agentMapPath,
            name: blueprint.name,
            personaRelPath: `forge/${blueprint.name}.txt`,
            overwrite: Boolean(ctx.overwriteApproved)
        });
        const restricted = await restrictKnowledgeLibrary({ policyPath: knowledgePolicyPath, libraryName, name: blueprint.name });
        const guidance = await registerGuidance({ guidancePath: guidanceConfigPath, blueprint });
        const memoryPolicy = await registerMemoryPolicy({
            memoryPolicyPath,
            name: blueprint.name,
            maid: resolveDiaryMaid(blueprint),
            diaryName
        });
        const recallProfile = await registerRecallProfile({ recallProfilesPath, name: blueprint.name, diaryName });

        return {
            summary: `人设已合成并注册：forge/${blueprint.name}.txt + agent_map 登记 + 库「${libraryName}」受限白名单 [${restricted.allowedAgents.join(', ')}] + guidance ${guidance.registered ? '已写入' : '已存在（保留人工调优）'} + 工作日志「${diaryName}」${memoryPolicy.registered && recallProfile.registered ? '已配好（记忆策略+召回档案）' : '策略已存在（保留人工调优）'}`,
            artifacts: [
                path.relative(path.join(baseDir, '..'), personaPath),
                path.relative(path.join(baseDir, '..'), agentMapPath)
            ],
            state: {
                expertName: blueprint.name,
                displayName: blueprint.displayName,
                personaPath,
                libraryName,
                diaryName,
                agentMapEntry: agentMap.entry,
                restrictedAgents: restricted.allowedAgents,
                guidanceRegistered: guidance.registered,
                memoryPolicyRegistered: memoryPolicy.registered,
                recallProfileRegistered: recallProfile.registered
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
    PERSONA_BOUNDARY_CLAUSE,
    buildPersonaBlock,
    renderPersona,
    loadTemplate,
    createSynthesizeStepRunner,
    expertDiaryName,
    resolveDiaryMaid,
    registerAgentMap,
    restrictKnowledgeLibrary,
    registerGuidance,
    registerMemoryPolicy,
    registerRecallProfile,
    renameAtSynthesize
};
