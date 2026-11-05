import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArgumentSearchBridge, ARGUMENT_SEARCH_BRIDGE_LIMITS } from '../src/electron/rag/argumentSearchBridge.ts';
import { createArgumentProjectionRuntime } from '../src/electron/rag/argumentProjectionRuntime.ts';
import type { ArgumentProjectionRuntime } from '../src/electron/rag/argumentProjectionRuntime.ts';
import { buildArgumentProjectionReviewInput, finalizeArgumentProjectionBuild } from '../src/services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionDraft } from '../src/services/argumentContext/buildTypes.ts';
import { readStoredArgumentContextPack } from '../src/electron/rag/argumentProjectionReader.ts';
import { buildNoteReferenceChunks, noteReferenceSourceHash } from '../src/electron/rag/noteReferenceChunks.ts';
import { buildTextStructuredDocument, buildSentenceSpans } from '../src/electron/rag/structuredDocument.ts';
import { TEXT_SEGMENTATION_VERSION } from '../src/electron/rag/sentenceBoundaries.ts';
import { serializeMetadata } from '../src/services/vaultFsService.ts';
import { withRagSourceTransaction } from '../src/electron/ragSourceTransactions.ts';
import { readSavedArgumentProjectionSource } from '../src/electron/rag/argumentSavedSourceReader.ts';
import { fixedAcceptProjectionReview } from './argument-projection-build-fixture.ts';
import type { DocumentChunk, DocumentSearchResult, NoteItem, NoteSearchResult, UploadedDocument } from '../src/types.ts';

// Deterministic protocol checks only: all sources, review votes and publications are synthetic.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network allowed in argument search bridge checks');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-argument-search-'));
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const rootScopeId = 'synthetic-search-root', environmentId = 'synthetic-search-environment';
const vaultRoot = path.join(temporary, 'vault'), userStateDir = path.join(temporary, 'user-state');
const note: NoteItem = { id: 'synthetic-note', noteType: 'knowledge', title: '合成选择过载',
  content: '# 定义\r\n\r\n选择过载是指选项超过认知处理阈值时难以决策。🧠\r\n\r\n## 条件\r\n\r\n当选项超过处理阈值时，选择过载才可能发生。\r\n\r\n## 例子\r\n\r\n例如同时对比很多商品可能难以决定。\r\n\r\n## 附录\r\n\r\n这个附录不属于已审核的定义范围。',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T01:00:00.000Z', tags: [], links: [], backlinks: [], dueDates: [] };
const docId = 'synthetic-doc', rawDocument = '# 定义\n\n选择过载是指选项超过认知处理阈值时难以决策。\n\n## 条件\n\n当选项超过处理阈值时，选择过载才可能发生。';
const document = { ...buildTextStructuredDocument(docId, rawDocument),
  sourceHash: createHash('sha256').update(rawDocument).digest('hex'), materialParserVersion: 1 };
const metadata: UploadedDocument = { id: docId, fileName: 'synthetic.md', fileType: 'md', extension: '.md', indexable: true,
  size: Buffer.byteLength(rawDocument), status: 'ready', chunkCount: 1, totalChars: document.normalizedText.length,
  parseStatus: 'ready', parsedAt: '2026-10-07T01:00:00.000Z', uploadAt: '2026-10-07T00:00:00.000Z' };
const definitionBlock = document.blocks.find(block => block.kind === 'paragraph')!;
const chunk: DocumentChunk = { id: `${docId}#saved-L1`, docId, fileName: metadata.fileName, index: 0, sectionPath: definitionBlock.sectionPath,
  content: document.normalizedText.slice(definitionBlock.textStart, definitionBlock.textEnd),
  textStart: definitionBlock.textStart, textEnd: definitionBlock.textEnd, sourceBlockIds: [definitionBlock.id],
  sourceLocators: [definitionBlock.locator], schemaVersion: TEXT_SEGMENTATION_VERSION,
  sentenceSpans: buildSentenceSpans(`${docId}#saved-L1`, document.normalizedText.slice(definitionBlock.textStart, definitionBlock.textEnd), definitionBlock.textStart), embedding: [] };
let current = true;
const runtime = createArgumentProjectionRuntime({ dataRoot: temporary, vaultRoot, userStateDir, rootScopeId, environmentId,
  scope: { scopeId: 'synthetic-library', rootScopeId, corpus: 'reference', allowedSourceKinds: ['knowledge-note', 'uploaded-document'],
    allowedNoteIds: [note.id], allowedDocIds: [docId], allowedRecordIds: [] }, isCurrent: () => current });

async function rawNote(id: string): Promise<NoteItem | null> {
  const saved = JSON.parse(await fs.readFile(path.join(vaultRoot, 'metadata.json'), 'utf8')).notesMeta[id];
  if (!saved) return null;
  return { ...saved, content: await fs.readFile(path.join(vaultRoot, 'notes', `${id}.md`), 'utf8') };
}
async function rawChunk(id: string, chunkId: string): Promise<DocumentChunk | null> {
  const rows = JSON.parse(await fs.readFile(path.join(temporary, 'rag-index', `chunks-${id}.json`), 'utf8')) as DocumentChunk[];
  return rows.find(row => row.id === chunkId) ?? null;
}
const bridge = createArgumentSearchBridge({ environmentId, store: runtime.store, readSavedKnowledgeNote: rawNote, readSavedDocumentChunk: rawChunk });
function noteHit(section: string): NoteSearchResult {
  const piece = buildNoteReferenceChunks(note).find(item => item.sectionPath.endsWith(section))!;
  assert.ok(piece, section);
  return { noteId: note.id, noteType: 'knowledge', title: note.title, score: 0.82, snippet: piece.content.slice(0, 450),
    matchKinds: ['note'], evidenceOrigin: 'note-passage', passage: { schemaVersion: 2, chunkId: piece.chunkId,
      sourceHash: noteReferenceSourceHash(note), sourceUpdatedAt: note.updatedAt, textStart: piece.textStart, textEnd: piece.textEnd,
      sectionPath: piece.sectionPath, sectionKind: piece.sectionKind, forcedSplit: piece.forcedSplit } };
}
const docHit: DocumentSearchResult = { docId, fileName: metadata.fileName, chunkId: chunk.id, sectionPath: chunk.sectionPath,
  score: 0.76, snippet: '这个snippet故意不是原文，桥不从snippet定位。', matchKinds: ['passage', 'argument'],
  arguments: [{ argumentId: 'legacy-N999', docId, chunkId: chunk.id } as any] };
async function publish(targetRuntime: ArgumentProjectionRuntime, kind: 'knowledge-note' | 'uploaded-document', entityId: string,
  publicationId: string, nodeCount = 2, sourceStateDir = userStateDir): Promise<ArgumentProjectionBuildInput> {
  const ref = { kind, entityId };
  let input!: ArgumentProjectionBuildInput;
  const response = await targetRuntime.execute({ op: 'source', environmentId: targetRuntime === runtime ? environmentId : 'synthetic-seed-environment', ref });
  assert.ok(response.status === 'physical_source');
  // The host-private admission write takes the source transaction directly. withSource is
  // read-only and detects qualification changes; mutating inside it would fail its post-check.
  await withRagSourceTransaction([temporary, vaultRoot, sourceStateDir], async () => {
    const base = await readSavedArgumentProjectionSource({ dataRoot: temporary, vaultRoot, userStateDir: sourceStateDir, scope: response.input.scope }, ref);
    assert.ok(base);
    input = await targetRuntime.admission.record(base!, { reviewId: `${publicationId}-source`, policyVersion: 'synthetic-source-v1',
      decision: 'eligible', evidence: [base!.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!.evidence],
      checks: { provenanceVerified: true, relevantContentPresent: true, noCriticalSourceGaps: true, reviewIndependent: true },
      reason: '固定合成来源审核，仅验证程序合同，不证明事实正确。', reviewedAt: '2026-10-07T02:00:00.000Z' });
  });
  const definition = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('是指'))!;
  const condition = input.quotes.find(q => q.completeSentence && q.evidence.quote.includes('才可能'))!;
  const draft: ArgumentProjectionDraft = { version: 1, buildId: input.buildId,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `N${index + 1}`, role: index === 1 && nodeCount === 2 ? 'condition' as const : 'definition' as const,
      quoteIds: [index === 1 && nodeCount === 2 ? condition.quoteId : definition.quoteId] })),
    relations: nodeCount === 2 ? [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', quoteIds: [condition.quoteId] }] : [],
    groups: [], scopes: [{ id: 'S1', seedNodeId: 'N1', task: 'definition', requiredNodeIds: Array.from({ length: nodeCount }, (_, i) => `N${i + 1}`),
      requiredRelationIds: nodeCount === 2 ? ['E1'] : [], requiredGroupIds: [], quoteIds: [definition.quoteId, condition.quoteId] }] };
  const review = fixedAcceptProjectionReview(await buildArgumentProjectionReviewInput(input, draft));
  const result = await finalizeArgumentProjectionBuild(input, draft, review);
  assert.equal((await targetRuntime.store.publish({ publicationId, result, proof: { input, draft, review }, expectedActiveHash: null })).status, 'published');
  return input;
}

try {
  await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true }); await fs.mkdir(userStateDir);
  await fs.mkdir(path.join(temporary, 'documents')); await fs.mkdir(path.join(temporary, 'rag-index'));
  await fs.writeFile(path.join(vaultRoot, 'metadata.json'), serializeMetadata([note]));
  await fs.writeFile(path.join(vaultRoot, 'notes', `${note.id}.md`), note.content);
  await fs.writeFile(path.join(temporary, 'rag-index', 'manifest.json'), JSON.stringify([metadata]));
  await fs.writeFile(path.join(temporary, 'rag-index', `structured-${docId}.json`), JSON.stringify(document));
  await fs.writeFile(path.join(temporary, 'documents', `${docId}.md`), rawDocument);
  await fs.writeFile(path.join(temporary, 'rag-index', `chunks-${docId}.json`), JSON.stringify([chunk]));
  const initial = await bridge.attachNoteHits([noteHit('定义')]);
  assert.equal(initial[0].argumentContext.status, 'unavailable');
  assert.equal(initial[0].argumentContext.status === 'unavailable' && initial[0].argumentContext.reasonCode, 'projection_unavailable');
  assert.equal(await fs.stat(path.join(userStateDir, 'argument-projections')).catch(() => null), null);
  pass('仅有物理来源不隐式发布/抽取或升级，保留原命中并明确无结构');

  await publish(runtime, 'knowledge-note', note.id, 'note-published'); await publish(runtime, 'uploaded-document', docId, 'doc-published');
  const hit = noteHit('定义'), results = await bridge.attachNoteHits([hit]);
  assert.equal(results[0].argumentContext.status, 'available');
  const attachment = results[0].argumentContext;
  assert.ok(attachment.status === 'available'); assert.equal(attachment.environmentId, environmentId);
  assert.deepEqual(attachment.pointer.seedNodeIds, ['N1']);
  const { argumentContext: _pointer, ...baseHit } = results[0]; assert.deepEqual(baseHit, hit);
  assert.equal((hit as any).argumentContext, undefined);
  const pack = await readStoredArgumentContextPack(runtime.store, { pointer: attachment.pointer, task: 'definition' });
  assert.equal(pack!.completeness.status, 'complete_for_scope'); assert.equal(pack!.relations[0].sourceNodeId, 'N2');
  assert.equal(pack!.limitations.writes, 'disabled');
  pass('真实保存版CRLF/emoji坐标→证据重合种子→完整已审范围，排序分数原字段与原对象不变');

  for (const changed of [{ ...hit, passage: undefined }, { ...hit, passage: { ...hit.passage!, sourceHash: '0'.repeat(64) } },
    { ...hit, passage: { ...hit.passage!, sourceUpdatedAt: '2026-10-07T03:00:00.000Z' } },
    { ...hit, passage: { ...hit.passage!, textStart: hit.passage!.textStart + 1 } },
    { ...hit, passage: { ...hit.passage!, chunkId: 'forged-chunk' } },
    { ...hit, passage: { ...hit.passage!, sectionKind: 'fact' as const } }]) {
    assert.equal((await bridge.attachNoteHits([changed]))[0].argumentContext.status, 'unavailable');
  }
  pass('旧无passage、假hash/时间/offset/chunkId/类型拒绝，不用文字相似猜结构坐标');

  assert.equal((await bridge.attachNoteHits([{ ...hit, noteType: 'project' }]))[0].argumentContext.status, 'unavailable');
  assert.equal((await bridge.attachNoteHits([{ ...hit, evidenceOrigin: 'user-argument-doc' }]))[0].argumentContext.status, 'unavailable');
  assert.equal((await bridge.attachNoteHits([{ ...hit, matchKinds: ['argument'] }]))[0].argumentContext.status, 'unavailable');
  const appendix = (await bridge.attachNoteHits([noteHit('附录')]))[0].argumentContext;
  assert.equal(appendix.status === 'unavailable' && appendix.reasonCode, 'no_evidence_overlap');
  pass('个人/project/仅个人argument命中不混成资料结构，真实范围无证据交集明确拒绝');

  const docResult = (await bridge.attachDocumentHits([docHit]))[0];
  assert.equal(docResult.argumentContext.status, 'available');
  assert.ok(docResult.argumentContext.status === 'available'); assert.deepEqual(docResult.argumentContext.pointer.seedNodeIds, ['N1']);
  assert.deepEqual(docResult.arguments, docHit.arguments); assert.equal(docResult.snippet, docHit.snippet);
  const duplicateSentenceSnippet = { ...docHit, snippet: '才可能' };
  assert.deepEqual((await bridge.attachDocumentHits([duplicateSentenceSnippet]))[0].argumentContext, docResult.argumentContext);
  pass('资料命中只按当前保存L1区间和真实node证据挂入口，完全忽略snippet与legacy图ID');

  for (const changed of [{ ...chunk, textStart: undefined }, { ...chunk, schemaVersion: 0 }, { ...chunk, content: `${chunk.content}伪造` },
    { ...chunk, sourceBlockIds: ['another-block'] }, { ...chunk, docId: 'another-doc' }]) {
    await withRagSourceTransaction([temporary], () => fs.writeFile(path.join(temporary, 'rag-index', `chunks-${docId}.json`), JSON.stringify([changed])));
    assert.equal((await bridge.attachDocumentHits([docHit]))[0].argumentContext.status, 'unavailable');
  }
  await withRagSourceTransaction([temporary], () => fs.writeFile(path.join(temporary, 'rag-index', `chunks-${docId}.json`), JSON.stringify([chunk])));
  assert.equal((await bridge.attachDocumentHits([{ ...docHit, chunkId: 'missing-chunk' }]))[0].argumentContext.status, 'unavailable');
  pass('无L1坐标/旧schema/错正文/错sourceBlocks/借doc/失踪chunk均不借缓存造pointer');

  const budget = await bridge.attachNoteHits(Array.from({ length: ARGUMENT_SEARCH_BRIDGE_LIMITS.hits + 1 }, () => hit));
  assert.equal(budget.length, ARGUMENT_SEARCH_BRIDGE_LIMITS.hits + 1);
  assert.ok(budget.slice(0, ARGUMENT_SEARCH_BRIDGE_LIMITS.hits).every(row => row.argumentContext.status === 'available'));
  const beyond = budget.at(-1)!.argumentContext; assert.equal(beyond.status === 'unavailable' && beyond.reasonCode, 'hit_budget');
  pass('超过8条仅跳过结构附加，不删除搜索命中或改变top-k，不截断后自称完整');

  const denied = await bridge.attachNoteHits([{ ...hit, noteId: 'not-authorized' }]);
  assert.equal(denied[0].argumentContext.status, 'unavailable');
  current = false; assert.equal((await bridge.attachNoteHits([hit]))[0].argumentContext.status, 'unavailable'); current = true;
  const absentReader = createArgumentSearchBridge({ environmentId, store: runtime.store });
  assert.equal((await absentReader.attachNoteHits([hit]))[0].argumentContext.status, 'unavailable');
  const faultyReader = createArgumentSearchBridge({ environmentId, store: runtime.store, readSavedKnowledgeNote: async () => { throw new Error('secret host path'); } });
  assert.ok(!JSON.stringify(await faultyReader.attachNoteHits([hit])).includes('secret host path'));
  pass('host范围/过期环境/missing或坏rawreader不泄漏路径，不允许自带pointer获得authority');

  const forged = { ...hit, argumentContext: { status: 'available' as const, environmentId: 'old', pointer: { fake: true } as any } };
  const replay = await bridge.attachNoteHits([forged]);
  assert.equal(replay[0].argumentContext.environmentId, environmentId);
  assert.ok(replay[0].argumentContext.status === 'available'); assert.equal((replay[0].argumentContext.pointer as any).fake, undefined);
  let entered!: () => void, release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const slow = createArgumentSearchBridge({ environmentId, store: runtime.store, readSavedKnowledgeNote: async id => { entered(); await released; return rawNote(id); } });
  const mutable = structuredClone(hit), pending = slow.attachNoteHits([mutable]); await paused;
  mutable.passage!.sourceHash = '0'.repeat(64); mutable.noteId = 'not-authorized'; release();
  assert.equal((await pending)[0].argumentContext.status, 'available');
  pass('首次await前冻结hit，晚改输入和注入旧pointer不改变本次回核来源');

  const extraState = path.join(temporary, 'seed-state'); await fs.mkdir(extraState);
  const seedRuntime = createArgumentProjectionRuntime({ dataRoot: temporary, vaultRoot, userStateDir: extraState,
    rootScopeId: 'synthetic-seed-root', environmentId: 'synthetic-seed-environment', isCurrent: () => true,
    scope: { scopeId: 'synthetic-seed-library', rootScopeId: 'synthetic-seed-root', corpus: 'reference',
      allowedSourceKinds: ['knowledge-note'], allowedNoteIds: [note.id], allowedDocIds: [], allowedRecordIds: [] } });
  await publish(seedRuntime, 'knowledge-note', note.id, 'many-seeds', ARGUMENT_SEARCH_BRIDGE_LIMITS.seedNodes + 1, extraState);
  const many = createArgumentSearchBridge({ environmentId: 'synthetic-seed-environment', store: seedRuntime.store, readSavedKnowledgeNote: rawNote });
  const seeds = (await many.attachNoteHits([hit]))[0].argumentContext;
  assert.equal(seeds.status === 'unavailable' && seeds.reasonCode, 'seed_budget');
  pass('超过16个实际重合种子明确held，不把静默截断种子当完整链');

  await withRagSourceTransaction([vaultRoot, userStateDir], async () => {
    await fs.writeFile(path.join(vaultRoot, 'notes', `${note.id}.md`), `${note.content}\r\n源已修改。`);
    await fs.writeFile(path.join(vaultRoot, 'metadata.json'), serializeMetadata([{ ...note, updatedAt: '2026-10-07T04:00:00.000Z' }]));
  });
  assert.equal((await bridge.attachNoteHits([hit]))[0].argumentContext.status, 'unavailable');
  assert.equal(await runtime.store.read({ kind: 'knowledge-note', entityId: note.id }), null);
  pass('保存源已观察变更隔离旧projection/pointer，不因为旧搜索结果还在就回退使用');

  console.log(`Argument search bridge checks passed: ${checks} groups (synthetic temporary sources, fixed reviewer votes; 0 model calls; no real vault/index/score/cognition writes).`);
} finally {
  globalThis.fetch = originalFetch;
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('loginote-argument-search-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
