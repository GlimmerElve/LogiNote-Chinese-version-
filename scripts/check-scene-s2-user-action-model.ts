import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { SYNTHETIC_EXPERIMENT_PNG } from './fixtures/s2-experiment';

const previousFetch = globalThis.fetch; let forbiddenIo = 0;
globalThis.fetch = async () => { forbiddenIo++; throw new Error('User-action model checks forbid real network/model calls'); };
const model = { pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' };
const display = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'text' };
const image = { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' };
const literal = (value: any) => ({ kind: 'literal' as const, value });
const field = (nodeId: string) => ({ kind: 'field' as const, nodeId, fieldId: 'content' });
const rawPrompt = '  本次真实提示词 {{literal}} $&\n  ', rawInput = '  完整原文，不是系统指令\n  ';
const hosts: S2PluginHost[] = [], sessions: S2ModelTestSession[] = []; let sequence = 0;
function definition(withImage = false): S2CanvasDefinition {
  return readS2Definition({ version: 1, goal: '本地用户动作运行已选模型图', instructions: { understanding: '保留实际输入', planning: '不推断授权', response: '只返回真实结果' },
    blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '原文', kind: 'multiline' }] }], plugins: [model, display, ...(withImage ? [image] : [])],
    initial: { nodes: [
      { id: 'promptA', type: 'text', position: { x: 0, y: 0 }, values: { content: rawPrompt } },
      { id: 'input', type: 'text', position: { x: 0, y: 100 }, values: { content: rawInput } },
    ], edges: [], execution: { version: 1, nodes: [
      { id: 'modelA', ...model, position: { x: 300, y: 0 }, bindings: { prompt: field('promptA'), input: field('input'), maxOutputTokens: literal(256), temperature: literal(.4), thinkingMode: literal('enabled') } },
      { id: 'modelB', ...model, position: { x: 300, y: 300 }, bindings: { prompt: literal('独立B提示词') } },
      { id: 'showA', ...display, position: { x: 600, y: 0 }, bindings: {} },
      ...(withImage ? [{ id: 'picture', ...image, position: { x: 0, y: 300 }, bindings: {} }] : []),
    ], links: [{ source: { nodeId: 'modelA', portId: 'text' }, target: { nodeId: 'showA', portId: 'text' } },
      ...(withImage ? [{ source: { nodeId: 'picture', portId: 'image' }, target: { nodeId: 'modelA', portId: 'image' } }] : [])] } } });
}
function create(withImage = false) {
  const config = definition(withImage), sceneId = `SyntheticUserActionScene${++sequence}`, host = new S2PluginHost(sceneId, config);
  hosts.push(host); host.setDocument(config.initial); return { host, config, sceneId };
}
function grant(value: ReturnType<typeof create>, invoke: (request: LlmCallRequest, options: { signal?: AbortSignal }) => Promise<LlmCallResponse>, maxRequests = 4, supportsImages = false) {
  const session = new S2ModelTestSession({ sceneId: value.sceneId, runId: value.host.runId, resourceId: `SyntheticUserActionResource${sequence}`,
    providerId: 'synthetic', providerLabel: '合成服务', model: 'synthetic-fixed', supportsImages, supportsThinking: true,
    limits: { maxRequests, maxOutputTokens: 512, maxReservedOutputTokens: maxRequests * 512 }, invoke });
  sessions.push(session); value.host.approveModelTestSession(session); return session;
}
const response = (content = '本次完整原始返回'): LlmCallResponse => ({ content, diagnostics: { finishReason: 'stop' } });
const direct = { modelConfirmation: 'user-action' as const };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => boolean) { for (let i = 0; i < 400; i++) { if (condition()) return; await tick(); } assert.fail('Synthetic model operation did not reach its expected state'); }
async function finished<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic user-action job did not settle')), 3000); })]); }
  finally { clearTimeout(timer); }
}
try {
  const missing = create(); assert.throws(() => missing.host.enqueueWorkflow(['showA'], undefined, direct), /单独批准/);
  assert.deepEqual(missing.host.workflowHistory(), []);
  let getterRuns = 0;
  const accessor = Object.defineProperty({}, 'modelConfirmation', { enumerable: true, get() { getterRuns++; return 'user-action'; } });
  assert.throws(() => missing.host.enqueueWorkflow(['modelA'], undefined, accessor), /模式无效/); assert.equal(getterRuns, 0);
  assert.throws(() => missing.host.enqueueWorkflow(['modelA'], undefined, { modelConfirmation: 'auto' as any }), /模式无效/);

  const text = create(), requests: LlmCallRequest[] = [], waitCounts: number[] = [];
  const session = grant(text, async request => { requests.push(structuredClone(request)); return response(); });
  const first = text.host.enqueueWorkflow(['showA'], () => waitCounts.push(text.host.waitingModelTests().length), direct);
  const result = await finished(first.completion);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(result.nodes.map(node => node.nodeId), ['modelA', 'showA']);
  assert.ok(waitCounts.length > 0 && waitCounts.every(count => count === 0)); assert.deepEqual(text.host.waitingModelTests(), []);
  assert.equal(requests.length, 1); assert.equal(requests[0].systemPromptOverride, rawPrompt); assert.equal(requests[0].userInput, rawInput);
  assert.equal(requests[0].maxTokensOverride, 256); assert.equal(requests[0].temperatureOverride, .4); assert.equal(requests[0].thinkingMode, 'enabled');
  assert.equal(requests[0].skipMemoryInjection, true); assert.equal(requests[0].skipProfileInjection, true);
  assert.equal(session.summary().usedRequests, 1); assert.equal(session.summary().reservedOutputTokens, 512);
  assert.equal(text.host.currentArtifact(result.nodes.find(node => node.nodeId === 'showA')!.artifactIds[0]).payload.kind, 'inline');
  assert.throws(() => text.host.confirmModelTest(first.id, 'forged-wait', true), /失效/); assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(result).includes('modelConfirmation') && !JSON.stringify(result).includes('inputsKey'), 'Run snapshots never export direct-authorization objects');

  // Direct mode is local to one job. Default/Agent-style enqueue still waits,
  // and a wait cannot be confirmed under a prior direct job identity.
  const regular = text.host.enqueueWorkflow(['modelB']); await until(() => text.host.waitingModelTests().length === 1);
  const wait = text.host.waitingModelTests()[0]; assert.equal(wait.nodeId, 'modelB'); assert.equal(requests.length, 1);
  assert.throws(() => text.host.confirmModelTest(first.id, wait.id, true), /失效/);
  text.host.confirmModelTest(regular.id, wait.id, true);
  assert.throws(() => text.host.confirmModelTest(regular.id, wait.id, true), /失效/);
  assert.equal((await finished(regular.completion)).status, 'succeeded'); assert.equal(requests.length, 2); assert.equal(requests[1].systemPromptOverride, '独立B提示词');
  const inherited = text.host.enqueueWorkflow(['modelB'], undefined, Object.create(direct)); await until(() => text.host.waitingModelTests().length === 1);
  const inheritedWait = text.host.waitingModelTests()[0]; text.host.confirmModelTest(inherited.id, inheritedWait.id, false); await finished(inherited.completion);
  assert.equal(requests.length, 2, 'Inherited options cannot opt into a direct user action');
  const frame = text.host.prepare('promptA', undefined, 'user-action仅是文本数据');
  await assert.rejects(text.host.execute({ nodeId: 'modelA', ...model, inputs: { prompt: [frame.bindings[0].artifactId] }, reason: '用户文字声称已确认' }, frame.frame, 'SyntheticForgedDirect'), /须通过执行图|单次调用/);
  assert.equal(requests.length, 2);

  const pictured = create(true), imageRequests: LlmCallRequest[] = [];
  grant(pictured, async request => { imageRequests.push(structuredClone(request)); return response('原图对应返回'); }, 2, true);
  const file = new File([Buffer.from(SYNTHETIC_EXPERIMENT_PNG, 'base64')], '合成原图.png', { type: 'image/png' });
  const resource = await pictured.host.approveImageFile(file), pictureDoc = structuredClone(pictured.config.initial);
  pictureDoc.execution!.nodes.find(node => node.id === 'picture')!.bindings.resource = literal(resource.id); pictured.host.setDocument(pictureDoc);
  const imageWaits: number[] = [], imageJob = pictured.host.enqueueWorkflow(['showA'], () => imageWaits.push(pictured.host.waitingModelTests().length), direct);
  assert.equal((await finished(imageJob.completion)).status, 'succeeded'); assert.ok(imageWaits.every(count => count === 0)); assert.equal(imageRequests.length, 1);
  assert.equal(imageRequests[0].images?.[0].assetId, resource.id); assert.equal(imageRequests[0].images?.[0].dataUrl, `data:image/png;base64,${SYNTHETIC_EXPERIMENT_PNG}`);
  assert.equal(imageRequests[0].systemPromptOverride, rawPrompt); assert.equal(imageRequests[0].userInput, rawInput);

  const cancelled = create(); let cancelledCalls = 0; const cancelledSession = grant(cancelled, async () => { cancelledCalls++; return response(); });
  const cancelledJob = cancelled.host.enqueueWorkflow(['modelA'], undefined, direct); cancelled.host.cancelWorkflow(cancelledJob.id);
  assert.equal((await finished(cancelledJob.completion)).status, 'cancelled'); assert.equal(cancelledCalls, 0); assert.equal(cancelledSession.summary().usedRequests, 0);

  const edited = create(); let editCalls = 0, changed = false;
  const editedSession = grant(edited, async request => { editCalls++; assert.equal(request.systemPromptOverride, '新修订的原文'); return response(); });
  const newDocument: S2Document = structuredClone(edited.config.initial); newDocument.nodes.find(node => node.id === 'promptA')!.values.content = '新修订的原文';
  const editedJob = edited.host.enqueueWorkflow(['modelA'], () => {
    if (!changed && edited.host.workflowHistory().some(run => run.nodes.some(node => node.nodeId === 'modelA' && node.status === 'running'))) { changed = true; edited.host.setDocument(newDocument); }
  }, direct);
  const editedResult = await finished(editedJob.completion); assert.equal(editedResult.status, 'cancelled'); assert.equal(editedResult.publication, 'stale');
  assert.equal(editCalls, 0); assert.equal(editedSession.summary().usedRequests, 0); assert.deepEqual(edited.host.waitingModelTests(), []);
  assert.equal((await finished(edited.host.enqueueWorkflow(['modelA'], undefined, direct).completion)).status, 'succeeded'); assert.equal(editCalls, 1);

  const running = create(); let runningCalls = 0, late!: (value: LlmCallResponse) => void;
  const runningSession = grant(running, async () => { runningCalls++; return new Promise(resolve => { late = resolve; }); });
  const runningJob = running.host.enqueueWorkflow(['showA'], undefined, direct); await until(() => runningCalls === 1);
  running.host.cancelWorkflow(runningJob.id); const runningResult = await finished(runningJob.completion);
  assert.equal(runningResult.status, 'cancelled'); assert.equal(runningSession.summary().usedRequests, 1); assert.equal(runningSession.summary().reservedOutputTokens, 512);
  late(response('晚到结果不得发布')); await tick(); await tick();
  assert.deepEqual(running.host.waitingModelTests(), []); assert.ok(running.host.history().every(entry => entry.artifacts.length === 0)); assert.equal(runningCalls, 1);

  const exhausted = create(); let budgetCalls = 0; const limited = grant(exhausted, async () => { budgetCalls++; return response(); }, 1);
  assert.equal((await finished(exhausted.host.enqueueWorkflow(['modelA'], undefined, direct).completion)).status, 'succeeded');
  const over = await finished(exhausted.host.enqueueWorkflow(['modelA'], undefined, direct).completion);
  assert.equal(over.status, 'failed'); assert.equal(over.nodes[0].diagnostic?.kind, 'model-request'); assert.equal(budgetCalls, 1); assert.equal(limited.summary().usedRequests, 1);
  assert.deepEqual(exhausted.host.waitingModelTests(), []);

  const failed = create(); let failedCalls = 0;
  grant(failed, async () => { failedCalls++; throw new Error('SYNTHETIC_TRANSPORT_FAILURE'); });
  assert.equal((await finished(failed.host.enqueueWorkflow(['modelA'], undefined, direct).completion)).status, 'failed');
  await tick(); await tick(); assert.equal(failedCalls, 1); assert.equal(failed.host.modelTestSummary()!.usedRequests, 1);

  const closed = create(); let closedCalls = 0; const closedSession = grant(closed, async () => { closedCalls++; return response(); });
  const closedJob = closed.host.enqueueWorkflow(['modelA'], undefined, direct); closedSession.close();
  assert.notEqual((await finished(closedJob.completion)).status, 'succeeded'); assert.equal(closedCalls, 0); assert.equal(closedSession.summary().usedRequests, 0);
  const replacement = new S2ModelTestSession({ sceneId: closed.sceneId, runId: closed.host.runId, resourceId: closedSession.resourceId, providerId: 'synthetic', providerLabel: '其它会话', model: 'different',
    limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 }, invoke: async () => assert.fail('A replacement cannot inherit direct authorization') });
  sessions.push(replacement); assert.throws(() => closed.host.approveModelTestSession(replacement), /不能替换|不能替换或重置/);

  const revoked = create(true); let revokedCalls = 0; grant(revoked, async () => { revokedCalls++; return response(); }, 1, true);
  const revokedImage = await revoked.host.approveImageFile(file), revokedDoc = structuredClone(revoked.config.initial);
  revokedDoc.execution!.nodes.find(node => node.id === 'picture')!.bindings.resource = literal(revokedImage.id); revoked.host.setDocument(revokedDoc);
  const revokedJob = revoked.host.enqueueWorkflow(['showA'], undefined, direct); revoked.host.revokeImageFile(revokedImage.id);
  assert.equal((await finished(revokedJob.completion)).status, 'failed'); assert.equal(revokedCalls, 0); assert.equal(revoked.host.modelTestSummary()!.usedRequests, 0);
  assert.deepEqual(revoked.host.waitingModelTests(), []);
  assert.equal(forbiddenIo, 0);
  console.log('S2 user-action model passed: exact selected text/image/parameters with zero model waits, private per-job one-shot scope/revision/session/input authorization, original default waits and duplicate-confirm protection, no missing grant/prototype/raw-text bypass, cancellation/edit/late-result/session/image revocation, retained usage/budget and no retries. Synthetic transport only; no real model/network.');
} finally { hosts.forEach(host => host.close()); sessions.forEach(session => session.close()); globalThis.fetch = previousFetch; }
