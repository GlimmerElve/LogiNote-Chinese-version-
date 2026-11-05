import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Json, S2PluginInvocation } from '../src/types/sceneS2Plugin';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2WorkflowRun, type S2LocalAdapter } from '../src/services/scene/sceneS2PluginHost';
import { executeS2Structured, readS2StructuredFailureDiagnostic } from '../src/services/scene/sceneS2Structured';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';

const cap = (capabilityId: string) => ({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId });
const plugins = [cap('parse-json'), cap('select'), cap('stringify')];
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({
  id, ...cap(capabilityId), position: { x: 0, y: 0 }, bindings, presentation: { label: id === 'parse' ? '读取结构化文本' : id === 'select' ? '提取所需部分' : '来源处理' },
});
const link = (source: string, sourcePort: string, target: string, targetPort: string) => ({ source: { nodeId: source, portId: sourcePort }, target: { nodeId: target, portId: targetPort } });
const definition = readS2Definition({ version: 1, goal: '只诊断真实转换失败，不猜修复内容',
  instructions: { understanding: '先理解', planning: '分别核对来源', response: '定位不等于运行' }, plugins,
  blockTypes: [{ id: 'note', label: '练习原文', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
function parseDocument(text: string): S2Document {
  return readS2Document({ nodes: [], edges: [], execution: { version: 1, nodes: [node('parse', 'parse-json', { text: literal(text) }), node('down', 'stringify')],
    links: [link('parse', 'value', 'down', 'value')] } }, definition);
}
function selectDocument(value: S2Json, pointer: string): S2Document {
  return readS2Document({ nodes: [], edges: [], execution: { version: 1, nodes: [node('select', 'select', { value: literal(value), pointer: literal(pointer) }), node('down', 'stringify')],
    links: [link('select', 'value', 'down', 'value')] } }, definition);
}
const state = (run: S2WorkflowRun, id: string) => run.nodes.find(item => item.nodeId === id)!;
const diagnostic = (reason: 'json-syntax' | 'pointer-syntax' | 'pointer-missing' | 'pointer-inaccessible') => ({ kind: 'structured-transform', reason,
  inputPortIds: reason === 'json-syntax' ? ['text'] : reason === 'pointer-syntax' ? ['pointer'] : ['value', 'pointer'] });
const hosts: S2PluginHost[] = [];
function hostFor(document: S2Document, adapter?: S2LocalAdapter) { const host = new S2PluginHost('transform-issues-synthetic', definition, adapter); hosts.push(host); host.setDocument(document); return host; }
function failedOutcome(outcome: Awaited<ReturnType<typeof executeS2Structured>>) {
  assert.ok('error' in outcome); assert.equal(outcome.status, 'failed'); return outcome;
}
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic transform tests must not use IO'); };
try {
  // Native converter evidence is tied to the exact invocation, complete inputs and original failed outcome, never a message pattern.
  const call: S2PluginInvocation = { protocolVersion: 1, id: 'invocation-brand-test', sceneId: 'scene', runId: 'run', nodeId: 'parse', revision: 1,
    ...cap('parse-json'), idempotencyKey: 'test', inputs: { text: ['artifact-text'] } };
  const inputs = { text: ['{"PRIVATE_NATIVE":'] }, outcome = failedOutcome(await executeS2Structured(call, inputs));
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.error!.code, 'TRANSFORM_REJECTED');
  assert.deepEqual(await readS2StructuredFailureDiagnostic(structuredClone(call), structuredClone(inputs), outcome, structuredClone(outcome)), diagnostic('json-syntax'));
  assert.equal(await readS2StructuredFailureDiagnostic(call, inputs, structuredClone(outcome), structuredClone(outcome)), null);
  for (const changed of [{ ...call, id: 'foreign-invocation' }, { ...call, revision: 2 }, { ...call, idempotencyKey: 'foreign-key' }, { ...call, inputs: { text: ['foreign-artifact'] } }]) {
    assert.equal(await readS2StructuredFailureDiagnostic(changed, inputs, outcome, outcome), null);
  }
  assert.equal(await readS2StructuredFailureDiagnostic(call, { text: ['{different'] }, outcome, outcome), null);
  const badValidated = structuredClone(outcome); badValidated.error!.message += 'changed';
  assert.equal(await readS2StructuredFailureDiagnostic(call, inputs, outcome, badValidated), null);
  const tampered = failedOutcome(await executeS2Structured(call, inputs)); tampered.error!.message += 'changed';
  assert.equal(await readS2StructuredFailureDiagnostic(call, inputs, tampered, tampered), null);
  const getterOutcome = failedOutcome(await executeS2Structured(call, inputs)); let getterReads = 0;
  Object.defineProperty(getterOutcome.error!, 'message', { enumerable: true, get: () => { getterReads++; return 'fake'; } });
  assert.equal(await readS2StructuredFailureDiagnostic(call, inputs, getterOutcome, outcome), null); assert.equal(getterReads, 0);

  const document = parseDocument('{"PRIVATE_TEXT":'), original = JSON.stringify(document), host = hostFor(document);
  const first = await host.enqueueWorkflow(['down']).completion;
  assert.equal(state(first, 'parse').status, 'failed'); assert.equal(state(first, 'down').status, 'blocked'); assert.equal(host.remainingCalls, 63);
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'parse'), diagnostic('json-syntax'));
  assert.equal(host.history()[0].receipt.error!.code, 'TRANSFORM_REJECTED'); assert.equal(host.history().length, 1);
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'down'), { kind: 'upstream-unavailable', sourceNodeIds: ['parse'] });
  const display = s2RuntimeIssue(definition, document, 'parse', host.readWorkflowDiagnostic(first.id, 'parse'))!;
  assert.equal(display.kind, 'structured-transform'); assert.deepEqual(display.nodeIds, ['parse']); assert.match(display.summary, /JSON 语法/);
  assert.match(display.detail, /本次转换调用已计入次数/); assert.ok(!JSON.stringify(display).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(host.history()[0]).includes('structuredDiagnostic'), 'Native evidence remains private until attached to a matching workflow node');
  const beforeRead = JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]);
  const actualArtifactRead = host.currentArtifact; host.currentArtifact = () => { throw new Error('Diagnostic retrieval may not resolve material'); };
  try { assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'parse'), diagnostic('json-syntax')); } finally { host.currentArtifact = actualArtifactRead; }
  assert.equal(JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]), beforeRead); assert.equal(JSON.stringify(document), original);

  // Post-parse value-policy failures are not syntax errors; parsing occurs once and normal outcome messages/codes remain intact.
  for (const text of ['1e400', '{"constructor":0}', '{"__proto__":0}', '['.repeat(10) + '0' + ']'.repeat(10), '[' + Array(2050).fill('0').join(',') + ']']) {
    const instance = hostFor(parseDocument(text)), result = await instance.enqueueWorkflow(['parse']).completion;
    assert.equal(state(result, 'parse').status, 'failed'); assert.equal(instance.readWorkflowDiagnostic(result.id, 'parse'), null);
    assert.equal(instance.history()[0].receipt.error!.code, 'TRANSFORM_REJECTED'); assert.equal(instance.remainingCalls, 63);
  }
  for (const text of ['false', '0', 'null', '[]', '{}']) {
    const instance = hostFor(parseDocument(text)), result = await instance.enqueueWorkflow(['parse']).completion;
    assert.equal(result.status, 'succeeded'); assert.equal(instance.readWorkflowDiagnostic(result.id, 'parse'), null);
  }

  // Select distinguishes unsupported position syntax, missing complete path, and intentionally inaccessible positions.
  const selectCases: Array<[S2Json, string, Parameters<typeof diagnostic>[0]]> = [
    [{}, 'PRIVATE_DYNAMIC_BAD', 'pointer-syntax'], [{}, '/bad~2', 'pointer-syntax'],
    [{ PRIVATE_VALUE: true }, '/PRIVATE_DYNAMIC_MISSING', 'pointer-missing'], [{ child: false }, '/child/deeper', 'pointer-missing'],
    [[], '/01', 'pointer-inaccessible'], [{}, '/constructor', 'pointer-inaccessible'], [{}, '/__proto__', 'pointer-inaccessible'],
  ];
  for (const [value, pointer, reason] of selectCases) {
    const doc = selectDocument(value, pointer), instance = hostFor(doc), result = await instance.enqueueWorkflow(['select']).completion;
    assert.equal(state(result, 'select').status, 'failed'); assert.deepEqual(instance.readWorkflowDiagnostic(result.id, 'select'), diagnostic(reason));
    const issue = s2RuntimeIssue(definition, doc, 'select', instance.readWorkflowDiagnostic(result.id, 'select'))!;
    assert.equal(issue.kind, 'structured-transform'); assert.deepEqual(issue.nodeIds, ['select']);
    assert.ok(!JSON.stringify(issue).includes('PRIVATE_')); assert.ok(!Object.hasOwn(instance.readWorkflowDiagnostic(result.id, 'select')!, 'pointer'));
    assert.equal(instance.history()[0].receipt.error!.code, 'TRANSFORM_REJECTED'); assert.equal(instance.remainingCalls, 63);
  }
  const validCases: Array<[S2Json, string, S2Json]> = [[false, '', false], [0, '', 0], [null, '', null], [{ value: false }, '/value', false],
    [{ value: 0 }, '/value', 0], [{ value: null }, '/value', null], [{ '': 0 }, '/', 0], [{ 'a/b': { '~key': null } }, '/a~1b/~0key', null], [{ '~1': false }, '/~01', false], [{ '01': 0 }, '/01', 0], [[false], '/0', false]];
  for (const [value, pointer, expected] of validCases) {
    const instance = hostFor(selectDocument(value, pointer)), result = await instance.enqueueWorkflow(['select']).completion;
    assert.equal(result.status, 'succeeded'); assert.equal(instance.readWorkflowDiagnostic(result.id, 'select'), null);
    assert.deepEqual(instance.readCurrentStructuredOutput('select', 'value').payload, { kind: 'inline', value: expected });
  }

  // Source labels use topology only, and source paths remain distinct for the data value and the extraction pointer.
  const field = parseDocument('{}'); field.nodes.push({ id: 'content', type: 'note', position: { x: 0, y: 0 }, values: { content: '{PRIVATE_FIELD' } });
  field.execution!.nodes[0].bindings.text = { kind: 'field', nodeId: 'content', fieldId: 'content' };
  const fieldHost = hostFor(field), fieldRun = await fieldHost.enqueueWorkflow(['parse']).completion;
  const fieldIssue = s2RuntimeIssue(definition, field, 'parse', fieldHost.readWorkflowDiagnostic(fieldRun.id, 'parse'))!;
  assert.deepEqual(fieldIssue.nodeIds, ['parse', 'content']); assert.match(fieldIssue.detail, /原内容块修改/); assert.ok(!JSON.stringify(fieldIssue).includes('PRIVATE_FIELD'));
  const upstream = selectDocument({}, '/missing'); delete upstream.execution!.nodes[0].bindings.value; delete upstream.execution!.nodes[0].bindings.pointer;
  upstream.execution!.nodes.unshift(node('dataSource', 'parse-json', { text: literal('{"PRIVATE_DATA":0}') }), node('pointerSource', 'stringify', { value: literal('PRIVATE_POINTER') }));
  upstream.execution!.links.push(link('dataSource', 'value', 'select', 'value'), link('pointerSource', 'text', 'select', 'pointer'));
  const upstreamHost = hostFor(upstream), upstreamRun = await upstreamHost.enqueueWorkflow(['select']).completion;
  const upstreamDiag = upstreamHost.readWorkflowDiagnostic(upstreamRun.id, 'select')!; assert.deepEqual(upstreamDiag, diagnostic('pointer-syntax'));
  const upstreamIssue = s2RuntimeIssue(definition, upstream, 'select', upstreamDiag)!;
  assert.deepEqual(upstreamIssue.nodeIds, ['select', 'pointerSource'], 'Syntax trouble concerns the pointer source, not an unrelated successful value source');
  assert.match(upstreamIssue.detail, /提取位置来自/); assert.ok(!JSON.stringify(upstreamIssue).includes('PRIVATE_'));
  const mixed = selectDocument({}, '/missing'); mixed.nodes.push({ id: 'pointerField', type: 'note', position: { x: 0, y: 0 }, values: { content: '/PRIVATE_MISSING' } });
  mixed.execution!.nodes[0].bindings.pointer = { kind: 'field', nodeId: 'pointerField', fieldId: 'content' };
  delete mixed.execution!.nodes[0].bindings.value; mixed.execution!.nodes.unshift(node('dataSource', 'parse-json', { text: literal('{}') }));
  mixed.execution!.links.push(link('dataSource', 'value', 'select', 'value'));
  const mixedHost = hostFor(mixed), mixedRun = await mixedHost.enqueueWorkflow(['select']).completion;
  const mixedIssue = s2RuntimeIssue(definition, mixed, 'select', mixedHost.readWorkflowDiagnostic(mixedRun.id, 'select'))!;
  assert.deepEqual(mixedIssue.nodeIds, ['select', 'dataSource', 'pointerField']); assert.match(mixedIssue.detail, /要提取的数据来自/); assert.match(mixedIssue.detail, /提取位置来自/);
  assert.ok(!JSON.stringify(mixedIssue).includes('PRIVATE_MISSING'));
  let materialReads = 0; const protectedDocument = structuredClone(mixed);
  Object.defineProperty(protectedDocument.nodes[0].values, 'content', { enumerable: true, get: () => { materialReads++; throw new Error('Formatter cannot read content'); } });
  assert.ok(s2RuntimeIssue(definition, protectedDocument, 'select', mixedHost.readWorkflowDiagnostic(mixedRun.id, 'select'))); assert.equal(materialReads, 0);

  // Adapter claims/clone/tamper/foreign invocation/input substitutions never acquire native failure evidence.
  const adapters: S2LocalAdapter[] = [
    async () => ({ status: 'failed', outputs: {}, error: { code: 'TRANSFORM_REJECTED', message: 'Unexpected end of JSON input' } }),
    async (call, inputs) => structuredClone(await executeS2Structured(call, inputs)),
    async (call, inputs) => { const result = failedOutcome(await executeS2Structured(call, inputs)); result.error!.message += ' changed'; return result; },
    async (call, inputs) => executeS2Structured({ ...call, revision: call.revision + 1 }, inputs),
    async (call) => executeS2Structured(call, { text: ['{SUBSTITUTED_INPUT'] }),
  ];
  for (const adapter of adapters) {
    const instance = hostFor(parseDocument('{ORIGINAL_INPUT'), adapter), result = await instance.enqueueWorkflow(['parse']).completion;
    assert.equal(state(result, 'parse').status, 'failed'); assert.equal(instance.readWorkflowDiagnostic(result.id, 'parse'), null); assert.equal(instance.remainingCalls, 63);
  }
  // A normal trusted wrapper preserving call, inputs and the native object works; diagnosis is not based on adapter identity.
  const wrapped = hostFor(document, (call, inputs) => executeS2Structured(call, inputs));
  const wrappedRun = await wrapped.enqueueWorkflow(['parse']).completion; assert.deepEqual(wrapped.readWorkflowDiagnostic(wrappedRun.id, 'parse'), diagnostic('json-syntax'));

  // Native metadata arriving after cancellation, edits/end or timeout cannot attach to a live workflow node.
  for (const stop of ['cancel', 'edit', 'end'] as const) {
    let release!: () => void, entered!: () => void, returned!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), done = new Promise<void>(resolve => { returned = resolve; });
    const instance = hostFor(document, async (call, inputs) => { const result = await executeS2Structured(call, inputs); entered(); await gate; returned(); return result; });
    const job = instance.enqueueWorkflow(['parse']); await started;
    if (stop === 'cancel') instance.cancelWorkflow(job.id);
    else if (stop === 'end') instance.close();
    else { const changed = structuredClone(document); changed.execution!.nodes[0].bindings.text = literal('{}'); instance.setDocument(changed); }
    release(); await done; const result = await job.completion;
    assert.equal(result.status, 'cancelled'); assert.equal(instance.readWorkflowDiagnostic(job.id, 'parse'), null); assert.equal(instance.remainingCalls, 63);
  }
  let finishLate!: () => void;
  const lateReturned = new Promise<void>(resolve => { finishLate = resolve; });
  const timeout = hostFor(document, async (call, inputs) => { const result = await executeS2Structured(call, inputs); await new Promise(resolve => setTimeout(resolve, 1100)); finishLate(); return result; });
  const timedJob = timeout.enqueueWorkflow(['parse']), timedRun = await timedJob.completion;
  assert.equal(timeout.history()[0].receipt.status, 'unknown'); assert.equal(timeout.history()[0].receipt.error!.code, 'TIMEOUT');
  assert.equal(timeout.readWorkflowDiagnostic(timedRun.id, 'parse'), null); await lateReturned; assert.equal(timeout.readWorkflowDiagnostic(timedRun.id, 'parse'), null);
  assert.equal(timeout.history().length, 1); assert.equal(timeout.remainingCalls, 63);

  // Current-attempt freshness and clone isolation remain the U5 gate; editing is separate from the user's next execution request.
  const secondJob = host.enqueueWorkflow(['parse']); assert.equal(host.readWorkflowDiagnostic(first.id, 'parse'), null);
  const second = await secondJob.completion; assert.deepEqual(host.readWorkflowDiagnostic(second.id, 'parse'), diagnostic('json-syntax')); assert.equal(host.remainingCalls, 62);
  const copy = host.readWorkflowDiagnostic(second.id, 'parse'); if (copy?.kind === 'structured-transform') copy.inputPortIds.push('fake');
  assert.deepEqual(host.readWorkflowDiagnostic(second.id, 'parse'), diagnostic('json-syntax'));
  const fixed = parseDocument('{}'); host.setDocument(fixed); assert.equal(host.readWorkflowDiagnostic(second.id, 'parse'), null);
  assert.equal(host.history().length, 2); const recovered = await host.enqueueWorkflow(['down']).completion; assert.equal(recovered.status, 'succeeded');
  host.setDocument(document); assert.equal(host.readWorkflowDiagnostic(second.id, 'parse'), null, 'Undo cannot recover a stale diagnostic');
  const other = hostFor(document); assert.equal(other.readWorkflowDiagnostic(second.id, 'parse'), null);
  const last = await host.enqueueWorkflow(['parse']).completion; host.close(); assert.equal(host.readWorkflowDiagnostic(last.id, 'parse'), null);

  for (const invalid of [{ ...diagnostic('json-syntax'), inputPortIds: ['value'] }, { ...diagnostic('json-syntax'), pointer: '/PRIVATE' },
    { ...diagnostic('json-syntax'), reason: 'guessed' }, { ...diagnostic('json-syntax'), inputPortIds: ['text', 'text'] }]) assert.equal(s2RuntimeIssue(definition, document, 'parse', invalid), null);
  assert.equal(s2RuntimeIssue(definition, document, 'parse', diagnostic('pointer-syntax')), null);
  assert.equal(s2RuntimeIssue(definition, selectDocument({}, '/missing'), 'select', diagnostic('json-syntax')), null);
  assert.equal(network, 0);
  console.log('S2 transform issues passed: narrow native JSON/pointer evidence with SHA-256 invocation/input/outcome branding, no text or dynamic pointer in metadata, exact source topology, preserved TRANSFORM_REJECTED messages, policy-vs-syntax and falsy distinctions, forged/clone/tamper/foreign/input-substitution rejection, cancelled/late/timeout/current-attempt gates, private receipt linkage, no diagnostic material reads, separate repair/run, and zero external IO.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
