import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation,
  type MasteryShadowEvaluationInput, type MasteryShadowEvaluationResult } from '../masteryShadow/evaluator';
import type { QuickCheckAnswer, QuickCheckQuestionEvaluation, QuickCheckSession } from './types';
import { masteryShadowCriterion } from '../masteryShadow/rubric';
import { quickCheckReferenceQuotes } from './referenceQuotes';
import { expandQuickCheckEvaluation } from './compactEvaluation';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function questionInputs(session: QuickCheckSession, input: MasteryShadowEvaluationInput) {
  return (input.task.verificationScopes || []).map(scope => {
    const question = session.questions.find(question => question.id === scope.id)!;
    const child: MasteryShadowEvaluationInput = { ...input, evaluationId: `${input.evaluationId}:${scope.id}`, answer: scope.answer,
      task: { ...input.task, prompt: scope.prompt, responseType: question.type, criterionIds: scope.criterionIds,
        requiredLayers: [...new Set(session.targets.filter(target => scope.criterionIds.includes(target.id)).map(target => target.layer))],
        verificationScopes: [scope] }, references: input.references.filter(reference => scope.referenceIds.includes(reference.id)) };
    return { question, input: child };
  });
}

/** One network request; shared references are sent once, judgments stay per question. */
export function buildQuickCheckEvaluationRequest(session: QuickCheckSession, input: MasteryShadowEvaluationInput) {
  const common = buildMasteryShadowEvaluationRequest(input);
  const questionTasks = questionInputs(session, input).map(({ question, input: child }) => {
    const payload = JSON.parse(buildMasteryShadowEvaluationRequest(child).userInput);
    return { questionId: question.id, evaluationId: child.evaluationId, task: payload.task, answer: child.answer, criteria: payload.criteria };
  });
  const semanticRules = common.systemPrompt.split('每个输入判据各一条baseline和criterion。')[0];
  return { systemPrompt: `这是逐题简测协议。下列通用核验原则分别用于每道题，不把同一判据在不同题的表现混在一起。\n${semanticRules}\n
以下是唯一输出格式，覆盖上文涉及的内部字段名：只返回紧凑JSON，不返回result、evaluationId、knowledgePointId、scopeIds、evidenceIds或重复的referenceIds，它们由本地根据原题绑定。每项直接引用用户原话evidenceQuotes，baseline保留模型实际判断的scope、applicability、coverage、rule及referenceQuotes；不能省略这些语义判断，也不能为了通过核验把uncertain改成applicable。
{"protocol":"quick-check-evaluation-v3","sessionId":"输入sessionId","questionEvaluations":[{"questionId":"Q1","criteria":[{"id":"本题判据ID","state":"六种状态选一","evidenceQuotes":["本题answer中的连续原话，≤240字"],"baseline":{"scope":"本题核验对象及范围","applicability":"applicable/uncertain/out_of_scope三选一","coverage":"covered/insufficient/not_required三选一","rule":"资料实际给出的标准，没有则空","referenceQuotes":[{"referenceId":"本题允许的引用ID","quote":"连续原文，≤240字"}]},"reason":"原话与标准如何对应或冲突","comparison":{"requirement":"具体违反的要求","finding":"contradiction/required_omission/unsupported_generalization三选一","scopeMatch":true}}],"answerKey":{"optionId":"仅闭合题必填正确选项ID","explanation":"独立核对后的答案和依据","referenceQuotes":[{"referenceId":"本题引用ID","quote":"真实连续原文，≤240字"}]} }]}。
comparison仅在fail/partial时必填；reason≤160字，rule≤240字，scope≤160字；引文每类至多3段，不输出重复的总结或整段教材。开放题不输出answerKey。
questionTasks每项是一道独立任务，每项criteria内按上述简化格式填写baseline与evidenceQuotes；仅评价该题的criteria和允许的referenceIds。每题都给结果，不能把另一题的选择、解释或引用挪来。evidenceQuotes只引用该题answer。缺少某题的依据，只暂停该题，不牵连其余题。
闭合题必须先根据题干、选项和所给资料独立求出answerKey，再判用户选择是否一致。有据的选对/选错应明确判pass/fail，不用partial代替；正确识别可以判概念或判断项pass，但不能冒充用户解释了因果、完成证明。开放题逐项比较用户实际说出的内容，不要求复述参考原句。
出题场景可以是资料原理的新应用，不要求原文出现同一故事。以参考规则、题干明示条件及可核验计算比较语义；模型负责理解和应用，不能用外部记忆补造判分标准。先检查本题是否真的提供该判据的检验机会：术语译名或概念配对不自动证明判断条件、判断归属，闭合题题型不代表判断层。题目标签不符合语义时该项not_applicable，不因选对就跨项通过；同一句回答可支持多个实际命中的本题判据，但不可把选项中的解释当成用户自述。
开放题的pass代表该分项已被充分展示：核对用户实际说出的含义、条件、应用或依据联系，不把只说术语、照题干重复结论或一句“是/不是”当作完整展示；有实质不足用partial，无该项机会用not_applicable，不以字数或固定关键词判断。充分展示一个分项不要求把其他未问分项一并展开。选择题选对可判识别正确，但不等于开放解释；确认次数与掌握状态由本地按证据类型处理，不由模型指定。
先按本题实际任务核对作答：比较要指出差异条件，反事实要处理改变的条件，证据题要判断信息是否足够，设计/改写要给出相应方案或修订。通用定义或机制即使本身正确，也不自动完成这道题要求的具体判断或推导；只对实际展示的分项给评价，不以复用了旧措辞为由判错，不用新关键词配额代替语义核对。
题干给定的数字、条件与算术可直接核验；区分已发生投入和未来增量，不把过去投入再计入继续/停止的未来比较。需核对回答中的计算与决策是否一致，不能因承认某概念就忽略具体应用错误。给出简短核算结论，不展开思考过程。
引用不足、答案不确定时如实unverifiable并说明；不因仅选择字母而说用户没回答。不会、跳过不判错。不输出总分、掌握状态或观察记录。`,
    // Keep the original fields for older transports; the explicit per-question
    // packets below are the authoritative split for the new response contract.
    userInput: JSON.stringify({ ...JSON.parse(common.userInput), protocol: 'quick-check-evaluation-v3', sessionId: session.id, questionTasks }) };
}

function parseAnswerKey(raw: unknown, session: QuickCheckSession, questionId: string) {
  const question = session.questions.find(question => question.id === questionId)!, key = record(raw);
  if (!question.options || !question.options.some(option => option.id === text(key.optionId)) || !text(key.explanation) || text(key.explanation).length > 1500) return undefined;
  try {
    return { optionId: text(key.optionId), explanation: text(key.explanation),
      referenceQuotes: quickCheckReferenceQuotes(key.referenceQuotes, session.references, question.referenceIds) };
  } catch { return undefined; }
}

function guardChoice(question: QuickCheckSession['questions'][number], answer: QuickCheckAnswer,
  evaluation: MasteryShadowEvaluationResult, answerKey?: QuickCheckQuestionEvaluation['answerKey'], independentKeyRequired = false) {
  if (!question.options) return evaluation;
  const next = structuredClone(evaluation);
  for (const criterion of next.criteria) {
    if (criterion.id.startsWith('reasoning_') && ['pass', 'partial', 'fail'].includes(criterion.state)) {
      criterion.state = 'not_observed'; criterion.evidenceIds = []; criterion.referenceIds = [];
      criterion.reason = '仅选择了答案，尚未展示可评价的推理过程；本项保持原状态。';
    } else if (independentKeyRequired && !answerKey && ['pass', 'partial', 'fail'].includes(criterion.state)) {
      criterion.state = 'unverifiable'; criterion.evidenceIds = []; criterion.referenceIds = [];
      criterion.reason = '本题尚未返回有原文依据的独立答案，暂不判对错或更新该项。';
    } else if (['pass', 'fail'].includes(criterion.state)
      && (answer.optionId === (answerKey?.optionId || question.privateAnswer.optionId)) !== (criterion.state === 'pass')) {
      criterion.state = 'unverifiable'; criterion.evidenceIds = []; criterion.referenceIds = [];
      criterion.reason = '选项答案与本题语义核验存在分歧，本项暂不更新。';
      next.diagnostics.push(`criterion ${criterion.id} choice key conflicts with verdict`);
    }
  }
  return next;
}

export function parseQuickCheckQuestionEvaluations(raw: unknown, input: MasteryShadowEvaluationInput,
  session: QuickCheckSession, answers: QuickCheckAnswer[], replay = false): QuickCheckQuestionEvaluation[] {
  const root = expandQuickCheckEvaluation(record(raw), session, input), modern = root.protocol === 'quick-check-evaluation-v2';
  if (!modern && !replay)
    throw new Error('实时简测评价返回了旧协议，需要按逐题协议独立核验答案；原作答已保留。');
  if (modern ? root.sessionId !== session.id || !Array.isArray(root.questionEvaluations)
    : root.protocol !== 'mastery-shadow-evaluator-v1' || root.evaluationId !== input.evaluationId || root.knowledgePointId !== input.knowledgePointId)
    throw new Error('简测评价响应与当前卡片不匹配，请重试。');
  const rows = modern ? root.questionEvaluations.map(record) : [];
  const validIds = questionInputs(session, input).map(row => row.question.id);
  if (rows.length > 3 || rows.some((row: any) => !validIds.includes(row.questionId))
    || new Set(rows.map((row: any) => row.questionId)).size !== rows.length) throw new Error('简测逐题评价编号不匹配，请重试。');
  return questionInputs(session, input).map(({ question, input: child }) => {
    const row = rows.find((row: any) => row.questionId === question.id);
    // Historical flat output is partitioned, never used as a shared verdict for
    // all questions. Explicitly wrong scope IDs remain wrong and are rejected.
    const result = modern ? row?.result || { protocol: 'mastery-shadow-evaluator-v1', evaluationId: child.evaluationId,
      knowledgePointId: child.knowledgePointId, evidence: [], baselines: [], criteria: [] }
      : { ...root, evaluationId: child.evaluationId };
    let evaluation: MasteryShadowEvaluationResult;
    try { evaluation = parseMasteryShadowEvaluation(result, child); }
    catch {
      // A foreign child identity cannot become evidence for this question, but
      // does not invalidate correctly bound sibling questions either.
      evaluation = parseMasteryShadowEvaluation({ protocol: 'mastery-shadow-evaluator-v1', evaluationId: child.evaluationId,
        knowledgePointId: child.knowledgePointId, evidence: [], baselines: [], criteria: [] }, child);
      evaluation.diagnostics.push('invalid result binding; foreign per-question result rejected');
    }
    const diagnostics = evaluation.diagnostics;
    const answerKey = modern && parseAnswerKey(row?.answerKey, session, question.id);
    const answerKeyPolicy = modern && !(replay && row?.answerKeyPolicy === 'legacy') ? 'independent' : 'legacy';
    const guarded = guardChoice(question, answers.find(answer => answer.questionId === question.id)!, evaluation, answerKey || undefined, answerKeyPolicy === 'independent');
    evaluation = parseMasteryShadowEvaluation(guarded, child);
    evaluation.diagnostics = [...new Set([...diagnostics, ...guarded.diagnostics, ...evaluation.diagnostics])];
    for (const criterion of evaluation.criteria) {
      if (criterion.state !== 'unverifiable' || !criterion.reason.includes('核验范围或证据用途未对齐')) continue;
      const baseline = evaluation.baselines?.find(item => item.id === criterion.id);
      // Presentation only: retain the held verdict and its machine diagnostics.
      if (!baseline?.scope) criterion.reason = '评价缺少本题的具体核验范围，本项暂未更新。';
      else if (baseline.applicability !== 'applicable') criterion.reason = '参考标准对本题的适用性尚未确认，本项暂未更新。';
      else if (!baseline.scopeIds?.includes(question.id)) criterion.reason = '评价绑定的题号与本题不一致，本项暂未更新。';
      else if (!criterion.evidenceIds.length) criterion.reason = '评价未能定位到本题的作答原话，本项暂未更新。';
      else if (masteryShadowCriterion(criterion.id)?.referenceRequired && !criterion.referenceIds.length)
        criterion.reason = '评价引用的资料未能通过本题的原文核对，本项暂未更新。';
    }
    return { questionId: question.id, evaluation, answerKeyPolicy, ...(answerKey ? { answerKey } : {}) };
  });
}

/** A structural recovery cannot erase already grounded criteria in the same
 * question. Rebind disjoint evidence IDs, then pass the combined receipt through
 * exactly the same scope, source and independent-answer checks again. */
export function mergeQuickCheckRecovery(previous: QuickCheckQuestionEvaluation, repaired: QuickCheckQuestionEvaluation,
  input: MasteryShadowEvaluationInput, session: QuickCheckSession, answers: QuickCheckAnswer[]): QuickCheckQuestionEvaluation {
  const scope = input.task.verificationScopes!.find(scope => scope.id === previous.questionId)!;
  const selected = scope.criterionIds.map(id => {
    const old = previous.evaluation.criteria.find(criterion => criterion.id === id);
    const useOld = old && ['pass', 'partial', 'fail'].includes(old.state);
    const source = useOld ? previous : repaired;
    return { source, prefix: useOld ? 'O:' : 'R:', criterion: source.evaluation.criteria.find(criterion => criterion.id === id) || old };
  });
  const result = { protocol: 'mastery-shadow-evaluator-v1', evaluationId: `${input.evaluationId}:${scope.id}`,
    knowledgePointId: input.knowledgePointId,
    evidence: [previous, repaired].flatMap((row, index) => row.evaluation.evidence.map(evidence =>
      ({ ...evidence, id: `${index ? 'R:' : 'O:'}${evidence.id}` }))),
    baselines: selected.flatMap(({ source, criterion }) => source.evaluation.baselines?.filter(baseline => baseline.id === criterion?.id) || []),
    criteria: selected.flatMap(({ prefix, criterion }) => criterion ? [{ ...criterion,
      evidenceIds: criterion.evidenceIds.map(id => prefix + id),
      ...(criterion.comparison ? { comparison: { ...criterion.comparison,
        evidenceIds: criterion.comparison.evidenceIds.map(id => prefix + id) } } : {}) }] : []) };
  const scopedInput: MasteryShadowEvaluationInput = { ...input, answer: scope.answer,
    task: { ...input.task, prompt: scope.prompt, criterionIds: scope.criterionIds, verificationScopes: [scope] } };
  const keyConflict = previous.evaluation.diagnostics.some(message => message.includes('choice key conflicts'));
  return parseQuickCheckQuestionEvaluations({ protocol: 'quick-check-evaluation-v2', sessionId: session.id,
    questionEvaluations: [{ questionId: scope.id, result,
      answerKey: keyConflict ? repaired.answerKey : previous.answerKey || repaired.answerKey }] }, scopedInput, session, answers)[0];
}

/** At most one observation per criterion/card; failures/partials keep their own
 * verified scope, while per-question feedback remains separate. No new truth
 * judgment is made here; this is only a reduction of already validated results. */
export function mergeQuickCheckQuestionEvaluations(rows: QuickCheckQuestionEvaluation[], input: MasteryShadowEvaluationInput, session: QuickCheckSession) {
  const rank = { fail: 0, partial: 1, pass: 2, unverifiable: 3, not_observed: 4, not_applicable: 5 };
  const candidates = rows.flatMap(row => row.evaluation.criteria.map(criterion => ({ row, criterion })));
  const demonstrated = (candidate: (typeof candidates)[number]) => candidate.criterion.state === 'pass'
    && candidate.criterion.evidenceIds.length > 0
    && session.questions.some(question => question.id === candidate.row.questionId
      && !question.options && ['open', 'application', 'calculation', 'proof'].includes(question.type));
  const selected = input.task.criterionIds.flatMap(id => {
    const match = candidates.filter(candidate => candidate.criterion.id === id).sort((a, b) => rank[a.criterion.state] - rank[b.criterion.state]
      || Number(demonstrated(b)) - Number(demonstrated(a)))[0];
    return match ? [match] : [];
  });
  const prefix = (questionId: string, evidenceId: string) => `${questionId}:${evidenceId}`;
  const merged = parseMasteryShadowEvaluation({ protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId,
    knowledgePointId: input.knowledgePointId, evidence: rows.flatMap(row => row.evaluation.evidence.map(evidence =>
      ({ ...evidence, id: prefix(row.questionId, evidence.id) }))),
    baselines: selected.flatMap(({ row, criterion }) => row.evaluation.baselines?.filter(baseline => baseline.id === criterion.id) || []),
    criteria: selected.map(({ row, criterion }) => ({ ...criterion,
      evidenceIds: criterion.evidenceIds.map(id => prefix(row.questionId, id)),
      ...(criterion.comparison ? { comparison: { ...criterion.comparison,
        evidenceIds: criterion.comparison.evidenceIds.map(id => prefix(row.questionId, id)) } } : {}) })),
    summary: '逐题核对完成；每个判据在本卡最多记一次表现，未核验项保持原状态。' }, input);
  // Re-derived on save/replay from frozen question types and validated judgments.
  // Never elevate a whole card: recognition-only items and all failures retain
  // natural strength, even alongside a fully demonstrated open-answer criterion.
  const demonstratedIds = new Set<string>(selected.filter(demonstrated).map(candidate => candidate.criterion.id));
  for (const observation of merged.observations) for (const result of observation.results) {
    for (const criterion of result.criterionResults || []) {
      if (criterion.verdict === 'pass' && demonstratedIds.has(criterion.id)
        && input.assistance === 'independent'
        && (criterion.referenceBasis === 'grounded' || masteryShadowCriterion(criterion.id)?.referenceRequired === false)) {
        criterion.passStrength = 'targeted';
      }
    }
  }
  return merged;
}
