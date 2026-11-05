import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { NoteItem } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft, ArgumentProjectionReview,
  ArgumentProjectionReviewInput } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionAuthorityHost } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput,
  finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { createArgumentContextPointer } from '../src/services/argumentContext/reader.ts';
import { readTaskScopedArgumentContextPack } from '../src/services/argumentContext/taskScopedReader.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { createPersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';

// These deliberate, fixed synthetic review votes exercise actual construction,
// persistent host replay and pre-answer gates. They measure no model improvement.
// KNOWN-RISK assertions intentionally keep mechanically accepted semantic gaps
// visible. No old model response is repaired, and no semantic edge is inferred.
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Condition scope checks forbid network');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-condition-scope-'));
const rootScopeId = 'synthetic-condition-scope-root';
let checks = 0, fixtureNumber = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const paragraphs = [
  '本次合成包裹带有蓝印。',
  '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。',
  '只有系统已联网时，本次分拣推断才成立。',
];
const saved: NoteItem = { id: 'synthetic-condition-source', title: '合成分拣条件归属', content: paragraphs.join('\n\n'),
  noteType: 'knowledge', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z',
  tags: [], links: [], backlinks: [], dueDates: [] };
const scope: ArgumentContextScope = { scopeId: 'synthetic-condition-source-scope', rootScopeId, corpus: 'reference',
  allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [saved.id], allowedDocIds: [], allowedRecordIds: [] };
const ref = { kind: 'knowledge-note' as const, entityId: saved.id };

/** Intentionally explicit fabricated votes, not an independent semantic decision. */
function fixedVotes(input: ArgumentProjectionReviewInput): ArgumentProjectionReview {
  const vote = (id: string, quoteIds: string[]) => ({ id, decision: 'accept' as const, quoteIds: [...quoteIds],
    reason: '纯合成固定票：仅测试程序合同，不是语义准确率证据。' });
  return { version: 1, reviewId: input.reviewId,
    nodes: input.draft.nodes.map(row => ({ ...vote(row.id, row.quoteIds), roleSupported: true })),
    relations: input.draft.relations.map(row => ({ ...vote(row.id, row.quoteIds), sourceNodeId: row.sourceNodeId,
      targetNodeId: row.targetNodeId, kind: row.kind, relationSupported: true, directionSupported: true, crossChunkSupported: true })),
    groups: input.draft.groups.map(row => ({ ...vote(row.id, row.quoteIds), operator: row.operator,
      membersSupported: true, operatorSupported: true, necessarySetComplete: true })),
    scopes: input.draft.scopes.map(row => ({ ...vote(row.id, row.quoteIds), requiredSetComplete: true, attributionSupported: true })) };
}
function quote(input: ArgumentProjectionBuildInput, text: string): string {
  const candidate = input.quotes.find(row => row.evidence.quote === text);
  assert.ok(candidate, `Synthetic source must expose exact quotation: ${text}`); return candidate.quoteId;
}
function correctDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const fact = quote(input, paragraphs[0]), link = quote(input, paragraphs[1]), condition = quote(input, paragraphs[2]);
  const rule = quote(input, '本实验约定带有蓝印的包裹会进入二号通道，');
  const conclusion = quote(input, '所以本次合成包裹会进入二号通道。');
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [fact] }, { id: 'N2', role: 'premise', quoteIds: [rule] },
      { id: 'N3', role: 'conclusion', quoteIds: [conclusion] }, { id: 'N4', role: 'condition', quoteIds: [condition] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E2', sourceNodeId: 'N2', targetNodeId: 'N3', kind: 'support', quoteIds: [link] },
      { id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N3', kind: 'requires_condition', quoteIds: [condition] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N3', premiseNodeIds: ['N1', 'N2'], conditionNodeIds: ['N4'],
      relationIds: ['E1', 'E2', 'E3'], operator: 'all', quoteIds: [fact, link, condition] }],
    scopes: [{ id: 'S1', seedNodeId: 'N3', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3', 'N4'],
      requiredRelationIds: ['E1', 'E2', 'E3'], requiredGroupIds: ['G1'], quoteIds: [fact, link, condition] }] };
}
function omittedConditionDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const draft = correctDraft(input);
  draft.nodes = draft.nodes.filter(row => row.id !== 'N4');
  draft.relations = draft.relations.filter(row => row.id !== 'E3');
  draft.groups[0].conditionNodeIds = [];
  draft.groups[0].relationIds = ['E1', 'E2'];
  draft.groups[0].quoteIds = draft.groups[0].quoteIds.filter(id => id !== quote(input, paragraphs[2]));
  draft.scopes[0].requiredNodeIds = ['N1', 'N2', 'N3'];
  draft.scopes[0].requiredRelationIds = ['E1', 'E2'];
  draft.scopes[0].quoteIds = [...draft.groups[0].quoteIds];
  return draft;
}
function orphanConditionDraft(input: ArgumentProjectionBuildInput, fullConditionNode = false): ArgumentProjectionDraft {
  const draft = omittedConditionDraft(input), condition = quote(input, paragraphs[2]);
  const conditionPrefix = quote(input, '只有系统已联网时，'), isolatedClaim = quote(input, '本次分拣推断才成立。');
  draft.nodes.push({ id: 'N4', role: 'condition', quoteIds: [fullConditionNode ? condition : conditionPrefix] },
    { id: 'N5', role: 'claim', quoteIds: [isolatedClaim] });
  draft.relations.push({ id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N5', kind: 'requires_condition', quoteIds: [condition] });
  draft.groups.push({ id: 'G2', conclusionNodeId: 'N5', premiseNodeIds: [], conditionNodeIds: ['N4'],
    relationIds: ['E3'], operator: 'all', quoteIds: [condition] });
  draft.scopes.push({ id: 'S2', seedNodeId: 'N5', task: 'condition', requiredNodeIds: ['N4', 'N5'],
    requiredRelationIds: ['E3'], requiredGroupIds: ['G2'], quoteIds: [condition] });
  return draft;
}
async function selectors(includeCondition = true) {
  const assessment = freezeReviewAssessment('reasoning', [saved.title]);
  const catalog = await buildReviewReferenceCatalog([saved], [saved.title], [saved.id]);
  const candidate = (text: string) => { const row = catalog.candidates.find(item => item.quote === text); assert.ok(row, text); return row.candidateId; };
  const actual = [candidate(paragraphs[0]), ...(includeCondition ? [candidate(paragraphs[2])] : [])];
  const rubric = freezeReviewReferenceRubric(`actual_premise=${actual.join(',')};inference_link=${candidate(paragraphs[1])}`, assessment, catalog);
  assert.equal(rubric.status, 'fixed');
  return { questionMessageId: 'synthetic-condition-question', knowledgeTargets: [saved.title], assessment, referenceRubric: rubric };
}
async function fixture(make: (input: ArgumentProjectionBuildInput) => ArgumentProjectionDraft,
  editReview?: (review: ArgumentProjectionReview) => void) {
  const base = await adaptSavedKnowledgeNote({ note: saved, rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    scope, chunks: base.chunks, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-condition-policy', evidence: [base.quotes[0].evidence] } });
  const draft = make(input), reviewInput = await buildArgumentProjectionReviewInput(input, draft), review = fixedVotes(reviewInput);
  editReview?.(review);
  const result = await finalizeArgumentProjectionBuild(input, draft, review);
  const host: ArgumentProjectionAuthorityHost = { rootScopeId, async withSource(request, action) {
    assert.deepEqual(request, ref); return action(structuredClone(input)); } };
  const store = createPersistentArgumentProjectionStore(path.join(temporary, `fixture-${++fixtureNumber}`), host);
  const publication = await store.publish({ publicationId: `synthetic-condition-${fixtureNumber}`, result,
    proof: { input, draft, review }, expectedActiveHash: null });
  const service = createArgumentQuestionFrameService({ runtime: { host, store }, readReferenceNotes: async () => [structuredClone(saved)] });
  const pointer = await createArgumentContextPointer(result.projection, result.authority, scope, ['N3']);
  const pack = await readTaskScopedArgumentContextPack(result.projection, result.authority, { pointer, scope, task: 'reasoning' });
  return { input, draft, review, result, publication, service, pack };
}
try {
  const full = await selectors(), good = await fixture(correctDraft), goodFrame = await good.service.prepare(full);
  assert.equal(good.publication.status, 'published'); assert.equal(good.pack.completeness.status, 'complete_for_scope');
  assert.equal(goodFrame.status, 'fixed', JSON.stringify(goodFrame.reasons));
  const frame = goodFrame.frames[0];
  assert.deepEqual(frame.pack.prerequisiteGroups[0].conditionNodeIds, ['N4']);
  assert.equal(frame.pack.prerequisiteGroups[0].conclusionNodeId, 'N3');
  assert.deepEqual(frame.items.find(row => row.criterionId === 'inference_link')!.relationIds, ['E1', 'E2', 'E3']);
  assert.equal(frame.pack.relations.find(row => row.id === 'E3')!.targetNodeId, 'N3');
  assert.equal((await good.service.verify(goodFrame)).status, 'current');
  pass('正例：明确条件→主结论，all组与reasoning scope包含条件，完整题前rubric真实host重放为fixed');

  const missingOriginal = await good.service.prepare(await selectors(false));
  assert.equal(missingOriginal.status, 'held'); assert.ok(missingOriginal.reasons.includes('prerequisite_incomplete'));
  assert.deepEqual(good.pack.completeness.requiredNodeIds, ['N1', 'N2', 'N3', 'N4']);
  pass('已声明必要条件但题前未选条件原文：held，不隐式扩充rubric、不删必要闭包');

  const incomplete = await fixture(input => { const draft = correctDraft(input);
    draft.relations = draft.relations.filter(row => row.id !== 'E3'); draft.groups[0].relationIds = ['E1', 'E2'];
    draft.scopes[0].requiredRelationIds = ['E1', 'E2']; return draft; });
  assert.equal(incomplete.result.status, 'reviewed_partial'); assert.equal(incomplete.publication.status, 'held');
  assert.equal(incomplete.pack.completeness.status, 'partial');
  assert.ok(incomplete.pack.completeness.gaps.some(gap => gap.code === 'missing_prerequisite' && gap.targetId === 'G1'));
  assert.ok(!incomplete.pack.relations.some(row => row.kind === 'requires_condition'));
  assert.equal((await incomplete.service.prepare(full)).status, 'held');
  pass('组已声明条件但缺条件边：即使全accept票，真实必要闭包partial/发布held，程序不自动补边');

  const rejected = await fixture(correctDraft, review => { review.scopes[0].decision = 'reject';
    review.scopes[0].requiredSetComplete = false; review.scopes[0].attributionSupported = false; });
  assert.equal(rejected.result.status, 'reviewed_partial'); assert.equal(rejected.publication.status, 'held');
  assert.notEqual(rejected.pack.completeness.status, 'complete_for_scope');
  assert.equal((await rejected.service.prepare(full)).status, 'held');
  pass('审核明确拒绝必要集合/归属：不产生已审完整scope，题前held');

  const orphan = await fixture(input => orphanConditionDraft(input));
  assert.equal(orphan.publication.status, 'published'); assert.equal(orphan.pack.completeness.status, 'complete_for_scope');
  const orphanFrame = await orphan.service.prepare(full);
  assert.equal(orphanFrame.status, 'held'); assert.ok(orphanFrame.reasons.includes('item_structure_incomplete'));
  assert.deepEqual(orphan.draft.groups[0].conditionNodeIds, []);
  assert.equal(orphan.draft.relations.find(row => row.id === 'E3')!.targetNodeId, 'N5');
  pass('负例：条件另连“推断成立”claim，主reasoning scope遗漏条件；固定完整rubric缺对应项而held');

  const omitted = await fixture(omittedConditionDraft), omittedFrame = await omitted.service.prepare(full);
  assert.equal(omitted.publication.status, 'published'); assert.equal(omitted.pack.completeness.status, 'complete_for_scope');
  assert.equal(omittedFrame.status, 'held'); assert.ok(omittedFrame.reasons.includes('item_structure_incomplete'));
  pass('负例：模型图/组/scope全漏条件，完整题前rubric仍可挡下；source reviewed_complete不等于语义完整');

  const weakened = await omitted.service.prepare(await selectors(false));
  assert.equal(weakened.status, 'fixed'); assert.equal((await omitted.service.verify(weakened)).status, 'current');
  assert.equal(weakened.limitations.semanticTruth, 'not_certified');
  pass('KNOWN-RISK：图与题前选择同时漏条件可机械fixed；通用actual_premise标准不证明本题必要条件完整');

  const wronglyIncluded = await fixture(input => { const draft = orphanConditionDraft(input, true);
    draft.scopes[0].requiredNodeIds.push('N4', 'N5'); draft.scopes[0].requiredRelationIds.push('E3');
    draft.scopes[0].requiredGroupIds.push('G2'); draft.scopes[0].quoteIds.push(quote(input, paragraphs[2])); return draft; });
  const wrongFrame = await wronglyIncluded.service.prepare(full);
  assert.equal(wronglyIncluded.publication.status, 'published'); assert.equal(wrongFrame.status, 'fixed');
  assert.deepEqual(wrongFrame.frames[0].pack.prerequisiteGroups.find(row => row.id === 'G1')!.conditionNodeIds, []);
  assert.equal(wrongFrame.frames[0].pack.relations.find(row => row.id === 'E3')!.targetNodeId, 'N5');
  assert.equal((await wronglyIncluded.service.verify(wrongFrame)).status, 'current');
  pass('KNOWN-RISK：全accept错归属票＋全句条件角色＋把孤立组塞入scope可机械fixed；host不证明条件指向主结论');

  assert.equal(goodFrame.limitations.scoreWrite, 'disabled'); assert.equal(goodFrame.limitations.cognitionWrite, 'disabled');
  assert.equal(good.pack.limitations.writes, 'disabled');
  console.log(`Argument condition scope: ${checks} synthetic offline groups passed, including 2 explicit KNOWN-RISK cases; `
    + '0 model requests, no production index, cognition or score writes, no model accuracy claim.');
} finally {
  globalThis.fetch = fetchBefore;
  const absolute = path.resolve(temporary);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('loginote-condition-scope-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
