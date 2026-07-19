const crypto = require('crypto');

const { normalizeString } = require('./shared/normalize');

/**
 * Discovery 确定规则与冻结快照（§3.4 / M1.S5）。
 *
 * - bound credential：canonical gateway tools + 该 agent 可见动态工具；
 *   resources 只含该 agent。
 * - unbound credential：tools 仅 canonical（不合并 per-agent 动态工具）；
 *   resources 按稳定 agentId 排序枚举 allowedAgents；admin 按全量可见
 *   集合执行同一规则。
 * - prompts 始终只返回 canonical descriptor。
 * - initialize 成功时生成 `{ discoveryRevision, tools, resources, prompts,
 *   visibleAgents }` 只读快照；cursor 绑定 revision 与 credential subject，
 *   不能跨 revision / 跨 subject 使用。
 * - 自定义 discovery agentId 仅作收窄扩展：越界返回空集合。
 */

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function computeVisibleAgents(credential, allAgentIds = []) {
    const knownAgents = [...new Set(allAgentIds.map((agentId) => normalizeString(agentId)).filter(Boolean))].sort();
    const boundAgentId = normalizeString(credential?.boundAgentId);
    if (boundAgentId) {
        return knownAgents.includes(boundAgentId) ? [boundAgentId] : [];
    }
    const scopes = Array.isArray(credential?.scopes) ? credential.scopes : [];
    if (scopes.includes('admin')) {
        return knownAgents;
    }
    const allowedAgents = Array.isArray(credential?.allowedAgents) ? credential.allowedAgents : [];
    const allowed = new Set(allowedAgents.map((agentId) => normalizeString(agentId)).filter(Boolean));
    return knownAgents.filter((agentId) => allowed.has(agentId));
}

/**
 * @param {object} input.credential 规范化 credential record（builtin 或文件）
 * @param {string} input.credentialSubject cursor 绑定主体
 * @param {string[]} input.allAgentIds agent directory 全集
 * @param {object[]} input.canonicalTools canonical gateway tool descriptors
 * @param {object[]} input.canonicalPrompts canonical prompt descriptors
 * @param {function} input.dynamicToolsForAgent (agentId) => descriptor[]（bound 专用）
 * @param {function} input.resourcesForAgent (agentId) => resource descriptor[]
 */
function buildDiscoverySnapshot({
    credential,
    credentialSubject,
    allAgentIds = [],
    canonicalTools = [],
    canonicalPrompts = [],
    dynamicToolsForAgent = () => [],
    resourcesForAgent = () => []
} = {}) {
    const visibleAgents = computeVisibleAgents(credential, allAgentIds);
    const boundAgentId = normalizeString(credential?.boundAgentId);

    let tools = [...canonicalTools];
    if (boundAgentId && visibleAgents.includes(boundAgentId)) {
        tools = [...tools, ...(dynamicToolsForAgent(boundAgentId) || [])];
    }
    tools = tools.slice().sort((left, right) => String(left.name).localeCompare(String(right.name)));

    const resources = visibleAgents.flatMap((agentId) => resourcesForAgent(agentId) || []);
    const prompts = [...canonicalPrompts];

    const subject = normalizeString(credentialSubject) || normalizeString(credential?.credentialId);
    const discoveryRevision = `sha256:${sha256Hex(JSON.stringify({
        subject,
        visibleAgents,
        tools: tools.map((tool) => tool.name),
        resources: resources.map((resource) => resource.uri || resource.name),
        prompts: prompts.map((prompt) => prompt.name)
    }))}`;

    return Object.freeze({
        discoveryRevision,
        credentialSubject: subject,
        visibleAgents: Object.freeze(visibleAgents),
        tools: Object.freeze(tools.map(Object.freeze)),
        resources: Object.freeze(resources.map(Object.freeze)),
        prompts: Object.freeze(prompts.map(Object.freeze))
    });
}

/**
 * 自定义 discovery agentId 收窄扩展：越界返回空集合（不报错，§3.4）。
 */
function narrowSnapshotToAgent(snapshot, agentId) {
    const normalizedAgentId = normalizeString(agentId);
    if (!normalizedAgentId) {
        return snapshot;
    }
    if (!snapshot.visibleAgents.includes(normalizedAgentId)) {
        return Object.freeze({
            ...snapshot,
            visibleAgents: Object.freeze([]),
            tools: Object.freeze([]),
            resources: Object.freeze([]),
            prompts: snapshot.prompts
        });
    }
    return Object.freeze({
        ...snapshot,
        visibleAgents: Object.freeze([normalizedAgentId]),
        resources: Object.freeze(snapshot.resources.filter(
            (resource) => String(resource.uri || '').includes(`/${normalizedAgentId}/`) ||
                resource.agentId === normalizedAgentId
        ))
    });
}

function encodeDiscoveryCursor({ revision, subject, offset }) {
    return Buffer.from(JSON.stringify({ revision, subject, offset }), 'utf8').toString('base64url');
}

function decodeDiscoveryCursor(cursor) {
    try {
        const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const offset = Number(parsed.offset);
        if (!Number.isInteger(offset) || offset < 0) {
            return null;
        }
        return { revision: normalizeString(parsed.revision), subject: normalizeString(parsed.subject), offset };
    } catch (_error) {
        return null;
    }
}

/**
 * 从冻结快照分页读取；cursor 不能跨 discovery revision 或 credential subject。
 */
function readSnapshotPage(snapshot, kind, { cursor = null, pageSize = 50 } = {}) {
    const items = snapshot[kind];
    if (!items) {
        return { ok: false, reason: `unknown discovery kind "${kind}"` };
    }
    let offset = 0;
    if (cursor) {
        const decoded = decodeDiscoveryCursor(cursor);
        if (!decoded) {
            return { ok: false, reason: 'malformed cursor' };
        }
        if (decoded.revision !== snapshot.discoveryRevision) {
            return { ok: false, reason: 'cursor bound to a different discovery revision' };
        }
        if (decoded.subject !== snapshot.credentialSubject) {
            return { ok: false, reason: 'cursor bound to a different credential subject' };
        }
        offset = decoded.offset;
    }
    const page = items.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
        ok: true,
        items: page,
        nextCursor: nextOffset < items.length
            ? encodeDiscoveryCursor({
                revision: snapshot.discoveryRevision,
                subject: snapshot.credentialSubject,
                offset: nextOffset
            })
            : null
    };
}

const DISCOVERY_SNAPSHOT_HOLDER = Symbol('agentGateway.discoverySnapshotHolder');

function createDiscoverySnapshotHolder() {
    // 每个 MCP session/connection 一个 holder：list 结果首次计算后冻结，
    // 同 session 后续 list 稳定（listChanged:false，§3.4）；新 session 见新配置。
    return { frozen: Object.create(null) };
}

function serveFrozenList(input, kind, compute) {
    const holder = input?.[DISCOVERY_SNAPSHOT_HOLDER];
    if (holder?.frozen?.[kind]) {
        return holder.frozen[kind];
    }
    const result = compute();
    if (holder && result && typeof result.then !== 'function') {
        holder.frozen[kind] = result;
    } else if (holder && result?.then) {
        return result.then((resolved) => {
            holder.frozen[kind] = resolved;
            return resolved;
        });
    }
    return result;
}

module.exports = {
    DISCOVERY_SNAPSHOT_HOLDER,
    createDiscoverySnapshotHolder,
    serveFrozenList,
    buildDiscoverySnapshot,
    computeVisibleAgents,
    decodeDiscoveryCursor,
    encodeDiscoveryCursor,
    narrowSnapshotToAgent,
    readSnapshotPage
};
