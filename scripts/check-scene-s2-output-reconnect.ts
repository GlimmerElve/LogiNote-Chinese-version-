import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2CompositeDesign } from '../src/types/sceneS2Composite';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { readS2CompositeDesign, instantiateS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { previewS2CompositeMigration, prepareS2CompositeCopy, previewS2CompositeOutputs, checkS2CompositeOutputPlan,
  isS2CompositeCopyCurrent, isS2CompositeOutputPreviewCurrent, discardS2CompositeOutputPreview, discardS2CompositeCopy,
  acceptS2CompositeCopy, readS2CompositeCopyDesign } from '../src/services/scene/sceneS2CompositeMigration';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const allPlugins = [cap('parse-json'), cap('stringify'), cap('merge-json', 'workflow-merge')];
const baseDefinition = readS2Definition({ version: 1, goal: '只读输出重接合成测试',
  instructions: { understanding: '理解用途', planning: '仅做静态预览', response: '不宣称已经改线或执行' },
  blockTypes: [{ id: 'note', label: '内容', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] }], plugins: allPlugins,
  initial: { nodes: [], edges: [], execution: { version: 1, nodes: [], links: [] } } });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({
  id, ...cap(capabilityId, pluginId), position: { x: 0, y: 0 }, bindings, presentation: { label: '同名处理' },
});
const literal = (value: any) => ({ kind: 'literal' as const, value });
const jsonType = { id: 'structured-data.value', version: 1 };
const textType = { id: 'core.text', version: 1 };
function design(version: string, count = 2, includeText = true): S2CompositeDesign {
  const nodes = Array.from({ length: count }, (_, i) => node(`parse${i}`, 'parse-json'));
  if (includeText) nodes.push(node('text', 'stringify', { value: literal({ PRIVATE_TARGET: false }) }));
  return readS2CompositeDesign({ format: 's2-composite-design', protocolVersion: 1, rootId: 'root',
    blueprint: { format: 's2-composite', protocolVersion: 1, id: 'test', version, label: '同名组合', description: '合成完整设计',
      plugins: [cap('parse-json'), ...(includeText ? [cap('stringify')] : [])], workflow: { version: 1, nodes, links: [] }, inputs: [],
      parameters: Array.from({ length: count }, (_, i) => ({ id: `value${i}`, label: `填写${i}`, type: textType, target: { nodeId: `parse${i}`, portId: 'text' }, defaultValue: '{"PRIVATE_INPUT":false}' })),
      outputs: [...Array.from({ length: count }, (_, i) => ({ id: `result${i}`, label: '同名结果', type: jsonType, required: true, multiple: false, source: { nodeId: `parse${i}`, portId: 'value' } })),
        ...(includeText ? [{ id: 'keep', label: '同名结果', type: textType, required: true, multiple: false, source: { nodeId: 'text', portId: 'text' } }] : [])] },
    composites: [{ id: 'root', label: '同名组合', nodeIds: nodes.map(node => node.id) }] });
}
function setup(old = design('1.0.0'), target = design('1.1.0')) {
  const initial = readS2Document({ ...baseDefinition.initial, blueprints: [old, target] }, baseDefinition);
  const added = instantiateS2CompositeDesign(initial, baseDefinition.plugins, old.blueprint.id, old.blueprint.version);
  const map = new Map(added.document.composites!.find(item => item.id === added.id)!.blueprint!.mapping!.nodes.map(item => [item.localId, item.id]));
  const trial = { document: readS2Document(added.document, baseDefinition), definition: structuredClone(baseDefinition), id: added.id, map };
  const prepare = () => {
    const p = previewS2CompositeMigration(trial.document, trial.definition, trial.id, target.blueprint.version);
    if (p.status !== 'preview') throw new Error(p.reason); assert.equal(p.status, 'preview');
    return prepareS2CompositeCopy(p, trial.document, trial.definition, p.items.filter(item => item.copyChoices.length).map(item => ({
      key: item.key, choice: item.copyChoices.includes('current') ? 'current' : item.copyChoices.includes('target-default') ? 'target-default' : 'empty',
    })));
  };
  return { trial, prepare };
}
const outputId = (id: string) => JSON.stringify(['output', id]);
const source = (id: string) => ({ nodeId: id, portId: 'value' });
const host = new S2PluginHost('output-reconnect-synthetic', allPlugins);
const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic output preview must not perform IO'); };
try {
  const old = design('1.0.0'); old.blueprint.outputs = old.blueprint.outputs.filter(port => port.id !== 'result1');
  const { trial, prepare } = setup(old), graph = trial.document.execution!;
  graph.nodes.push(node('consume', 'stringify'), node('merge', 'merge-json', {}, 'workflow-merge'), node('textConsumer', 'parse-json'));
  const first = source(trial.map.get('parse0')!), second = source(trial.map.get('parse1')!);
  graph.links.push({ source: first, target: { nodeId: 'consume', portId: 'value' } },
    { source: first, target: { nodeId: 'merge', portId: 'candidates' } }, { source: second, target: { nodeId: 'merge', portId: 'candidates' } },
    { source: { nodeId: trial.map.get('text')!, portId: 'text' }, target: { nodeId: 'textConsumer', portId: 'text' } });
  for (const [index, equals] of [false, 0, null, { PRIVATE_COMPARISON: 'secret' }].entries()) graph.nodes.push({ ...node(`conditional${index}`, 'stringify', { value: literal(equals) }),
    when: { ...first, pointer: '/PRIVATE_POINTER', equals, match: index % 2 === 0 } });
  trial.document = readS2Document(trial.document, trial.definition);
  host.setDocument(trial.document); const beforeHost = JSON.stringify([host.history(), host.remainingCalls, host.waitingHumanInputs()]);
  const before = JSON.stringify(trial.document), beforeDefinition = JSON.stringify(trial.definition), candidate = prepare();
  const beforeDesign = JSON.stringify(readS2CompositeCopyDesign(candidate, trial.document, trial.definition));
  const report = previewS2CompositeOutputs(candidate, trial.document, trial.definition);
  assert.equal(report.items.length, 8); assert.equal(report.items.filter(item => item.kind === 'condition').length, 4);
  assert.equal(report.applied, false); assert.equal(report.canApply, false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'), 'No content, fixed inputs, pointer or comparison values in the report');
  assert.ok(report.items.every(item => item.options[0].id === 'keep' && item.options[0].eligible));
  assert.ok(report.items.every(item => new Set(item.options.map(option => option.label)).size === item.options.length));
  assert.ok(report.items.some(item => item.description.includes('不在原库版本的公开输出')));
  assert.ok(report.items[0].sourceLabel.includes('步骤 1')); assert.ok(report.items[0].targetLabel.includes('步骤 4'));
  const choices = () => report.items.map(item => ({ key: item.key, choice: 'keep' }));
  const keep = checkS2CompositeOutputPlan(report, trial.document, trial.definition, choices());
  assert.equal(keep.status, 'checked'); assert.equal(keep.compatible, true); assert.equal(keep.canApply, false);
  assert.ok(keep.changes.every(item => item.kept)); assert.ok(!Object.hasOwn(keep, 'document') && !Object.hasOwn(keep, 'commands'));
  const condition = report.items.find(item => item.kind === 'condition')!;
  assert.equal(condition.options.find(option => option.id === outputId('keep'))!.eligible, false, 'Text cannot become a JSON condition');
  assert.equal(condition.options.find(option => option.id === outputId('result0'))!.eligible, true);
  const textConsumer = report.items.find(item => item.targetLabel.includes('步骤 6'))!;
  assert.equal(textConsumer.options.find(option => option.id === outputId('result0'))!.eligible, false);
  assert.equal(textConsumer.options.find(option => option.id === outputId('keep'))!.eligible, true, 'Public output called keep must not collide with keep choice');
  const allReplaced = choices().map(selection => ({ ...selection, choice: report.items.find(item => item.key === selection.key) === textConsumer ? outputId('keep') : outputId('result0') }));
  const blocked = checkS2CompositeOutputPlan(report, trial.document, trial.definition, allReplaced);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.compatible, false); assert.match(blocked.reasons.join(' '), /重复|数量/);
  const acceptedChoices = allReplaced.map(selection => ({ ...selection, choice: report.items.find(item => item.key === selection.key)!.description.includes('不在原库版本') ? 'keep' : selection.choice }));
  assert.equal(checkS2CompositeOutputPlan(report, trial.document, trial.definition, acceptedChoices).status, 'checked');
  assert.equal(JSON.stringify(trial.document), before); assert.equal(JSON.stringify(trial.definition), beforeDefinition);
  assert.equal(JSON.stringify(readS2CompositeCopyDesign(candidate, trial.document, trial.definition)), beforeDesign);
  assert.equal(JSON.stringify([host.history(), host.remainingCalls, host.waitingHumanInputs()]), beforeHost);
  assert.equal(isS2CompositeCopyCurrent(candidate, trial.document, trial.definition), true, 'Checks do not consume a copy');
  for (const raw of [[], {}, null, [...choices(), choices()[0]], [{ ...choices()[0], extra: true }, ...choices().slice(1)], choices().map((item, index) => index ? item : { ...item, choice: 'unknown' })]) {
    assert.throws(() => checkS2CompositeOutputPlan(report, trial.document, trial.definition, raw));
  }
  let gets = 0; const hostile = choices(); Object.defineProperty(hostile[0], 'choice', { enumerable: true, get: () => { gets++; return 'keep'; } });
  assert.throws(() => checkS2CompositeOutputPlan(report, trial.document, trial.definition, hostile)); assert.equal(gets, 0);
  const clone = structuredClone(report); assert.equal(isS2CompositeOutputPreviewCurrent(clone, trial.document, trial.definition), false);
  assert.throws(() => checkS2CompositeOutputPlan(clone, trial.document, trial.definition, choices()), /过期/);
  const changed = structuredClone(trial.document); changed.execution!.nodes[0].position.x++;
  assert.equal(isS2CompositeOutputPreviewCurrent(report, changed, trial.definition), false);
  const changedDefinition = structuredClone(trial.definition); changedDefinition.instructions.response += '改变';
  assert.equal(isS2CompositeOutputPreviewCurrent(report, trial.document, changedDefinition), false);
  const tampered = previewS2CompositeOutputs(candidate, trial.document, trial.definition); tampered.items[0].options[0].eligible = false;
  assert.equal(isS2CompositeOutputPreviewCurrent(tampered, trial.document, trial.definition), false);
  const revoked = previewS2CompositeOutputs(candidate, trial.document, trial.definition); discardS2CompositeOutputPreview(revoked);
  assert.equal(isS2CompositeOutputPreviewCurrent(revoked, trial.document, trial.definition), false);
  const cancelled = prepare(), cancelledReport = previewS2CompositeOutputs(cancelled, trial.document, trial.definition); discardS2CompositeCopy(cancelled);
  assert.equal(isS2CompositeOutputPreviewCurrent(cancelledReport, trial.document, trial.definition), false);
  const applied = acceptS2CompositeCopy(candidate, trial.document, trial.definition);
  assert.equal(isS2CompositeOutputPreviewCurrent(report, trial.document, trial.definition), false, 'Accepting unchanged original copy retires all output previews');
  assert.deepEqual(applied.document.execution!.links.filter(link => !applied.nodeIds.includes(link.target.nodeId)), trial.document.execution!.links);
  for (const target of trial.document.execution!.nodes.filter(node => node.when)) assert.deepEqual(applied.document.execution!.nodes.find(node => node.id === target.id)!.when, target.when);

  // An edited current source is inventory truth, not the published mapping or label.
  const edited = setup(); edited.trial.document.execution!.nodes.push(node('editedExtra', 'parse-json', { text: literal('false') }), node('editedUse', 'stringify'));
  edited.trial.document.composites!.find(item => item.id === edited.trial.id)!.nodeIds.push('editedExtra');
  edited.trial.document.execution!.links.push({ source: source('editedExtra'), target: { nodeId: 'editedUse', portId: 'value' } });
  const editedCandidate = edited.prepare(), editedReport = previewS2CompositeOutputs(editedCandidate, edited.trial.document, edited.trial.definition);
  assert.equal(editedReport.items.length, 1); assert.match(editedReport.items[0].sourceLabel, /步骤 4/); assert.match(editedReport.items[0].description, /不在原库版本/);

  // Missing original mapping cannot be guessed by labels; without a valid source there is no issued copy to inspect.
  const missingMap = setup(); delete missingMap.trial.document.composites!.find(item => item.id === missingMap.trial.id)!.blueprint!.mapping;
  assert.equal(previewS2CompositeMigration(missingMap.trial.document, missingMap.trial.definition, missingMap.trial.id, '1.1.0').status, 'unavailable');
  assert.throws(() => previewS2CompositeOutputs(structuredClone(editedCandidate), edited.trial.document, edited.trial.definition), /过期/);
  // A target with no public output can still be inspected; the only valid explicit choice is to retain old consumers.
  const closedTarget = design('1.1.0'); closedTarget.blueprint.outputs = [];
  const closed = setup(design('1.0.0'), closedTarget);
  closed.trial.document.execution!.nodes.push(node('closedUse', 'stringify'));
  closed.trial.document.execution!.links.push({ source: source(closed.trial.map.get('parse0')!), target: { nodeId: 'closedUse', portId: 'value' } });
  const closedReport = previewS2CompositeOutputs(closed.prepare(), closed.trial.document, closed.trial.definition);
  assert.deepEqual(closedReport.items[0].options.map(option => option.id), ['keep']);
  assert.equal(checkS2CompositeOutputPlan(closedReport, closed.trial.document, closed.trial.definition,
    [{ key: closedReport.items[0].key, choice: 'keep' }]).status, 'checked');

  // Candidate input carry is preserved. Changing a different output can create a NEW cycle in the complete copy candidate.
  const cycleOld = design('1.0.0', 2, false); cycleOld.blueprint.parameters = cycleOld.blueprint.parameters.filter(item => item.id !== 'value1');
  cycleOld.blueprint.inputs = [{ id: 'external', label: '外部文本', type: textType, required: true, multiple: false, targets: [{ nodeId: 'parse1', portId: 'text' }] }];
  const cycleTarget = structuredClone(cycleOld); cycleTarget.blueprint.version = '1.1.0';
  const cycle = setup(cycleOld, cycleTarget), cycleGraph = cycle.trial.document.execution!;
  cycleGraph.nodes.push(node('between', 'stringify'));
  cycleGraph.links.push({ source: source(cycle.trial.map.get('parse0')!), target: { nodeId: 'between', portId: 'value' } },
    { source: { nodeId: 'between', portId: 'text' }, target: { nodeId: cycle.trial.map.get('parse1')!, portId: 'text' } });
  const cycleCandidate = cycle.prepare(), cycleReport = previewS2CompositeOutputs(cycleCandidate, cycle.trial.document, cycle.trial.definition);
  assert.equal(cycleReport.items.length, 1, 'The copy incoming reference is not an original outgoing consumer');
  assert.equal(cycleReport.items[0].options.find(option => option.id === outputId('result0'))!.eligible, true);
  assert.equal(cycleReport.items[0].options.find(option => option.id === outputId('result1'))!.eligible, false);
  assert.match(cycleReport.items[0].options.find(option => option.id === outputId('result1'))!.reason, /循环/);
  assert.equal(readS2CompositeCopyDesign(cycleCandidate, cycle.trial.document, cycle.trial.definition).execution.links.filter(link => link.source.nodeId === 'between').length, 1);

  // A copied input may reference the original instance, but it was not a consumer in the original graph.
  const carry = setup(); const carryDoc = carry.trial.document;
  carryDoc.execution!.nodes.push(node('carrySource', 'stringify', { value: literal(false) }));
  carryDoc.composites!.find(item => item.id === carry.trial.id)!.nodeIds.push('carrySource');
  // Carry through an unchanged PUBLIC input instead of a private/internal source is intentionally not allowed by migration.
  assert.equal(previewS2CompositeOutputs(carry.prepare(), carry.trial.document, carry.trial.definition).items.length, 0);

  // Outer shells are display metadata, not phantom consumers, and copy inspection never changes memberships.
  const nested = setup(); nested.trial.document.execution!.nodes.push({ ...node('insideCondition', 'stringify', { value: literal(0) }),
    when: { ...source(nested.trial.map.get('parse0')!), pointer: '', equals: false, match: true } });
  const shell = wrapS2CanvasComposite(nested.trial.document, nested.trial.definition.plugins,
    [...nested.trial.document.composites!.find(item => item.id === nested.trial.id)!.nodeIds, 'insideCondition'], '外层组合');
  nested.trial.document = readS2Document(shell.document, nested.trial.definition);
  const nestedBefore = JSON.stringify(nested.trial.document.composites), nestedCandidate = nested.prepare();
  const nestedReport = previewS2CompositeOutputs(nestedCandidate, nested.trial.document, nested.trial.definition);
  assert.equal(nestedReport.items.length, 1); assert.equal(nestedReport.items[0].kind, 'condition');
  assert.equal(checkS2CompositeOutputPlan(nestedReport, nested.trial.document, nested.trial.definition,
    nestedReport.items.map(item => ({ key: item.key, choice: outputId('result0') }))).status, 'checked');
  assert.equal(JSON.stringify(nested.trial.document.composites), nestedBefore);

  // Bounded Cartesian inspection: reject the whole preview, not a misleading partially compatible report.
  const large = setup(design('1.0.0', 1, false), design('1.1.0', 16, false));
  for (let index = 0; index < 9; index++) {
    large.trial.document.execution!.nodes.push(node(`consumer${index}`, 'stringify'));
    large.trial.document.execution!.links.push({ source: source(large.trial.map.get('parse0')!), target: { nodeId: `consumer${index}`, portId: 'value' } });
  }
  const largeCandidate = large.prepare(); assert.throws(() => previewS2CompositeOutputs(largeCandidate, large.trial.document, large.trial.definition), /影响方案过多.*未生成完整/);
  assert.equal(isS2CompositeCopyCurrent(largeCandidate, large.trial.document, large.trial.definition), true);
  assert.equal(network, 0);
  console.log('S2 output reconnection preview passed: original actual outgoing data and conditions, explicit keep vs exact public outputs, edited/non-public producers, no pointer/value disclosure, type/condition checks, candidate-input-aware cycles and joint duplicate rejection, native falsy preservation, whole document/config/candidate/report freshness and retirement, no copy consumption/commands/commit/IO/runtime effects, and bounded all-or-nothing preview workload.');
} finally { host.close(); globalThis.fetch = previousFetch; }
