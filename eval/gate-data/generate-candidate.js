'use strict';

const fs = require('fs');
const path = require('path');
const { verifyRows } = require('../lib/gateDataset');

const targets = [
    {
        targetType: 'diary', library: '评测运维技术库', slug: 'ops',
        intents: [
            ['ops-rate-limiting', '评测运维技术库/限流治理', '高峰期的入口配额、队列缓冲和降级策略分别负责什么', 'calibration'],
            ['ops-rate-metrics', '评测运维技术库/限流治理', '判断流量治理是否有效时应重点观察哪些指标', 'calibration'],
            ['ops-error-retry', '评测运维技术库/接口错误码', '接口返回请求过多时客户端应如何退避并控制并发', 'calibration'],
            ['ops-migration-cause', '评测运维技术库/迁移复盘首轮', '机房切换后数据库排队并导致写入失败的因果链是什么', 'calibration'],
            ['ops-migration-recovery', '评测运维技术库/迁移复盘次轮', '迁移引发连接异常后值班人员采用了什么恢复步骤', 'calibration'],
            ['ops-cache-collapse', '评测运维技术库/缓存雪崩首例', '热点数据失效后请求穿透到底层时怎样避免服务整体失稳', 'calibration'],
            ['ops-gray-routing', '评测运维技术库/网关灰度判别', '网关修改灰度分流规则时需要留下哪些变更和回归记录', 'calibration'],
            ['ops-certificate', '评测运维技术库/证书握手异常', '边缘节点握手失败时怎样确认是否遗漏了证书轮换', 'holdout'],
            ['ops-archive-window', '评测运维技术库/衰减样本近期', '近期归档保留窗口调整后超出的数据会被放到哪里', 'holdout'],
            ['ops-release-rollback', '评测运维技术库/发布评审纪要', '发布期间满足哪些错误率或延迟条件就应该回滚', 'holdout']
        ]
    },
    {
        targetType: 'diary', library: '评测幻想设定库', slug: 'fiction',
        intents: [
            ['fiction-tide-star-gate', '评测幻想设定库/世界观核心法则', '梦境的涨落与星门回声之间有什么双向影响', 'calibration'],
            ['fiction-festival-route', '评测幻想设定库/古城祭典', '祭典巡游会沿什么路线进行以及要绕城几次', 'calibration'],
            ['fiction-role-reversal', '评测幻想设定库/古城祭典', '仪式期间守钥人与观星者的关系会发生什么变化', 'calibration'],
            ['fiction-echo-season', '评测幻想设定库/星门回响记述', '不同季节里星门发出的声音有什么变化', 'calibration'],
            ['fiction-keykeeper-lineage', '评测幻想设定库/守钥人谱系', '守钥人不同支系中哪一支拥有开启内门的资格', 'calibration'],
            ['fiction-calendar-cycle', '评测幻想设定库/潮汐历法', '历法的一个完整大周期包含多少次高潮和低潮', 'calibration'],
            ['fiction-observatory', '评测幻想设定库/观星台构造', '观星台如何校正历法推算产生的偏差', 'calibration'],
            ['fiction-pottery', '评测幻想设定库/陶土工艺', '祭典器皿烧制时为什么要避开潮水最盛的几天', 'holdout'],
            ['fiction-music-summer', '评测幻想设定库/点歌记录仲夏', '夏季收藏的音乐更偏好哪种演奏和录音形式', 'holdout'],
            ['fiction-playlist', '评测幻想设定库/播放列表整理', '整理收藏时播放列表是按什么维度分组的', 'holdout']
        ]
    },
    {
        targetType: 'diary', library: '评测容量运营库', slug: 'capacity',
        intents: [
            ['capacity-monthly-headroom', '评测容量运营库/容量规划月报', '当前最紧张的集群还保留了多少可用空间', 'calibration'],
            ['capacity-review-cadence', '评测容量运营库/容量规划月报', '为什么余量测算准备从每月一次改成每周一次', 'calibration'],
            ['capacity-guardrail', '评测容量运营库/容量护栏设计', '集群接近极限时上限约束会怎样调整入口流量', 'calibration'],
            ['capacity-guardrail-trigger', '评测容量运营库/容量护栏设计', '容量保护的触发点相对历史峰值设在什么位置', 'calibration'],
            ['capacity-scale-signal', '评测容量运营库/扩容时机判断', '决定增加机器时为什么要看连续趋势而不是瞬时负载', 'calibration'],
            ['capacity-handover-chart', '评测容量运营库/扩容时机判断', '容量交接时需要附带哪一种趋势图以避免重复计算', 'calibration'],
            ['capacity-pool-sizing', '评测容量运营库/数据库连接池调优', '连接池上限为什么需要随实例规格和核数一起变化', 'calibration'],
            ['capacity-cross-strategy', '评测容量运营库/整形策略跨库对照', '两套流量策略并列比较后最大的档位差异是什么', 'holdout'],
            ['capacity-handover-items', '评测容量运营库/值班交接规范', '值班交接清单必须列出哪三类待跟进信息', 'holdout'],
            ['capacity-cold-storage', '评测容量运营库/容量复核记录二', '把冷存占用单独统计后主库曲线发生了什么变化', 'holdout']
        ]
    },
    {
        targetType: 'diary', library: 'vcp知识库', slug: 'collision',
        intents: [
            ['collision-suffix-rule', 'vcp知识库/占位符解析约定', '目录名带有知识库字样时如何判断它实际指向日记本', 'calibration'],
            ['collision-route-priority', 'vcp知识库/占位符解析约定', '名称发生歧义时哪一种后缀应获得更高的解析优先级', 'calibration'],
            ['collision-storage', 'vcp知识库/链路差异说明', '两种知识检索链路在底层存储方面有什么区别', 'calibration'],
            ['collision-score-comparison', 'vcp知识库/链路差异说明', '为什么来自两条检索链路的分数不能直接混在一起比较', 'calibration'],
            ['collision-registry-purpose', 'vcp知识库/命名冲突登记', '新增目录之前为什么要先查询已有的名称冲突记录', 'calibration'],
            ['collision-registry-update', 'vcp知识库/命名冲突登记', '发现新的同名歧义后应该把它登记到哪里', 'calibration'],
            ['collision-source-trace', 'vcp知识库/链路差异说明', '评测结果为什么必须分别保留两条链路的来源信息', 'calibration'],
            ['collision-regression-cases', 'vcp知识库/歧义回归要点', '名称歧义回归至少要覆盖哪三种占位符写法', 'holdout'],
            ['collision-diary-only', 'vcp知识库/歧义回归要点', '只带日记本后缀的目录名应走哪一条处理路径', 'holdout'],
            ['collision-mixed-name', 'vcp知识库/歧义回归要点', '目录名自身含有知识库二字时回归测试应怎样构造', 'holdout']
        ]
    },
    {
        targetType: 'cold', library: 'VCP知识', slug: 'cold',
        intents: [
            ['cold-system-role', 'knowledge/VCP百科全书/01_VCP系统总览与核心哲学.txt', 'VCP 在模型与外部工具之间承担什么核心角色', 'calibration'],
            ['cold-tool-protocol', 'knowledge/VCP百科全书/04_VCP指令协议语法.txt', '工具请求块使用哪些边界标记和字段组织参数', 'calibration'],
            ['cold-placeholders', 'knowledge/VCP百科全书/05_通用变量占位符系统.txt', '自定义变量占位符有哪些类别以及在何时展开', 'calibration'],
            ['cold-distributed', 'knowledge/VCP百科全书/06_分布式架构与星型网络.txt', '分布式节点怎样注册并把工具执行转发到远端', 'calibration'],
            ['cold-sync-plugin', 'knowledge/VCP百科全书/07_同步插件开发规范.txt', '同步插件的清单和标准输入输出应怎样定义', 'calibration'],
            ['cold-async-plugin', 'knowledge/VCP百科全书/08_异步插件开发规范.txt', '异步插件如何返回任务标识并在完成后传递结果', 'calibration'],
            ['cold-static-plugin', 'knowledge/VCP百科全书/09_静态插件与折叠协议.txt', '静态插件怎样通过系统提示词占位符暴露内容', 'calibration'],
            ['cold-diary-usage', 'knowledge/VCP百科全书/10_日记系统使用规范.txt', '日记内容怎样组织才能被记忆检索稳定使用', 'holdout'],
            ['cold-memory-modes', 'knowledge/VCP百科全书/139_VCP记忆_日记系统与记忆四模式.txt', '记忆系统的几种工作模式分别适合什么场景', 'holdout'],
            ['cold-vector-engine', 'knowledge/VCP百科全书/142_VCP记忆_SQLite重构与Rust向量引擎.txt', 'SQLite 重构后原生向量组件承担了哪些索引职责', 'holdout']
        ]
    }
];

const variants = [
    question => `${question}？`,
    question => `请说明：${question}？`,
    question => `能否解释一下，${question}？`,
    question => `我想确认，${question}。`,
    question => `从现有记录看，${question}？`,
    question => `如果要做一次复盘，${question}？`,
    question => `帮我梳理一下，${question}。`,
    question => `具体来说，${question}？`,
    question => `相关资料是怎么说明的：${question}？`,
    question => `请根据已有内容回答，${question}。`
];

const annotation = () => ({ status: 'pending', reviewCount: 0, reviewBatch: null, notes: null });
const normalizedTargets = targets.map(target => ({
    ...target,
    intents: target.intents.map(([id, sourceRef, question, split]) => ({ id, sourceRef, question, split }))
}));

function roundRobin(targetLists, split, count) {
    const pools = targetLists.map(target => target.intents.filter(intent => intent.split === split));
    const selected = [];
    for (let index = 0; selected.length < count; index++) {
        for (const pool of pools) {
            if (pool[index] && selected.length < count) selected.push(pool[index]);
        }
    }
    return selected;
}

const rows = [];
for (const target of normalizedTargets) {
    let positiveIndex = 0;
    for (const intent of target.intents) {
        for (const [variantIndex, render] of variants.entries()) {
            positiveIndex++;
            rows.push({
                id: `gate_${target.slug}_pos_${String(positiveIndex).padStart(3, '0')}`,
                targetType: target.targetType,
                library: target.library,
                query: render(intent.question),
                label: 'positive',
                difficulty: ['easy', 'near-domain', 'hard'][variantIndex % 3],
                source: 'corpus-derived',
                sourceRefs: [intent.sourceRef],
                intentGroup: intent.id,
                split: intent.split,
                annotation: annotation()
            });
        }
    }

    const otherTargets = normalizedTargets.filter(candidate => candidate !== target);
    const negativeIntents = [
        ...roundRobin(otherTargets, 'calibration', 14),
        ...roundRobin(otherTargets, 'holdout', 6)
    ];
    let negativeIndex = 0;
    for (const intent of negativeIntents) {
        for (const render of variants) {
            const difficulty = ['easy', 'near-domain', 'hard'][negativeIndex % 3];
            negativeIndex++;
            rows.push({
                id: `gate_${target.slug}_neg_${difficulty.replace('-', '')}_${String(negativeIndex).padStart(3, '0')}`,
                targetType: target.targetType,
                library: target.library,
                query: render(intent.question),
                label: 'negative',
                difficulty,
                source: 'cross-library',
                sourceRefs: [intent.sourceRef],
                intentGroup: intent.id,
                split: intent.split,
                annotation: annotation()
            });
        }
    }
}

const baseVerification = verifyRows(rows, {
    targets: normalizedTargets.map(({ targetType, library }) => ({ targetType, library }))
});
const miningPath = path.join(__dirname, 'gate-v1.mining.json');
let miningEvidence = null;
if (fs.existsSync(miningPath)) {
    miningEvidence = JSON.parse(fs.readFileSync(miningPath, 'utf8'));
    if (miningEvidence.inputDatasetHash !== baseVerification.datasetHash) {
        throw new Error('gate-v1 mining evidence does not match the generated base candidate');
    }
    const assignments = new Map((miningEvidence.cases || []).map(item => [item.caseId, item]));
    for (const row of rows) {
        if (row.label !== 'negative') continue;
        const assignment = assignments.get(row.id);
        if (!assignment || !['easy', 'near-domain', 'hard'].includes(assignment.assignedDifficulty)) {
            throw new Error(`gate-v1 mining evidence is incomplete for ${row.id}`);
        }
        row.difficulty = assignment.assignedDifficulty;
        row.source = assignment.source;
        row.id = assignment.outputCaseId;
        if (row.source === 'mined') row.annotation.notes = `mining-candidate:${miningEvidence.evidenceId}`;
    }
}

const manifest = {
    schemaVersion: 1,
    datasetId: 'gate-v1',
    annotationVersion: miningEvidence ? 'candidate-3-mined' : 'candidate-2',
    qualityLevel: 'candidate',
    status: 'awaiting-human-review',
    splitProtocol: {
        unit: 'intentGroup-and-source-document',
        calibrationRatio: 0.7,
        holdoutRatio: 0.3
    },
    targets: normalizedTargets.map(({ targetType, library }) => ({ targetType, library })),
    requirements: { positivePerTarget: 100, negativePerTarget: 200, hardNegativeReviewCount: 2 },
    generatedCandidateNotice: miningEvidence
        ? 'Natural-language candidates with real dual-profile score mining. Labels remain pending human confirmation.'
        : 'Natural-language candidates only. Labels require human confirmation; no mined or human-reviewed provenance is claimed.',
    miningEvidence: miningEvidence ? {
        evidenceId: miningEvidence.evidenceId,
        inputDatasetHash: miningEvidence.inputDatasetHash,
        algorithm: miningEvidence.algorithm,
        scoreEvidence: miningEvidence.scoreEvidence
    } : null
};
const verification = verifyRows(rows, manifest);
if (!verification.ok) {
    throw new Error(`generated gate candidate is invalid: ${JSON.stringify(verification.findings)}`);
}
manifest.hashes = {
    dataset: verification.datasetHash,
    calibration: verification.calibrationSplitHash,
    holdout: verification.holdoutSplitHash
};
manifest.counts = verification.counts;
manifest.annotation = verification.annotation;

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'gate-v1.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
fs.writeFileSync(path.join(dir, 'gate-v1.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
