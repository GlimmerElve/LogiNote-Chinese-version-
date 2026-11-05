/** A bounded continuation of a failed, paid synthetic build, never a hand-authored candidate or acceptance override. */
import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { createS2Scene, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { parseJsonLenient } from '../src/services/reviewSegmentScoring';
import { recoverS2RedundantObjectClosers } from '../src/services/scene/sceneS2Output';
import { createS2ExactReplay } from './scene-s2-exact-replay';
import type { S2UiValidationCase } from './scene-s2-ui-agent-validation';

type Usage = { calls: number; outputTokensReserved: number };
type Metadata = { id: string; model: string; origin: string };
export async function prepareS2TaskReplay(input: {
  manifest: any; report: any; dispatch: any[];
  requests: LlmCallRequest[]; responses: LlmCallResponse[];
  task: S2UiValidationCase; provider: Metadata; inheritedUsage: Usage;
}) {
  const { manifest, report, task, provider, requests, responses } = input;
  assert.equal(manifest.kind, 's2-real-agent-validation');
  assert.equal(manifest.profile, 'ui-chain'); assert.equal(report.profile, 'ui-chain');
  assert.equal(manifest.taskCaseId, task.id); assert.equal(report.taskCaseId, task.id); assert.equal(report.caseId, task.id);
  assert.equal(manifest.taskBuildPreviewOnly, true); assert.equal(report.taskBuildPreviewOnly, true);
  assert.equal(manifest.syntheticOnly, true); assert.equal(manifest.productionWrites, 0); assert.equal(report.productionWrites, 0);
  assert.deepEqual(manifest.provider, provider); assert.deepEqual(report.provider, provider); assert.equal(report.execution, 'real-provider');
  assert.deepEqual(manifest.approval, { maxCalls: 24, reservedOutputTokens: 48000 });
  assert.equal(manifest.resumedSameApprovalPaidPrefix, false); assert.equal(manifest.replayPrefix, undefined);
  assert.equal(manifest.approvalTransition, undefined); assert.equal(manifest.approvalLedgerRoot, undefined);
  assert.equal(report.replayedExactPaidRequests, 0); assert.equal(report.automaticTransportRetries, 0);
  assert.equal(report.buildAccepted, false); assert.equal(report.buildPreviewPassed, false);
  assert.equal(report.interactionPassed, false); assert.equal(report.passed, false); assert.equal(report.browserTested, false);
  assert.equal(report.stopped, 'build-stage-failed'); assert.equal(report.judgeCalls, 0);
  for (const name of ['steps', 'workflows', 'receipts', 'humanActions']) assert.deepEqual(report[name], []);
  assert.equal(requests.length, 3); assert.equal(responses.length, 3);
  const prior = manifest.prior as Usage;
  assert(prior && Number.isSafeInteger(prior.calls) && prior.calls >= 0 && Number.isSafeInteger(prior.outputTokensReserved) && prior.outputTokensReserved >= 0);
  let reserved = 0;
  const parsed = requests.map((request, index) => {
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert.equal(request.workflow, 'agent-scene-setup');
    assert(!request.tools?.length && !request.images?.length && !request.agentMessages?.length);
    assert.equal(typeof request.userInput, 'string'); assert(request.userInput.length < 120000);
    const cap = request.maxTokensOverride!;
    assert(Number.isSafeInteger(cap) && cap >= 256 && cap <= (index === 1 ? 6144 : index === 2 ? 1536 : 3072));
    reserved += cap;
    assert.equal(responses[index].diagnostics?.finishReason, 'stop');
    assert.equal(typeof responses[index].content, 'string'); assert(responses[index].content.length <= 64000);
    return JSON.parse(request.userInput);
  });
  assert.equal(parsed[0].stage, 'understand'); assert.equal(parsed[1].stage, 'assemble');
  assert.equal(parsed[2].stage, 'assemble'); assert.equal(parsed[2].feedback?.kind, 'protocol');
  assert.equal(parsed[1].feedback, undefined); assert.equal(parsed[1].jsonFormatRepair, undefined);
  assert.deepEqual(parsed[1].sources, parsed[0].sources); assert.deepEqual(parsed[2].sources, parsed[0].sources);
  let paidCandidate: unknown;
  try { paidCandidate = parseJsonLenient(responses[1].content); }
  catch { paidCandidate = recoverS2RedundantObjectClosers(responses[1].content); }
  assert(paidCandidate, 'The paid output must be recoverable by the unchanged production object parser');
  assert.deepEqual(parsed[2].previousCandidate, paidCandidate);
  assert.deepEqual(report.approvalUsage, { calls: prior.calls + 3, outputTokensReserved: prior.outputTokensReserved + reserved });
  assert.deepEqual(input.inheritedUsage, report.approvalUsage);
  assert(report.approvalUsage.calls + 2 <= 24 && report.approvalUsage.outputTokensReserved + 1536 + 2048 <= 48000,
    'Need room for one bounded repair and one independent builder review without resetting approval');
  assert.deepEqual(report.dispatchAudit, { ipc: { calls: 3, tokens: reserved }, http: { calls: 3, tokens: reserved } });
  assert.equal(input.dispatch.length, 6);
  const counters = { ipc: { calls: 0, tokens: 0 }, http: { calls: 0, tokens: 0 } };
  input.dispatch.forEach((row, index) => {
    const kind = index % 2 === 0 ? 'ipc' : 'http';
    assert.equal(row.kind, kind); assert.equal(row.tokens, requests[Math.floor(index / 2)].maxTokensOverride);
    counters[kind].calls++; counters[kind].tokens += row.tokens;
    assert.deepEqual(row.usage, { calls: prior.calls + Math.max(counters.ipc.calls, counters.http.calls),
      outputTokensReserved: prior.outputTokensReserved + Math.max(counters.ipc.tokens, counters.http.tokens) });
  });

  // Run the current production builder before claiming the source endpoint. It must issue
  // exactly matching paid requests and reach a real local protocol error, not an accepted substitute.
  // This helper accepts only the historical two-stage complete-context prefix above.
  // New production builds keep progressive discovery; they are not silently replayed through this branch.
  const entries = requests.slice(0, 2).map((request, index) => ({ request, response: responses[index] }));
  const replay = createS2ExactReplay(entries), stop = new Error('S2_TASK_REPLAY_LOCAL_PREFLIGHT_STOP');
  let next: LlmCallRequest | undefined;
  try {
    await designS2Canvas(createS2Scene(task.request), { review: true, disclosure: 'complete', invoke: async request => {
      if (replay.remaining) return replay.take(request);
      next = request; throw stop;
    } });
    assert.fail('The failed prefix must not already be accepted');
  } catch (error) { if (error !== stop) throw error; }
  assert.equal(replay.consumed, 2); assert(next);
  const repair = JSON.parse(next.userInput);
  assert.equal(repair.stage, 'assemble'); assert.equal(repair.feedback?.kind, 'protocol'); assert.equal(next.maxTokensOverride, 1536);
  assert.deepEqual(repair.previousCandidate, parsed[2].previousCandidate); assert.deepEqual(repair.sources, parsed[0].sources);
  const issues = repair.repairContext?.connectionIssues, businessIssues = repair.repairContext?.businessDesignIssues;
  assert(Array.isArray(issues) && Array.isArray(businessIssues) && (issues.length > 0 || businessIssues.length > 0),
    'This continuation requires an actual current connection or business structural diagnostic');
  return { entries: structuredClone(entries), preflight: { prefixRequestsVerified: 2, nextStage: 'protocol-repair',
    repairOutputCap: 1536, builderReviewOutputCap: 2048, connectionIssuePaths: issues.map((issue: { linkPath: string }) => issue.linkPath),
    businessIssuePaths: businessIssues.map((issue: { path: string }) => issue.path),
    freshBuildTested: false, wholeChainTested: false, browserTested: false } };
}
