import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCognitionMutation, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { previewCognitionGraphEdit } from '../src/services/cognition/editing';
import { buildCognitionManagement } from '../src/services/cognition/management';
import { buildInquirySnapshot, INQUIRY_PROMPT } from '../src/services/cognition/inquiry';
import { readCognitionRetrieval, retrieveCurrentCognition, withCognitionNeighborhood } from '../src/services/cognition/retrieval';
import { loadCognition, mutateCognition } from '../src/electron/cognitionStore';
import { COGNITION_RELATION_LABELS, type CognitionGraphEdit, type CognitionFile, type CognitionEditMeaning } from '../src/services/cognition/types';
import { RELATION_LABELS as ARGUMENT_RELATIONS } from '../src/services/argumentDoc/types';
import { getAgentSkill } from '../src/services/agent/skillRegistry';

let checks = 0, sequence = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const stamp = () => ({ id: `semantic-${++sequence}`, at: '2026-10-20T08:00:00Z' });
const doc = { doc_id: 'pressure', title: '压力与表现', nodes: [
  { id: 'claim', text: '压力有助于提高表现。', mainType: '假设' as const, role: 'claim' as const },
  { id: 'support', text: '这次练习中，我在压力下表现更好。', mainType: '事实陈述' as const },
  { id: 'context', text: '我上次睡眠不足时没有出现这种表现。', mainType: '事实陈述' as const },
], edges: [{ id: 'support-edge', source: 'support', target: 'claim', relation: 'support' as const }] };
let file = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '', doc }, stamp());
const original = structuredClone(file);
const node = () => latestCognition(file.records[0]).branches[0].graph.nodes.find(n => n.id === 'claim')!;
const ref = (nodeId = 'claim') => ({ recordId: 'pressure', branchId: 'primary', nodeId, revisionId: latestCognition(file.records[0]).id });
const apply = (edit: CognitionGraphEdit) => file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, authorship: 'adopted_with_assistance', edit }, stamp());
function update(operation: Extract<CognitionGraphEdit, { action: 'update_node' }>['operation'], text: string, conditions?: CognitionEditMeaning['conditions']): Extract<CognitionGraphEdit, { action: 'update_node' }> {
  return { action: 'update_node', target: ref(), text, mainType: '假设', stance: 'endorsed', reason: '用户明确要求整理这项认知', operation,
    meaning: { interpretation: '只调整这项认知的明确条件，保留其他内容和连线', preserved: ['压力有助于提高表现'], ...(conditions ? { conditions } : {}) } };
}
const add = update('add_conditions', '压力适中且睡眠充足时，压力有助于提高表现。', { before: [], changes: [{ kind: 'add', after: '压力适中' }, { kind: 'add', after: '睡眠充足' }] });
const preview = previewCognitionGraphEdit(file, add, 'adopted_with_assistance');
assert.match(preview.lines.join('\n'), /意图的理解[\s\S]*新增条件：压力适中[\s\S]*新增条件：睡眠充足[\s\S]*修改后条件/);
assert.match(preview.lines.join('\n'), /需你核对是否完整/);
assert.deepEqual(file, original, 'preview has no side effects');
apply(add);
assert.deepEqual(node().conditions, ['压力适中', '睡眠充足']);
assert.equal(file.records[0].revisions[0].branches[0].graph.nodes[0].conditions, undefined, 'legacy data not rewritten');
assert.deepEqual(latestCognition(file.records[0]).meaning, add.meaning);
pass('add conditions is explicit, preview discloses legacy extraction uncertainty, history and source words survive');

const baseline = structuredClone(file);
assert.throws(() => apply(update('add_conditions', '压力可控且睡眠充足时，压力有助于提高表现。', { before: ['压力适中', '睡眠充足'], changes: [{ kind: 'replace', before: '压力适中', after: '压力可控' }] })), /不一致/);
assert.throws(() => apply(update('add_conditions', '压力适中时，压力有助于提高表现。', { before: ['压力适中', '睡眠充足'], changes: [{ kind: 'add', after: '目标清晰' }] })), /遗漏/);
assert.throws(() => apply(update('replace_conditions', '压力可控且睡眠充足时，压力有助于提高表现。', { before: ['压力适中'], changes: [{ kind: 'replace', before: '压力适中', after: '压力可控' }] })), /原条件与当前节点不符/);
assert.throws(() => apply(update('remove_conditions', '睡眠充足时，压力有助于提高表现。', { before: ['压力适中', '睡眠充足'], changes: [{ kind: 'remove', before: '不存在的条件' }] })), /不存在/);
assert.throws(() => apply(update('revise', '压力有助于提高表现。')), /不能静默/);
assert.throws(() => apply(update('certainty', '压力有助于提高表现。')), /不能静默/);
const hidden = { ...add, target: ref(), operation: 'qualify' as const, meaning: undefined };
assert.throws(() => apply(hidden), /缺少语义解释/);
assert.deepEqual(file, baseline, 'all failed mutations are atomic');
pass('addition cannot hide replacement/deletion; missing/forged baselines and silent condition changes fail atomically');

apply(update('replace_conditions', '压力适中或偏高且睡眠充足时，压力有助于提高表现。', { before: node().conditions!, changes: [{ kind: 'replace', before: '压力适中', after: '压力适中或偏高' }] }));
assert.deepEqual(node().conditions, ['压力适中或偏高', '睡眠充足']);
file = structuredClone(baseline);
assert.throws(() => apply(update('replace_conditions', '压力适中时或压力可控且睡眠充足时，压力有助于提高表现。', { before: node().conditions!, changes: [{ kind: 'replace', before: '压力适中', after: '压力可控' }] })), /仍单独出现/);
pass('replacement can reuse words in the new complete condition, but cannot quietly leave the old condition active separately');

const replace = update('replace_conditions', '压力可控且睡眠充足时，压力有助于提高表现。', { before: node().conditions!, changes: [{ kind: 'replace', before: '压力适中', after: '压力可控' }] });
assert.match(previewCognitionGraphEdit(file, replace).lines.join('\n'), /替换条件：压力适中 → 压力可控[\s\S]*保留原条件：睡眠充足/);
apply(replace); assert.deepEqual(node().conditions, ['压力可控', '睡眠充足']);
apply(update('remove_conditions', '压力可控时，压力有助于提高表现。', { before: node().conditions!, changes: [{ kind: 'remove', before: '睡眠充足' }] }));
assert.deepEqual(node().conditions, ['压力可控']);
assert.ok(latestCognition(file.records[0]).branches[0].graph.edges.some(e => e.id === 'support-edge'));
pass('replace/removal preserve unaffected conditions, original support edges and full immutable revisions');

apply(update('qualify', '压力适中且目标清晰时，压力有助于提高表现。', { before: node().conditions!, changes: [{ kind: 'replace', before: '压力可控', after: '压力适中' }, { kind: 'add', after: '目标清晰' }] }));
assert.deepEqual(node().conditions, ['压力适中', '目标清晰']);
apply({ ...update('certainty', node().text), stance: 'tentative' });
assert.deepEqual(node().conditions, ['压力适中', '目标清晰']); assert.equal(node().stance, 'tentative');
const corrupted = structuredClone(file); latestCognition(corrupted.records[0]).branches[0].graph.nodes[0].conditions = ['伪造条件'];
assert.throws(() => parseCognitionFile(corrupted), /不在节点正文/);
pass('mixed condition edits remain itemized, certainty keeps conditions, and corrupt structured conditions are rejected');

// Argument-editor nodes have no private condition metadata. Resaving the same
// coordinates must not bypass the single-node condition contract or erase tags.
const conditionSnapshot = structuredClone(file), conditionSnapshotJson = JSON.stringify(file);
const primaryGraph = latestCognition(file.records[0]).branches[0].graph;
const canvas = { doc_id: 'pressure', ...primaryGraph, nodes: primaryGraph.nodes.map(({ conditions, ...node }) => node) };
for (const operation of ['revise', 'qualify', 'certainty'] as const) {
  const saveCanvas = (doc: unknown) => applyCognitionMutation(conditionSnapshot, { kind: 'confirm', expectedRevision: conditionSnapshot.revision,
    confirmed: true, operation, reason: '仅重新核对画布，不移除已有条件', authorship: 'own_expression', stance: 'tentative', doc }, stamp());
  const next = saveCanvas(canvas);
  assert.deepEqual(latestCognition(next.records[0]).branches[0].graph.nodes.find(node => node.id === 'claim')!.conditions, ['压力适中', '目标清晰']);
  assert.deepEqual(next.records[0].revisions.slice(0, -1), conditionSnapshot.records[0].revisions);
  assert.throws(() => saveCanvas({ ...canvas, nodes: canvas.nodes.map(node => node.id === 'claim' ? { ...node, text: '压力有助于提高表现。' } : node) }), /不能静默/);
  assert.throws(() => saveCanvas({ ...canvas, nodes: canvas.nodes.map(node => node.id === 'claim' ? { ...node, conditions: [] } : node) }), /单节点条件编辑/);
  // Whole-graph replacement may still intentionally remove a node; do not turn
  // private annotations into a ban on the existing, previewed graph operation.
  const withoutClaim = saveCanvas({ ...canvas, nodes: canvas.nodes.filter(node => node.id !== 'claim'), edges: [] });
  assert.ok(!latestCognition(withoutClaim.records[0]).branches[0].graph.nodes.some(node => node.id === 'claim'));
}
assert.equal(JSON.stringify(file), conditionSnapshotJson, 'preview and rejected whole-graph writes never modify their base');
pass('whole-graph resaves retain private conditions, reject hidden condition changes and preserve intentional previewed node removal');

const reasonGraph = { title: '关系补充', nodes: [{ id: 'a', text: '前提', mainType: '假设' }, { id: 'b', text: '主张', mainType: '假设' }],
  edges: [{ id: 'e', source: 'a', target: 'b', relation: 'support', reason: '只在同样条件下支持' }] };
const reasonFile = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', reason: '',
  authorship: 'own_expression', stance: 'endorsed', doc: { doc_id: 'relation-reason', ...reasonGraph } }, stamp());
const supplement = (reason?: string) => applyCognitionMutation(reasonFile, { kind: 'confirm', confirmed: true, expectedRevision: reasonFile.revision,
  operation: 'supplement', reason: '仅新增补充观点', authorship: 'own_expression', stance: 'endorsed', doc: { doc_id: 'relation-reason', ...reasonGraph,
    nodes: [...reasonGraph.nodes, { id: 'c', text: '新观察', mainType: '假设' }],
    edges: [{ id: 'e', source: 'a', target: 'b', relation: 'support', ...(reason === undefined ? {} : { reason }) }] } }, stamp());
for (const reason of [undefined, '只在同样条件下支持']) {
  const next = supplement(reason);
  assert.equal(latestCognition(next.records[0]).branches[0].graph.edges[0].reason, '只在同样条件下支持');
  assert.equal(latestCognition(next.records[0]).branches[0].graph.nodes.length, 3);
}
assert.throws(() => supplement('改成没有条件也支持'), /补充不能改写已有连线/);
pass('supplement keeps omitted existing relationship reasons and cannot hide a reason rewrite inside addition');

for (const relation of ['limits', 'exception', 'oppose'] as const) {
  const edit: CognitionGraphEdit = { action: 'add_relation', source: ref('context'), target: ref(), relation, reason: `用户明确记录${relation}`,
    meaning: { interpretation: `只建立${COGNITION_RELATION_LABELS[relation]}关系，不覆盖主张或既有支持`, preserved: [] } };
  assert.match(previewCognitionGraphEdit(file, edit).lines.join('\n'), /关系起点[\s\S]*关系终点[\s\S]*关系含义[\s\S]*其他支持/);
  apply(edit);
}
const managed = buildCognitionManagement(file);
assert.deepEqual(new Set(managed.groups[0].edges.map(e => e.relation)), new Set(['support', 'limits', 'exception', 'oppose']));
assert.equal(node().text, '压力适中且目标清晰时，压力有助于提高表现。');
assert.ok(!Object.hasOwn(ARGUMENT_RELATIONS, 'limits') && !Object.hasOwn(ARGUMENT_RELATIONS, 'exception'));
const inquiry = buildInquirySnapshot(file, '我的认知库');
assert.ok(inquiry.pages.flatMap(p => p.edges).some(e => e.relation === 'exception'));
const recalled = readCognitionRetrieval(withCognitionNeighborhood(file, retrieveCurrentCognition(file, '睡眠不足')))!;
assert.ok(recalled.items.flatMap(hit => hit.neighbors || []).some(edge => edge.relation === 'limits' || edge.relation === 'exception'));
assert.match(INQUIRY_PROMPT, /limits.*限定.*exception.*例外/);
pass('support/opposition/limitation/exception coexist distinctly in graph, inquiry and retrieval without changing scoring relations');

const oldText = original.records[0].revisions[0].branches[0].graph.nodes[0].text;
const badLegacy = update('remove_conditions', oldText, { before: ['不在原文'], changes: [{ kind: 'remove', before: '不在原文' }] });
file = structuredClone(original); badLegacy.target = ref();
assert.throws(() => apply(badLegacy), /逐字来自原文/);
const contradictory = update('add_conditions', '压力适中时，压力有助于提高表现。', { before: [], changes: [{ kind: 'add', after: '压力适中' }] });
contradictory.meaning!.preserved = ['伪造保留片段'];
assert.throws(() => apply(contradictory), /保留的原文片段/);
for (const action of ['add_node', 'delete_node', 'add_relation', 'update_relation', 'delete_relation']) {
  assert.throws(() => apply({ action, reason: '模型不能跳过解释' } as CognitionGraphEdit), /缺少语义解释/);
}
const prompt = getAgentSkill('cognition-management')!.systemPrompt;
for (const word of ['add_conditions', 'remove_conditions', 'replace_conditions', 'limits', 'exception', '先澄清']) assert.ok(prompt.includes(word));
pass('unread/imaginary legacy conditions, fake retained text and incomplete Agent proposals are blocked; semantic distinctions are in the model contract');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-semantics-'));
try {
  let stored = await mutateCognition(directory, { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '', doc });
  file = stored;
  const edit = { ...add, target: ref() };
  stored = await mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: stored.revision, authorship: 'adopted_with_assistance', edit });
  file = stored;
  stored = await mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: stored.revision, authorship: 'adopted_with_assistance', edit: {
    action: 'add_relation', source: ref('context'), target: ref(), relation: 'exception', reason: '明确保存例外', meaning: { interpretation: '记录睡眠不足的特定例外，保留原支持', preserved: [] },
  } });
  stored = await mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: stored.revision, authorship: 'adopted_with_assistance', edit: {
    action: 'add_node', title: '睡眠条件', text: '睡眠不足时表现会受到影响。', mainType: '假设', stance: 'tentative', reason: '独立记录', meaning: { interpretation: '新增独立认知，不覆盖原记录', preserved: [] },
  } });
  file = stored;
  const other = stored.records[1], otherRevision = latestCognition(other), otherBranch = otherRevision.branches[0];
  stored = await mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: stored.revision, authorship: 'adopted_with_assistance', edit: {
    action: 'add_relation', source: { recordId: other.id, revisionId: otherRevision.id, branchId: otherBranch.id, nodeId: otherBranch.graph.nodes[0].id }, target: ref(), relation: 'limits', reason: '用户明确跨活动范围限制', meaning: { interpretation: '建立跨活动限制关系，不否定原支持', preserved: [] },
  } });
  const storedBaseline = structuredClone(stored), storedGraph = latestCognition(stored.records[0]).branches[0].graph;
  stored = await mutateCognition(directory, { kind: 'confirm', confirmed: true, expectedRevision: stored.revision, operation: 'certainty',
    authorship: 'own_expression', stance: 'tentative', reason: '画布重新保存，不移除私人条件标注',
    doc: { doc_id: 'pressure', ...storedGraph, nodes: storedGraph.nodes.map(({ conditions, ...node }) => node) } });
  assert.deepEqual(stored.records[0].revisions.slice(0, -1), storedBaseline.records[0].revisions);
  assert.deepEqual(stored.links, storedBaseline.links);
  assert.deepEqual(stored.linkHistory, storedBaseline.linkHistory);
  const loaded = await loadCognition(directory);
  assert.deepEqual(loaded, stored);
  assert.deepEqual(latestCognition(loaded.records[0]).branches[0].graph.nodes[0].conditions, ['压力适中', '睡眠充足']);
  assert.ok(latestCognition(loaded.records[0]).branches[0].graph.edges.some(e => e.relation === 'exception'));
  assert.equal(loaded.links?.[0].relation, 'limits');
  assert.match(loaded.linkHistory?.at(-1)?.meaning?.interpretation || '', /不否定原支持/);
  assert.ok(buildInquirySnapshot(loaded, '我的认知库').pages.flatMap(page => page.edges).some(edge => edge.relation === 'limits'));
  parseCognitionFile(loaded);
  pass('actual atomic private-file IO round-trips conditions, semantic interpretation and exception relations without real user data');
} finally {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'loginote-cognition-semantics-'));
  await fs.rm(directory, { recursive: true, force: true });
}
console.log(`Cognition semantics: ${checks} groups passed. Contract/consistency tests only, not a live-model semantic accuracy evaluation.`);
