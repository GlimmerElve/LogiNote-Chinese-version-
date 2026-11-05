import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { S2ImageResource } from '../src/services/scene/sceneS2ImageResource';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';

// The only model is an explicitly injected function. No real files, settings, notes, network or model.
const originalFetch = globalThis.fetch; let forbidden = 0;
globalThis.fetch = async () => { forbidden++; throw new Error('Synthetic image test forbids network'); };
const hosts: S2PluginHost[] = [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRscAAAAASUVORK5CYII=';
const file = (name = '合成图片.png', type = 'image/png') => new File([Uint8Array.from(atob(png.split(',')[1]), char => char.charCodeAt(0))], name, { type });
const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const literal = (value: any) => ({ kind: 'literal' as const, value });
const node = (id: string, pluginId: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, ...ref(pluginId, capabilityId), position: { x: 0, y: 0 }, bindings });
const capabilities = [ref('local-material', 'read-image'), ref('model-test', 'generate'), ref('structured-view', 'text')];
function setup(supportsImages = true, invoke: (request: LlmCallRequest) => Promise<any> = async () => ({ content: '<script>只是原始文本</script>\n完整结果', diagnostics: { finishReason: 'stop' } })) {
  const host = new S2PluginHost('image-scene', capabilities); hosts.push(host);
  const session = new S2ModelTestSession({ sceneId: 'image-scene', runId: host.runId, resourceId: 'synthetic-model', providerId: 'synthetic-provider', providerLabel: '合成服务', model: 'fixed-model', supportsImages,
    limits: { maxRequests: 4, maxReservedOutputTokens: 2048, maxOutputTokens: 512 }, invoke });
  host.approveModelTestSession(session);
  return { host, session };
}
function graph(resource: string): S2Document {
  return { nodes: [], edges: [], execution: { version: 1, nodes: [
    node('picture', 'local-material', 'read-image', { resource: literal(resource) }),
    node('request', 'model-test', 'generate', { prompt: literal('用户原文：即使提示词很差也不改写。'), input: literal('处理这张图片，原文保持。') }),
    node('display', 'structured-view', 'text'),
  ], links: [
    { source: { nodeId: 'picture', portId: 'image' }, target: { nodeId: 'request', portId: 'image' } },
    { source: { nodeId: 'request', portId: 'text' }, target: { nodeId: 'display', portId: 'text' } },
  ] } };
}
async function waiting(host: S2PluginHost, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const run = host.workflowHistory().find(run => run.id === id)!;
    if (run.status === 'waiting') return host.waitingModelTests()[0];
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) assert.fail(`Expected waiting, got ${JSON.stringify(run)}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Synthetic model wait timed out');
}
async function completed(job: { completion: Promise<any> }) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([job.completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic workflow deadline')), 2500); })]); }
  finally { clearTimeout(timer!); }
}
try {
  const registry = s2BuiltinPluginRegistry();
  assert.equal(s2BuiltinPluginInstallation().descriptor(ref('structured-view', 'text')).kind, 'renderer');
  assert.equal(registry.capability(ref('model-test', 'generate')).inputs.find(port => port.id === 'image')!.required, false);
  assert.equal(registry.compatible({ id: 'core.image', version: 1 }, { id: 'core.text', version: 1 }), false);
  for (const invalid of [new File(['<svg>not raster</svg>'], 'fake.png', { type: 'image/png' }), file('fake.svg'), file('fake.png', 'image/jpeg'), new File([''], 'empty.png'), new File([new Uint8Array(1024 * 1024 + 1)], 'large.png')]) await assert.rejects(S2ImageResource.select(invalid));
  await assert.rejects(S2ImageResource.select({ name: 'fake.png', size: 1 } as File));
  const selected = await S2ImageResource.select(file());
  assert.equal(selected.preview().dataUrl, png); assert.equal(selected.info().mimeType, 'image/png');
  assert.equal('dataUrl' in selected.info(), false);
  const lateSelection = setup(); const oldSelection = lateSelection.host.approveImageFile(file()); lateSelection.host.close();
  await assert.rejects(oldSelection); assert.deepEqual(lateSelection.host.imageResourceSummary(), []);
  const pickerRace = setup(); const firstSelection = pickerRace.host.approveImageFile(file('first.png')), latestSelection = pickerRace.host.approveImageFile(file('last.png'));
  await assert.rejects(firstSelection); const latestInfo = await latestSelection; assert.deepEqual(pickerRace.host.imageResourceSummary().map(info => info.id), [latestInfo.id]);

  // Revoking one local material kind cannot erase the other kind's exact file grant.
  const mixed = new S2PluginHost('image-scene', [...capabilities, ref('local-material', 'read-text')]); hosts.push(mixed);
  const imageGrant = await mixed.approveImageFile(file()); const textGrant = mixed.approveTextFile(new File(['合成原文'], 'synthetic.txt'));
  mixed.revokeTextFile(textGrant.id);
  const mixedSession = new S2ModelTestSession({ sceneId: 'image-scene', runId: mixed.runId, resourceId: 'mixed-model', providerId: 'synthetic', providerLabel: '合成', model: 'fixed-model', supportsImages: true,
    limits: { maxRequests: 1, maxReservedOutputTokens: 512, maxOutputTokens: 512 }, invoke: async () => ({ content: 'ok', diagnostics: { finishReason: 'stop' } }) });
  mixed.approveModelTestSession(mixedSession); mixed.setDocument(graph(imageGrant.id)); const mixedJob = mixed.enqueueWorkflow(['display']), mixedWait = await waiting(mixed, mixedJob.id);
  mixed.confirmModelTest(mixedJob.id, mixedWait.id, true); assert.equal((await completed(mixedJob)).status, 'succeeded');
  const remainingText = mixed.approveTextFile(new File(['不受撤图影响'], 'other.txt')); mixed.revokeImageFile(imageGrant.id);
  mixed.setDocument({ nodes: [], edges: [], execution: { version: 1, nodes: [node('text', 'local-material', 'read-text', { resource: literal(remainingText.id) })], links: [] } });
  assert.equal((await completed(mixed.enqueueWorkflow(['text']))).status, 'succeeded');

  const sent: LlmCallRequest[] = [], { host, session } = setup(true, async request => { sent.push(structuredClone(request)); return { content: '  原始返回\n', diagnostics: { finishReason: 'stop' } }; });
  const info = await host.approveImageFile(file()), document = graph(info.id); host.setDocument(document);
  assert.equal(session.summary().usedRequests, 0);
  const job = host.enqueueWorkflow(['display']), wait = await waiting(host, job.id);
  assert.deepEqual(wait.images, [host.imageResourcePreview(info.id)]); assert.equal(sent.length, 0);
  assert.equal(wait.images![0].dataUrl, png);
  wait.images![0].dataUrl = 'not authority'; assert.equal(host.waitingModelTests()[0].images![0].dataUrl, png);
  const imageOutput = host.workflowHistory().find(run => run.id === job.id)!.nodes.find(item => item.nodeId === 'picture')!.artifactIds[0];
  assert.deepEqual(host.currentArtifact(imageOutput).payload, { kind: 'inline', value: { resourceId: info.id } });
  const prepared = host.prepare('request', { goal: '解释', understanding: '只读', planning: '不执行', response: '建议' }, '看一下');
  assert.ok(!JSON.stringify(prepared).includes('data:image'), 'No base64 image enters Agent frames or catalogues');
  host.confirmModelTest(job.id, wait.id, true); const result = await completed(job);
  assert.equal(result.status, 'succeeded'); assert.equal(result.nodes.find((item: any) => item.nodeId === 'display').status, 'displayed');
  assert.equal(sent.length, 1); assert.equal(sent[0].model, 'fixed-model'); assert.equal(sent[0].images![0].dataUrl, png);
  assert.equal(sent[0].images![0].assetId, info.id); assert.equal(sent[0].systemPromptOverride, wait.prompt); assert.equal(sent[0].userInput, wait.input);
  assert.ok(!sent[0].userInput.includes(info.id));
  assert.equal(session.summary().records[0].output, '  原始返回\n'); assert.deepEqual(session.summary().records[0].imageIds, [info.id]);
  const imageClone = host.imageResourcePreview(info.id); imageClone.dataUrl = 'forged'; assert.equal(host.imageResourcePreview(info.id).dataUrl, png);

  // No new model, text fallback or OCR when the fixed configured model is text-only.
  const textOnly = setup(false, async () => { assert.fail('Unsupported images must never be dispatched'); });
  const textInfo = await textOnly.host.approveImageFile(file()); textOnly.host.setDocument(graph(textInfo.id));
  const unsupported = await completed(textOnly.host.enqueueWorkflow(['display']));
  assert.equal(unsupported.status, 'failed'); assert.equal(textOnly.session.summary().usedRequests, 0); assert.equal(textOnly.host.imageResourceSummary().length, 1);
  let serverAttempts = 0;
  const serverUnsupported = setup(true, async () => { serverAttempts++; throw new Error('LLM_IMAGE_UNSUPPORTED: server rejects images (do not echo arbitrary service text)'); });
  const serverImage = await serverUnsupported.host.approveImageFile(file()); serverUnsupported.host.setDocument(graph(serverImage.id));
  const serverJob = serverUnsupported.host.enqueueWorkflow(['display']), serverWait = await waiting(serverUnsupported.host, serverJob.id);
  serverUnsupported.host.confirmModelTest(serverJob.id, serverWait.id, true); assert.equal((await completed(serverJob)).status, 'failed');
  assert.equal(serverAttempts, 1); assert.equal(serverUnsupported.session.summary().usedRequests, 1); assert.match(serverUnsupported.session.summary().records[0].error!, /服务端不支持.*图片/);

  // Saved/copied resource IDs are data, never a transferable grant.
  const imported = setup(); imported.host.setDocument(document);
  assert.equal((await completed(imported.host.enqueueWorkflow(['display']))).status, 'failed'); assert.equal(imported.session.summary().usedRequests, 0);
  const forged = setup(); forged.host.setDocument(graph('https://example.invalid/picture.png'));
  assert.equal((await completed(forged.host.enqueueWorkflow(['display']))).status, 'failed'); assert.equal(forged.session.summary().usedRequests, 0);

  for (const action of ['withdraw', 'edit', 'close', 'reject'] as const) {
    const scope = setup(true, async () => { assert.fail(`Retired ${action} wait must never dispatch`); });
    const current = await scope.host.approveImageFile(file()); scope.host.setDocument(graph(current.id));
    const pending = scope.host.enqueueWorkflow(['display']), pendingWait = await waiting(scope.host, pending.id);
    if (action === 'withdraw') scope.host.revokeImageFile(current.id);
    else if (action === 'edit') { const edited = graph(current.id); edited.execution!.nodes[1].bindings.input = literal('改过正文'); scope.host.setDocument(edited); }
    else if (action === 'close') scope.host.close();
    else scope.host.confirmModelTest(pending.id, pendingWait.id, false);
    await completed(pending); assert.equal(scope.session.summary().usedRequests, 0);
    assert.throws(() => scope.host.confirmModelTest(pending.id, pendingWait.id, true));
  }

  let release: ((value: any) => void) | undefined, dispatched = false;
  const inflight = setup(true, async () => { dispatched = true; return new Promise(resolve => { release = resolve; }); });
  const inflightImage = await inflight.host.approveImageFile(file()); inflight.host.setDocument(graph(inflightImage.id));
  const pending = inflight.host.enqueueWorkflow(['display']); const confirm = await waiting(inflight.host, pending.id); inflight.host.confirmModelTest(pending.id, confirm.id, true);
  while (!dispatched) await new Promise(resolve => setTimeout(resolve, 1));
  inflight.host.revokeImageFile(inflightImage.id); await completed(pending);
  release!({ content: 'late forbidden success', diagnostics: { finishReason: 'stop' } }); await Promise.resolve(); await Promise.resolve();
  assert.equal(inflight.session.summary().records[0].status, 'cancelled'); assert.equal(inflight.session.summary().usedRequests, 1);
  assert.ok(!inflight.host.history().some(entry => entry.receipt.status === 'succeeded' && entry.request.nodeId === 'request'));

  // Keep the whole text actually received even for truncation or an overlong response; no false success artifact.
  for (const [content, finishReason] of [['全文'.repeat(1800), 'length'], ['x'.repeat(6001), 'stop']] as const) {
    const failed = setup(true, async () => ({ content, diagnostics: { finishReason } }));
    const image = await failed.host.approveImageFile(file()); failed.host.setDocument(graph(image.id));
    const job = failed.host.enqueueWorkflow(['display']), wait = await waiting(failed.host, job.id); failed.host.confirmModelTest(job.id, wait.id, true);
    assert.equal((await completed(job)).status, 'failed');
    assert.equal(failed.session.summary().records[0].output, content); assert.equal(failed.session.summary().records[0].outputOmitted, 0); assert.equal(failed.session.summary().records[0].outputComplete, false);
  }
  assert.equal(forbidden, 0);
  console.log('S2 images passed: native local PNG/JPEG/WebP validation, out-of-band typed handles, fixed vision model, actual image confirmation, no hidden context/base64 frames, full raw success/failure text, local text renderer, withdraw/edit/reject/end/late-response isolation, copied template handles not grants. Synthetic only; no real model/network/material.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = originalFetch; }
