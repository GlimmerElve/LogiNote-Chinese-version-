import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NoteItem, NoteRagIndexInput } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { ArgDoc, ArgNode } from '../src/services/argumentDoc/types';
import { emptyCognitionFile } from '../src/services/cognition/core';
import { personalProjectContent, projectMaterialRows, referenceNoteContent } from '../src/services/ragSourcePolicy';
import { retrieveProjectMaterials, retrievePublishedMaterials, readCognitionMaterials } from '../src/services/cognition/materials';
import { buildNoteRagContent, buildNoteRagIndexInput, normalizeNoteSearchResults } from '../src/services/ragService';
import { buildQaEvidenceResult, registerQaTools } from '../src/services/agent/tools/qaTools';
import { isAlignmentReference, comparisonUnavailable } from '../src/services/cognition/alignment';
import { setCognitionMaterialDataRoot, syncCognitionMaterialNote, syncCognitionMaterialNotes, deleteCognitionMaterialNote, searchCognitionMaterials } from '../src/electron/cognitionMaterials';
import { setNoteRagDataRoot, indexNote, countNotes, indexNotes } from '../src/electron/noteRag';
import { setUserArgumentDataRoot, syncUserArgumentNote, archiveLegacyUserArgumentShards, readAllUserArgumentShards } from '../src/electron/rag/userArgumentIndex';
import { assessArgumentDoc, createPublishedSnapshot } from '../src/services/argumentDoc/quality';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { savedFlowReviewGraphs, retrieveFlowReviewGraphs } from '../src/services/cognition/flowReviewMaterials';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loginote-rag-separation-'));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No network in source separation checks'); };
const source = '我在主动回忆练习中发现，只看答案会掩盖提取困难。';
const project: NoteItem = { id: 'project-1', title: '主动回忆项目', noteType: 'project',
  content: `- [ ] 理解 [[主动回忆]] @due(2026-10-08) <!-- ln-task:task1 -->\n\nAI 生成的起始计划说明。\n\n${source}`,
  generatedContentBlocks: ['AI 生成的起始计划说明。'], tags: [], links: ['主动回忆'], backlinks: [], dueDates: [],
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' };
const knowledge: NoteItem = { ...project, id: 'knowledge-1', title: '主动回忆', noteType: 'knowledge',
  content: '主动回忆是主动从记忆中提取信息的学习方法。', generatedContentBlocks: undefined };
const argNode = (id: string, mainType: ArgNode['mainType'], text: string): ArgNode => ({ id, mainType, text,
  position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false });
const graph: ArgDoc = { doc_id: 'argument-1', title: '主动回忆论证', created_at: project.createdAt, updated_at: project.updatedAt,
  iteration: 0, status: 'draft', nodes: [argNode('premise', '事实陈述', '主动回忆可暴露提取困难。'),
    argNode('conclusion', '推理', '因此主动回忆应先尝试提取再查看答案。')],
  edges: [{ id: 'edge1', source: 'premise', target: 'conclusion', relation: 'support' }] };
const snapshot = createPublishedSnapshot(graph, assessArgumentDoc(graph, project.updatedAt), project.updatedAt);
const graphNote: NoteItem = { ...knowledge, id: 'graph-host', argumentDocs: [{ ...graph,
  rag: { publishedSnapshot: snapshot } } as ArgDoc] };
const input = buildNoteRagIndexInput(project), graphInput = buildNoteRagIndexInput(graphNote);
let passCount = 0;
const pass = (name: string) => { passCount++; console.log(`PASS ${name}`); };

try {
  assert.equal(referenceNoteContent(input), '');
  assert.equal(buildNoteRagContent(graphNote), knowledge.content, 'Knowledge-hosted user graph must not leak into reference text');
  assert.equal(personalProjectContent(input), source);
  assert.equal(personalProjectContent(buildNoteRagIndexInput(knowledge)), '');
  assert.equal(projectMaterialRows({ ...input, content: '- [ ] 仅有计划任务' }).length, 0);
  assert.ok(retrieveProjectMaterials([{ ...input, content: '前言'.repeat(900) + '\n\n' + source }], '主动回忆').length,
    'Restatements after the opening plan must still be indexed');
  assert.equal(project.content.includes('ln-task:task1'), true, 'Original body and wiki task links are untouched');
  pass('项目复述与知识点分源，计划/任务被排除，末尾复述可检索，原文不变');

  const normalized = normalizeNoteSearchResults([
    { noteId: 'legacy', title: '无类型旧索引', snippet: source, score: 0.9 },
    { noteId: project.id, noteType: 'project', title: project.title, snippet: source, score: 0.9 },
    { noteId: 'graph', noteType: 'knowledge', title: '用户图', snippet: source, score: 0.9, matchKinds: ['argument'] },
    { noteId: knowledge.id, noteType: 'knowledge', title: knowledge.title, snippet: knowledge.content, score: 0.8 },
  ]);
  assert.deepEqual(normalized.map((r) => r.noteId), [knowledge.id]);
  const evidence = buildQaEvidenceResult({ question: '什么是主动回忆？', requestedScope: 'current-note', activeNote: project,
    noteResults: normalized, documentResults: [] });
  assert.deepEqual(evidence.sources, []); assert.equal(evidence.coverage, 'insufficient');
  assert.match(evidence.warnings.join(''), /个人认知素材/);
  const staleTypedResult = { noteId: project.id, noteType: 'knowledge' as const, title: project.title, snippet: source, score: 0.8 };
  assert.deepEqual(buildQaEvidenceResult({ question: '主动回忆', requestedScope: 'global', notes: [project],
    noteResults: [staleTypedResult], documentResults: [] }).sources, [], 'Fresh note type overrides stale derived cache type');
  assert.equal(isAlignmentReference({ sourceId: 'N1', type: 'note', noteType: 'knowledge', snippet: knowledge.content }), true);
  assert.equal(isAlignmentReference({ sourceId: 'N1', type: 'note', noteType: 'project', snippet: source }), false);
  assert.equal(isAlignmentReference({ sourceId: 'N1', type: 'note', snippet: source }), false);
  pass('旧/项目/论证图结果均不能进入事实证据，知识点可作非权威参考');

  setNoteRagDataRoot(tempRoot); setCognitionMaterialDataRoot(tempRoot); setUserArgumentDataRoot(tempRoot);
  await writeFile(path.join(tempRoot, 'note-embeddings.json'), JSON.stringify([
    { noteId: 'legacy', title: '无来源缓存', text: source, snippet: source, embedding: [1, 0] },
    { noteId: 'known', noteType: 'knowledge', title: '已知', text: knowledge.content, snippet: knowledge.content, embedding: [1, 0] },
  ]));
  assert.equal(await countNotes(), 1, 'Unknown legacy cache fails closed before rebuild');
  await indexNote(input); assert.equal(await countNotes(), 1, 'Project indexing must not request an embedding or enter reference cache');
  await indexNotes([input]); assert.equal(await countNotes(), 0, 'Deleted/type-changed reference rows are pruned');
  pass('桌面资料索引拒绝未知类型，重建/类型变更清除旧衍生行');

  await syncCognitionMaterialNotes([input, buildNoteRagIndexInput(knowledge)]);
  await syncUserArgumentNote(graphInput, async () => [1, 0]);
  const privateHits = await searchCognitionMaterials('主动回忆');
  assert.ok(privateHits.some((h) => h.sourceKind === 'project-restatement'));
  assert.ok(privateHits.some((h) => h.sourceKind === 'published-argument'));
  assert.ok(privateHits.every((h) => h.stance === 'not_assessed' && h.usableAsFactEvidence === false));
  assert.equal(readCognitionMaterials([{ ...privateHits[0], stance: 'endorsed' }]).length, 0);
  assert.equal(readCognitionMaterials([{ ...privateHits[0], usableAsFactEvidence: true }]).length, 0);
  assert.ok(retrievePublishedMaterials([graphInput], '主动回忆').length);
  assert.equal(retrievePublishedMaterials([{ ...graphInput, publishedArguments: [{ argumentDocId: graph.doc_id,
    snapshot: { ...snapshot, revisionHash: 'wrong-hash' } }] }], '主动回忆').length, 0);
  assert.equal(comparisonUnavailable({ personalCognition: { status: 'ready', method: 'local-lexical-v1', items: [],
    materials: privateHits, warning: '' }, sources: [{ sourceId: 'D1', type: 'document', snippet: '资料' }],
    review: { supportedCitationIds: ['D1'] } }), 'no_personal_match');
  pass('个人素材双来源可召回，均无立场/事实资格，不能代替确认认知参与冲突判定');

  await syncCognitionMaterialNote({ ...input, content: '现在我记录的是另一种学习方法。' });
  assert.equal((await searchCognitionMaterials('掩盖提取困难')).some((h) => h.noteId === project.id), false);
  await deleteCognitionMaterialNote(project.id);
  assert.equal((await searchCognitionMaterials('学习方法')).some((h) => h.noteId === project.id), false);
  await syncCognitionMaterialNote({ ...input, noteType: 'knowledge' });
  assert.equal((await readdir(path.join(tempRoot, 'user-state', 'cognition-materials'))).some((name) => name.startsWith('project-')), false);
  pass('更新、删除、类型变更均撤下旧个人素材，不写入确认立场');

  const privateDir = path.join(tempRoot, 'user-state', 'cognition-materials');
  const shardName = (await readdir(privateDir)).find((name) => name.startsWith('user-argument-'))!;
  await mkdir(path.join(tempRoot, 'rag-index'));
  await writeFile(path.join(tempRoot, 'rag-index', shardName), await readFile(path.join(privateDir, shardName)));
  await archiveLegacyUserArgumentShards();
  assert.equal((await readdir(path.join(tempRoot, 'rag-index'))).length, 0);
  assert.equal((await readdir(path.join(privateDir, 'legacy'))).length, 1);
  assert.equal((await readAllUserArgumentShards()).length, 1, 'Legacy archives are not searched');
  pass('用户图位于私有衍生目录，旧公开缓存可恢复归档且不参与检索');

  let notes = [project, knowledge, graphNote], writes = 0;
  const cognition = emptyCognitionFile();
  const material = retrieveProjectMaterials([input], '主动回忆')[0];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
    userState: { loadCognition: async () => cognition, searchCognition: async () => ({ status: 'ready', method: 'local-lexical-v1',
      items: [], materials: [material], materialsStatus: 'ready', fileRevision: cognition.revision, warning: '' }),
      mutateCognition: async () => { writes++; throw new Error('Must not write'); } },
    noteRag: { search: async () => { throw new Error('Recall must not use public QA'); } },
  } }) });
  registerQaTools();
  const ctx = { getNotes: () => notes, getActiveNote: () => project, getResourceDraftSession: () => null,
    getPlanDraftSession: () => null, hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
  const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待主动回忆的', ctx, history: [],
    enableMultiAgent: true, memoryPrefixLoader: async () => '', callLlm: async (request) => {
      const data = JSON.parse(request.userInput!);
      const m = data.pages.flatMap((p: { sources: Array<{ id: string; kind: string; text: string }> }) => p.sources)
        .find((s: { kind: string }) => s.kind === 'material');
      assert.equal(data.counts.endorsedFacts, 0); assert.equal(m.id, 'M1');
      return { content: JSON.stringify({ action: 'answer', paragraphs: [{ text: '你在项目复述中记录了查看答案可能掩盖提取困难。',
        evidence: [{ id: m.id, quote: m.text }] }] }) };
    } });
  assert.match(result.reply, /未确认立场/);
  assert.equal(result.updatedHistory.at(-1)?.citations?.[0].sourceId, 'M1');
  assert.equal(result.updatedHistory.at(-1)?.citations?.[0].entityId, project.id);
  assert.equal(result.updatedHistory.at(-1)?.cognitionReferences, undefined);
  assert.equal(writes, 0); assert.equal(cognition.records.length, 0);
  pass('真实 Agent 可在空确认库查询项目原话，M# 可打开原笔记，且不推断认同或自动写入');

  const reviewGraph: ArgDoc = { ...graph, doc_id: 'saved-review', nodes: graph.nodes.map((n, i) => ({ ...n, role: i ? 'claim' : 'premise' })) };
  const reviewNote = { ...project, argumentDocs: [reviewGraph], learningReviewRecords: [{ schemaVersion: 1,
    projectNoteId: project.id, sessionId: 'session', argumentDocIds: [reviewGraph.doc_id] }] } as unknown as NoteItem;
  notes = [reviewNote];
  const graphMaterial = retrieveFlowReviewGraphs(savedFlowReviewGraphs(reviewNote), '我是如何看待主动回忆的')[0];
  (window as any).electronAPI.userState.searchCognition = async () => ({ status: 'ready', method: 'local-lexical-v1',
    items: [], materials: [graphMaterial], materialsStatus: 'ready', fileRevision: cognition.revision, warning: '' });
  const recalledGraph = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待主动回忆的', ctx, history: [],
    memoryPrefixLoader: async () => '', callLlm: async request => {
      const body = JSON.parse(request.userInput!);
      const item = body.pages.flatMap((p: any) => p.sources).find((s: any) => s.kind === 'material');
      assert.equal(item.sourceKind, 'flow-review-argument');
      assert.match(item.relationSummary, /premise -support-> conclusion/u);
      assert.equal(body.counts.endorsedFacts, 0);
      return { content: JSON.stringify({ action: 'answer', paragraphs: [{ text: '你在已保存的复盘图中记录了这条依据与主张。',
        evidence: [{ id: item.id, quote: item.text }] }] }) };
    } });
  assert.deepEqual(recalledGraph.updatedHistory.at(-1)?.citations?.[0].matchKinds, ['argument']);
  assert.equal(recalledGraph.updatedHistory.at(-1)?.citations?.[0].entityId, project.id);
  assert.equal(writes, 0); assert.equal(cognition.records.length, 0);
  pass('待复核复盘图可经实际 Agent 召回角色与有向关系，但不自动成为已确认事实或立场');

  notes = [knowledge];
  const stale = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待主动回忆的', ctx, history: [],
    memoryPrefixLoader: async () => '', callLlm: async () => { throw new Error('Deleted source must not reach model'); } });
  assert.equal(stale.updatedHistory.at(-1)?.citations?.length || 0, 0);
  assert.doesNotMatch(stale.reply, /查看答案会掩盖/);
  pass('笔记删除后，即使衍生查询返回旧命中也不会交给模型或继续引用');

  console.log(`\n${passCount} RAG source separation checks passed (synthetic, offline).`);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  await rm(tempRoot, { recursive: true, force: true });
}
