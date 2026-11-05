/** Question-time task definitions. These are evidence requirements, not reference answers or scores. */
export type ReviewAssessmentLayer = 'concept' | 'judgment' | 'reasoning';
export const REVIEW_ASSESSMENT_CRITERIA = {
  concept_meaning: '用自己的话保留所问概念的核心含义；同义表达可以合格。',
  concept_boundary: '保留本题所问概念的关键限定，不要求复述整篇笔记。',
  example_fit: '给出的实例体现所问概念特征，不把举例题扩展为完整证明题。',
  distinction: '说明本题指定概念的关键区别，不只列出名称。',
  fact_scope: '在本题对象和适用范围内核对事实、状态、数值及单位。',
  condition_scope: '说明本题所问成立条件或例外，保留不确定程度。',
  attribution_scope: '区分本题表达中的事实、假设、他人观点与自己的结论，不要求无关引述。',
  actual_premise: '提供本题实际前提，不用一般规则代替具体前提。',
  inference_link: '说明规则如何连接前提和实际结论，核对方向与充分性。',
} as const;
export type ReviewCriterionId = keyof typeof REVIEW_ASSESSMENT_CRITERIA;
export const REVIEW_ASSESSMENT_TASKS = {
  definition: { layer: 'concept', criterionIds: ['concept_meaning', 'concept_boundary'] },
  example: { layer: 'concept', criterionIds: ['example_fit'] },
  distinguish: { layer: 'concept', criterionIds: ['distinction'] },
  fact: { layer: 'judgment', criterionIds: ['fact_scope'] },
  condition: { layer: 'judgment', criterionIds: ['condition_scope'] },
  attribution: { layer: 'judgment', criterionIds: ['attribution_scope'] },
  reasoning: { layer: 'reasoning', criterionIds: ['actual_premise', 'inference_link'] },
} as const;
export type ReviewAssessmentTaskType = keyof typeof REVIEW_ASSESSMENT_TASKS;
export interface ReviewAssessmentContract {
  version: 1;
  rubricVersion: 'review-task-v1';
  status: 'fixed' | 'unavailable' | 'not_assessed';
  taskType: ReviewAssessmentTaskType | null;
  requirements: { knowledgeTarget: string; layer: ReviewAssessmentLayer; criterionIds: ReviewCriterionId[] }[];
  reason?: 'missing_marker' | 'invalid_marker' | 'no_knowledge_target' | 'not_assessed';
}

/** Only a valid pre-answer marker selects a preset. Never infer it from an answer or a cognition purpose. */
export function freezeReviewAssessment(marker: string | undefined, knowledgeTargets: string[], invalid = false): ReviewAssessmentContract {
  const base = { version: 1 as const, rubricVersion: 'review-task-v1' as const };
  if (invalid || (marker !== undefined && marker !== '无' && !Object.hasOwn(REVIEW_ASSESSMENT_TASKS, marker))) {
    return { ...base, status: 'unavailable', taskType: null, requirements: [], reason: 'invalid_marker' };
  }
  if (marker === undefined) return { ...base, status: 'unavailable', taskType: null, requirements: [], reason: 'missing_marker' };
  if (marker === '无' || !knowledgeTargets.length) return { ...base, status: 'not_assessed', taskType: null,
    requirements: [], reason: marker === '无' ? 'not_assessed' : 'no_knowledge_target' };
  const taskType = marker as ReviewAssessmentTaskType, task = REVIEW_ASSESSMENT_TASKS[taskType];
  return { ...base, status: 'fixed', taskType, requirements: knowledgeTargets.map((knowledgeTarget) => ({
    knowledgeTarget, layer: task.layer, criterionIds: [...task.criterionIds],
  })) };
}

/** Closed persisted contract: a preset cannot be weakened or expanded by edited/model-produced fields. */
export function parseReviewAssessment(raw: unknown, knowledgeTargets: string[]): ReviewAssessmentContract {
  const fail = (): never => { throw new Error('复习检验任务无效'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  const fields = ['version', 'rubricVersion', 'status', 'taskType', 'requirements', 'reason'];
  if (Object.keys(value).some((key) => !fields.includes(key)) || value.version !== 1 || value.rubricVersion !== 'review-task-v1'
    || !Array.isArray(value.requirements) || value.requirements.length > 20) return fail();
  let expected: ReviewAssessmentContract;
  if (value.status === 'fixed') {
    if (typeof value.taskType !== 'string' || !Object.hasOwn(REVIEW_ASSESSMENT_TASKS, value.taskType) || !knowledgeTargets.length) return fail();
    expected = freezeReviewAssessment(value.taskType, knowledgeTargets);
  } else if (value.status === 'unavailable' && value.taskType === null && ['missing_marker', 'invalid_marker'].includes(value.reason as string)) {
    expected = freezeReviewAssessment(undefined, knowledgeTargets, value.reason === 'invalid_marker');
  } else if (value.status === 'not_assessed' && value.taskType === null) {
    if (value.reason === 'no_knowledge_target' && !knowledgeTargets.length) expected = freezeReviewAssessment('definition', []);
    else if (value.reason === 'not_assessed') expected = freezeReviewAssessment('无', knowledgeTargets);
    else return fail();
  } else return fail();
  if (value.reason !== expected.reason || value.requirements.length !== expected.requirements.length) return fail();
  for (let i = 0; i < value.requirements.length; i++) {
    const item = value.requirements[i] as Record<string, unknown>, requirement = expected.requirements[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join('|') !== 'criterionIds|knowledgeTarget|layer'
      || item.knowledgeTarget !== requirement.knowledgeTarget || item.layer !== requirement.layer
      || JSON.stringify(item.criterionIds) !== JSON.stringify(requirement.criterionIds)) return fail();
  }
  return expected;
}

export const REVIEW_ASSESSMENT_MARKER_PROMPT = `\n下一问只选择一个检验任务，必须与可见问题实际要求一致。末尾单独输出 [检验:definition|example|distinguish|fact|condition|attribution|reasoning]（实际只选一个）：definition=定义/核心含义，example=概念举例，distinguish=概念区分，fact=事实/状态/数值，condition=成立条件/边界，attribution=区分事实/假设/他人观点/自己的结论，reasoning=前提/规则/结论。长期确认需要各项证据，不要一直重复定义题；根据已有对话逐步考查边界、应用、判断和推理，每次仍只问一个明确问题。项目整体回忆、普通澄清或无法确定则 [检验:无]。不得为了评分增加可见问题没有要求的任务；换问法或提示后重答保持原检验任务。标记是隐藏元数据，不提供标准答案。`;

/** Program-owned opening questions carry their task without an extra LLM call or a user setting. */
export function buildReviewOpeningQuestion(title: string, project: boolean, selectedQuestions: readonly string[] = []): string {
  const questions = selectedQuestions.map(question => question.trim()).filter(Boolean);
  if (project && questions.length) {
    const introduction = questions.length > 1 ? `已选 ${questions.length} 个问题，先从第 1 题开始：` : '请先回答你选中的问题：';
    return `${introduction}\n${questions[0]}\n请先不看资料，用自己的话作答；不确定的地方可以直接说明。\n[检验:无]`;
  }
  return project
    ? `请先自由复述你对项目“${title}”的整体理解、记得的关键内容，以及目前仍不确定的部分。\n[检验:无]`
    : `请先不看资料，用自己的话说明“${title}”的核心含义，并说明你最不确定的部分。\n[检验:definition]`;
}
