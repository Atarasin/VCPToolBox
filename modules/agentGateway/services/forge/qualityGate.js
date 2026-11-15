'use strict';

/**
 * forge 质量硬门禁（设计 §3.5，M4.S1/S2）。
 *
 * 最小接口（§3.5.1）：
 * - assessMaterial({blueprint, subskill, material}) → QualityVerdict
 *     材料级主题门禁：材料读取后、分批蒸馏前（§3.5.2）。
 * - assessUnit({blueprint, subskill, unit, claims}) → QualityVerdict
 *     单元级门禁：主题 + 完整性（§3.5.4）+ 主张支持聚合。
 * - verifyClaims({units, evidenceBySourceUrl, materialUrls, llm, llmConfig, logger})
 *     → { byUnitTitle, claims }：主张提取（LLM）→ URL 白名单与引文精确匹配
 *     （确定性）→ 独立支持判定（LLM，复用 ctx.llm 的预算/重试护栏，§3.5.3）。
 * - classifyMerge({unit, targetCard}) → 'source-only' | 'content-revision' | 'conflict'
 * - assertIndexReady({knowledgeStorePort, expectedFiles, probes, timeoutMs})
 *     → ReadinessReport（§3.6.1 合取条件；任一不满足 fail closed）。
 *
 * 判定输出全部走 qualityModel 的 QualityVerdict（构造期校验），
 * 规则版本 forge-quality-v1。本模块不做 I/O（LLM 端口与证据文本由调用方注入）。
 */

const crypto = require('node:crypto');
const qualityModel = require('./qualityModel');

const QUALITY_RULE_VERSION = qualityModel.RULE_VERSION;

// ── 主题门禁（§3.5.2） ───────────────────────────────────────────────────

/** CJK bigram + 拉丁词元的轻量分词（够用即可：主题命中是信号不是判词）。 */
function tokenize(text) {
    const raw = String(text || '');
    const tokens = new Set();
    for (const word of raw.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) {
        tokens.add(word);
    }
    const cjk = raw.replace(/[^\p{Script=Han}]+/gu, '');
    for (let i = 0; i + 2 <= cjk.length; i++) {
        tokens.add(cjk.slice(i, i + 2));
    }
    return tokens;
}

function subskillTermProfile(blueprint, subskill) {
    const profile = new Map(); // token → weight
    const add = (text, weight) => {
        for (const token of tokenize(text)) {
            profile.set(token, Math.max(profile.get(token) || 0, weight));
        }
    };
    add(subskill?.title, 3);
    add(subskill?.id?.replace(/-/g, ' '), 2);
    for (const query of subskill?.searchQueries || []) add(query, 2);
    for (const responsibility of blueprint?.scope?.responsibilities || []) add(responsibility, 1);
    return profile;
}

function boundaryTokens(blueprint) {
    const tokens = new Set();
    for (const boundary of blueprint?.scope?.boundaries || []) {
        for (const token of tokenize(boundary)) tokens.add(token);
    }
    return tokens;
}

/**
 * 材料级主题判定（确定性）。信号：标题/摘要/域名与子技能词廓的重叠，以及
 * 蓝图 boundaries 词命中（负信号）。强判据不足时判 uncertain → needs_review，
 * 不冒险放行也不武断隔离。
 */
function assessMaterial({ blueprint, subskill, material }) {
    const subjectId = material?.url || material?.title || 'material';
    const profile = subskillTermProfile(blueprint, subskill);
    // 材料文本：title + snippet（缺失时回退 raw body 前 300 字——distill 的
    // materials 只带 content）+ 域名。
    const text = [
        material?.title,
        material?.snippet || String(material?.content || '').slice(0, 300),
        material?.domain
    ].filter(Boolean).join(' ');
    const tokens = tokenize(text);
    let strongHits = 0;
    let weakHits = 0;
    for (const token of tokens) {
        const weight = profile.get(token);
        if (weight >= 3) strongHits += 1;
        else if (weight >= 1) weakHits += 1;
    }
    const boundaryHits = [...tokens].filter((token) => boundaryTokens(blueprint).has(token)).length;

    let verdict;
    let reason;
    // 阈值校准：材料由子技能 searchQueries 检索得来，主题性大半继承自查询；
    // 材料门禁的职责是拦"明显跑题"而非复检搜索引擎——强命中或两个词廓弱
    // 命中即 in_scope；零重叠 + 边界词才是 out_of_scope。
    if (strongHits >= 1 || weakHits >= 2) {
        verdict = 'in_scope';
        reason = `主题命中：强 ${strongHits} / 弱 ${weakHits}（子技能词廓）`;
    } else if (weakHits === 0 && tokens.size >= 6 && boundaryHits >= 2) {
        verdict = 'out_of_scope';
        reason = `与子技能词廓零重叠且命中蓝图边界词 ${boundaryHits} 项`;
    } else if (weakHits === 1) {
        verdict = 'adjacent';
        reason = `主题仅单一弱命中（强 ${strongHits} / 弱 ${weakHits}）`;
    } else {
        verdict = 'uncertain';
        reason = `主题信号不足（强 ${strongHits} / 弱 ${weakHits}，tokens ${tokens.size}）`;
    }

    const status = verdict === 'out_of_scope' ? 'quarantine'
        : (verdict === 'in_scope' ? 'pass' : 'needs_review');
    return qualityModel.createQualityVerdict({
        subjectType: 'material',
        subjectId,
        status,
        topic: { verdict, reason },
        claims: [],
        issues: status === 'pass' ? [] : [{
            code: `TOPIC_${verdict.toUpperCase()}`,
            message: reason,
            blocking: status !== 'pass'
        }],
        ruleVersion: QUALITY_RULE_VERSION,
        createdAt: new Date().toISOString()
    });
}

// ── 完整性门禁（§3.5.4，按卡片类型） ────────────────────────────────────

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };

function promisedItemCount(title) {
    const digit = String(title || '').match(/(\d+)\s*(项|条|个|步)/);
    if (digit) return Number(digit[1]);
    const cn = String(title || '').match(/([一二三四五六七八九十两]+)\s*(项|条|个|步)/);
    if (cn) {
        const text = cn[1];
        if (text === '十') return 10;
        if (text.startsWith('十')) return 10 + (CN_NUMERALS[text[1]] || 0);
        return CN_NUMERALS[text] ?? null;
    }
    return null;
}

function countListItems(content) {
    return ([...String(content || '').matchAll(/^\s*(?:\d+\.|[-*])\s+\S/gm)] || []).length;
}

function completenessIssues(unit) {
    const issues = [];
    const content = String(unit?.content || '');
    const title = String(unit?.title || '');
    const items = countListItems(content);
    const promised = promisedItemCount(title);
    if (promised != null && items > 0 && items < promised) {
        issues.push({ code: 'CHECKLIST_UNDERDELIVERED', message: `标题承诺 ${promised} 项，正文清单仅 ${items} 项`, blocking: true });
    }
    if (promised != null && items === 0) {
        issues.push({ code: 'CHECKLIST_MISSING', message: `标题承诺 ${promised} 项但正文无清单`, blocking: true });
    }
    if (unit?.type === 'methodology' && !/步骤|流程|方法|实施/.test(content) && countListItems(content) < 2) {
        issues.push({ code: 'METHODOLOGY_NO_STEPS', message: 'methodology 既无步骤/流程章节也无 ≥2 条编号步骤', blocking: true });
    }
    if (unit?.type === 'definition' && !/定义|是指|概念|含义/.test(content)) {
        issues.push({ code: 'DEFINITION_NO_DEFINITION', message: 'definition 缺定义表述', blocking: true });
    }
    // §3.3.2：定义卡可以简短——薄内容只有当标题承诺系统性内容时才是阻断项。
    const thin = content.replace(/\s/g, '').length < 60;
    if (thin && /方法|体系|指南|全解|清单|流程/.test(title)) {
        issues.push({ code: 'CONTENT_TOO_THIN', message: `标题承诺系统性内容但正文仅 ${content.replace(/\s/g, '').length} 字符`, blocking: true });
    } else if (thin) {
        issues.push({ code: 'CONTENT_THIN_NOTE', message: `正文较薄（${content.replace(/\s/g, '').length} 字符）——定义卡允许简短，记录备查`, blocking: false });
    }
    if (/清单|列表/.test(title) && items === 0 && promised == null) {
        issues.push({ code: 'CHECKLIST_NO_ITEMS', message: '标题含"清单/列表"但正文无列表项', blocking: true });
    }
    return issues;
}

// ── 主张与证据门禁（§3.5.3） ─────────────────────────────────────────────

/** 规范化：去空白、统一大小写——引文须在证据正文中"规范化精确匹配"。 */
function normalizeForQuoteMatch(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, '');
}

function quoteMatchesEvidence(quote, evidenceText) {
    const normalizedQuote = normalizeForQuoteMatch(quote);
    if (normalizedQuote.length < 12) return false; // 太短不具证据力
    return normalizeForQuoteMatch(evidenceText).includes(normalizedQuote);
}

function claimExtractionPrompt({ units, evidenceExcerpts }) {
    return `你是知识主张提取器。对下面每个知识单元，从标题、oneLiner 与正文中提取原子主张（可核验的单句事实/规范/经验判断），并为每条主张从"证据摘录"中选择支撑它的原文引文与其来源 URL。
规则：
- kind ∈ normative（规范条文）| factual（事实）| heuristic（经验法则）| opinion（观点）；
- 每条主张的 quote 必须逐字取自证据摘录（后续会做精确匹配校验），sourceUrl 必须是摘录中列出的 URL 之一；
- 标题或 oneLiner 中的关键主张必须包含；不得虚构引文；找不到支撑时 quote 留空字符串。
只输出 JSON：{"claims":[{"unitTitle":"","id":"claim-001","text":"","kind":"","scope":"适用组织/版本/条件，未知给 general","sourceUrl":"","quote":""}]}

知识单元：
${units.map((unit) => `- 标题：${unit.title}\n  oneLiner：${unit.oneLiner || ''}\n  正文：${String(unit.content).slice(0, 2000)}`).join('\n')}

证据摘录：
${evidenceExcerpts}`;
}

function claimAdjudicationPrompt({ claims, evidenceExcerpts }) {
    return `你是独立主张核验员（与提取过程无关）。对下面每条主张，依据"证据摘录"独立判断其是否被证据支撑。
规则：support ∈ supported | unsupported | conflicted | uncertain；只依据摘录内容判断，不使用你自己的知识补证；给出一句理由。
只输出 JSON：{"judged":[{"id":"","support":"","reason":""}]}

主张：
${claims.map((claim) => `- ${claim.id}（${claim.kind}）[来源 ${claim.sourceUrl}]：${claim.text}\n  提取引文：${claim.quote || '（无）'}`).join('\n')}

证据摘录：
${evidenceExcerpts}`;
}

function renderEvidenceExcerpts(evidenceBySourceUrl, { maxCharsPerSource = 3000 } = {}) {
    return Object.entries(evidenceBySourceUrl || {})
        .map(([url, text]) => `[来源 ${url}]\n${String(text).slice(0, maxCharsPerSource)}`)
        .join('\n\n') || '（无证据）';
}

function extractJsonLoose(text) {
    const raw = String(text || '').trim();
    try {
        return JSON.parse(raw);
    } catch {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(raw.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

async function llmJson({ llm, llmConfig, prompt, label, logger }) {
    const response = await llm.complete(llmConfig, {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 4000
    });
    const content = response?.data?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonLoose(content);
    if (!parsed) {
        const error = new Error(`${label} 输出不可解析`);
        error.code = 'FORGE_CLAIM_LLM_INVALID';
        throw error;
    }
    return parsed;
}

/**
 * 主张提取 → 确定性校验 → 独立支持判定（§3.5.3 顺序 1-4）。
 * 返回 { byUnitTitle: Map<title, Claim[]>, allClaims, issues }。
 * LLM 端口必须走 ctx.llm 包装（费用/取消/预算/重试护栏——§3.5.3 明令）。
 */
async function verifyClaims({ units, evidenceBySourceUrl, materialUrls, llm, llmConfig, logger }) {
    const issues = [];
    const evidenceExcerpts = renderEvidenceExcerpts(evidenceBySourceUrl);
    const urlSet = new Set(materialUrls || []);

    // 1+2. LLM 提取主张与引文。
    const extracted = await llmJson({
        llm, llmConfig, label: 'claim-extract', logger,
        prompt: claimExtractionPrompt({ units, evidenceExcerpts })
    });
    const rawClaims = Array.isArray(extracted.claims) ? extracted.claims : [];
    if (rawClaims.length === 0) {
        issues.push({ code: 'CLAIMS_EMPTY', message: '主张提取结果为空——单元无主张或提取失败', blocking: false });
    }

    // 3. 确定性校验：URL 属于本批材料；引文在对应证据全文中规范化精确匹配。
    const verified = [];
    for (const claim of rawClaims) {
        const id = claim?.id || `claim-${verified.length + 1}`;
        const sourceUrl = String(claim?.sourceUrl || '');
        const quote = String(claim?.quote || '');
        if (sourceUrl && !urlSet.has(sourceUrl)) {
            issues.push({ code: 'CLAIM_URL_NOT_IN_BATCH', message: `主张 ${id} 的来源 ${sourceUrl} 不在本批材料中（疑似编造）`, blocking: true, unitTitle: claim.unitTitle });
            continue;
        }
        const evidenceText = evidenceBySourceUrl?.[sourceUrl];
        if (!evidenceText || String(evidenceText).trim().length < 200) {
            issues.push({ code: 'CLAIM_EVIDENCE_SNIPPET_ONLY', message: `主张 ${id} 的来源 ${sourceUrl} 无归档全文（仅摘要不构成证据，红线 3）`, blocking: true, unitTitle: claim.unitTitle });
            continue;
        }
        if (quote && !quoteMatchesEvidence(quote, evidenceText)) {
            issues.push({ code: 'CLAIM_QUOTE_NOT_MATCHED', message: `主张 ${id} 的引文未能在证据全文中精确匹配（疑似虚构引文）`, blocking: true, unitTitle: claim.unitTitle });
            continue;
        }
        verified.push({ id, ...claim, sourceUrl, quote, quoteMatched: quote.length > 0 });
    }

    // 4. 独立支持判定（第二个 LLM 调用，只见主张与证据摘录）。
    let judged = new Map();
    if (verified.length > 0) {
        const adjudication = await llmJson({
            llm, llmConfig, label: 'claim-adjudge', logger,
            prompt: claimAdjudicationPrompt({ claims: verified, evidenceExcerpts })
        });
        for (const item of Array.isArray(adjudication.judged) ? adjudication.judged : []) {
            if (item?.id) judged.set(item.id, item);
        }
    }

    const byUnitTitle = new Map(units.map((unit) => [unit.title, []]));
    const allClaims = [];
    for (const claim of verified) {
        const judgment = judged.get(claim.id);
        let support = judgment?.support;
        if (!['supported', 'unsupported', 'conflicted', 'uncertain'].includes(support)) {
            support = 'uncertain';
        }
        // 规范/事实主张无引文匹配 → 独立判定 supported 也不算数（标题孤证同罪）。
        if ((claim.kind === 'normative' || claim.kind === 'factual') && !claim.quoteMatched) {
            support = support === 'supported' ? 'uncertain' : support;
            issues.push({
                code: 'CLAIM_NORMATIVE_WITHOUT_QUOTE',
                message: `${claim.kind} 主张 ${claim.id} 无精确匹配引文（标题/摘要孤证不得通过）`,
                blocking: true,
                unitTitle: claim.unitTitle
            });
        }
        if (support === 'unsupported' || support === 'conflicted') {
            issues.push({
                code: `CLAIM_${support.toUpperCase()}`,
                message: `主张 ${claim.id} 独立判定为 ${support}：${judgment?.reason || ''}`,
                blocking: true,
                unitTitle: claim.unitTitle
            });
        } else if (support === 'uncertain' && ['normative', 'factual', 'heuristic'].includes(claim.kind)) {
            // §3.5.3 顺序 5：低置信 → needs_review（opinion 除外——本就不当标准发布）。
            issues.push({
                code: 'CLAIM_LOW_CONFIDENCE',
                message: `主张 ${claim.id}（${claim.kind}）独立判定为 uncertain：${judgment?.reason || '无判定理由'}——低置信不得作为已核验知识发布`,
                blocking: true,
                unitTitle: claim.unitTitle
            });
        }
        const built = qualityModel.createClaim({
            id: claim.id,
            text: String(claim.text || ''),
            kind: ['normative', 'factual', 'heuristic', 'opinion'].includes(claim.kind) ? claim.kind : 'heuristic',
            scope: String(claim.scope || 'general'),
            evidence: claim.quoteMatched
                ? [{ url: claim.sourceUrl, contentHash: `sha256:${crypto.createHash('sha256').update(String(evidenceBySourceUrl[claim.sourceUrl])).digest('hex')}`, quote: claim.quote }]
                : [],
            support
        });
        allClaims.push(built);
        const bucket = byUnitTitle.get(claim.unitTitle);
        if (bucket) bucket.push(built);
    }
    return { byUnitTitle, allClaims, issues };
}

/** 单元级判定：主题（材料背书 + 词廓）+ 完整性 + 主张聚合。
 *
 * 材料背书（§3.5.2 材料门禁的下游效力）：单元的来源材料若被判 in_scope，
 * 单元主题随材料——单元级词廓对中文同义改写太弱（"色轮"与"配色理论"
 * 零 bigram 重叠），材料级判定（标题+摘要+查询词）才是主题权威信号；
 * 单元自身词廓只用于抓"材料没问题但单元跑题"的异常与边界命中。
 */
function assessUnit({ blueprint, subskill, unit, claims = [], claimIssues = [], materialVerdicts = [] }) {
    const profile = subskillTermProfile(blueprint, subskill);
    const tokens = tokenize([unit?.title, unit?.oneLiner, String(unit?.content || '').slice(0, 800)].filter(Boolean).join(' '));
    let strongHits = 0;
    let weakHits = 0;
    for (const token of tokens) {
        const weight = profile.get(token);
        if (weight >= 3) strongHits += 1;
        else if (weight >= 1) weakHits += 1;
    }
    const boundaryHits = [...tokens].filter((token) => boundaryTokens(blueprint).has(token)).length;
    const hasInScopeMaterial = (materialVerdicts || []).includes('in_scope');

    let topicVerdict;
    let topicReason;
    if (strongHits >= 2 || (strongHits >= 1 && weakHits >= 4)) {
        topicVerdict = 'in_scope';
        topicReason = `单元主题命中子技能词廓（强 ${strongHits} / 弱 ${weakHits}）`;
    } else if (hasInScopeMaterial) {
        topicVerdict = 'in_scope';
        topicReason = '来源材料已过主题门禁（材料背书），单元无边界信号';
    } else if (strongHits === 0 && weakHits <= 1 && boundaryHits >= 2) {
        topicVerdict = 'out_of_scope';
        topicReason = `单元与子技能词廓近零重叠且命中边界词 ${boundaryHits} 项`;
    } else {
        topicVerdict = 'adjacent';
        topicReason = `单元主题部分命中（强 ${strongHits} / 弱 ${weakHits}，来源材料亦非 in_scope）`;
    }

    const issues = [...claimIssues.map((issue) => ({ ...issue })), ...completenessIssues(unit)];
    const hasBlocking = issues.some((issue) => issue.blocking);
    const status = topicVerdict === 'out_of_scope' ? 'quarantine'
        : (topicVerdict === 'in_scope' && !hasBlocking ? 'pass' : 'needs_review');

    return qualityModel.createQualityVerdict({
        subjectType: 'knowledgeUnit',
        subjectId: unit?.title || 'unit',
        status,
        topic: { verdict: topicVerdict, reason: topicReason },
        claims,
        issues: status === 'pass' ? [] : [
            ...(topicVerdict !== 'in_scope' ? [{ code: `TOPIC_${topicVerdict.toUpperCase()}`, message: topicReason, blocking: topicVerdict === 'out_of_scope' }] : []),
            ...issues
        ],
        ruleVersion: QUALITY_RULE_VERSION,
        createdAt: new Date().toISOString()
    });
}

// ── 合并分类（§3.3.3） ───────────────────────────────────────────────────

function extractNumericClaims(text) {
    // 数值/规范级主张的指纹：比例（4.5:1）、P 级、阈值数字——分歧行政权交给
    // classifyMerge 的 conflict 分支，不在此处判断对错。
    const raw = String(text || '');
    const tokens = new Set();
    for (const match of raw.matchAll(/\d+(?:\.\d+)?\s*[:：]\s*1\b|P\d\b|≥?\s*\d+(?:\.\d+)?\s*(?:px|pt|列|项|倍)/g)) {
        tokens.add(match[0].replace(/\s+/g, ''));
    }
    return tokens;
}

/**
 * classifyMerge：unit 与目标卡的关系分类。
 * - source-only：正文高度一致（规范化正文重复）——只并来源（旧 fetchedAt 保留）；
 * - content-revision：正文有实质差异（新主张/修订表述）——须生成复核建议；
 * - conflict：数值/规范级主张互相矛盾——不得自动选择"看起来更新"的一条。
 * 跨子技能合并的拦截（一律 needs_review）由调用方用 subskill 比对完成。
 */
function classifyMerge({ unit, targetCard }) {
    const normalize = (text) => normalizeForQuoteMatch(String(text || ''))
        .replace(/[，。！？；：""''（）、]/g, '');
    const unitBody = normalize(unit?.content);
    const cardBody = normalize(targetCard?.content || targetCard?.body || '');
    if (!unitBody || !cardBody) {
        return 'content-revision'; // 无法确认一致性 → 按内容型处理
    }
    if (unitBody === cardBody) {
        return 'source-only';
    }
    const shorter = Math.min(unitBody.length, cardBody.length);
    const longer = Math.max(unitBody.length, cardBody.length);
    // 只允许"单元 ⊂ 旧卡"（重蒸子集，无新增主张）；单元是超集 = 有补充内容，
    // 静默并来源会丢弃新增主张 → 必须走 content-revision 复核（§3.3.3）。
    if (shorter >= 200 && unitBody.length <= cardBody.length
        && cardBody.includes(unitBody.slice(0, Math.floor(shorter * 0.8)))) {
        return 'source-only';
    }
    if (shorter / longer > 0.85) {
        // 高相似但不相同：数值类主张不同 → conflict，否则 content-revision。
        const unitNumbers = extractNumericClaims(unit.content);
        const cardNumbers = extractNumericClaims(targetCard.content || targetCard.body);
        const divergingNumbers = [...unitNumbers].filter((token) => !cardNumbers.has(token));
        return divergingNumbers.length > 0 ? 'conflict' : 'content-revision';
    }
    return 'content-revision';
}

// ── 索引就绪门禁（§3.6.1 合取条件） ────────────────────────────────────

const DEFAULT_INDEX_READINESS_TIMEOUT_MS = 5 * 60 * 1000;
const INDEX_READINESS_POLL_MS = 3000;

function readinessFail(reasons) {
    return { ok: false, reasons, checkedAt: new Date().toISOString() };
}

/**
 * §3.6.1 合取：initialized && initializationState==compatible && 队列收敛 &&
 * 每个预期文件正向探针命中 &&（有内容型合并时）新正文探针命中。
 * pendingIngestCount 是全局计数只作辅助——"短暂为零"不构成成功，
 * 探针命中才是就绪证据。端口能力缺失（未知）一律 fail closed。
 */
async function assertIndexReady({ knowledgeStorePort, expectedFiles = [], probes = [], timeoutMs = null, pollIntervalMs = INDEX_READINESS_POLL_MS, logger = null }) {
    const effectiveTimeoutMs = Number(timeoutMs) || Number(process.env.FORGE_INDEX_READINESS_TIMEOUT_MS)
        || DEFAULT_INDEX_READINESS_TIMEOUT_MS;
    const deadline = Date.now() + effectiveTimeoutMs;
    const reasons = [];

    if (!knowledgeStorePort || knowledgeStorePort.available === false) {
        return readinessFail(['knowledge store port 不可用（TDB 未启用）——未知状态不得放行（§3.6.1）']);
    }
    if (typeof knowledgeStorePort.search !== 'function') {
        return readinessFail(['knowledge store 端口缺少 search 能力']);
    }

    // 状态与队列：getInitializationStatus 可选暴露；缺状态能力按未知处理（fail closed）。
    const stateFn = knowledgeStorePort.getInitializationStatus;
    const pendingFn = knowledgeStorePort.pendingIngestCount;

    // 探针定义：{query, library, expectSourceFile}（explore:false 的正向探针）。
    const allProbes = [
        ...expectedFiles.map((file) => ({ query: String(file).split('/').pop()?.replace(/[-_]/g, ' ').replace(/\.(md|txt)$/, '') || file, library: String(file).split('/')[0], expectSourceFile: file })),
        ...probes
    ];

    let lastSnapshot = null;
    while (Date.now() < deadline) {
        const snapshot = {};
        if (typeof stateFn === 'function') {
            try {
                const status = stateFn();
                snapshot.state = status?.state;
                snapshot.initialized = status?.initialized;
            } catch (error) {
                return readinessFail([`getInitializationStatus 失败：${error.message}`]);
            }
        } else {
            // 红线 5：未知状态不得放行——端口缺状态能力即 fail closed。
            return readinessFail(['端口未暴露 getInitializationStatus——索引状态未知，不得放行（§3.6.1）']);
        }
        if (typeof pendingFn === 'function') {
            try {
                snapshot.pending = pendingFn();
            } catch (error) {
                snapshot.pending = null;
            }
        }
        lastSnapshot = snapshot;

        reasons.length = 0;
        if (snapshot.initialized === false || snapshot.state === 'uninitialized' || snapshot.state === 'disabled') {
            reasons.push(`store 未初始化（state=${snapshot.state}）`);
        } else if (snapshot.state && !['compatible', 'empty'].includes(snapshot.state)) {
            reasons.push(`store 状态非 compatible：${snapshot.state}`);
        }
        if (snapshot.pending === null) {
            reasons.push('队列状态未知（pendingIngestCount 不可用）');
        } else if (snapshot.pending > 0) {
            reasons.push(`队列未收敛（pending=${snapshot.pending}）`);
        }

        // 全部探针：预期 sourceFile 命中才算过（任一未命中继续轮询直到超时）。
        // expectAny（trial 开考）：库内任一 sourceFile 命中即过——考卷探针
        // 关心的是"库可检索"，不绑定具体文件。
        let probesPassed = 0;
        for (const probe of allProbes) {
            try {
                const hits = await knowledgeStorePort.search(probe.query, { libraries: [probe.library], topK: 5, expand: false });
                const hit = probe.expectAny
                    ? (hits || []).some((item) => String(item.sourceFile || '').startsWith(`${probe.library}/`))
                    : (hits || []).some((item) => item.sourceFile === probe.expectSourceFile || item.sourceFile?.endsWith(`/${probe.expectSourceFile}`));
                if (hit) probesPassed += 1;
                else reasons.push(`探针未命中：${probe.expectAny ? `${probe.library}（库内任意卡）` : probe.expectSourceFile}（query="${probe.query.slice(0, 40)}"）`);
            } catch (error) {
                reasons.push(`探针查询失败：${error.message}`);
            }
        }

        if (reasons.length === 0 && allProbes.length > 0 && probesPassed === allProbes.length) {
            return {
                ok: true,
                reasons: [],
                probesPassed,
                probesTotal: allProbes.length,
                snapshot: lastSnapshot,
                elapsedMs: effectiveTimeoutMs - (deadline - Date.now()),
                checkedAt: new Date().toISOString()
            };
        }
        if (reasons.length === 0 && allProbes.length === 0) {
            // 无预期文件（零产物）时不因探针空集放行——由调用方按"零合格产物"分支处理。
            return readinessFail(['无预期文件与探针（零产物不构成索引就绪）']);
        }
        logger?.(`index readiness：未就绪（${reasons.slice(0, 3).join('；')}），${Math.floor((deadline - Date.now()) / 1000)}s 后超时`);
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return readinessFail([`索引就绪超时（${effectiveTimeoutMs}ms）：${reasons.slice(0, 3).join('；')}`, JSON.stringify(lastSnapshot)]);
}

module.exports = {
    QUALITY_RULE_VERSION,
    assessMaterial,
    assessUnit,
    verifyClaims,
    classifyMerge,
    assertIndexReady,
    // 测试与复用
    tokenize,
    quoteMatchesEvidence,
    completenessIssues,
    promisedItemCount,
    normalizeForQuoteMatch,
    DEFAULT_INDEX_READINESS_TIMEOUT_MS
};
