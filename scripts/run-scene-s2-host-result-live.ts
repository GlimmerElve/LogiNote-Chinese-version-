/** Explicitly approved synthetic host-result subset. Never rebuilds or writes production scenes/settings. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LlmCallRequest, LlmProvider } from '../src/types';
import { callLLM } from '../src/services/llmService';
import { proxyLlmRequest } from '../src/electron/apiHandlers';
import { S2ValidationStop } from './scene-s2-agent-validation';
import { prepareS2HostResultSource, runS2HostResultValidation } from './scene-s2-host-result-validation';

const args = process.argv.slice(2);
const maxCalls = 24, maxOutputTokens = 48000, maxNewCalls = 5;
if (!args.length) {
  console.log('Dry run: --execute --run-id UNIQUE_ID --continue-after FRESH_BUSINESS_CHAIN_ROOT --host-result-only. Reuses only the accepted synthetic definition, confirmed canvas, six accepted user turns and genuine failed host-result request. A new local host reruns the previously confirmed local target; only host understanding/action and one independent evidence review call the current scene model. Normally 3 calls; at most 5 including existing production repairs. Continues the original 24 calls / 48000 reserved-output-token approval, never resets it. Production cap1536, one judge cap2048; no automatic transport or judge-format retry. Not fresh build, resumed UI, whole-chain or browser acceptance. Explicit current-run authorization required.');
} else {
  assert.equal(args.length, 6); assert.equal(args[0], '--execute'); assert.equal(args[1], '--run-id');
  assert.equal(args[3], '--continue-after'); assert.equal(args[5], '--host-result-only');
  const runId = args[2], sourceRunId = args[4], safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
  assert(safeId.test(runId) && safeId.test(sourceRunId) && runId !== sourceRunId);
  const root = path.resolve('.ui-preview', 's2-agent-live'), output = path.join(root, runId), sourceRoot = path.join(root, sourceRunId);
  const anchor = JSON.parse(await fs.readFile(path.join(os.homedir(), '.logi-note', 'storage-config.json'), 'utf8'));
  const settings = JSON.parse(await fs.readFile(path.join(anchor.dataRoot, 'user-state', 'llm.json'), 'utf8')).settings;
  const selectedId = settings.workflowBinding['scene-general-turn'] || settings.defaultProviderId;
  const selected = settings.providers.find((item: LlmProvider) => item.id === selectedId && item.enabled);
  assert(selected?.apiType === 'openai-compatible' && selected.apiKey?.trim(), 'Current scene provider unavailable');
  const provider: LlmProvider = structuredClone(selected), base = new URL(provider.baseUrl);
  assert.equal(base.protocol, 'https:'); assert(!base.username && !base.password && !base.search && !base.hash);
  const endpoint = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const metadata = { id: provider.id, model: provider.selectedModel, origin: base.origin };
  const sourceArtifacts: Record<string, { sha256: string; chars: number }> = {};
  const readSource = async (name: string) => {
    const contents = await fs.readFile(path.join(sourceRoot, name), 'utf8');
    assert(contents.length <= 262144, 'Source artifact exceeds bounded synthetic input');
    sourceArtifacts[name] = { sha256: createHash('sha256').update(contents).digest('hex'), chars: contents.length };
    return JSON.parse(contents);
  };
  const manifest = await readSource('manifest.json'), previous = await readSource('report.json');
  assert.equal(manifest.kind, 's2-real-agent-validation'); assert.equal(manifest.profile, 'business-chain');
  assert.equal(previous.profile, 'business-chain'); assert.equal(previous.caseId, 'business-chain');
  assert.equal(manifest.syntheticOnly, true); assert.equal(manifest.productionWrites, 0); assert.equal(previous.productionWrites, 0);
  assert.deepEqual(manifest.provider, metadata); assert.deepEqual(previous.provider, metadata); assert.equal(previous.execution, 'real-provider');
  assert.deepEqual(manifest.approval, { maxCalls, reservedOutputTokens: maxOutputTokens });
  assert.deepEqual(manifest.prior, { calls: 0, outputTokensReserved: 0 });
  assert.equal(manifest.resumedSameApprovalPaidPrefix, false); assert.equal(manifest.replayPrefix, undefined);
  assert.equal(manifest.approvalLedgerRoot, undefined); assert.equal(manifest.approvalTransition, undefined);
  assert.equal(manifest.unacceptedModelDraftSource, undefined); assert.equal(manifest.scopeReviewSource, undefined);
  assert.equal(manifest.businessGoalClosureTested, true); assert.equal(previous.businessGoalClosureTested, true);
  assert.equal(previous.buildAccepted, true); assert.equal(previous.passed, false); assert.equal(previous.stopped, 'ui-chain-stage-failed');
  assert(Array.isArray(previous.steps) && previous.steps.length === 6 && previous.steps.every((step: { origin?: string }) => step.origin === 'user'));
  const prior = previous.approvalUsage as { calls: number; outputTokensReserved: number };
  // This one-shot diagnostic is deliberately restricted to the genuine 19-request failed root, not arbitrary resumable profiles.
  assert(prior && prior.calls === 19 && Number.isSafeInteger(prior.outputTokensReserved) && prior.outputTokensReserved >= 0 && prior.outputTokensReserved < maxOutputTokens);
  const requests: LlmCallRequest[] = await Promise.all(Array.from({ length: 19 }, (_, index) => readSource(`request-${index + 1}.json`)));
  let reserved = 0;
  for (const request of requests) {
    assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
    assert(Number.isSafeInteger(request.maxTokensOverride) && request.maxTokensOverride! >= 256 && request.maxTokensOverride! <= 6144);
    assert.equal(typeof request.userInput, 'string'); assert(request.userInput.length < 120000); JSON.parse(request.userInput);
    reserved += request.maxTokensOverride!;
  }
  assert.equal(reserved, prior.outputTokensReserved, 'The immutable paid requests must exactly account for the inherited reservation');
  const audit = previous.dispatchAudit;
  assert(audit && ['ipc', 'http'].every(kind => Number.isSafeInteger(audit[kind]?.calls) && audit[kind].calls >= 0 && audit[kind].calls <= prior.calls
    && Number.isSafeInteger(audit[kind]?.tokens) && audit[kind].tokens >= 0 && audit[kind].tokens <= prior.outputTokensReserved));
  assert.equal(Math.max(audit.ipc.calls, audit.http.calls), prior.calls);
  assert.equal(Math.max(audit.ipc.tokens, audit.http.tokens), prior.outputTokensReserved);
  const failedHostRequests = requests.slice(-2).map(request => JSON.parse(request.userInput));
  assert(failedHostRequests.every(input => input.stage === 'turn-understand' && input.origin === 'host-event'
    && input.hostEvent?.kind === 'workflow-completed' && input.triggeredExecution?.available === true
    && input.hostEvent.workflowRunId === input.triggeredExecution.workflowRunId));
  assert(failedHostRequests[1].memoryRepair && typeof failedHostRequests[1].memoryRepair.error === 'string');
  const definition = await readSource('definition.json'), editConfirmed = await readSource('ui-edit-confirmed.json');
  assert.deepEqual(previous.definition, definition);
  const source = prepareS2HostResultSource({ report: previous, definition, editConfirmed, requests });
  try {
    await fs.readFile(path.join(sourceRoot, 'continued-by.json'), 'utf8'); assert.fail('The source approval endpoint is already claimed');
  } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }

  // All provenance, schema, restoration and unclaimed-ledger checks precede directory creation and the atomic single-use claim.
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(output);
  await fs.writeFile(path.join(sourceRoot, 'continued-by.json'), JSON.stringify({ runId, transition: 'same-approval', scope: 'host-result-only' }), { flag: 'wx' });
  const save = async (name: string, value: unknown) => {
    assert(/^[A-Za-z0-9_-]+$/.test(name));
    const contents = JSON.stringify(value, null, 2); assert(!contents.includes(provider.apiKey!), 'SECRET_ECHO_REJECTED');
    await fs.writeFile(path.join(output, `${name}.json`), contents, { flag: 'wx' });
  };
  await save('manifest', { kind: 's2-real-agent-host-result-validation', profile: 'host-result-only', provider: metadata,
    syntheticOnly: true, productionWrites: 0, sourceRunId, sourceArtifacts, sourceScope: 'fresh-business-chain-failed-host-result',
    prior, approval: { maxCalls, reservedOutputTokens: maxOutputTokens }, maxNewCalls,
    independentReviewReservation: { calls: 1, tokens: 2048 }, productionOutputCap: 1536, judgeOutputCap: 2048,
    newApproval: false, builderTested: false, wholeChainTested: false, browserTested: false,
    actualHostRerunRequired: true, historicalExecutionIdsAreNotCurrentEvidence: true });
  const counters = { ipc: { calls: 0, tokens: 0 }, http: { calls: 0, tokens: 0 } };
  const usage = () => ({ calls: prior.calls + Math.max(counters.ipc.calls, counters.http.calls),
    outputTokensReserved: prior.outputTokensReserved + Math.max(counters.ipc.tokens, counters.http.tokens) });
  let inJudge = false, stoppedTransport = false, index = 0, judgeCalls = 0, inFlight = false;
  let dispatchedKinds = { ipc: false, http: false };
  const reserve = async (kind: 'ipc' | 'http', tokens: number) => {
    assert(inFlight && !dispatchedKinds[kind], 'NO_TRANSPORT_RETRY');
    const count = counters[kind], heldCalls = inJudge ? 0 : 1;
    assert(Number.isSafeInteger(tokens) && tokens >= 256 && tokens <= (inJudge ? 2048 : 1536), 'INVALID_OUTPUT_LIMIT');
    if (count.calls + 1 > maxNewCalls - heldCalls || prior.calls + count.calls + 1 > maxCalls - heldCalls
      || prior.outputTokensReserved + count.tokens + tokens > maxOutputTokens - heldCalls * 2048) throw new S2ValidationStop('approval-budget-exhausted');
    dispatchedKinds[kind] = true; count.calls++; count.tokens += tokens;
    await fs.appendFile(path.join(output, 'dispatch.jsonl'), JSON.stringify({ kind, tokens, usage: usage(), at: new Date().toISOString() }) + '\n');
  };
  const cache = new Map([['loginote_llm_settings', JSON.stringify({ ...settings, providers: [provider] })]]);
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) } });
  const actualFetch = globalThis.fetch, controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), 600000); let activeSignal: AbortSignal | undefined;
  globalThis.fetch = async (input, init) => {
    assert(!stoppedTransport, 'NO_TRANSPORT_RETRY'); assert.equal(input instanceof Request ? input.url : String(input), endpoint);
    assert.equal(init?.method, 'POST'); assert.equal(typeof init?.body, 'string');
    await reserve('http', JSON.parse(init!.body as string).max_tokens);
    try { const response = await actualFetch(input, { ...init, redirect: 'error' }); if (!response.ok) stoppedTransport = true; return response; }
    catch { stoppedTransport = true; throw new Error('S2_PROVIDER_TRANSPORT_FAILED'); }
  };
  Object.assign(globalThis, { window: { electronAPI: { llm: { request: async (request: Parameters<typeof proxyLlmRequest>[0]) => {
    assert(!stoppedTransport, 'NO_TRANSPORT_RETRY');
    assert.equal(request.provider.baseUrl, provider.baseUrl); assert.equal(request.provider.selectedModel, provider.selectedModel); assert.equal(request.provider.apiKey, provider.apiKey);
    assert(!request.tools?.length && !request.images?.length && !request.agentMessages?.length);
    await reserve('ipc', request.maxTokens); return proxyLlmRequest(request, activeSignal);
  }, cancel() {} } } } });
  const invoke = async (request: LlmCallRequest) => {
    assert(!stoppedTransport && !controller.signal.aborted && !inFlight, 'S2_STOPPED_OR_CONCURRENT_DISPATCH');
    assert(request.skipMemoryInjection && request.skipProfileInjection && request.workflow === 'agent-scene-setup');
    assert(JSON.stringify(request).length < 120000, 'SYNTHETIC_CONTEXT_TOO_LARGE');
    const input = JSON.parse(request.userInput);
    inJudge = input.phase === 's2-host-result-independent-review';
    assert(inJudge || ['turn-understand', 'turn-act'].includes(input.stage) && input.origin === 'host-event', 'HOST_RESULT_SCOPE_ONLY');
    assert(!inJudge || judgeCalls === 0, 'NO_JUDGE_FORMAT_RETRY');
    const heldCalls = inJudge ? 0 : 1, tokens = Math.min(request.maxTokensOverride ?? (inJudge ? 2048 : 1536), inJudge ? 2048 : 1536);
    assert(Number.isSafeInteger(tokens) && tokens >= 256, 'INVALID_OUTPUT_LIMIT');
    const current = usage();
    if (index + 1 > maxNewCalls - heldCalls || current.calls + 1 > maxCalls - heldCalls
      || current.outputTokensReserved + tokens > maxOutputTokens - heldCalls * 2048) throw new S2ValidationStop('approval-budget-exhausted');
    if (inJudge) judgeCalls++;
    const callIndex = ++index, effectiveRequest = { ...request, maxTokensOverride: tokens }, requestController = new AbortController();
    const stop = () => requestController.abort(); controller.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 60000); activeSignal = requestController.signal; inFlight = true; dispatchedKinds = { ipc: false, http: false };
    try {
      await save(`request-${callIndex}`, effectiveRequest);
      const response = await callLLM({ ...effectiveRequest, providerId: provider.id, model: provider.selectedModel, context: undefined, thinkingMode: 'disabled' },
        { providerSnapshot: provider, signal: activeSignal });
      await save(`response-${callIndex}`, response); return response;
    } catch (error) {
      if (error instanceof S2ValidationStop) throw error;
      stoppedTransport = true;
      throw new S2ValidationStop(controller.signal.aborted ? 'cancelled' : requestController.signal.aborted ? 'request-timeout' : 'transport-failed');
    } finally { inFlight = false; clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
  };
  let report: Record<string, unknown>;
  try {
    try { report = await runS2HostResultValidation({ source, invoke, signal: controller.signal, onArtifact: save }); }
    catch (error) { report = { hostResultSubsetPassed: false, stopped: error instanceof S2ValidationStop ? error.code : 'host-result-validation-failed' }; }
    const savedReport = { ...report, hostResultSubsetPassed: report.hostResultSubsetPassed === true,
      kind: 's2-host-result-subset', profile: 'host-result-only', passed: false, buildAccepted: false,
      wholeChainTested: false, browserTested: false, syntheticOnly: true, productionWrites: 0, sourceRunId, sourceArtifacts,
      provider: metadata, execution: 'real-provider', approval: { maxCalls, reservedOutputTokens: maxOutputTokens },
      prior, approvalUsage: usage(), newCallsAttempted: index, independentReviewCalls: judgeCalls, dispatchAudit: counters, automaticTransportRetries: 0 };
    await save('report', savedReport);
    console.log(JSON.stringify({ reportPath: path.join(output, 'report.json'), hostResultSubsetPassed: savedReport.hostResultSubsetPassed,
      wholeChainTested: false, approvalUsage: usage(), sourceRunId }));
    if (savedReport.hostResultSubsetPassed !== true) process.exitCode = 2;
  } finally { clearTimeout(overallTimer); globalThis.fetch = actualFetch; }
}
