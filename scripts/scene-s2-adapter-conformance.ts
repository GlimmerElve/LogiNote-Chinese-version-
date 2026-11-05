import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2PluginOutcome, S2PluginRequest } from '../src/types/sceneS2Plugin';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT, type S2LocalAdapter } from '../src/services/scene/sceneS2PluginHost';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry, s2CapabilityKey } from '../src/services/scene/sceneS2PluginRegistry';
import { isS2ExclusiveMerge } from '../src/services/scene/sceneS2Merge';
import type { S2LocalAdapterFixture } from './scene-s2-adapter-fixtures';

const registry = s2BuiltinPluginRegistry(), installation = s2BuiltinPluginInstallation();
const strategy = { goal: '适配器接入合规', understanding: '仅合成数据', planning: '明确请求后执行', response: '不将执行成功当作业务通过' };
const actual: S2LocalAdapter = (call, inputs, signal) => installation.execute(call, inputs, signal);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Conformance watchdog: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Test-only harness against the production host and installed handlers. No runtime registry/permission injection.
 * Each fixture uses complete inline values, with at most one literal per port; multi-source graph tests remain separate.
 * Faults and uncooperative late returns deliberately use the trusted adapter TEST seam, never scene/model input.
 */
export async function checkS2LocalAdapterConformance(fixture: S2LocalAdapterFixture) {
  const { binding } = fixture, label = s2CapabilityKey(binding), cap = registry.capability(binding);
  assert.equal(installation.descriptor(binding).kind, 'local', label);
  const expectedInputs = Object.fromEntries(cap.inputs.map(port => [port.id, structuredClone(fixture.inputs[port.id] ?? [])]));
  assert.ok(Object.keys(fixture.inputs).every(id => cap.inputs.some(port => port.id === id)), `${label}: unknown fixture input`);
  const bindings: S2WorkflowNode['bindings'] = {};
  for (const port of cap.inputs) {
    const values = expectedInputs[port.id];
    assert.ok(values.length <= 1 && (!port.required || values.length === 1), `${label}: fixture needs complete single literal inputs`);
    if (values.length) bindings[port.id] = { kind: 'literal', value: structuredClone(values[0]) };
  }
  const node: S2WorkflowNode = { id: 'target', ...binding, position: { x: 0, y: 0 }, bindings };
  const document: S2Document = {
    nodes: [{ id: 'context', type: 'text', position: { x: 0, y: 100 }, values: { content: '合成接入测试 v1' } }], edges: [],
    execution: { version: 1, nodes: [node], links: [] },
  };
  const cases: string[] = [];
  async function test(name: string, adapter: S2LocalAdapter, check: (host: S2PluginHost) => Promise<void>, allowed = true) {
    const host = new S2PluginHost('adapter-conformance', allowed ? [binding] : [], adapter);
    try { host.setDocument(document); await check(host); cases.push(name); }
    catch (error) { throw new Error(`${label} / ${name}`, { cause: error }); }
    finally { host.close(); }
  }
  function single(host: S2PluginHost) {
    const entries = host.history(); assert.equal(entries.length, 1);
    assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1, 'Started call is charged exactly once, even on failure');
    return entries[0];
  }
  function unpublished(host: S2PluginHost, raw?: S2PluginOutcome) {
    const result = single(host); assert.deepEqual(result.artifacts, []); assert.deepEqual(result.observation.artifacts, []);
    assert.deepEqual(result.receipt.outputArtifactIds, {});
    if (raw?.status === 'succeeded') for (const artifact of Object.values(raw.outputs).flat())
      assert.throws(() => host.currentArtifact(artifact.id), 'Unvalidated or late artifact must never become a host input');
    const indexed = host.prepare('target', strategy, '只查看结果').outputIndex.filter(item => item.nodeId === 'target');
    assert.equal(indexed.length, cap.outputs.length);
    assert.ok(indexed.every(item => item.artifactIds.length === 0));
    return result;
  }
  let calls = 0, realOutput: S2PluginOutcome | undefined;
  await test('complete-data-and-snapshots', async (call, inputs, signal) => {
    calls++; assert.deepEqual(inputs, expectedInputs, 'Native values must reach the real handler without string coercion');
    realOutput = await actual(call, inputs, signal) as S2PluginOutcome; return realOutput;
  }, async host => {
    const run = await host.enqueueWorkflow(['target']).completion;
    assert.equal(run.status, 'succeeded'); assert.equal(calls, 1);
    const result = single(host); assert.equal(result.receipt.status, 'succeeded'); assert.equal(result.receipt.publication, 'current');
    assert.ok(result.artifacts.length > 0);
    for (const artifact of result.artifacts) {
      assert.equal(artifact.complete, true); assert.equal(artifact.source.invocationId, result.receipt.invocationId);
      assert.equal(artifact.source.runId, host.runId); assert.equal(artifact.source.kind, 'plugin');
      assert.deepEqual(host.currentArtifact(artifact.id), artifact);
    }
    const before = host.history();
    assert.equal(realOutput?.status, 'succeeded');
    if (realOutput?.status !== 'succeeded') assert.fail('Real adapter must produce a success fixture');
    Object.values(realOutput.outputs).flat()[0].payload = { kind: 'inline', value: 'mutated adapter-owned data' };
    result.artifacts[0].payload = { kind: 'inline', value: 'mutated caller-owned data' };
    result.receipt.status = 'failed';
    assert.deepEqual(host.history(), before, 'Neither adapter nor caller may change stored facts after return');
  });
  calls = 0;
  await test('no-grant-no-dispatch', async (...args) => { calls++; return actual(...args); }, async host => {
    await assert.rejects(async () => host.enqueueWorkflow(['target']).completion);
    assert.equal(calls, 0); assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(host.history(), []);
  }, false);

  for (const fault of ['missing-output', 'partial-output', 'throw'] as const) {
    let raw: S2PluginOutcome | undefined, dispatches = 0;
    await test(fault, async (call, inputs, signal) => {
      dispatches++;
      if (fault === 'throw') throw null;
      if (fault === 'missing-output') return { status: 'succeeded', outputs: {} };
      raw = await actual(call, inputs, signal) as S2PluginOutcome;
      assert.equal(raw.status, 'succeeded');
      if (raw.status !== 'succeeded') assert.fail('Real output required');
      // Keep a valid artifact first, then poison the same batch. The valid prefix must not leak.
      const port = Object.keys(raw.outputs)[0], outputs: Record<string, unknown[]> = structuredClone(raw.outputs);
      outputs[port].push({ ...structuredClone(raw.outputs[port][0]), id: 'invalid-partial-output', complete: false });
      return { status: 'succeeded', outputs };
    }, async host => {
      assert.equal((await host.enqueueWorkflow(['target']).completion).status, 'failed'); assert.equal(dispatches, 1);
      const result = unpublished(host, raw);
      assert.equal(result.receipt.status, 'failed');
      assert.equal(result.receipt.error?.code, fault === 'throw' ? 'ADAPTER_FAILURE' : 'INVALID_OUTPUT');
    });
  }

  for (const stop of ['cancel', 'timeout', 'revision', 'close'] as const) {
    const entered = deferred<{ signal: AbortSignal; raw: S2PluginOutcome }>(), release = deferred<void>(), done = deferred<void>();
    let dispatches = 0;
    await test(`${stop}-late-result-isolation`, async (call, inputs, signal) => {
      dispatches++;
      try {
        const raw = await actual(call, inputs, signal) as S2PluginOutcome;
        entered.resolve({ signal, raw });
        await release.promise; // Deliberately ignore abort; host must still isolate a late return.
        return raw;
      } finally { done.resolve(); }
    }, async host => {
      const queued = host.enqueueWorkflow(['target']);
      try {
        const started = await within(entered.promise, cap.timeoutMs + 2000, `${label}: adapter did not start`);
        if (stop === 'cancel') host.cancelWorkflow(queued.id);
        if (stop === 'close') host.close();
        if (stop === 'revision') {
          const edited = structuredClone(document); edited.nodes[0].values.content = '合成接入测试 v2'; host.setDocument(edited);
        }
        const run = await within(queued.completion, cap.timeoutMs + 2000, `${label}: host did not stop`);
        assert.equal(run.status, stop === 'timeout' ? 'failed' : 'cancelled');
        assert.equal(started.signal.aborted, true); assert.equal(dispatches, 1);
        const result = single(host);
        assert.equal(result.receipt.status, stop === 'timeout' ? 'unknown' : 'cancelled');
        assert.equal(result.receipt.error?.code, stop === 'timeout' ? 'TIMEOUT' : 'CANCELLED');
        assert.equal(result.receipt.publication, stop === 'revision' || stop === 'close' ? 'stale' : 'current');
        assert.deepEqual(result.artifacts, []); assert.deepEqual(result.receipt.outputArtifactIds, {});
        if (started.raw.status === 'succeeded') for (const artifact of Object.values(started.raw.outputs).flat())
          assert.throws(() => host.currentArtifact(artifact.id));
        const before = host.history(); release.resolve(); await done.promise;
        // Let Promise.race's ignored result settle, without relying on arbitrary long sleeps.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.deepEqual(host.history(), before, 'Late completion must not append a second receipt, publish data or refund');
      } finally { release.resolve(); }
    });
  }

  let dispatches = 0;
  await test('direct-guards-and-idempotency', async (...args) => { dispatches++; return actual(...args); }, async host => {
    const prepared = host.prepare('target', strategy, '执行当前节点');
    const request: S2PluginRequest = { ...binding, nodeId: 'target', reason: '合成执行请求',
      inputs: Object.fromEntries(cap.inputs.map(port => [port.id, prepared.bindings.filter(item => item.fieldId === port.id).map(item => item.artifactId)])) };
    if (isS2ExclusiveMerge(binding)) {
      await assert.rejects(async () => host.execute(request, prepared.frame, 'direct-merge'), { code: 'WORKFLOW_REQUIRED' });
      assert.equal(dispatches, 0); assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(host.history(), []);
      return;
    }
    const preaborted = new AbortController(); preaborted.abort();
    await assert.rejects(async () => host.execute(request, prepared.frame, 'preaborted', preaborted.signal));
    const required = cap.inputs.find(port => port.required)!;
    await assert.rejects(async () => host.execute({ ...request, inputs: { ...request.inputs, [required.id]: ['invented'] } }, prepared.frame, 'invalid-input'));
    assert.equal(dispatches, 0); assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(host.history(), []);
    const [first, second] = await Promise.all([
      host.execute(request, prepared.frame, 'same-call'), host.execute(structuredClone(request), prepared.frame, 'same-call'),
    ]);
    assert.equal(dispatches, 1); assert.equal(first.receipt.id, second.receipt.id); assert.equal(first.receipt.status, 'succeeded'); single(host);
    const repeated = await host.execute(request, prepared.frame, 'same-call'); assert.equal(repeated.receipt.id, first.receipt.id);
    await assert.rejects(async () => host.execute({ ...request, reason: 'different intent' }, prepared.frame, 'same-call'), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(dispatches, 1); single(host);
  });

  // A failing node blocks its consumers, not a separate node using the exact same capability.
  const output = cap.outputs[0];
  const consumers: Record<string, [string, string, string]> = {
    'core.text': ['json-check', 'validate', 'text'], 'core.assessment': ['workflow-merge', 'merge-assessment', 'candidates'],
    'structured-data.value': ['structured-data', 'stringify', 'value'], 'structured-data.table': ['structured-data', 'table-to-json', 'table'],
    'workflow-simulation.result': ['workflow-merge', 'merge-simulation', 'candidates'],
  };
  assert.ok(output && consumers[output.type.id], `${label}: add a typed consumer fixture when adding a new output type`);
  const [pluginId, capabilityId, input] = consumers[output.type.id], consumer = { pluginId, pluginVersion: '1.0.0', capabilityId };
  const grants = [...new Map([binding, consumer].map(item => [s2CapabilityKey(item), item])).values()];
  const branchDoc = structuredClone(document);
  branchDoc.execution!.nodes.push({ ...structuredClone(node), id: 'independent' },
    { ...consumer, id: 'dependent', position: { x: 200, y: 0 }, bindings: {} });
  branchDoc.execution!.links.push({ source: { nodeId: 'target', portId: output.id }, target: { nodeId: 'dependent', portId: input } });
  const dispatched: string[] = [];
  const host = new S2PluginHost('adapter-branch-conformance', grants, async (call, inputs, signal) => {
    dispatched.push(call.nodeId); if (call.nodeId === 'target') throw new Error('Synthetic adapter failure'); return actual(call, inputs, signal);
  });
  try {
    host.setDocument(branchDoc);
    const result = await host.enqueueWorkflow(['dependent', 'independent']).completion;
    assert.equal(result.status, 'failed');
    assert.equal(result.nodes.find(item => item.nodeId === 'target')?.status, 'failed');
    assert.equal(result.nodes.find(item => item.nodeId === 'dependent')?.status, 'blocked');
    assert.equal(result.nodes.find(item => item.nodeId === 'independent')?.status, 'succeeded');
    assert.deepEqual([...dispatched].sort(), ['independent', 'target']); assert.equal(host.history().length, 2);
    assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT - 2); cases.push('failure-branch-isolation');
  } catch (error) { throw new Error(`${label} / failure-branch-isolation`, { cause: error }); }
  finally { host.close(); }
  return { capability: label, cases };
}
