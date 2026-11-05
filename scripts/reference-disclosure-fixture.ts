import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types.ts';
import { adaptSavedKnowledgeNote } from '../src/electron/rag/argumentSourceAdapter.ts';
import { createArgumentQuestionFrameService } from '../src/electron/rag/argumentQuestionFrames.ts';
import type { ArgumentProjectionAuthorityHost, ArgumentProjectionSourceRef } from '../src/electron/rag/argumentProjectionAuthority.ts';
import type { PersistentArgumentProjectionStore } from '../src/electron/rag/argumentProjectionStore.ts';
import { prepareArgumentProjectionBuild, buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import type { ArgumentContextScope } from '../src/services/argumentContext/types.ts';
import { argumentContextHash } from '../src/services/argumentContext/hash.ts';
import { createArgumentProjectionPublicationStore } from '../src/services/argumentContext/publication.ts';
import { freezeReviewAssessment } from '../src/services/reviewAssessment.ts';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';

// Pure import: no top-level I/O, provider configuration or model requests.
// Synthetic fixed reviewer votes exercise production contracts, not semantic truth.
export const DISCLOSURE_FIXTURE_DEFINITION = [
  '选择过载是指选项🧠超过当前可比较的范围而使决策困难。',
  '只有当处理能力不足以有效比较这些选项时，上述选择过载概念才适用。',
  '例如，合成学习者面对多种课程无法有效比较而难以决策，这个场景用于举例说明选择过载。',
  '这份合成教材还保存无关账户标签🧩，该段不应随定义结构披露。',
] as const;
export const DISCLOSURE_FIXTURE_REASONING = [
  '本次合成设备的读数超过阈值。',
  '本实验约定读数超过阈值会报警，所以本次合成设备会报警。',
  '只有设备已供电时，本次报警推断才成立。',
  '这是无关账户标签🧩，不应随报警推理结构披露。',
] as const;
export const PROGRESSIVE_FIXTURE_DEFINITION = [
  '本实验把“青灯就绪”定义为设备可以开始执行训练指令的状态。',
  '只有设备已供电且自检通过时，上述“青灯就绪”状态才成立。',
  '例如，合成设备甲接通电源并通过自检，就处于“青灯就绪”状态。',
  '这份合成教材还保存无关账户标签🧩，该段不应随定义结构披露。',
] as const;
export const PROGRESSIVE_FIXTURE_CONDITION = [
  '本实验中，阈值报警规则只适用于已供电且处于正常模式的设备。',
  '本实验中，维护模式是例外：设备即使已供电且读数超过阈值，也不按阈值报警规则报警。',
  '例如，合成设备乙已供电且处于正常模式，就可以使用阈值报警规则。',
  '这是无关账户标签🧩，不应随规则条件结构披露。',
] as const;

/** Fresh fictional source facts for the v3 acceptance pilot. These are not real
 * user notes or model-built reference truth; the fixed reviewer below stays synthetic. */
export const ACCEPTANCE_FIXTURE_DEFINITION = [
  '本实验把“蓝印就绪”定义为系统能够接收派送任务的状态。',
  '只有系统联网且身份校验通过时，上述“蓝印就绪”状态才成立。',
  '例如，合成系统甲已联网并通过身份校验，可以接收派送任务。',
  '这是无关账户标签🧩，不应随定义结构披露。',
] as const;
export const ACCEPTANCE_FIXTURE_CONDITION = [
  '本实验中，蓝印分拣规则只适用于已联网且处于自动模式的系统。',
  '本实验中，人工模式是例外：系统即使已联网且包裹带蓝印，也不按蓝印分拣规则送入二号通道。',
  '例如，合成系统乙已联网且处于自动模式，就可以使用蓝印分拣规则。',
  '这是无关账户标签🧩，不应随规则条件结构披露。',
] as const;
export const ACCEPTANCE_FIXTURE_REASONING = [
  '本次合成包裹带有蓝印。',
  '本实验约定带有蓝印的包裹会进入二号通道，所以本次合成包裹会进入二号通道。',
  '只有系统已联网时，本次分拣推断才成立。',
  '这是无关账户标签🧩，不应随分拣推理结构披露。',
] as const;

export interface ReferenceDisclosureFixtureOptions {
  task?: 'definition' | 'condition' | 'reasoning';
  /** Experimental names have no factual authority outside this synthetic fixture. */
  theme?: 'progressive-device-v1' | 'progressive-parcel-v1';
  noteCount?: number;
  /** Two pre-answer target aliases of one source, used to test exact quote deduplication. */
  aliasTargets?: boolean;
  /** Same authored proposition at TWO original occurrences, never borrowed by wording. */
  repeatedOccurrences?: boolean;
}

export async function createReferenceDisclosureFixture(options: ReferenceDisclosureFixtureOptions = {}) {
  const task = options.task ?? 'definition', rootScopeId = 'offline-disclosure-fixture-root';
  const count = options.noteCount ?? 1;
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 20);
  assert.ok(options.theme === undefined || ['progressive-device-v1', 'progressive-parcel-v1'].includes(options.theme));
  assert.ok(!options.aliasTargets || count === 1);
  assert.ok(!options.repeatedOccurrences || task === 'definition');
  const parcel = options.theme === 'progressive-parcel-v1';
  const paragraphs: string[] = [...(parcel
    ? task === 'definition' ? ACCEPTANCE_FIXTURE_DEFINITION
      : task === 'condition' ? ACCEPTANCE_FIXTURE_CONDITION : ACCEPTANCE_FIXTURE_REASONING
    : task === 'definition'
    ? options.theme ? PROGRESSIVE_FIXTURE_DEFINITION : DISCLOSURE_FIXTURE_DEFINITION
    : task === 'condition' ? PROGRESSIVE_FIXTURE_CONDITION : DISCLOSURE_FIXTURE_REASONING)];
  if (options.repeatedOccurrences) paragraphs[1] = paragraphs[0];
  const notes: NoteItem[] = Array.from({ length: count }, (_, index) => ({
    id: `offline-reference-${index + 1}`, title: `${parcel
      ? task === 'definition' ? '合成蓝印就绪' : task === 'condition' ? '合成蓝印分拣条件' : '合成包裹分拣推理'
      : task === 'definition'
      ? options.theme ? '实验青灯就绪' : '合成选择过载'
      : task === 'condition' ? '合成阈值报警条件' : '合成设备推理'}-${index + 1}`,
    noteType: 'knowledge', content: paragraphs.join('\r\n\r\n'),
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [],
    ...(options.aliasTargets ? { aliases: ['合成别名目标'] } : {}),
  }));
  const inputs = new Map<string, ArgumentProjectionBuildInput>(), results = new Map<string, ArgumentProjectionBuildResult>();
  const publication = createArgumentProjectionPublicationStore();
  for (const saved of notes) {
    const scope: ArgumentContextScope = { scopeId: `offline-source-${saved.id}`, rootScopeId, corpus: 'reference',
      allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [saved.id], allowedDocIds: [], allowedRecordIds: [] };
    const base = await adaptSavedKnowledgeNote({ note: saved, rootScopeId, scope });
    const input = await prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText,
      hierarchy: base.hierarchy, scope, chunks: base.chunks,
      sourceQualification: { status: 'eligible', policyVersion: 'offline-fixed-review-only', evidence: [base.quotes[0].evidence] } });
    const quoteIds = paragraphs.map((text, index) => {
      const start = paragraphs.slice(0, index).reduce((total, paragraph) => total + paragraph.length + 4, 0);
      const quote = input.quotes.find(q => q.completeSentence && q.evidence.start === start && q.evidence.quote === text);
      assert.ok(quote); return quote.quoteId;
    });
    const draft: ArgumentProjectionDraft = task === 'definition' ? {
      version: 1, buildId: input.buildId,
      nodes: [{ id: 'N1', role: 'definition', quoteIds: [quoteIds[0]] },
        { id: 'N2', role: options.repeatedOccurrences ? 'definition' : 'condition', quoteIds: [quoteIds[1]] },
        { id: 'N3', role: 'example', quoteIds: [quoteIds[2]] }, { id: 'N4', role: 'fact', quoteIds: [quoteIds[3]] }],
      relations: [...(!options.repeatedOccurrences ? [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition' as const, quoteIds: [quoteIds[1]] }] : []),
        { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N1', kind: 'illustrates', quoteIds: [quoteIds[2]] }], groups: [],
      scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: ['N1', 'N2'],
        requiredRelationIds: options.repeatedOccurrences ? [] : ['E1'], requiredGroupIds: [], quoteIds: quoteIds.slice(0, 2) },
      { id: 'S2', seedNodeId: 'N1', task: 'example', requiredNodeIds: ['N1', 'N3'], requiredRelationIds: ['E2'], requiredGroupIds: [], quoteIds: [quoteIds[0], quoteIds[2]] },
      { id: 'S3', seedNodeId: 'N4', task: 'fact', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quoteIds[3]] }],
    } : task === 'condition' ? {
      version: 1, buildId: input.buildId,
      nodes: [{ id: 'N1', role: 'condition', quoteIds: [quoteIds[0]] }, { id: 'N2', role: 'exception', quoteIds: [quoteIds[1]] },
        { id: 'N3', role: 'example', quoteIds: [quoteIds[2]] }, { id: 'N4', role: 'fact', quoteIds: [quoteIds[3]] }],
      relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'exception_of', quoteIds: [quoteIds[1]] }], groups: [],
      scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'condition', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'], requiredGroupIds: [], quoteIds: quoteIds.slice(0, 2) },
        { id: 'S2', seedNodeId: 'N4', task: 'fact', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quoteIds[3]] }],
    } : {
      version: 1, buildId: input.buildId,
      nodes: [{ id: 'N1', role: 'fact', quoteIds: [quoteIds[0]] }, { id: 'N2', role: 'conclusion', quoteIds: [quoteIds[1]] },
        { id: 'N3', role: 'condition', quoteIds: [quoteIds[2]] }, { id: 'N4', role: 'fact', quoteIds: [quoteIds[3]] }],
      relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support', quoteIds: [quoteIds[1]] },
        { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition', quoteIds: [quoteIds[2]] }],
      groups: [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'], operator: 'all', quoteIds: [quoteIds[1], quoteIds[2]] }],
      scopes: [{ id: 'S1', seedNodeId: 'N2', task: 'reasoning', requiredNodeIds: ['N1', 'N2', 'N3'], requiredRelationIds: ['E1', 'E2'], requiredGroupIds: ['G1'], quoteIds: quoteIds.slice(0, 3) },
        { id: 'S2', seedNodeId: 'N4', task: 'fact', requiredNodeIds: ['N4'], requiredRelationIds: [], requiredGroupIds: [], quoteIds: [quoteIds[3]] }],
    };
    const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
    const result = await finalizeArgumentProjectionBuild(input, draft, review);
    await publication.registerSource(input);
    assert.equal((await publication.publish({ publicationId: `offline-publication-${saved.id}`, result,
      proof: { input, draft, review }, scope, currentSource: input.source, expectedActiveHash: null })).status, 'published');
    inputs.set(saved.id, input); results.set(saved.id, result);
  }
  const checkedInput = (ref: ArgumentProjectionSourceRef) => {
    if (ref.kind !== 'knowledge-note' || !inputs.has(ref.entityId)) throw new Error('offline_scope_denied');
    return structuredClone(inputs.get(ref.entityId)!);
  };
  const host: ArgumentProjectionAuthorityHost = { rootScopeId,
    async withSource(ref, action) { return action(checkedInput(ref)); } };
  // In-memory read adapter only. The underlying prototype has independently registered
  // source inputs and replays real proofs. No filesystem or production host authority.
  const store: PersistentArgumentProjectionStore = {
    async publish() { throw new Error('offline_read_adapter_does_not_publish'); },
    async readSource(ref) { return checkedInput(ref); },
    async read(ref) { const input = checkedInput(ref); return publication.read({ source: input.source, scope: input.scope }); },
    async readStaged(ref, publicationId) { const input = checkedInput(ref); return publication.readStaged({ publicationId, source: input.source, scope: input.scope }); },
    async withActive(ref, action) { const input = checkedInput(ref), result = await publication.read({ source: input.source, scope: input.scope });
      return result ? action(structuredClone(result), structuredClone(input)) : null; },
  };
  const knowledgeTargets = options.aliasTargets ? [notes[0].title, notes[0].aliases![0]] : notes.map(saved => saved.title);
  const assessment = freezeReviewAssessment(task, knowledgeTargets);
  const catalog = await buildReviewReferenceCatalog(notes, knowledgeTargets, notes.map(saved => saved.id));
  const selections = new Map<string, string[]>();
  for (const target of knowledgeTargets) {
    for (const [paragraphIndex, criterion] of (task === 'definition'
      ? [[0, 'concept_meaning'], [1, 'concept_boundary']]
      : task === 'condition' ? [[0, 'condition_scope'], [1, 'condition_scope']]
        : [[0, 'actual_premise'], [1, 'inference_link'], [2, 'actual_premise']]) as [number, string][]) {
      const start = paragraphs.slice(0, paragraphIndex).reduce((total, paragraph) => total + paragraph.length + 4, 0);
      const paragraph = paragraphs[paragraphIndex];
      // Semantic retrieval may join a continuing paragraph with its predecessor.
      // Still require the exact occurrence and text to be covered by the source interval.
      const candidate = catalog.candidates.find(item => item.knowledgeTarget === target
        && item.start <= start && item.end >= start + paragraph.length
        && item.quote.slice(start - item.start, start - item.start + paragraph.length) === paragraph);
      assert.ok(candidate); selections.set(criterion, [...(selections.get(criterion) ?? []), candidate.candidateId]);
    }
  }
  const marker = [...selections].map(([criterion, ids]) => `${criterion}=${ids.join(',')}`).join(';');
  const referenceRubric = freezeReviewReferenceRubric(marker, assessment, catalog); assert.equal(referenceRubric.status, 'fixed');
  const selectors = { questionMessageId: 'offline-reference-question', knowledgeTargets, assessment, referenceRubric };
  const service = createArgumentQuestionFrameService({ runtime: { host, store }, readReferenceNotes: async () => structuredClone(notes) });
  const frozen = await service.prepare(selectors); assert.equal(frozen.status, 'fixed', JSON.stringify(frozen.reasons));
  assert.equal((await service.verify(frozen)).status, 'current');
  return { frozen, selectors, notes, inputs, results, service, store, host, paragraphs, catalog };
}

/** Synthetic mutation helpers recalculate protocol hashes, never grant host authority. */
export async function rehashReferenceDisclosureFixture(value: import('../src/services/argumentContext/questionBindingTypes.ts').FrozenArgumentQuestionFrames) {
  for (const frame of value.frames) {
    const { packHash: _hash, ...packBody } = frame.pack;
    frame.pack.packHash = await argumentContextHash(packBody);
  }
  value.rubricHash = await argumentContextHash(value.referenceRubric);
  value.snapshotBindingHash = await argumentContextHash(value.frames.map(({ pack, ...frame }) => ({ ...frame, packHash: pack.packHash })));
  const { contractHash: _hash, ...body } = value;
  value.contractHash = await argumentContextHash(body);
  return value;
}
