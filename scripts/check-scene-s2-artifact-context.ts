import assert from 'node:assert/strict';
import type { S2Document } from '../src/types/sceneS2';

const priorFetch = globalThis.fetch, protectedKeys = ['localStorage', 'window', 'electronAPI'];
const descriptors = new Map(protectedKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let forbiddenIo = 0;
const denied = () => { forbiddenIo++; throw new Error('Artifact context test forbids real IO'); };
globalThis.fetch = async () => denied();
for (const key of protectedKeys) Object.defineProperty(globalThis, key, { configurable: true, get: denied });
const hosts: Array<{ close(): void }> = [];
try {
  const { S2PluginHost, executeS2JsonCheck } = await import('../src/services/scene/sceneS2PluginHost');
  const { readS2ContextRecall, s2RecallContext, s2EvidenceIndex } = await import('../src/services/scene/sceneS2Context');
  const { readS2ContextArtifact, createS2AssessmentArtifactScope, readS2AssessmentArtifact, resolveS2AssessmentOutput } = await import('../src/services/scene/sceneS2ArtifactAccess');
  const binding = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' };
  const content = 'x'.repeat(5400) + '\n末尾完整证据，不能从500字预览中取得。';
  const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: ['render', 'other'].map(id => ({ id, ...binding, position: { x: 0, y: 0 },
    bindings: { template: { kind: 'literal', value: content }, variables: { kind: 'literal', value: {} } } })), links: [] } };
  const host = new S2PluginHost('SyntheticArtifactScene', [binding]); hosts.push(host); host.setDocument(document);
  const strategy = { goal: 'Synthetic complete artifact reads', understanding: 'Read only selected complete sources', planning: 'No tool replay', response: 'Use real provenance' };
  const job = host.enqueueWorkflow(), run = await job.completion; assert.equal(run.status, 'succeeded');
  const artifactId = run.nodes.find(node => node.nodeId === 'render')!.artifactIds[0], otherId = run.nodes.find(node => node.nodeId === 'other')!.artifactIds[0];
  const context = host.prepare(null, strategy, '只解释实际全文');
  assert.ok(s2EvidenceIndex(context)!.artifacts.some(item => item.id === artifactId));
  assert.equal(context.frame.observations[0].artifacts[0].previewOmitted, true);
  const before = { calls: host.remainingCalls, history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) };
  const recalled = s2RecallContext(readS2ContextRecall({ artifactIds: [artifactId] }), [], document, context);
  assert.equal(recalled.items.length, 1); assert.deepEqual(recalled.unavailable, []);
  const value = recalled.items[0].value as { text: string; artifact: { id: string; source: { runId: string }; payload?: unknown } };
  assert.equal(value.text, content); assert.equal(value.artifact.id, artifactId); assert.equal(value.artifact.source.runId, host.runId);
  assert.equal(value.artifact.payload, undefined, 'Full text is provided once, alongside provenance; duplicating payload would incorrectly exhaust the recall budget');
  const scope = createS2AssessmentArtifactScope(context, recalled.items.filter(item => item.kind === 'artifact').map(item => item.id));
  assert.equal(readS2AssessmentArtifact(scope, artifactId).text, content);
  assert.equal(resolveS2AssessmentOutput(scope, 'render', 'text')!.artifact.id, artifactId);
  const mutated = readS2ContextArtifact(context, artifactId); (mutated.artifact.payload as any).value = 'forged'; mutated.text = 'forged';
  assert.equal(readS2ContextArtifact(context, artifactId).text, content);
  const catalogEntry = context.artifactCatalog.find(item => item.id === artifactId)!;
  catalogEntry.source.runId = 'ForgedRun'; catalogEntry.source.invocationId = 'ForgedInvocation'; catalogEntry.type.id = 'forged.type';
  assert.equal(readS2ContextArtifact(context, artifactId).artifact.source.runId, host.runId, 'Catalog metadata must not expose mutable store references');
  assert.notEqual(readS2ContextArtifact(context, artifactId).artifact.source.invocationId, 'ForgedInvocation');
  assert.equal(resolveS2AssessmentOutput(scope, 'render', 'text')!.artifact.type.id, 'core.text');
  assert.equal(resolveS2AssessmentOutput(scope, 'render', 'text')!.artifact.source.runId, host.runId);
  const publicHistory = host.history();
  publicHistory[0].observation.artifacts[0].type.id = 'forged.history';
  publicHistory[0].observation.artifacts[0].preview = 'forged preview';
  assert.equal(JSON.stringify(host.history()), before.history, 'Public observations must not expose mutable ledger or cache references');
  assert.throws(() => readS2ContextArtifact(structuredClone(context), artifactId), /真实宿主/);
  assert.throws(() => readS2ContextArtifact(JSON.parse(JSON.stringify(context)), artifactId), /真实宿主/);
  assert.throws(() => readS2AssessmentArtifact({}, artifactId), /宿主签发/);
  assert.throws(() => readS2AssessmentArtifact(structuredClone(scope), artifactId), /宿主签发/);
  assert.equal(resolveS2AssessmentOutput(createS2AssessmentArtifactScope(context, []), 'render', 'text'), undefined, 'A preview alone never grants formal full-body evidence');
  assert.throws(() => readS2AssessmentArtifact(scope, otherId), /未在本轮完整提供/);
  assert.throws(() => readS2ContextRecall({ artifactIds: ['a', 'b', 'c', 'd'] }), /范围/);
  assert.throws(() => readS2ContextRecall({ artifactIds: [artifactId, artifactId] }), /范围/);
  let getterReads = 0;
  const getterIds: string[] = [];
  Object.defineProperty(getterIds, '0', { enumerable: true, get: () => { getterReads++; return artifactId; } });
  assert.throws(() => readS2ContextRecall({ artifactIds: getterIds }), /范围/);
  assert.throws(() => readS2ContextRecall({ artifactIds: new Array(1) }), /范围/);
  const getterRecall = Object.defineProperty({}, 'artifactIds', { enumerable: true, get: () => { getterReads++; return [artifactId]; } });
  assert.throws(() => readS2ContextRecall(getterRecall), /提取/);
  assert.equal(getterReads, 0, 'Recall validates data descriptors without evaluating accessors');
  const tooMany = s2RecallContext(readS2ContextRecall({ artifactIds: [artifactId, otherId] }), [], document, context);
  assert.equal(tooMany.items.length, 1); assert.ok(tooMany.unavailable[0].reason.includes('未截断'));
  const exhausted = s2RecallContext(readS2ContextRecall({ messageIds: ['history-0'], artifactIds: [artifactId] }), [{ role: 'user', content: 'q'.repeat(8000) }], document, context);
  assert.ok(!exhausted.items.some(item => item.kind === 'artifact')); assert.equal(exhausted.unavailable[0].kind, 'artifact');
  const fake = s2RecallContext(readS2ContextRecall({ artifactIds: ['artifact-forged'] }), [], document, context);
  assert.equal(fake.items.length, 0); assert.equal(fake.unavailable.length, 1);
  assert.deepEqual({ calls: host.remainingCalls, history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) }, before, 'Reading and scope issuance do not execute, spend, cache or alter source data');

  // A fresh attempt invalidates current-output claims immediately, even if it
  // has not run or is cancelled. Explicit old artifact text remains readable.
  const cancelled = host.enqueueWorkflow(['render']); host.cancelWorkflow(cancelled.id); await cancelled.completion;
  assert.equal(readS2AssessmentArtifact(scope, artifactId).text, content);
  assert.equal(resolveS2AssessmentOutput(scope, 'render', 'text'), undefined);
  const cached = await host.enqueueWorkflow(['render']).completion;
  assert.equal(cached.nodes[0].status, 'cached');
  const cachedId = cached.nodes[0].artifactIds[0]; assert.notEqual(cachedId, artifactId);
  assert.equal(resolveS2AssessmentOutput(scope, 'render', 'text'), undefined, 'A previous turn cannot claim it saw a new cached artifact');
  const fresh = host.prepare(null, strategy, '读当前缓存来源'), cacheScope = createS2AssessmentArtifactScope(fresh, [cachedId]);
  assert.equal(resolveS2AssessmentOutput(cacheScope, 'render', 'text')!.artifact.id, cachedId);
  const layout = structuredClone(document); layout.execution!.nodes[0].position.x += 20; host.setDocument(layout);
  assert.equal(readS2AssessmentArtifact(cacheScope, cachedId).text, content, 'Layout is not a semantic revision');
  const semantic = structuredClone(layout); semantic.execution!.nodes[0].bindings.template = { kind: 'literal', value: 'new content' }; host.setDocument(semantic);
  assert.throws(() => readS2AssessmentArtifact(cacheScope, cachedId), /失效/);
  assert.equal(resolveS2AssessmentOutput(cacheScope, 'render', 'text'), undefined);

  // Human answers publish genuine user artifacts, not plugin receipts, and
  // starting a fresh unanswered attempt retires the previous answer target.
  const humanBinding = { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' };
  const human = new S2PluginHost('SyntheticHumanArtifact', [humanBinding]); hosts.push(human);
  human.setDocument({ nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'ask', ...humanBinding, position: { x: 0, y: 0 },
    bindings: { prompt: { kind: 'literal', value: 'Synthetic answer' } } }], links: [] } });
  const answerJob = human.enqueueWorkflow(['ask']);
  for (let attempt = 0; attempt < 500 && !human.waitingHumanInputs().length; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  const answerWait = human.waitingHumanInputs()[0]; assert.ok(answerWait);
  human.submitHumanInput(answerJob.id, answerWait.id, 'exact user answer');
  const answered = await answerJob.completion, answerId = answered.nodes[0].artifactIds[0];
  const answerContext = human.prepare(null, strategy, '只读用户原文'), answerScope = createS2AssessmentArtifactScope(answerContext, [answerId]);
  assert.equal(resolveS2AssessmentOutput(answerScope, 'ask', 'text')!.text, 'exact user answer');
  assert.equal(resolveS2AssessmentOutput(answerScope, 'ask', 'text')!.artifact.source.kind, 'user');
  assert.equal(resolveS2AssessmentOutput(answerScope, 'ask', 'text')!.artifact.source.invocationId, undefined);
  const freshQuestion = human.enqueueWorkflow(['ask']);
  assert.equal(resolveS2AssessmentOutput(answerScope, 'ask', 'text'), undefined);
  human.cancelWorkflow(freshQuestion.id); await freshQuestion.completion;
  assert.equal(human.remainingCalls, 64, 'Publishing/reading human output never consumes plugin calls');

  // Concurrent standalone attempts: an old late success cannot replace the
  // latest failure. Use genuine validation/receipts, not synthetic evidence.
  const checker = { pluginId: 'json-check', pluginVersion: '1.0.0', capabilityId: 'validate' };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const concurrent = new S2PluginHost('SyntheticConcurrentArtifact', [checker], async (call, inputs, signal) => {
    if (call.idempotencyKey === 'Older') { await gate; return executeS2JsonCheck(call, inputs, signal); }
    throw new Error('Synthetic newer failure');
  }); hosts.push(concurrent);
  const checkDoc: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'check', ...checker, position: { x: 0, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } } }], links: [] } };
  concurrent.setDocument(checkDoc);
  const prepared = concurrent.prepare('check', strategy, '合成并发核对'), input = prepared.bindings.find(item => item.fieldId === 'text')!.artifactId;
  const intention = { nodeId: 'check', ...checker, inputs: { text: [input] }, reason: 'Synthetic explicit check' };
  const older = concurrent.execute(intention, prepared.frame, 'Older');
  const newer = concurrent.execute(intention, prepared.frame, 'Newer');
  assert.equal((await newer).receipt.status, 'failed'); release();
  const oldResult = await older; assert.equal(oldResult.receipt.status, 'succeeded');
  const lateId = oldResult.artifacts[0].id, after = concurrent.prepare(null, strategy, '读取历史但不当作最新'), lateScope = createS2AssessmentArtifactScope(after, [lateId]);
  assert.equal(readS2AssessmentArtifact(lateScope, lateId).artifact.source.invocationId, oldResult.receipt.invocationId);
  assert.equal(resolveS2AssessmentOutput(lateScope, 'check', 'assessment'), undefined);
  concurrent.close(); assert.throws(() => readS2AssessmentArtifact(lateScope, lateId), /已结束/);
  assert.equal(forbiddenIo, 0);
  console.log('S2 artifact context passed: branded live host access and exact complete long text once, bounded explicit three-artifact recall and full-or-unavailable 10000-character pool, immutable provenance, clone/JSON/scope forgery rejection, no reads causing calls, latest-attempt invalidation, genuine cache sources, layout vs semantic/close isolation, and older concurrent success cannot override newer failure. Synthetic adapters only; no model/network/user data or semantic accuracy claim.');
} finally {
  hosts.forEach(host => host.close()); globalThis.fetch = priorFetch;
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
}
