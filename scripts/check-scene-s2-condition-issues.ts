import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Artifact, S2Json } from '../src/types/sceneS2Plugin';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, type S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { selectS2Pointer, S2PointerAccessError } from '../src/services/scene/sceneS2Structured';
import { s2RuntimeIssue } from '../src/services/scene/sceneS2RuntimeIssues';

const cap = (capabilityId: string) => ({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId });
const plugins = [cap('parse-json'), cap('stringify'), cap('select')];
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, bindings: S2WorkflowNode['bindings'] = {}, capabilityId = 'parse-json'): S2WorkflowNode => ({
  id, ...cap(capabilityId), position: { x: 0, y: 0 }, bindings, presentation: { label: id === 'target' ? '确认条件后处理' : '同名步骤' },
});
const definition = readS2Definition({ version: 1, goal: '只解释运行条件不可判定的真实原因',
  instructions: { understanding: '先理解', planning: '不自动修复', response: '不可判定不是不成立' }, plugins,
  blockTypes: [{ id: 'note', label: '练习笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
function documentFor(value: S2Json = {}, pointer = '/missing', equals: S2Json = 'PRIVATE_COMPARISON', match = true): S2Document {
  return readS2Document({ nodes: [], edges: [], execution: { version: 1, nodes: [
    node('source', { text: literal(JSON.stringify(value)) }),
    { ...node('target', { text: literal('{"PRIVATE_TARGET":true}') }), when: { nodeId: 'source', portId: 'value', pointer, equals, match } },
    node('down', {}, 'stringify'),
  ], links: [{ source: { nodeId: 'target', portId: 'value' }, target: { nodeId: 'down', portId: 'value' } }] } }, definition);
}
const state = (run: S2WorkflowRun, id: string) => run.nodes.find(item => item.nodeId === id)!;
const hosts: S2PluginHost[] = [];
function hostFor(document: S2Document, adapter?: ConstructorParameters<typeof S2PluginHost>[2]) {
  const host = new S2PluginHost('condition-issues-synthetic', definition, adapter); hosts.push(host); host.setDocument(document); return host;
}
const expectedDiagnostic = (pointer: string, reason: 'pointer-missing' | 'source-output-unavailable' | 'inline-data-unavailable' = 'pointer-missing') => ({
  kind: 'condition-unavailable', reason, sourceNodeId: 'source', sourcePortId: 'value', pointer,
});
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic condition diagnostics must not perform external IO'); };
try {
  // The native failure discriminator keeps old messages/name and converter behavior, without parsing an error message.
  for (const [value, pointer] of [[{}, '/missing'], [null, '/a'], [false, '/a'], [0, '/a'], [{ items: [] }, '/items/2']] as Array<[S2Json, string]>) {
    assert.throws(() => selectS2Pointer(value, pointer), (error: unknown) => error instanceof S2PointerAccessError
      && error.reason === 'missing' && error.pointer === pointer && error.name === 'Error'
      && error.message === `JSON Pointer 路径不存在或不能访问：${pointer.slice(0, 200)}`);
  }
  for (const [value, pointer] of [[{}, '/__proto__'], [{}, '/constructor'], [{}, '/prototype'], [[], '/01'], [[], '/-'], [[], '/length']] as Array<[S2Json, string]>) {
    assert.throws(() => selectS2Pointer(value, pointer), (error: unknown) => error instanceof S2PointerAccessError && error.reason === 'inaccessible' && error.name === 'Error');
  }
  for (const pointer of ['not-a-pointer', '/bad~2']) assert.throws(() => selectS2Pointer({}, pointer), (error: unknown) => error instanceof Error && !(error instanceof S2PointerAccessError));
  assert.equal(selectS2Pointer({ '~1': 0 }, '/~01'), 0); assert.equal(selectS2Pointer({ 'a/b': { '~key': false } }, '/a~1b/~0key'), false);
  assert.equal(selectS2Pointer({ '': null }, '/'), null); assert.equal(selectS2Pointer({ '01': false }, '/01'), false);

  const document = documentFor({ PRIVATE_SOURCE: true }), beforeDocument = JSON.stringify(document), host = hostFor(document);
  const first = await host.enqueueWorkflow(['down']).completion;
  assert.equal(first.status, 'failed'); assert.equal(state(first, 'source').status, 'succeeded'); assert.equal(state(first, 'target').status, 'blocked');
  assert.equal(state(first, 'down').status, 'blocked'); assert.equal(host.remainingCalls, 63);
  assert.equal(host.history().length, 1); assert.equal(host.history().some(entry => entry.request.nodeId === 'target'), false);
  assert.equal(state(first, 'target').error, 'JSON Pointer 路径不存在或不能访问：/missing');
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'target'), expectedDiagnostic('/missing'));
  const issue = s2RuntimeIssue(definition, document, 'target', host.readWorkflowDiagnostic(first.id, 'target'))!;
  assert.equal(issue.kind, 'condition-unavailable'); assert.deepEqual(issue.nodeIds, ['target', 'source'], 'Condition source does not need a data link');
  assert.match(issue.summary, /"missing"/); assert.match(issue.detail, /不是条件不成立/); assert.match(issue.detail, /上游可能已经运行并消耗次数/);
  assert.ok(!issue.detail.includes('该条件来源为模拟结果'));
  assert.ok(!JSON.stringify([issue, host.readWorkflowDiagnostic(first.id, 'target')]).includes('PRIVATE_'));
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'down'), { kind: 'upstream-unavailable', sourceNodeIds: ['target'] });
  // Reading/formatting a diagnostic does not resolve any artifact or re-run the condition; returned clones are detached.
  const beforeRead = JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]);
  const originalArtifactRead = host.currentArtifact; host.currentArtifact = () => { throw new Error('Diagnostic may not inspect artifact values'); };
  try { assert.ok(s2RuntimeIssue(definition, document, 'target', host.readWorkflowDiagnostic(first.id, 'target'))); } finally { host.currentArtifact = originalArtifactRead; }
  const clone = host.readWorkflowDiagnostic(first.id, 'target')!; if (clone.kind === 'condition-unavailable') clone.pointer = '/changed';
  assert.deepEqual(host.readWorkflowDiagnostic(first.id, 'target'), expectedDiagnostic('/missing'));
  assert.equal(JSON.stringify([host.history(), host.workflowHistory(), host.remainingCalls]), beforeRead); assert.equal(JSON.stringify(document), beforeDocument);

  // Full public pointer is preserved, including long paths, empty keys, escapes and ambiguous numeric tokens; comparison values never appear.
  const longKey = '路径'.repeat(140), fullPointer = `/${longKey}/tail`;
  const pathCases: Array<[S2Json, string, string[]]> = [
    [{}, '/', ['""']], [{}, '/a~1b/~0key', ['"a/b"', '"~key"']], [{}, '/~01', ['"~1"']],
    [{}, '/01', ['"01"']], [{}, fullPointer, [longKey, '"tail"']], [{ item: false }, '/item/deeper', ['"item"', '"deeper"']],
  ];
  for (const [value, pointer, expectedParts] of pathCases) {
    const doc = documentFor(value, pointer), instance = hostFor(doc), run = await instance.enqueueWorkflow(['target']).completion;
    const diagnostic = instance.readWorkflowDiagnostic(run.id, 'target'); assert.deepEqual(diagnostic, expectedDiagnostic(pointer));
    const display = s2RuntimeIssue(definition, doc, 'target', diagnostic)!; assert.ok(display);
    for (const part of expectedParts) assert.ok(display.summary.includes(part), `Must preserve full path segment ${part}`);
    assert.equal(JSON.parse(display.technical).pointer, pointer); assert.equal(instance.remainingCalls, 63);
  }
  // Present native falsy values and root/empty/escaped/numeric keys are valid; nonmatching means skipped, never blocked or diagnosed missing.
  const validCases: Array<[S2Json, string, S2Json]> = [
    [{ value: false }, '/value', false], [{ value: 0 }, '/value', 0], [{ value: null }, '/value', null],
    [false, '', false], [0, '', 0], [null, '', null], [{ '': null }, '/', null],
    [{ 'a/b': { '~key': 0 } }, '/a~1b/~0key', 0], [{ '~1': false }, '/~01', false], [{ '01': false }, '/01', false], [[0], '/0', 0],
  ];
  for (const [value, pointer, equals] of validCases) {
    const doc = documentFor(value, pointer, equals), instance = hostFor(doc), run = await instance.enqueueWorkflow(['target']).completion;
    assert.equal(state(run, 'target').status, 'succeeded'); assert.equal(instance.readWorkflowDiagnostic(run.id, 'target'), null); assert.equal(instance.remainingCalls, 62);
    const notMatched = documentFor(value, pointer, equals, false), skipHost = hostFor(notMatched), skipped = await skipHost.enqueueWorkflow(['target']).completion;
    assert.equal(state(skipped, 'target').status, 'skipped'); assert.equal(skipHost.readWorkflowDiagnostic(skipped.id, 'target'), null); assert.equal(skipHost.remainingCalls, 63);
  }
  for (const [value, pointer] of [[{}, '/__proto__'], [{}, '/constructor'], [{}, '/prototype'], [[], '/01'], [[], '/-'], [[], '/length']] as Array<[S2Json, string]>) {
    const instance = hostFor(documentFor(value, pointer)), run = await instance.enqueueWorkflow(['target']).completion;
    assert.equal(state(run, 'target').status, 'blocked'); assert.equal(instance.readWorkflowDiagnostic(run.id, 'target'), null, 'Inaccessible keys and noncanonical array indices are not reported as definitely missing fields');
  }

  // Failed/blocked source is different from a missing path. Skipped source keeps native skipped propagation.
  const failedSource = documentFor({}, '/value'); failedSource.execution!.nodes[0].bindings.text = literal('{bad PRIVATE_INPUT');
  const failedHost = hostFor(failedSource), failed = await failedHost.enqueueWorkflow(['target']).completion;
  assert.equal(state(failed, 'source').status, 'failed'); assert.equal(state(failed, 'target').status, 'blocked');
  assert.deepEqual(failedHost.readWorkflowDiagnostic(failed.id, 'target'), expectedDiagnostic('/value', 'source-output-unavailable'));
  const failedDisplay = s2RuntimeIssue(definition, failedSource, 'target', failedHost.readWorkflowDiagnostic(failed.id, 'target'))!;
  assert.match(failedDisplay.detail, /不是已经确认路径缺失/); assert.ok(!JSON.stringify(failedDisplay).includes('PRIVATE_')); assert.equal(failedHost.remainingCalls, 63);
  const chained = documentFor({}, '/value'); chained.execution!.nodes.unshift(node('root', { text: literal('{}') }));
  chained.execution!.nodes.find(item => item.id === 'source')!.when = { nodeId: 'root', portId: 'value', pointer: '/missing', equals: true, match: true };
  const chainedHost = hostFor(chained), chainedRun = await chainedHost.enqueueWorkflow(['target']).completion;
  assert.equal(state(chainedRun, 'source').status, 'blocked'); assert.deepEqual(chainedHost.readWorkflowDiagnostic(chainedRun.id, 'target'), expectedDiagnostic('/value', 'source-output-unavailable'));
  const skipSource = structuredClone(chained); skipSource.execution!.nodes.find(item => item.id === 'source')!.when = { nodeId: 'root', portId: 'value', pointer: '', equals: {}, match: false };
  const skipSourceHost = hostFor(skipSource), skipRun = await skipSourceHost.enqueueWorkflow(['target']).completion;
  assert.equal(state(skipRun, 'source').status, 'skipped'); assert.equal(state(skipRun, 'target').status, 'skipped'); assert.equal(skipSourceHost.readWorkflowDiagnostic(skipRun.id, 'target'), null);

  // Real plugin outcomes with reference data cannot currently publish without a host resolver. Preserve that fail-closed upstream boundary.
  const refDoc = documentFor({}, '/field'), referenceHost = hostFor(refDoc, async call => ({ status: 'succeeded', outputs: { value: [{
    protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'structured-data.value', version: 1 }, complete: true,
    source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id },
    payload: { kind: 'reference', artifactRef: 'synthetic-reference', bytes: 2, sha256: '0'.repeat(64) },
  } as S2Artifact] } }));
  const referenceRun = await referenceHost.enqueueWorkflow(['target']).completion;
  assert.equal(state(referenceRun, 'source').status, 'failed'); assert.deepEqual(referenceHost.readWorkflowDiagnostic(referenceRun.id, 'target'), expectedDiagnostic('/field', 'source-output-unavailable'));
  // Explicit test seam only: exercise the existing non-inline defensive branch without weakening artifact validation or pretending builtin reachability.
  const defensive = hostFor(refDoc), actualRead = defensive.currentArtifact.bind(defensive);
  defensive.currentArtifact = (id: string) => {
    const artifact = actualRead(id);
    return artifact.source.nodeId === 'source' && artifact.type.id === 'structured-data.value'
      ? { ...artifact, payload: { kind: 'reference', artifactRef: 'synthetic-defensive-reference', bytes: 2, sha256: '0'.repeat(64) } } : artifact;
  };
  const defensiveRun = await defensive.enqueueWorkflow(['target']).completion;
  assert.equal(state(defensiveRun, 'source').status, 'succeeded'); assert.equal(state(defensiveRun, 'target').status, 'blocked');
  assert.deepEqual(defensive.readWorkflowDiagnostic(defensiveRun.id, 'target'), expectedDiagnostic('/field', 'inline-data-unavailable'));
  assert.match(s2RuntimeIssue(definition, refDoc, 'target', defensive.readWorkflowDiagnostic(defensiveRun.id, 'target'))!.detail, /不会为诊断自动读取/);
  assert.equal(defensive.remainingCalls, 63);

  // Simulation provenance comes from the registered output type, not from reading samples or claiming a real business outcome.
  const simulationCapability = { pluginId: 'workflow-simulation', pluginVersion: '1.0.0', capabilityId: 'step' };
  const simulationDefinition = readS2Definition({ ...definition, plugins: [...plugins, simulationCapability] });
  const simulationDocument = documentFor({}, '/steps/0/output/missing');
  simulationDocument.execution!.nodes[0] = { ...node('source'), ...simulationCapability, bindings: {
    purpose: literal('合成业务步骤'), assumptions: literal('仅预设示例，不执行真实业务'), sample: literal({ PRIVATE_SIMULATION: true }),
  } };
  simulationDocument.execution!.nodes.find(item => item.id === 'target')!.when!.portId = 'result';
  const simulationHost = new S2PluginHost('condition-simulation-synthetic', simulationDefinition); hosts.push(simulationHost);
  simulationHost.setDocument(readS2Document(simulationDocument, simulationDefinition));
  const simulationRun = await simulationHost.enqueueWorkflow(['target']).completion;
  const simulationIssue = s2RuntimeIssue(simulationDefinition, simulationDocument, 'target', simulationHost.readWorkflowDiagnostic(simulationRun.id, 'target'))!;
  assert.equal(simulationIssue.kind, 'condition-unavailable'); assert.match(simulationIssue.detail, /该条件来源为模拟结果，不能证明真实业务已发生或已达标/);
  assert.ok(!JSON.stringify(simulationIssue).includes('PRIVATE_SIMULATION')); assert.equal(simulationHost.remainingCalls, 63);

  // Former condition diagnostics cannot navigate after requeue, partial retry, edit/undo, another host or session end.
  const repeatJob = host.enqueueWorkflow(['target']); assert.equal(host.readWorkflowDiagnostic(first.id, 'target'), null);
  const repeated = await repeatJob.completion; assert.equal(state(repeated, 'source').status, 'cached'); assert.equal(host.remainingCalls, 63);
  assert.ok(host.readWorkflowDiagnostic(repeated.id, 'target'));
  const sourceRetry = host.enqueueWorkflow(['source']); assert.equal(host.readWorkflowDiagnostic(repeated.id, 'target'), null); await sourceRetry.completion;
  const latest = await host.enqueueWorkflow(['target']).completion;
  const otherHost = hostFor(document); assert.equal(otherHost.readWorkflowDiagnostic(latest.id, 'target'), null);
  const changed = structuredClone(document); changed.execution!.nodes.find(item => item.id === 'target')!.when!.pointer = '';
  host.setDocument(changed); host.setDocument(document); assert.equal(host.readWorkflowDiagnostic(latest.id, 'target'), null);
  const ending = await host.enqueueWorkflow(['target']).completion; assert.ok(host.readWorkflowDiagnostic(ending.id, 'target')); host.close(); assert.equal(host.readWorkflowDiagnostic(ending.id, 'target'), null);

  // No guessed output paths, topology, comparison values or hostile getter execution in metadata formatting.
  const raw = expectedDiagnostic('/missing');
  for (const invalid of [{ ...raw, sourceNodeId: 'down' }, { ...raw, sourcePortId: 'text' }, { ...raw, pointer: '/other' },
    { ...raw, reason: 'guessed' }, { ...raw, equals: 'PRIVATE_VALUE' }, { ...raw, pointer: '' }, { ...raw, payload: { PRIVATE_VALUE: true } }]) {
    assert.equal(s2RuntimeIssue(definition, document, 'target', invalid), null);
  }
  const noCondition = structuredClone(document); delete noCondition.execution!.nodes.find(item => item.id === 'target')!.when;
  assert.equal(s2RuntimeIssue(definition, noCondition, 'target', raw), null);
  let getterReads = 0; const hostile = { ...raw }; Object.defineProperty(hostile, 'pointer', { enumerable: true, get: () => { getterReads++; return '/missing'; } });
  assert.equal(s2RuntimeIssue(definition, document, 'target', hostile), null); assert.equal(getterReads, 0);
  // Non-condition structured select retains the same normal failed outcome and message, without a condition diagnosis.
  const selectDoc: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [node('select', { value: literal({}), pointer: literal('/missing') }, 'select')], links: [] } };
  const selectHost = hostFor(selectDoc), selected = await selectHost.enqueueWorkflow(['select']).completion;
  assert.equal(state(selected, 'select').status, 'failed');
  assert.deepEqual(selectHost.readWorkflowDiagnostic(selected.id, 'select'), { kind: 'structured-transform', reason: 'pointer-missing', inputPortIds: ['value', 'pointer'] });
  assert.equal(selectHost.history()[0].receipt.error!.code, 'TRANSFORM_REJECTED');
  assert.equal(selectHost.history()[0].receipt.error!.message, 'JSON Pointer 路径不存在或不能访问：/missing');
  assert.equal(network, 0);
  console.log('S2 condition issues passed: native missing vs inaccessible pointer discrimination, unchanged converter failures, exact current condition source/path metadata, full escaped/empty/long/numeric path labels without values, false/0/null and root validity, matched/skipped/blocked separation, source-failure and non-inline defensive cases, unchanged budgets/dispatch, current-attempt retirement, no artifact reads during diagnostics and zero IO.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
