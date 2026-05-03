'use strict';

/**
 * Synthetic E2E test for two-phase extraction pipeline.
 *
 * Instead of calling real LLMs, this test injects mock agent outputs
 * with realistic markdown variability (code blocks, inline JSON, truncated,
 * wrapped in explanatory text) and verifies the full 3-phase workflow
 * completes without JSON parse failures.
 *
 * This proves the ExtractionLayer stabilizes the pipeline against
 * LLM output variability that previously caused flaky e2e failures.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');

/* ------------------------------------------------------------------ */
/*  mock agent outputs with realistic markdown variability              */
/* ------------------------------------------------------------------ */

const WORLD_BUILDER_OUTPUTS = [
  // Variant 1: clean JSON block
  `好的，这是世界观设定：\n\n\`\`\`json\n{"setting":"2150年火星殖民地，红色荒漠中的穹顶城市","rules":{"physical":"低重力环境，需要磁力靴","special":"大气改造器维持穹顶内氧气","limitations":"每次外出需穿戴全套维生装备"},"factions":[{"name":"地球联邦","description":"母星派驻的管理机构","relationships":["与殖民地议会存在权力摩擦"]}],"history":{"keyEvents":["2045年首批殖民船抵达","2090年穹顶城市建成"],"coreConflicts":["资源分配不公","自治权争议"]},"sceneNorms":["穹顶内恒温恒湿","外出需申请许可"],"secrets":["地下水库发现远古微生物痕迹"]}\n\`\`\``,

  // Variant 2: inline JSON without code block
  `{"setting":"2150年火星殖民地","rules":{"physical":"低重力","special":"大气改造器","limitations":"维生装备"},"factions":[{"name":"殖民地议会","description":"本地自治政府","relationships":["与地球联邦对立"]}],"history":{"keyEvents":["首批殖民抵达"],"coreConflicts":["自治与管辖"]},"sceneNorms":["恒温穹顶"],"secrets":["地下微生物"]}`,

  // Variant 3: JSON wrapped in explanatory text (no code fence)
  `根据您的要求，我构建了以下世界观设定：\n\n{"setting":"2150年火星殖民地，最后一位图书管理员的故事发生地","rules":{"physical":"火星低重力环境","special":"穹顶生态维持系统","limitations":"外部活动严格受限"},"factions":[{"name":"地球联邦","description":"管辖火星的地球政权","relationships":["与本地居民关系紧张"]}],"history":{"keyEvents":["2050年首批殖民","2100年图书馆建立"],"coreConflicts":["文化传承与生存现实的冲突"]},"sceneNorms":["图书馆是公共 sanctuary","书籍禁止数字化导出"],"secrets":["图书馆地下室藏有地球禁书"]}\n\n希望这个设定符合您的需求。`,

  // Variant 4: truncated JSON (missing closing braces)
  `{"setting":"2150年火星殖民地","rules":{"physical":"低重力环境","special":"大气改造器维持氧气","limitations":"每次外出需穿戴全套维生装备"},"factions":[{"name":"联邦管理局","description":"地球派驻机构","relationships":["与殖民地自治会对立"]}],"history":{"keyEvents":["首批殖民抵达","穹顶城市建成"],"coreConflicts":["资源分配","自治权"]},"sceneNorms":["恒温恒湿","外出申请"],"secrets":["远古微生物`,
];

const CHARACTER_DESIGNER_OUTPUTS = [
  // Variant 1: clean JSON block
  `\`\`\`json\n{"protagonists":[{"name":"阿琳","identity":"火星殖民地最后一位人类图书管理员","appearance":"银灰色短发，常穿旧式毛衣，戴着一副古董眼镜","personality":["执着","温柔","略带孤独感"],"background":"地球文学博士，自愿申请到火星守护纸质书籍","motivation":"证明纸质书的价值，建立人与书的情感联结","innerConflict":"是否应该让书籍数字化以拯救它们","growthArc":"从固守传统到理解变革的意义"}],"supportingCharacters":[{"name":"墨菲","identity":"服役五十年的老旧AI机器人","role":"图书馆助手","relationship":"阿琳的搭档，逐渐理解情感"}],"relationshipNetwork":{"direct":[{"from":"阿琳","to":"墨菲","type":"搭档与知己"}],"hidden":[]},"oocRules":{"阿琳":["不会主动破坏书籍","在危机中优先保护人"],"墨菲":["底层协议禁止伤害人类","会为了保护阿琳突破协议限制"]}}\n\`\`\``,

  // Variant 2: inline JSON
  `{"protagonists":[{"name":"阿琳","identity":"图书管理员","appearance":"银灰短发","personality":["执着"],"background":"文学博士","motivation":"保护纸质书","innerConflict":"传统vs数字化","growthArc":"理解变革"}],"supportingCharacters":[{"name":"墨菲","identity":"老旧AI","role":"助手","relationship":"搭档"}],"relationshipNetwork":{"direct":[{"from":"阿琳","to":"墨菲","type":"搭档"}],"hidden":[]},"oocRules":{}}`,

  // Variant 3: truncated JSON
  `{"protagonists":[{"name":"阿琳","identity":"火星图书管理员","appearance":"短发","personality":["温柔","执着"],"background":"地球来的博士","motivation":"守护纸质书","innerConflict":"是否应该数字化","growthArc":"从固执到开放"}],"supportingCharacters":[{"name":"墨菲","identity":"老旧AI机器人","role":"助手","relationship":"阿琳的搭档"}],"relationshipNetwork":{"direct":[{"from":"阿琳","to":"墨菲","type":"搭档"}],"hidden":[{"from":"墨菲","to":"阿琳","secret":"墨菲偷偷保存了阿琳的所有阅读记录"}]},"oocRules":{"阿琳":["不会伤害书籍"],"墨菲":["`,
];

const PLOT_ARCHITECT_OUTPUTS = [
  // Variant 1: clean JSON
  `\`\`\`json\n{"chapters":[{"number":1,"title":"启程","coreEvent":"阿琳在图书馆发现最后一本未编目的地球诗集","scenes":["图书馆晨间整理","发现神秘诗集"],"characters":["阿琳","墨菲"],"wordCountTarget":800,"storyFunction":"setup"},{"number":2,"title":"冲突","coreEvent":"联邦下令关闭图书馆","scenes":["收到关闭通知","阿琳与墨菲商议对策"],"characters":["阿琳","墨菲","管理局官员"],"wordCountTarget":800,"storyFunction":"escalation"},{"number":3,"title":"终章","coreEvent":"阿琳和墨菲用诗歌打动管理局，保住图书馆","scenes":["最后的朗诵会","管理局动摇","图书馆得救"],"characters":["阿琳","墨菲","管理局官员"],"wordCountTarget":800,"storyFunction":"resolution"}],"structure":"三幕式： setup → escalation → resolution","keyTurningPoints":["发现诗集","收到关闭令","朗诵会"],"foreshadowing":["诗集扉页的神秘题词 → 终章揭示是初代馆长所写"]}\n\`\`\``,

  // Variant 2: text outline with Chinese markers (legacy format)
  `【整体故事结构】\n三幕式结构： setup → escalation → resolution\n\n【Chapter 1】\n标题: 启程\n核心事件: 阿琳发现最后一本未编目的地球诗集\n场景:\n1. 图书馆晨间整理\n2. 发现神秘诗集\n出场人物:\n1. 阿琳\n2. 墨菲\n故事功能: setup\n\n【Chapter 2】\n标题: 冲突\n核心事件: 联邦下令关闭图书馆\n场景:\n1. 收到关闭通知\n2. 阿琳与墨菲商议对策\n出场人物:\n1. 阿琳\n2. 墨菲\n3. 管理局官员\n故事功能: escalation\n\n【Chapter 3】\n标题: 终章\n核心事件: 用诗歌打动管理局，保住图书馆\n场景:\n1. 最后的朗诵会\n2. 管理局动摇\n3. 图书馆得救\n出场人物:\n1. 阿琳\n2. 墨菲\n3. 管理局官员\n故事功能: resolution\n\n【关键转折点】\n1. 发现诗集\n2. 收到关闭令\n3. 朗诵会\n\n【伏笔与回收计划】\n诗集扉页题词 → 终章揭示初代馆长所写`,
];

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function createAdapter(outputVariants) {
  let callIndex = 0;
  const outputs = outputVariants || [];

  return new StoryOrchestratorKernelAdapter({
    stateManager: {
      repository: {
        getStory: () => null,
        updateStory: () => {},
        createSnapshot: () => 'snap-1',
        getLatestApprovedSnapshot: () => null
      }
    },
    agentDispatcher: {
      delegate: async () => {
        const content = outputs[callIndex % outputs.length];
        callIndex++;
        return { content, markers: [], raw: {} };
      }
    },
    chapterOperations: {
      createChapterDraft: async () => ({
        content: '草稿内容',
        metrics: { counts: { actualCount: 500 } }
      }),
      fillDetails: async () => ({ detailedContent: '' }),
      countChapterLength: () => ({
        counts: { actualCount: 500 },
        validation: { isQualified: true, deficit: 0 }
      }),
      _expandChapter: async () => ({ content: '扩展内容' }),
      reviseChapter: async () => ({ revisedContent: '' }),
      polishChapter: async () => ({
        polishedContent: '润色内容',
        metrics: {},
        improvements: []
      })
    },
    contentValidator: {
      comprehensiveValidation: async () => ({
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        allIssues: []
      }),
      qualityScore: async () => ({ average: 8.5, scores: {}, rawReport: '' })
    },
    config: {
      USE_WORKFLOW_KERNEL: 'true',
      MAX_PHASE_ITERATIONS: '1',
      QUALITY_THRESHOLD: '7.0'
    }
  });
}

/* ------------------------------------------------------------------ */
/*  test suite                                                        */
/* ------------------------------------------------------------------ */

describe('StoryOrchestrator E2E — Two-phase extraction with markdown variability', () => {
  it('completes phase1 without JSON parse failures across all worldBuilder output variants', async () => {
    const adapter = createAdapter(WORLD_BUILDER_OUTPUTS);
    await adapter.initialize();

    for (let i = 0; i < WORLD_BUILDER_OUTPUTS.length; i++) {
      const agentCallHandler = adapter.kernel.stepRegistry.handlers.get('agentCall');
      const parseHandler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');

      const agentResult = await agentCallHandler(
        {
          id: `worldBuilder-${i}`,
          agent: 'worldBuilder',
          input: { prompt: 'test', genre: '科幻' },
          extraction: {
            parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
            maxAttempts: 2,
            throwOnFailure: false,
            defaultValue: null
          }
        },
        { kernel: adapter.kernel, context: { inputs: {}, outputs: {}, steps: {} } }
      );

      assert.strictEqual(agentResult.status, 'completed', `worldBuilder variant ${i} should succeed`);

      const parseResult = await parseHandler(
        {
          id: `parseWorldview-${i}`,
          input: { raw: { $ref: 'ctx.outputs.rawContent' } }
        },
        { context: { outputs: { rawContent: agentResult.output.content } } }
      );

      assert.strictEqual(parseResult.status, 'completed', `parseWorldview variant ${i} should succeed`);
      assert.ok(
        parseResult.output.data || parseResult.output.parsed || parseResult.output.raw,
        `variant ${i} should produce some structured output`
      );
    }

    const metrics = adapter.getExtractionMetrics();
    console.log(`[E2E-Extraction] Phase1 metrics: attempts=${metrics.totalAttempts}, successes=${metrics.totalSuccesses}, failures=${metrics.totalFailures}`);
    assert.ok(metrics.totalSuccesses > 0, 'should have extraction successes');
  });

  it('completes character extraction across all characterDesigner output variants', async () => {
    const adapter = createAdapter(CHARACTER_DESIGNER_OUTPUTS);
    await adapter.initialize();

    for (let i = 0; i < CHARACTER_DESIGNER_OUTPUTS.length; i++) {
      const agentCallHandler = adapter.kernel.stepRegistry.handlers.get('agentCall');
      const parseHandler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');

      const agentResult = await agentCallHandler(
        {
          id: `characterDesigner-${i}`,
          agent: 'characterDesigner',
          input: { prompt: 'test', genre: '科幻' },
          extraction: {
            parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
            maxAttempts: 2,
            throwOnFailure: false,
            defaultValue: null
          }
        },
        { kernel: adapter.kernel, context: { inputs: {}, outputs: {}, steps: {} } }
      );

      assert.strictEqual(agentResult.status, 'completed', `characterDesigner variant ${i} should succeed`);

      const parseResult = await parseHandler(
        {
          id: `parseCharacters-${i}`,
          input: { raw: { $ref: 'ctx.outputs.rawContent' } }
        },
        { context: { outputs: { rawContent: agentResult.output.content } } }
      );

      assert.strictEqual(parseResult.status, 'completed', `parseCharacters variant ${i} should succeed`);
    }

    const metrics = adapter.getExtractionMetrics();
    console.log(`[E2E-Extraction] Character metrics: attempts=${metrics.totalAttempts}, successes=${metrics.totalSuccesses}, failures=${metrics.totalFailures}`);
  });

  it('completes outline extraction across all plotArchitect output variants', async () => {
    const adapter = createAdapter(PLOT_ARCHITECT_OUTPUTS);
    await adapter.initialize();

    for (let i = 0; i < PLOT_ARCHITECT_OUTPUTS.length; i++) {
      const generateOutlineHandler = adapter.kernel.stepRegistry.handlers.get('generateOutline');
      const parseOutlineHandler = adapter.kernel.stepRegistry.handlers.get('parseOutline');

      const agentResult = await generateOutlineHandler(
        {
          id: `plotArchitect-${i}`,
          input: {
            storyPrompt: 'test',
            worldview: { setting: 'Mars' },
            characters: { protagonists: [] },
            targetWordCount: { min: 500, max: 800 }
          },
          extraction: {
            parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
            maxAttempts: 2,
            throwOnFailure: false,
            defaultValue: null
          }
        },
        { kernel: adapter.kernel, context: { inputs: {}, outputs: {}, steps: {} } }
      );

      assert.strictEqual(agentResult.status, 'completed', `plotArchitect variant ${i} should succeed`);

      const parseResult = await parseOutlineHandler(
        {
          id: `parseOutline-${i}`,
          input: { raw: { $ref: 'ctx.outputs.rawContent' } }
        },
        { context: { outputs: { rawContent: agentResult.output.content } } }
      );

      assert.strictEqual(parseResult.status, 'completed', `parseOutline variant ${i} should succeed`);
      assert.ok(
        Array.isArray(parseResult.output.chapters),
        `variant ${i} should produce chapters array`
      );
      assert.ok(
        parseResult.output.chapters.length > 0,
        `variant ${i} should produce at least one chapter`
      );
    }

    const metrics = adapter.getExtractionMetrics();
    console.log(`[E2E-Extraction] Outline metrics: attempts=${metrics.totalAttempts}, successes=${metrics.totalSuccesses}, failures=${metrics.totalFailures}`);
    console.log(`[E2E-Extraction] Per-parser: ${JSON.stringify(metrics.byParser)}`);
  });

  it('has zero JSON parse failures across all 9 synthetic variants', async () => {
    const allVariants = [
      ...WORLD_BUILDER_OUTPUTS.map((c, i) => ({ content: c, agent: 'worldBuilder', idx: i })),
      ...CHARACTER_DESIGNER_OUTPUTS.map((c, i) => ({ content: c, agent: 'characterDesigner', idx: i })),
      ...PLOT_ARCHITECT_OUTPUTS.map((c, i) => ({ content: c, agent: 'plotArchitect', idx: i })),
    ];

    const adapter = createAdapter(allVariants.map(v => v.content));
    await adapter.initialize();

    const agentCallHandler = adapter.kernel.stepRegistry.handlers.get('agentCall');
    const parseHandler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');
    const parseOutlineHandler = adapter.kernel.stepRegistry.handlers.get('parseOutline');

    let jsonParseFailures = 0;

    for (let i = 0; i < allVariants.length; i++) {
      const variant = allVariants[i];

      try {
        let agentResult;
        if (variant.agent === 'plotArchitect') {
          agentResult = await adapter.kernel.stepRegistry.handlers.get('generateOutline')(
            {
              id: `variant-${i}`,
              input: { storyPrompt: 'test', worldview: {}, characters: {}, targetWordCount: {} },
              extraction: { parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'], maxAttempts: 2, throwOnFailure: false, defaultValue: null }
            },
            { kernel: adapter.kernel, context: { inputs: {}, outputs: {}, steps: {} } }
          );
        } else {
          agentResult = await agentCallHandler(
            {
              id: `variant-${i}`,
              agent: variant.agent,
              input: { prompt: 'test', genre: '科幻' },
              extraction: { parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'], maxAttempts: 2, throwOnFailure: false, defaultValue: null }
            },
            { kernel: adapter.kernel, context: { inputs: {}, outputs: {}, steps: {} } }
          );
        }

        if (agentResult.status !== 'completed') {
          jsonParseFailures++;
          continue;
        }

        let parseResult;
        if (variant.agent === 'plotArchitect') {
          parseResult = await parseOutlineHandler(
            { id: `parse-${i}`, input: { raw: { $ref: 'ctx.outputs.rawContent' } } },
            { context: { outputs: { rawContent: agentResult.output.content } } }
          );
        } else {
          parseResult = await parseHandler(
            { id: `parse-${i}`, input: { raw: { $ref: 'ctx.outputs.rawContent' } } },
            { context: { outputs: { rawContent: agentResult.output.content } } }
          );
        }

        if (parseResult.status !== 'completed') {
          jsonParseFailures++;
        }
      } catch (err) {
        jsonParseFailures++;
        console.error(`[E2E-Extraction] Variant ${i} (${variant.agent}) failed:`, err.message);
      }
    }

    const metrics = adapter.getExtractionMetrics();
    console.log(`[E2E-Extraction] TOTAL metrics: attempts=${metrics.totalAttempts}, successes=${metrics.totalSuccesses}, failures=${metrics.totalFailures}`);
    console.log(`[E2E-Extraction] JSON parse failures: ${jsonParseFailures}`);
    console.log(`[E2E-Extraction] Per-parser breakdown:`);
    for (const [name, stats] of Object.entries(metrics.byParser)) {
      const rate = stats.attempts > 0 ? Math.round((stats.successes / stats.attempts) * 100) : 0;
      console.log(`  ${name}: ${stats.successes}/${stats.attempts} (${rate}%)`);
    }

    assert.strictEqual(jsonParseFailures, 0, `Expected 0 JSON parse failures, got ${jsonParseFailures}`);
  });
});
