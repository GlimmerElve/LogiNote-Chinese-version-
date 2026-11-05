import type {
  SceneInteractionResponse, SceneInteractionDirective, SceneLearningNote, SceneMessage,
  SceneRunState, SceneSpec, SceneTeachingState,
} from '../../types';
import type { SceneUnderstanding } from './sceneUnderstanding';
import { SceneUnderstandingError } from './sceneUnderstanding';
import { normalizeSceneInteractionResponse, normalizeQuestionSetEvaluation, gradeQuestionSetResponse } from './sceneInteraction';
import { normalizeSceneObjectiveEvaluation, gradeSceneObjectiveResponse } from './sceneAssessment';
import { normalizeSceneAnswerFeedback, readSceneTeachingPolicyUpdates, resolveSceneTeachingConditionalPolicy } from './sceneTeachingPolicy';
import { getPendingSceneInteraction } from './scenePendingTask';

export function collectSceneAnswerRecords(run: SceneRunState) {
  const tasks = new Map<string, SceneMessage>(), answered = new Set<string>(), retired = new Set(run.retiredInteractionIds || []);
  return run.messages.flatMap(message => {
    if (message.isStreaming) return [];
    if (message.speakerType === 'role' && message.interaction) tasks.set(message.interaction.id, message);
    if (message.speakerType !== 'user' || message.inputKind === 'conversation' || !message.interactionResponse) return [];
    const task = tasks.get(message.interactionResponse.interactionId);
    if (!task?.interaction || retired.has(task.interaction.id) || answered.has(task.interaction.id)) return [];
    const response = normalizeSceneInteractionResponse(message.interactionResponse, task.interaction);
    if (!response) return [];
    answered.add(task.interaction.id);
    const objective = normalizeSceneObjectiveEvaluation(task.objectiveEvaluation, task.interaction);
    const fullPaper = normalizeQuestionSetEvaluation(task.interactionEvaluation, task.interaction);
    const submitted = response.type === 'question-set' ? new Set(response.answers.map(item => item.itemId)) : new Set<string>();
    const paper = fullPaper ? { ...fullPaper, items: fullPaper.items.filter(item => submitted.has(item.itemId)) } : undefined;
    return [{ interactionId: task.interaction.id, task, answer: message, response,
      objectiveGrade: gradeSceneObjectiveResponse(response, objective),
      questionGrade: gradeQuestionSetResponse(response, paper), paper }];
  });
}
type AnswerRecord = ReturnType<typeof collectSceneAnswerRecords>[number];
const latestUser = (run: SceneRunState) => run.messages.findLast(message => message.speakerType === 'user' && !message.isStreaming);
function fail(detail: string): never { throw new SceneUnderstandingError(detail, 'invalid-teaching-state'); }

/** Durable references are local state; no model-supplied grades, scores or mastery flags are accepted. */
export function resolveSceneTeachingState(spec: SceneSpec, run: SceneRunState, understanding?: SceneUnderstanding): SceneTeachingState {
  const records = collectSceneAnswerRecords(run), last = records.at(-1);
  const prior = run.teachingState;
  const state: SceneTeachingState = structuredClone(prior || { notes: [] });
  state.notes ??= [];
  if (last && last.answer.id !== state.lastAnswerMessageId) {
    state.lastAnswerMessageId = last.answer.id;
    state.discussion = { interactionId: last.interactionId, answerMessageId: last.answer.id };
  }
  if (state.discussion && !records.some(record => record.interactionId === state.discussion!.interactionId
    && record.answer.id === state.discussion!.answerMessageId)) delete state.discussion;
  const user = latestUser(run), directive = understanding?.teaching;
  // A review is one response to one user request, not a policy for later tasks.
  state.activeInstructions = (state.activeInstructions || []).filter(instruction =>
    instruction.scope !== 'review' || instruction.source.sourceMessageId === user?.id);
  if (directive && (directive.focus || directive.progression || directive.feedback || directive.policyUpdates || directive.explanationRequested)) {
    const evidence = understanding!.evidence.find(entry => entry.sourceId === user?.id && user.content.includes(entry.quote));
    if (!user || user.interactionResponse || !evidence) fail('教学调整必须来自最新用户的精确原话，不能把选择答案解释为修改策略。');
    let acceptedOrder: number | undefined;
    if (directive.feedback || directive.policyUpdates) {
      const receipts = [state.feedbackSource, ...(state.taskFeedback || []), ...(state.activeInstructions || []).map(instruction => ({
        sourceMessageId: instruction.source.sourceMessageId, acceptedOrder: instruction.acceptedOrder,
      })), ...(state.instructionChanges || []).map(change => ({ sourceMessageId: change.source.sourceMessageId, acceptedOrder: change.acceptedOrder }))];
      const validOrder = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      const maximum = Math.max(0, validOrder(state.policyOrder) ? state.policyOrder : 0,
        ...receipts.flatMap(receipt => validOrder(receipt?.acceptedOrder) ? [receipt.acceptedOrder] : []));
      const sameSource = receipts.flatMap(receipt => receipt?.sourceMessageId === user.id && validOrder(receipt.acceptedOrder)
        ? [receipt.acceptedOrder] : []);
      acceptedOrder = sameSource.length ? Math.max(...sameSource) : maximum + 1;
      if (!Number.isSafeInteger(acceptedOrder)) fail('本局教学策略修订序号超过安全范围。');
      state.policyOrder = Math.max(maximum, acceptedOrder);
    }
    if (directive.focus?.action === 'release') delete state.discussion;
    if (directive.focus?.action === 'focus') {
      const target = records.find(record => record.interactionId === directive.focus!.interactionId);
      if (!target) fail('讨论对象必须是本局已经合法作答的题目。');
      state.discussion = { interactionId: target.interactionId, answerMessageId: target.answer.id };
    }
    if (directive.progression === 'pause') state.pause = { sourceMessageId: user.id, quote: evidence.quote };
    if (directive.progression === 'resume') delete state.pause;
    if (directive.policyUpdates !== undefined) {
      let updates: NonNullable<SceneUnderstanding['teaching']>['policyUpdates'];
      try { updates = readSceneTeachingPolicyUpdates(directive.policyUpdates); }
      catch (error) { fail(error instanceof Error ? error.message : '条件教学策略无效。'); }
      for (const update of updates!) {
        if (update.source.sourceMessageId !== user.id || !user.content.includes(update.source.quote)) {
          fail('持续教学策略的更新或撤销必须精确引用最新真实用户，不能沿用旧用户或助手来源。');
        }
        if (state.instructionChanges?.some(change => change.id === update.id && change.action === update.action
          && change.scope === update.scope && change.source.sourceMessageId === update.source.sourceMessageId
          && change.source.quote === update.source.quote)) continue;
        const previous = state.activeInstructions.find(instruction => instruction.id === update.id);
        if (previous && previous.scope !== update.scope) fail('相同策略ID不能静默改变适用范围，须先有依据撤销或使用不同ID。');
        if (update.action === 'revoke') {
          if (!previous) fail('只能撤销本局仍有效的已知教学策略。');
          state.activeInstructions = state.activeInstructions.filter(instruction => instruction.id !== update.id);
        } else {
          let interactionIds: string[] | undefined;
          if (update.scope === 'task') {
            const pendingId = getPendingSceneInteraction(run)?.interaction?.id;
            const target = update.interactionId || pendingId || state.discussion?.interactionId || last?.interactionId;
            if (!target || (target !== pendingId && !records.some(record => record.interactionId === target))) {
              fail('task条件策略必须绑定本局有效未答题或已答题，不得引用退役或不存在的任务。');
            }
            interactionIds = [target];
          } else if (update.scope === 'review') {
            interactionIds = records.filter(record => update.target !== 'incorrect' || record.objectiveGrade?.correct === false
              || Boolean(record.questionGrade && record.questionGrade.correct < record.questionGrade.total)).map(record => record.interactionId);
            if (!interactionIds.length) fail('review条件策略必须有本局已经合法作答的目标题。');
          }
          state.activeInstructions = [...state.activeInstructions.filter(instruction => instruction.id !== update.id), {
            id: update.id, scope: update.scope, instruction: update.instruction || update.source.quote,
            rules: update.rules || [], source: update.source, acceptedOrder, ...(interactionIds ? { interactionIds } : {}),
          }];
          if (state.activeInstructions.length > 8) fail('活跃本局教学策略超过8项；请有依据地合并更新或撤销已有项，不能静默淘汰持续要求。');
        }
        state.instructionChanges = [...(state.instructionChanges || []), {
          id: update.id, action: update.action, scope: update.scope, source: update.source, acceptedOrder,
        }].slice(-24);
      }
    }
    if (directive.feedback) {
      const { scope, interactionId, target: reviewTarget, ...change } = directive.feedback;
      if (scope === 'session') {
        state.feedbackPolicy = { ...normalizeSceneAnswerFeedback(spec.runtimeContract?.answerFeedback), ...state.feedbackPolicy, ...change };
        state.feedbackSource = { sourceMessageId: user.id, quote: evidence.quote, acceptedOrder };
        state.taskFeedback = [];
      } else if (scope === 'review') {
        const selected = records.filter(record => reviewTarget !== 'incorrect' || record.objectiveGrade?.correct === false
          || Boolean(record.questionGrade && record.questionGrade.correct < record.questionGrade.total));
        const byId = new Map((state.taskFeedback || []).map(item => [item.interactionId, item]));
        for (const record of selected) byId.set(record.interactionId, { ...byId.get(record.interactionId),
          interactionId: record.interactionId, ...change, sourceMessageId: user.id, quote: evidence.quote, acceptedOrder });
        state.taskFeedback = [...byId.values()];
      } else {
        const pendingId = getPendingSceneInteraction(run)?.interaction?.id;
        const target = interactionId || pendingId || state.discussion?.interactionId || last?.interactionId;
        const answered = records.some(record => record.interactionId === target);
        if (!target || (!answered && target !== pendingId)) fail('局部反馈必须引用本局有效任务，不能引用取消、退役或不存在的题目。');
        if (!answered && (change.correctness === 'immediate' || change.explanation === 'immediate')) fail('未答题不能请求释放私有答案；可延迟反馈或正常求提示。');
        const previous = state.taskFeedback?.find(item => item.interactionId === target);
        state.taskFeedback = [...(state.taskFeedback || []).filter(item => item.interactionId !== target),
          { ...previous, interactionId: target, ...change, sourceMessageId: user.id, quote: evidence.quote, acceptedOrder }];
      }
    }
  }
  if (understanding?.intent === 'help' && user) {
    const pending = getPendingSceneInteraction(run);
    const target = pending?.interaction?.id || state.discussion?.interactionId;
    if (target && !state.helpRequests?.some(item => item.sourceMessageId === user.id)) {
      state.helpRequests = [...(state.helpRequests || []), { interactionId: target, sourceMessageId: user.id }].slice(-100);
    }
  }
  return state;
}

export function isSceneFinalFeedbackTurn(spec: SceneSpec, run: SceneRunState, understanding?: SceneUnderstanding) {
  const user = latestUser(run);
  return run.status !== 'running' || user?.endRequested === true
    || Boolean(user && !user.interactionResponse && understanding?.intent === 'end')
    || Boolean(spec.completion.maxTurns > 0 && run.turnCount >= spec.completion.maxTurns);
}

function recordOutcome(record: AnswerRecord, itemId?: string): 'correct' | 'incorrect' | undefined {
  if (record.objectiveGrade) return record.objectiveGrade.correct ? 'correct' : 'incorrect';
  if (record.questionGrade) return itemId
    ? record.questionGrade.incorrectItemIds.includes(itemId) ? 'incorrect' : 'correct'
    : record.questionGrade.correct === record.questionGrade.total ? 'correct' : 'incorrect';
  return undefined;
}

function effectiveFeedbackPolicy(spec: SceneSpec, run: SceneRunState, state: SceneTeachingState,
  record: AnswerRecord, understanding?: SceneUnderstanding, itemId?: string) {
  const focus = state.discussion?.interactionId || collectSceneAnswerRecords(run).at(-1)?.interactionId;
  const user = latestUser(run);
  const requested = Boolean(user && !user.interactionResponse && understanding?.teaching?.explanationRequested
    && focus === record.interactionId);
  const local = state.taskFeedback?.find(item => item.interactionId === record.interactionId);
  return resolveSceneTeachingConditionalPolicy(normalizeSceneAnswerFeedback(spec.runtimeContract?.answerFeedback), state.activeInstructions,
    { interactionId: record.interactionId, outcome: recordOutcome(record, itemId), explanationRequested: requested, currentUserMessageId: user?.id }, [
      ...(state.feedbackPolicy ? [{ ...state.feedbackPolicy, scope: 'session' as const, acceptedOrder: state.feedbackSource?.acceptedOrder }] : []),
      ...(local ? [{ correctness: local.correctness, explanation: local.explanation, scope: 'task' as const, acceptedOrder: local.acceptedOrder }] : []),
    ]);
}

function feedbackAccess(spec: SceneSpec, run: SceneRunState, state: SceneTeachingState, record: AnswerRecord,
  understanding?: SceneUnderstanding, itemId?: string) {
  const policy = effectiveFeedbackPolicy(spec, run, state, record, understanding, itemId);
  const focus = state.discussion?.interactionId || collectSceneAnswerRecords(run).at(-1)?.interactionId;
  const user = latestUser(run), isFocus = focus === record.interactionId && Boolean(user && !user.interactionResponse);
  const correctnessRequested = isFocus && understanding?.evaluationRequested && !understanding.teaching?.feedback;
  const explanationRequested = isFocus && understanding?.teaching?.explanationRequested === true;
  const final = isSceneFinalFeedbackTurn(spec, run, understanding);
  return {
    correctness: policy.correctness === 'immediate' || (policy.correctness === 'at-end' && final) || (policy.correctness === 'on-request' && correctnessRequested === true),
    explanation: policy.explanation === 'immediate' || (policy.explanation === 'at-end' && final) || (policy.explanation === 'on-request' && explanationRequested),
  };
}

/** Project fields explicitly: never spread an assessment or private evaluation into a request. */
export function sceneAnswerFeedbackView(spec: SceneSpec, run: SceneRunState, answerMessageId: string, understanding?: SceneUnderstanding) {
  const record = collectSceneAnswerRecords(run).find(item => item.answer.id === answerMessageId);
  if (!record) return undefined;
  const state = resolveSceneTeachingState(spec, run, understanding), access = feedbackAccess(spec, run, state, record, understanding);
  const view: { interactionId: string; correct?: boolean | number; total?: number; incorrectItemIds?: string[];
    explanation?: string | Array<{ itemId: string; text: string }> } = { interactionId: record.interactionId };
  if (access.correctness && record.objectiveGrade) view.correct = record.objectiveGrade.correct;
  if (access.correctness && record.questionGrade) Object.assign(view, record.questionGrade);
  if (access.correctness && access.explanation && record.objectiveGrade?.explanation) view.explanation = record.objectiveGrade.explanation;
  if (record.paper) {
    const explanations = record.paper.items.flatMap(item => {
      const itemAccess = feedbackAccess(spec, run, state, record, understanding, item.itemId);
      return itemAccess.correctness && itemAccess.explanation && item.explanation ? [{ itemId: item.itemId, text: item.explanation }] : [];
    });
    if (explanations.length) view.explanation = explanations;
  }
  return Object.keys(view).length > 1 ? view : undefined;
}
function preview(text: string, max: number) {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true, originalChars: text.length };
}

function boundedTeachingData<T extends { type: string; interactionId?: string; id?: string }>(value: T, max: number) {
  const text = JSON.stringify(value);
  return text.length <= max ? value : { type: value.type, interactionId: value.interactionId, id: value.id,
    excerpt: preview(text, max), completeness: 'excerpt-not-full-source' as const };
}
function boundedFeedback(value: ReturnType<typeof sceneAnswerFeedbackView>) {
  if (!value || JSON.stringify(value).length <= 1800) return value;
  return { interactionId: value.interactionId, correct: value.correct, total: value.total, incorrectItemIds: value.incorrectItemIds,
    explanationExcerpt: preview(JSON.stringify(value.explanation), 1000), completeness: 'excerpt-not-full-explanation' as const };
}

/** This root context is protected by the scene budget; optional history may disappear without losing the discussion. */
export function buildSceneTeachingContext(spec: SceneSpec, run: SceneRunState, understanding?: SceneUnderstanding) {
  const records = collectSceneAnswerRecords(run), state = resolveSceneTeachingState(spec, run, understanding);
  const focus = records.find(record => record.interactionId === state.discussion?.interactionId);
  const selected = [...new Set([...(focus ? [focus] : []), ...records.slice(-8)])];
  const publicRecord = (record: AnswerRecord) => ({
    interactionId: record.interactionId, taskMessageId: record.task.id, answerMessageId: record.answer.id,
    response: boundedTeachingData<SceneInteractionResponse>(record.response, 1600),
    feedbackPolicy: effectiveFeedbackPolicy(spec, run, state, record, understanding),
    itemFeedbackPolicies: record.paper?.items.map(item => ({ itemId: item.itemId,
      ...effectiveFeedbackPolicy(spec, run, state, record, understanding, item.itemId) })),
    feedback: boundedFeedback(sceneAnswerFeedbackView(spec, run, record.answer.id, understanding)),
    helpRequestMessageIds: (state.helpRequests || []).filter(item => item.interactionId === record.interactionId).map(item => item.sourceMessageId).slice(-8),
    recordedHelpRequestCount: (state.helpRequests || []).filter(item => item.interactionId === record.interactionId).length,
    independence: '未记录求助不等于独立掌握；核对一次正确也不等于已掌握',
  });
  const start = focus ? run.messages.findIndex(message => message.id === focus.answer.id) : -1;
  const following = start < 0 ? [] : run.messages.slice(start + 1);
  const nextTask = following.findIndex(message => message.speakerType === 'role' && message.interaction && message.interaction.id !== focus?.interactionId);
  const legacySegment = new Set((nextTask < 0 ? following : following.slice(0,nextTask)).map(message => message.id));
  const explanations = following.filter(message =>
    message.speakerType === 'role' && !message.isStreaming && !message.interaction
    && (message.discussionInteractionId === focus?.interactionId || (!message.discussionInteractionId && legacySegment.has(message.id)))).slice(-4)
    .map(message => ({ sourceMessageId: message.id, ...preview(message.content, 900) }));
  const visibleGrades = records.flatMap(record => {
    if (!feedbackAccess(spec, run, state, record, understanding).correctness) return [];
    if (record.objectiveGrade) return [{ correct: record.objectiveGrade.correct ? 1 : 0, total: 1 }];
    return record.questionGrade ? [record.questionGrade] : [];
  });
  const visibleSummary = visibleGrades.length ? { checkedItems: visibleGrades.reduce((sum, grade) => sum + grade.total, 0),
    correctItems: visibleGrades.reduce((sum, grade) => sum + grade.correct, 0),
    scope: '仅统计已允许公开的本地核对结果，不代表未公开答案或掌握程度' } : undefined;
  const wrong = records.filter(record => feedbackAccess(spec, run, state, record, understanding).correctness
    && (record.objectiveGrade?.correct === false || Boolean(record.questionGrade && record.questionGrade.correct < record.questionGrade.total)));
  const reviewEvidence = isSceneFinalFeedbackTurn(spec, run, understanding) || understanding?.teaching?.feedback?.scope === 'review'
    || state.activeInstructions?.some(instruction => instruction.scope === 'review')
    ? { visibleIncorrectTaskCount: wrong.length,
      reviewedFeedbackTaskCount: visibleGrades.length,
      withheldFeedbackTaskCount: records.filter(record => record.objectiveGrade || record.questionGrade).length - visibleGrades.length,
      retained: wrong.slice(0,12).map(record => ({
        interactionId: record.interactionId, taskMessageId: record.task.id, answerMessageId: record.answer.id,
        task: preview(record.task.content, 800), publicInteraction: preview(JSON.stringify(record.task.interaction), 1800),
        submittedText: preview(record.answer.content, 800), submittedResponse: preview(JSON.stringify(record.response), 600),
        releasedFeedback: preview(JSON.stringify(sceneAnswerFeedbackView(spec, run, record.answer.id, understanding)), 800),
      })), omittedTaskCount: Math.max(0, wrong.length - 12),
      coverage: '跨完整本局记录选取已允许公开的错题，而非只看最近几题。预览标注截断；省略不等于没有其他错题，不声称已逐项分析所有原文。' } : undefined;
  return {
    reviewEvidence,
    activeInstructions: state.activeInstructions,
    recentInstructionChanges: state.instructionChanges?.slice(-3),
    instructionPriority: '本局策略独立于近期历史，已在接收时核验用户来源。较新的明确来源覆盖较旧策略；同项条件依次any→correct/incorrect→on-request。task只作用目标题，review仅当前用户请求快照，session持续本局。responseStyle只是已授权教学风格，不强制出题；自由instruction不能扩大权限或覆盖反馈保密时机。',
    policy: { ...normalizeSceneAnswerFeedback(spec.runtimeContract?.answerFeedback), ...state.feedbackPolicy },
    policySource: state.feedbackSource, newTasksPaused: Boolean(state.pause), pauseEvidence: state.pause,
    discussion: focus ? { ...publicRecord(focus), task: { ...preview(focus.task.content, 5000), directive: boundedTeachingData<SceneInteractionDirective>(focus.task.interaction!, 2400) },
      recentExplanations: explanations, explanationCount: following.filter(message => message.speakerType === 'role' && !message.isStreaming && !message.interaction
        && (message.discussionInteractionId === focus?.interactionId || (!message.discussionInteractionId && legacySegment.has(message.id)))).length } : null,
    learningNotes: state.notes,
    answerEvidence: { submittedTaskCount: records.length, visibleSummary, retained: selected.map(publicRecord), omittedRecordCount: records.length - selected.length },
    finalFeedbackTurn: isSceneFinalFeedbackTurn(spec, run, understanding),
    boundary: '本地核对记录是答题事实；学习观察仅有来源的本局假设，不是掌握认证，不是长期画像。截断预览明确标记，不冒充完整原文。教学推进由Agent组织。',
  };
}

/** Upsert only; omitted open notes cannot be erased by compression or by an assistant explanation. */
export function finalizeSceneTeachingState(raw: unknown, spec: SceneSpec, run: SceneRunState, understanding?: SceneUnderstanding): SceneTeachingState {
  const state = resolveSceneTeachingState(spec, run, understanding), messages = new Map(run.messages.map(message => [message.id, message]));
  const records = collectSceneAnswerRecords(run);
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length > 8) fail('learningNotes每轮最多更新8项。');
    const updatedIds = new Set<string>(), committedNotes = new Map(state.notes.map(note => [note.id, note]));
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('learningNotes更新必须为对象。');
      const entry = item as Record<string, unknown>;
      if (Object.keys(entry).some(key => !['id', 'interactionId', 'kind', 'status', 'summary', 'evidence'].includes(key))
        || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 100
        || !['question', 'misconception', 'self-explanation', 'hint-dependence', 'uncertain'].includes(entry.kind as string)
        || !['open', 'resolved'].includes(entry.status as string)
        || typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 400
        || !Array.isArray(entry.evidence) || !entry.evidence.length || entry.evidence.length > 3) fail('learningNotes字段或长度无效。');
      const evidence = entry.evidence.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('学习观察缺少用户依据。');
        const source = value as Record<string, unknown>, message = messages.get(source.sourceMessageId as string);
        if (Object.keys(source).some(key => !['sourceMessageId', 'quote'].includes(key))
          || !message || message.speakerType !== 'user' || message.isStreaming || typeof source.quote !== 'string'
          || !source.quote.trim() || source.quote.length > 400 || !message.content.includes(source.quote)) fail('学习观察只能引用本局真实用户的精确原话，不能用助手讲解冒充理解证据。');
        return { sourceMessageId: message.id, quote: source.quote };
      });
      if (entry.interactionId !== undefined && (typeof entry.interactionId !== 'string'
        || !records.some(record => record.interactionId === entry.interactionId))) fail('学习观察的题目来源无效。');
      if (updatedIds.has(entry.id)) fail('同轮learningNotes不能重复更新同一ID。');
      updatedIds.add(entry.id);
      const previous = committedNotes.get(entry.id);
      const current = latestUser(run);
      if (previous && previous.summary !== entry.summary && !evidence.some(source => source.sourceMessageId === current?.id
        && !previous.evidence.some(old => old.sourceMessageId === source.sourceMessageId))) fail('改写学习观察摘要需要本轮新的用户依据，不能覆盖旧误解。');
      if (previous && (previous.kind !== entry.kind || previous.interactionId !== entry.interactionId)) fail('不能借相同笔记ID替换观察对象。');
      if (entry.status === 'resolved') {
        const oldIds = new Set(previous?.evidence.map(source => source.sourceMessageId) || []);
        if (!previous || !evidence.some(source => !oldIds.has(source.sourceMessageId)
          && run.messages.findIndex(message => message.id === source.sourceMessageId) > Math.max(...previous.evidence.map(source => run.messages.findIndex(message => message.id === source.sourceMessageId))))) {
          fail('解决已有问题需要较新的用户依据；助手解释过不表示用户已经理解。');
        }
      }
      const note: SceneLearningNote = { id: entry.id, kind: entry.kind as SceneLearningNote['kind'], status: entry.status as SceneLearningNote['status'],
        summary: entry.summary, originalSummary: previous?.originalSummary || previous?.summary || entry.summary, evidence: [...(previous?.evidence || []), ...evidence].filter((source,index,all) =>
          all.findIndex(other => other.sourceMessageId === source.sourceMessageId && other.quote === source.quote) === index).filter((source,index,all) => index === 0 || index >= all.length - 2),
        ...(entry.interactionId === undefined ? {} : { interactionId: entry.interactionId as string }) };
      state.notes = [...state.notes.filter(old => old.id !== note.id), note];
    }
    // Resolved notes may be archived; unresolved observations must never silently disappear.
    if (state.notes.length > 12) {
      const open = state.notes.filter(note => note.status === 'open'), capacity = Math.max(0, 12 - open.length);
      state.notes = [...open, ...(capacity ? state.notes.filter(note => note.status === 'resolved').slice(-capacity) : [])];
    }
    if (state.notes.length > 12) fail('开放问题超过12项；保留原状态，需合并有来源的观察或先处理现有问题。');
  }
  return state;
}

/** Deterministic fallback/final receipt, never an invented pedagogical analysis or unsubmitted answer key. */
export function renderFinalSceneAnswerFeedback(spec: SceneSpec, run: SceneRunState): string {
  const finalRun: SceneRunState = { ...run, status: run.status === 'running' ? 'success' : run.status };
  const lines = collectSceneAnswerRecords(finalRun).flatMap(record => {
    const view = sceneAnswerFeedbackView(spec, finalRun, record.answer.id);
    if (!view) return [];
    const score = typeof view.correct === 'boolean' ? view.correct ? '正确' : '错误'
      : typeof view.correct === 'number' ? view.correct + '/' + view.total + '题正确' : '';
    const explanation = typeof view.explanation === 'string' ? view.explanation
      : view.explanation?.map(item => item.itemId + '：' + item.text).join('；') || '';
    return [record.interactionId + '：' + [score, explanation].filter(Boolean).join('；')];
  });
  return lines.length ? '本局已提交答案核对（不是掌握程度认证）：\n' + lines.join('\n') : '';
}
