'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { extractJsonObject, extractCompleteArrayObjects } = require('./jsonUtils');
const { scanTextForSecrets } = require('./secretScan');

/**
 * 试岗验收（trial）：出题 → 盲测 → LLM 判卷 → Jev 对照 → 报告与缺口。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.7（D3/D7/Q5）。
 *
 * - 出题：LLM 按考纲生成（每 subskill ≥1 概念 + 1 应用 + 1 实操题，评分维度含
 *   眼前一亮/去 AI 味）——按考纲条目分次生成（2026-10-11 实测整卷单次输出
 *   顶满 max_tokens 被截断，completion 恰为上限值 ×2）；
 * - 盲测（红线 1）：被考 agent 只经 gateway_knowledge_search 查自己的库——
 *   实现为「代查专属库 + 人设作答」：以专家人设为 system，答题上下文只注入
 *   专属库命中知识卡，无记忆读写、无其他工具，查不到就答知识边界；
 * - 判卷（D7 第一步）：五维 0-5 分 + 评语 + 引用知识卡；按题分块判卷（块输出
 *   远小于 max_tokens）；及格线总分 80%，到线才转 pending_confirm 请用户抽查
 *   （D3），不及格不推送用户直接留缺口；
 * - Jev 对照（D7 方案 C）：同一批答卷经 jevPort（typesafe-ai Jev）类型化复判
 *   isProfessional / isAiFlavored / isActionable，与 LLM 分数双档
 *   exams/comparison.json；jevPort 未配置记 skipped 原因（不阻断）。
 *
 * 解析韧性：出题/判卷共用 completeJsonResilient——整体解析 → 抢救完整数组
 * 元素 → 同 prompt 重试（共 3 次尝试）；彻底失败前原始输出留档
 * runDir/trial-failed/ 供事后诊断（与 distill-failed/ 同构）。
 */

const PASS_RATIO = 0.8;
const GRADE_DIMENSIONS = ['correctness', 'completeness', 'professionalism', 'antiAiFlavor', 'actionability'];
const TRIAL_MAX_ATTEMPTS = 3;
const TRIAL_MAX_TOKENS = 8000;
const GRADE_CHUNK_SIZE = 5;
// 盲测作答弹性（2026-10-11 补考实测）：应用/实操题是长交付物，3000 会中途
// 截断；推理型模型还可能把整个输出预算耗在推理段导致 message.content 为空
//（两题 0 分「未作答」）——空正文/截断时带「直接输出正文」强指令加预算重试。
const ANSWER_MAX_TOKENS = 6000;
const ANSWER_RETRY_MAX_TOKENS = 8000;
const DIRECT_OUTPUT_NOTE = '\n\n【输出要求】直接输出答案正文本身（结论/清单/方案本体在前）；不要输出推理过程、开场白或前置免责声明；依据的知识卡编号与不确定处放在正文末尾一行。';

const FALLBACK_EXAMINE_TEMPLATE = `你是出题官。按考纲为{{displayName}}（{{name}}）出上岗考卷。考纲：
{{examOutline}}
要求：每子技能 1 概念题+1 应用题，另 1 实操题（{{practicalPrompt}}，维度：{{gradingDimensions}}）。每题带 referencePoints 与 searchKeywords。只输出 JSON：{"questions":[{"id":"","subskillId":"","kind":"concept|applied|practical","prompt":"","gradingDimensions":["..."],"referencePoints":[],"searchKeywords":[]}]}`;

const FALLBACK_GRADE_TEMPLATE = `你是判卷官。对{{displayName}}的答卷逐题五维打分（correctness/completeness/professionalism/antiAiFlavor/actionability 各 0-5，0.5 步进）+评语+引用知识卡。考卷与答卷：{{examWithAnswers}}。只输出 JSON：{"gradedQuestions":[{"id":"","scores":{},"comment":"","citedKnowledgeCards":[]}],"overallComment":""}`;

function loadTemplate(baseDir, fileName, fallback) {
    try {
        return fs.readFileSync(path.join(baseDir, 'templates', fileName), 'utf8');
    } catch {
        return fallback;
    }
}

// 彻底失败前把原始输出留档（与 distill-failed/ 同构；留档失败不掩盖原始错误）。
async function dumpTrialFailure(runDir, dumpBase, attempts, promptPreview) {
    try {
        const dir = path.join(runDir, 'trial-failed');
        await fsp.mkdir(dir, { recursive: true });
        for (const attempt of attempts) {
            await fsp.writeFile(
                path.join(dir, `${dumpBase}.attempt-${attempt.index}.json`),
                `${JSON.stringify({
                    dumpBase,
                    attempt: attempt.index,
                    finishReason: attempt.finishReason,
                    usage: attempt.usage ?? null,
                    promptPreview,
                    rawContent: attempt.content
                }, null, 2)}\n`,
                'utf8'
            );
        }
    } catch {
        // 尽力而为。
    }
}

/**
 * 出题/判卷共用的弹性 JSON 补全：
 * 整体解析 → 按数组字段抢救完整元素（截断只损失被切开的尾元素）→ 同 prompt
 * 重试（默认共 3 次尝试）。全部失败时留档 trial-failed/ 并返回 null（调用方
 * 按语义抛 FORGE_*_OUTPUT_INVALID）。
 */
async function completeJsonResilient({
    llm, llmConfig, prompt, temperature, runDir, dumpBase, arrayField, validate, logger,
    maxAttempts = TRIAL_MAX_ATTEMPTS, maxTokens = TRIAL_MAX_TOKENS
}) {
    const attempts = [];
    for (let index = 1; index <= maxAttempts; index += 1) {
        const response = await llm.complete(llmConfig, {
            model: llmConfig.model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
            max_tokens: maxTokens
        });
        const choice = response?.data?.choices?.[0];
        const content = choice?.message?.content || '';
        const finishReason = choice?.finish_reason || null;

        const payload = extractJsonObject(content);
        if (validate(payload)) {
            return payload;
        }
        if (arrayField) {
            const items = extractCompleteArrayObjects(content, `"${arrayField}"`);
            if (items.length > 0) {
                const salvaged = arrayField === 'gradedQuestions'
                    ? { gradedQuestions: items, overallComment: '' }
                    : { [arrayField]: items };
                if (validate(salvaged)) {
                    logger?.(`trial: ${dumpBase} 输出整体不可解析（finish_reason=${finishReason ?? 'unknown'}），抢救出 ${items.length} 个完整元素`);
                    return salvaged;
                }
            }
        }
        attempts.push({ index, finishReason, usage: response?.data?.usage ?? null, content });
        if (index < maxAttempts) {
            logger?.(`trial: ${dumpBase} 输出不可解析（finish_reason=${finishReason ?? 'unknown'}），重试（${index}/${maxAttempts - 1}）`);
        }
    }
    await dumpTrialFailure(runDir, dumpBase, attempts, prompt.slice(0, 2000));
    return null;
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

function renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps = [], answerMeta = {} }) {
    const ISSUE_TAGS = {
        empty: '⚠️ 作答失败（模型未输出正文，非知识缺口）',
        truncated: '⚠️ 答卷被输出上限截断',
        'reasoning-only': '⚠️ 以推理段作答（正文未输出）'
    };
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
        const issueTag = answerMeta[question.id] ? ` ${ISSUE_TAGS[answerMeta[question.id].issue] || answerMeta[question.id].issue}` : '';
        lines.push(`## ${question.id}（${question.kind} / ${question.subskillId}）— ${(qScore * 100).toFixed(0)}%${issueTag}`);
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
        // 按考纲条目分次生成 + 实操题单独一次：整卷单次输出会顶满 max_tokens 被截断
        //（2026-10-11 实测 completion 恰为上限 6000 ×2，同 prompt 重试必然再截）。
        const examTemplate = loadTemplate(baseDir, 'examine.md', FALLBACK_EXAMINE_TEMPLATE);
        const renderExamPrompt = (outlineBlock, scopeNote) => examTemplate
            .replace(/\{\{displayName\}\}/g, blueprint.displayName)
            .replace(/\{\{name\}\}/g, blueprint.name)
            .replace(/\{\{examOutline\}\}/g, outlineBlock)
            .replace(/\{\{practicalPrompt\}\}/g, blueprint.practicalExam.prompt)
            .replace(/\{\{gradingDimensions\}\}/g, blueprint.practicalExam.gradingDimensions.join('、')) + scopeNote;
        const CONCEPT_SCOPE_NOTE = '\n\n【本次范围】只出考纲中列出子技能的概念题与应用题；不要出实操题（kind=practical）。';
        const PRACTICAL_SCOPE_NOTE = '\n\n【本次范围】只出 1 道 kind=practical 的实操题（题目即实操要求，带 gradingDimensions）；不要出概念题/应用题。';
        const outlineLine = (entry) => {
            const subskill = blueprint.subskills.find((s) => s.id === entry.subskillId);
            return `- ${entry.subskillId}（${subskill?.title || ''}）：${entry.conceptQuestions} 概念题 + ${entry.appliedQuestions} 应用题`;
        };

        // 跨批合并：题干/类型非法的丢弃；id 按考纲条目命名空间化（模型在每条
        // 目的输出里都会自复用 q1/q2 这类 id，直接按 id 去重会把整个子技能的
        // 题目静默吞掉——2026-10-11 实测两次补考 13 题缩水成 5 题、覆盖子技能
        // 随机漂移）；命名空间内重复仍去重（保留首个）。
        const mergedQuestions = [];
        const seenIds = new Set();
        const collectQuestions = (payload, scopeKey) => {
            const questions = Array.isArray(payload?.questions) ? payload.questions : [];
            for (const [index, question] of questions.entries()) {
                if (!question || typeof question.prompt !== 'string' || !question.prompt.trim() || !question.kind) {
                    logger?.(`trial: 丢弃格式非法的题目：${JSON.stringify(question?.id || question)}`);
                    continue;
                }
                const rawId = String(question.id || `q${index + 1}`);
                const id = `${scopeKey}-${rawId}`;
                if (seenIds.has(id)) {
                    continue;
                }
                seenIds.add(id);
                mergedQuestions.push({ ...question, id });
            }
        };

        for (const entry of blueprint.examOutline) {
            const payload = await completeJsonResilient({
                llm, llmConfig,
                prompt: renderExamPrompt(outlineLine(entry), CONCEPT_SCOPE_NOTE),
                temperature: 0.5,
                runDir,
                dumpBase: `exam-${entry.subskillId}`,
                arrayField: 'questions',
                validate: (candidate) => Array.isArray(candidate?.questions) && candidate.questions.length > 0,
                logger
            });
            if (!payload) {
                const error = new Error(`出题输出不可解析（subskill ${entry.subskillId}，已重试 ${TRIAL_MAX_ATTEMPTS - 1} 次；原始输出已留档 trial-failed/）`);
                error.code = 'FORGE_EXAM_OUTPUT_INVALID';
                error.status = 502;
                throw error;
            }
            collectQuestions(payload, entry.subskillId);
        }
        const practicalPayload = await completeJsonResilient({
            llm, llmConfig,
            prompt: renderExamPrompt('（本次不出概念/应用题）', PRACTICAL_SCOPE_NOTE),
            temperature: 0.5,
            runDir,
            dumpBase: 'exam-practical',
            arrayField: 'questions',
            validate: (candidate) => Array.isArray(candidate?.questions) && candidate.questions.length > 0,
            logger
        });
        if (!practicalPayload) {
            const error = new Error(`出题输出不可解析（实操题，已重试 ${TRIAL_MAX_ATTEMPTS - 1} 次；原始输出已留档 trial-failed/）`);
            error.code = 'FORGE_EXAM_OUTPUT_INVALID';
            error.status = 502;
            throw error;
        }
        collectQuestions(practicalPayload, 'practical');
        if (mergedQuestions.length === 0) {
            const error = new Error('出题输出不可解析（合并后无有效题目）');
            error.code = 'FORGE_EXAM_OUTPUT_INVALID';
            error.status = 502;
            throw error;
        }
        const exam = { questions: mergedQuestions };
        await writeExamFile(examsDir, 'exam.json', exam);

        const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
        const { answers, grading, ratio, passed, gaps, jev, answerMeta } = outcome;

        // §3.9 独立审计事件（区别于 forge.step.running 的步骤消息流）。
        ctx.audit?.('forge.exam.graded', {
            expertName: blueprint.name,
            step: 'trial',
            ratio,
            passed,
            gapCount: gaps.length,
            jevSkipped: Boolean(jev.skipped),
            ...(Object.keys(answerMeta || {}).length > 0 ? { answerIssues: answerMeta } : {})
        });

        const issueNote = Object.keys(answerMeta || {}).length > 0
            ? `；作答异常 ${Object.keys(answerMeta).length} 题（${Object.entries(answerMeta).map(([id, meta]) => `${id}:${meta.issue}`).join('、')}）`
            : '';
        return {
            summary: `试岗完成：总分 ${(ratio * 100).toFixed(1)}%（${passed ? '及格，待用户抽查' : '未及格，缺口 ' + gaps.length + ' 项'}）${issueNote}；Jev 对照${jev.skipped ? '跳过（' + jev.reason + '）' : '已留档'}`,
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
 * 盲测作答的弹性补全：正文为空或被截断时带「直接输出正文」强指令、加预算
 * 重试一次；两轮正文皆空时以推理段兜底（显式标注），仍无则以 issue='empty'
 * 留痕（判卷/报告/缺口据此区分「作答失败」与「知识缺口」）。
 */
async function completeBlindAnswer({ llm, llmConfig, prompt, questionId, logger }) {
    const completeOnce = (maxTokens, promptSuffix = '') => llm.complete(llmConfig, {
        model: llmConfig.model,
        messages: [{ role: 'user', content: prompt + promptSuffix }],
        temperature: 0.4,
        max_tokens: maxTokens
    });
    let choice = (await completeOnce(ANSWER_MAX_TOKENS))?.data?.choices?.[0];
    let content = String(choice?.message?.content || '').trim();
    let finishReason = choice?.finish_reason || null;
    if (content && finishReason !== 'length') {
        return { text: content, issue: null };
    }
    const why = content ? '正文被截断（finish_reason=length）' : '正文为空（疑似推理段耗尽输出预算）';
    logger?.(`trial: 考题 ${questionId} 作答${why}，带直接输出指令重试一次`);
    choice = (await completeOnce(ANSWER_RETRY_MAX_TOKENS, DIRECT_OUTPUT_NOTE))?.data?.choices?.[0];
    content = String(choice?.message?.content || '').trim();
    finishReason = choice?.finish_reason || null;
    if (content) {
        return { text: content, issue: finishReason === 'length' ? 'truncated' : null };
    }
    const reasoning = String(choice?.message?.reasoning_content || '').trim();
    if (reasoning) {
        logger?.(`trial: 考题 ${questionId} 正文两轮为空，以推理段兜底作答（显式标注）`);
        return { text: reasoning, issue: 'reasoning-only' };
    }
    logger?.(`trial: 考题 ${questionId} 两轮均未产出正文，按作答失败留痕`);
    return { text: '', issue: 'empty' };
}

/**
 * 盲测 + 判卷 + 评分 + 报告落盘的共享实现（trial 首考与回填后 retest 复用）。
 * exam 由调用方给定（retest 传原考卷，实现「同一套考题重测」§3.7）。
 */
async function runBlindAndGrade(ctx, { blueprint, exam, examsDir }) {
    const { llm, llmConfig, knowledgeStorePort, baseDir, logger, runDir } = ctx;
    const libraryName = blueprintLibraryName(blueprint.name);
    // 盲测（红线 1）：代查专属库 + 人设作答
    let persona = '';
        try {
            persona = await fsp.readFile(path.join(baseDir, `${blueprint.name}.txt`), 'utf8');
        } catch {
            persona = `你是${blueprint.displayName}，只依据给定知识库资料作答。`;
        }
        const answers = {};
        const answerMeta = {};
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
                // 正文先行：先给结论/清单本体，依据与边界说明收尾——避免大段
                // 前置免责声明稀释交付物（判卷 antiAiFlavor 实测扣分点）。
                '要求：依据上面的知识库资料作答；直接以答案正文开头（结论/清单/方案本体在前）；依据的知识卡编号与不确定处放在正文末尾；资料不足时在正文内说明知识边界；给出处；不编造。'
            ].join('\n');
            const { text, issue } = await completeBlindAnswer({
                llm, llmConfig, prompt: answerPrompt, questionId: question.id, logger
            });
            answers[question.id] = text;
            if (issue) {
                answerMeta[question.id] = { issue, notedAt: new Date().toISOString() };
            }
        }
        await writeExamFile(examsDir, 'answers.json', {
            answers,
            ...(Object.keys(answerMeta).length > 0 ? { answerMeta } : {})
        });

        // 3. 判卷（D7 第一步：五维 0-5 + 评语 + 知识卡引用）——按题分块（每块 ≤5 题），
        // 块输出远小于 max_tokens，杜绝整卷判卷被截断。
        // 作答异常注记随题透传给判卷官：「截断/作答失败」与「没写完/不会」不同罪。
        const ANSWER_ISSUE_NOTES = {
            empty: '（注：本题为作答失败——模型两轮未输出正文，非考生知识问题；按未作答评分，评语请注明「作答失败」）',
            truncated: '（注：本答卷因输出长度上限被截断——请就已写内容评分，评语注明「截断」）',
            'reasoning-only': '（注：本答卷取自模型推理段（正文未输出）——按内容质量正常评分，评语注明「推理段作答」）'
        };
        const examWithAnswers = exam.questions.map((question) => ({
            id: question.id,
            kind: question.kind,
            subskillId: question.subskillId,
            prompt: question.prompt,
            referencePoints: question.referencePoints,
            gradingDimensions: question.gradingDimensions,
            answer: answers[question.id],
            ...(answerMeta[question.id] ? { answerIssue: ANSWER_ISSUE_NOTES[answerMeta[question.id].issue] || answerMeta[question.id].issue } : {})
        }));
        let overallComment = '';
        const gradedQuestions = [];
        const chunks = [];
        const gradeTemplate = loadTemplate(baseDir, 'grade.md', FALLBACK_GRADE_TEMPLATE);
        for (let i = 0; i < examWithAnswers.length; i += GRADE_CHUNK_SIZE) {
            chunks.push(examWithAnswers.slice(i, i + GRADE_CHUNK_SIZE));
        }
        for (let index = 0; index < chunks.length; index += 1) {
            const gradePrompt = gradeTemplate
                .replace(/\{\{displayName\}\}/g, blueprint.displayName)
                .replace(/\{\{name\}\}/g, blueprint.name)
                .replace(/\{\{examWithAnswers\}\}/g, JSON.stringify(chunks[index], null, 2));
            const payload = await completeJsonResilient({
                llm, llmConfig,
                prompt: gradePrompt,
                temperature: 0.2,
                runDir,
                dumpBase: `grade-chunk-${index + 1}`,
                arrayField: 'gradedQuestions',
                validate: (candidate) => Array.isArray(candidate?.gradedQuestions),
                logger
            });
            if (!payload) {
                const error = new Error(`判卷输出不可解析（第 ${index + 1}/${chunks.length} 块，已重试 ${TRIAL_MAX_ATTEMPTS - 1} 次；原始输出已留档 trial-failed/）`);
                error.code = 'FORGE_GRADE_OUTPUT_INVALID';
                error.status = 502;
                throw error;
            }
            gradedQuestions.push(...payload.gradedQuestions);
            overallComment = payload.overallComment || overallComment;
        }
        // 完整性守卫：截断抢救/输出污染可能丢题——缺失题按 0 分计，并在总评注明
        //（缺失静默计 0 会歪曲及格判定，必须显式可见）。
        const missingIds = exam.questions
            .filter((question) => !gradedQuestions.some((graded) => graded && graded.id === question.id))
            .map((question) => question.id);
        if (missingIds.length > 0) {
            logger?.(`trial: 判卷缺失 ${missingIds.length} 题（${missingIds.join('、')}），按 0 分计`);
            overallComment = `${overallComment}（判卷缺失 ${missingIds.length} 题：${missingIds.join('、')}，按 0 分计）`;
        }
        const grading = { gradedQuestions, overallComment };

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
            // 作答失败（empty）是执行面问题而非知识缺口——不计入弱项，
            // 避免触发无意义的知识回填；截断/推理段作答保留（内容仍有信号）。
            if (questionRatio < PASS_RATIO && question.subskillId !== 'practical' && answerMeta[question.id]?.issue !== 'empty') {
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
        const reportMarkdown = renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps, answerMeta });
        assertNoSecrets(reportMarkdown, '验收报告');
        await fsp.writeFile(path.join(examsDir, 'grade-report.md'), reportMarkdown, 'utf8');

        return { answers, grading, ratio, passed, gaps, jev, answerMeta };
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
        const { readBlueprint } = require('./blueprint');
        const blueprint = await readBlueprint(ctx.blueprintPath);
        const examsDir = path.join(runDir, 'exams');

        const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
        const { ratio, passed, gaps } = outcome;

        const previousRatio = Number(retestOf.previousRatio) || 0;
        ctx.audit?.('forge.exam.graded', {
            expertName: blueprint.name,
            step: 'retest',
            previousRatio,
            ratio,
            passed,
            gapCount: gaps.length
        });
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
