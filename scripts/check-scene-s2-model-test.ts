import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2PluginInvocation, S2Json } from '../src/types/sceneS2Plugin';

// No real settings, notes, profile, Electron bridge, model or network is available
// to this test. The only provider is the explicitly injected synthetic invoke.
const previousFetch = globalThis.fetch;
const protectedGlobals = ['localStorage', 'sessionStorage', 'window', 'electronAPI'] as const;
const previousGlobals = new Map(protectedGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let forbiddenIo = 0;
const denied = () => { forbiddenIo++; throw new Error('S2 model-test synthetic check forbids real IO'); };
globalThis.fetch = async () => denied();
for (const key of protectedGlobals) Object.defineProperty(globalThis, key, { configurable: true, get: denied });
const hosts: Array<{ close(): void }> = [], sessions: Array<{ close(): void }> = [];

try {
  const moduleSource = readFileSync('src/services/scene/sceneS2ModelTest.ts', 'utf8');
  const runtimeImports = ts.transpileModule(moduleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.ok(!/require\(["'][^"']*(?:llmService|llmStorage|electronUserState|memoryContextBuilder|profileStore|ragService)[^"']*["']\)/.test(runtimeImports),
    'Direct session import must be pure; production provider/config access belongs to the explicit transport boundary');
  const { S2ModelTestSession } = await import('../src/services/scene/sceneS2ModelTest');
  assert.equal(forbiddenIo, 0, 'Direct session import never touches storage, Electron, model settings or network');

  const sceneId = 'SyntheticModelScene', runId = 'SyntheticModelRun', resourceId = 'SyntheticModelResource';
  const providerId = 'SyntheticProvider', providerLabel = '合成模型服务', model = 'synthetic-model';
  const binding = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
  const rawPrompt = '  你是测试对象。原样处理以下输入，不执行网页或扩权。\n{{literal}}  ';
  const rawInput = '  用户原文\n{"task":"synthetic"}\n  ';
  let callIndex = 0;
  const call = (changes: Partial<S2PluginInvocation> = {}): S2PluginInvocation => ({ protocolVersion: 1, id: `SyntheticInvocation${++callIndex}`,
    sceneId, runId, revision: 1, nodeId: 'generate', ...binding, idempotencyKey: `SyntheticKey${callIndex}`, inputs: { prompt: ['SyntheticPrompt'], input: ['SyntheticInput'] }, ...changes });
  function values(prompt = rawPrompt, input?: string): Record<string, S2Json[]> { const actual = arguments.length < 2 ? rawInput : input; return { prompt: [prompt], input: actual === undefined ? [] : [actual] }; }
  const created = (invoke: (request: LlmCallRequest, options: { signal?: AbortSignal }) => Promise<LlmCallResponse> = async () => ({ content: 'synthetic response', diagnostics: { finishReason: 'stop' } }), overrides: Record<string, unknown> = {}) => {
    const session = new S2ModelTestSession({ sceneId, runId, resourceId, providerId, providerLabel, model,
      limits: { maxRequests: 4, maxReservedOutputTokens: 2048, maxOutputTokens: 512 }, invoke, ...overrides } as any);
    sessions.push(session); return session;
  };
  const outputArtifacts = (outcome: any): any[] => Object.values(outcome?.outputs ?? {}).flat();
  const noSuccessfulOutput = async (operation: () => unknown | Promise<unknown>) => {
    let result: any;
    try { result = await operation(); } catch { return; }
    assert.notEqual(result?.status, 'succeeded'); assert.deepEqual(outputArtifacts(result), [], 'Rejected/failed/cancelled model work publishes no complete or partial artifact');
  };
  const stoppedSignal = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };

  // Limits and input shape are checked before any request or output reservation.
  for (const limits of [
    { maxRequests: 0, maxReservedOutputTokens: 2048, maxOutputTokens: 512 },
    { maxRequests: 25, maxReservedOutputTokens: 2048, maxOutputTokens: 512 },
    { maxRequests: 1.5, maxReservedOutputTokens: 2048, maxOutputTokens: 512 },
    { maxRequests: 1, maxReservedOutputTokens: 255, maxOutputTokens: 256 },
    { maxRequests: 1, maxReservedOutputTokens: 48001, maxOutputTokens: 512 },
    { maxRequests: 1, maxReservedOutputTokens: 2048, maxOutputTokens: 255 },
    { maxRequests: 1, maxReservedOutputTokens: 48000, maxOutputTokens: 2049 },
  ]) assert.throws(() => created(undefined, { limits }));
  let previewDispatches = 0;
  const preview = created(async () => { previewDispatches++; return { content: 'never sent by preview' }; });
  const previewInitial = preview.summary();
  preview.preview(rawPrompt, rawInput); preview.preview(rawPrompt); preview.preview(rawPrompt, '');
  for (const prompt of ['', '   ', 'x'.repeat(6001)]) assert.throws(() => preview.preview(prompt, rawInput));
  for (const input of [null, {}, 'x'.repeat(6001)]) assert.throws(() => preview.preview(rawPrompt, input as any));
  assert.deepEqual(preview.summary(), previewInitial); assert.equal(previewDispatches, 0);
  for (const invalid of [
    { prompt: [], input: [] }, { prompt: [rawPrompt, 'extra'], input: [] }, { prompt: [123], input: [] },
    { prompt: [rawPrompt], input: [undefined] }, { prompt: [rawPrompt], input: [null] }, { prompt: [rawPrompt], input: ['a', 'b'] },
  ]) await noSuccessfulOutput(() => preview.execute(call(), invalid as any, new AbortController().signal));
  for (const changes of [{ sceneId: 'ForeignScene' }, { runId: 'ForeignRun' }, { pluginId: 'uninstalled' }, { pluginVersion: '9.0.0' }, { capabilityId: 'invented' }])
    await noSuccessfulOutput(() => preview.execute(call(changes), values(), new AbortController().signal));
  await noSuccessfulOutput(() => preview.execute(call(), values(), stoppedSignal()));
  assert.equal(preview.summary().usedRequests, 0); assert.equal(preview.summary().reservedOutputTokens, 0); assert.equal(previewDispatches, 0);

  // The session sends precisely the confirmed prompt/input, with no hidden RAG,
  // memory/profile injection, tools, conversation or user-selected workflow.
  const captured: LlmCallRequest[] = [];
  const exact = created(async (request, options) => {
    assert.ok(options.signal instanceof AbortSignal); captured.push(structuredClone(request));
    return { content: '  合成返回原文\n', usage: { promptTokens: 31, completionTokens: 9 }, diagnostics: { finishReason: 'stop' } };
  });
  const success = await exact.execute(call(), values(), new AbortController().signal);
  assert.equal(success.status, 'succeeded'); assert.equal(captured.length, 1);
  const sent = captured[0];
  assert.equal(sent.providerId, providerId); assert.equal(sent.model, model); assert.equal(sent.systemPromptOverride, rawPrompt); assert.equal(sent.userInput, rawInput);
  assert.equal(sent.maxTokensOverride, 512); assert.equal(sent.skipMemoryInjection, true); assert.equal(sent.skipProfileInjection, true);
  for (const key of ['context', 'agentMessages', 'messages', 'tools', 'images', 'outputSchema']) assert.equal((sent as any)[key], undefined, `No undeclared ${key} is attached`);
  assert.ok(typeof sent.workflow === 'string' && sent.workflow.length > 0);
  const artifact = outputArtifacts(success)[0]; assert.equal(outputArtifacts(success).length, 1);
  assert.equal(artifact.type.id, 'core.text'); assert.equal(artifact.payload.kind, 'inline'); assert.equal(artifact.payload.value, '  合成返回原文\n');
  assert.equal(artifact.source.sceneId, sceneId); assert.equal(artifact.source.runId, runId); assert.equal(artifact.source.nodeId, 'generate');
  assert.equal(exact.summary().usedRequests, 1); assert.equal(exact.summary().reservedOutputTokens, 512); assert.equal(exact.summary().records.length, 1);
  const mutableSummary: any = exact.summary(); mutableSummary.usedRequests = 0; mutableSummary.records.length = 0;
  assert.equal(exact.summary().usedRequests, 1); assert.equal(exact.summary().records.length, 1, 'Public ledger is a clone, not mutable authority');
  exact.close(); assert.equal(exact.summary().usedRequests, 1); assert.equal(exact.summary().reservedOutputTokens, 512);
  await noSuccessfulOutput(() => exact.execute(call(), values(), new AbortController().signal)); assert.equal(captured.length, 1, 'Closing does not rewind authorization or budget');

  // Optional input omitted/empty stays literal and is not a hidden request wrapper.
  const optionalRequests: LlmCallRequest[] = [];
  const optional = created(async request => { optionalRequests.push(structuredClone(request)); return { content: 'ok', diagnostics: { finishReason: 'stop' } }; });
  for (const input of [undefined, '']) assert.equal((await optional.execute(call({ inputs: { prompt: ['SyntheticPrompt'], ...(input === undefined ? {} : { input: ['SyntheticInput'] }) } }), values(rawPrompt, input), new AbortController().signal)).status, 'succeeded');
  assert.equal(optionalRequests.length, 2); assert.ok(optionalRequests.every(request => request.workflow === sent.workflow && request.systemPromptOverride === rawPrompt && request.userInput === ''));

  // Concurrent dispatch cannot overspend either request count or output pool.
  let release!: () => void, concurrentDispatches = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const concurrent = created(async () => { concurrentDispatches++; await gate; return { content: 'once', diagnostics: { finishReason: 'stop' } }; },
    { limits: { maxRequests: 1, maxReservedOutputTokens: 512, maxOutputTokens: 512 } });
  const pending = concurrent.execute(call(), values(), new AbortController().signal);
  for (let i = 0; i < 100 && !concurrentDispatches; i++) await Promise.resolve();
  assert.equal(concurrent.summary().usedRequests, 1); assert.equal(concurrent.summary().reservedOutputTokens, 512);
  await noSuccessfulOutput(() => concurrent.execute(call(), values(), new AbortController().signal)); release();
  assert.equal((await pending).status, 'succeeded'); assert.equal(concurrentDispatches, 1);
  let outputPoolDispatches = 0;
  const pool = created(async () => { outputPoolDispatches++; return { content: 'ok', diagnostics: { finishReason: 'stop' } }; }, { limits: { maxRequests: 3, maxReservedOutputTokens: 512, maxOutputTokens: 256 } });
  assert.equal((await pool.execute(call(), values(), new AbortController().signal)).status, 'succeeded');
  assert.equal((await pool.execute(call(), values(), new AbortController().signal)).status, 'succeeded');
  await noSuccessfulOutput(() => pool.execute(call(), values(), new AbortController().signal));
  assert.equal(outputPoolDispatches, 2); assert.equal(pool.summary().reservedOutputTokens, 512);

  // Truncation, invalid data and provider errors spend the reserved attempt but
  // never retry, repair, judge or publish a success/partial output.
  const failures: Array<() => Promise<LlmCallResponse>> = [
    async () => ({ content: 'uncertain', diagnostics: { finishReason: 'unrecognized' } }),
    async () => ({ content: 'no finish metadata' }),
    async () => ({ content: 'refusal', diagnostics: { finishReason: 'stop', refusal: 'synthetic refusal' } } as any),
    async () => ({ content: 'tool', diagnostics: { finishReason: 'stop' }, toolCalls: [{ id: 'synthetic-tool' }] } as any),
    async () => ({ content: 'partial', diagnostics: { finishReason: 'length' } }),
    async () => ({ content: 'partial', diagnostics: { finishReason: 'max_output_tokens' } }),
    async () => ({ content: 'x'.repeat(6001), diagnostics: { finishReason: 'stop' } }), async () => ({ content: '', diagnostics: { finishReason: 'stop' } }),
    async () => { throw new Error('synthetic provider failure'); },
  ];
  for (const failure of failures) {
    let dispatched = 0; const session = created(async () => { dispatched++; return failure(); });
    await noSuccessfulOutput(() => session.execute(call(), values(), new AbortController().signal));
    assert.equal(dispatched, 1); assert.equal(session.summary().usedRequests, 1); assert.equal(session.summary().reservedOutputTokens, 512);
    assert.equal(session.summary().records.length, 1);
  }
  let excessDispatches = 0;
  const excess = created(async () => { excessDispatches++; return { content: 'synthetic over-limit usage', usage: { promptTokens: 10, completionTokens: 513 }, diagnostics: { finishReason: 'stop' } }; });
  await noSuccessfulOutput(() => excess.execute(call(), values(), new AbortController().signal));
  assert.equal(excess.summary().active, false); assert.equal(excess.summary().records[0].usage?.completionTokens, 513);
  assert.equal(excess.summary().reservedOutputTokens, 512); assert.equal(excess.summary().records[0].status, 'failed');
  await noSuccessfulOutput(() => excess.execute(call(), values(), new AbortController().signal)); assert.equal(excessDispatches, 1);
  let memoDispatches = 0;
  const memo = created(async () => { memoDispatches++; return { content: 'exactly once', diagnostics: { finishReason: 'stop' } }; }), memoCall = call();
  const [memoFirst, memoSecond] = await Promise.all([memo.execute(memoCall, values(), new AbortController().signal), memo.execute(structuredClone(memoCall), values(), new AbortController().signal)]);
  assert.equal(memoDispatches, 1); assert.deepEqual(memoFirst, memoSecond);
  await noSuccessfulOutput(() => memo.execute(memoCall, values('changed prompt'), new AbortController().signal));
  await noSuccessfulOutput(() => memo.execute({ ...memoCall, idempotencyKey: 'ChangedKey' }, values(), new AbortController().signal));
  assert.equal(memoDispatches, 1); assert.equal(memo.summary().usedRequests, 1);
  const controller = new AbortController(); let abortDispatches = 0;
  const aborting = created(async (_request, options) => {
    abortDispatches++; controller.abort(); assert.equal(options.signal?.aborted, true); return { content: 'late synthetic output' };
  });
  await noSuccessfulOutput(() => aborting.execute(call(), values(), controller.signal));
  assert.equal(abortDispatches, 1); assert.equal(aborting.summary().usedRequests, 1);

  // Real Host integration, with a synthetic provider injected explicitly into a
  // fresh run grant. A model node always pauses after local upstream completion.
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const { s2BuiltinPluginRegistry, readS2PluginBindings } = await import('../src/services/scene/sceneS2PluginRegistry');
  const { readS2PluginRequest, validateS2Invocation } = await import('../src/services/scene/sceneS2PluginProtocol');
  const registry = s2BuiltinPluginRegistry(), capability = registry.capability(binding);
  assert.equal(capability.effect, 'external'); assert.deepEqual(capability.permissions, ['model-call']); assert.equal(capability.confirmation, 'per-call');
  assert.equal(capability.retry, 'manual-only'); assert.equal(capability.inputs.find(port => port.id === 'input')!.required, false);
  assert.deepEqual(capability.outputs.map(port => [port.id, port.type.id]), [['text', 'core.text']]);
  assert.equal(readS2PluginBindings([binding]).length, 1);
  const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
  const node = (id: string, pluginId: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, pluginId, pluginVersion: '1.0.0', capabilityId, position: { x: 100, y: 100 }, bindings });
  const plugins = [binding, { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' },
    { pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' }];
  const document: S2Document = { nodes: [{ id: 'prompt', type: 'text', position: { x: 0, y: 0 }, values: { content: rawPrompt } }], edges: [], execution: { version: 1, nodes: [
    node('compose', 'text-template', 'render', { template: literal('合成指令 {{role}}'), variables: literal({ role: '助教' }) }),
    node('generate', 'model-test', 'generate', { input: literal(rawInput) }),
    node('check', 'json-check', 'validate'), node('independent', 'json-check', 'validate', { text: literal('{}') }),
  ], links: [
    { source: { nodeId: 'compose', portId: 'text' }, target: { nodeId: 'generate', portId: 'prompt' } },
    { source: { nodeId: 'generate', portId: 'text' }, target: { nodeId: 'check', portId: 'text' } },
  ] } };
  const hostFor = (doc = document, approved = plugins) => { const host = new S2PluginHost(sceneId, approved); hosts.push(host); host.setDocument(doc); return host; };
  const attached = (host: InstanceType<typeof S2PluginHost>, invoke: (request: LlmCallRequest, options: { signal?: AbortSignal }) => Promise<LlmCallResponse> = async () => ({ content: '{"synthetic":true}', diagnostics: { finishReason: 'stop' } }), overrides: Record<string, unknown> = {}) => {
    const session = created(invoke, { runId: host.runId, ...overrides }); host.approveModelTestSession(session); return session;
  };
  const state = (run: any, id: string) => run.nodes.find((item: any) => item.nodeId === id);
  const waiting = async (host: InstanceType<typeof S2PluginHost>, id: string) => {
    for (let i = 0; i < 500; i++) { const run = host.workflowHistory().find(run => run.id === id)!; if (run.status === 'waiting') return run; if (['succeeded', 'failed', 'cancelled'].includes(run.status)) assert.fail(`Expected model confirmation wait: ${JSON.stringify(run)}`); await new Promise(resolve => setTimeout(resolve, 1)); }
    assert.fail('Synthetic host did not reach model confirmation wait');
  };
  const completed = async (job: { completion: Promise<any> }) => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([job.completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic model workflow deadline')), 2500); })]); }
    finally { clearTimeout(timer!); }
  };
  const unapproved = hostFor(); assert.throws(() => unapproved.enqueueWorkflow(['check']), /模型|授权|model/i); assert.equal(unapproved.history().length, 0);
  const wrongRun = created(); assert.throws(() => unapproved.approveModelTestSession(wrongRun), /运行|授权|run/i);
  const notInstalled = hostFor({ ...document, execution: undefined }, plugins.filter(item => item.pluginId !== 'model-test'));
  assert.throws(() => attached(notInstalled), /装配|授权|能力/);
  const wrongScene = hostFor(); assert.throws(() => attached(wrongScene, undefined, { sceneId: 'ForeignScene' }), /场景|授权|scene/i);

  let hostDispatches = 0; const hostRequests: LlmCallRequest[] = [];
  const host = hostFor(), hostSession = attached(host, async request => { hostDispatches++; hostRequests.push(structuredClone(request)); return { content: '{"synthetic":true}', diagnostics: { finishReason: 'stop' } }; });
  const job = host.enqueueWorkflow(['check', 'independent']), waitRun = await waiting(host, job.id);
  assert.equal(state(waitRun, 'compose').status, 'succeeded'); assert.equal(state(waitRun, 'independent').status, 'succeeded'); assert.equal(state(waitRun, 'check').status, 'pending');
  assert.equal(hostDispatches, 0); assert.equal(hostSession.summary().usedRequests, 0);
  const wait = host.waitingModelTests()[0]; assert.equal(wait.nodeId, 'generate'); assert.equal(wait.workflowId, job.id);
  assert.equal(wait.prompt, '合成指令 助教'); assert.equal(wait.input, rawInput); assert.equal(wait.model, model); assert.equal(wait.providerLabel, providerLabel); assert.equal(wait.maxOutputTokens, 512);
  const forged = structuredClone(wait); forged.prompt = 'not authority'; assert.equal(host.waitingModelTests()[0].prompt, '合成指令 助教');
  assert.throws(() => host.confirmModelTest('foreign-workflow', wait.id, true), /失效/); assert.throws(() => host.confirmModelTest(job.id, 'forged-wait', true), /失效/);
  assert.throws(() => host.confirmModelTest(job.id, wait.id, 'yes' as any), /明确|布尔|boolean/i);
  assert.equal(hostDispatches, 0);
  host.confirmModelTest(job.id, wait.id, true);
  assert.throws(() => host.confirmModelTest(job.id, wait.id, true), /失效|确认/);
  const done = await completed(job); assert.equal(done.status, 'succeeded'); assert.equal(state(done, 'generate').status, 'succeeded'); assert.equal(state(done, 'check').status, 'succeeded');
  assert.equal(hostDispatches, 1); assert.equal(hostRequests[0].systemPromptOverride, wait.prompt); assert.equal(hostRequests[0].userInput, rawInput);
  assert.equal(host.modelTestSummary()!.usedRequests, 1); assert.equal(host.modelTestSummary()!.reservedOutputTokens, 512);
  assert.equal(host.currentArtifact(state(done, 'generate').artifactIds[0]).payload.kind, 'inline');
  const before = host.history().length, rerun = host.enqueueWorkflow(['check']); await waiting(host, rerun.id);
  assert.equal(hostDispatches, 1); host.confirmModelTest(rerun.id, host.waitingModelTests()[0].id, true); await completed(rerun);
  assert.equal(hostDispatches, 2); assert.ok(host.history().length > before, 'Model results are not pure-cache hits; every run requires another explicit confirmation and budget');

  // Rejection cancels only the model branch and does not debit model allowance.
  const rejectedHost = hostFor(), rejectedSession = attached(rejectedHost), rejectedJob = rejectedHost.enqueueWorkflow(['check', 'independent']);
  await waiting(rejectedHost, rejectedJob.id); const rejectedWait = rejectedHost.waitingModelTests()[0];
  rejectedHost.confirmModelTest(rejectedJob.id, rejectedWait.id, false); const rejectedRun = await completed(rejectedJob);
  assert.notEqual(state(rejectedRun, 'generate').status, 'succeeded'); assert.equal(state(rejectedRun, 'generate').artifactIds.length, 0);
  assert.equal(state(rejectedRun, 'independent').status, 'succeeded'); assert.equal(rejectedSession.summary().usedRequests, 0); assert.equal(rejectedSession.summary().reservedOutputTokens, 0);

  // Layout leaves the exact pending confirmation valid. Semantic change/undo,
  // explicit cancellation and close retire the wait without spending or replay.
  const layoutHost = hostFor(), layoutSession = attached(layoutHost), layoutJob = layoutHost.enqueueWorkflow(['check']); await waiting(layoutHost, layoutJob.id);
  const layoutWait = layoutHost.waitingModelTests()[0], layout = structuredClone(document); layout.nodes[0].position.x += 25; layout.execution!.nodes[0].position.y += 40;
  layoutHost.setDocument(layout); assert.equal(layoutHost.waitingModelTests()[0].id, layoutWait.id);
  layoutHost.confirmModelTest(layoutJob.id, layoutWait.id, true); assert.equal((await completed(layoutJob)).status, 'succeeded'); assert.equal(layoutSession.summary().usedRequests, 1);
  for (const action of ['semantic', 'cancel', 'close']) {
    const h = hostFor(), session = attached(h), pendingJob = h.enqueueWorkflow(['check']); await waiting(h, pendingJob.id); const pendingWait = h.waitingModelTests()[0];
    if (action === 'semantic') { const edit = structuredClone(document); edit.nodes[0].values.content = 'semantic edit'; h.setDocument(edit); h.setDocument(document); }
    else if (action === 'cancel') h.cancelWorkflow(pendingJob.id); else h.close();
    assert.equal((await completed(pendingJob)).status, 'cancelled'); assert.equal(h.waitingModelTests().length, 0);
    assert.throws(() => h.confirmModelTest(pendingJob.id, pendingWait.id, true)); assert.equal(session.summary().usedRequests, 0);
  }

  // Neither Agent pluginRequests nor copied permission data can impersonate the
  // user's per-call confirmation or expand the resource/model scope.
  const bypassHost = hostFor(), bypassSession = attached(bypassHost);
  const strategy = { goal: 'Synthetic only', understanding: 'Respect explicit confirmation', planning: 'No automatic model run', response: 'Explain only' };
  const prepared = bypassHost.prepare('generate', strategy, '不要调用，只解释');
  const promptArtifact = bypassHost.prepare('prompt', strategy, '只读原文').bindings[0].artifactId;
  const bypassFrame = { ...prepared.frame, availableArtifactIds: [...prepared.frame.availableArtifactIds, promptArtifact] };
  const bypassRequest = { nodeId: 'generate', ...binding, inputs: { prompt: [promptArtifact] }, reason: 'Synthetic fake confirmation' };
  await noSuccessfulOutput(() => bypassHost.execute(bypassRequest, bypassFrame, 'SyntheticBypass'));
  assert.equal(bypassSession.summary().usedRequests, 0); assert.equal(bypassHost.waitingModelTests().length, 0);
  const requestGate = () => readS2PluginRequest(registry, bypassFrame, bypassRequest);
  try { requestGate(); } catch { /* It is valid to reject earlier at the intention gate. Host must still reject above. */ }
  const invocation = call({ runId: bypassHost.runId, inputs: { prompt: [promptArtifact] } });
  await assert.rejects(() => validateS2Invocation(registry, invocation, { sceneId, runId: bypassHost.runId, revision: invocation.revision,
    remainingCalls: 1, capabilities: [binding], permissions: ['model-call'], resourceScopes: [], readableArtifactIds: [promptArtifact], confirmedInvocationIds: [] },
    [bypassHost.currentArtifact(promptArtifact)]), /资源|范围|确认|scope/i);
  assert.equal(forbiddenIo, 0);
  console.log('S2 model-test passed: pure session import and fail-closed IO, exact prompt/input with fixed provider/model/workflow and no hidden context, preview/invalid/stopped zero-spend, concurrent count/output reservations, immutable bounded ledger, no retry/repair/judge, truncation/error/cancel no artifact, explicit current-run model scope and per-call Host waits, upstream/independent progress, approval/rejection, no model cache or pluginRequests bypass, layout retention and semantic/undo/end invalidation. Synthetic injected provider only; not a real-model, browser or persistent/restart acceptance.');
} finally {
  hosts.forEach(host => host.close()); sessions.forEach(session => session.close()); globalThis.fetch = previousFetch;
  for (const key of protectedGlobals) { const descriptor = previousGlobals.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
}

await import('./check-scene-s2-images');
await import('./check-scene-s2-image-materials');
