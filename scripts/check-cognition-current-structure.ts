import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentCognitionFixture } from './fixtures/cognition-current-structure';
import { applyCognitionMutation, cognitionGraph, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { flowStructureForNode, flowStructureMatches, readFlowStructure } from '../src/services/argumentDoc/flowStructure';
import { cognitionRoleLabel } from '../src/services/cognition/roles';
import { buildInquirySnapshot } from '../src/services/cognition/inquiry';
import { previewCognitionGraphEdit } from '../src/services/cognition/editing';
import { savedRestatementObservations } from '../src/services/cognition/restatements';
import { loadCognition, mutateCognition } from '../src/electron/cognitionStore';
import { registerCognitionTools } from '../src/services/agent/tools/cognitionTools';
import { getTool } from '../src/services/agent/toolRegistry';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { CognitionGraphEdit } from '../src/services/cognition/types';
import { CognitionFlowStructureDetails } from '../src/components/CognitionFlowStructureDetails';

let passed = 0;
const pass = (s: string) => { passed++; console.log(`PASS ${s}`); };
const { record, bundle, note, file } = currentCognitionFixture();
let stored = file;
const graph = latestCognition(file.records[0]).branches[0].graph;
const stamp = () => ({ id: crypto.randomUUID(), at: record.input.observedAt });
const target = () => ({ recordId: stored.records[0].id, revisionId: latestCognition(stored.records[0]).id, branchId: 'primary', nodeId: 'N6' });
assert.deepEqual(bundle.argumentDoc.flowStructure, { version: 1, ...record.graph });
assert.deepEqual(graph.flowStructure, bundle.argumentDoc.flowStructure);
assert.deepEqual(graph.flowStructure!.arguments.find(a => a.claim === 'N6')!.support, ['N2', 'N4', 'N5']);
assert.ok(flowStructureMatches(graph.flowStructure!, graph));
assert.deepEqual(graph.nodes.map(n => n.role), record.graph.nodes.map(n => n.role));
assert.doesNotMatch(JSON.stringify(graph), /conceptScore|recommendation|criteria|cognitiveObservations|AI SUMMARY/);
pass('actual production adapter → saved review binding → cognition preserves four roles, joint groups/status, raw fragments and unresolved extraction, not scores or diagnoses');

const currentOnly = cognitionGraph({ ...graph, nodes: graph.nodes.map(({ mainType, ...n }) => n) });
assert.ok(currentOnly.nodes.every(n => !Object.hasOwn(n, 'mainType')));
assert.ok(flowStructureMatches(currentOnly.flowStructure!, currentOnly));
const legacy = cognitionGraph({ title: 'legacy', nodes: [{ id: 'old', text: '旧表述', mainType: '推理' }], edges: [] });
assert.equal(legacy.nodes[0].role, undefined); assert.equal(cognitionRoleLabel(legacy.nodes[0]), '未标注角色');
assert.throws(() => cognitionGraph({ ...currentOnly, nodes: [{ id: 'bad', text: 'bad', role: '推理' }] }));
pass('role-only current data accepted without old mainType; nine-type history is readable, never guessed into four roles');

const rawRows = savedRestatementObservations([{ ...note, argumentDocs: [] }]);
const raw = applyCognitionMutation(emptyCognitionFile(), { kind: 'record_restatements', observations: rawRows }, stamp());
assert.ok(latestCognition(raw.records[0]).branches[0].graph.nodes.every(n => n.mainType === undefined && n.role === undefined));
const snapshot = buildInquirySnapshot(file, '我相信哪些事实');
assert.equal(snapshot.counts.endorsedNodes, graph.nodes.length); assert.equal(snapshot.counts.endorsedFacts, 0);
assert.equal(snapshot.counts.selectedNodes, graph.nodes.length);
pass('unstructured expressions stay unclassified; current-role beliefs are not omitted or called facts through the legacy adapter labels');

const edit: CognitionGraphEdit = { action: 'update_node', target: target(), text: graph.nodes.find(n => n.id === 'N6')!.text,
  role: 'premise', stance: 'endorsed', operation: 'revise', reason: '用户明确调整论证角色' };
assert.ok(previewCognitionGraphEdit(file, edit).lines.some(line => /主张 → 前提/u.test(line)));
stored = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit }, stamp());
const revised = latestCognition(stored.records[0]).branches[0].graph;
assert.equal(revised.nodes.find(n => n.id === 'N6')!.role, 'premise');
assert.equal(file.records[0].revisions.length, 1);
assert.deepEqual(revised.flowStructure, graph.flowStructure);
assert.equal(flowStructureForNode(revised, 'N6')!.state, 'source_only');
const supplemental = applyCognitionMutation(file, { kind: 'update_cognition', confirmed: true, expectedRevision: file.revision,
  target: { ...edit.target, operation: 'supplement', reason: '补充新观点而非继承旧分类' }, text: '新的补充表述', stance: 'endorsed', authorship: 'own_expression' }, stamp());
assert.equal(latestCognition(supplemental.records[0]).branches[0].graph.nodes.at(-1)!.role, undefined);
assert.deepEqual(parseCognitionFile(JSON.parse(JSON.stringify(stored))), stored);
pass('role changes are previewed, saved and revisioned; old snapshots survive as source-only; supplements do not inherit guessed roles');

for (const action of ['delete_node', 'delete_relation'] as const) {
  const edit = action === 'delete_node' ? { action, target: { ...target(), revisionId: latestCognition(file.records[0]).id }, reason: '合成删除' }
    : { action, edge: { recordId: file.records[0].id, revisionId: latestCognition(file.records[0]).id, branchId: 'primary', edgeId: graph.edges[0].id }, reason: '合成删边' };
  const next = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit }, stamp());
  assert.equal(flowStructureForNode(latestCognition(next.records[0]).branches[0].graph, 'N6')!.state, 'source_only');
}
const moved = { ...bundle.argumentDoc, nodes: bundle.argumentDoc.nodes.map(n => ({ ...n, position: { x: 999, y: 321 } })) };
assert.ok(flowStructureMatches(moved.flowStructure!, moved));
const malformed = structuredClone(graph.flowStructure!); malformed.arguments[1].support = ['not-present'];
assert.throws(() => readFlowStructure(malformed));
const ambiguous = structuredClone(graph.flowStructure!); ambiguous.nodes.find(n => n.id === 'N6')!.role = 'background';
assert.equal(readFlowStructure(ambiguous)!.nodes.find(n => n.id === 'N6')!.role, 'background', 'existing production protocol warns on semantic role mismatch, not hard-rejects');
pass('node/edge edits invalidate source-current binding, layout changes do not; dangling references reject, production semantic-ambiguity tolerance retained');

registerCognitionTools();
const props = (getTool('prepare_cognition_change')!.parameters as any).properties.edit.properties;
assert.equal(props.mainType, undefined); assert.deepEqual(props.role.enum, ['background', 'premise', 'claim', 'method']);
(globalThis as any).window = { electronAPI: { userState: { loadCognition: async () => stored } } };
const result = await getTool('query_cognition')!.execute({ target: target() }, {} as AgentRuntimeContext) as any;
assert.equal(result.nodes[0].role, 'premise'); assert.equal(result.nodes[0].analysisStructure.state, 'source_only');
assert.deepEqual(result.nodes[0].analysisStructure.arguments.find((a: any) => a.claim === 'N6').support, ['N2', 'N4', 'N5']);
assert.match(renderToStaticMarkup(React.createElement(CognitionFlowStructureDetails, { graph: revised, nodeId: 'N6' })), /仅供溯源|共同支持依据/u);
pass('actual Agent tool advertises only current roles and exact reads disclose source-only joint groups; UI distinguishes original extraction from current beliefs');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-current-structure-'));
try {
  const saved = await mutateCognition(directory, { kind: 'confirm', expectedRevision: 0, confirmed: true, operation: 'initial',
    reason: '', stance: 'endorsed', authorship: 'own_expression', doc: { doc_id: 'current-only', ...currentOnly } });
  assert.deepEqual(await loadCognition(directory), saved);
  assert.ok(latestCognition(saved.records[0]).branches[0].graph.nodes.every(n => n.role && !n.mainType));
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('loginote-current-structure-'));
  await fs.rm(directory, { recursive: true, force: true });
}
pass('native atomic private storage round-trips role-only nodes and lossless original extraction using an isolated temporary store');
console.log(`Current cognition structure: ${passed} groups passed; synthetic data only, no real vault, network or model inference. Semantic extraction accuracy not certified.`);
