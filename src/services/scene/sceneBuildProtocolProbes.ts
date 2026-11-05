import type { SceneInteractionDirective, SceneInteractionType, SceneMessage, SceneQuestionSetItem, SceneSpec } from '../../types';
import { createRunState, appendMessage, checkCompletion } from './sceneRuntime';
import { resolveSceneRuntimeContract } from './sceneRuntimeContract';
import { normalizeSceneInteractionDirectiveV2, normalizeSceneInteractionResponseV2 } from './sceneInteractionV2Adapter';
import { resolveSceneRuntimeInteractionProtocol, normalizeQuestionSetEvaluation, gradeQuestionSetResponse } from './sceneInteraction';
import { normalizeSceneObjectiveEvaluation, gradeSceneObjectiveResponse } from './sceneAssessment';
import { getPendingSceneInteraction, validateSceneTaskUpdate } from './scenePendingTask';
import { unreachableSceneStages } from './sceneExecutionRegistry';
import { readSceneFormSubmission } from './sceneInputForm';
import { resolveSceneInputAvailability } from './sceneInputAvailability';

export interface SceneBuildProtocolProbes {
  method: 'local-protocol-probes-v1';
  semanticAccuracyEvaluated: false;
  uiEvaluated: false;
  actualToolCalls: 0;
  coverage: { authorizedInteractionTypes: SceneInteractionType[]; testedInteractionTypes: SceneInteractionType[];
    authorizedQuestionItemTypes: Array<SceneQuestionSetItem['type']>; testedQuestionItemTypes: Array<SceneQuestionSetItem['type']> };
  passed: boolean;
  cases: Array<{ id: string; status: 'passed' | 'failed' | 'skipped'; target: 'behavior' | 'runtimeContract'; detail: string }>;
}

/** The semantic reviewer needs coverage and failures, not hundreds of repeated passing descriptions. */
export function compactSceneBuildProtocolProbes(report: SceneBuildProtocolProbes) {
  const fixtures = new Map<string, { id: string; passed: number; failed: number; skipped: number }>();
  for (const item of report.cases) {
    const parts = item.id.split(':');
    const id = parts[0] === 'type' || parts[0] === 'handoff' ? parts.slice(0, 2).join(':') : 'global';
    const fixture = fixtures.get(id) || { id, passed: 0, failed: 0, skipped: 0 };
    fixture[item.status]++; fixtures.set(id, fixture);
  }
  return { method: report.method, passed: report.passed, semanticAccuracyEvaluated: report.semanticAccuracyEvaluated,
    uiEvaluated: report.uiEvaluated, actualToolCalls: report.actualToolCalls, coverage: structuredClone(report.coverage),
    scope: '仅本地合成协议及执行状态交接；未执行真实工具、未评估模型语义、未做真实界面端到端。',
    caseCount: report.cases.length, fixtures: [...fixtures.values()], failures: report.cases.filter(item => item.status === 'failed').map(item => ({ ...item })) };
}

function syntheticTask(type: SceneInteractionType, id: string, childType: SceneQuestionSetItem['type'] = 'single-choice') {
  const options = [{ id: 'a', label: '合成选项甲' }, { id: 'b', label: '合成选项乙' }];
  if (type === 'single-choice' || type === 'multiple-choice') return { id, type, required: true, assessment: 'objective', options,
    ...(type === 'multiple-choice' ? { minSelections: 1, maxSelections: 2 } : {}) };
  if (type === 'question-set') return { id, type, required: true, submissionMode: 'batch', feedbackMode: 'after-submit',
    items: [1, 2].map(index => ({ id: id + '-item-' + index, type: childType, required: true, content: '合成协议题',
      ...(childType === 'true-false' ? {} : { options }) })) };
  if (type === 'ordering') return { id, type, required: true, assessment: 'objective', items: [{ id: 's1', content: '合成步骤甲' }, { id: 's2', content: '合成步骤乙' }] };
  if (type === 'fill-blanks') return { id, type, required: true, blanks: [{ id: 'blank', label: '合成空缺' }] };
  return { id, type: 'text', required: true, minLength: 1 };
}

function syntheticAnswer(task: SceneInteractionDirective) {
  return normalizeSceneInteractionResponseV2({ interactionId: task.id, type: task.type, submittedAt: '',
    ...(task.type === 'single-choice' ? { selectedId: 'a' } : task.type === 'multiple-choice' ? { selectedIds: ['a'] }
      : task.type === 'question-set' ? { answers: task.items.map(item => ({ itemId: item.id, type: item.type,
        ...(item.type === 'true-false' ? { value: true } : item.type === 'multiple-choice' ? { selectedIds: ['a'] } : { selectedId: 'a' }) })) }
        : task.type === 'ordering' ? { orderedIds: ['s1', 's2'] } : task.type === 'fill-blanks' ? { values: { blank: '合成内容' } } : { value: '合成回答' }) }, task);
}

/** All actual authorized types and bounded handoffs, not permutations, real tools, model semantics or a UI smoke test. */
export function probeSceneBuildProtocol(spec: SceneSpec): SceneBuildProtocolProbes {
  const report: SceneBuildProtocolProbes = { method: 'local-protocol-probes-v1', semanticAccuracyEvaluated: false, uiEvaluated: false,
    actualToolCalls: 0, passed: true, cases: [], coverage: { authorizedInteractionTypes: [], testedInteractionTypes: [], authorizedQuestionItemTypes: [], testedQuestionItemTypes: [] } };
  const record = (id: string, ok: boolean, detail: string, target: 'behavior' | 'runtimeContract' = 'behavior') => {
    report.cases.push({ id, status: ok ? 'passed' : 'failed', target, detail }); if (!ok) report.passed = false;
  };
  if (spec.meta.sceneSkill === 'S4') {
    report.cases.push({ id: 'dialogue-loop', status: 'skipped', target: 'behavior', detail: 'S4保持自己的数理画布检查，不运行S1对话探针；不代表画布已联调。' }); return report;
  }
  try {
    const contract = resolveSceneRuntimeContract(spec);
    const protocol = { ...resolveSceneRuntimeInteractionProtocol(spec.behavior?.interaction), allowedTypes: contract.allowedInteractionTypes,
      defaultType: contract.allowedInteractionTypes[0], allowTextFallback: contract.allowTextFallback };
    report.coverage.authorizedInteractionTypes = [...contract.allowedInteractionTypes];
    report.coverage.authorizedQuestionItemTypes = contract.allowedInteractionTypes.includes('question-set') ? [...(contract.allowedQuestionItemTypes || [])] : [];
    if (spec.runtimeContract?.stages !== undefined) record('explicit-stage-reachability', !unreachableSceneStages(contract).length,
      '检查显式自定义阶段从初始节点可达；允许合法循环，不要求固定教学流程。', 'runtimeContract');
    // Preserve historical representative case IDs, but no longer stop after that representative.
    const first = contract.allowedInteractionTypes.find(id => ['single-choice', 'multiple-choice', 'question-set'].includes(id)) || contract.allowedInteractionTypes[0];
    const types = [first, ...contract.allowedInteractionTypes.filter(type => type !== first)];
    const fixtures = types.flatMap<{ id: string; type: SceneInteractionType; childType?: SceneQuestionSetItem['type'] }>(type => type === 'question-set'
      ? (contract.allowedQuestionItemTypes || []).map(childType => ({ id: type + '-' + childType, type, childType }))
      : [{ id: type, type, childType: undefined }]);
    const validatedTasks: SceneInteractionDirective[] = [];
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const reportCase = (id: string, ok: boolean, detail: string, target: 'behavior' | 'runtimeContract' = 'behavior') => {
        record('type:' + fixture.id + ':' + id, ok, detail, target);
        if (fixtureIndex === 0) record(id, ok, detail, target);
      };
      const task = normalizeSceneInteractionDirectiveV2(syntheticTask(fixture.type, 'probe-' + fixture.id, fixture.childType), protocol);
      reportCase('authorized-task', Boolean(task), '只使用本场景实际授权类型，创建合成协议控件，不取真实知识材料。');
      if (!task) continue;
      validatedTasks.push(task);
      if (!report.coverage.testedInteractionTypes.includes(task.type)) report.coverage.testedInteractionTypes.push(task.type);
      if (task.type === 'question-set') for (const item of task.items) if (!report.coverage.testedQuestionItemTypes.includes(item.type)) report.coverage.testedQuestionItemTypes.push(item.type);
      reportCase('task-count-within-contract', task.type !== 'question-set' || task.items.length <= contract.maxUserTasksPerTurn,
        '题组最小可执行题量也不得超过本场景上限；逐子型测试，不把多个探针视作一轮真实任务。', 'runtimeContract');
      const key = normalizeSceneObjectiveEvaluation({ interactionId: task.id, type: task.type,
        ...(task.type === 'single-choice' ? { correctId: 'a' } : task.type === 'ordering' ? { correctOrderIds: ['s1', 's2'] } : { correctIds: ['a'] }), explanation: '合成本地答案' }, task);
      const batchKey = normalizeQuestionSetEvaluation({ interactionId: task.id, type: 'question-set', items: task.type === 'question-set'
        ? task.items.map(item => ({ itemId: item.id, type: item.type, ...(item.type === 'true-false' ? { correctValue: true } : item.type === 'multiple-choice' ? { correctIds: ['a'] } : { correctId: 'a' }) })) : [] }, task);
      if (['single-choice', 'multiple-choice', 'ordering', 'question-set'].includes(task.type)) reportCase('private-answer-key', Boolean(key || batchKey)
        && !/correctId|correctIds|correctValue|correctOrderIds/u.test(JSON.stringify(task)), '使用实际本地私有答案校验器，公开控件不携带答案。');
      let run = createRunState(spec);
      const append = (id: string, speakerType: 'role' | 'user', content: string, extra: Partial<SceneMessage> = {}) => {
        run = appendMessage(run, { id, speakerType, speakerName: '合成协议验收', content, timestamp: '', ...extra });
      };
      append('probe-role-task', 'role', '合成协议任务', { interaction: task, objectiveEvaluation: key, interactionEvaluation: batchKey });
      reportCase('pending-task', getPendingSceneInteraction(run)?.interaction?.id === task.id, '运行器可定位本类型待答任务。');
      const activeAvailability = resolveSceneInputAvailability(spec, run);
      if (activeAvailability.formConfigured && task.type !== 'text') reportCase('form-waits-with-task', !activeAvailability.formAvailable
        && activeAvailability.pendingInteractionId === task.id, '同一执行可用性函数确认原题优先，表单不冒充该题答案；不代表UI已联调。');
      if (contract.allowConversation) {
        for (const [id, content] of [['hint', '先给提示，不要答案。'], ['harder', '下一题请更难，保留当前题型。'], ['correction', '这道题似乎有误，请核查。']]) {
          append('probe-user-' + id, 'user', content, { inputKind: 'conversation' });
          append('probe-role-' + id, 'role', '合成控制回应，保留原题。');
          reportCase(id + '-keeps-task', getPendingSceneInteraction(run)?.interaction?.id === task.id, '纯交流不写作答记录，原题保持待答；不声称模型已理解这句话。');
        }
        const cancelRun = appendMessage(run, { id: 'probe-cancel-source', speakerType: 'user', speakerName: '合成用户', content: '取消当前题。', timestamp: '', inputKind: 'conversation' });
        const update = validateSceneTaskUpdate({ operation: 'cancel', interactionId: task.id, sourceUserMessageId: 'probe-cancel-source', reason: '合成取消验证' }, cancelRun);
        if (!update) throw new Error('合成取消未返回已校验操作');
        const retired = { ...cancelRun, retiredInteractionIds: [update.interactionId] };
        reportCase('validated-cancel', !getPendingSceneInteraction(retired), '已校验取消退役原题；不是自动取消来腾出工具入口。');
        if (activeAvailability.formConfigured) reportCase('form-after-cancel', resolveSceneInputAvailability(spec, retired).formAvailable, '用户明确取消后，真实可用性函数释放表单提交。');
        const nextFixture = fixtures[(fixtureIndex + 1) % fixtures.length];
        const nextTask = normalizeSceneInteractionDirectiveV2(syntheticTask(nextFixture.type, 'probe-after-cancel-' + fixture.id, nextFixture.childType), protocol);
        if (nextTask) {
          const afterCancel = appendMessage(retired, { id: 'probe-after-cancel', speakerType: 'role', speakerName: '合成验收', content: '用户取消之后的新授权任务', timestamp: '', interaction: nextTask });
          reportCase('cancel-handoff', getPendingSceneInteraction(afterCancel)?.interaction?.id === nextTask.id && afterCancel.retiredInteractionIds.includes(task.id),
            '显式取消后可交接至下一授权组件，旧任务保持退役、消息未删除。');
          const replaced = validateSceneTaskUpdate({ operation: 'replace', interactionId: task.id, sourceUserMessageId: 'probe-cancel-source', reason: '合成用户明确换题验证' }, cancelRun, nextTask);
          reportCase('replace-handoff', Boolean(replaced && replaced.operation === 'replace'), '不同id的替换任务仍须绑定最新真实交流，不能借组件切换扩大权限。');
        }
      } else report.cases.push({ id: 'type:' + fixture.id + ':conversation-controls', status: 'skipped', target: 'runtimeContract', detail: '尊重明确关闭的交流入口。' });
      const response = syntheticAnswer(task);
      reportCase('original-answer', Boolean(response), '控制对话之后，原任务id仍可通过对应响应校验。');
      if (!response) continue;
      const assessment = gradeSceneObjectiveResponse(response, key), batchGrade = gradeQuestionSetResponse(response, batchKey);
      if (key || batchKey) reportCase('local-grading', assessment?.correct === true || Boolean(batchGrade && batchGrade.correct === batchGrade.total), '实际本地grader核对，不调用模型重判。');
      else report.cases.push({ id: 'type:' + fixture.id + ':local-grading', status: 'skipped', target: 'behavior', detail: '该类型无本地客观评分器，不虚构答案。' });
      append('probe-user-answer', 'user', '合成作答', { interactionResponse: response, objectiveAssessment: assessment, inputKind: 'response' });
      reportCase('answer-resolves-task', !getPendingSceneInteraction(run), '已验证响应使原题退出pending。');
      if (activeAvailability.formConfigured) reportCase('form-after-answer', resolveSceneInputAvailability(spec, run).formAvailable, '作答完成后，真实可用性函数释放表单提交。');
      const ended = checkCompletion(spec, run, { userIntentEnd: true });
      reportCase('summary-user-end', ended.status !== 'running' && ended.completionOutcome === 'stopped', '本地主动收场不冒充目标达成；模型总结质量未验收。', 'runtimeContract');
    }
    // One bounded sequence covers every chosen component once, without factorial permutation enumeration.
    let handoffRun = createRunState(spec);
    for (const [index, task] of validatedTasks.entries()) {
      const previousMessages = handoffRun.messages.length;
      handoffRun = appendMessage(handoffRun, { id: 'probe-handoff-role-' + index, speakerType: 'role', speakerName: '合成验收', content: '授权组件交接', timestamp: '', interaction: task });
      record('handoff:' + task.id + ':activate', getPendingSceneInteraction(handoffRun)?.interaction?.id === task.id && handoffRun.messages.length === previousMessages + 1,
        '上一任务完成后再激活下一授权组件；之前消息/作答保留，不强制真实教学必须立即出下一题。');
      const response = syntheticAnswer(task);
      if (response) handoffRun = appendMessage(handoffRun, { id: 'probe-handoff-answer-' + index, speakerType: 'user', speakerName: '合成验收', content: '合成作答', timestamp: '', inputKind: 'response', interactionResponse: response });
      record('handoff:' + task.id + ':release', Boolean(response) && !getPendingSceneInteraction(handoffRun), '有效提交释放作答槽位，已提交记录仍在本局。');
    }
    const form = resolveSceneInputAvailability(spec, handoffRun).inputForm;
    if (form) {
      const values = Object.fromEntries(form.fields.map(field => [field.id, field.kind === 'select' ? field.options![0].value : 'x'.repeat(Math.min(4, field.maxLength))]));
      const submission = readSceneFormSubmission({ formId: form.id, values }, form);
      record('form-submission-schema', submission.formId === form.id, '实际表单schema可接收合成字段值；不提交给真实模型，不替代待答客观题。');
    }
    record('authorized-coverage', report.coverage.authorizedInteractionTypes.every(type => report.coverage.testedInteractionTypes.includes(type))
      && report.coverage.authorizedQuestionItemTypes.every(type => report.coverage.testedQuestionItemTypes.includes(type)), '覆盖所有实际授权顶层类型及题组子型；不代表真实工具、模型语义或UI端到端已测。', 'runtimeContract');
  } catch (error) { record('protocol-execution', false, error instanceof Error ? error.message : '合成协议执行失败；无模型或工具调用。'); }
  return report;
}
