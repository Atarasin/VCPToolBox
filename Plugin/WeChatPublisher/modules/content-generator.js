const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

function estimateLength(text) {
    return String(text || '').replace(/\s+/g, '').length;
}

function buildTitle(repo) {
    return `${repo.name}：值得关注的 AI 开源项目`;
}

function buildBody(repo) {
    const paragraphA = `今天推荐一个在 GitHub 上热度持续上升的项目：${repo.full_name}。该项目目前累计 ${repo.stars} 个 Stars、${repo.forks} 个 Forks，最近仍保持活跃更新，说明社区关注度与维护状态都比较稳健。`;
    const paragraphB = `从定位上看，${repo.name} 聚焦于 ${repo.description || 'AI 相关能力建设'}，适合用于快速验证想法、构建原型，或直接集成到现有工作流中。对技术团队来说，它的价值不止在“能跑起来”，还在于可以作为可复用模块缩短开发周期。`;
    const paragraphC = `在应用场景上，${repo.name} 可以用于研发团队的效率增强、业务侧的智能化能力补齐，以及教学和研究中的案例复现。对于想快速构建 MVP 的团队，它通常能显著降低从“概念验证”到“可演示版本”的时间成本。`;
    const paragraphD = `建议从三个角度评估该项目：第一，功能边界是否与当前业务痛点匹配；第二，社区活跃度与版本节奏是否可持续；第三，二次开发成本是否可控。完成这三步后，再决定是直接接入、二次封装还是仅作为技术参考。`;
    const paragraphE = `如果你正在持续跟踪 AI 工具链和开源生态，${repo.name} 值得加入本周重点观察列表，优先阅读 README、Issue 区和近期提交记录，并结合实际业务目标制定试用计划。`;
    return [paragraphA, paragraphB, paragraphC, paragraphD, paragraphE].join('\n\n');
}

function buildDraft(repo, now = new Date()) {
    const body = buildBody(repo);
    return {
        draft_id: `draft_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`,
        created_at: now.toISOString(),
        source: repo,
        title: buildTitle(repo),
        body,
        word_count: estimateLength(body),
        references: [
            {
                type: 'github',
                name: repo.full_name,
                url: repo.url,
                owner: repo.owner
            }
        ]
    };
}

async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

async function generateDrafts(corpus, options = {}) {
    if (!Array.isArray(corpus)) {
        throw new Error('阶段2输入必须是项目数组');
    }
    const now = options.now || new Date();
    const pluginRoot = options.pluginRoot || path.join(__dirname, '..');
    const outputDir = path.join(pluginRoot, 'data', 'output');
    await ensureDir(outputDir);

    const drafts = corpus.map(repo => buildDraft(repo, now));
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(outputDir, `stage2-drafts-${timestamp}.json`);
    await fs.writeFile(
        filePath,
        JSON.stringify(
            {
                generated_at: now.toISOString(),
                total: drafts.length,
                drafts
            },
            null,
            2
        ),
        'utf-8'
    );
    return {
        generatedAt: now.toISOString(),
        total: drafts.length,
        drafts,
        snapshotPath: filePath
    };
}

module.exports = {
    generateDrafts,
    buildDraft,
    estimateLength
};
