// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2DesignBrief, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2BusinessPackage } from '../src/types/sceneS2Business';
import { applyS2Commands, createS2Scene, designS2Canvas, exportS2Subgraph, exportS2Workspace, importS2Subgraph, importS2Workspace, interactS2Canvas, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { readS2BusinessPackage, s2BusinessProtocolFacts, s2BusinessRuntimeContext } from '../src/services/scene/sceneS2Business';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT } from '../src/services/scene/sceneS2PluginHost';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';
import { s2TableToRecords } from '../src/services/scene/sceneS2Structured';
import { harness } from './scene-s2-ui-harness';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { readS2AssessmentRequest } from '../src/services/scene/sceneS2Assessment';
import { s2BusinessDesignIssues } from '../src/services/scene/sceneS2BusinessDiagnostics';

globalThis.fetch = async () => assert.fail('S2 business checks are synthetic/offline; no model, notes, profile or network');
const clone = <T>(value: T): T => structuredClone(value);
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic record-table exercise', knowledgePoints: [], sceneSkill: 'S2' });
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const workflowNode = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId = 'structured-data'): S2WorkflowNode => ({
  id, ...cap(capabilityId, pluginId), bindings, position: { x: 100, y: 100 },
});
const records = [{ name: 'PrivateReferenceBody', score: 80 }];
const brief: S2DesignBrief = { goal: 'Display an editable record array as a table',
  requirements: [{ id: 'ReadRecords', description: 'Read a record array', source: 'task', quote: 'record array' },
    { id: 'ShowTable', description: 'Show a typed table', source: 'task', quote: 'table' }],
  userRole: 'Build a compatible route', agentRole: 'Discuss without compulsory edits or execution', assumptions: [], openQuestions: [],
  delivery: { initial: 'Editable empty source and authorized capability library', deferred: 'Learner creates their own route', source: 'task', quote: 'record array' } };
const base: S2CanvasDefinition = { ...scene.canvasWorkspace!, designBrief: brief,
  plugins: [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')],
  initial: { nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: '' } }], edges: [] } };
const reference: S2Document = { nodes: [{ id: 'PrivateSource', type: 'text', position: { x: 0, y: 0 }, values: { content: JSON.stringify(records) } }], edges: [],
  execution: { version: 1, nodes: [workflowNode('PrivateParse', 'parse-json', { text: { kind: 'field', nodeId: 'PrivateSource', fieldId: 'content' } }),
    workflowNode('PrivateTable', 'to-table'), workflowNode('PrivateView', 'table', {}, 'structured-view')],
    links: [{ source: { nodeId: 'PrivateParse', portId: 'value' }, target: { nodeId: 'PrivateTable', portId: 'value' } },
      { source: { nodeId: 'PrivateTable', portId: 'table' }, target: { nodeId: 'PrivateView', portId: 'table' } }] } };
const business: S2BusinessPackage = { version: 1, purpose: 'Display synthetic records, with an editable learner exercise',
  knowledge: [1, 2, 3, 4].map(number => ({ id: `Skill${number}`, title: `Business concept ${number}`, content: `PrivateKnowledgeBody${number}` })),
  workflow: [{ id: 'Read', goal: 'Read structured record input', actor: 'tool', capabilities: [cap('parse-json')], input: 'Record JSON text', output: 'Structured records' },
    { id: 'Display', goal: 'Convert and show records', actor: 'tool', capabilities: [cap('to-table'), cap('table', 'structured-view')], input: 'Structured records', output: 'A table' }],
  completion: { mode: 'execution', reference, targetNodeIds: ['PrivateView'], coverage: [
    { requirementId: 'ReadRecords', stepIds: ['Read'], nodeIds: ['PrivateParse'] },
    { requirementId: 'ShowTable', stepIds: ['Display'], nodeIds: ['PrivateTable', 'PrivateView'] },
  ] },
  criteria: [{ id: 'PrivateCriterion', label: 'Synthetic local key regression', expectation: 'Check a declared text marker; no claim of real teaching sufficiency',
    method: 'local', required: true, target: { nodeId: 'source', fieldId: 'content' }, rule: { kind: 'text-includes', value: 'PrivateLocalAnswerValue' } },
    { id: 'BusinessSuggestion', label: 'Optional design suggestion', expectation: 'Open suggestions must not masquerade as required grading criteria', method: 'advisory', required: false }],
};
const original = JSON.stringify({ base, business });
const definition = readS2Definition({ ...base, business }, { requireBusiness: true });
const diagnosticDraft = clone(definition);
diagnosticDraft.business!.completion.reference.nodes.push(clone(reference.execution!.nodes[0]) as any);
diagnosticDraft.business!.completion.coverage[0].nodeIds.push('NeverDeclared');
diagnosticDraft.business!.completion.coverage[0].stepIds.push('NeverDeclaredStep');
diagnosticDraft.business!.completion.coverage[1].nodeIds = ['PrivateParse'];
const diagnosticBefore = JSON.stringify(diagnosticDraft), aggregated = s2BusinessDesignIssues(diagnosticDraft);
assert.ok(aggregated.some(issue => issue.code === 'misplaced-execution-node' && issue.path === '/business/completion/reference/nodes/1'));
assert.ok(aggregated.some(issue => issue.code === 'missing-reference-node' && issue.path === '/business/completion/coverage/0/nodeIds/1'));
assert.ok(aggregated.some(issue => issue.code === 'missing-workflow-step' && issue.path === '/business/completion/coverage/0/stepIds/1'));
const missingCoverage = aggregated.filter(issue => issue.code === 'uncovered-step-capability' && issue.path === '/business/completion/coverage/1/nodeIds');
assert.equal(missingCoverage.length, 2, 'One repair sees both omitted capability implementations, not just the first fail-fast error');
assert.deepEqual(missingCoverage.map(issue => issue.matchingReferenceNodeIds), [['PrivateTable'], ['PrivateView']]);
assert.ok(missingCoverage.every(issue => issue.relatedPaths!.some(path => path.startsWith('/business/workflow/1/capabilities/'))));
assert.equal(JSON.stringify(diagnosticDraft), diagnosticBefore, 'Business diagnostics never mutate a draft, invent nodes, repair the graph or execute it');
assert.throws(() => readS2Definition(diagnosticDraft, { requireBusiness: true }), undefined, 'Diagnostics do not bypass the original strict validator');
assert.deepEqual(s2BusinessDesignIssues(definition), [], 'No structural repair hint is not an execution or semantic acceptance record');
assert.deepEqual(s2BusinessDesignIssues(definition, brief), []);
const incompleteCoverage = clone(diagnosticDraft);
incompleteCoverage.business!.completion.coverage = [clone(business.completion.coverage[0]), clone(business.completion.coverage[0]),
  { ...clone(business.completion.coverage[1]), requirementId: 'Invented' }];
const untrustedCoverageBefore = JSON.stringify(incompleteCoverage);
const coverageIssues = s2BusinessDesignIssues({ ...incompleteCoverage, designBrief: { requirements: [{ id: 'Invented' }] } }, brief);
assert.ok(coverageIssues.some(issue => issue.code === 'misplaced-execution-node'), 'Other structural errors must not mask missing requirement IDs');
assert.deepEqual(coverageIssues.filter(issue => issue.code === 'missing-requirement-coverage').map(issue => issue.requirementId), ['ShowTable']);
assert.ok(coverageIssues.some(issue => issue.code === 'unknown-requirement-coverage' && issue.path === '/business/completion/coverage/2/requirementId'));
assert.ok(coverageIssues.some(issue => issue.code === 'duplicate-requirement-coverage' && issue.path === '/business/completion/coverage/1/requirementId'));
assert.equal(JSON.stringify(incompleteCoverage), untrustedCoverageBefore, 'Diagnostics do not fill coverage, choose workflow steps or accept the draft');
const missingPolicy = s2BusinessDesignIssues(definition, { requirements: [...brief.requirements, { id: 'Policy', description: 'PRIVATE_DESCRIPTION_NOT_FOR_DIAGNOSTICS' }] });
assert.deepEqual(missingPolicy.map(issue => issue.requirementId), ['Policy']);
assert(!JSON.stringify(missingPolicy).includes('PRIVATE_DESCRIPTION_NOT_FOR_DIAGNOSTICS'), 'Only actual IDs/paths are copied, not requirement or private witness bodies');
const emptyCoverage = clone(definition);
emptyCoverage.business!.completion.coverage[1].stepIds = [];
emptyCoverage.business!.completion.coverage[1].nodeIds = [];
const emptyIssues = s2BusinessDesignIssues(emptyCoverage, brief);
assert.ok(emptyIssues.some(issue => issue.code === 'empty-coverage-steps' && issue.path === '/business/completion/coverage/1/stepIds'));
assert.ok(emptyIssues.some(issue => issue.code === 'empty-coverage-nodes' && issue.path === '/business/completion/coverage/1/nodeIds'));
assert.ok(emptyIssues.some(issue => issue.code === 'uncovered-workflow-step' && issue.relatedPaths![0] === '/business/workflow/1/id'));
assert.throws(() => readS2Definition(emptyCoverage, { requireBusiness: true }), /真实业务步骤/, 'Aggregated hints do not relax the original strict coverage gate');
const briefAccessor = {};
Object.defineProperty(briefAccessor, 'requirements', { get() { assert.fail('Do not evaluate independent brief accessors'); } });
assert.ok(s2BusinessDesignIssues(definition, briefAccessor).some(issue => issue.code === 'unsafe-diagnostic-input'));
const accessors: Record<string, unknown> = {};
Object.defineProperty(accessors, 'business', { get() { assert.fail('Diagnostic cannot evaluate accessors'); } });
assert.ok(s2BusinessDesignIssues(accessors).some(issue => issue.code === 'unsafe-diagnostic-input' && issue.path === '/business'));
const nodeAccessorDraft = clone(definition);
Object.defineProperty(nodeAccessorDraft.business!.completion.reference.nodes[0], 'id', { get() { assert.fail('Diagnostic cannot evaluate nested accessors'); } });
assert.ok(s2BusinessDesignIssues(nodeAccessorDraft).some(issue => issue.path === '/business/completion/reference/nodes/0/id'));
const arrayAccessorDraft = clone(definition);
Object.defineProperty(arrayAccessorDraft.business!.completion.coverage[0].nodeIds, 0, { get() { assert.fail('Diagnostic cannot evaluate list accessors'); } });
assert.ok(s2BusinessDesignIssues(arrayAccessorDraft).some(issue => issue.path === '/business/completion/coverage/0/nodeIds/0'));
const cyclic: any = {}; cyclic.business = cyclic; cyclic.completion = cyclic; cyclic.reference = cyclic; cyclic.nodes = [cyclic]; cyclic.workflow = [cyclic]; cyclic.coverage = [cyclic];
for (const unsafe of [undefined, null, 1, 'not a draft', [], { business: null }, { business: Object.create({ completion: reference }) }, cyclic]) {
  assert.doesNotThrow(() => s2BusinessDesignIssues(unsafe), 'Malformed/prototype/cyclic input is inspected only at bounded named paths, never recursively traversed');
}
const largeDiagnostic = clone(diagnosticDraft);
largeDiagnostic.business!.completion.reference.nodes = Array.from({ length: 1000 }, () => clone(reference.execution!.nodes[0]) as any);
largeDiagnostic.business!.workflow = Array.from({ length: 1000 }, () => clone(business.workflow[0]));
largeDiagnostic.business!.completion.coverage = Array.from({ length: 1000 }, () => clone(diagnosticDraft.business!.completion.coverage[1]));
const boundedIssues = s2BusinessDesignIssues(largeDiagnostic);
assert.ok(boundedIssues.length <= 160 && boundedIssues.some(issue => issue.code === 'diagnostic-limit'));
assert.ok(!boundedIssues.some(issue => /\/reference\/nodes\/(?:[4-9]\d|\d{3})/.test(issue.path)), 'At most40 nodes in each declared node list are inspected');
assert.equal(JSON.stringify({ base, business }), original, 'Static acceptance is pure and never writes the private witness into the initial exercise');
assert.equal(definition.initial.nodes[0].values.content, ''); assert.equal(definition.initial.execution, undefined);
assert.deepEqual(selectS2Execution(definition.business!.completion.reference, definition.plugins, ['PrivateView']).order, ['PrivateParse', 'PrivateTable', 'PrivateView']);
const facts = s2BusinessProtocolFacts(definition.business!, definition);
assert.equal(facts.protocolReady, true); assert.equal(facts.executed, false); assert.equal(facts.permissionGranted, false);
assert.equal(facts.businessSuccess, 'not-assessed', 'Typed feasibility is not a fabricated semantic business pass');
const initialHost = new S2PluginHost('business-initial', []); initialHost.setDocument(definition.initial);
assert.equal(initialHost.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.deepEqual(initialHost.history(), []); assert.deepEqual(initialHost.workflowHistory(), []);
initialHost.close();

let rejections = 0;
function rejects(mutate: (value: S2CanvasDefinition) => void, pattern?: RegExp) {
  const changed = clone(definition); mutate(changed);
  assert.throws(() => readS2Definition(changed, { requireBusiness: true }), pattern); rejections++;
}
rejects(value => { value.business!.completion.reference.execution!.links.shift(); }, /必填/);
rejects(value => { value.business!.completion.reference.execution!.nodes.push(workflowNode('UnrelatedIncomplete', 'parse-json')); }, /必填/);
rejects(value => { value.business!.completion.reference.execution!.nodes[0].pluginId = 'invented-plugin'; });
rejects(value => { value.business!.workflow[0].capabilities[0].pluginId = 'invented-plugin'; });
rejects(value => { value.business!.workflow[0].capabilities = [cap('validate', 'json-check')]; }, /未装配/);
rejects(value => { value.business!.completion.reference.execution!.nodes.push(workflowNode('UnapprovedCheck', 'validate', { text: { kind: 'literal', value: '{}' } }, 'json-check')); }, /未装配/);
rejects(value => { value.business!.completion.reference.execution!.links[0].source.portId = 'text'; });
rejects(value => { value.business!.completion.reference.execution!.nodes[1].bindings.value = { kind: 'field', nodeId: 'PrivateSource', fieldId: 'content' }; }, /类型/);
rejects(value => { value.business!.completion.reference.execution!.links[0].source.nodeId = 'NotPresent'; });
rejects(value => { value.business!.completion.targetNodeIds = ['NotPresent']; }, /目标/);
rejects(value => { value.business!.completion.targetNodeIds = ['PrivateSource']; }, /目标/);
rejects(value => { value.business!.completion.targetNodeIds = []; }, /目标/);
rejects(value => { value.business!.completion.coverage.pop(); }, /每个业务步骤|逐项覆盖/);
rejects(value => { value.business!.completion.coverage = []; }, /每个业务步骤/);
rejects(value => { value.business!.completion.coverage[1].requirementId = 'InventedRequirement'; }, /逐项覆盖/);
rejects(value => { value.business!.completion.coverage[1].stepIds = ['InventedStep']; }, /真实业务步骤/);
rejects(value => { value.business!.completion.coverage[1].nodeIds = ['InventedNode']; }, /真实参考节点/);
rejects(value => { value.business!.completion.coverage[1].nodeIds = ['PrivateParse']; }, /未实现/);
rejects(value => { value.business!.workflow[0].capabilities = []; }, /真实已安装能力/);
rejects(value => { value.business!.completion.mode = 'canvas'; }, /不能据此声称工具执行/);
rejects(value => { (value.business as any).grant = { permissions: ['network'] }; }, /未知字段/);
rejects(value => { value.business!.criteria[0].method = 'advisory'; value.business!.criteria[0].required = true; delete value.business!.criteria[0].rule; }, /建议不能/);
rejects(value => { value.business!.criteria[0].target!.nodeId = 'PrivateSource'; }, /初始画布真实内容字段/);
rejects(value => { value.business!.criteria[0].rule = { kind: 'json-pointer-equals', pointer: '/__proto__', value: true }; }, /原型保留/);
rejects(value => { value.business!.knowledge[1].id = value.business!.knowledge[0].id; }, /不能重复/);

const runtime = s2BusinessRuntimeContext(definition.business!);
const runtimeJson = JSON.stringify(runtime);
for (const secret of ['PrivateReferenceBody', 'PrivateSource', 'PrivateParse', 'PrivateTable', 'PrivateView', 'PrivateLocalAnswerValue', 'targetNodeIds', 'coverage', 'reference']) {
  assert.ok(!runtimeJson.includes(secret), `Learner runtime context must not disclose ${secret}`);
}
assert.equal(runtime.knowledge.length, 0); assert.equal(runtime.knowledgeIndex.length, 4);
assert.ok(!runtimeJson.includes('PrivateKnowledgeBody'), 'The semantic intent phase sees an index, not all knowledge bodies');
const recalled = s2BusinessRuntimeContext(definition.business!, ['Skill1', 'Skill3']);
assert.deepEqual(recalled.knowledge.map(item => item.id), ['Skill1', 'Skill3']);
assert.ok(!JSON.stringify(recalled).includes('PrivateKnowledgeBody2')); assert.ok(!JSON.stringify(recalled).includes('PrivateKnowledgeBody4'));
assert.throws(() => s2BusinessRuntimeContext(definition.business!, ['Skill1', 'Skill2', 'Skill3', 'Skill4']), /最多3/);
assert.throws(() => s2BusinessRuntimeContext(definition.business!, ['Skill1', 'Skill1']), /不能重复/);
assert.throws(() => s2BusinessRuntimeContext(definition.business!, ['InventedSkill']), /不存在/);
recalled.workflow[0].capabilities.length = 0; recalled.knowledge[0].content = 'caller changed';
assert.equal(definition.business!.workflow[0].capabilities.length, 1); assert.equal(definition.business!.knowledge[0].content, 'PrivateKnowledgeBody1');
let runtimeStubCalls = 0;
await interactS2Canvas({ ...scene, canvasWorkspace: definition }, definition.initial, 'Explain the second business concept without changing or running the canvas', 'source', [], {
  invoke: async request => {
    runtimeStubCalls++;
    const input = JSON.parse(request.userInput), serialized = request.userInput;
    for (const secret of ['PrivateReferenceBody', 'PrivateSource', 'PrivateParse', 'PrivateTable', 'PrivateView', 'PrivateLocalAnswerValue']) {
      assert.ok(!serialized.includes(secret), `Production runtime ${input.stage} payload must not leak ${secret}`);
    }
    assert.equal(input.businessSkill.completion.executed, false);
    if (input.stage === 'turn-understand') {
      assert.deepEqual(input.businessSkill.knowledge, []);
      assert.ok(!serialized.includes('PrivateKnowledgeBody'));
      return { content: JSON.stringify({ understanding: 'Discuss one requested concept only', desiredOutcome: 'Explain without edits or execution',
        actions: ['reply'], constraints: [], questions: [], skillIds: ['Skill2'] }) };
    }
    assert.equal(input.stage, 'turn-act');
    assert.deepEqual(input.businessSkill.knowledge.map((item: { id: string }) => item.id), ['Skill2']);
    assert.ok(serialized.includes('PrivateKnowledgeBody2')); assert.ok(!serialized.includes('PrivateKnowledgeBody1'));
    return { content: JSON.stringify({ understanding: 'Explain the requested concept', plan: 'Discussion only', reply: 'Synthetic explanation, no operation', commands: [] }) };
  },
});
assert.equal(runtimeStubCalls, 2, 'On-demand business context reuses the existing understand/action stages without a new tool call');

const legacy = readS2Definition(base); assert.equal(legacy.business, undefined, 'Saved legacy scenes remain readable without inventing a completion witness');
assert.throws(() => readS2Definition(base, { requireBusiness: true }), /必须提供business/);
assert.deepEqual(importS2Workspace(exportS2Workspace(legacy, legacy.initial)), legacy);
assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition, 'Full design export retains business guidance and private design witness, not run authority');
for (const segments of [16, 17]) {
  const withPointer = clone(definition);
  withPointer.business!.criteria[0].rule = { kind: 'json-pointer-equals', pointer: '/a'.repeat(segments), value: true };
  const parsed = readS2Definition(withPointer, { requireBusiness: true });
  const saved = importS2Workspace(exportS2Workspace(parsed, parsed.initial));
  assert.deepEqual(saved.business!.criteria[0].rule, withPointer.business!.criteria[0].rule,
    `${segments}-segment pointers accepted during design remain compatible with saved/imported scenes`);
  saved.initial.nodes[0].values.content = '{}';
  assert.equal(readS2AssessmentRequest({ criterionIds: ['PrivateCriterion'] }, saved.business!, saved.initial).overall, 'unmet',
    'A legal absent path is a normal local mismatch, not a runtime protocol-repair failure');
}
for (const sharedRule of [
  { kind: 'text-includes', value: 'T'.repeat(1000) },
  { kind: 'text-length', min: 0, max: 6000 },
  { kind: 'json-pointer-equals', pointer: '/' + 'a'.repeat(499), value: 'J'.repeat(4094) },
] as const) {
  const withRule = clone(definition); withRule.business!.criteria[0].rule = sharedRule;
  const saved = importS2Workspace(exportS2Workspace(readS2Definition(withRule, { requireBusiness: true }), withRule.initial));
  saved.initial.nodes[0].values.content = '{}';
  assert.doesNotThrow(() => readS2AssessmentRequest({ criterionIds: ['PrivateCriterion'] }, saved.business!, saved.initial),
    'Rule text/length/expected-JSON bounds accepted by the builder are also accepted by assessment');
}
for (const invalidPointer of ['/bad~2path', '/__proto__', '/constructor/prototype', '/' + 'a'.repeat(500)]) {
  const invalid = clone(definition); invalid.business!.criteria[0].rule = { kind: 'json-pointer-equals', pointer: invalidPointer, value: true };
  assert.throws(() => readS2Definition(invalid, { requireBusiness: true }));
  assert.throws(() => exportS2Workspace(invalid, invalid.initial), undefined, 'Saving never relaxes rule syntax or permission boundaries');
  assert.throws(() => importS2Workspace(JSON.stringify({ format: 's2-workspace', version: 1, definition: invalid })), undefined,
    'Import shares the same local-rule parser as fresh building and assessment');
}
const largeWorkspace = clone(definition);
largeWorkspace.initial.nodes[0].values.content = 'L'.repeat(6000);
largeWorkspace.initial.nodes.push(...Array.from({ length: 9 }, (_, i) => ({ id: `LearnerLarge${i}`, type: 'text', position: { x: 0, y: i * 30 }, values: { content: 'L'.repeat(6000) } })));
largeWorkspace.business!.completion.reference.nodes.push(...Array.from({ length: 10 }, (_, i) => ({ id: `ReferenceLarge${i}`, type: 'text', position: { x: 0, y: i * 30 }, values: { content: 'R'.repeat(6000) } })));
largeWorkspace.business!.knowledge = Array.from({ length: 3 }, (_, i) => ({ id: `LargeKnowledge${i}`, title: 'Bounded knowledge', content: 'K'.repeat(3000) }));
const serializedLarge = exportS2Workspace(largeWorkspace, largeWorkspace.initial);
assert.ok(serializedLarge.length > 128000, 'A legal learner canvas plus a legal private witness may exceed the old envelope');
assert.deepEqual(importS2Workspace(serializedLarge), readS2Definition(largeWorkspace), 'Export/import share the full-template container limit without truncating either document');
const deletedTargetDefinition = { ...definition, initial: { nodes: [], edges: [] } };
assert.throws(() => readS2BusinessPackage(business, deletedTargetDefinition, readS2Document, brief), /初始画布真实内容字段/);
assert.equal(readS2BusinessPackage(business, deletedTargetDefinition, readS2Document, brief, { strictTargets: false }).criteria[0].target!.nodeId, 'source',
  'Persisting a later user deletion preserves the declared criterion for an uncertain assessment, not an edit lock');
const badSavedRule = clone(business); badSavedRule.criteria[0].rule = { kind: 'text-length', min: 100, max: 1 };
assert.throws(() => readS2BusinessPackage(badSavedRule, deletedTargetDefinition, readS2Document, brief, { strictTargets: false }), /长度上下界/);
const portable = JSON.parse(exportS2Subgraph(definition, definition.initial, ['source']));
assert.equal(portable.definition.business, undefined, 'A reusable fragment must not carry a scene-wide private answer or evaluator');
assert.equal(portable.definition.designBrief, undefined, 'A fragment cannot pretend to cover the full original scene request');
const pasted = importS2Subgraph(JSON.stringify(portable), definition, definition.initial);
assert.equal(pasted.document.nodes.length, 2); assert.deepEqual(definition.business!.completion.reference, reference);
const synthetic = syntheticS2Business(base, brief);
assert.equal(readS2Definition({ ...base, business: synthetic }, { requireBusiness: true }).business!.completion.mode, 'canvas');
assert.equal(synthetic.completion.reference.execution, undefined);
assert.throws(() => readS2Definition({ ...base, business: { ...synthetic, workflow: [{ ...synthetic.workflow[0], capabilities: [cap('parse-json')] }] } }), /canvas/);

// A business package is optional for a fresh user-led experiment; its absence
// must not create a repair, a hidden default witness or a paid reviewer.
const builderScene = createS2Scene({ source: 'custom', subject: 'Synthetic record-table exercise', extraHints: 'record array table', knowledgePoints: [], sceneSkill: 'S2' });
const { designBrief: _brief, business: _business, ...withoutBusiness } = definition;
const missingStages: string[] = [];
const lightAccepted = await designS2Canvas(builderScene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); missingStages.push(input.stage);
  if (input.stage === 'understand') return { content: JSON.stringify(brief) };
  assert.equal(input.stage, 'assemble', 'The default builder performs only local validation after assembly');
  return { content: JSON.stringify(withoutBusiness) };
} });
assert.equal(lightAccepted.business, undefined);
assert.deepEqual(missingStages, ['understand', 'assemble']);
const acceptedStages: string[] = [];
const { designBrief: _independentBrief, ...assembly } = definition;
const accepted = await designS2Canvas(builderScene, { disclosure: 'complete', review: true, invoke: async request => {
  const input = JSON.parse(request.userInput); acceptedStages.push(input.stage);
  if (input.stage === 'understand') return { content: JSON.stringify(brief) };
  if (input.stage === 'assemble') return { content: JSON.stringify(assembly) };
  assert.equal(input.stage, 'review');
  assert.equal(input.candidate.initial.nodes[0].values.content, '');
  assert.equal(input.candidate.initial.execution, undefined);
  assert.equal(input.protocolFacts.business.permissionGranted, false);
  return { content: JSON.stringify({ verdict: 'accept', factChecks: [], coverage: brief.requirements.map(requirement => ({
    requirementId: requirement.id, status: 'covered', evidencePaths: ['/business/completion'], reason: 'Synthetic protocol exercise only; not semantic sufficiency evidence',
  })), feedback: 'Synthetic builder protocol accepted, not a real semantic judgement' }) };
} });
assert.deepEqual(acceptedStages, ['understand', 'assemble', 'review'], 'A valid business package adds no fixed extra teaching/model stage');
assert.deepEqual(accepted.initial, definition.initial, 'A complete private feasibility witness must not replace the deliberately incomplete learner exercise');
assert.deepEqual(accepted.business!.completion.reference, reference);

// Use real production edit/run handlers without ANY Agent call. The learner chooses
// a different legal path: direct record literal -> table -> view, with no parser.
let capturedHost: S2PluginHost | undefined;
const ui = harness({ initialDraft: { ...scene, canvasWorkspace: definition }, onHost: host => { capturedHost = host; } });
assert.equal(ui.modelCalls(), 0); assert.equal(ui.flow().props.nodes.length, 1);
assert.ok(ui.text().includes('业务目标、完成能力与评价标准'));
assert.ok(ui.text().includes(business.purpose)); assert.ok(ui.text().includes('Synthetic local key regression'));
assert.ok(ui.text().includes('本地核对')); assert.ok(ui.text().includes('必需指标'));
assert.ok(ui.text().includes('Optional design suggestion')); assert.ok(ui.text().includes('仅供建议'));
for (const secret of ['PrivateReferenceBody', 'PrivateSource', 'PrivateParse', 'PrivateTable', 'PrivateView', 'PrivateLocalAnswerValue']) {
  assert.ok(!ui.text().includes(secret), `Preview must not display the private witness or local answer: ${secret}`);
}
assert.ok(!ui.flow().props.nodes.some((node: any) => node.id.startsWith('Private')), 'Private solution is never materialized into the learner canvas');
function addCapability(capabilityId: string, pluginId = 'structured-data') {
  ui.labelControl('添加的执行能力', 'select').props.onChange({ target: { value: `${pluginId}@1.0.0/${capabilityId}` } }); ui.render();
  ui.button('添加执行节点').props.onClick(); ui.render();
  return ui.flow().props.nodes.find((node: any) => node.type === 'execution' && node.selected).id as string;
}
const tableId = addCapability('to-table');
const tableValue = ui.elements().find(element => element.type === 'json-parameter' && element.props.portId === 'value'); assert.ok(tableValue);
const userRecords = [{ name: 'LearnerChoice', score: 93 }, { name: 'AlternativeRoute', score: 77 }];
tableValue.props.onCommit(userRecords); ui.render();
const viewId = addCapability('table', 'structured-view');
ui.flow().props.onConnect({ source: tableId, sourceHandle: 'out:table', target: viewId, targetHandle: 'in:table' }); ui.render();
assert.equal(ui.flow().props.nodes.length, 3, 'The learner is not forced to copy the reference three-tool solution');
ui.button('开始试验').props.onClick(); ui.render();
assert.ok(capturedHost); assert.equal(capturedHost!.remainingCalls, S2_LOCAL_RUN_LIMIT);
assert.deepEqual(capturedHost!.workflowHistory(), []); assert.deepEqual(capturedHost!.history(), [], 'Starting a business scene must not run the private witness or grade it');
ui.button('运行所选步骤').props.onClick();
for (let attempt = 0; attempt < 400; attempt++) {
  ui.render(); if (ui.flow().props.nodes.find((node: any) => node.id === viewId).data.status === 'displayed') break;
  await new Promise(resolve => setTimeout(resolve, 5));
}
ui.render();
const displayed = ui.flow().props.nodes.find((node: any) => node.id === viewId);
assert.equal(displayed.data.status, 'displayed'); assert.equal(ui.modelCalls(), 0, 'Free manual component interaction never requires an LLM gate or lecture');
assert.deepEqual(s2TableToRecords(displayed.data.artifacts[0].payload.value), userRecords);
assert.equal(capturedHost!.remainingCalls, S2_LOCAL_RUN_LIMIT - 1, 'Only the user-selected real conversion executes; rendering is not a tool call');
assert.deepEqual(capturedHost!.workflowHistory()[0].nodes.map(node => node.nodeId), [tableId, viewId]);
assert.ok(!capturedHost!.history().some(item => item.request.nodeId.startsWith('Private')));
// A business package is not a grant. The same current graph fails on a separately
// created host with no approved capabilities, without dispatch or budget debit.
const edited = ui.drafts.at(-1).canvasWorkspace.initial as S2Document;
const denied = new S2PluginHost('business-denied', []); denied.setDocument(edited);
assert.throws(() => denied.enqueueWorkflow([viewId]), /未装配/);
assert.equal(denied.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.equal(denied.history().length, 0); denied.close();
const stillEditable = applyS2Commands(definition, edited, [{ op: 'remove-node', id: 'source' }]);
assert.equal(stillEditable.nodes.length, 0, 'An assessment target or private reference does not lock manual deletion');
assert.deepEqual(selectS2Execution(stillEditable, definition.plugins, [viewId]).order, [tableId, viewId]);
ui.dispose();

console.log(`S2 business passed: ${rejections} malformed/incomplete/out-of-scope witness rejections; private reference and local-rule redaction; bounded on-demand knowledge; legacy/full-workspace/subgraph boundaries; real production manual handlers and local record-to-table execution through a legal non-reference path with zero model calls. Static typed witness is NOT proof of semantic business sufficiency or browser E2E. Synthetic data only; no external services, paid calls, notes, profile or S4 engine access.`);
