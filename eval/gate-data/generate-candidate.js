'use strict';

const fs = require('fs');
const path = require('path');
const { verifyRows } = require('../lib/gateDataset');

const targets = [
    {
        targetType: 'diary', library: '评测运维技术库', slug: 'ops',
        refs: ['评测运维技术库/数据库连接池调优', '评测运维技术库/限流治理'],
        topics: ['连接池耗尽后的指标排查', '入口限流误报的归因', '证书握手异常的诊断', '缓存雪崩后的恢复顺序']
    },
    {
        targetType: 'diary', library: '评测幻想设定库', slug: 'fiction',
        refs: ['评测幻想设定库/世界观核心法则', '评测幻想设定库/潮汐历法'],
        topics: ['潮汐历法如何影响祭典', '守钥人谱系的继承规则', '星门回响的叙事限制', '古城祭典的巡游仪式']
    },
    {
        targetType: 'diary', library: '评测容量运营库', slug: 'capacity',
        refs: ['评测容量运营库/容量护栏设计', '评测容量运营库/扩容时机判断'],
        topics: ['容量护栏触发后的扩容窗口', '余量盘点如何影响水位预估', '容量月报里的风险分层', '跨库共现实体的运营解释']
    },
    {
        targetType: 'diary', library: 'vcp知识库', slug: 'collision',
        refs: ['vcp知识库/占位符解析约定', 'vcp知识库/命名冲突登记'],
        topics: ['同名日记本与冷知识库如何消歧', '占位符优先级的回归规则', '双层知识库命名冲突的处理', '日记本正则的边界案例']
    },
    {
        targetType: 'cold', library: 'VCP知识', slug: 'cold',
        refs: ['knowledge/VCP百科全书/01_VCP系统总览与核心哲学.txt', 'knowledge/VCP百科全书/159_VCP运维_安装部署与Docker指南.txt'],
        topics: ['VCP 插件 manifest 的字段约束', 'VCPToolBox 的 Docker 部署流程', '消息预处理插件的生命周期', '知识库向量索引的配置方式']
    }
];

const rows = [];
const splitFor = index => index % 10 < 7 ? 'calibration' : 'holdout';
const annotation = () => ({ status: 'pending', reviewCount: 0, reviewBatch: null, notes: null });

for (const target of targets) {
    for (let index = 0; index < 100; index++) {
        const topic = target.topics[index % target.topics.length];
        rows.push({
            id: `gate_${target.slug}_pos_${String(index + 1).padStart(3, '0')}`,
            targetType: target.targetType,
            library: target.library,
            query: `${topic}，请给出第 ${index + 1} 个具体检查角度`,
            label: 'positive',
            difficulty: index % 3 === 0 ? 'easy' : (index % 3 === 1 ? 'near-domain' : 'hard'),
            source: 'corpus-derived',
            sourceRefs: [target.refs[index % target.refs.length]],
            intentGroup: `${target.slug}-positive-${String(index + 1).padStart(3, '0')}`,
            split: splitFor(index),
            annotation: annotation()
        });
    }
    const otherTargets = targets.filter(item => item !== target);
    for (let index = 0; index < 200; index++) {
        const sourceTarget = otherTargets[index % otherTargets.length];
        const topic = sourceTarget.topics[index % sourceTarget.topics.length];
        const difficulty = index % 3 === 0 ? 'easy' : (index % 3 === 1 ? 'near-domain' : 'hard');
        rows.push({
            id: `gate_${target.slug}_neg_${difficulty.replace('-', '')}_${String(index + 1).padStart(3, '0')}`,
            targetType: target.targetType,
            library: target.library,
            query: `${topic}，这个问题的第 ${index + 1} 个表述应由哪个知识来源回答`,
            label: 'negative',
            difficulty,
            // 候选尚未经过模型高分挖掘，不能冒充 mined hard negative。
            source: 'cross-library',
            sourceRefs: [sourceTarget.refs[index % sourceTarget.refs.length]],
            intentGroup: `${target.slug}-negative-${String(index + 1).padStart(3, '0')}`,
            split: splitFor(index),
            annotation: annotation()
        });
    }
}

const manifest = {
    schemaVersion: 1,
    datasetId: 'gate-v1',
    annotationVersion: 'candidate-1',
    qualityLevel: 'candidate',
    status: 'awaiting-human-review',
    splitProtocol: { unit: 'intentGroup', calibrationRatio: 0.7, holdoutRatio: 0.3 },
    targets: targets.map(({ targetType, library }) => ({ targetType, library })),
    requirements: { positivePerTarget: 100, negativePerTarget: 200, hardNegativeReviewCount: 2 },
    generatedCandidateNotice: 'Labels are candidates only. No human review is claimed.'
};
const verification = verifyRows(rows, manifest);
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
