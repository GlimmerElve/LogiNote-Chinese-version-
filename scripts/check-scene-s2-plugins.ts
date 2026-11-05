import assert from 'node:assert/strict';
import type { S2Artifact, S2ExecutionLink, S2Json, S2PluginCapability, S2PluginGrant, S2PluginInvocation, S2PluginManifest, S2PluginNode, S2PluginPort, S2InteractionFrame } from '../src/types/sceneS2Plugin';
import { canonicalS2Json, createS2Receipt, describeS2PluginOutcome, preflightS2ExecutionGraph, readS2Artifact, readS2PluginManifest,
  resolveS2Artifact, readS2PluginRequest, assertS2ResourceAccess, S2PluginProtocolError, S2PluginRegistry, validateS2Invocation, validateS2Outcome } from '../src/services/scene/sceneS2PluginProtocol';
import { S2_CORE_PLUGIN, s2InstalledPluginCatalog, s2BuiltinPluginRegistry, readS2PluginBindings } from '../src/services/scene/sceneS2PluginRegistry';

globalThis.fetch = async () => assert.fail('Plugin conformance checks must stay synthetic/offline');
const clone = <T>(value: T): T => structuredClone(value);
const port = (id: string, type = 'core.text', extra: Partial<S2PluginPort> = {}): S2PluginPort => ({ id, label: id, meaning: `Semantic ${id}`, type: { id: type, version: 1 }, required: true, multiple: false, ...extra });
const capability = (id: string, inputs: S2PluginPort[], outputs: S2PluginPort[], extra: Partial<S2PluginCapability> = {}): S2PluginCapability => ({
  id, kind: 'transform', meaning: `Synthetic ${id}`, inputs, outputs, effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000, ...extra,
});
const plugin = (id: string, capabilities: S2PluginCapability[]): S2PluginManifest => ({ protocolVersion: 1, id, version: '1.0.0', label: id, meaning: 'Synthetic test fixture only',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities });
const source = plugin('source', [capability('emit', [], [port('text')])]);
const transform = plugin('transform', [capability('uppercase', [port('text')], [port('text')])]);
const checker = plugin('checker', [capability('check', [port('text')], [port('assessment', 'core.assessment')], { kind: 'validator' })]);
const registry = new S2PluginRegistry([S2_CORE_PLUGIN, source, transform, checker]);
let checks = 0;
function rejects(code: string, fn: () => unknown) { assert.throws(fn, e => e instanceof S2PluginProtocolError && e.code === code); checks++; }
async function rejectsAsync(code: string, fn: () => Promise<unknown>) { await assert.rejects(fn, e => e instanceof S2PluginProtocolError && e.code === code); checks++; }

rejects('UNSUPPORTED_PROTOCOL', () => readS2PluginManifest({ ...source, protocolVersion: 2 }));
rejects('UNKNOWN_FIELD', () => readS2PluginManifest({ ...source, grantedPermissions: ['network'] }));
rejects('VERSION_MISMATCH', () => readS2PluginManifest({ ...source, version: '^1.0.0' }));
rejects('PLUGIN_MISSING', () => new S2PluginRegistry([source]));
rejects('PLUGIN_MISSING', () => new S2PluginRegistry([S2_CORE_PLUGIN, { ...source, dependencies: [{ id: 'core', version: '2.0.0' }] }]));
rejects('DEPENDENCY_MISSING', () => new S2PluginRegistry([S2_CORE_PLUGIN, { ...source, dependencies: [] }]));
rejects('DEPENDENCY_CYCLE', () => new S2PluginRegistry([{ ...source, dependencies: [{ id: 'transform', version: '1.0.0' }] }, { ...transform, dependencies: [{ id: 'source', version: '1.0.0' }] }]));
rejects('DUPLICATE_ID', () => new S2PluginRegistry([S2_CORE_PLUGIN, S2_CORE_PLUGIN]));
const changed = clone(S2_CORE_PLUGIN); changed.version = '1.1.0'; changed.dataTypes[0].schema = { kind: 'string', maxLength: 4000 };
rejects('TYPE_CONFLICT', () => new S2PluginRegistry([S2_CORE_PLUGIN, changed]));
const meaningChanged = clone(S2_CORE_PLUGIN); meaningChanged.version = '1.1.0'; meaningChanged.dataTypes[0].meaning = 'Different semantic contract';
rejects('TYPE_CONFLICT', () => new S2PluginRegistry([S2_CORE_PLUGIN, meaningChanged]));
rejects('INVALID_SCHEMA', () => readS2PluginManifest({ ...source, dataTypes: [{ ...S2_CORE_PLUGIN.dataTypes[0] }] }));
rejects('INVALID_MANIFEST', () => readS2PluginManifest(plugin('bad', [capability('bad', [], [], { permissions: ['network'] })])));
rejects('INVALID_MANIFEST', () => readS2PluginManifest(plugin('bad', [capability('bad', [], [], { effect: 'external', permissions: ['model-call'], confirmation: 'none' })])));
const snapshot = registry.plugin('source', '1.0.0'); snapshot.capabilities[0].outputs.length = 0;
assert.equal(registry.plugin('source', '1.0.0').capabilities[0].outputs.length, 1, 'Registry access returns copies');

const nodes: S2PluginNode[] = [{ id: 'a', pluginId: 'source', pluginVersion: '1.0.0', capabilityId: 'emit' },
  { id: 'b', pluginId: 'transform', pluginVersion: '1.0.0', capabilityId: 'uppercase' }, { id: 'c', pluginId: 'checker', pluginVersion: '1.0.0', capabilityId: 'check' }];
const links: S2ExecutionLink[] = [{ source: { nodeId: 'a', portId: 'text' }, target: { nodeId: 'b', portId: 'text' } }, { source: { nodeId: 'b', portId: 'text' }, target: { nodeId: 'c', portId: 'text' } }];
assert.deepEqual(preflightS2ExecutionGraph(registry, nodes, links), { order: ['a', 'b', 'c'], executed: false });
rejects('MISSING_INPUT', () => preflightS2ExecutionGraph(registry, nodes, []));
rejects('PORT_MISSING', () => preflightS2ExecutionGraph(registry, nodes, [{ ...links[0], source: { nodeId: 'a', portId: 'invented' } }]));
rejects('DUPLICATE_LINK', () => preflightS2ExecutionGraph(registry, nodes, [links[0], { target: links[0].target, source: links[0].source }]));
rejects('PORT_CARDINALITY', () => preflightS2ExecutionGraph(registry, nodes, links, [{ nodeId: 'b', portId: 'text', count: 1 }]));
rejects('TYPE_MISMATCH', () => preflightS2ExecutionGraph(registry, nodes, [{ source: { nodeId: 'c', portId: 'assessment' }, target: { nodeId: 'b', portId: 'text' } }]));
rejects('EXECUTION_CYCLE', () => preflightS2ExecutionGraph(registry, nodes.slice(1), [{ source: { nodeId: 'b', portId: 'text' }, target: { nodeId: 'c', portId: 'text' } },
  { source: { nodeId: 'c', portId: 'assessment' }, target: { nodeId: 'c', portId: 'text' } }]));
const loopNodes = [{ ...nodes[1], id: 'x' }, { ...nodes[1], id: 'y' }];
rejects('EXECUTION_CYCLE', () => preflightS2ExecutionGraph(registry, loopNodes, [{ source: { nodeId: 'x', portId: 'text' }, target: { nodeId: 'y', portId: 'text' } }, { source: { nodeId: 'y', portId: 'text' }, target: { nodeId: 'x', portId: 'text' } }]));
const distinct = plugin('semantic', [capability('take', [port('text', 'semantic.prompt')], [])]);
distinct.dataTypes = [{ id: 'semantic.prompt', version: 1, meaning: 'Executable prompt, not arbitrary text', schema: { kind: 'string', maxLength: 6000 } }];
const semanticRegistry = new S2PluginRegistry([S2_CORE_PLUGIN, source, distinct]);
rejects('TYPE_MISMATCH', () => preflightS2ExecutionGraph(semanticRegistry, [nodes[0], { id: 'b', pluginId: 'semantic', pluginVersion: '1.0.0', capabilityId: 'take' }], [links[0]]));

const grant: S2PluginGrant = { sceneId: 'scene-test', runId: 'run-test', revision: 7, remainingCalls: 3, permissions: [], resourceScopes: [], confirmedInvocationIds: [], readableArtifactIds: [], capabilities: nodes.map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId })) };
function invocation(node: S2PluginNode, inputs: Record<string, string[]>): S2PluginInvocation { return { protocolVersion: 1, id: `call-${node.id}`, sceneId: grant.sceneId, runId: grant.runId,
  revision: 7, nodeId: node.id, pluginId: node.pluginId, pluginVersion: node.pluginVersion, capabilityId: node.capabilityId, idempotencyKey: `key-${node.id}`, inputs }; }
function artifact(id: string, call: S2PluginInvocation, value: S2Json, type = 'core.text'): S2Artifact { return { protocolVersion: 1, id, type: { id: type, version: 1 },
  source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, complete: true, payload: { kind: 'inline', value } }; }
const stored: S2Artifact[] = [];
const live = { sceneId: grant.sceneId, runId: grant.runId, revision: 7, active: true };
let assessmentReceipt;
// Synthetic adapter chain: source -> uppercase -> check. Real protocol, no installed external handlers.
for (const node of nodes) {
  const inputs = node.id === 'a' ? {} : { text: [stored.at(-1)!.id] };
  const checked = await validateS2Invocation(registry, invocation(node, inputs), grant, stored);
  grant.remainingCalls--; // Reservation is host-owned; preflight did not mutate it.
  const value = node.id === 'a' ? 'actual input' : node.id === 'b' ? String(checked.inputs.text[0]).toUpperCase()
    : { status: 'fail', reason: 'Synthetic content criterion unmet', evidence: [String(checked.inputs.text[0])] };
  const output = artifact(`data-${node.id}`, checked.invocation, value, node.id === 'c' ? 'core.assessment' : 'core.text');
  const outcome = await validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: { [node.id === 'c' ? 'assessment' : 'text']: [output] } }, stored.map(a => a.id));
  const receipt = createS2Receipt(checked.invocation, outcome, live), observation = describeS2PluginOutcome(registry, checked.invocation, outcome, live);
  assert.equal(receipt.status, 'succeeded'); assert.equal(observation.executionStatus, 'succeeded');
  if (outcome.status !== 'succeeded') throw new Error('fixture failed');
  stored.push(...Object.values(outcome.outputs).flat()); grant.readableArtifactIds.push(output.id);
  if (node.id === 'c') assessmentReceipt = receipt;
}
assert.equal((stored[1].payload as { value: unknown }).value, 'ACTUAL INPUT');
assert.equal((stored[2].payload as { value: any }).value.status, 'fail');
assert.equal(assessmentReceipt?.status, 'succeeded', 'An executed check can correctly report a failed content criterion');
await rejectsAsync('BUDGET_EXHAUSTED', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['data-a'] }), grant, stored));
const allowed = { ...grant, remainingCalls: 1 };
await rejectsAsync('SCOPE_DENIED', () => validateS2Invocation(registry, { ...invocation(nodes[1], { text: ['data-a'] }), runId: 'another-run' }, allowed, stored));
await rejectsAsync('STALE_REVISION', () => validateS2Invocation(registry, { ...invocation(nodes[1], { text: ['data-a'] }), revision: 6 }, allowed, stored));
await rejectsAsync('PERMISSION_DENIED', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['data-a'] }), { ...allowed, capabilities: [] }, stored));
await rejectsAsync('MISSING_INPUT', () => validateS2Invocation(registry, invocation(nodes[1], {}), allowed, stored));
await rejectsAsync('SCOPE_DENIED', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['hidden'] }), allowed, stored));
await rejectsAsync('SCOPE_DENIED', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['data-a'] }), { ...allowed, readableArtifactIds: [] }, stored));
await rejectsAsync('TYPE_MISMATCH', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['data-c'] }), allowed, stored));
const checked = await validateS2Invocation(registry, invocation(nodes[1], { text: ['data-a'] }), allowed, stored);
assert.equal(allowed.remainingCalls, 1, 'Protocol preflight is not an executor or budget reservation');
await rejectsAsync('PROTOCOL_BYPASS', () => validateS2Outcome(registry, clone(checked.invocation), { status: 'succeeded', outputs: {} }));
rejects('PROTOCOL_BYPASS', () => createS2Receipt(checked.invocation, { status: 'succeeded', outputs: {} }, live));
await rejectsAsync('MISSING_OUTPUT', () => validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: {} }));
const output = artifact('verified-output', checked.invocation, 'complete');
await rejectsAsync('SOURCE_MISMATCH', () => validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: { text: [{ ...output, source: { ...output.source, invocationId: 'wrong-call' } }] } }));
await rejectsAsync('DUPLICATE_ID', () => validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: { text: [output] } }, [output.id]));
await rejectsAsync('UNKNOWN_FIELD', () => validateS2Outcome(registry, checked.invocation, { status: 'failed', outputs: { text: [output] }, error: { code: 'bad', message: 'bad' } }));
const unknown = await validateS2Outcome(registry, checked.invocation, { status: 'unknown', outputs: {}, error: { code: 'timeout', message: 'May have executed; do not automatically retry' } });
assert.equal(createS2Receipt(checked.invocation, unknown, live).status, 'unknown');
const valid = await validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: { text: [output] } });
if (valid.status !== 'succeeded') throw new Error('fixture failed');
assert.equal(createS2Receipt(checked.invocation, valid, { ...live, revision: 8 }).publication, 'stale');
assert.deepEqual(describeS2PluginOutcome(registry, checked.invocation, valid, { ...live, active: false }).artifacts, [], 'Late output is archived, not published as a current observation');
valid.outputs.text[0].source.revision++;
rejects('PROTOCOL_BYPASS', () => createS2Receipt(checked.invocation, valid, live));
rejects('INCOMPLETE_DATA', () => readS2Artifact(registry, { ...output, complete: false }));
rejects('TYPE_MISMATCH', () => readS2Artifact(registry, { ...output, payload: { kind: 'inline', value: 12 } }));
rejects('TYPE_MISMATCH', () => readS2Artifact(registry, artifact('bad-assessment', checked.invocation, { status: 'certainly-proven', reason: '', evidence: [] }, 'core.assessment')));

const referenceValue = '完整引用数据\n含中文与换行', bytes = new TextEncoder().encode(canonicalS2Json(referenceValue));
const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
const ref: S2Artifact = { ...output, payload: { kind: 'reference', artifactRef: 'local-data-handle', bytes: bytes.byteLength, sha256 } };
assert.equal(await resolveS2Artifact(registry, ref, async () => referenceValue), referenceValue);
const longArtifact = artifact('long-output', checked.invocation, 'x'.repeat(1500));
const longOutcome = await validateS2Outcome(registry, checked.invocation, { status: 'succeeded', outputs: { text: [longArtifact] } });
const summary = describeS2PluginOutcome(registry, checked.invocation, longOutcome, live).artifacts[0];
assert.equal(summary.previewOmitted, true); assert.equal(summary.artifactComplete, true); assert.ok(summary.preview.length <= 1200);
assert.equal((await resolveS2Artifact(registry, longArtifact) as string).length, 1500, 'Agent preview never truncates the real artifact');
await rejectsAsync('ARTIFACT_UNAVAILABLE', () => resolveS2Artifact(registry, ref));
await rejectsAsync('INTEGRITY_MISMATCH', () => resolveS2Artifact(registry, ref, async () => 'changed'));
rejects('INVALID_ID', () => readS2Artifact(registry, { ...ref, payload: { ...ref.payload, artifactRef: 'https://example.invalid/data' } }));
const revoke = { ...allowed, readableArtifactIds: ['verified-output'] };
await rejectsAsync('PERMISSION_DENIED', () => validateS2Invocation(registry, invocation(nodes[1], { text: ['verified-output'] }), revoke, [ref], async () => {
  revoke.readableArtifactIds = []; return referenceValue;
}));
const external = plugin('external', [capability('experiment', [port('text')], [port('text')], { kind: 'action', effect: 'external', permissions: ['model-call'], confirmation: 'per-call', retry: 'same-idempotency-key' })]);
const externalRegistry = new S2PluginRegistry([S2_CORE_PLUGIN, external]);
const externalNode = { id: 'external-node', pluginId: 'external', pluginVersion: '1.0.0', capabilityId: 'experiment' };
const externalCall = invocation(externalNode, { text: ['data-a'] });
const externalGrant: S2PluginGrant = { ...allowed, capabilities: [externalNode], permissions: ['model-call'], resourceScopes: [{ permission: 'model-call', resourceIds: ['approved-model'] }], confirmedInvocationIds: [] };
await rejectsAsync('CONFIRMATION_REQUIRED', () => validateS2Invocation(externalRegistry, externalCall, externalGrant, stored));
externalGrant.confirmedInvocationIds = [externalCall.id];
const externalChecked = await validateS2Invocation(externalRegistry, externalCall, externalGrant, stored);
assert.equal(externalChecked.invocation.idempotencyKey, externalCall.idempotencyKey);
assertS2ResourceAccess(externalRegistry, externalChecked.invocation, externalGrant, 'model-call', 'approved-model');
rejects('SCOPE_DENIED', () => assertS2ResourceAccess(externalRegistry, externalChecked.invocation, externalGrant, 'model-call', 'another-model'));
rejects('PERMISSION_DENIED', () => assertS2ResourceAccess(externalRegistry, externalChecked.invocation, externalGrant, 'network', 'approved-model'));
await rejectsAsync('SCOPE_DENIED', () => validateS2Invocation(externalRegistry, externalCall, { ...externalGrant, resourceScopes: [] }, stored));
const catalog = s2InstalledPluginCatalog(); assert.equal(catalog.plugins.length, 11); assert.equal(catalog.toolExecutionAvailable, true);
assert.deepEqual(catalog.plugins.find(plugin => plugin.id === 'text-template')?.capabilities.map(capability => capability.id).sort(), ['bind', 'compose', 'render']);
assert.ok(catalog.plugins.every(plugin => plugin.capabilities.every(capability => capability.kind !== 'editor')), 'Executable discovery must not advertise text field editors as executable tools');
assert.ok(catalog.plugins.find(plugin => plugin.id === 'core')!.dataTypes.some(type => type.id === 'core.text'), 'UI/editor separation must not lose owned transfer types');
const composable = catalog.plugins.find(plugin => plugin.capabilities.length)!;
const count = composable.capabilities.length; composable.capabilities.length = 0;
assert.equal(s2InstalledPluginCatalog().plugins.find(plugin => plugin.id === composable.id)!.capabilities.length, count);
assert.deepEqual(catalog.fieldEditors, ['text', 'multiline', 'number', 'enum', 'boolean', 'list', 'form', 'table', 'json', 'code']);
assert.equal(s2BuiltinPluginRegistry().capability({ pluginId: 'core', pluginVersion: '1.0.0', capabilityId: 'text' }).kind, 'editor', 'The actual UI implementation remains installed');
assert.throws(() => readS2PluginBindings([{ pluginId: 'core', pluginVersion: '1.0.0', capabilityId: 'text' }]), /plugins\[0\].*editor.*blockTypes/);
assert.throws(() => readS2PluginBindings([{ pluginId: 'missing', pluginVersion: '1.0.0', capabilityId: 'text' }]), /plugins\[0\].*精确可组合能力/);
const frame: S2InteractionFrame = { protocolVersion: 1, sceneId: live.sceneId, runId: live.runId, revision: 7, event: { id: 'event-1', kind: 'request-check', text: 'Check the text' },
  focusNodeIds: ['b'], availableNodeIds: ['a', 'b', 'c'], availableArtifactIds: ['data-a'], observations: [], strategy: { goal: 'Synthetic', understanding: 'understand', planning: 'plan', response: 'respond' } };
const intention = { nodeId: 'b', pluginId: 'transform', pluginVersion: '1.0.0', capabilityId: 'uppercase', inputs: { text: ['data-a'] }, reason: 'User requested a case conversion' };
assert.equal(readS2PluginRequest(registry, frame, intention).authorization, 'requires-host-validation');
rejects('UNKNOWN_FIELD', () => readS2PluginRequest(registry, frame, { ...intention, permissions: ['network'] }));
rejects('SCOPE_DENIED', () => readS2PluginRequest(registry, frame, { ...intention, nodeId: 'missing' }));
rejects('SCOPE_DENIED', () => readS2PluginRequest(registry, frame, { ...intention, inputs: { text: ['invented-data'] } }));
console.log(`S2 plugin protocol passed: ${checks} rejection cases plus typed three-plugin collaboration, immutable registry, exact-version dependencies, semantic port compatibility, DAG preflight, complete/ref integrity, scope/revision/approval/budget gates, anti-forgery receipts and separate content assessment. All adapters/data are synthetic; NO external plugins installed/executed.`);
