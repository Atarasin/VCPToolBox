'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { extractJsonObject } = require('./jsonUtils');
const { scanTextForSecrets } = require('./secretScan');

/**
 * 试岗验收（trial）：出题 → 盲测 → LLM 判卷 → Jev 对照 → 报告与缺口。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.7（D3/D7/Q5）。
 *
 * - 出题：LLM 按考纲生成（每 subskill ≥1 概念 + 1 应用 + 1 实操题，评分维度含
 *   眼前一亮/去 AI 味）；
 * - 盲测（红线 1）：被考 agent 只经 gateway_knowledge_search 查自己的库——
 *   实现为「代查专属库 + 人设作答」：以专家人设为 system，答题上下文只注入
 *   专属库命中知识卡，无记忆读写、无其他工具，查不到就答知识边界；
 * - 判卷（D7 第一步）：五维 0-5 分 + 评语 + 引用知识卡；及格线总分 80%，
 *   到线才转 pending_confirm 请用户抽查（D3），不及格不推送用户直接留缺口；
 * - Jev 对照（D7 方案 C）：同一批答卷经 jevPort（typesafe-ai Jev）类型化复判
 *   isProfessional / isAiFlavored / isActionable，与 LLM 分数双档
 *   exams/comparison.json；jevPort 未配置记 skipped 原因（不阻断）。
 */

const PASS_RATIO = 0.8;
const GRADE_DIMENSIONS = ['correctness', 'completeness', 'professionalism', 'antiAiFlavor', 'actionability'];

const FALLBACK_EXAMINE_TEMPLATE = `你是出题官。按考纲为{{displayName}}（{{name}}）出上岗考卷：每子技能 1 概念题+1 应用题，另 1 实操题（{{practicalPrompt}}，维度：{{gradingDimensions}}）。每题带 referencePoints 与 searchKeywords。只输出 JSON：{"questions":[{"id":"","subskillId":"","kind":"concept|applied|practical","prompt":"","gradingDimensions":["..."],"referencePoints":[],"searchKeywords":[]}]}`;

const FALLBACK_GRADE_TEMPLATE = `你是判卷官。对{{displayName}}的答卷逐题五维打分（correctness/completeness/professionalism/antiAiFlavor/actionability 各 0-5，0.5 步进）+评语+引用知识卡。考卷与答卷：{{examWithAnswers}}。只输出 JSON：{"gradedQuestions":[{"id":"","scores":{},"comment":"","citedKnowledgeCards":[]}],"overallComment":""}`;

function loadTemplate(baseDir, fileName, fallback) {
    try {
        return fs.readFileSync(path.join(baseDir, 'templates', fileName), 'utf8');
    } catch {
        return fallback;
    }
}

async function completeJson(llm, llmConfig, prompt, { temperature = 0.3, maxTokens = 6000 } = {}) {
    const response = await llm.complete(llmConfig, {
        model: llmConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens
    });
    return extractJsonObject(response?.data?.choices?.[0]?.message?.content || '');
}

function assertNoSecrets(text, what) {
    const hits = scanTextForSecrets(text);
    if (hits.length > 0) {
        const error = new Error(`${what} 疑似包含密钥，阻断落盘`);
        error.code = 'FORGE_SECRET_DETECTED';
        error.status = 400;
        error.details = { hits };
        throw error;
    }
}

async function writeExamFile(examsDir, name, payload) {
    await fsp.mkdir(examsDir, { recursive: true });
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    assertNoSecrets(serialized, `考试产物 ${name}`);
    await fsp.writeFile(path.join(examsDir, name), serialized, 'utf8');
}

// 盲测代查：只查专属库（红线 1：白名单仅 gateway_knowledge_search 的库面）。
async function blindSearch(knowledgeStorePort, libraryName, keywords, { topK = 5 } = {}) {
    if (!knowledgeStorePort || knowledgeStorePort.available === false) {
        return { cards: [], skipped: true };
    }
    const cards = [];
    try {
        const hits = await knowledgeStorePort.search(keywords[0] || '', { libraries: [libraryName], topK });
        for (const hit of Array.isArray(hits) ? hits : []) {
            cards.push({
                title: hit.title || hit.sourceFile || '(untitled)',
                text: String(hit.text || hit.content || '').slice(0, 1200),
                score: hit.score
            });
        }
    } catch {
        // 检索异常视为无可用知识——被考者按知识边界作答。
    }
    return { cards, skipped: false };
}

function renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps = [] }) {
    const lines = [];
    lines.push(`# ${blueprint.displayName}（${blueprint.name}）上岗验收报告`);
    lines.push('');
    lines.push(`- 及格线：${PASS_RATIO * 100}%（Q5：${blueprint.acceptanceSample}）`);
    lines.push(`- 总分：${(ratio * 100).toFixed(1)}%（${passed ? '✅ 及格，待用户抽查（D3）' : '❌ 未及格，进入定向补课'}）`);
    lines.push(`- 知识库：${libraryName}`);
    lines.push('');
    for (const question of exam.questions) {
        const graded = grading.gradedQuestions.find((g) => g.id === question.id) || {};
        const scores = graded.scores || {};
        const qScore = GRADE_DIMENSIONS.reduce((sum, dim) => sum + (Number(scores[dim]) || 0), 0) / (GRADE_DIMENSIONS.length * 5);
        lines.push(`## ${question.id}（${question.kind} / ${question.subskillId}）— ${(qScore * 100).toFixed(0)}%`);
        lines.push('');
        lines.push(`**题干**：${question.prompt}`);
        lines.push('');
        lines.push(`**答卷**：${(answers[question.id] || '').slice(0, 600)}${(answers[question.id] || '').length > 600 ? '…' : ''}`);
        lines.push('');
        lines.push(`**得分**：${GRADE_DIMENSIONS.map((dim) => `${dim} ${scores[dim] ?? '-'}`).join(' / ')}`);
        lines.push('');
        lines.push(`**评语**：${graded.comment || '—'}`);
        if (Array.isArray(graded.citedKnowledgeCards) && graded.citedKnowledgeCards.length > 0) {
            lines.push('');
            lines.push(`**引用知识卡**：${graded.citedKnowledgeCards.join('；')}`);
        }
        lines.push('');
    }
    lines.push(`## 总评`);
    lines.push('');
    lines.push(grading.overallComment || '—');
    lines.push('');
    if (Array.isArray(gaps) && gaps.length > 0) {
        lines.push(`## 缺口清单（定向补课范围）`);
        lines.push('');
        for (const gap of gaps) {
            lines.push(`- **${gap.subskillId}**：${gap.reason}（考题：${(gap.questionIds || []).join('、')}）`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// Jev 对照（D7 方案 C）：类型化复判三维度（choice），与 LLM 分数并排留档。
async function jevCrossCheck(jevPort, { displayName, answers }) {
    if (!jevPort || typeof jevPort.decide !== 'function') {
        return { skipped: true, reason: 'jevPort 未配置（JEV_API_KEY 缺失或试点未启用）' };
    }
    try {
        const answerDigest = Object.entries(answers).map(([id, text]) => `[${id}] ${String(text).slice(0, 800)}`).join('\n\n');
        const decision = await jevPort.decide(
            { role: `${displayName} 上岗考试答卷`, answers: answerDigest },
            {
                isProfessional: {
                    type: 'choice',
                    instructions: '答卷整体是否体现该领域专业深度？',
                    criteria: { professional: '专业准确有深度', partial: '部分专业', unprofessional: '不专业或编造' }
                },
                isAiFlavored: {
                    type: 'choice',
                    instructions: '答卷是否带有明显 AI 味（套话/空泛/缺乏具体判断）？',
                    criteria: { heavy: 'AI 味重', mild: '轻微', none: '去 AI 味良好' }
                },
                isActionable: {
                    type: 'choice',
                    instructions: '答卷内容是否可直接落地执行？',
                    criteria: { actionable: '可直接执行', partial: '部分可执行', vague: '空泛不可执行' }
                }
            }
        );
        return { skipped: false, decision };
    } catch (error) {
        return { skipped: true, reason: `jev 调用失败：${error.message}` };
    }
}

function createTrialStepRunner() {
    return async function runTrialStep(ctx) {
        const { runDir, llm, llmConfig, knowledgeStorePort, baseDir, logger } = ctx;
        if (!ctx.blueprintPath) {
            const error = new Error('trial 需要 blueprintPath');
            error.code = 'FORGE_BLUEPRINT_MISSING';
            error.status = 400;
            throw error;
        }
        if (!llm || llm.available !== true || !llmConfig?.url) {
            const error = new Error('llmCompletion 端口不可用，无法出题/判卷');
            error.code = 'FORGE_LLM_UNAVAILABLE';
            error.status = 503;
            throw error;
        }
        const blueprint = await readBlueprint(ctx.blueprintPath);
        const libraryName = blueprintLibraryName(blueprint.name);
        const examsDir = path.join(runDir, 'exams');

        // 1. 出题（§3.7：每 subskill ≥1 概念 + 1 应用 + 1 实操，维度含眼前一亮/去 AI 味）
        const outlineBlock = blueprint.examOutline.map((entry) => {
            const subskill = blueprint.subskills.find((s) => s.id === entry.subskillId);
            return `- ${entry.subskillId}（${subskill?.title || ''}）：${entry.conceptQuestions} 概念题 + ${entry.appliedQuestions} 应用题`;
        }).join('\n');
        const examinePrompt = loadTemplate(baseDir, 'examine.md', FALLBACK_EXAMINE_TEMPLATE)
            .replace(/\{\{displayName\}\}/g, blueprint.displayName)
            .replace(/\{\{name\}\}/g, blueprint.name)
            .replace(/\{\{examOutline\}\}/g, outlineBlock)
            .replace(/\{\{practicalPrompt\}\}/g, blueprint.practicalExam.prompt)
            .replace(/\{\{gradingDimensions\}\}/g, blueprint.practicalExam.gradingDimensions.join('、'));
        let exam = await completeJson(llm, llmConfig, examinePrompt, { temperature: 0.5 });
        if (!exam || !Array.isArray(exam.questions) || exam.questions.length === 0) {
            logger?.('trial: 出题输出不可解析，重试一次');
            exam = await completeJson(llm, llmConfig, examinePrompt, { temperature: 0.5 });
        }
        if (!exam || !Array.isArray(exam.questions) || exam.questions.length === 0) {
            const error = new Error('出题输出不可解析（已重试一次）');
            error.code = 'FORGE_EXAM_OUTPUT_INVALID';
            error.status = 502;
            throw error;
        }
        await writeExamFile(examsDir, 'exam.json', exam);

        const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
        const { answers, grading, ratio, passed, gaps, jev } = outcome;

        logger?.(`forge.exam.graded: ${blueprint.name} 总分 ${(ratio * 100).toFixed(1)}%，${passed ? '及格待抽查' : `缺口 ${gaps.length} 项`}`);

        return {
            summary: `试岗完成：总分 ${(ratio * 100).toFixed(1)}%（${passed ? '及格，待用户抽查' : '未及格，缺口 ' + gaps.length + ' 项'}）；Jev 对照${jev.skipped ? '跳过（' + jev.reason + '）' : '已留档'}`,
            artifacts: ['exams/grade-report.md', 'exams/comparison.json'],
            state: {
                passed,
                ratio,
                gaps,
                userGate: passed ? {
                    kind: 'trial-report',
                    reportPath: path.relative(path.join(baseDir, '..'), path.join(examsDir, 'grade-report.md')),
                    hint: '试岗及格，请用户抽查验收报告（D3）'
                } : null
            }
        };
    };
}

/**
 * 盲测 + 判卷 + 评分 + 报告落盘的共享实现（trial 首考与回填后 retest 复用）。
 * exam 由调用方给定（retest 传原考卷，实现「同一套考题重测」§3.7）。
 */
async function runBlindAndGrade(ctx, { blueprint, exam, examsDir }) {
    const { llm, llmConfig, knowledgeStorePort, baseDir } = ctx;
    const libraryName = blueprintLibraryName(blueprint.name);
    // 盲测（红线 1）：代查专属库 + 人设作答
    let persona = '';
        try {
            persona = await fsp.readFile(path.join(baseDir, `${blueprint.name}.txt`), 'utf8');
        } catch {
            persona = `你是${blueprint.displayName}，只依据给定知识库资料作答。`;
        }
        const answers = {};
        for (const question of exam.questions) {
            const keywords = Array.isArray(question.searchKeywords) && question.searchKeywords.length > 0
                ? question.searchKeywords
                : [question.prompt.slice(0, 40)];
            const { cards } = await blindSearch(knowledgeStorePort, libraryName, keywords);
            const knowledgeBlock = cards.length > 0
                ? cards.map((card, index) => `[${index + 1}] ${card.title}\n${card.text}`).join('\n\n')
                : '（知识库未命中——按知识边界作答，明确说明不确定，不编造）';
            const answerPrompt = [
                persona,
                '',
                `# 知识库检索结果（你唯一的专业资料来源）`,
                knowledgeBlock,
                '',
                `# 考题（${question.id}）`,
                question.prompt,
                '',
                '要求：依据上面的知识库资料作答；资料不足时明确说明知识边界；给出处；不编造。'
            ].join('\n');
            const answerResponse = await llm.complete(llmConfig, {
                model: llmConfig.model,
                messages: [{ role: 'user', content: answerPrompt }],
                temperature: 0.4,
                max_tokens: 3000
            });
            answers[question.id] = String(answerResponse?.data?.choices?.[0]?.message?.content || '').trim();
        }
        await writeExamFile(examsDir, 'answers.json', { answers });

        // 3. 判卷（D7 第一步：五维 0-5 + 评语 + 知识卡引用）
        const examWithAnswers = exam.questions.map((question) => ({
            id: question.id,
            kind: question.kind,
            subskillId: question.subskillId,
            prompt: question.prompt,
            referencePoints: question.referencePoints,
            gradingDimensions: question.gradingDimensions,
            answer: answers[question.id]
        }));
        const gradePrompt = loadTemplate(baseDir, 'grade.md', FALLBACK_GRADE_TEMPLATE)
            .replace(/\{\{displayName\}\}/g, blueprint.displayName)
            .replace(/\{\{name\}\}/g, blueprint.name)
            .replace(/\{\{examWithAnswers\}\}/g, JSON.stringify(examWithAnswers, null, 2));
        let grading = await completeJson(llm, llmConfig, gradePrompt, { temperature: 0.2 });
        if (!grading || !Array.isArray(grading.gradedQuestions)) {
            logger?.('trial: 判卷输出不可解析，重试一次');
            grading = await completeJson(llm, llmConfig, gradePrompt, { temperature: 0.2 });
        }
        if (!grading || !Array.isArray(grading.gradedQuestions)) {
            const error = new Error('判卷输出不可解析（已重试一次）');
            error.code = 'FORGE_GRADE_OUTPUT_INVALID';
            error.status = 502;
            throw error;
        }

        // 及格线 80%（D3：到线才请用户抽查）
        let earned = 0;
        let full = 0;
        const weakQuestions = [];
        for (const question of exam.questions) {
            const graded = grading.gradedQuestions.find((g) => g.id === question.id);
            const scores = graded?.scores || {};
            const dims = GRADE_DIMENSIONS.map((dim) => Number(scores[dim]) || 0);
            const questionFull = GRADE_DIMENSIONS.length * 5;
            earned += dims.reduce((sum, value) => sum + Math.min(5, Math.max(0, value)), 0);
            full += questionFull;
            const questionRatio = dims.reduce((sum, value) => sum + Math.min(5, Math.max(0, value)), 0) / questionFull;
            if (questionRatio < PASS_RATIO && question.subskillId !== 'practical') {
                weakQuestions.push({ id: question.id, subskillId: question.subskillId, ratio: questionRatio });
            }
        }
        const ratio = full > 0 ? earned / full : 0;
        const passed = ratio >= PASS_RATIO;

        // 缺口清单：弱项题 → subskill（去重）；实操弱计入整体缺口说明。
        const gaps = [];
        for (const weak of weakQuestions) {
            if (!gaps.some((gap) => gap.subskillId === weak.subskillId)) {
                gaps.push({
                    subskillId: weak.subskillId,
                    reason: `考题 ${weak.id} 得分 ${(weak.ratio * 100).toFixed(0)}%（低于 80% 及格线）`,
                    questionIds: weakQuestions.filter((w) => w.subskillId === weak.subskillId).map((w) => w.id)
                });
            }
        }

        // 4. Jev 对照试点（D7 方案 C）
        const jev = await jevCrossCheck(ctx.jevPort, { displayName: blueprint.displayName, answers });
        const comparison = {
            comparedAt: new Date().toISOString(),
            llm: { ratio, passed, gradedQuestions: grading.gradedQuestions },
            jev,
            note: 'D7 方案 C：LLM 主判，Jev 类型化复判对照留档；对比数据稳定且确有收益后再切换主判引擎（本期不切换）'
        };
        await writeExamFile(examsDir, 'comparison.json', comparison);
        await writeExamFile(examsDir, 'gaps.json', { gaps, generatedAt: new Date().toISOString() });

        // 5. 报告落盘（JSON + 用户可读 markdown，含缺口清单）
        const report = { passed, ratio, passLine: PASS_RATIO, grading, gaps, libraryName };
        await writeExamFile(examsDir, 'grade-report.json', report);
        const reportMarkdown = renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps });
        assertNoSecrets(reportMarkdown, '验收报告');
        await fsp.writeFile(path.join(examsDir, 'grade-report.md'), reportMarkdown, 'utf8');

        return { answers, grading, ratio, passed, gaps, jev };
}

/**
 * 回填后重测（§3.7：对同一套考题重测）——读原 job 的考卷，复用盲测+判卷，
 * 报告并排本次与前次分数（弱项提升可见）。
 */
function createRetestStepRunner() {
    return async function runRetestStep(ctx) {
        const { runDir, baseDir } = ctx;
        const retestOf = ctx.retestOf;
        if (!retestOf?.examPath) {
            const error = new Error('retest 需要 retestOf.examPath（原考卷路径）');
            error.code = 'FORGE_RETEST_SOURCE_MISSING';
            error.status = 400;
            throw error;
        }
        const exam = JSON.parse(await fsp.readFile(retestOf.examPath, 'utf8'));
        if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
            const error = new Error('原考卷不可用（无 questions）');
            error.code = 'FORGE_RETEST_SOURCE_INVALID';
            error.status = 502;
            throw error;
        }
        const { readBlueprint, blueprintLibraryName: libName } = require('./blueprint');
        const blueprint = await readBlueprint(ctx.blueprintPath);
        void libName;
        const examsDir = path.join(runDir, 'exams');

        const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
        const { ratio, passed, gaps, grading } = outcome;

        const previousRatio = Number(retestOf.previousRatio) || 0;
        const improvement = ratio - previousRatio;
        const summary = `重测完成（同一套考题）：${(previousRatio * 100).toFixed(1)}% → ${(ratio * 100).toFixed(1)}%（${improvement >= 0 ? '+' : ''}${(improvement * 100).toFixed(1)} 分点，${passed ? '✅ 达到及格线' : '仍未及格，缺口 ' + gaps.length + ' 项'}）`;
        await writeExamFile(examsDir, 'retest-summary.json', {
            previousRatio,
            ratio,
            improvement,
            passed,
            gaps,
            retestOf: retestOf.jobId || null,
            gradedAt: new Date().toISOString()
        });
        return {
            summary,
            artifacts: ['exams/grade-report.md'],
            state: {
                passed,
                ratio,
                improvement,
                gaps,
                userGate: passed ? {
                    kind: 'trial-report',
                    reportPath: path.relative(path.join(baseDir, '..'), path.join(examsDir, 'grade-report.md')),
                    hint: '回填后重测及格，请用户抽查验收报告'
                } : null
            }
        };
    };
}

module.exports = {
    PASS_RATIO,
    GRADE_DIMENSIONS,
    FALLBACK_EXAMINE_TEMPLATE,
    FALLBACK_GRADE_TEMPLATE,
    createTrialStepRunner,
    createRetestStepRunner,
    runBlindAndGrade,
    jevCrossCheck,
    blindSearch,
    renderReportMarkdown
};
