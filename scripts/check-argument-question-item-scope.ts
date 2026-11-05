import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { NoteItem } from '../src/types.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionAuthorityHost } from '../src/electron/rag/argumentProjectionAuthority.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { createPersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import { freezeReviewAssessment, type ReviewAssessmentTaskType, type ReviewCriterionId } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';

// Independent source/host replay using deliberately fixed synthetic review votes.
// No question criterion, necessary set or historical model response is repaired.
// This measures bounded mapping and safety, not model semantic accuracy.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Question item scope checks forbid network');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-question-item-scope-'));
const rootScopeId = 'synthetic-question-item-scope-root';
let checks = 0, fixtures = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const clone = <T>(value: T): T => structuredClone(value);
const note = (id: string, content: string): NoteItem => ({ id, title: `合成题目范围-${id}`, content, noteType: 'knowledge',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] });
function q(input: ArgumentProjectionBuildInput, text: string) {
  const quote = input.quotes.find(row => row.completeSentence && row.evidence.quote === text); assert.ok(quote, text); return quote.quoteId;
}
async function rig(saved: NoteItem, make: (input: ArgumentProjectionBuildInput) => ArgumentProjectionDraft) {
  const scope: ArgumentContextScope = { scopeId: `synthetic-scope-${saved.id}`, rootScopeId, corpus: 'reference',
    allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [saved.id], allowedDocIds: [], allowedRecordIds: [] };
  const base = await adaptSavedKnowledgeNote({ note: saved, rootScopeId, scope });
  const input = await prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    scope, chunks: base.chunks, sourceQualification: { status: 'eligible', policyVersion: 'synthetic-item-scope-fixed-vote', evidence: [base.quotes[0].evidence] } });
  const draft = make(input), review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
  const result = await finalizeArgumentProjectionBuild(input, draft, review);
  assert.equal(result.status, 'reviewed_complete');
  const ref = { kind: 'knowledge-note' as const, entityId: saved.id };
  const host: ArgumentProjectionAuthorityHost = { rootScopeId, async withSource(value, action) {
    assert.deepEqual(value, ref); return action(clone(input)); } };
  const store = createPersistentArgumentProjectionStore(path.join(temporary, `fixture-${++fixtures}`), host);
  const publication = await store.publish({ publicationId: `synthetic-item-scope-${fixtures}`, result,
    proof: { input, draft, review }, expectedActiveHash: null });
  assert.equal(publication.status, 'published');
  const service = createArgumentQuestionFrameService({ runtime: { host, store }, readReferenceNotes: async () => [clone(saved)] });
  return { input, draft, result, service };
}
async function select(saved: NoteItem, task: ReviewAssessmentTaskType, rows: [ReviewCriterionId, string][]) {
  const assessment = freezeReviewAssessment(task, [saved.title]);
  const catalog = await buildReviewReferenceCatalog([saved], [saved.title], [saved.id]);
  const choices = new Map<string, string[]>();
  for (const [criterion, text] of rows) {
    const candidate = catalog.candidates.find(row => row.quote === text); assert.ok(candidate, text);
    choices.set(criterion, [...(choices.get(criterion) ?? []), candidate.candidateId]);
  }
  const marker = [...choices].map(([criterion, ids]) => `${criterion}=${ids.join(',')}`).join(';');
  const referenceRubric = freezeReviewReferenceRubric(marker, assessment, catalog); assert.equal(referenceRubric.status, 'fixed');
  return { questionMessageId: 'synthetic-item-scope-question', knowledgeTargets: [saved.title], assessment, referenceRubric };
}
const definitions = [
  '本实验定义蓝印就绪为能够接收派送任务的状态。',
  '蓝印就绪只适用于系统联网且身份校验通过的情形。',
  '人工模式下不适用蓝印就绪规则。',
  '例如，合成系统甲已联网并通过身份校验，可以接收派送任务。',
  '合成系统甲当前已联网并通过身份校验。',
  '这是无关账户标签，不属于本题范围。',
];
const definition = note('definition', definitions.join('\n\n'));
const definitionRows: [ReviewCriterionId, string][] = [['concept_meaning', definitions[0]], ['concept_boundary', definitions[1]], ['concept_boundary', definitions[2]]];
function definitionDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const quotes = definitions.map(text => q(input, text));
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'definition', quoteIds: [quotes[0]] }, { id: 'N2', role: 'condition', quoteIds: [quotes[1]] },
      { id: 'N3', role: 'exception', quoteIds: [quotes[2]] }, { id: 'N4', role: 'example', quoteIds: [quotes[3]] },
      { id: 'N5', role: 'fact', quoteIds: [quotes[4]] }, { id: 'N6', role: 'fact', quoteIds: [quotes[5]] }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: quotes.slice(0, 2) },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N1', kind: 'exception_of', quoteIds: [quotes[0], quotes[2]] },
      { id: 'E3', sourceNodeId: 'N4', targetNodeId: 'N1', kind: 'illustrates', quoteIds: [quotes[3]] }], groups: [],
    scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2', 'N3'],
      requiredRelationIds: ['E1', 'E2'], requiredGroupIds: [], quoteIds: quotes.slice(0, 3) },
      { id: 'S2', seedNodeId: 'N4', task: 'example', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quotes[3]] },
      { id: 'S3', seedNodeId: 'N5', task: 'fact', requiredNodeIds: ['N5'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quotes[4]] },
      { id: 'S4', seedNodeId: 'N6', task: 'fact', requiredNodeIds: ['N6'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quotes[5]] }] };
}
const reasoningParagraphs = ['本次合成包裹带有蓝印。',
  '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。',
  '只有系统已联网时，本次分拣推断才成立。', '这是无关账户标签，不属于本题范围。'];
const reasoning = note('reasoning', reasoningParagraphs.join('\n\n'));
const reasoningRows: [ReviewCriterionId, string][] = [['actual_premise', reasoningParagraphs[0]],
  ['actual_premise', reasoningParagraphs[2]], ['inference_link', reasoningParagraphs[1]]];
function reasoningDraft(input: ArgumentProjectionBuildInput): ArgumentProjectionDraft {
  const quotes = reasoningParagraphs.map(text => q(input, text));
  return { version: 1, buildId: input.buildId,
    nodes: [{ id: 'N1', role: 'fact', quoteIds: [quotes[0]] }, { id: 'N2', role: 'conclusion', quoteIds: [quotes[1]] },
      { id: 'N3', role: 'condition', quoteIds: [quotes[2]] }, { id: 'N4', role: 'fact', quoteIds: [quotes[3]] }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support', quoteIds: quotes.slice(0, 2) },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition', quoteIds: [quotes[1], quotes[2]] }],
    groups: [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'],
      operator: 'all', quoteIds: quotes.slice(0, 3) }],
    scopes: [{ id: 'S1', seedNodeId: 'N2', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3'],
      requiredRelationIds: ['E1', 'E2'], requiredGroupIds: ['G1'], quoteIds: quotes.slice(0, 3) },
      { id: 'S2', seedNodeId: 'N4', task: 'fact', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quotes[3]] }] };
}
try {
  const core = await rig(definition, definitionDraft), coreSelectors = await select(definition, 'definition', definitionRows);
  const fixed = await core.service.prepare(coreSelectors); assert.equal(fixed.status, 'fixed', JSON.stringify(fixed.reasons));
  assert.deepEqual(fixed.frames[0].pack.nodes.map(row => row.id), ['N1', 'N2', 'N3']);
  assert.deepEqual(fixed.frames[0].pack.completeness.requiredRelationIds, ['E1', 'E2']);
  assert.ok(core.result.projection.nodes.some(row => row.id === 'N4' && row.role === 'example'));
  assert.ok(core.result.projection.nodes.some(row => row.id === 'N5' && row.role === 'fact'));
  assert.ok(core.result.projection.relations.some(row => row.id === 'E3' && row.kind === 'illustrates'));
  assert.equal((await core.service.verify(fixed)).status, 'current');
  pass('合法最小definition任务子图保留条件/例外，例子与实例事实仍在整图但不是本题required，不删图');

  const conditionItem = fixed.frames[0].items.find(row => row.quote === definitions[1])!;
  const exceptionItem = fixed.frames[0].items.find(row => row.quote === definitions[2])!;
  assert.deepEqual(conditionItem.relationIds, ['E1']); assert.deepEqual(exceptionItem.relationIds, ['E2']);
  const originalE1 = core.result.projection.relations.find(row => row.id === 'E1')!;
  assert.deepEqual(fixed.frames[0].pack.relations.find(row => row.id === 'E1')!.evidence, originalE1.evidence);
  assert.equal(originalE1.evidence.length, 2);
  pass('必要条件/例外边可同时引用已固定定义段与边界段，全证据原样保留且对应边界原文仍定位');

  for (const omitted of [definitions[1], definitions[2]]) {
    const partial = await core.service.prepare(await select(definition, 'definition', definitionRows.filter(row => row[1] !== omitted)));
    assert.equal(partial.status, 'held'); assert.ok(partial.reasons.includes('prerequisite_incomplete'));
  }
  pass('最小子图不等于降低标准：未选任何required条件/例外仍held，不自动补原文');

  const escaped = await rig(definition, input => { const draft = definitionDraft(input);
    draft.relations[0].quoteIds.push(q(input, definitions[5])); return draft; });
  const escapedFrame = await escaped.service.prepare(coreSelectors);
  assert.equal(escapedFrame.status, 'held'); assert.ok(escapedFrame.reasons.includes('prerequisite_incomplete'));
  pass('必要边任一证据段越出已冻结items仍held，不裁掉越界span凑通过');

  const broad = await rig(definition, input => { const draft = definitionDraft(input);
    draft.scopes[0].requiredNodeIds.push('N4', 'N5'); draft.scopes[0].requiredRelationIds.push('E3');
    draft.scopes[0].quoteIds.push(q(input, definitions[3]), q(input, definitions[4])); return draft; });
  const broadFrame = await broad.service.prepare(coreSelectors);
  assert.equal(broadFrame.status, 'held'); assert.ok(broadFrame.reasons.includes('prerequisite_incomplete'));
  assert.deepEqual(broad.result.projection.build.scopes[0].requiredNodeIds, ['N1', 'N2', 'N3', 'N4', 'N5']);
  pass('旧过宽required范围不在读侧按role迁移/删例子，保持held，必须上游纠正并重建');

  const exampleSelectors = await select(definition, 'example', [['example_fit', definitions[3]]]);
  const example = await core.service.prepare(exampleSelectors);
  assert.equal(example.status, 'fixed'); assert.deepEqual(example.frames[0].pack.nodes.map(row => row.id), ['N4']);
  assert.equal(example.frames[0].items[0].quote, definitions[3]);
  assert.equal((await core.service.verify(example)).status, 'current');
  const mandatoryCaseFact = await rig(definition, input => { const draft = definitionDraft(input);
    draft.scopes[1].requiredNodeIds.push('N5'); draft.scopes[1].quoteIds.push(q(input, definitions[4])); return draft; });
  assert.equal((await mandatoryCaseFact.service.prepare(exampleSelectors)).status, 'held');
  pass('完整例句可作最小举例任务；独立实例fact若被声明required却未有原题检验项，仍held不暗添标准');

  const caseRig = await rig(reasoning, reasoningDraft), caseSelectors = await select(reasoning, 'reasoning', reasoningRows);
  const caseFrame = await caseRig.service.prepare(caseSelectors);
  assert.equal(caseFrame.status, 'fixed', JSON.stringify(caseFrame.reasons));
  assert.deepEqual(caseFrame.frames[0].items.find(row => row.criterionId === 'inference_link')!.relationIds, ['E1', 'E2']);
  assert.deepEqual(caseFrame.frames[0].pack.prerequisiteGroups[0].premiseNodeIds, ['N1']);
  assert.deepEqual(caseFrame.frames[0].pack.prerequisiteGroups[0].conditionNodeIds, ['N3']);
  assert.deepEqual(caseFrame.frames[0].pack.relations.find(row => row.id === 'E1')!.evidence,
    caseRig.result.projection.relations.find(row => row.id === 'E1')!.evidence);
  assert.equal((await caseRig.service.verify(caseFrame)).status, 'current');
  pass('案例应用推理边跨实际事实/推理项合法映射，原G1实际前提与条件闭包全保留、不裁证据');

  const incompleteCase = await caseRig.service.prepare(await select(reasoning, 'reasoning', reasoningRows.filter(row => row[1] !== reasoningParagraphs[0])));
  assert.equal(incompleteCase.status, 'held');
  assert.ok(incompleteCase.reasons.includes('inference_relation_missing') || incompleteCase.reasons.includes('prerequisite_incomplete'));
  pass('案例推理遗漏具体实际事实仍held，一般规则/条件不能替代实际前提');

  const noInferenceOriginal = await rig(reasoning, input => { const draft = reasoningDraft(input);
    draft.relations[0].quoteIds = [q(input, reasoningParagraphs[0])]; return draft; });
  const noInferenceFrame = await noInferenceOriginal.service.prepare(caseSelectors);
  assert.equal(noInferenceFrame.status, 'held'); assert.ok(noInferenceFrame.reasons.includes('inference_relation_missing'));
  const outsideInference = await rig(reasoning, input => { const draft = reasoningDraft(input);
    draft.relations[0].quoteIds.push(q(input, reasoningParagraphs[3])); return draft; });
  const outsideFrame = await outsideInference.service.prepare(caseSelectors);
  assert.equal(outsideFrame.status, 'held'); assert.ok(outsideFrame.reasons.includes('inference_relation_missing'));
  pass('关系未完整覆盖本推理检验项或任一span越本题范围仍held，condition边不替代support证据');

  const changed = clone(caseFrame); changed.frames[0].items.find(row => row.criterionId === 'inference_link')!.relationIds = ['E2'];
  changed.snapshotBindingHash = await argumentContextHash(changed.frames.map(({ pack, ...frame }) => ({ ...frame, packHash: pack.packHash })));
  const { contractHash: _ignored, ...body } = changed; changed.contractHash = await argumentContextHash(body);
  assert.equal((await caseRig.service.verify(changed)).status, 'held');
  assert.equal((await caseRig.service.verify(caseFrame)).status, 'current');
  assert.equal(caseFrame.limitations.scoreWrite, 'disabled'); assert.equal(caseFrame.limitations.cognitionWrite, 'disabled');
  pass('冻结原范围/关系映射独立重放，重算hash不能删必要边，原合同可用且无评分/认知写入');
  console.log(`Argument question item scope: ${checks} new independent synthetic offline groups passed; `
    + '0 network, no private configuration or real vault, no frozen-criterion or stored-required-set migration.');
} finally {
  globalThis.fetch = previousFetch;
  const absolute = path.resolve(temporary); assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('loginote-question-item-scope-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
