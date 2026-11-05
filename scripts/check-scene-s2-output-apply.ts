import assert from 'node:assert/strict';
import type { S2WorkflowNode } from '../src/types/sceneS2';
import type { S2CompositeDesign } from '../src/types/sceneS2Composite';
import { readS2Definition, readS2Document, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { readS2CompositeDesign, instantiateS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { previewS2CompositeMigration, prepareS2CompositeCopy, previewS2CompositeOutputs, checkS2CompositeOutputPlan,
  isS2CompositeCopyCurrent, isS2CompositeOutputPreviewCurrent, discardS2CompositeOutputPreview, discardS2CompositeCopy,
  acceptS2CompositeCopy, readS2CompositeCopyDesign, isS2CompositeOutputPlanCurrent, discardS2CompositeOutputPlan,
  acceptS2CompositeOutputPlan } from '../src/services/scene/sceneS2CompositeMigration';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const plugins = [cap('parse-json'), cap('stringify'), cap('merge-json', 'workflow-merge')];
const definition = readS2Definition({ version: 1, goal: '确认后添加副本与整批重接的合成测试',
  instructions: { understanding: '理解用途', planning: '逐项选择并检查', response: '明确只改设计，不运行' }, plugins,
  blockTypes: [{ id: 'note', label: '合成内容', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] }],
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
const literal = (value: any) => ({ kind: 'literal' as const, value });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({
  id, ...cap(capabilityId, pluginId), position: { x: 0, y: 0 }, bindings, presentation: { label: '合成步骤' },
});
const jsonType = { id: 'structured-data.value', version: 1 }, textType = { id: 'core.text', version: 1 };
const endpoint = (nodeId: string, portId = 'value') => ({ nodeId, portId });
const outputId = (id: string) => JSON.stringify(['output', id]);
function design(version: string): S2CompositeDesign {
  return readS2CompositeDesign({ format: 's2-composite-design', protocolVersion: 1, rootId: 'root',
    blueprint: { format: 's2-composite', protocolVersion: 1, id: 'apply-test', version, label: '可复用处理', description: '纯合成测试',
      plugins: [cap('parse-json')], workflow: { version: 1, nodes: [node('parse0', 'parse-json'), node('parse1', 'parse-json')], links: [] }, inputs: [],
      parameters: [0, 1].map(index => ({ id: `value${index}`, label: `原文${index}`, type: textType, target: endpoint(`parse${index}`, 'text'),
        defaultValue: version === '1.0.0' ? '{"PRIVATE_VALUE":false}' : '{"PRIVATE_VALUE":0}' })),
      outputs: [0, 1].map(index => ({ id: `result${index}`, label: `结果${index}`, type: jsonType, required: true, multiple: false, source: endpoint(`parse${index}`) })) },
    composites: [{ id: 'root', label: '可复用处理', nodeIds: ['parse0', 'parse1'] }] });
}
function setup(consumerCount = 2) {
  const initial = readS2Document({ ...definition.initial, blueprints: [design('1.0.0'), design('1.1.0')] }, definition);
  const added = instantiateS2CompositeDesign(initial, definition.plugins, 'apply-test', '1.0.0');
  const map = new Map(added.document.composites!.find(item => item.id === added.id)!.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  const document = added.document;
  for (let index = 0; index < consumerCount; index++) {
    document.execution!.nodes.push(node(`use${index}`, 'stringify'));
    document.execution!.links.push({ source: endpoint(map.get('parse0')!), target: endpoint(`use${index}`, 'value') });
  }
  return { document: readS2Document(document, definition), definition: structuredClone(definition), id: added.id, map };
}
type Trial = ReturnType<typeof setup>;
function prepare(trial: Trial, choice: 'current' | 'target-default' = 'current') {
  const migration = previewS2CompositeMigration(trial.document, trial.definition, trial.id, '1.1.0');
  if (migration.status !== 'preview') throw new Error(migration.reason);
  const candidate = prepareS2CompositeCopy(migration, trial.document, trial.definition,
    migration.items.filter(item => item.copyChoices.length).map(item => ({ key: item.key, choice })));
  const preview = previewS2CompositeOutputs(candidate, trial.document, trial.definition);
  const choices = preview.items.map(item => ({ key: item.key, choice: outputId('result0') }));
  return { candidate, preview, choices, migration };
}
function check(trial: Trial, pending: ReturnType<typeof prepare>, choices = pending.choices) {
  return checkS2CompositeOutputPlan(pending.preview, trial.document, trial.definition, choices);
}
const oldFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic output apply never performs network IO'); };
const hosts: S2PluginHost[] = [];
try {
  const trial = setup(), originalMembers = [...trial.document.composites!.find(item => item.id === trial.id)!.nodeIds];
  // Native comparison values must survive both joint checking and final candidate acceptance without coercion.
  for (const [index, equals] of [false, 0, null, { PRIVATE_COMPARE: 'hidden' }].entries()) trial.document.execution!.nodes.push({
    ...node(`condition${index}`, 'stringify', { value: literal(equals) }),
    when: { ...endpoint(trial.map.get('parse0')!), pointer: '/PRIVATE_VALUE', equals, match: index % 2 === 0 },
  });
  trial.document = readS2Document(trial.document, trial.definition);
  const host = new S2PluginHost('s2-output-apply-synthetic', trial.definition); hosts.push(host); host.setDocument(trial.document);
  const before = JSON.stringify(trial.document), beforeDefinition = JSON.stringify(trial.definition);
  const hostState = () => JSON.stringify([host.remainingCalls, host.history(), host.workflowHistory(), host.waitingHumanInputs(), host.waitingModelTests(), host.textResourceSummary(), host.projectNoteSummary()]);
  const beforeHost = hostState(), pending = prepare(trial, 'target-default');
  const newDesign = readS2CompositeCopyDesign(pending.candidate, trial.document, trial.definition);
  const newMap = new Map(newDesign.composites.find(item => item.id === pending.candidate.id)!.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  const choices = pending.choices.map((item, index) => ({ ...item, choice: index === 1 ? 'keep' : item.choice }));
  const checked = check(trial, pending, choices);
  assert.equal(checked.status, 'checked'); assert.equal(checked.canApply, true); assert.equal(checked.applied, false);
  assert.equal(isS2CompositeOutputPlanCurrent(checked, trial.document, trial.definition), true);
  assert.ok(!JSON.stringify(checked).includes('PRIVATE_')); assert.ok(!Object.hasOwn(checked, 'document') && !Object.hasOwn(checked, 'commands'));
  assert.equal(isS2CompositeOutputPlanCurrent(structuredClone(checked), trial.document, trial.definition), false);
  assert.throws(() => acceptS2CompositeOutputPlan(structuredClone(checked), trial.document, trial.definition), /过期/);
  assert.equal(JSON.stringify(trial.document), before); assert.equal(JSON.stringify(trial.definition), beforeDefinition); assert.equal(hostState(), beforeHost);
  const accepted = acceptS2CompositeOutputPlan(checked, trial.document, trial.definition);
  assert.equal(accepted.id, pending.candidate.id); assert.deepEqual(accepted.nodeIds, newDesign.execution.nodes.map(item => item.id));
  assert.equal(accepted.reconnectedCount, 5); assert.equal(accepted.keptCount, 1);
  assert.equal(isS2CompositeOutputPlanCurrent(checked, trial.document, trial.definition), false);
  assert.equal(isS2CompositeCopyCurrent(pending.candidate, trial.document, trial.definition), false);
  assert.equal(isS2CompositeOutputPreviewCurrent(pending.preview, trial.document, trial.definition), false);
  assert.throws(() => acceptS2CompositeOutputPlan(checked, trial.document, trial.definition), /已使用/);
  assert.throws(() => acceptS2CompositeCopy(pending.candidate, trial.document, trial.definition), /已使用/);
  assert.equal(JSON.stringify(trial.document), before); assert.equal(hostState(), beforeHost, 'Accept returns a candidate; it does not commit or execute in the host');
  const expected = structuredClone(trial.document);
  expected.execution!.nodes.push(...newDesign.execution.nodes); expected.execution!.links.push(...newDesign.execution.links);
  expected.composites!.push(...newDesign.composites);
  expected.execution!.links[0].source = endpoint(newMap.get('parse0')!);
  for (const item of expected.execution!.nodes) if (item.when) item.when = { ...item.when, nodeId: newMap.get('parse0')! };
  assert.deepEqual(accepted.document, readS2Document(expected, trial.definition), 'The entire result is exactly the copy plus only explicitly selected endpoint changes');
  assert.deepEqual(accepted.document.execution!.nodes.filter(item => originalMembers.includes(item.id)), trial.document.execution!.nodes.filter(item => originalMembers.includes(item.id)));
  assert.deepEqual(accepted.document.blueprints, trial.document.blueprints); assert.deepEqual(accepted.document.nodes, trial.document.nodes);
  assert.deepEqual(accepted.document.execution!.links[1], trial.document.execution!.links[1]);
  for (const item of trial.document.execution!.nodes.filter(item => item.when)) {
    const next = accepted.document.execution!.nodes.find(node => node.id === item.id)!;
    assert.deepEqual({ ...next.when, nodeId: item.when!.nodeId }, item.when);
  }
  assert.deepEqual(importS2Workspace(exportS2Workspace(trial.definition, accepted.document)).initial, accepted.document);
  assert.equal(isS2CompositeOutputPlanCurrent(JSON.parse(JSON.stringify(checked)), trial.document, trial.definition), false, 'Serialization never preserves confirmation authority');
  // The normal host commit invalidates old output readiness but still does not run; execution remains a separate action.
  host.setDocument(accepted.document); assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64);
  const run = await host.enqueueWorkflow(['use0']).completion;
  assert.equal(run.status, 'succeeded'); assert.ok(run.nodes.some(item => item.nodeId === newMap.get('parse0')));
  assert.ok(!run.nodes.some(item => originalMembers.includes(item.nodeId)));
  const artifact = host.readCurrentStructuredOutput(newMap.get('parse0')!, 'value');
  assert.deepEqual(artifact.payload, { kind: 'inline', value: { PRIVATE_VALUE: 0 } });
  assert.equal(host.remainingCalls, 62); assert.equal(network, 0);

  // Every new check supersedes earlier confirmation, including rejected and malformed choices. Failed attempts preserve the original copy.
  const replacement = setup(), replacementPending = prepare(replacement);
  const first = check(replacement, replacementPending), second = check(replacement, replacementPending);
  assert.equal(isS2CompositeOutputPlanCurrent(first, replacement.document, replacement.definition), false);
  assert.equal(isS2CompositeOutputPlanCurrent(second, replacement.document, replacement.definition), true);
  assert.throws(() => check(replacement, replacementPending, []), /每条/);
  assert.equal(isS2CompositeOutputPlanCurrent(second, replacement.document, replacement.definition), false);
  const malformed = check(replacement, replacementPending); let getterReads = 0;
  const hostile = structuredClone(replacementPending.choices); Object.defineProperty(hostile[0], 'choice', { enumerable: true, get: () => { getterReads++; return outputId('result0'); } });
  assert.throws(() => check(replacement, replacementPending, hostile)); assert.equal(getterReads, 0);
  assert.equal(isS2CompositeOutputPlanCurrent(malformed, replacement.document, replacement.definition), false);
  assert.equal(isS2CompositeCopyCurrent(replacementPending.candidate, replacement.document, replacement.definition), true);
  const allKeep = check(replacement, replacementPending, replacementPending.choices.map(item => ({ ...item, choice: 'keep' })));
  assert.equal(allKeep.compatible, true); assert.equal(allKeep.canApply, false); assert.match(allKeep.reasons.join(' '), /没有需要重接/);
  assert.throws(() => acceptS2CompositeOutputPlan(allKeep, replacement.document, replacement.definition), /没有待重接项/);
  const noConsumers = setup(0), noPending = prepare(noConsumers), noPlan = check(noConsumers, noPending);
  assert.equal(noPlan.compatible, true); assert.equal(noPlan.canApply, false);
  const onlyCopy = acceptS2CompositeCopy(noPending.candidate, noConsumers.document, noConsumers.definition);
  assert.equal(onlyCopy.document.execution!.nodes.length, 4, 'The separate copy-only path remains available');

  // A new copy starts to the right of all cards, including downstream execution and content cards, without moving existing work.
  for (const hasContent of [false, true]) {
    const layout = setup();
    layout.document.execution!.nodes.find(item => item.id === 'use0')!.position = { x: 1500, y: 0 };
    layout.document.execution!.nodes.find(item => item.id === 'use1')!.position = { x: 3000, y: 200 };
    if (hasContent) layout.document.nodes.push({ id: 'rightContent', type: 'note', position: { x: 7000, y: 200 }, values: { content: '仅合成占位内容' } });
    const targetNodes = layout.document.blueprints![1].blueprint.workflow.nodes;
    targetNodes[0].position = { x: 40, y: -100 }; targetNodes[1].position = { x: 760, y: 200 };
    layout.document = readS2Document(layout.document, layout.definition);
    const originalLayout = JSON.stringify(layout.document), layoutPending = prepare(layout);
    const placed = readS2CompositeCopyDesign(layoutPending.candidate, layout.document, layout.definition).execution.nodes;
    assert.equal(Math.min(...placed.map(item => item.position.x)), (hasContent ? 7000 : 3000) + 450);
    assert.deepEqual({ x: placed[1].position.x - placed[0].position.x, y: placed[1].position.y - placed[0].position.y }, { x: 720, y: 300 });
    assert.equal(JSON.stringify(layout.document), originalLayout, 'Placement preview cannot move original cards');
    const placedCopy = acceptS2CompositeOutputPlan(check(layout, layoutPending), layout.document, layout.definition);
    for (const oldNode of layout.document.execution!.nodes) assert.deepEqual(placedCopy.document.execution!.nodes.find(item => item.id === oldNode.id)!.position, oldNode.position);
    assert.deepEqual(placedCopy.document.nodes, layout.document.nodes); assert.equal(JSON.stringify(layout.document), originalLayout);
  }
  const boundedLayout = setup(); boundedLayout.document.execution!.nodes.find(item => item.id === 'use1')!.position.x = 99800;
  const boundBefore = JSON.stringify(boundedLayout.document);
  assert.throws(() => prepare(boundedLayout), /位置|范围/, 'No wrapping or clamping into occupied space when the right-side candidate exceeds native position limits');
  assert.equal(JSON.stringify(boundedLayout.document), boundBefore);

  // Incoming field references and links are a different direction from outgoing consumer replacements, and must stay exact.
  const carry = setup();
  carry.document.nodes.push({ id: 'content', type: 'note', position: { x: 0, y: 0 }, values: { content: 'false' } });
  carry.document.execution!.nodes.push(node('incoming', 'stringify', { value: literal(0) }));
  carry.document.execution!.nodes.find(item => item.id === carry.map.get('parse0'))!.bindings.text = { kind: 'field', nodeId: 'content', fieldId: 'content' };
  delete carry.document.execution!.nodes.find(item => item.id === carry.map.get('parse1'))!.bindings.text;
  carry.document.execution!.links.push({ source: endpoint('incoming', 'text'), target: endpoint(carry.map.get('parse1')!, 'text') });
  carry.document = readS2Document(carry.document, carry.definition);
  const carryBefore = JSON.stringify(carry.document), carryPending = prepare(carry), carryPlan = check(carry, carryPending);
  const carryDesign = readS2CompositeCopyDesign(carryPending.candidate, carry.document, carry.definition);
  const carryAccepted = acceptS2CompositeOutputPlan(carryPlan, carry.document, carry.definition);
  const carriedField = carryDesign.execution.nodes.find(item => item.bindings.text?.kind === 'field')!;
  assert.deepEqual(carryAccepted.document.execution!.nodes.find(item => item.id === carriedField.id), carriedField);
  for (const link of carryDesign.execution.links) assert.ok(carryAccepted.document.execution!.links.some(item => JSON.stringify(item) === JSON.stringify(link)));
  assert.deepEqual(carryAccepted.document.nodes, carry.document.nodes); assert.equal(JSON.stringify(carry.document), carryBefore);

  // An edited, unpublished original producer is a real consumer source; no published-name mapping is needed or guessed.
  const edited = setup(0);
  edited.document.execution!.nodes.push(node('extra', 'parse-json', { text: literal('null') }), node('extraUse', 'stringify'));
  edited.document.composites!.find(item => item.id === edited.id)!.nodeIds.push('extra');
  edited.document.execution!.links.push({ source: endpoint('extra'), target: endpoint('extraUse') });
  edited.document = readS2Document(edited.document, edited.definition);
  const editedPending = prepare(edited); assert.match(editedPending.preview.items[0].description, /不在原库版本/);
  const editedAccepted = acceptS2CompositeOutputPlan(check(edited, editedPending), edited.document, edited.definition);
  assert.deepEqual(editedAccepted.document.execution!.nodes.find(item => item.id === 'extra'), edited.document.execution!.nodes.find(item => item.id === 'extra'));
  assert.ok(editedAccepted.nodeIds.includes(editedAccepted.document.execution!.links[0].source.nodeId));

  // Two individually valid changes can collide at a multi-input consumer; no successful plan may remain active after this failed check.
  const collision = setup(0), g = collision.document.execution!;
  g.nodes.push(node('merge', 'merge-json', {}, 'workflow-merge'));
  for (const id of collision.map.values()) g.links.push({ source: endpoint(id), target: endpoint('merge', 'candidates') });
  collision.document = readS2Document(collision.document, collision.definition);
  const collisionPending = prepare(collision);
  const safe = check(collision, collisionPending, collisionPending.choices.map((item, index) => ({ ...item, choice: index ? 'keep' : item.choice })));
  const blocked = check(collision, collisionPending);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.canApply, false); assert.match(blocked.reasons.join(' '), /重复|数量/);
  assert.equal(isS2CompositeOutputPlanCurrent(safe, collision.document, collision.definition), false);
  assert.throws(() => acceptS2CompositeOutputPlan(blocked, collision.document, collision.definition), /过期/);
  assert.equal(isS2CompositeCopyCurrent(collisionPending.candidate, collision.document, collision.definition), true);

  // Exact report/preview/copy signatures, cancellation and current graph/configuration prevent stale or forged submission.
  const invalidations: Array<[string, (trial: Trial, pending: ReturnType<typeof prepare>, plan: ReturnType<typeof check>) => void]> = [
    ['check cancellation', (_trial, _pending, plan) => discardS2CompositeOutputPlan(plan)],
    ['preview cancellation', (_trial, pending) => discardS2CompositeOutputPreview(pending.preview)],
    ['copy cancellation', (_trial, pending) => discardS2CompositeCopy(pending.candidate)],
    ['check tamper', (_trial, _pending, plan) => { plan.changes[0].choiceLabel += '伪造'; }],
    ['preview tamper', (_trial, pending) => { pending.preview.items[0].options[0].label += '伪造'; }],
    ['copy tamper', (_trial, pending) => { pending.candidate.nodeCount++; }],
    ['migration tamper', (_trial, pending) => { pending.migration.instance.label += '伪造'; }],
    ['full graph edit', trial => { trial.document.execution!.nodes[0].position.x++; }],
    ['same version library edit', trial => { trial.document.blueprints![1].blueprint.description += '变更'; }],
    ['configuration edit', trial => { trial.definition.instructions.response += '变更'; }],
    ['independent copy accepted', (trial, pending) => { acceptS2CompositeCopy(pending.candidate, trial.document, trial.definition); }],
  ];
  for (const [label, invalidate] of invalidations) {
    const scenario = setup(), p = prepare(scenario), plan = check(scenario, p); invalidate(scenario, p, plan);
    const original = JSON.stringify(scenario.document);
    assert.equal(isS2CompositeOutputPlanCurrent(plan, scenario.document, scenario.definition), false, label);
    assert.throws(() => acceptS2CompositeOutputPlan(plan, scenario.document, scenario.definition), /过期|取消/, label);
    assert.equal(JSON.stringify(scenario.document), original, label);
  }
  // Failed acceptance does not consume a still-valid copy or token; caller-provided bad state cannot partially apply.
  const unchanged = setup(), unchangedPending = prepare(unchanged), unchangedPlan = check(unchanged, unchangedPending);
  const bad = structuredClone(unchanged.document); bad.execution!.links[0].target.portId = 'missing';
  assert.throws(() => acceptS2CompositeOutputPlan(unchangedPlan, bad, unchanged.definition));
  assert.equal(isS2CompositeOutputPlanCurrent(unchangedPlan, unchanged.document, unchanged.definition), true);
  assert.equal(isS2CompositeCopyCurrent(unchangedPending.candidate, unchanged.document, unchanged.definition), true);
  const alternate = previewS2CompositeOutputs(unchangedPending.candidate, unchanged.document, unchanged.definition);
  const alternatePlan = checkS2CompositeOutputPlan(alternate, unchanged.document, unchanged.definition, alternate.items.map(item => ({ key: item.key, choice: outputId('result1') })));
  acceptS2CompositeOutputPlan(unchangedPlan, unchanged.document, unchanged.definition);
  assert.equal(isS2CompositeOutputPlanCurrent(alternatePlan, unchanged.document, unchanged.definition), false, 'Applying any plan retires every other plan from the consumed copy');

  // Nested copies extend only their ancestors. A selected condition remains inside the same parent; old child membership is exact.
  const nested = setup(0);
  nested.document.execution!.nodes.push({ ...node('insideCondition', 'stringify', { value: literal(false) }),
    when: { ...endpoint(nested.map.get('parse0')!), pointer: '', equals: null, match: false } });
  nested.document.nodes.push({ id: 'nestedOutsideContent', type: 'note', position: { x: 5000, y: 200 }, values: { content: '合成外层占位内容' } });
  const parent = wrapS2CanvasComposite(nested.document, nested.definition.plugins, [...nested.map.values(), 'insideCondition'], '外层组合');
  nested.document = readS2Document(parent.document, nested.definition);
  const nestedBefore = JSON.stringify(nested.document);
  const oldChild = structuredClone(nested.document.composites!.find(item => item.id === nested.id));
  const nestedPending = prepare(nested), nestedPlan = check(nested, nestedPending);
  const nestedAccepted = acceptS2CompositeOutputPlan(nestedPlan, nested.document, nested.definition);
  assert.deepEqual(nestedAccepted.document.composites!.find(item => item.id === nested.id), oldChild);
  assert.equal(nestedAccepted.document.composites!.find(item => item.id === nestedAccepted.id)!.parentId, parent.id);
  assert.ok(nestedAccepted.nodeIds.every(id => nestedAccepted.document.composites!.find(item => item.id === parent.id)!.nodeIds.includes(id)));
  assert.equal(Math.min(...nestedAccepted.document.execution!.nodes.filter(item => nestedAccepted.nodeIds.includes(item.id)).map(item => item.position.x)), 5450);
  assert.equal(JSON.stringify(nested.document), nestedBefore);
  assert.deepEqual(nestedAccepted.document.nodes, nested.document.nodes);
  for (const oldNode of nested.document.execution!.nodes) assert.deepEqual(nestedAccepted.document.execution!.nodes.find(item => item.id === oldNode.id)!.position, oldNode.position);
  assert.equal(network, 0);
  console.log('S2 output apply passed: explicit host-local single-use confirmation, exact whole-copy/selected-data/condition commit with native false/0/null, keep-only separate path, invalid/replaced/blocked/stale/tampered/imported/cancelled retirement, no partial mutation/IO/authority/runtime effects, nested boundaries, and separate real local execution using the chosen new output.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
