import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2DesignBrief, S2Document } from '../src/types/sceneS2';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { readS2DesignReview } from '../src/services/scene/sceneS2Design';
import { readS2DesignFactChecks, readS2EvidenceQuote } from '../src/services/scene/sceneS2DesignEvidence';

globalThis.fetch = async () => assert.fail('Synthetic business evidence checks only; no models, notes, profile, network or real data');
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const content = (id: string, value: string) => ({ id, type: 'text', position: { x: 0, y: 0 }, values: { content: value } });
const parse = (id: string, sourceId: string, capability = cap('parse-json')) => ({ id, ...capability, position: { x: 100, y: 0 }, bindings: { text: { kind: 'field' as const, nodeId: sourceId, fieldId: 'content' } } });
const initial: S2Document = { nodes: [content('initialSource', 'Initial parser reads initialSource; initial display uses a literal and is not linked.')], edges: [],
  execution: { version: 1, nodes: [parse('sameParse', 'initialSource'), parse('typedShared', 'initialSource', cap('validate', 'json-check')),
    parse('InitialOnly', 'initialSource'), { id: 'sameShow', ...cap('json-tree', 'structured-view'), position: { x: 200, y: 0 }, bindings: { value: { kind: 'literal', value: { draft: true } } } }], links: [] } };
const reference: S2Document = { nodes: [content('referenceSource', 'Reference parser reads referenceSource; sameShow receives sameParse.value. This is a static witness, not a successful business execution.')], edges: [],
  execution: { version: 1, nodes: [parse('sameParse', 'referenceSource'), parse('typedShared', 'referenceSource'), parse('ReferenceOnly', 'referenceSource'),
    { id: 'sameShow', ...cap('json-tree', 'structured-view'), position: { x: 200, y: 0 }, bindings: {} }],
  links: [{ source: { nodeId: 'sameParse', portId: 'value' }, target: { nodeId: 'sameShow', portId: 'value' } }] } };
const brief: S2DesignBrief = { goal: 'Synthetic reference namespace regression', requirements: [{ id: 'ReferenceRoute', description: 'Reference route', source: 'task', quote: 'reference' }],
  userRole: 'Discuss', agentRole: 'Discuss', assumptions: [], openQuestions: [] };
const candidate = readS2Definition({ version: 1, goal: brief.goal, instructions: { understanding: 'Understand current intent', planning: 'Initial display uses a fixed literal; initial parser reads initialSource.', response: 'No automatic execution' },
  blockTypes: [{ id: 'text', label: 'Text', fields: [{ id: 'content', label: 'Content', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('validate', 'json-check'), cap('json-tree', 'structured-view')], initial,
  business: { version: 1, purpose: 'Reference parser and display demonstrate one static completion route.', knowledge: [{ id: 'Concept', title: 'Source semantics', content: 'Distinguish reference and initial graph namespaces.' }],
    workflow: [{ id: 'Route', goal: 'Reference parser feeds display', actor: 'tool', capabilities: [cap('parse-json'), cap('json-tree', 'structured-view')], input: 'Reference source text', output: 'Reference structured display' }],
    completion: { mode: 'execution', reference, targetNodeIds: ['sameShow'], coverage: [{ requirementId: 'ReferenceRoute', stepIds: ['Route'], nodeIds: ['sameParse', 'sameShow'] }] },
    criteria: [{ id: 'Advice', label: 'Optional guidance', expectation: 'No mandatory business pass', method: 'advisory', required: false }] } } satisfies S2CanvasDefinition, { requireBusiness: true });
const before = JSON.stringify(candidate);
const refPath = '/business/completion/reference/nodes/0/values/content';
const evidence = { path: refPath, quote: 'sameShow receives sameParse.value' };
const fact = (claim: unknown, matches = true, quote = evidence) => ({ ...quote, claim, matches });
const linkClaim = { kind: 'data-link', source: { nodeId: 'sameParse', portId: 'value' }, target: { nodeId: 'sameShow', portId: 'value' }, present: true };
const input = (nodeId: string, portId: string, source: unknown) => ({ kind: 'input-source', nodeId, portId, source });
const type = (nodeId: string, portId: string, direction: string, typeId: string) => ({ kind: 'port-type', nodeId, portId, direction, type: { id: typeId, version: 1 } });
const dependency = { kind: 'execution-dependency', nodeId: 'sameShow', dependsOnNodeId: 'sameParse', present: true };
const refFacts = [fact(linkClaim), fact(input('sameParse', 'text', { kind: 'field', nodeId: 'referenceSource', fieldId: 'content' })),
  fact(input('sameShow', 'value', { kind: 'execution-output', nodeId: 'sameParse', portId: 'value' })), fact(type('typedShared', 'value', 'output', 'structured-data.value')),
  fact(dependency), fact(input('ReferenceOnly', 'text', { kind: 'field', nodeId: 'referenceSource', fieldId: 'content' }))];
assert.deepEqual(readS2DesignFactChecks(refFacts, candidate), refFacts, 'Business facts resolve the private reference, including nodes absent from initial');
const initialEvidence = { path: '/initial/nodes/0/values/content', quote: 'initial display uses a literal' };
const initialFacts = [fact(linkClaim, false, initialEvidence), fact(input('sameShow', 'value', { kind: 'literal' }), true, initialEvidence),
  fact(input('sameParse', 'text', { kind: 'field', nodeId: 'initialSource', fieldId: 'content' }), true, initialEvidence),
  fact(type('typedShared', 'assessment', 'output', 'core.assessment'), true, initialEvidence), fact(dependency, false, initialEvidence)];
assert.deepEqual(readS2DesignFactChecks(initialFacts, candidate), initialFacts, 'Same IDs never cross graph namespaces for links, input sources, ports or dependencies');
const instructionEvidence = { path: '/instructions/planning', quote: 'Initial display uses a fixed literal' };
assert.equal(readS2DesignFactChecks([fact(input('sameShow', 'value', { kind: 'literal' }), true, instructionEvidence)], candidate)[0].matches, true, 'Legacy instructions still describe initial');
for (const [path, quote] of [
  ['/business/purpose', 'Reference parser'], ['/business/knowledge/0/title', 'Source semantics'], ['/business/knowledge/0/content', 'reference and initial'],
  ['/business/workflow/0/goal', 'Reference parser feeds display'], ['/business/workflow/0/input', 'Reference source text'], ['/business/workflow/0/output', 'Reference structured display'],
  ['/business/criteria/0/label', 'Optional guidance'], ['/business/criteria/0/expectation', 'No mandatory business pass'],
]) {
  assert.deepEqual(readS2EvidenceQuote({ path, quote }, candidate), { path, quote });
  assert.throws(() => readS2DesignFactChecks([fact(linkClaim, true, { path, quote })], candidate), /明确画布命名空间/,
    'General business prose is valid coverage evidence but cannot silently choose either graph for structural assertions');
}
for (const bad of [
  fact(linkClaim, false), fact(linkClaim, true, initialEvidence), fact(input('sameShow', 'value', { kind: 'literal' })),
  fact(input('sameParse', 'text', { kind: 'field', nodeId: 'initialSource', fieldId: 'content' })),
  fact(input('sameParse', 'text', { kind: 'field', nodeId: 'referenceSource', fieldId: 'content' }), true, initialEvidence),
  fact(input('InitialOnly', 'text', { kind: 'field', nodeId: 'initialSource', fieldId: 'content' })),
  fact(input('ReferenceOnly', 'text', { kind: 'field', nodeId: 'referenceSource', fieldId: 'content' }), true, initialEvidence),
  fact(type('typedShared', 'assessment', 'output', 'core.assessment')), fact(type('typedShared', 'value', 'output', 'structured-data.value'), true, initialEvidence),
  fact({ ...dependency, dependsOnNodeId: 'Ghost' }), fact({ ...linkClaim, target: { nodeId: 'sameShow', portId: 'Ghost' } }),
]) assert.throws(() => readS2DesignFactChecks([bad], candidate), /不符|不存在/);
for (const [path, quote] of [
  ['/business/workflow/0/id', 'Route'], ['/business/workflow/0/actor', 'tool'], ['/business/workflow/0/capabilities/0/pluginId', 'structured-data'],
  ['/business/completion/reference/execution/nodes/0/id', 'sameParse'], ['/business/completion/mode', 'execution'],
  ['/business/completion/targetNodeIds/0', 'sameShow'], ['/business/criteria/0/id', 'Advice'], ['/business/__proto__/purpose', 'Reference'],
  ['/business/knowledge/8/content', 'Missing'], ['/business/completion/reference/nodes/8/values/content', 'Ghost'],
  [refPath, 'concatenated…not genuine'], ['D:/secret.txt', 'Reference'],
]) assert.throws(() => readS2EvidenceQuote({ path, quote }, candidate), /连续原文/);
const review = { verdict: 'accept', coverage: [{ requirementId: 'ReferenceRoute', status: 'covered', evidencePaths: [refPath], evidenceQuotes: [evidence], reason: 'Synthetic static reference evidence only; not actual business success' }],
  factChecks: refFacts, feedback: 'Synthetic namespace regression, not real-model semantic acceptance' };
const accepted = readS2DesignReview(review, brief, candidate, { strictEvidence: true });
assert.equal(accepted.verdict, 'accept'); assert.equal(accepted.factChecks!.length, refFacts.length);
const wrongReview = { ...review, factChecks: [fact(linkClaim, false)] };
assert.throws(() => readS2DesignReview(wrongReview, brief, candidate, { strictEvidence: true }), /不符/);
const blank = structuredClone(candidate); blank.business!.completion.reference.nodes[0].values.content = '';
assert.deepEqual(readS2EvidenceQuote({ path: refPath, quote: '' }, blank, { allowEmpty: true }), { path: refPath, quote: '' });
assert.throws(() => readS2EvidenceQuote({ path: '/business/purpose', quote: '' }, blank, { allowEmpty: true }));
assert.equal(JSON.stringify(candidate), before, 'Namespace fact checks and full review do not mutate, execute, authorize or publish private reference data to the learner');
console.log('S2 business evidence passed: grounded business prose/reference quotes, namespace-specific link/source/port/dependency recomputation, same-ID isolation, phantom endpoint/ID/authority/quote rejection, legacy initial behavior and complete design-review integration. Synthetic static checks only; not business success or model-quality evidence.');
