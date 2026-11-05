import assert from 'node:assert/strict';
import type { LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2_VALIDATION_CHECKS, S2_VALIDATION_REQUEST } from './scene-s2-agent-validation';
import { S2_BUSINESS_VALIDATION_CASE, S2_BUSINESS_VALIDATION_CHECKS } from './scene-s2-business-validation';
import { runS2UiAgentValidation } from './scene-s2-ui-agent-validation';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { assertS2UiReviewInput, buildS2UiReviewEvidence, readS2UiEvidenceJudge, S2_UI_EVIDENCE_LIMITS,
  type S2UiEvidenceInput } from './scene-s2-ui-evidence';

globalThis.fetch = async () => assert.fail('Offline actual-source binding tests only; no model, credentials, notes, profile or network');
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
function definition() {
  const base = createS2Scene(S2_VALIDATION_REQUEST).canvasWorkspace!;
  const business = syntheticS2Business(base);
  business.knowledge = [{ id: 'PublicKnowledge', title: '公开业务知识', content: '完整的公开业务知识正文供设计审查，不是私有完成参考或本地答案规则。' }];
  business.criteria = [{ id: 'Local', label: '精确比对', expectation: '按预先规则核对', method: 'local', required: true,
    target: { nodeId: base.initial.nodes[0].id, fieldId: base.blockTypes[0].fields[0].id }, rule: { kind: 'text-includes', value: 'PrivateLocalRuleMarker' } }];
  return readS2Definition({ ...base, business }, { requireBusiness: true });
}
function input(business = false): S2UiEvidenceInput {
  const current = definition(), count = business ? 6 : 4;
  const steps = Array.from({ length: count + 1 }, (_, index) => ({ query: `QueryOnlyMarker-${index}-不能作为成功证据的原始用户要求`,
    origin: index === count ? 'host-event' : 'user', before: structuredClone(current.initial), after: structuredClone(current.initial),
    result: { understanding: '合成理解', plan: '合成计划', reply: `实际第${index + 1}轮回复正文：这是一段足够长的确定性协议桩，仅用于绑定真实来源和轮次，不证明模型语义准确。`, commands: [] } }));
  const hostStep = steps[count] as S2UiEvidenceInput['steps'][number];
  hostStep.hostFrame = { sceneId: 'SyntheticScene', runId: 'SyntheticRun', revision: 3,
    event: { id: 'CompletedEvent', kind: 'workflow-completed', workflowRunId: 'ActualWorkflow' } };
  hostStep.triggeredExecution = { available: true, workflowRunId: 'ActualWorkflow', revision: 3 };
  return { originalRequest: business ? S2_BUSINESS_VALIDATION_CASE.request : S2_VALIDATION_REQUEST, definition: current,
    preview: { origin: 'actual-public-preview', document: current.initial }, userDocument: current.initial, steps,
    collaborationIndex: count - 2, executionIndex: count - 1, queryCount: count,
    checkIds: business ? S2_BUSINESS_VALIDATION_CHECKS : S2_VALIDATION_CHECKS,
    localChecks: { uiConfirmedEditMatchesProposal: true, awaitingUserConfirmation: true, selectedTargetsOnly: true, confirmedWorkflowSucceeded: true },
    workflows: [
      { id: 'ActualWorkflow', revision: 3, targets: ['Target'], status: 'succeeded', publication: 'current', nodes: [
        { nodeId: 'Target', status: 'succeeded', artifactIds: ['ActualArtifact'], invocationId: 'ActualInvocation' },
      ] },
      { id: 'UnrelatedWorkflow', revision: 3, targets: ['Other'], status: 'succeeded', publication: 'current', nodes: [
        { nodeId: 'Other', status: 'succeeded', artifactIds: [], invocationId: 'UnrelatedInvocation' },
      ] },
    ], receipts: [
      { request: { nodeId: 'Target' }, receipt: { invocationId: 'ActualInvocation', sceneId: 'SyntheticScene', runId: 'SyntheticRun', revision: 3, publication: 'current', status: 'succeeded' }, artifacts: [] },
      { request: { nodeId: 'Other' }, receipt: { invocationId: 'UnrelatedInvocation', sceneId: 'SyntheticScene', runId: 'SyntheticRun', revision: 3, publication: 'current', status: 'succeeded' }, artifacts: [] },
    ] as unknown as S2UiEvidenceInput['receipts'] };
}
for (const business of [false, true]) {
  const actual = input(business), original = JSON.stringify(actual), compiled = buildS2UiReviewEvidence(actual);
  assert.deepEqual(buildS2UiReviewEvidence(actual).catalogue, compiled.catalogue, 'IDs and exact quotes are stable for identical actual records');
  assert.equal(JSON.stringify(actual), original, 'Compiling review does not mutate source records or saved definition');
  assert.ok(compiled.catalogue.length > 0 && compiled.catalogue.length <= S2_UI_EVIDENCE_LIMITS.candidates);
  assert.ok(!JSON.stringify(compiled).includes('PrivateSyntheticAnswer')); assert.ok(!JSON.stringify(compiled).includes('PrivateLocalRuleMarker'));
  assert.ok(JSON.stringify(compiled.transcript).includes('完整的公开业务知识正文'), 'Sanitizing private witness/rule must not erase public skill content');
  for (const candidate of compiled.catalogue) {
    assert.ok(candidate.quote.length >= 20 && candidate.quote.length <= 100);
    const source = compiled.sources.find(source => source.id === candidate.sourceId)!;
    assert.ok(source.text.includes(candidate.quote)); assert.ok(!candidate.quote.includes('QueryOnlyMarker'));
  }
  for (const [index, step] of actual.steps.entries()) {
    assert.ok(compiled.actualReplies.includes(step.result.reply), 'All actual replies remain available, not replaced by candidate windows');
    const saved = compiled.transcript.steps[index];
    assert.deepEqual(compiled.transcript.documents.find(item => item.id === saved.beforeDocumentId)!.document, step.before);
    assert.deepEqual(compiled.transcript.documents.find(item => item.id === saved.afterDocumentId)!.document, step.after);
  }
  assert.equal(compiled.transcript.documents.length, 1, 'Identical full document snapshots use lossless references');
  const resultCheck = business ? 'consent-and-local-results' : 'result-grounding';
  const eligible = compiled.catalogue.filter(entry => entry.checkIds.includes(resultCheck));
  assert.ok(eligible.length > 0);
  assert.ok(eligible.every(entry => entry.turn === actual.steps.length && entry.origin === 'host-event'));
  assert.ok(eligible.every(entry => !entry.quote.includes('UnrelatedInvocation') && !entry.quote.includes('UnrelatedWorkflow')));
  assert.ok(compiled.catalogue.filter(entry => entry.checkIds.includes(business ? 'collaboration-preserves-work' : 'preserve-and-collaborate'))
    .every(entry => entry.turn === actual.collaborationIndex + 1));
  const good = { checks: actual.checkIds.map(id => ({ id, verdict: 'met', evidenceId: compiled.catalogue.find(entry => entry.checkIds.includes(id))!.id,
    reason: '故意乐观的确定性桩，只证明绑定协议，不证明真实语义质量。' })) };
  const restored = readS2UiEvidenceJudge(good, compiled.catalogue, actual.checkIds);
  assert.ok(restored.every(check => compiled.catalogue.find(entry => entry.id === check.evidenceId)!.quote === check.evidence));
  for (const mode of ['unknown', 'wrong-source', 'free-quote', 'extra'] as const) {
    const bad = structuredClone(good), check = bad.checks.find(item => item.id === resultCheck)!;
    if (mode === 'unknown') check.evidenceId = 'UnknownEvidenceId';
    if (mode === 'wrong-source') check.evidenceId = compiled.catalogue.find(entry => entry.origin === 'user' && entry.turn === 1)!.id;
    if (mode === 'free-quote') Object.assign(check, { evidence: '实际来源正文存在也不能用自由复制字符串替代绑定ID。' });
    if (mode === 'extra') Object.assign(check, { confidence: 1 });
    assert.throws(() => readS2UiEvidenceJudge(bad, compiled.catalogue, actual.checkIds));
  }
  for (const mode of ['wrong-event', 'missing-event', 'wrong-revision', 'unavailable-trigger', 'user-not-event'] as const) {
    const wrong = structuredClone(actual), last = wrong.steps.at(-1)!;
    if (mode === 'wrong-event') last.hostFrame!.event.workflowRunId = 'NeverActuallyCompleted';
    if (mode === 'missing-event') delete last.hostFrame;
    if (mode === 'wrong-revision') last.hostFrame!.revision++;
    if (mode === 'unavailable-trigger') last.triggeredExecution!.available = false;
    if (mode === 'user-not-event') last.origin = 'user';
    assert.throws(() => buildS2UiReviewEvidence(wrong), /ui-evidence-empty/, 'A user promise or unrelated/current-latest run cannot manufacture completion evidence');
  }
}
const headingOnly = input(); headingOnly.steps[0].result.reply = '**一个形象例子：寄快递**';
assert.throws(() => buildS2UiReviewEvidence(headingOnly), /ui-evidence-empty/);
const oversized = input(); oversized.steps[0].result.reply = 'x'.repeat(S2_UI_EVIDENCE_LIMITS.sourceChars + 1);
assert.throws(() => buildS2UiReviewEvidence(oversized), /ui-evidence-limit/);
assert.throws(() => assertS2UiReviewInput('x'.repeat(S2_UI_EVIDENCE_LIMITS.inputChars + 1)), /ui-review-input-too-large/);
const tooMany = input(); tooMany.steps[0].result.reply = Array.from({ length: 200 }, (_, index) => `${index}:`.padEnd(59, 'x') + '。').join('\n');
assert.throws(() => buildS2UiReviewEvidence(tooMany), /ui-evidence-limit/, 'Candidate overflow fails closed, never silently drops the full input');

// Integration exercises the real UI handlers/controllers/local host, not DOM/browser rendering or model quality.
const draft = readS2Definition({ version: 1, goal: 'Synthetic actual source bound workflow design exercise',
  instructions: { understanding: '理解实际用户要求，不从工具倒推意图', planning: '用户明确委托后才提最小补线方案，执行仍单独确认', response: '说明真实本地结果，不能把解析成功当作业务条件合格' },
  blockTypes: [{ id: 'note', label: '合成文本', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('to-table')], initial: { nodes: [{ id: 'Input', type: 'note', position: { x: 0, y: 0 }, values: { content: '[{"name":"示例甲","score":80}]' } }], edges: [],
    execution: { version: 1, nodes: [{ id: 'Parse', ...cap('parse-json'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'Input', fieldId: 'content' } } },
      { id: 'Table', ...cap('to-table'), position: { x: 200, y: 0 }, bindings: {} }], links: [] } } });
async function ui(variant: 'good' | 'cross-source' | 'free-quote' | 'construction-failure') {
  let calls = 0, turns = 0, reviews = 0;
  // Fixed scripted replies validate complete-catalogue compatibility, not discovery rounds.
  const result = await runS2UiAgentValidation({ disclosure: 'complete', ...(variant === 'construction-failure' ? { validationCase: {
    id: 'unknown-review-check', request: S2_VALIDATION_REQUEST, learnerText: '合成学习者原文',
    queries: ['先提示不改图不运行', '再举例不改图不运行', '现在请你协作提出补线方案', '申请运行待用户确认'],
    collaborationIndex: 2, executionIndex: 3, checks: ['unknown-check'], reviewRules: '未注册评审不得生成证据' } } : {}), invoke: async request => {
      calls++; const value = JSON.parse(request.userInput);
      if (['understand', 'assemble', 'review'].includes(value.stage)) return s2DesignFixtureResponse(request, draft);
      if (value.stage === 'turn-understand') { turns++; return { content: JSON.stringify({ understanding: '合成意图摘要', desiredOutcome: '只测执行协议与来源绑定',
        actions: ['reply', ...(turns === 3 ? ['edit'] : []), ...(turns === 4 ? ['execute'] : [])], constraints: [], questions: [] }) }; }
      if (value.stage === 'turn-proposal-review') return { content: JSON.stringify({ verdict: 'accept', reason: '仅为确定性协议桩，不证明实际业务判断', evidence: [{ sourceId: 'query', quote: '现在请你协作' }] }) };
      if (value.stage === 'turn-act') return { content: JSON.stringify({ understanding: '合成理解', plan: '合成计划',
        reply: `实际第${turns}轮合成回复：这里只验证来源与状态流转，不声称模型质量或浏览器验收已经通过。`,
        commands: turns === 3 ? [{ op: 'connect-ports', link: { source: { nodeId: 'Parse', portId: 'value' }, target: { nodeId: 'Table', portId: 'value' } } }] : [],
        ...(turns === 4 ? { executionRequest: { targetNodeIds: ['Table'], reason: '用户单独确认后执行必要上游与目标' } } : {}) }) };
      reviews++; assert.equal(value.phase, 's2-ui-independent-review'); assert.equal(value.formatRepair, undefined);
      assert.ok(!request.userInput.includes('PrivateSyntheticAnswer'));
      return { content: JSON.stringify({ checks: value.checkIds.map((id: string) => {
        const entry = value.evidenceCatalogue.find((entry: { checkIds: string[] }) => entry.checkIds.includes(id));
        const result: Record<string, unknown> = { id, verdict: 'met', evidenceId: entry.id, reason: '故意乐观的离线桩，不能覆盖宿主事实或错源ID。' };
        if (id === 'result-grounding' && variant === 'cross-source') result.evidenceId = value.evidenceCatalogue.find((entry: { turn?: number; origin?: string }) => entry.turn === 1 && entry.origin === 'user').id;
        if (id === 'result-grounding' && variant === 'free-quote') result.evidence = entry.quote;
        return result;
      }) }) } as LlmCallResponse;
    } });
  return { result, calls, turns, reviews };
}
const integrated = await ui('good'); assert.equal(integrated.calls, 15); assert.equal(integrated.reviews, 1); assert.equal(integrated.result.passed, true);
assert.equal(integrated.result.browserTested, false); assert.equal(integrated.result.judgeCalls, 1);
assert.equal(integrated.result.localChecks.hostEventMatchesConfirmedRun, true); assert.equal(integrated.result.localChecks.uiAcceptedMemoryInOrder, true);
assert.equal(integrated.result.localChecks.historyInActualTurnOrder, true); assert.equal(integrated.result.localChecks.uiClosedConversationMemory, true);
assert.equal(integrated.result.steps.at(-1)!.triggeredExecution!.available, true);
for (const variant of ['cross-source', 'free-quote'] as const) {
  const failed = await ui(variant); assert.equal(failed.result.passed, false); assert.equal(failed.calls, 15); assert.equal(failed.reviews, 1);
  assert.equal(failed.result.reviewStatus, 'failed');
}
const unavailable = await ui('construction-failure'); assert.equal(unavailable.result.passed, false);
assert.equal(unavailable.calls, 14); assert.equal(unavailable.reviews, 0); assert.equal(unavailable.result.judgeCalls, 0);
assert.equal(unavailable.result.reviewStatus, 'skipped-evidence-unavailable'); assert.ok(unavailable.result.notTested.includes('independent-interaction-review'));
console.log('S2 complete UI evidence protocol passed: actual public design/reply/confirmed-edit/host sources, check-bound stable IDs, real turn and exact matching completion-event/run/receipt binding, no user-query-only proof, private reference/rule excluded with public skill body retained, full transcript and lossless document snapshots, exact local quote restoration, wrong-source/unknown/free-quote/extra rejection, bounded empty/oversize fail-closed predispatch, single judge/no format retry, and actual UI host/history/memory lifecycle. Synthetic offline tests only; NOT real-model or browser acceptance.');
