import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import { primaryMasteryReferences } from '../src/services/masteryShadow/primaryReferences';
import { packMasteryReferences, MASTERY_REFERENCE_LIMITS } from '../src/services/masteryShadow/referenceBudget';
import { MASTERY_SHADOW_CRITERIA } from '../src/services/masteryShadow/rubric';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks';
import { createFlowReferenceProvider } from '../src/services/flowAnalysis/referenceProvider';
import { createFlowMasteryFixture } from './fixtures/flow-mastery';

globalThis.fetch = async () => assert.fail('No network, embedding rebuild or real vault');
const note: NoteItem = { id: 'bounded-reference', title: '观察效应', noteType: 'knowledge',
  content: '## 含义\r\n\r\n观察效应指意识到被观察后，行为可能发生改变。\r\n\r\n## 历史\r\n\r\n这是背景介绍。\r\n\r\n## 条件与边界\r\n\r\n判断干预效果时，需比较观察条件；不能把被关注后的变化全部归因于干预。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' };
const original = JSON.stringify(note), head = buildNoteReferenceChunks(note).find(chunk => chunk.content.includes('观察效应指'))!;
const headHit: any = { noteId: note.id, title: note.title, noteType: 'knowledge', score: .8, snippet: head.content,
  evidenceOrigin: 'note-passage', matchKinds: ['note'], passage: { schemaVersion: 2, chunkId: head.chunkId,
    sourceHash: noteReferenceSourceHash(note), sourceUpdatedAt: note.updatedAt, textStart: head.textStart, textEnd: head.textEnd,
    sectionPath: head.sectionPath, forcedSplit: head.forcedSplit, sectionKind: head.sectionKind } };
const passages = await primaryMasteryReferences(note, 'judgment_conditions', '观察效应 条件 边界', { searchNotes: async () => [headHit] });
assert.equal(passages.length, 2, 'a definition head cannot hide a distant condition passage');
assert.ok(passages.some(row => row.quote.includes('需比较观察条件')));
assert.ok(passages.every(row => note.content.includes(row.quote)));
assert.ok(passages.reduce((sum, row) => sum + row.quote.length, 0) <= 1800);
const topicOnly = await primaryMasteryReferences(note, 'judgment_attribution', '完全不存在的专业词xyz', { searchNotes: async () => [] });
assert.equal(topicOnly[0].retrievalPurpose, 'topic_context', 'zero-match fallback is labelled context, not a certified criterion rule');
assert.equal(JSON.stringify(note), original);

const groups = MASTERY_SHADOW_CRITERIA.map((criterion, index) => ({ criterionId: criterion.id,
  references: [0, 1].map(slot => ({ id: `R-${index}-${slot}`, tier: 3 as const, sourceId: `N${index}`, sourceRole: 'primary' as const,
    sourceLabel: '合成知识点', quote: `${index}/${slot}。${'这是完整的原文条件。'.repeat(50)}`, criterionIds: [criterion.id], layers: [criterion.layer] })) }));
const packed = packMasteryReferences(groups);
assert.equal(packed.omittedCriterionIds.length, 0, 'one head per criterion is protected before any extra');
assert.ok(packed.references.length <= 12 && packed.characters <= 6000 && JSON.stringify(packed.references).length <= 10000);
assert.ok(packed.references.every(row => groups.some(group => group.references.some(original => original.quote === row.quote))), 'no budget truncation of a sentence');
const scarce = packMasteryReferences(groups, { ...MASTERY_REFERENCE_LIMITS, characters: 1700 });
assert.deepEqual([...new Set(scarce.references.flatMap(row => row.layers || []))].sort(), ['concept', 'judgment', 'reasoning']);
assert.ok(scarce.omittedCriterionIds.length > 0, 'budget omissions are explicit, not fake coverage');
const shared = packMasteryReferences(groups.map(group => ({ ...group, references: [{ ...group.references[0], sourceId: 'same', quote: '同一段实际原文。' }] })));
assert.equal(shared.references.length, 1); assert.equal(shared.references[0].criterionIds!.length, 9);

// Textbook candidates do not prevent a bounded local-document supplement for mastery.
const fixture = createFlowMasteryFixture();
const project = structuredClone(fixture.notes[0]); project.resources = [{ documentId: 'isolated-doc', title: '补充资料' } as any];
let documentCalls = 0;
const overrides: any = { searchTextbooks: async () => [], searchNotes: async () => [], searchDocuments: async (_query: string, _limit: number, options: any) => {
  documentCalls++; assert.deepEqual(options.allowedDocIds, ['isolated-doc']); assert.equal(options.mode, 'passage'); assert.equal(options.expandGraph, false);
  return [{ docId: 'isolated-doc', chunkId: 'D1', fileName: '补充资料', sectionPath: '条件', score: .8, snippet: '确认偏误的判断需要检查相反信息。' }];
} };
const context = { noteId: project.id, noteTitle: project.title, allNotes: [project, ...fixture.notes.slice(1)], speakingContent: fixture.session.incrementalText! };
const targets = [{ id: 'T1', layer: 'judgment' as const, nodeIds: [], query: '确认偏误 条件' }];
const candidates = await createFlowReferenceProvider(context, overrides, { purpose: 'mastery' }).retrieve({} as any, { nodes: [], arguments: [], relations: [], unresolved: [] }, targets);
assert.equal(documentCalls, 1); assert.ok(candidates.some(row => row.tier === 1 && row.availability === 'available'));
assert.ok(candidates.some(row => row.tier === 2 && row.availability === 'available'));
await createFlowReferenceProvider(context, overrides).retrieve({} as any, { nodes: [], arguments: [], relations: [], unresolved: [] }, targets);
assert.equal(documentCalls, 1, 'ordinary overall-flow source priority remains unchanged');

console.log('PASS flow mastery only: scoped vector seed + distant body passage; bounded exact context; labelled topic fallback; fair 9-item budgets/dedup/omissions; textbook+local supplement without graph; overall-flow retrieval unchanged. No cloud or user writes.');
