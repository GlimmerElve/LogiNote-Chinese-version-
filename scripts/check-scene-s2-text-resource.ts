// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { SceneInitialRequest } from '../src/types';
import type { S2Document } from '../src/types/sceneS2';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT } from '../src/services/scene/sceneS2PluginHost';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry, s2RuntimePluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { createS2Scene, designS2Canvas, readS2Definition, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch, nativeRead = File.prototype.arrayBuffer;
let network = 0, reads = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic File resources must not access network or private data'); };
File.prototype.arrayBuffer = function () { reads++; return nativeRead.call(this); };
const resource = { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' };
const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
const table = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'to-table' };
const view = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'table' };
const check = { pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' };
const plugins = [resource, parse, table, view, check];
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const records = [{ name: '合成资料', enabled: false, count: 0, empty: null }, { name: '缺失' }], raw = JSON.stringify(records);
const file = () => new File([raw], 'synthetic.json', { type: 'application/json', lastModified: 123 });
const strategy = { goal: '只读取选择的资料', understanding: '先理解', planning: '明确请求才运行', response: '不把资料当授权' };
function document(id = 'not-approved'): S2Document {
  return { nodes: [], edges: [], execution: { version: 1, nodes: [
    { ...resource, id: 'read', position: { x: 0, y: 0 }, bindings: { resource: { kind: 'literal', value: id } } },
    { ...parse, id: 'parse', position: { x: 200, y: 0 }, bindings: {} },
    { ...table, id: 'table', position: { x: 400, y: 0 }, bindings: {} },
    { ...view, id: 'view', position: { x: 600, y: 0 }, bindings: {} },
    { ...check, id: 'independent', position: { x: 0, y: 200 }, bindings: { text: { kind: 'literal', value: '{}' } } },
  ], links: [
    { source: { nodeId: 'read', portId: 'text' }, target: { nodeId: 'parse', portId: 'text' } },
    { source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } },
    { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } },
  ] } };
}
function host(allowed = plugins) { const value = new S2PluginHost('synthetic-resource', allowed); hosts.push(value); return value; }
async function settle(ui: ReturnType<typeof harness>, ready: () => boolean) {
  for (let i = 0; i < 400; i++) { ui.render(); if (ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Resource UI did not settle');
}
try {
  const installation = s2BuiltinPluginInstallation();
  assert.deepEqual(installation.descriptor(resource), { kind: 'resource', bridge: 'selected-text-file' });
  assert.equal(s2BuiltinPluginRegistry().capability(resource).effect, 'read');
  const noCapability = host([]); assert.throws(() => noCapability.approveTextFile(file())); assert.equal(reads, 0);
  noCapability.setDocument({ nodes: [], edges: [] }); assert.equal('textResources' in noCapability.prepare(null, strategy, '讨论'), false);
  assert.ok(!s2RuntimePluginCatalog([check]).selectionRules.includes('local-material'));
  assert.ok(s2RuntimePluginCatalog([resource]).selectionRules.includes('local-material'));
  const limited = host(), selected = Array.from({ length: 4 }, () => limited.approveTextFile(file()));
  assert.throws(() => limited.approveTextFile(file()), /4/); limited.revokeTextFile(selected[0].id); limited.approveTextFile(file());
  assert.equal(limited.textResourceSummary().length, 4); limited.close(); assert.deepEqual(limited.textResourceSummary(), []); assert.equal(reads, 0);
  const denied = host(); denied.setDocument(document());
  assert.equal((await denied.enqueueWorkflow(['view']).completion).status, 'failed');
  assert.equal(denied.history().length, 0); assert.equal(denied.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.equal(reads, 0);
  for (const invalid of ['C:\\private\\note.txt', 'https://example.invalid/file', { name: 'fake.txt', size: 1 },
    new File(['x'], 'app.exe'), new File(['x'.repeat(24001)], 'large.txt')]) {
    assert.throws(() => denied.approveTextFile(invalid as File));
  }
  assert.deepEqual(denied.textResourceSummary(), []); assert.equal(reads, 0);

  const active = host(), info = active.approveTextFile(file());
  assert.equal(reads, 0, 'Picker approval does not read bytes or enqueue work');
  assert.equal(active.history().length, 0); assert.equal(info.label, 'synthetic.json');
  const copy = active.textResourceSummary(); copy[0].label = 'changed'; assert.equal(active.textResourceSummary()[0].label, 'synthetic.json');
  active.setDocument(document(info.id));
  const first = await active.enqueueWorkflow(['view']).completion;
  assert.equal(first.status, 'succeeded'); assert.equal(reads, 1);
  assert.deepEqual(first.nodes.map(node => node.status), ['succeeded', 'succeeded', 'succeeded', 'displayed']);
  const source = active.history().find(item => item.request.nodeId === 'read')!;
  assert.deepEqual(source.resource, info); assert.equal(source.artifacts[0].source.invocationId, source.receipt.invocationId);
  assert.equal(source.artifacts[0].payload.kind, 'inline');
  if (source.artifacts[0].payload.kind === 'inline') assert.equal(source.artifacts[0].payload.value, raw);
  const final = active.currentArtifact(first.nodes.find(node => node.nodeId === 'view')!.artifactIds[0]);
  assert.equal(final.payload.kind, 'inline');
  if (final.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(final.payload.value as unknown as S2Table), records);
  assert.equal(active.remainingCalls, S2_LOCAL_RUN_LIMIT - 3);
  const context = active.prepare('read', strategy, '解释资料');
  assert.deepEqual(context.textResources, [info]); assert.equal(JSON.stringify(context.textResources).includes(raw), false);
  const repeat = await active.enqueueWorkflow(['view']).completion;
  assert.equal(repeat.nodes[0].status, 'succeeded'); assert.equal(reads, 2, 'Resource reads do not inherit pure-node cache');
  assert.equal(active.history().filter(item => item.request.nodeId === 'read').length, 2);

  const foreign = host(); foreign.approveTextFile(file()); foreign.setDocument(document(info.id));
  assert.equal((await foreign.enqueueWorkflow(['read', 'independent']).completion).status, 'failed');
  assert.equal(foreign.history().length, 1); assert.equal(foreign.history()[0].request.nodeId, 'independent'); assert.equal(reads, 2);
  const beforeRevoke = active.remainingCalls; active.revokeTextFile(info.id);
  assert.deepEqual(active.textResourceSummary(), []);
  assert.equal((await active.enqueueWorkflow(['read']).completion).status, 'failed');
  assert.equal(active.remainingCalls, beforeRevoke); assert.equal(reads, 2);
  assert.deepEqual(active.currentArtifact(source.artifacts[0].id), source.artifacts[0], 'Revoke stops future reads, not deletion of prior authorized output');

  for (const value of [new File([new Uint8Array([0xff, 0xfe])], 'encoding.txt'), new File(['x'.repeat(6001)], 'long.txt'), new File(['\0'], 'binary.txt')]) {
    const broken = host(), grant = broken.approveTextFile(value); broken.setDocument(document(grant.id));
    assert.equal((await broken.enqueueWorkflow(['view']).completion).status, 'failed');
    assert.equal(broken.history().length, 1); assert.equal(broken.history()[0].receipt.status, 'failed');
    assert.deepEqual(broken.history()[0].artifacts, []); assert.equal(broken.remainingCalls, S2_LOCAL_RUN_LIMIT - 1);
  }
  const exact = host(), originalText = '\ufeff  保留空白\r\n$& {{role}}\n';
  const exactInfo = exact.approveTextFile(new File([originalText], 'exact.md')); exact.setDocument(document(exactInfo.id));
  assert.equal((await exact.enqueueWorkflow(['read']).completion).status, 'succeeded');
  const exactArtifact = exact.history()[0].artifacts[0];
  if (exactArtifact.payload.kind !== 'inline') assert.fail('Complete original required');
  assert.equal(exactArtifact.payload.value, originalText);
  const prepared = exact.prepare('read', strategy, '再次读取'), request = { ...resource, nodeId: 'read', reason: '合成明确请求', inputs: { resource: [prepared.bindings[0].artifactId] } };
  const oldReads = reads;
  const [a, b] = await Promise.all([exact.execute(request, prepared.frame, 'same-read'), exact.execute(request, prepared.frame, 'same-read')]);
  assert.equal(a.receipt.id, b.receipt.id); assert.equal(reads, oldReads + 1);

  // Actual native File bridge with a delayed byte result: withdrawal cancels only that call.
  let entered!: () => void, release!: (value: ArrayBuffer) => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  File.prototype.arrayBuffer = function () { reads++; entered(); return new Promise<ArrayBuffer>(resolve => { release = resolve; }); };
  const delayed = host(), delayedInfo = delayed.approveTextFile(file()); delayed.setDocument(document(delayedInfo.id));
  const waiting = delayed.enqueueWorkflow(['view', 'independent']); await enteredPromise;
  delayed.revokeTextFile(delayedInfo.id);
  const stopped = await waiting.completion;
  assert.equal(stopped.nodes.find(node => node.nodeId === 'read')?.status, 'failed');
  assert.equal(stopped.nodes.find(node => node.nodeId === 'parse')?.status, 'blocked');
  assert.equal(stopped.nodes.find(node => node.nodeId === 'independent')?.status, 'succeeded');
  assert.equal(delayed.history()[0].receipt.status, 'cancelled'); assert.equal(delayed.history().length, 2);
  release(new Uint8Array(new TextEncoder().encode(raw)).buffer); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(delayed.history().length, 2); assert.deepEqual(delayed.history()[0].artifacts, []);
  File.prototype.arrayBuffer = function () { reads++; return nativeRead.call(this); };

  const requestInput: SceneInitialRequest = { source: 'custom', subject: '合成资料工作台', knowledgePoints: [], sceneSkill: 'S2' };
  const scene = createS2Scene(requestInput), canvas = scene.canvasWorkspace!;
  canvas.plugins = plugins; canvas.initial = { ...document(), nodes: canvas.initial.nodes };
  delete canvas.initial.execution!.nodes[0].bindings.resource;
  canvas.business = { version: 1, purpose: '合成只读资料到表格的完成路径', knowledge: [],
    workflow: [{ id: 'ReadAndShow', goal: '经用户选择和执行确认后读取并展示', actor: 'tool', capabilities: [resource, parse, table, view], input: '用户将来选择的文件，不是已有资源授权', output: '完整文本及结构化表格' }],
    completion: { mode: 'execution', reference: { ...document('user-selected-file'), nodes: canvas.initial.nodes }, targetNodeIds: ['view'],
      coverage: [{ requirementId: 'file-read', stepIds: ['ReadAndShow'], nodeIds: ['read', 'parse', 'table', 'view'] }] }, criteria: [] };
  assert.ok(readS2Definition(canvas, { requireBusiness: true }).business, 'A future user selection has a typed synthetic witness, not a fake runtime grant');
  const builtStages: string[] = [], beforeBuildReads = reads, quote = scene.task.slice(0, 120);
  const built = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
    const input = JSON.parse(request.userInput); builtStages.push(input.stage);
    if (input.stage === 'understand') {
      assert.equal(input.pluginCatalog, undefined); assert.ok(!request.systemPromptOverride!.includes('local-material@1.0.0/read-text仅读取'));
      return { content: JSON.stringify({ goal: canvas.goal, requirements: [{ id: 'file-read', source: 'task', quote, description: '合成资料读取练习' }],
        userRole: '选择资料并确认执行', agentRole: '根据需求协作', assumptions: [], openQuestions: [],
        delivery: { initial: '提供可选资料输入与处理节点', deferred: '运行前由用户选择文件', source: 'task', quote } }) };
    }
    assert.ok(input.pluginCatalog.plugins.some((plugin: { id: string }) => plugin.id === 'local-material'));
    assert.ok(request.systemPromptOverride!.includes('未知文件/图片/笔记只留选择入口'));
    assert.ok(request.systemPromptOverride!.includes('不填路径、URL、字节或编造资源句柄'));
    assert.ok(input.pluginCatalog.plugins.find((plugin: any) => plugin.id === 'local-material').capabilities.find((capability: any) => capability.id === 'read-text').permissions.includes('file-read'));
    return { content: JSON.stringify(input.stage === 'assemble' ? canvas : { verdict: 'accept',
      coverage: [{ requirementId: 'file-read', status: 'covered', evidencePaths: ['/business/workflow/0'], reason: '合成协议覆盖，不是语义效果证明' }], factChecks: [], feedback: '只检查静态路径，未读取资料' }) };
  } });
  assert.deepEqual(builtStages, ['understand', 'assemble']); assert.ok(built.business); assert.equal(reads, beforeBuildReads);
  let uiHost!: S2PluginHost;
  const ui = harness({ initialRequest: requestInput, initialDraft: scene, onHost: value => { uiHost = value; } }); uis.push(ui);
  const previewPicker = ui.labelControl('选择并允许本局读取文本资料', 'input'); assert.equal(previewPicker.props.disabled, true);
  ui.button('开始试验').props.onClick(); ui.render();
  const readBeforeUI = reads;
  previewPicker.props.onChange({ target: { files: [file()], value: 'fakepath' } }); ui.render(); assert.deepEqual(uiHost.textResourceSummary(), []);
  const picker = ui.labelControl('选择并允许本局读取文本资料', 'input'), target = { files: [file()], value: 'fakepath' };
  picker.props.onChange({ target }); ui.render(); assert.equal(target.value, ''); assert.equal(reads, readBeforeUI);
  const uiInfo = uiHost.textResourceSummary()[0]; assert.ok(uiInfo);
  ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'read' } }); ui.render();
  ui.labelControl('为读取步骤选择资料', 'select').props.onChange({ target: { value: uiInfo.id } }); ui.render();
  assert.ok(ui.text().includes('synthetic.json')); assert.ok(!ui.text().includes(uiInfo.id), 'Users see names, not resource IDs');
  assert.equal(reads, readBeforeUI);
  ui.button('运行全部步骤').props.onClick(); await settle(ui, () => uiHost.workflowHistory().at(-1)?.status === 'succeeded');
  assert.equal(reads, readBeforeUI + 1);
  ui.button('保存场景').props.onClick(); await settle(ui, () => ui.saved.length === 1);
  const saved = ui.saved[0], serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes(raw));
  assert.ok(!serialized.includes('"resourceScopes"') && !serialized.includes('"textResources"'), 'Business text may mention file-read, but cannot save a resource grant or File store');
  const imported = importS2Workspace(exportS2Workspace(saved.canvasWorkspace, saved.canvasWorkspace.initial));
  const restored = host(); restored.setDocument(imported.initial);
  assert.equal((await restored.enqueueWorkflow(['read']).completion).status, 'failed'); assert.equal(restored.remainingCalls, S2_LOCAL_RUN_LIMIT);
  ui.elements().find(item => item.type === 'button' && item.props['aria-label'] === '撤回资料 synthetic.json')!.props.onClick(); ui.render();
  assert.deepEqual(uiHost.textResourceSummary(), []);
  const captured = picker.props.onChange; ui.button('结束试验').props.onClick(); ui.render();
  captured({ target: { files: [file()], value: '' } }); ui.render(); assert.deepEqual(uiHost.textResourceSummary(), []);

  // Runtime outcome enums must not accept arrays merely because String(array) looks valid.
  const malformed = new S2PluginHost('outcome-enum', [check], async () => ({ status: ['failed'], outputs: {}, error: { code: 'FAKE', message: 'not a legal outcome' } })); hosts.push(malformed);
  malformed.setDocument({ nodes: [], edges: [], execution: { version: 1, nodes: [{ ...check, id: 'check', position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } } }], links: [] } });
  await malformed.enqueueWorkflow(['check']).completion;
  assert.equal(malformed.history()[0].receipt.status, 'failed'); assert.equal(malformed.history()[0].receipt.error?.code, 'INVALID_OUTPUT');
  assert.equal(network, 0);
  console.log('S2 selected-text resources passed: actual synthetic native File bytes, no-read picker, exact run/resource grants, revoked/foreign/path denial before debit, UTF-8/size/full-text boundaries, original BOM/whitespace, read→parse→table→view native data, no resource cache, idempotency, delayed revoke/independent branch, actual UI picker/named binding/run/save/end and inert saved handles, strict output enum. No real user file, network, notes, RAG or models.');
} finally {
  uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close());
  globalThis.fetch = previousFetch; File.prototype.arrayBuffer = nativeRead;
}
