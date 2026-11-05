import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';
import { s2RuntimeIssue, s2WorkflowPreflightIssue } from '../src/services/scene/sceneS2RuntimeIssues';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const plugins = [cap('parse-json'), cap('stringify'), cap('merge-json', 'workflow-merge'), cap('json-tree', 'structured-view')];
const literal = (value: any) => ({ kind: 'literal' as const, value });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({
  id, ...cap(capabilityId, pluginId), position: { x: 0, y: 0 }, bindings, presentation: { label: id === 'merge' ? '唯一结果转交' : '同名处理' },
});
const link = (source: string, sourcePort: string, target: string, targetPort: string) => ({ source: { nodeId: source, portId: sourcePort }, target: { nodeId: target, portId: targetPort } });
const definition = readS2Definition({ version: 1, goal: '运行诊断仅定位，不替用户改变流程',
  instructions: { understanding: '理解要求', planning: '不自动执行', response: '分清未开始与上游已运行' }, plugins,
  blockTypes: [{ id: 'note', label: '练习内容', fields: [{ id: 'content', label: '原文', kind: 'multiline' }] }],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
function makeDocument() {
  return readS2Document({ nodes: [], edges: [], execution: { version: 1, nodes: [
    node('condition', 'parse-json', { text: literal('true') }),
    { ...node('left', 'parse-json', { text: literal('{"PRIVATE_SOURCE":"equal"}') }), when: { nodeId: 'condition', portId: 'value', pointer: '', equals: true, match: true } },
    { ...node('right', 'parse-json', { text: literal('{"PRIVATE_SOURCE":"equal"}') }), when: { nodeId: 'condition', portId: 'value', pointer: '', equals: true, match: true } },
    node('merge', 'merge-json', {}, 'workflow-merge'), node('view', 'json-tree', {}, 'structured-view'),
  ], links: [link('left', 'value', 'merge', 'candidates'), link('right', 'value', 'merge', 'candidates'), link('merge', 'selected', 'view', 'value')] } }, definition);
}
const state = (run: S2WorkflowRun, id: string) => run.nodes.find(item => item.nodeId === id)!;
const hosts: S2PluginHost[] = [];
function hostFor(document: S2Document) { const host = new S2PluginHost('runtime-issues-synthetic', definition); hosts.push(host); host.setDocument(document); return host; }
function failure(document: S2Document, targets?: string[]): unknown {
  try { selectS2Execution(document, plugins, targets); assert.fail('Expected synthetic preflight failure'); } catch (error) { return error; }
}
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Runtime diagnostics must not call external IO'); };
try {
  const missing: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [node('missing', 'parse-json'), node('other', 'parse-json'), node('down', 'stringify')],
    links: [link('missing', 'value', 'down', 'value')] } };
  const hostMissing = hostFor(missing), beforeMissing = JSON.stringify(missing);
  let missingError: unknown; try { hostMissing.enqueueWorkflow(['down']); } catch (error) { missingError = error; }
  assert.ok(missingError instanceof S2PluginProtocolError); assert.equal(missingError.field, 'missing.text');
  const missingIssue = s2WorkflowPreflightIssue(definition, missing, ['down'], missingError)!;
  assert.equal(missingIssue.kind, 'missing-input'); assert.deepEqual(missingIssue.nodeIds, ['missing']); assert.match(missingIssue.summary, /同名处理.*步骤 1/);
  assert.equal(hostMissing.remainingCalls, 64); assert.equal(hostMissing.history().length, 0); assert.equal(hostMissing.workflowHistory().length, 0);
  assert.equal(JSON.stringify(missing), beforeMissing);
  assert.equal(s2WorkflowPreflightIssue(definition, missing, ['other'], missingError), null, 'A missing item outside the selected ancestors must not be advertised');
  const secondError = new S2PluginProtocolError('MISSING_INPUT', 'other.text', '必填输入未连接或提供');
  assert.equal(s2WorkflowPreflightIssue(definition, missing, undefined, secondError), null, 'Only the actual first native missing port can be located');
  for (const error of [new Error('missing.text'), { code: 'MISSING_INPUT', field: 'missing.text' },
    new S2PluginProtocolError('MISSING_INPUT', 'link', '可缺省输出不能保证必填输入'),
    new S2PluginProtocolError('MISSING_INPUT', 'missing.fake', '必填输入未连接或提供'),
    new S2PluginProtocolError('INVALID_DATA', 'missing.text', '必填输入未连接或提供')]) assert.equal(s2WorkflowPreflightIssue(definition, missing, ['down'], error), null);
  // Native falsy literals and existing field bindings are present, not missing. Field values are not read by the diagnostic formatter.
  for (const value of [false, 0, null]) {
    const filled: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [node('filled', 'stringify', { value: literal(value) })], links: [] } };
    assert.doesNotThrow(() => selectS2Execution(filled, plugins));
    assert.equal(s2WorkflowPreflightIssue(definition, filled, undefined, new S2PluginProtocolError('MISSING_INPUT', 'filled.value', '必填输入未连接或提供')), null);
  }
  const field: S2Document = { nodes: [{ id: 'content', type: 'note', position: { x: 0, y: 0 }, values: { content: 'PRIVATE_FIELD' } }], edges: [],
    execution: { version: 1, nodes: [node('field', 'parse-json', { text: { kind: 'field', nodeId: 'content', fieldId: 'content' } })], links: [] } };
  assert.equal(s2WorkflowPreflightIssue(definition, field, undefined, new S2PluginProtocolError('MISSING_INPUT', 'field.text', '必填输入未连接或提供')), null);

  const document = makeDocument(), original = JSON.stringify(document), host = hostFor(document);
  const first = await host.enqueueWorkflow(['view']).completion;
  assert.equal(first.status, 'failed'); assert.equal(state(first, 'merge').status, 'failed'); assert.equal(state(first, 'view').status, 'blocked');
  assert.equal(host.remainingCalls, 61, 'Only the three upstream parse nodes execute; merge never invokes or refunds');
  assert.equal(host.history().some(item => item.request.nodeId === 'merge'), false);
  const diagnostic = host.readWorkflowDiagnostic(first.id, 'merge')!;
  assert.equal(diagnostic.kind, 'merge-conflict');
  assert.deepEqual(diagnostic, { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['left', 'right'], boundInput: false });
  const issue = s2RuntimeIssue(definition, document, 'merge', diagnostic)!;
  assert.equal(issue.kind, 'merge-conflict'); assert.deepEqual(issue.nodeIds, ['merge', 'left', 'right']);
  assert.match(issue.summary, /2 份/); assert.match(issue.detail, /上游可能已经运行并消耗次数/);
  assert.ok(!JSON.stringify([diagnostic, issue]).includes('PRIVATE_')); assert.ok(!JSON.stringify(diagnostic).includes('artifact'));
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'view'), { kind: 'upstream-unavailable', sourceNodeIds: ['merge'] });
  const downstreamIssue = s2RuntimeIssue(definition, document, 'view', host.readWorkflowDiagnostic(first.id, 'view'))!;
  assert.equal(downstreamIssue.kind, 'upstream-unavailable'); assert.deepEqual(downstreamIssue.nodeIds, ['view', 'merge']);
  assert.equal(host.readWorkflowDiagnostic(first.id, 'left'), null); assert.equal(host.readWorkflowDiagnostic('foreign', 'merge'), null);
  const otherHost = hostFor(document); assert.equal(otherHost.readWorkflowDiagnostic(first.id, 'merge'), null);
  // Retrieval must never resolve the artifacts. Changing returned clones cannot modify host-owned proof.
  const beforeRead = JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]);
  const currentArtifact = host.currentArtifact; host.currentArtifact = () => { throw new Error('Metadata read must not resolve artifacts'); };
  try { assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'merge'), diagnostic); } finally { host.currentArtifact = currentArtifact; }
  diagnostic.sourceNodeIds.push('PRIVATE_MUTATION');
  const currentDiagnostic = host.readWorkflowDiagnostic(first.id, 'merge')!;
  assert.equal(currentDiagnostic.kind, 'merge-conflict'); assert.equal(currentDiagnostic.sourceNodeIds.length, 2);
  const historyClone = host.workflowHistory(), historyDiagnostic = state(historyClone[0], 'merge').diagnostic!;
  assert.equal(historyDiagnostic.kind, 'merge-conflict'); historyDiagnostic.sourceNodeIds.push('PRIVATE_HISTORY_MUTATION');
  const afterCloneMutation = host.readWorkflowDiagnostic(first.id, 'merge')!;
  assert.equal(afterCloneMutation.kind, 'merge-conflict'); assert.equal(afterCloneMutation.sourceNodeIds.length, 2);
  assert.equal(JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]), beforeRead); assert.equal(JSON.stringify(document), original);
  // Requeue retires old diagnostic immediately, even before the new run starts. Cached sources still count as this attempt's separate candidates.
  const nextJob = host.enqueueWorkflow(['view']); assert.equal(host.readWorkflowDiagnostic(first.id, 'merge'), null);
  const repeated = await nextJob.completion;
  assert.equal(host.remainingCalls, 61); assert.equal(state(repeated, 'left').status, 'cached'); assert.equal(state(repeated, 'right').status, 'cached');
  assert.deepEqual(host.readWorkflowDiagnostic(repeated.id, 'merge'), { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['left', 'right'], boundInput: false });
  // A reattempt of any dependency conservatively retires the whole prior job's navigation; cancelling does not resurrect it.
  const sourceOnly = host.enqueueWorkflow(['left']); assert.equal(host.readWorkflowDiagnostic(repeated.id, 'merge'), null);
  host.cancelWorkflow(sourceOnly.id); await sourceOnly.completion; assert.equal(host.readWorkflowDiagnostic(repeated.id, 'merge'), null);
  const last = await host.enqueueWorkflow(['view']).completion; assert.ok(host.readWorkflowDiagnostic(last.id, 'merge'));
  const modified = structuredClone(document); modified.execution!.nodes.find(item => item.id === 'right')!.when!.match = false;
  host.setDocument(modified); assert.equal(host.readWorkflowDiagnostic(last.id, 'merge'), null);
  const successful = await host.enqueueWorkflow(['view']).completion; assert.equal(successful.status, 'succeeded');
  assert.equal(host.readWorkflowDiagnostic(successful.id, 'merge'), null);
  host.setDocument(document); assert.equal(host.readWorkflowDiagnostic(last.id, 'merge'), null, 'Undo to identical content cannot restore previous revision proof');
  const fresh = await host.enqueueWorkflow(['view']).completion; assert.ok(host.readWorkflowDiagnostic(fresh.id, 'merge'));
  host.close(); assert.equal(host.readWorkflowDiagnostic(fresh.id, 'merge'), null);

  // One fixed candidate plus one live branch is still two candidates, even for native false/0/null; skipped branches do not count.
  for (const value of [false, 0, null]) {
    const bound = structuredClone(modified); bound.execution!.nodes.find(item => item.id === 'merge')!.bindings.candidates = literal(value);
    const boundHost = hostFor(bound), result = await boundHost.enqueueWorkflow(['view']).completion;
    const data = boundHost.readWorkflowDiagnostic(result.id, 'merge')!;
    assert.deepEqual(data, { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['left'], boundInput: true });
    assert.match(s2RuntimeIssue(definition, bound, 'merge', data)!.detail, /已填写的一份内容/);
    assert.equal(boundHost.history().some(item => item.request.nodeId === 'merge'), false);
  }
  const invalidField = structuredClone(document); invalidField.nodes = field.nodes;
  invalidField.execution!.nodes.find(item => item.id === 'merge')!.bindings.candidates = { kind: 'field', nodeId: 'content', fieldId: 'content' };
  const invalidFieldHost = hostFor(invalidField); assert.throws(() => invalidFieldHost.enqueueWorkflow(['view']), /字段引用类型不符/);
  assert.equal(invalidFieldHost.workflowHistory().length, 0, 'Text fields are not implicit JSON merge candidates');
  assert.equal(s2WorkflowPreflightIssue(definition, invalidField, ['view'], failure(invalidField, ['view'])), null);

  // A failed branch blocks merge even if another branch supplied a value. It must not be diagnosed as an exclusive-choice conflict.
  const broken = structuredClone(document); broken.execution!.nodes.find(item => item.id === 'left')!.bindings.text = literal('{bad PRIVATE_FAILURE');
  const brokenHost = hostFor(broken), brokenRun = await brokenHost.enqueueWorkflow(['view']).completion;
  assert.equal(state(brokenRun, 'merge').status, 'blocked');
  assert.deepEqual(brokenHost.readWorkflowDiagnostic(brokenRun.id, 'merge'), { kind: 'upstream-unavailable', sourceNodeIds: ['left'] });
  assert.deepEqual(brokenHost.readWorkflowDiagnostic(brokenRun.id, 'left'), { kind: 'structured-transform', reason: 'json-syntax', inputPortIds: ['text'] }, 'Native parse failures have their own diagnosis, not a guessed merge failure');
  const skipped = structuredClone(document); skipped.execution!.nodes.filter(item => item.when).forEach(item => { item.when!.match = false; });
  const skippedHost = hostFor(skipped), skippedRun = await skippedHost.enqueueWorkflow(['view']).completion;
  assert.equal(state(skippedRun, 'merge').status, 'skipped'); assert.equal(skippedHost.readWorkflowDiagnostic(skippedRun.id, 'merge'), null);

  // Formatter accepts only bounded metadata consistent with current graph endpoints; no arbitrary value-bearing error echo.
  for (const bad of [null, {}, { kind: 'unknown' }, { kind: 'merge-conflict', candidateCount: 1, sourceNodeIds: ['left'], boundInput: false },
    { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['left', 'left'], boundInput: false },
    { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['condition'], boundInput: false },
    { kind: 'merge-conflict', candidateCount: 2, sourceNodeIds: ['left', 'right'], boundInput: false, value: 'PRIVATE_SECRET' },
    { kind: 'upstream-unavailable', sourceNodeIds: ['absent'] }]) assert.equal(s2RuntimeIssue(definition, document, 'merge', bad), null);
  let reads = 0; const hostile = { kind: 'merge-conflict', candidateCount: 2, boundInput: false };
  Object.defineProperty(hostile, 'sourceNodeIds', { enumerable: true, get: () => { reads++; return ['left', 'right']; } });
  assert.equal(s2RuntimeIssue(definition, document, 'merge', hostile), null); assert.equal(reads, 0);
  assert.equal(network, 0);
  console.log('S2 runtime issues passed: exact selected-scope first missing-input, native falsy/field presence, fresh host-owned merge/upstream metadata, equal and literal candidate counting, no merge invocation on conflict, cache/requeue/partial retry/cancel/revision/undo/end/foreign-host freshness, clone isolation, fail/skip distinctions, bounded no-value formatting and zero IO or automatic execution.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
