const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    BLUEPRINT_SCHEMA_VERSION,
    DEFAULT_MAX_MODEL_COST_CNY,
    validateBlueprint,
    normalizeBlueprint,
    readBlueprint,
    writeBlueprint,
    blueprintLibraryName,
    listBlueprintNames
} = require('../../../modules/agentGateway/services/forge/blueprint');
const { BLUEPRINT_DRAFT_PROMPT } = require('../../../modules/agentGateway/services/forge/steps');

// 验收（M1.S1）：给定「UI 设计专家」一句话需求产出的画像（§3.1 示例）
// 通过全部校验规则，落盘文件含默认预算 10 元。
function buildUiDesignerBlueprint(overrides = {}) {
    const blueprint = {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: {
            responsibilities: ['落地页/UI 界面设计评审', '组件规范建议', '配色与排版方案'],
            boundaries: ['不做前端代码实现', '不做人机交互研究']
        },
        subskills: [
            {
                id: 'color-theory',
                title: '配色理论',
                searchQueries: ['color theory UI design', '配色理论 界面设计'],
                sourceHints: ['官方文档优先', '经典书籍优先']
            },
            {
                id: 'layout-typography',
                title: '版式与排版',
                searchQueries: ['layout typography principles', '排版 网格系统']
            }
        ],
        sourcePolicy: {
            preferOfficialDocs: true,
            minDomainsPerSubskill: 3,
            qualityFilter: '丢弃营销软文/无实质内容/严重过时内容，丢弃理由留档'
        },
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
    return { ...blueprint, ...overrides };
}

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-blueprint-'));
}

test('forge blueprint: UI 设计专家画像通过全部校验并落盘，预算缺省补 10 元', async () => {
    const dir = createTempDir();
    const blueprintPath = path.join(dir, 'UIDesigner.json');

    const written = await writeBlueprint(blueprintPath, buildUiDesignerBlueprint());
    assert.equal(written.schemaVersion, BLUEPRINT_SCHEMA_VERSION);
    assert.equal(written.budget.maxModelCostCny, DEFAULT_MAX_MODEL_COST_CNY);
    assert.equal(written.budget.maxModelCostCny, 10);

    const onDisk = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    assert.equal(onDisk.name, 'UIDesigner');
    assert.equal(onDisk.budget.maxModelCostCny, 10);

    const readBack = await readBlueprint(blueprintPath);
    assert.deepEqual(readBack.subskills, written.subskills);
    assert.equal(readBack.budget.maxModelCostCny, 10);

    assert.equal(blueprintLibraryName('UIDesigner'), 'UIDesigner知识库');
    assert.deepEqual(listBlueprintNames(dir), ['UIDesigner']);
});

test('forge blueprint: 显式预算与 sourcePolicy 默认值归一化', () => {
    const normalized = normalizeBlueprint(buildUiDesignerBlueprint({ budget: { maxModelCostCny: 25 } }));
    assert.equal(normalized.budget.maxModelCostCny, 25);
    const withoutPolicy = normalizeBlueprint({ ...buildUiDesignerBlueprint(), sourcePolicy: undefined });
    assert.equal(withoutPolicy.sourcePolicy, undefined);
    const withPartialPolicy = normalizeBlueprint({
        ...buildUiDesignerBlueprint(),
        sourcePolicy: { qualityFilter: '只保留官方文档' }
    });
    assert.equal(withPartialPolicy.sourcePolicy.preferOfficialDocs, true);
    assert.equal(withPartialPolicy.sourcePolicy.minDomainsPerSubskill, 3);
});

test('forge blueprint: 校验规则逐项拒绝非法画像', () => {
    const cases = [
        {
            name: '空 name',
            mutate: (b) => { b.name = ''; },
            field: 'name'
        },
        {
            name: '非法文件名字符',
            mutate: (b) => { b.name = 'UI 设计师'; },
            field: 'name'
        },
        {
            name: '缺 displayName',
            mutate: (b) => { delete b.displayName; },
            field: 'displayName'
        },
        {
            name: '空 subskills',
            mutate: (b) => { b.subskills = []; },
            field: 'subskills'
        },
        {
            name: 'subskill 缺 searchQueries',
            mutate: (b) => { delete b.subskills[0].searchQueries; },
            field: 'subskills[0].searchQueries'
        },
        {
            name: 'subskill id 重复',
            mutate: (b) => { b.subskills[1].id = 'color-theory'; },
            field: 'subskills[1].id'
        },
        {
            name: 'examOutline 未覆盖全部 subskills',
            mutate: (b) => { b.examOutline = b.examOutline.slice(0, 1); },
            field: 'examOutline'
        },
        {
            name: 'examOutline 含未知 subskillId',
            mutate: (b) => { b.examOutline[1].subskillId = 'not-a-subskill'; },
            field: 'examOutline'
        },
        {
            name: 'practicalExam 缺维度',
            mutate: (b) => { b.practicalExam.gradingDimensions = []; },
            field: 'practicalExam.gradingDimensions'
        },
        {
            name: '预算为负',
            mutate: (b) => { b.budget = { maxModelCostCny: -1 }; },
            field: 'budget.maxModelCostCny'
        }
    ];

    for (const testCase of cases) {
        const blueprint = buildUiDesignerBlueprint();
        testCase.mutate(blueprint);
        const verdict = validateBlueprint(blueprint);
        assert.equal(verdict.valid, false, `用例应拒绝：${testCase.name}`);
        assert.ok(
            verdict.errors.some((error) => error.field === testCase.field),
            `用例 ${testCase.name} 应命中字段 ${testCase.field}，实际：${JSON.stringify(verdict.errors)}`
        );
    }
});

test('forge blueprint: 与既有 agent / Agent 文件重名冲突被拒绝（红线 3 前置）', () => {
    const base = buildUiDesignerBlueprint();

    const conflictWithMap = validateBlueprint(base, { existingAgentNames: ['Nexus', 'UIDesigner'] });
    assert.equal(conflictWithMap.valid, false);
    assert.ok(conflictWithMap.errors.some((e) => e.field === 'name' && e.message.includes('既有 agent')));

    const conflictWithFile = validateBlueprint(base, { existingAgentFiles: ['UIDesigner.txt'] });
    assert.equal(conflictWithFile.valid, false);
    assert.ok(conflictWithFile.errors.some((e) => e.field === 'name' && e.message.includes('同名文件')));

    const noConflict = validateBlueprint(base, {
        existingAgentNames: ['Nexus'],
        existingAgentFiles: ['Nexus.txt']
    });
    assert.equal(noConflict.valid, true);
});

test('forge blueprint: 含疑似密钥的画像被阻断落盘与读取（红线 2）', async () => {
    const dir = createTempDir();
    const blueprintPath = path.join(dir, 'Leaky.json');

    await assert.rejects(
        writeBlueprint(blueprintPath, buildUiDesignerBlueprint({
            acceptanceSample: '使用 sk-abcdefghijklmnopqrstuvwx 模型出图'
        })),
        (error) => error.code === 'FORGE_SECRET_DETECTED'
    );
    assert.equal(fs.existsSync(blueprintPath), false);

    fs.writeFileSync(path.join(dir, 'Leaked.json'), JSON.stringify({
        ...buildUiDesignerBlueprint({ name: 'Leaked' }),
        extra: 'Bearer abcdefghijklmnopqrstu'
    }));
    await assert.rejects(
        readBlueprint(path.join(dir, 'Leaked.json')),
        (error) => error.code === 'FORGE_SECRET_DETECTED'
    );
});

test('forge blueprint: 损坏 JSON 读取报结构化错误', async () => {
    const dir = createTempDir();
    const blueprintPath = path.join(dir, 'Broken.json');
    fs.writeFileSync(blueprintPath, '{ not json');
    await assert.rejects(
        readBlueprint(blueprintPath),
        (error) => error.code === 'FORGE_BLUEPRINT_INVALID'
    );
});

// ── 人格化铸造（参考 Agent/Yui.txt）：画像 persona 的名字与性格校验 ──

function buildPersona(overrides = {}) {
    return {
        name: '沐晴',
        title: '像素炼金术士',
        appearance: '束马尾的年轻设计师，瞳孔里常映着栅格线。',
        backstory: '从专家铸造炉中醒来，专属知识库就是她被铸出来的记忆。',
        coreMotto: '设计是戴着镣铐的舞蹈',
        cognitiveStyle: ['先看信息层级再看细节', '每个取舍都要给出理由'],
        toneAndExpression: ['温和但直接', '评审意见按优先级分层给出'],
        quirks: ['爱用「这里差一口气」形容临门一脚的缺陷'],
        ...overrides
    };
}

test('forge blueprint: 合法 persona 通过校验并随画像落盘回读', async () => {
    const dir = createTempDir();
    const blueprintPath = path.join(dir, 'Minqing.json');
    const written = await writeBlueprint(blueprintPath, buildUiDesignerBlueprint({
        name: 'Minqing',
        persona: buildPersona()
    }));
    assert.equal(written.persona.name, '沐晴');
    const readBack = await readBlueprint(blueprintPath);
    assert.deepEqual(readBack.persona, buildPersona());
});

test('forge blueprint: persona 缺省合法（旧画像兼容，补试岗/重考不受影响）', () => {
    const verdict = validateBlueprint(buildUiDesignerBlueprint());
    assert.equal(verdict.valid, true);
});

test('forge blueprint: persona 非法结构逐项拒绝', () => {
    const cases = [
        { name: 'persona 非对象', mutate: (b) => { b.persona = '沐晴'; }, field: 'persona' },
        { name: '缺人格名', mutate: (b) => { delete b.persona.name; }, field: 'persona.name' },
        { name: '缺核心箴言', mutate: (b) => { delete b.persona.coreMotto; }, field: 'persona.coreMotto' },
        { name: 'cognitiveStyle 空数组', mutate: (b) => { b.persona.cognitiveStyle = []; }, field: 'persona.cognitiveStyle' },
        { name: 'toneAndExpression 非数组', mutate: (b) => { b.persona.toneAndExpression = '温和'; }, field: 'persona.toneAndExpression' },
        { name: 'quirks 非数组', mutate: (b) => { b.persona.quirks = '口癖'; }, field: 'persona.quirks' }
    ];
    for (const testCase of cases) {
        const blueprint = buildUiDesignerBlueprint({ persona: buildPersona() });
        testCase.mutate(blueprint);
        const verdict = validateBlueprint(blueprint);
        assert.equal(verdict.valid, false, `用例应拒绝：${testCase.name}`);
        assert.ok(
            verdict.errors.some((error) => error.field === testCase.field),
            `用例 ${testCase.name} 应命中字段 ${testCase.field}，实际：${JSON.stringify(verdict.errors)}`
        );
    }
});

test('forge blueprint: 人格名与 agent 名解耦——人格名撞既有 agent 名不触发重名门禁', () => {
    const verdict = validateBlueprint(
        buildUiDesignerBlueprint({ persona: buildPersona({ name: 'Nexus' }) }),
        { existingAgentNames: ['Nexus'] }
    );
    assert.equal(verdict.valid, true, '重名硬门禁只针对 agent 名，人格名仅显示用');
});

test('forge blueprint: 起草提示词要求 LLM 一并设计 persona（名字与性格）', () => {
    assert.match(BLUEPRINT_DRAFT_PROMPT, /"persona"/, '结构示例含 persona 字段');
    assert.match(BLUEPRINT_DRAFT_PROMPT, /人格名/, '含人格名指引');
    assert.match(BLUEPRINT_DRAFT_PROMPT, /不得削弱专业严谨/, '性格不得削弱专业纪律');
    assert.match(BLUEPRINT_DRAFT_PROMPT, /铸造炉/, '身世衔接铸造炉世界观');
});
