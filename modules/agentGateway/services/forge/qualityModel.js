'use strict';

/**
 * 砚尺质量闭环的最小数据契约（设计 §2.3，M2.S1 T9）。
 *
 * 五个结构全部带构造期校验：缺必填字段直接抛 coded error——
 * "缺少必填字段不得 active"在数据入口就拦住，而不是等到发布。
 *
 * 时间统一 ISO 8601；哈希统一 sha256: 前缀。本模块纯函数、无 I/O、
 * 无 env 依赖（测试与生产同构）。
 */

const RULE_VERSION = 'forge-quality-v1';

const SUBJECT_TYPES = new Set(['material', 'knowledgeUnit', 'mergeProposal']);
const VERDICT_STATUSES = new Set(['pass', 'needs_review', 'quarantine']);
const TOPIC_VERDICTS = new Set(['in_scope', 'adjacent', 'out_of_scope', 'uncertain']);
const CLAIM_KINDS = new Set(['normative', 'factual', 'heuristic', 'opinion']);
const CLAIM_SUPPORT = new Set(['supported', 'unsupported', 'conflicted', 'uncertain']);
const SOURCE_TYPES = new Set(['official-standard', 'official-doc', 'secondary', 'ugc', 'other']);
const MANIFEST_STATUSES = new Set(['active', 'needs_review', 'failed']);
const CARD_QUALITY_STATUSES = new Set(['active', 'needs_review', 'quarantine']);
const CARD_INDEX_STATUSES = new Set(['verified', 'pending', 'failed']);

function codedError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function invalid(field, reason, subject) {
    return codedError('FORGE_QUALITY_MODEL_INVALID', `${subject ?? 'qualityModel'} 字段 ${field} 无效：${reason}`, { field, reason });
}

function assertIsoString(value, field, subject) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw invalid(field, '必须为 ISO 8601 字符串', subject);
    }
}

function assertSha256(value, field, subject) {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw invalid(field, '必须为 sha256:<64hex>', subject);
    }
}

function assertUrl(value, field, subject) {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value)) {
        throw invalid(field, '必须为 http(s) URL', subject);
    }
}

function assertNonEmptyString(value, field, subject) {
    if (typeof value !== 'string' || !value.trim()) {
        throw invalid(field, '必须为非空字符串', subject);
    }
}

// ── DiscoveryItem（§2.3.1）───────────────────────────────────────────────
// 搜索摘要仅用于发现；structured 保留插件原始结构化字段，
// 不得用 Markdown 反解析替代已有 details/structuredContent。

function createDiscoveryItem(input) {
    assertNonEmptyString(input?.title, 'title', 'DiscoveryItem');
    assertUrl(input?.url, 'url', 'DiscoveryItem');
    assertNonEmptyString(input?.provider, 'provider', 'DiscoveryItem');
    assertNonEmptyString(input?.query, 'query', 'DiscoveryItem');
    const rank = Number(input?.rank);
    if (!Number.isInteger(rank) || rank < 1) {
        throw invalid('rank', '必须为 ≥1 的整数', 'DiscoveryItem');
    }
    if (input?.publishedAt !== null && input?.publishedAt !== undefined) {
        assertIsoString(input.publishedAt, 'publishedAt', 'DiscoveryItem');
    }
    return Object.freeze({
        title: input.title,
        url: input.url,
        snippet: typeof input.snippet === 'string' ? input.snippet : '',
        provider: input.provider,
        query: input.query,
        rank,
        publishedAt: input?.publishedAt ?? null,
        structured: input?.structured && typeof input.structured === 'object' ? input.structured : {}
    });
}

// ── EvidenceDocument（§2.3.2）───────────────────────────────────────────
// 正文为空/应用壳/提取错误/截断必须显式记录；提取失败不得写成空正文成功。

const FETCH_TOOLS = new Set(['UrlFetch', 'ParallelSearch', 'AnySearch', 'ChromeBridge']);
const FETCH_MODES = new Set(['text', 'web_fetch', 'extract', 'get_page_info']);

function createEvidenceDocument(input) {
    assertUrl(input?.url, 'url', 'EvidenceDocument');
    if (input?.finalUrl !== null && input?.finalUrl !== undefined) {
        assertUrl(input.finalUrl, 'finalUrl', 'EvidenceDocument');
    }
    assertIsoString(input?.fetchedAt, 'fetchedAt', 'EvidenceDocument');
    if (!FETCH_TOOLS.has(input?.fetchTool)) {
        throw invalid('fetchTool', `必须为 ${[...FETCH_TOOLS].join(' | ')}`, 'EvidenceDocument');
    }
    if (!FETCH_MODES.has(input?.fetchMode)) {
        throw invalid('fetchMode', `必须为 ${[...FETCH_MODES].join(' | ')}`, 'EvidenceDocument');
    }
    assertNonEmptyString(input?.contentPath, 'contentPath', 'EvidenceDocument');
    assertSha256(input?.contentHash, 'contentHash', 'EvidenceDocument');
    if (typeof input?.truncated !== 'boolean') {
        throw invalid('truncated', '必须为布尔', 'EvidenceDocument');
    }
    if (input?.fetchError !== null && input?.fetchError !== undefined) {
        assertNonEmptyString(input.fetchError, 'fetchError', 'EvidenceDocument');
    }
    if (!SOURCE_TYPES.has(input?.sourceType)) {
        throw invalid('sourceType', `必须为 ${[...SOURCE_TYPES].join(' | ')}`, 'EvidenceDocument');
    }
    return Object.freeze({
        url: input.url,
        finalUrl: input?.finalUrl ?? null,
        fetchedAt: input.fetchedAt,
        fetchTool: input.fetchTool,
        fetchMode: input.fetchMode,
        contentPath: input.contentPath,
        contentHash: input.contentHash,
        truncated: input.truncated,
        fetchError: input?.fetchError ?? null,
        sourceType: input.sourceType
    });
}

// ── Claim 与 ClaimEvidence（§2.3.3）─────────────────────────────────────

function createClaimEvidence(input) {
    assertUrl(input?.url, 'evidence.url', 'Claim');
    assertSha256(input?.contentHash, 'evidence.contentHash', 'Claim');
    assertNonEmptyString(input?.quote, 'evidence.quote', 'Claim');
    return Object.freeze({ url: input.url, contentHash: input.contentHash, quote: input.quote });
}

function createClaim(input) {
    assertNonEmptyString(input?.id, 'id', 'Claim');
    assertNonEmptyString(input?.text, 'text', 'Claim');
    if (!CLAIM_KINDS.has(input?.kind)) {
        throw invalid('kind', `必须为 ${[...CLAIM_KINDS].join(' | ')}`, 'Claim');
    }
    assertNonEmptyString(input?.scope, 'scope', 'Claim');
    const evidence = (Array.isArray(input?.evidence) ? input.evidence : []).map(createClaimEvidence);
    if (!CLAIM_SUPPORT.has(input?.support)) {
        throw invalid('support', `必须为 ${[...CLAIM_SUPPORT].join(' | ')}`, 'Claim');
    }
    // §3.5.3：normative/factual 需要证据——数据层强制非空 evidence。
    if ((input.kind === 'normative' || input.kind === 'factual') && input.support === 'supported' && evidence.length === 0) {
        throw invalid('evidence', `${input.kind} 主张标记 supported 必须携带证据`, 'Claim');
    }
    return Object.freeze({
        id: input.id,
        text: input.text,
        kind: input.kind,
        scope: input.scope,
        evidence,
        support: input.support
    });
}

// ── QualityVerdict（§2.3.3）─────────────────────────────────────────────

function createQualityIssue(input) {
    assertNonEmptyString(input?.code, 'issues[].code', 'QualityVerdict');
    assertNonEmptyString(input?.message, 'issues[].message', 'QualityVerdict');
    if (typeof input?.blocking !== 'boolean') {
        throw invalid('issues[].blocking', '必须为布尔', 'QualityVerdict');
    }
    return Object.freeze({ code: input.code, message: input.message, blocking: input.blocking });
}

function createQualityVerdict(input) {
    if (!SUBJECT_TYPES.has(input?.subjectType)) {
        throw invalid('subjectType', `必须为 ${[...SUBJECT_TYPES].join(' | ')}`, 'QualityVerdict');
    }
    assertNonEmptyString(input?.subjectId, 'subjectId', 'QualityVerdict');
    if (!VERDICT_STATUSES.has(input?.status)) {
        throw invalid('status', `必须为 ${[...VERDICT_STATUSES].join(' | ')}`, 'QualityVerdict');
    }
    if (!input?.topic || !TOPIC_VERDICTS.has(input.topic.verdict)) {
        throw invalid('topic.verdict', `必须为 ${[...TOPIC_VERDICTS].join(' | ')}`, 'QualityVerdict');
    }
    assertNonEmptyString(input?.topic?.reason, 'topic.reason', 'QualityVerdict');
    const claims = (Array.isArray(input?.claims) ? input.claims : []).map(createClaim);
    const issues = (Array.isArray(input?.issues) ? input.issues : []).map(createQualityIssue);
    // 阻断性 issue 不得与 pass 并存——机器规则先于人工复核。
    if (input.status === 'pass' && issues.some((issue) => issue.blocking)) {
        throw invalid('status', '存在 blocking issue 时不得 pass', 'QualityVerdict');
    }
    return Object.freeze({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: input.status,
        topic: Object.freeze({ verdict: input.topic.verdict, reason: input.topic.reason }),
        claims: Object.freeze(claims),
        issues: Object.freeze(issues),
        ruleVersion: input?.ruleVersion ?? RULE_VERSION,
        createdAt: input?.createdAt ?? new Date().toISOString()
    });
}

// ── PublicationManifest（§2.3.4）────────────────────────────────────────
// 多文件发布以 manifest 为提交点；revision 只在索引验证成功后推进。

function createPublicationCard(input) {
    assertNonEmptyString(input?.cardId, 'cards[].cardId', 'PublicationManifest');
    assertNonEmptyString(input?.activePath, 'cards[].activePath', 'PublicationManifest');
    assertSha256(input?.contentHash, 'cards[].contentHash', 'PublicationManifest');
    if (!CARD_QUALITY_STATUSES.has(input?.qualityStatus)) {
        throw invalid('cards[].qualityStatus', `必须为 ${[...CARD_QUALITY_STATUSES].join(' | ')}`, 'PublicationManifest');
    }
    if (!CARD_INDEX_STATUSES.has(input?.indexStatus)) {
        throw invalid('cards[].indexStatus', `必须为 ${[...CARD_INDEX_STATUSES].join(' | ')}`, 'PublicationManifest');
    }
    assertIsoString(input?.publishedAt, 'cards[].publishedAt', 'PublicationManifest');
    // active 卡必须已过索引验证（§2.2：内容、索引和发布验收全部通过才 active）。
    if (input.qualityStatus === 'active' && input.indexStatus !== 'verified') {
        throw invalid('cards[].indexStatus', 'qualityStatus=active 要求 indexStatus=verified', 'PublicationManifest');
    }
    return Object.freeze({
        cardId: input.cardId,
        activePath: input.activePath,
        contentHash: input.contentHash,
        qualityStatus: input.qualityStatus,
        indexStatus: input.indexStatus,
        publishedAt: input.publishedAt
    });
}

function createPublicationManifest(input) {
    if (Number(input?.schemaVersion) !== 1) {
        throw invalid('schemaVersion', '必须为 1', 'PublicationManifest');
    }
    assertNonEmptyString(input?.expertName, 'expertName', 'PublicationManifest');
    assertNonEmptyString(input?.libraryName, 'libraryName', 'PublicationManifest');
    const revision = Number(input?.revision);
    if (!Number.isInteger(revision) || revision < 1) {
        throw invalid('revision', '必须为 ≥1 的整数', 'PublicationManifest');
    }
    if (!MANIFEST_STATUSES.has(input?.status)) {
        throw invalid('status', `必须为 ${[...MANIFEST_STATUSES].join(' | ')}`, 'PublicationManifest');
    }
    assertNonEmptyString(input?.sourceJobId, 'sourceJobId', 'PublicationManifest');
    assertNonEmptyString(input?.qualityReport, 'qualityReport', 'PublicationManifest');
    const cards = (Array.isArray(input?.cards) ? input.cards : []).map(createPublicationCard);
    if (cards.length === 0) {
        throw invalid('cards', '至少一张卡', 'PublicationManifest');
    }
    // status=active 的清单不允许有未过索引的卡混入（needs_review 卡可并存，D4 单卡隔离）。
    if (input.status === 'active' && cards.some((card) => card.qualityStatus === 'active' && card.indexStatus !== 'verified')) {
        throw invalid('cards', 'active 清单中 active 卡必须 indexStatus=verified', 'PublicationManifest');
    }
    assertIsoString(input?.createdAt, 'createdAt', 'PublicationManifest');
    return Object.freeze({
        schemaVersion: 1,
        expertName: input.expertName,
        libraryName: input.libraryName,
        revision,
        status: input.status,
        sourceJobId: input.sourceJobId,
        qualityReport: input.qualityReport,
        cards: Object.freeze(cards),
        createdAt: input.createdAt
    });
}

module.exports = {
    RULE_VERSION,
    SUBJECT_TYPES,
    VERDICT_STATUSES,
    TOPIC_VERDICTS,
    CLAIM_KINDS,
    CLAIM_SUPPORT,
    SOURCE_TYPES,
    MANIFEST_STATUSES,
    createDiscoveryItem,
    createEvidenceDocument,
    createClaim,
    createClaimEvidence,
    createQualityVerdict,
    createPublicationManifest
};
