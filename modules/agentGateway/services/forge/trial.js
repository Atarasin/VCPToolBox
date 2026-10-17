'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { extractCompleteArrayObjects } = require('./jsonUtils');
const {
    completeJsonResilient: completeJsonLadder,
    describeAttemptFailure,
    resolveThinkingMode
} = require('./jsonCompletion');
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
 * 元素 → 推理段兜底（正文为空时）→ 抬预算重试（8k → 32k）；彻底失败前原始
 * 输出留档 runDir/trial-failed/ 供事后诊断（与 distill-failed/ 同构）。
 * 判卷另有分块拆小重判（2026-10-17）：块输出整体不可用时按题拆半重判，而不是
 * 整单失败——覆盖轮（补判）继续兜底仍缺失的题。
 */

const PASS_RATIO = 0.8;
const GRADE_DIMENSIONS = ['correctness', 'completeness', 'professionalism', 'antiAiFlavor', 'actionability'];
const TRIAL_MAX_ATTEMPTS = 3;
const TRIAL_MAX_TOKENS = 8000;
// 抬预算重试：判卷保留思考（五维评分需要它），思考吃满 8000 时正文为空
//（2026-10-12 实测三次尝试 reasoning 7999/8000/8001、正文 0 字符）——
// 重试给 4 倍预算；供应商拒收则回落 12000。
const TRIAL_RETRY_MAX_TOKENS = 32000;
const TRIAL_RETRY_FALLBACK_TOKENS = 12000;
// 重试指令（抬预算那两次一并附上）：正文为本体，别让思考挤掉 JSON。
const TRIAL_RETRY_NOTE = '\n\n【重试要求】上一次输出不可用（正文为空或被截断）。请直接输出 JSON 本体：不要输出推理过程、分析或解释文字；只输出一个完整可解析的 JSON 对象，不要代码围栏。';
const GRADE_CHUNK_SIZE = 5;
// 判卷块拆半上限：5 题 → 3+2 → 2+1+1+1（单题块无路可退，转覆盖轮/显式缺失）。
const MAX_GRADE_CHUNK_SPLIT_DEPTH = 2;
// 盲测作答弹性（2026-10-11 补考实测）：应用/实操题是长交付物，3000 会中途
// 截断；推理型模型还可能把整个输出预算耗在推理段导致 message.content 为空
//（两题 0 分「未作答」）——空正文/截断时带「直接输出正文」强指令加预算重试。
// 工具调用标记泄漏检测：标记块（DSML / VCP TOOL_REQUEST / invoke）之外的
// 正文过薄即判定为泄漏——叙述性提及工具（正常答卷）不会被误伤。
const TOOL_CALL_MARKER_PATTERN = /<｜｜DSML｜｜|<<<\[TOOL_REQUEST\]>>>|<invoke[\s>]|antml:invoke/;
function stripToolCallMarkup(text) {
    return String(text || '')
        .replace(/<｜｜DSML｜｜[\s\S]*?(?:<\/｜｜DSML｜｜\s*calls>|$)/g, '')
        .replace(/<<<\[TOOL_REQUEST\]>>>[\s\S]*?(?:<<<\[END_TOOL_REQUEST\]>>>|$)/g, '')
        .replace(/<invoke[\s\S]*?(?:<\/invoke>|$)/g, '')
        .trim();
}
function detectToolCallLeak(text) {
    if (typeof text !== 'string' || !text || !TOOL_CALL_MARKER_PATTERN.test(text)) {
        return null;
    }
    const prose = stripToolCallMarkup(text);
    return prose.length < 200 ? { prose } : null;
}

// 索引就绪闸门（P1.3）：learn/蒸馏刚写盘的文件要等 TDB 队列消化（embedding
// 分钟级）才可检索——learn 完成 ≠ 知识可检索。开考前等待队列清零；超时或
// 端口无此能力 → 放行但在 summary/报告显式标注「检索可能缺最新知识」。
// env 在调用时读取（默认参数求值时机），120s/5s。
const resolvePositiveEnvInt = (name, fallback) => {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const ANSWER_MAX_TOKENS = 6000;
// 2026-10-11 补考 5 实测：重试 8000 仍会被中截（color-font-system-q2）——
// 交付物型应用题重试提到 12000；供应商若拒收该上限则回落 8000 再试一次。
const ANSWER_RETRY_MAX_TOKENS = 12000;
const ANSWER_RETRY_FALLBACK_TOKENS = 8000;
const DIRECT_OUTPUT_NOTE = '\n\n【输出要求】直接输出答案正文本身（结论/清单/方案本体在前）；不要输出推理过程、开场白或前置免责声明；依据的知识卡编号与不确定处放在正文末尾一行。';
const NO_TOOL_CALL_NOTE = '\n\n【考试环境说明】本环境没有任何可调用的工具——检索已由系统代为完成（见上方知识库检索结果）。严禁输出任何工具调用语法（<invoke>、DSML 标记、「始」「末」协议块等）；工具标记文本不是回答，出现即视为未作答。';

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
 * 出题/判卷共用的弹性 JSON 补全（jsonCompletion 阶梯的 trial 侧包装）：
 * 整体解析 → 按数组字段抢救完整元素（截断只损失被切开的尾元素）→ 正文为空时
 * 从推理段抢救 → 抬预算重试（8k → 32k）。全部失败时留档 trial-failed/ 并返回
 * 富结果 { payload: null, failureReason, attempts }，调用方按语义抛
 * FORGE_LLM_EMPTY_CONTENT / FORGE_*_OUTPUT_INVALID。
 */
async function completeJsonResilient({
    llm, llmConfig, prompt, temperature, runDir, dumpBase, arrayField, validate, logger,
    maxAttempts = TRIAL_MAX_ATTEMPTS, maxTokens = TRIAL_MAX_TOKENS,
    label = null, thinking = null
}) {
    const salvage = arrayField
        ? (text) => {
            const items = extractCompleteArrayObjects(text, `"${arrayField}"`);
            if (items.length === 0) {
                return null;
            }
            return arrayField === 'gradedQuestions'
                ? { gradedQuestions: items, overallComment: '' }
                : { [arrayField]: items };
        }
        : null;
    const result = await completeJsonLadder({
        llm,
        llmConfig,
        prompt,
        temperature,
        validate,
        salvage,
        logger,
        label: label || `trial: ${dumpBase}`,
        maxTokens,
        retryMaxTokens: TRIAL_RETRY_MAX_TOKENS,
        retryFallbackTokens: TRIAL_RETRY_FALLBACK_TOKENS,
        maxAttempts,
        retryNote: TRIAL_RETRY_NOTE,
        thinking: thinking || resolveThinkingMode('FORGE_TRIAL_THINKING', 'enabled')
    });
    if (!result.payload) {
        await dumpTrialFailure(runDir, dumpBase, result.attempts, prompt.slice(0, 2000));
    }
    return result;
}

// 出题/判卷失败的错误码与消息（正文为空与不可解析分开报，面板/日志一眼可辨）。
function trialOutputFailure({ attempts, failureReason }, { what, dumpBase }) {
    const failure = describeAttemptFailure(attempts);
    const error = new Error(
        `${what}${failure.summary}（已尝试 ${attempts.length} 次；finish_reason=${failure.finishReasons}；原始输出已留档 trial-failed/${dumpBase}）`
    );
    error.code = failureReason === 'empty-content' ? 'FORGE_LLM_EMPTY_CONTENT' : 'FORGE_EXAM_OUTPUT_INVALID';
    error.status = 502;
    error.details = { finishReasons: failure.finishReasons, reasoningTokens: failure.reasoningTokens, blankAttempts: failure.blankCount };
    return error;
}

// ── 判卷共享构件（首考 / 回填重测 / 补判共用）──────────────────────────────

const GRADE_COVERAGE_PASSES = 2;

// 作答异常注记随题透传给判卷官：「截断/作答失败」与「没写完/不会」不同罪。
const ANSWER_ISSUE_NOTES = {
    empty: '（注：本题为作答失败——模型两轮未输出正文，非考生知识问题；按未作答评分，评语请注明「作答失败」）',
    'tool-leak': '（注：本答卷重答后仍残留工具调用标记——按标记之外的正文评分，评语请注明「工具调用泄漏」；这是人设/环境适配问题而非知识缺口）',
    truncated: '（注：本答卷因输出长度上限被截断——请就已写内容评分，评语注明「截断」，并在评语末尾估算「若未截断，本题还可多得几分」——截断失分估算是验收归因依据）',
    'reasoning-only': '（注：本答卷取自模型推理段（正文未输出）——按内容质量正常评分，评语注明「推理段作答」）'
};

// 判卷输入条目：考题 + 答卷 + 作答异常注记。
function buildGradeEntries({ exam, answers, answerMeta = {} }) {
    return exam.questions.map((question) => ({
        id: question.id,
        kind: question.kind,
        subskillId: question.subskillId,
        prompt: question.prompt,
        referencePoints: question.referencePoints,
        gradingDimensions: question.gradingDimensions,
        answer: answers[question.id],
        ...(answerMeta[question.id]
            ? { answerIssue: ANSWER_ISSUE_NOTES[answerMeta[question.id].issue] || answerMeta[question.id].issue }
            : {})
    }));
}

/**
 * 单块判卷（含拆半重判，2026-10-17）：块输出整体不可用时按题拆半重判，
 * 而不是让整单失败；拆到单题仍不可用即认输，把该题交回覆盖轮/显式缺失。
 * 返回 { gradedQuestions, overallComment, failures }（failures 记失败块与原因，
 * 供终态错误消息点名「哪些题是判卷输出不可用而非漏判」）。
 */
async function gradeChunkResilient({
    llm, llmConfig, gradeTemplate, blueprint, runDir, logger,
    entries, dumpBase, depth = 0
}) {
    const gradePrompt = gradeTemplate
        .replace(/\{\{displayName\}\}/g, blueprint.displayName)
        .replace(/\{\{name\}\}/g, blueprint.name)
        .replace(/\{\{examWithAnswers\}\}/g, JSON.stringify(entries, null, 2));
    const result = await completeJsonResilient({
        llm, llmConfig,
        prompt: gradePrompt,
        temperature: 0.2,
        runDir,
        dumpBase,
        arrayField: 'gradedQuestions',
        // 只要求是数组（允许空）：块输出漏题/空输出交给覆盖轮补判，
        // 最终仍缺失才 FORGE_GRADE_MISSING（2026-10-12 缺陷 4）。
        validate: (candidate) => Array.isArray(candidate?.gradedQuestions),
        logger
    });
    if (result.payload) {
        return { gradedQuestions: result.payload.gradedQuestions, overallComment: result.payload.overallComment || '', failures: [] };
    }

    const failure = { dumpBase, questions: entries.length, reason: result.failureReason };
    if (entries.length > 1 && depth < MAX_GRADE_CHUNK_SPLIT_DEPTH) {
        const mid = Math.ceil(entries.length / 2);
        logger?.(`trial: ${dumpBase} 判卷输出不可用（${result.failureReason === 'empty-content' ? '正文为空' : '不可解析'}），拆半重判（${entries.length} 题 → ${mid}+${entries.length - mid}）`);
        const merged = { gradedQuestions: [], overallComment: '', failures: [] };
        const halves = [entries.slice(0, mid), entries.slice(mid)];
        for (let offset = 0; offset < halves.length; offset += 1) {
            const part = await gradeChunkResilient({
                llm, llmConfig, gradeTemplate, blueprint, runDir, logger,
                entries: halves[offset],
                dumpBase: `${dumpBase}${String.fromCharCode(97 + offset)}`,
                depth: depth + 1
            });
            merged.gradedQuestions.push(...part.gradedQuestions);
            merged.overallComment = part.overallComment || merged.overallComment;
            merged.failures.push(...part.failures);
        }
        return merged;
    }

    logger?.(`trial: ${dumpBase} 判卷输出不可用且无法再拆（${entries.length} 题，${result.failureReason === 'empty-content' ? '正文为空' : '不可解析'}），交回覆盖轮补判`);
    return { gradedQuestions: [], overallComment: '', failures: [failure] };
}

/**
 * 覆盖式判卷（2026-10-12 缺陷 4）：分块判卷后核对块内覆盖——截断抢救/
 * 输出污染丢的题进入下一轮补判（只判缺失题），共 GRADE_COVERAGE_PASSES 轮；
 * 仍缺失即抛 FORGE_GRADE_MISSING 显式失败，绝不静默按 0 分计（答卷已存
 * exams/answers.json，可用 gateway_forge_regrade 仅补判缺失题）。
 * 全部块判卷输出不可用时不空转补判轮：直接按原因抛
 * FORGE_LLM_EMPTY_CONTENT / FORGE_GRADE_OUTPUT_INVALID（2026-10-17）。
 */
async function gradeEntriesWithCoverage({ llm, llmConfig, baseDir, runDir, logger, blueprint, entries, dumpBasePrefix = 'grade' }) {
    const gradeTemplate = loadTemplate(baseDir, 'grade.md', FALLBACK_GRADE_TEMPLATE);
    const gradedQuestions = [];
    const seenGraded = new Set();
    const failures = [];
    let overallComment = '';
    let pending = [...entries];
    for (let pass = 1; pass <= GRADE_COVERAGE_PASSES && pending.length > 0; pass += 1) {
        const chunks = [];
        for (let i = 0; i < pending.length; i += GRADE_CHUNK_SIZE) {
            chunks.push(pending.slice(i, i + GRADE_CHUNK_SIZE));
        }
        const stillMissing = [];
        let passFailedChunks = 0;
        for (let index = 0; index < chunks.length; index += 1) {
            const chunkResult = await gradeChunkResilient({
                llm, llmConfig, gradeTemplate, blueprint, runDir, logger,
                entries: chunks[index],
                dumpBase: `${dumpBasePrefix}-chunk-${index + 1}${pass > 1 ? `-retry${pass}` : ''}`
            });
            if (chunkResult.gradedQuestions.length === 0 && chunkResult.failures.length > 0) {
                passFailedChunks += 1;
                failures.push(...chunkResult.failures);
            }
            for (const graded of chunkResult.gradedQuestions) {
                if (graded && typeof graded.id === 'string' && graded.id && !seenGraded.has(graded.id)) {
                    seenGraded.add(graded.id);
                    gradedQuestions.push(graded);
                }
            }
            overallComment = chunkResult.overallComment || overallComment;
            const covered = new Set(chunkResult.gradedQuestions.map((graded) => graded?.id));
            stillMissing.push(...chunks[index].filter((entry) => !covered.has(entry.id)));
        }
        // 整卷零判出且失败块全为同一形态：补判轮只会重演（合同一模型、同一批题），
        // 直接给出根因错误码，省一轮费用（追问到「不可解析」才保留原码）。
        if (gradedQuestions.length === 0 && failures.length > 0 && passFailedChunks === chunks.length) {
            const emptyContent = failures.every((failure) => failure.reason === 'empty-content');
            const error = new Error(
                emptyContent
                    ? `判卷正文为空——${failures.length} 个块（含拆半后）均无正文输出，模型把输出预算耗在推理段；原始输出已留档 trial-failed/`
                    : `判卷输出不可解析——${failures.length} 个块（含拆半后）均无法解析；原始输出已留档 trial-failed/`
            );
            error.code = emptyContent ? 'FORGE_LLM_EMPTY_CONTENT' : 'FORGE_GRADE_OUTPUT_INVALID';
            error.status = 502;
            error.details = { failedChunks: failures };
            throw error;
        }
        pending = stillMissing;
        if (pending.length > 0 && pass < GRADE_COVERAGE_PASSES) {
            logger?.(`trial: ${dumpBasePrefix} 判卷缺失 ${pending.length} 题（${pending.map((entry) => entry.id).join('、')}），进入补判轮 ${pass + 1}/${GRADE_COVERAGE_PASSES}`);
        }
    }
    if (pending.length > 0) {
        const unusable = failures.length > 0
            ? `；其中 ${failures.length} 次块判卷输出不可用（${[...new Set(failures.map((failure) => failure.reason === 'empty-content' ? '正文为空' : '不可解析'))].join('/')}）`
            : '';
        const error = new Error(`判卷缺失 ${pending.length} 题（${pending.map((entry) => entry.id).join('、')}）——补判 ${GRADE_COVERAGE_PASSES} 轮仍不完整，拒绝按 0 分计${unusable}（答卷已存 exams/answers.json，可用 gateway_forge_regrade 仅补判缺失题）`);
        error.code = 'FORGE_GRADE_MISSING';
        error.status = 502;
        error.details = { missingIds: pending.map((entry) => entry.id), failedChunks: failures };
        throw error;
    }
    return { gradedQuestions, overallComment };
}

// 计分与缺口抽取（首考/重测/补判共用）：五维 0-5 折算总分、及格判定、弱项映射缺口。
function scoreGrading({ exam, gradedQuestions, overallComment, answerMeta = {} }) {
    const grading = { gradedQuestions, overallComment };
    let earned = 0;
    let full = 0;
    const weakQuestions = [];
    for (const question of exam.questions) {
        const graded = grading.gradedQuestions.find((g) => g.id === question.id);
        const scores = graded?.scores || {};
        const dims = GRADE_DIMENSIONS.map((dim) => Number(scores[dim]) || 0);
        const questionFull = GRADE_DIMENSIONS.length * 5;
        const questionEarned = dims.reduce((sum, value) => sum + Math.min(5, Math.max(0, value)), 0);
        earned += questionEarned;
        full += questionFull;
        const questionRatio = questionEarned / questionFull;
        // 作答失败（empty）与工具调用泄漏（tool-leak）是执行面/人设问题
        // 而非知识缺口——不计入弱项，避免触发无意义的知识回填；截断/
        // 推理段作答保留（内容仍有信号）。
        const answerIssue = answerMeta[question.id]?.issue;
        if (questionRatio < PASS_RATIO && question.subskillId !== 'practical'
            && answerIssue !== 'empty' && answerIssue !== 'tool-leak') {
            weakQuestions.push({ id: question.id, subskillId: question.subskillId, ratio: questionRatio });
        }
    }
    const ratio = full > 0 ? earned / full : 0;
    const passed = ratio >= PASS_RATIO;
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
    return { grading, ratio, passed, gaps };
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
    const seenCards = new Set();
    try {
        const hits = await knowledgeStorePort.search(keywords[0] || '', { libraries: [libraryName], topK });
        for (const hit of Array.isArray(hits) ? hits : []) {
            const title = hit.title || hit.sourceFile || '(untitled)';
            // 同一知识卡的多 chunk 会重复占位（2026-10-11 实测：topK 5 实际仅
            // 3 张唯一卡）——按标题去重，把配额还给多样性。
            if (seenCards.has(title)) {
                continue;
            }
            seenCards.add(title);
            cards.push({
                title,
                text: String(hit.text || hit.content || '').slice(0, 1200),
                score: hit.score
            });
        }
    } catch {
        // 检索异常视为无可用知识——被考者按知识边界作答。
    }
    return { cards, skipped: false };
}

function renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps = [], answerMeta = {}, indexReadiness = null, retrievals = null }) {
    const ISSUE_TAGS = {
        empty: '⚠️ 作答失败（模型未输出正文，非知识缺口）',
        'tool-leak': '⚠️ 工具调用标记泄漏（已剥离标记，非知识缺口）',
        truncated: '⚠️ 答卷被输出上限截断',
        'reasoning-only': '⚠️ 以推理段作答（正文未输出）'
    };
    const lines = [];
    lines.push(`# ${blueprint.displayName}（${blueprint.name}）上岗验收报告`);
    lines.push('');
    lines.push(`- 及格线：${PASS_RATIO * 100}%（Q5：${blueprint.acceptanceSample}）`);
    lines.push(`- 总分：${(ratio * 100).toFixed(1)}%（${passed ? '✅ 及格，待用户抽查（D3）' : '❌ 未及格，进入定向补课'}）`);
    lines.push(`- 知识库：${libraryName}`);
    if (exam.meta) {
        const meta = exam.meta;
        lines.push(`- 考卷：${meta.questionCount} 题 / 覆盖 ${meta.coveredSubskills.length}/${meta.outlinedSubskills.length} 子技能 / 哈希 ${meta.examHash}${meta.salvagedGenerations > 0 ? `（含 ${meta.salvagedGenerations} 批截断抢救）` : ''}${meta.degradedEntries.length > 0 ? `（⚠️ 题量不足条目：${meta.degradedEntries.join('、')}）` : ''}`);
    }
    if (indexReadiness && indexReadiness.checked && indexReadiness.ready === false) {
        lines.push(`- ⚠️ 开考时索引队列未清空（剩余 ${indexReadiness.pending} 项）：检索可能缺最新入库知识`);
    }
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
        // 检索归因（反馈 3）：低分题先看「当时检索到了什么」——知识缺失/
        // 没召回/召回了没用上，三种归因的修法完全不同。
        const hits = retrievals?.[question.id];
        if (Array.isArray(hits)) {
            lines.push(`**检索命中**：${hits.length > 0 ? hits.join('；') : '（未命中——按知识边界作答）'}`);
            lines.push('');
        }
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
    const answerDigest = Object.entries(answers).map(([id, text]) => `[${id}] ${String(text).slice(0, 800)}`).join('\n\n');
    const questions = {
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
    };
    // 网络瞬断（TLS/超时）重试一次——对照试点失败只降级留痕，但能救则救
    //（2026-10-12 缺陷 4 ③：与判卷缺失同日发生，疑似同源网络抖动）。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const decision = await jevPort.decide(
                { role: `${displayName} 上岗考试答卷`, answers: answerDigest },
                questions
            );
            return { skipped: false, decision };
        } catch (error) {
            if (attempt >= 2) {
                return { skipped: true, reason: `jev 调用失败（已重试 1 次）：${error.message}` };
            }
        }
    }
    return { skipped: true, reason: 'jev 调用失败：未知错误' };
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
        let salvagedGenerations = 0;
        const noteSalvage = (payload) => {
            if (payload && payload.salvaged === true) {
                salvagedGenerations += 1;
            }
            return payload;
        };
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

        // 固定考卷重考（反馈 2）：复用指定源任务的 exam.json——跨轮分数对比
        // 消除重新出卷带来的系统性噪声；哈希重算防篡改，形状不合法直接拒绝。
        if (ctx.fixedExam && Array.isArray(ctx.fixedExam.questions) && ctx.fixedExam.questions.length > 0) {
            const reusedMeta = ctx.fixedExam.meta && typeof ctx.fixedExam.meta === 'object'
                ? ctx.fixedExam.meta
                : {};
            const exam = {
                questions: ctx.fixedExam.questions,
                meta: {
                    ...reusedMeta,
                    reusedFrom: ctx.examRef?.sourceJobId || reusedMeta.reusedFrom || null,
                    examHash: crypto.createHash('sha256').update(JSON.stringify(ctx.fixedExam.questions)).digest('hex').slice(0, 16)
                }
            };
            await writeExamFile(examsDir, 'exam.json', exam);
            const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
            const { ratio, passed, gaps, jev, answerMeta, indexReadiness } = outcome;
            ctx.audit?.('forge.exam.graded', {
                expertName: blueprint.name,
                step: 'trial',
                ratio,
                passed,
                gapCount: gaps.length,
                jevSkipped: Boolean(jev.skipped),
                fixedExamHash: exam.meta.examHash
            });
            const issueNote = Object.keys(answerMeta || {}).length > 0
                ? `；作答异常 ${Object.keys(answerMeta).length} 题（${Object.entries(answerMeta).map(([id, meta]) => `${id}:${meta.issue}`).join('、')}）`
                : '';
            const indexNote = indexReadiness && indexReadiness.checked && indexReadiness.ready === false
                ? `；⚠️ 开考时索引队列未清空（剩余 ${indexReadiness.pending} 项），检索可能缺最新知识`
                : '';
            return {
                summary: `试岗完成（固定考卷 ${exam.meta.examHash.slice(0, 8)}）：总分 ${(ratio * 100).toFixed(1)}%（${passed ? '及格，待用户抽查' : '未及格，缺口 ' + gaps.length + ' 项'}）${issueNote}${indexNote}；Jev 对照${jev.skipped ? '跳过（' + jev.reason + '）' : '已留档'}`,
                artifacts: ['exams/grade-report.md', 'exams/comparison.json'],
                state: {
                    passed,
                    ratio,
                    gaps,
                    examMeta: exam.meta,
                    indexReadiness,
                    userGate: passed ? {
                        kind: 'trial-report',
                        reportPath: path.relative(path.join(baseDir, '..'), path.join(examsDir, 'grade-report.md')),
                        hint: '试岗及格，请用户抽查验收报告（D3）'
                    } : null
                }
            };
        }

        // 抽考范围（反馈 4）：subskillIds 过滤考纲条目（冒烟试岗/定向验证）；
        // 门禁与元数据按有效条目集校验，实操题始终包含。
        const scopedIds = Array.isArray(ctx.examSubskillIds) ? ctx.examSubskillIds : null;
        const effectiveOutline = scopedIds
            ? blueprint.examOutline.filter((entry) => scopedIds.includes(entry.subskillId))
            : blueprint.examOutline;

        for (const entry of effectiveOutline) {
            const examDumpBase = `exam-${entry.subskillId}`;
            const examResult = await completeJsonResilient({
                llm, llmConfig,
                prompt: renderExamPrompt(outlineLine(entry), CONCEPT_SCOPE_NOTE),
                temperature: 0.5,
                runDir,
                dumpBase: examDumpBase,
                arrayField: 'questions',
                validate: (candidate) => Array.isArray(candidate?.questions) && candidate.questions.length > 0,
                logger
            });
            if (!examResult.payload) {
                throw trialOutputFailure(examResult, {
                    what: `出题（subskill ${entry.subskillId}）输出`,
                    dumpBase: examDumpBase
                });
            }
            noteSalvage(examResult.payload);
            collectQuestions(examResult.payload, entry.subskillId);
        }
        const practicalResult = await completeJsonResilient({
            llm, llmConfig,
            prompt: renderExamPrompt('（本次不出概念/应用题）', PRACTICAL_SCOPE_NOTE),
            temperature: 0.5,
            runDir,
            dumpBase: 'exam-practical',
            arrayField: 'questions',
            validate: (candidate) => Array.isArray(candidate?.questions) && candidate.questions.length > 0,
            logger
        });
        if (!practicalResult.payload) {
            throw trialOutputFailure(practicalResult, {
                what: '出题（实操题）输出',
                dumpBase: 'exam-practical'
            });
        }
        noteSalvage(practicalResult.payload);
        collectQuestions(practicalResult.payload, 'practical');

        // 完整性门禁（P1.1）：考纲条目零覆盖或缺实操题 = 残卷，直接 fail——
        // 残卷评分与完整卷在外观上无法区分，曾误导进修决策（47.2%/56.0% 两轮
        // 无效成绩）。残卷仍落盘供取证（meta.incomplete），但不进入评分。
        const outlinedEntries = effectiveOutline.map((entry) => ({
            subskillId: entry.subskillId,
            expected: (entry.conceptQuestions || 0) + (entry.appliedQuestions || 0)
        }));
        const coverage = outlinedEntries.map((entry) => ({
            ...entry,
            actual: mergedQuestions.filter((question) => question.subskillId === entry.subskillId).length
        }));
        const examMeta = {
            questionCount: mergedQuestions.length,
            outlinedSubskills: outlinedEntries.map((entry) => entry.subskillId),
            coveredSubskills: coverage.filter((entry) => entry.actual > 0).map((entry) => entry.subskillId),
            practicalIncluded: mergedQuestions.some((question) => question.kind === 'practical'),
            degradedEntries: coverage.filter((entry) => entry.actual > 0 && entry.actual < entry.expected).map((entry) => entry.subskillId),
            salvagedGenerations,
            ...(scopedIds ? { scoped: true } : {}),
            examHash: crypto.createHash('sha256').update(JSON.stringify(mergedQuestions)).digest('hex').slice(0, 16),
            generatedAt: new Date().toISOString()
        };
        const missingCoverage = coverage.filter((entry) => entry.actual === 0).map((entry) => entry.subskillId);
        if (missingCoverage.length > 0 || !examMeta.practicalIncluded || mergedQuestions.length === 0) {
            const error = new Error(
                `考卷不完整（覆盖 ${examMeta.coveredSubskills.length}/${outlinedEntries.length} 子技能，`
                + `${missingCoverage.length > 0 ? `缺失：${missingCoverage.join('、')}；` : ''}`
                + `${examMeta.practicalIncluded ? '' : '缺实操题；'}已留盘 exam.json 供取证，不进入评分）`
            );
            error.code = 'FORGE_EXAM_INCOMPLETE';
            error.status = 502;
            error.details = { examMeta, missingCoverage };
            await writeExamFile(examsDir, 'exam.json', { questions: mergedQuestions, meta: { ...examMeta, incomplete: true } });
            throw error;
        }
        const exam = { questions: mergedQuestions, meta: examMeta };
        await writeExamFile(examsDir, 'exam.json', exam);

        const outcome = await runBlindAndGrade(ctx, { blueprint, exam, examsDir });
        const { answers, grading, ratio, passed, gaps, jev, answerMeta, indexReadiness } = outcome;

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
        const examNote = `；考卷 ${examMeta.questionCount} 题覆盖 ${examMeta.coveredSubskills.length}/${examMeta.outlinedSubskills.length} 子技能（哈希 ${examMeta.examHash.slice(0, 8)}）`;
        const indexNote = indexReadiness && indexReadiness.checked && indexReadiness.ready === false
            ? `；⚠️ 开考时索引队列未清空（剩余 ${indexReadiness.pending} 项），检索可能缺最新知识`
            : '';
        return {
            summary: `试岗完成：总分 ${(ratio * 100).toFixed(1)}%（${passed ? '及格，待用户抽查' : '未及格，缺口 ' + gaps.length + ' 项'}）${examNote}${issueNote}${indexNote}；Jev 对照${jev.skipped ? '跳过（' + jev.reason + '）' : '已留档'}`,
            artifacts: ['exams/grade-report.md', 'exams/comparison.json'],
            state: {
                passed,
                ratio,
                gaps,
                examMeta,
                indexReadiness,
                userGate: passed ? {
                    kind: 'trial-report',
                    reportPath: path.relative(path.join(baseDir, '..'), path.join(examsDir, 'grade-report.md')),
                    hint: '试岗及格，请用户抽查验收报告（D3）'
                } : null
            }
        };
    };
}

// 索引就绪闸门：pendingIngestCount 归零或超时；端口无此能力按「未知」放行。
async function waitForIndexReadiness(knowledgeStorePort, { logger, timeoutMs = resolvePositiveEnvInt('FORGE_INDEX_READINESS_TIMEOUT_MS', 120000), intervalMs = resolvePositiveEnvInt('FORGE_INDEX_READINESS_INTERVAL_MS', 5000) } = {}) {
    if (!knowledgeStorePort || knowledgeStorePort.available === false) {
        return { checked: false };
    }
    if (typeof knowledgeStorePort.pendingIngestCount !== 'function') {
        return { checked: false, reason: '端口未暴露 pendingIngestCount' };
    }
    const readCount = async () => {
        try {
            const value = await knowledgeStorePort.pendingIngestCount();
            return Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    };
    let pending = await readCount();
    if (pending === null) {
        return { checked: false, reason: '队列深度不可读' };
    }
    const deadline = Date.now() + timeoutMs;
    while (pending > 0 && Date.now() < deadline) {
        logger?.(`trial: TDB 摄取队列未清空（${pending} 项），等待索引就绪…`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        pending = await readCount();
    }
    return pending > 0
        ? { checked: true, ready: false, pending }
        : { checked: true, ready: true, pending };
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
    let leak = content ? detectToolCallLeak(content) : null;
    if (!leak && content && finishReason !== 'length') {
        return { text: content, issue: null };
    }
    const why = leak
        ? '正文本体是工具调用标记（DSML/TOOL_REQUEST 泄漏）'
        : (content ? '正文被截断（finish_reason=length）' : '正文为空（疑似推理段耗尽输出预算）');
    logger?.(`trial: 考题 ${questionId} 作答${why}，带直接输出指令重试一次`);
    const retryNote = DIRECT_OUTPUT_NOTE + (leak ? NO_TOOL_CALL_NOTE : '');
    try {
        choice = (await completeOnce(ANSWER_RETRY_MAX_TOKENS, retryNote))?.data?.choices?.[0];
    } catch (error) {
        // 供应商可能拒收超过其输出上限的 max_tokens——回落到既有安全上限再试。
        logger?.(`trial: 考题 ${questionId} 重试上限 ${ANSWER_RETRY_MAX_TOKENS} 被拒（${error.message}），回落 ${ANSWER_RETRY_FALLBACK_TOKENS}`);
        choice = (await completeOnce(ANSWER_RETRY_FALLBACK_TOKENS, retryNote))?.data?.choices?.[0];
    }
    content = String(choice?.message?.content || '').trim();
    finishReason = choice?.finish_reason || null;
    leak = content ? detectToolCallLeak(content) : null;
    if (leak) {
        // 重答仍泄漏：保留剥离标记后的残余正文（可能为空），显式留痕。
        return { text: leak.prose, issue: 'tool-leak' };
    }
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
    // 索引就绪闸门（P1.3）：刚写盘的知识未被消化时盲测检索不到——等待或显式告警。
    const indexReadiness = await waitForIndexReadiness(knowledgeStorePort, { logger });
    // 盲测（红线 1）：代查专属库 + 人设作答
    let persona = '';
        try {
            persona = await fsp.readFile(path.join(baseDir, `${blueprint.name}.txt`), 'utf8');
        } catch {
            persona = `你是${blueprint.displayName}，只依据给定知识库资料作答。`;
        }
        const answers = {};
        const answerMeta = {};
        const retrievals = {};
        for (const question of exam.questions) {
            const keywords = Array.isArray(question.searchKeywords) && question.searchKeywords.length > 0
                ? question.searchKeywords
                : [question.prompt.slice(0, 40)];
            const { cards } = await blindSearch(knowledgeStorePort, libraryName, keywords);
            retrievals[question.id] = cards.map((card) => card.title);
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
                '要求：依据上面的知识库资料作答；直接以答案正文开头（结论/清单/方案本体在前）；依据的知识卡编号与不确定处放在正文末尾；资料未覆盖的部分，先用公认专业原则给出判断并标注「（通行原则，库内无直接资料）」，不要整体拒答（2026-10-11 教训：单纯声明边界导致概念题漏气）；给出处；不编造。篇幅纪律：正文控制在约 1500 字内，表格与要点优先、论述从简——超出部分视为未作答。本环境无任何可调用工具，严禁输出工具调用语法。'
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
            retrievals,
            ...(Object.keys(answerMeta).length > 0 ? { answerMeta } : {})
        });

        // 3. 判卷（D7 第一步：五维 0-5 + 评语 + 知识卡引用）——覆盖式：
        // 分块 → 块内缺失补判 → 仍缺失 FORGE_GRADE_MISSING 显式失败
        //（绝不静默按 0 分计，2026-10-12 缺陷 4）。
        const entriesForGrading = buildGradeEntries({ exam, answers, answerMeta });
        const { gradedQuestions, overallComment } = await gradeEntriesWithCoverage({
            llm, llmConfig, baseDir, runDir, logger, blueprint, entries: entriesForGrading
        });
        const { grading, ratio, passed, gaps } = scoreGrading({
            exam, gradedQuestions, overallComment, answerMeta
        });

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
        const reportMarkdown = renderReportMarkdown({ blueprint, exam, answers, grading, passed, ratio, libraryName, gaps, answerMeta, indexReadiness, retrievals });
        assertNoSecrets(reportMarkdown, '验收报告');
        await fsp.writeFile(path.join(examsDir, 'grade-report.md'), reportMarkdown, 'utf8');

        return { answers, grading, ratio, passed, gaps, jev, answerMeta, indexReadiness, retrievals };
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

/**
 * 补判（2026-10-12 缺陷 4 ②）：判卷缺失题曾被静默按 0 分计导致误判不及格——
 * 对源任务已保存的答卷**仅重判缺失题**：合并既有判卷、重算总分与缺口、重写
 * 报告并排前后分；不作答、不出卷，成本远低于整卷重考（补试岗）。
 */
function createRegradeStepRunner() {
    return async function runRegradeStep(ctx) {
        const { runDir, baseDir, llm, llmConfig, logger } = ctx;
        const regradeOf = ctx.regradeOf;
        if (!regradeOf?.examsDir) {
            const error = new Error('regrade 需要 regradeOf.examsDir（源任务 exams 目录）');
            error.code = 'FORGE_REGRADE_SOURCE_MISSING';
            error.status = 400;
            throw error;
        }
        if (!llm || llm.available !== true || !llmConfig?.url) {
            const error = new Error('llmCompletion 端口不可用，无法补判');
            error.code = 'FORGE_LLM_UNAVAILABLE';
            error.status = 503;
            throw error;
        }
        const readSourceJson = async (file) => JSON.parse(await fsp.readFile(path.join(regradeOf.examsDir, file), 'utf8'));
        let exam;
        let saved;
        let previousReport;
        try {
            exam = await readSourceJson('exam.json');
            saved = await readSourceJson('answers.json');
            previousReport = await readSourceJson('grade-report.json');
        } catch (error) {
            const wrapped = new Error(`源任务考试产物不可读（${regradeOf.examsDir}）：${error.message}`);
            wrapped.code = 'FORGE_REGRADE_SOURCE_INVALID';
            wrapped.status = 502;
            throw wrapped;
        }
        if (!Array.isArray(exam.questions) || exam.questions.length === 0) {
            const error = new Error('源任务考卷不可用（无 questions）');
            error.code = 'FORGE_REGRADE_SOURCE_INVALID';
            error.status = 502;
            throw error;
        }
        const { readBlueprint } = require('./blueprint');
        const blueprint = await readBlueprint(ctx.blueprintPath);
        const libraryName = blueprintLibraryName(blueprint.name);
        const examsDir = path.join(runDir, 'exams');

        const answers = saved.answers || {};
        const answerMeta = saved.answerMeta || {};
        const previousGraded = Array.isArray(previousReport?.grading?.gradedQuestions)
            ? previousReport.grading.gradedQuestions.filter((g) => g && typeof g.id === 'string' && g.scores && typeof g.scores === 'object')
            : [];
        const missingEntries = buildGradeEntries({ exam, answers, answerMeta })
            .filter((entry) => !previousGraded.some((g) => g.id === entry.id));
        if (missingEntries.length === 0) {
            const error = new Error('源任务判卷完整，无缺失题可补判（如需重考请走补试岗）');
            error.code = 'FORGE_REGRADE_NOTHING_MISSING';
            error.status = 400;
            throw error;
        }

        const { gradedQuestions, overallComment } = await gradeEntriesWithCoverage({
            llm, llmConfig, baseDir, runDir, logger, blueprint,
            entries: missingEntries, dumpBasePrefix: 'regrade'
        });
        // 合并：既有有效判卷保留 + 本次补判（同 id 以补判为准）。
        const merged = [
            ...previousGraded.filter((g) => !gradedQuestions.some((fresh) => fresh.id === g.id)),
            ...gradedQuestions
        ];
        const previousRatio = Number(previousReport?.ratio) || 0;
        const mergedComment = `${previousReport?.grading?.overallComment || ''}（补判 ${missingEntries.length} 题：${missingEntries.map((e) => e.id).join('、')}）${overallComment}`.trim();
        const { grading, ratio, passed, gaps } = scoreGrading({
            exam, gradedQuestions: merged, overallComment: mergedComment, answerMeta
        });

        // Jev 对照随补判重出（对同一批答卷，与补判后结论对齐）。
        const jev = await jevCrossCheck(ctx.jevPort, { displayName: blueprint.displayName, answers });
        const comparison = {
            comparedAt: new Date().toISOString(),
            llm: { ratio, passed, gradedQuestions: grading.gradedQuestions },
            jev,
            note: '补判后重留档：LLM 主判（既有判卷 + 缺失题补判合并）；Jev 类型化复判对照'
        };
        await writeExamFile(examsDir, 'comparison.json', comparison);
        await writeExamFile(examsDir, 'gaps.json', { gaps, generatedAt: new Date().toISOString() });

        const report = {
            passed,
            ratio,
            passLine: PASS_RATIO,
            grading,
            gaps,
            libraryName,
            regraded: {
                fromJobId: regradeOf.jobId || null,
                regradedQuestionIds: missingEntries.map((entry) => entry.id),
                previousRatio,
                at: new Date().toISOString()
            }
        };
        await writeExamFile(examsDir, 'grade-report.json', report);
        const reportMarkdown = renderReportMarkdown({
            blueprint, exam, answers, grading, passed, ratio, libraryName, gaps, answerMeta,
            indexReadiness: { checked: false, note: '补判复用首考答卷（索引状态以首考报告为准）' },
            retrievals: saved.retrievals || {}
        });
        assertNoSecrets(reportMarkdown, '补判验收报告');
        await fsp.writeFile(path.join(examsDir, 'grade-report.md'), reportMarkdown, 'utf8');

        ctx.audit?.('forge.exam.regraded', {
            expertName: blueprint.name,
            sourceJobId: regradeOf.jobId || null,
            regradedCount: missingEntries.length,
            previousRatio,
            ratio,
            passed,
            gapCount: gaps.length
        });
        const summary = `补判完成（${missingEntries.length} 题）：${(previousRatio * 100).toFixed(1)}% → ${(ratio * 100).toFixed(1)}%（${passed ? '✅ 翻转为及格，待用户抽查' : '仍未及格，缺口 ' + gaps.length + ' 项'}）`;
        return {
            summary,
            artifacts: ['exams/grade-report.md', 'exams/comparison.json'],
            state: {
                passed,
                ratio,
                previousRatio,
                gaps,
                userGate: passed ? {
                    kind: 'trial-report',
                    reportPath: path.relative(path.join(baseDir, '..'), path.join(examsDir, 'grade-report.md')),
                    hint: '补判后及格，请用户抽查验收报告（D3）'
                } : null
            }
        };
    };
}

module.exports = {
    PASS_RATIO,
    GRADE_DIMENSIONS,
    GRADE_COVERAGE_PASSES,
    FALLBACK_EXAMINE_TEMPLATE,
    FALLBACK_GRADE_TEMPLATE,
    createTrialStepRunner,
    createRetestStepRunner,
    createRegradeStepRunner,
    buildGradeEntries,
    gradeEntriesWithCoverage,
    scoreGrading,
    runBlindAndGrade,
    jevCrossCheck,
    blindSearch,
    renderReportMarkdown
};
