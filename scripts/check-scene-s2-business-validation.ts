import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { runS2BusinessValidation, S2_BUSINESS_VALIDATION_CHECKS, s2BusinessCaseArtifactFacts, s2BusinessCaseReferenceSource } from './scene-s2-business-validation';
import type { S2LocalExecution, S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { runS2UiAgentValidation } from './scene-s2-ui-agent-validation';
import { S2_VALIDATION_CHECKS, S2ValidationStop } from './scene-s2-agent-validation';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';

globalThis.fetch = async () => assert.fail('Offline deterministic synthetic decisions only; no model, credentials, notes or profile');
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const raw = '[{"name":"示例甲","score":80},{"name":"","score":120}]';
const misconception = 'JSON解析成功说明所有业务条件都满足。';
function document(prefix: string, incomplete: boolean, invalidInput = false): S2Document {
  return { nodes: [
    { id: `${prefix}input`, type: 'note', position: { x: 0, y: 0 }, values: { content: invalidInput ? 'not json' : raw } },
    { id: `${prefix}understanding`, type: 'note', position: { x: 0, y: 200 }, values: { content: misconception } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: `${prefix}parse`, ...cap('parse-json'), position: { x: 200, y: 0 }, bindings: { text: { kind: 'field', nodeId: `${prefix}input`, fieldId: 'content' } } },
    { id: `${prefix}rows`, ...cap('to-table'), position: { x: 400, y: 0 }, bindings: {} },
    { id: `${prefix}view`, ...cap('table', 'structured-view'), position: { x: 600, y: 0 }, bindings: {} },
  ], links: [
    ...(!incomplete ? [{ source: { nodeId: `${prefix}parse`, portId: 'value' }, target: { nodeId: `${prefix}rows`, portId: 'value' } }] : []),
    { source: { nodeId: `${prefix}rows`, portId: 'table' }, target: { nodeId: `${prefix}view`, portId: 'table' } },
  ] } };
}
function draft(invalidInput = false) {
  const plugins = [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')];
  return readS2Definition({ version: 1, goal: 'Synthetic local JSON-to-table business protocol exercise',
    instructions: { understanding: '理解真实用户要求', planning: '解释或按需协作，不强制教学阶段', response: '建议、正式指标和真实执行记录相互区别' },
    blockTypes: [{ id: 'note', label: '合成内容块', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins, initial: document('', true, invalidInput), business: { version: 1, purpose: '原样解析、转换并展示两条记录，不作业务筛选',
      knowledge: [{ id: 'Types', title: '类型边界', content: 'SyntheticSkillBodyTypes：文本需要显式解析为JSON值，再转换为表格。' },
        { id: 'Meaning', title: '技术与业务', content: 'SyntheticSkillBodyMeaning：语法成功不代表业务条件合格。' }],
      workflow: [{ id: 'LocalPath', goal: '原样解析转换展示', actor: 'tool', capabilities: plugins, input: '完整JSON文本', output: '保持两条原记录的表格展示' }],
      completion: { mode: 'execution', reference: document('Private', false), targetNodeIds: ['Privateview'],
        coverage: [{ requirementId: 'r1', stepIds: ['LocalPath'], nodeIds: ['Privateparse', 'Privaterows', 'Privateview'] }] },
      criteria: [
        { id: 'SourceName', label: '输入值', expectation: '第一条记录name为示例甲', method: 'local', required: true,
          target: { nodeId: 'input', fieldId: 'content' }, rule: { kind: 'json-pointer-equals', pointer: '/0/name', value: '示例甲' } },
        { id: 'Meaning', label: '理解区别', expectation: '区分技术执行成功和业务合格', method: 'semantic', required: true,
          target: { nodeId: 'understanding', fieldId: 'content' } },
        { id: 'Example', label: '开放建议', expectation: '可补充形象例子，不作为必过指标', method: 'advisory', required: false },
      ] } }, { requireBusiness: true });
}
type Variant = 'good' | 'no-skill' | 'no-assessment' | 'request-only-judge' | 'punctuation-judge' | 'cross-stage-judge' | 'failed-execution' | 'host-result-failure' | 'budget-midway' | 'abort-midway';
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) } as LlmCallResponse);
async function run(variant: Variant) {
  let calls = 0, turn = 0; const controller = new AbortController(), artifacts: string[] = [];
  const supplied = draft(variant === 'failed-execution');
  const result = await runS2BusinessValidation({ signal: controller.signal, onArtifact: async name => { artifacts.push(name); }, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); let value: unknown;
    if (variant === 'budget-midway' && input.stage === 'turn-understand' && turn === 1) throw new S2ValidationStop('approval-budget-exhausted');
    if (variant === 'abort-midway' && input.stage === 'turn-understand' && turn === 1) { controller.abort(); throw new DOMException('Stopped', 'AbortError'); }
    if (['understand', 'assemble', 'review'].includes(input.stage)) return s2DesignFixtureResponse(request, supplied);
    if (input.stage === 'turn-understand') {
      turn++;
      if (variant === 'host-result-failure' && input.origin === 'host-event') throw new Error('Synthetic result interpretation failure');
      value = { understanding: 'Synthetic interpretation only, not a quality measurement', desiredOutcome: '测试协议',
        actions: ['reply', ...(turn === 5 ? ['edit'] : []), ...(turn === 6 ? ['execute'] : [])], constraints: [], questions: [],
        ...(turn === 2 && variant !== 'no-skill' ? { skillIds: ['Types'] } : {}) };
    } else if (input.stage === 'turn-act') {
      if (turn === 2 && variant !== 'no-skill') assert.deepEqual(input.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Types']);
      value = { understanding: '合成理解', plan: '合成计划', reply: `合成回应第${turn}轮：这只是离线脚本，不证明模型语义理解。`,
        commands: turn === 5 ? [
          { op: 'add-node', node: { id: 'advice', type: 'note', position: { x: 0, y: 400 }, values: { content: '技术成功不同于业务合格；原文保留。' } } },
          { op: 'connect-ports', link: { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'rows', portId: 'value' } } },
        ] : [],
        ...(turn === 3 && variant !== 'no-assessment' ? { assessment: { criterionIds: ['SourceName', 'Meaning', 'Example'], judgments: [
          { criterionId: 'Meaning', verdict: 'unmet', reason: '原文把技术与业务混同', evidence: [{ sourceId: 'field:understanding:content', quote: misconception }] },
          { criterionId: 'Example', verdict: 'unmet', reason: '建议加一个例子，不据此判断失败', evidence: [] },
        ] } } : {}),
        ...(turn === 6 ? { executionRequest: { targetNodeIds: ['view'], reason: '用户单独确认本地完整目标' } } : {}),
      };
    } else if (input.stage === 'turn-proposal-review') value = { verdict: 'accept', reason: 'Synthetic fixture only', evidence: [{ sourceId: 'query', quote: '现在请协作' }] };
    else {
      assert.equal(input.phase, 's2-ui-independent-review');
      value = { checks: S2_BUSINESS_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met',
        ...(variant === 'punctuation-judge' || variant === 'request-only-judge'
          ? { evidence: variant === 'punctuation-judge' ? '。' : '我想练习在画布上设计本地 JSON 解析' }
          : { evidenceId: input.evidenceCatalogue.find((entry: { checkIds: string[]; sourceId: string }) =>
            variant === 'cross-stage-judge' && id === 'consent-and-local-results' ? entry.sourceId === 'reply-1' : entry.checkIds.includes(id))?.id }),
        reason: 'Overconfident deterministic stub, never semantic acceptance' })) };
    }
    return response(value);
  } });
  return { result, calls, turn, artifacts };
}

const good = await run('good');
assert.equal(good.calls, 19); assert.equal(good.turn, 7); assert.equal(good.result.passed, true);
assert.equal(good.result.browserTested, false); assert.equal(good.result.caseId, 'business-chain');
assert.equal(good.result.businessHostEvidence.modelSemanticsProvenByThisDriver, false);
assert.equal(good.result.businessHostEvidence.businessWitness?.executed, false);
assert.equal(good.result.businessHostEvidence.businessWitness?.businessSuccess, 'not-assessed');
assert.equal(good.result.localChecks.businessRequestedAnalogyActuallyLoadsSkill, true);
assert.equal(good.result.localChecks.businessLocalCriteriaHostRecomputed, true);
assert.equal(good.result.localChecks.businessAdviceDoesNotBecomeFormalFailure, true);
assert.equal(good.result.localChecks.businessHostArtifactsPreserveBothRecords, true);
assert.equal(good.result.steps[2].result.assessment?.overall, 'unmet', 'A real local path may run while an explicitly selected understanding criterion is unmet');
assert.equal(good.result.steps[3].result.assessment, undefined, 'Open discussion needs no task, control or assessment');
assert.equal(good.result.receipts.length, 2, 'Renderer does not forge an extra plugin invocation receipt');
assert.ok(good.artifacts.includes('business-host-evidence'));
assert.equal(good.result.judgeCalls, 1); assert.equal(good.result.reviewSchemaVersion, 2);
for (const key of ['hostEventMatchesConfirmedRun', 'hostEventTriggeredExecutionAvailable', 'sameConversationMemoryThroughout',
  'uiAcceptedMemoryInOrder', 'historyInActualTurnOrder', 'uiClosedConversationMemory']) assert.equal(good.result.localChecks[key], true, key);

// Independently perturb real host artifacts: two rows alone prove neither their values nor their displayed origin.
const runRecord = good.result.workflows[0] as S2WorkflowRun;
const receipts = good.result.receipts as S2LocalExecution[];
const executed = good.result.steps[5].before;
assert.deepEqual(s2BusinessCaseArtifactFacts(runRecord, receipts, executed), {
  parsedRecordsPreserved: true, tableRecordsPreserved: true, convertedFromParsedRecords: true, displayedConvertedTable: true,
});
for (const mutation of ['score', 'empty-to-null', 'missing-name', 'swap-columns', 'different-invocation', 'stale', 'other-run'] as const) {
  const changed = structuredClone(receipts), tableReceipt = changed.find(item => item.request.capabilityId === 'to-table')!;
  const table = tableReceipt.artifacts.find(artifact => artifact.type.id === 'structured-data.table')!;
  assert.equal(table.payload.kind, 'inline');
  const data = (table.payload as { kind: 'inline'; value: any }).value;
  if (mutation === 'score') data.rows[1][1].value = 80;
  if (mutation === 'empty-to-null') data.rows[1][0].value = null;
  if (mutation === 'missing-name') data.rows[1][0] = { present: false, value: null };
  if (mutation === 'swap-columns') data.columns.reverse();
  if (mutation === 'different-invocation') table.source.invocationId = 'unrelated-invocation';
  if (mutation === 'stale') tableReceipt.receipt.publication = 'stale';
  if (mutation === 'other-run') table.source.runId = 'unrelated-session';
  const facts = s2BusinessCaseArtifactFacts(runRecord, changed, executed);
  assert.equal(facts.tableRecordsPreserved, false, mutation);
  assert.equal(facts.displayedConvertedTable, false, mutation);
}
const notDisplayed = structuredClone(runRecord);
notDisplayed.nodes.find(node => node.status === 'displayed')!.artifactIds = ['unrelated-table'];
assert.equal(s2BusinessCaseArtifactFacts(notDisplayed, receipts, executed).displayedConvertedTable, false);
const disconnectedInput = structuredClone(receipts);
disconnectedInput.find(item => item.request.capabilityId === 'to-table')!.request.inputs.value = ['unrelated-json'];
assert.equal(s2BusinessCaseArtifactFacts(runRecord, disconnectedInput, executed).convertedFromParsedRecords, false,
  'Matching output values cannot replace the actual parser-to-converter provenance');
const splitReceipts = structuredClone(receipts), splitRun = structuredClone(runRecord), splitDocument = structuredClone(executed);
const secondTable = structuredClone(splitReceipts.find(item => item.request.capabilityId === 'to-table')!);
secondTable.request.nodeId = 'other-table'; secondTable.request.inputs.value = ['unrelated-json'];
secondTable.receipt.invocationId = 'other-table-invocation'; secondTable.receipt.outputArtifactIds = { table: ['other-table-artifact'] };
secondTable.artifacts[0].id = 'other-table-artifact'; secondTable.artifacts[0].source.nodeId = 'other-table';
secondTable.artifacts[0].source.invocationId = 'other-table-invocation'; splitReceipts.push(secondTable);
splitRun.nodes.push({ nodeId: 'other-table', status: 'succeeded', invocationId: 'other-table-invocation', artifactIds: ['other-table-artifact'] });
splitRun.nodes.find(node => node.status === 'displayed')!.artifactIds = ['other-table-artifact'];
splitDocument.execution!.nodes.push({ ...structuredClone(splitDocument.execution!.nodes.find(node => node.capabilityId === 'to-table')!), id: 'other-table' });
assert.equal(s2BusinessCaseArtifactFacts(splitRun, splitReceipts, splitDocument).convertedFromParsedRecords, true);
assert.equal(s2BusinessCaseArtifactFacts(splitRun, splitReceipts, splitDocument).displayedConvertedTable, false,
  'Cannot splice provenance from an undisplayed table into a different displayed table with identical values');
assert.equal(s2BusinessCaseArtifactFacts({ ...runRecord, revision: runRecord.revision + 1 }, receipts, executed).tableRecordsPreserved, false);
assert.equal(s2BusinessCaseArtifactFacts({ ...runRecord, publication: 'stale' }, receipts, executed).tableRecordsPreserved, false);
assert.ok(s2BusinessCaseReferenceSource(draft()));
const literalReference = draft();
literalReference.business!.completion.reference.execution!.nodes.find(node => node.capabilityId === 'parse-json')!.bindings.text = { kind: 'literal', value: raw };
assert.equal(s2BusinessCaseReferenceSource(literalReference), true, 'A literal source is valid; no field-only business restriction');
const parallelReference = draft(), parallelCompletion = parallelReference.business!.completion;
parallelCompletion.reference.execution!.nodes.push({
  ...structuredClone(parallelCompletion.reference.execution!.nodes.find(node => node.capabilityId === 'parse-json')!), id: 'PrivateSecondParser',
});
parallelCompletion.targetNodeIds.push('PrivateSecondParser');
assert.equal(s2BusinessCaseReferenceSource(parallelReference), true, 'Reference source checks do not impose a fixed parser count');
const wrongReference = draft();
wrongReference.business!.completion.reference.nodes[0].values.content = '[{"name":"示例甲","score":80}]';
assert.equal(s2BusinessCaseReferenceSource(wrongReference), false, 'A schedulable private reference must still preserve the actual case input');

const noSkill = await run('no-skill');
assert.ok(noSkill.result.judge?.every(check => check.verdict === 'met'));
assert.equal(noSkill.result.localChecks.businessRequestedAnalogyActuallyLoadsSkill, false); assert.equal(noSkill.result.passed, false);
const noAssessment = await run('no-assessment');
assert.ok(noAssessment.result.judge?.every(check => check.verdict === 'met'));
assert.equal(noAssessment.result.localChecks.businessFormalAssessmentActuallyReturned, false); assert.equal(noAssessment.result.passed, false);
const onlyRequest = await run('request-only-judge');
assert.equal(onlyRequest.result.localChecks.businessJudgeQuotesGeneratedEvidenceNotOnlyRequest, false); assert.equal(onlyRequest.result.passed, false);
const punctuation = await run('punctuation-judge');
assert.equal(punctuation.result.localChecks.businessJudgeQuotesGeneratedEvidenceNotOnlyRequest, false); assert.equal(punctuation.result.passed, false,
  'Free quotes and punctuation evidence are not accepted by the ID protocol');
assert.equal(punctuation.result.judgeCalls, 1, 'Invalid review format never triggers another paid judge');
const crossStage = await run('cross-stage-judge');
assert.equal(crossStage.result.passed, false); assert.equal(crossStage.result.judge, undefined);
assert.equal(crossStage.result.localChecks.businessJudgeQuotesGeneratedEvidenceNotOnlyRequest, false,
  'A real earlier reply is still invalid evidence for the final host-result interpretation');
const failed = await run('failed-execution');
assert.equal(failed.result.localChecks.businessHostExecutedFullLocalPath, false); assert.equal(failed.result.passed, false);
assert.equal(failed.result.workflows.length, 1, 'Failed local execution is not automatically retried');
assert.equal((failed.result.workflows[0] as S2WorkflowRun).status, 'failed');
assert.ok((failed.result.workflows[0] as S2WorkflowRun).nodes.some(node => node.status === 'failed' && !!node.error));
assert.equal(failed.result.steps.length, 7, 'The failed run still hands off once to the Agent');
assert.equal(failed.result.steps.at(-1)!.origin, 'host-event');
assert.equal(failed.result.localChecks.resultResponseDoesNotReexecute, true);
assert.equal(failed.result.localChecks.resultResponseDoesNotReedit, true);
const lostInterpretation = await run('host-result-failure');
assert.equal(lostInterpretation.result.passed, false);
assert.equal(lostInterpretation.result.workflows.length, 1);
assert.equal((lostInterpretation.result.workflows[0] as S2WorkflowRun).status, 'succeeded');
assert.equal(lostInterpretation.result.receipts.length, 2, 'Completed host receipts survive a later Agent failure');
assert.equal(lostInterpretation.result.localChecks.businessHostExecutedFullLocalPath, true);
assert.equal(lostInterpretation.result.localChecks.businessHostArtifactsPreserveBothRecords, true);
assert.equal(lostInterpretation.result.localChecks.businessOneGroundedHostResponse, false);
assert.equal(lostInterpretation.result.judgeCalls, 0, 'No final reply means no independent judge can certify result interpretation');
assert.ok(lostInterpretation.artifacts.includes('ui-partial-host-records'));
const stopped = await run('budget-midway');
assert.equal(stopped.result.stopped, 'approval-budget-exhausted'); assert.equal(stopped.result.passed, false);
assert.equal(stopped.result.steps.length, 1, 'Partial evidence cannot be filled with fabricated downstream turns');
const aborted = await run('abort-midway');
assert.equal(aborted.result.stopped, 'cancelled'); assert.equal(aborted.result.passed, false);

async function previewOnly(variant: 'good' | 'missing-business' | 'wrong-scope') {
  let calls = 0; const stages: string[] = [];
  const supplied = draft();
  if (variant === 'wrong-scope') supplied.plugins!.push(cap('stringify'));
  const result = await runS2BusinessValidation({ stopAfterPreview: true, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); stages.push(input.stage);
    assert.ok(['understand', 'assemble', 'review'].includes(input.stage), 'Build-only must not start an interaction or independent external judge');
    if (variant === 'missing-business' && input.stage === 'assemble') {
      const { business: _private, ...missing } = supplied;
      return response(missing);
    }
    return s2DesignFixtureResponse(request, supplied);
  } });
  return { calls, stages, result };
}
const preview = await previewOnly('good');
assert.equal(preview.calls, 3); assert.deepEqual(preview.stages, ['understand', 'assemble', 'review']);
assert.equal(preview.result.buildAccepted, true); assert.equal(preview.result.buildPreviewPassed, true);
assert.equal(preview.result.passed, false); assert.equal(preview.result.interactionPassed, false);
assert.equal(preview.result.reviewStatus, 'skipped-build-preview-only');
assert.equal(preview.result.localChecks.previewHasNoExecutionHost, true);
assert.equal(preview.result.localChecks.businessBuildPreviewOnlyHasNoRuntime, true);
assert.equal(preview.result.businessHostEvidence.partial, true);
assert.equal(preview.result.businessHostEvidence.scope, 'build-preview-only');
assert.equal(preview.result.businessHostEvidence.businessWitness?.executed, false);
assert.deepEqual(preview.result.steps, []); assert.deepEqual(preview.result.workflows, []); assert.deepEqual(preview.result.receipts, []);
assert.equal(preview.result.judge, undefined); assert.ok(preview.result.notTested.includes('interaction'));
assert.equal('businessRuntimeFramesObserved' in preview.result.localChecks, false, 'Untested runtime checks are not misreported as failures or passes');
const missingPreview = await previewOnly('missing-business');
assert.equal(missingPreview.result.buildAccepted, true, 'Ordinary scene protocol no longer requires a legacy package; this explicit business fixture still rejects its missing case-specific requirement below');
assert.equal(missingPreview.result.buildPreviewPassed, false);
assert.equal(missingPreview.result.passed, false); assert.equal(missingPreview.result.localChecks.businessBusinessPackageRequired, false);
const wrongScopePreview = await previewOnly('wrong-scope');
assert.equal(wrongScopePreview.calls, 3); assert.equal(wrongScopePreview.result.buildAccepted, true);
assert.equal(wrongScopePreview.result.localChecks.businessOnlyInstalledCaseCapabilities, false);
assert.equal(wrongScopePreview.result.buildPreviewPassed, false); assert.equal(wrongScopePreview.result.passed, false);

// The new validation case is opt-in, not a replacement for old scripts or historical scene readers.
const legacy = draft(); delete legacy.business;
assert.ok(readS2Definition(legacy)); assert.throws(() => readS2Definition(legacy, { requireBusiness: true }), /business/);
let legacyTurn = 0;
const legacyRun = await runS2UiAgentValidation({ invoke: async (request: LlmCallRequest) => {
  const input = JSON.parse(request.userInput);
  if (['understand', 'assemble', 'review'].includes(input.stage)) return s2DesignFixtureResponse(request, legacy);
  if (input.stage === 'turn-understand') { legacyTurn++; return response({ understanding: '旧用例保持独立', desiredOutcome: '合成兼容回归',
    actions: ['reply', ...(legacyTurn === 3 ? ['edit'] : []), ...(legacyTurn === 4 ? ['execute'] : [])], constraints: [], questions: [] }); }
  if (input.stage === 'turn-act') return response({ understanding: '合成理解', plan: '合成计划', reply: `旧用例合成回应${legacyTurn}：仅用于旧用例与当前组件执行协议的兼容检查，不作为真实模型质量评估。`, commands: legacyTurn === 3 ? [
    { op: 'connect-ports', link: { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'rows', portId: 'value' } } },
  ] : [], ...(legacyTurn === 4 ? { executionRequest: { targetNodeIds: ['view'], reason: '局部确认' } } : {}) });
  if (input.stage === 'turn-proposal-review') return response({ verdict: 'accept', reason: 'Synthetic only', evidence: [{ sourceId: 'query', quote: '现在请你协作' }] });
  return response({ checks: S2_VALIDATION_CHECKS.map(id => ({ id, verdict: 'met',
    evidenceId: input.evidenceCatalogue.find((entry: { checkIds: string[] }) => entry.checkIds.includes(id))?.id, reason: 'Synthetic compatibility only' })) });
} });
assert.equal(legacyRun.caseId, 'original-ui-chain'); assert.equal(legacyRun.steps.length, 5); assert.equal(legacyRun.passed, true);
assert.equal(Object.keys(legacyRun.localChecks).some(key => key.startsWith('business')), false);
console.log('S2 business validation driver passed: 19-call complete production-handler chain, private witness/context boundaries, actual selected skill loading, host-recomputed assessment and advisory scope, manual edit/run consent, actual two-record artifacts, optimistic judge cannot override missing skill/assessment or failed execution, budget/cancellation partial failures, opt-in legacy isolation, and 3-call build-preview-only partial evidence with no host/interaction/judge and no whole-chain pass. Deterministic synthetic decisions only; NOT real-model semantic acceptance or browser E2E.');
