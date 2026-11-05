import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { FlowSession, NoteItem } from '../src/types';
import type { ArgDoc } from '../src/services/argumentDoc/types';
import { saveFlowReviewRecord, saveReviewArgument, patchLearningReviewRecord, detachReviewArgument } from '../src/services/textbook/reviewRecordStore';
import { flowReviewAdmission } from '../src/services/textbook/reviewAdmission';
import { savedRestatementObservations, restatementRecordId } from '../src/services/cognition/restatements';
import { applyCognitionMutation, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { retrieveCurrentCognition, withCognitionNeighborhood, readCognitionRetrieval } from '../src/services/cognition/retrieval';
import { buildInquirySnapshot } from '../src/services/cognition/inquiry';
import { captureRestatementCognition, searchCurrentPersonalCognition } from '../src/services/cognition/store';
import { COGNITION_FILE_NAME, loadCognition, mutateCognition } from '../src/electron/cognitionStore';
import { prepareArgumentPublication } from '../src/services/ui/argumentPublication';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import type { AgentRuntimeContext } from '../src/services/agent/types';

const at = '2026-10-20T01:00:00.000Z', later = '2026-10-20T02:00:00.000Z';
const raw = '心理账户让不同来源的钱不能直接互换。分类会改变消费决策。但同一个人也可能灵活调整类别。收入的标注提供了讨论背景。还可以先记录每次决策。';
const base: NoteItem = { id: 'project', title: '心理账户', noteType: 'project', content: 'TEXTBOOK NOT USER COGNITION',
  createdAt: at, updatedAt: at, tags: [], links: [], backlinks: [], dueDates: [] };
const session = { id: 'flow-graph', noteId: base.id, noteTitle: base.title, rootProjectId: base.id, startedAt: at,
  endedAt: at, durationSeconds: 600, restateText: raw, incrementalText: raw } as FlowSession;
const graph: ArgDoc = { doc_id: 'analysis-graph', title: '心理账户的个人理解', created_at: at, updated_at: later, iteration: 1, status: 'draft',
  summary: 'AI SUMMARY MUST NOT ENTER COGNITION', scores: { conceptScore: 10, judgmentScore: 20, logicScore: 30 },
  nodes: [
    { id: 'premise', role: 'premise', mainType: '事实陈述', text: '心理账户让不同来源的钱不能直接互换。' },
    { id: 'claim', role: 'claim', mainType: '推理', text: '分类会改变消费决策。' },
    { id: 'opposition', role: 'premise', mainType: '假设', text: '但同一个人也可能灵活调整类别。' },
    { id: 'context', role: 'background', mainType: '定义', text: '收入的标注提供了讨论背景。' },
    { id: 'isolated', role: 'method', mainType: '事实陈述', text: '还可以先记录每次决策。' },
  ].map(node => ({ ...node, role: node.role as NonNullable<ArgDoc['nodes'][number]['role']>, mainType: node.mainType as ArgDoc['nodes'][number]['mainType'],
    position: { x: 0, y: 0 }, status: 'warning', issue: 'AI DIAGNOSTIC NOT USER WORDS', severity: 3,
    suggestion: 'AI SUGGESTION NOT USER WORDS', user_edited: false, collapsed: false })),
  edges: [
    { id: 's', source: 'premise', target: 'claim', relation: 'support' },
    { id: 'o', source: 'opposition', target: 'claim', relation: 'oppose' },
    { id: 'c', source: 'context', target: 'premise', relation: 'context', reason: '原图记录的背景关系' },
  ] };
let groups = 0, sequence = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const sync = (file: ReturnType<typeof emptyCognitionFile>, note: NoteItem) => applyCognitionMutation(file,
  { kind: 'record_restatements', observations: savedRestatementObservations([note]) }, { id: `sync-${++sequence}`, at: later });
let note = saveFlowReviewRecord(base, session, 'pending_analysis');
let file = sync(emptyCognitionFile(), note);
assert.equal(file.records.length, 1); assert.equal(latestCognition(file.records[0]).branches[0].graph.edges.length, 0);
note = saveReviewArgument(note, graph, session.id, raw);
const rows = savedRestatementObservations([note]); assert.equal(rows.length, 1); assert.equal(rows[0].graph!.argumentDocId, graph.doc_id);
file = sync(file, note);
const identity = restatementRecordId(rows[0]), current = latestCognition(file.records[0]);
assert.equal(file.records.length, 1); assert.equal(file.records[0].id, identity); assert.equal(file.records[0].revisions.length, 2);
assert.deepEqual(current.branches[0].graph.nodes.map(({ id, text, role, mainType }) => ({ id, text, role, mainType })),
  graph.nodes.map(({ id, text, role, mainType }) => ({ id, text, role, mainType })));
assert.deepEqual(current.branches[0].graph.edges, graph.edges);
assert.equal(current.branches[0].stance, 'endorsed'); assert.equal(current.factSupport, 'not_assessed'); assert.equal(current.mastery, 'not_assessed');
assert.equal(current.source.kind, 'restatement'); if (current.source.kind !== 'restatement') throw new Error('source');
assert.equal(current.source.originalText, raw); assert.equal(current.source.graph!.argumentDocId, graph.doc_id);
assert.doesNotMatch(JSON.stringify(rows), /AI SUMMARY|AI DIAGNOSTIC|AI SUGGESTION|TEXTBOOK|conceptScore/);
assert.equal(sync(file, note), file);
pass('saved analysis graph upgrades the same cognition record, preserving node identities/roles/types, directed edges/reasons, raw text and history; no new extraction or scoring');

const retrieval = withCognitionNeighborhood(file, retrieveCurrentCognition(file, '消费决策'));
assert.ok(retrieval.items.some(hit => hit.nodeId === 'claim' && hit.neighbors?.some(neighbor => neighbor.relation === 'oppose' && neighbor.sourceNodeId === 'opposition')));
const overview = buildInquirySnapshot(file, '查看我的认知库');
assert.equal(overview.counts.currentNodes, 5); assert.equal(overview.pages.flatMap(page => page.edges).length, 3);
assert.ok(overview.pages.flatMap(page => page.sources).some(source => source.reference?.nodeId === 'isolated'));
assert.equal(overview.pages.flatMap(page => page.sources).find(source => source.reference?.nodeId === 'claim')?.role, 'claim');
assert.equal(overview.pages.flatMap(page => page.edges).find(edge => edge.relation === 'context')?.reason, graph.edges[2].reason);
const normalized = readCognitionRetrieval(withCognitionNeighborhood(file, retrieveCurrentCognition(file, '不同来源的钱')))!;
assert.equal(normalized.items[0].role, 'premise'); assert.equal(normalized.items[0].mainType, '事实陈述');
assert.ok(normalized.items[0].neighbors?.some(neighbor => neighbor.relation === 'context' && neighbor.role === 'background' && neighbor.reason === graph.edges[2].reason));
for (const relation of ['method_for', 'relates'] as const) {
  const projected = readCognitionRetrieval({ ...normalized, items: [{ ...normalized.items[0], neighbors: [{ nodeId: 'isolated',
    sourceNodeId: 'isolated', targetNodeId: 'premise', relation, role: 'method', text: '记录每次决策', textTruncated: false, stance: 'endorsed', needsReview: false }] }] })!;
  assert.equal(projected.items[0].neighbors?.[0].relation, relation);
}
pass('actual retrieval/inquiry reads the reused graph, including opposition and isolated nodes, without inventing edges');

assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [] }]).length, 0);
assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [{ ...note.learningReviewRecords![0], argumentDocIds: [] }] }])[0].graph, undefined);
assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [{ ...note.learningReviewRecords![0], projectNoteId: 'foreign' }] }]).length, 0);
const editedText = patchLearningReviewRecord(note, session.id, { editedRestatement: '我现在认为类别可以调整，但会受到情境影响。' });
assert.equal(savedRestatementObservations([editedText])[0].graph, undefined, 'edited words cannot inherit an old analysis');
let textFile = sync(file, editedText); assert.equal(latestCognition(textFile.records[0]).branches[0].graph.edges.length, 0);
assert.equal(textFile.records[0].revisions[1].branches[0].graph.edges.length, 3);
const cleared = patchLearningReviewRecord(note, session.id, { editedRestatement: '' });
assert.equal(savedRestatementObservations([cleared])[0].graph, undefined); assert.ok(sync(file, cleared).records[0].withdrawn);
const noGraph = detachReviewArgument({ ...note, argumentDocs: [] }, graph.doc_id);
assert.equal(savedRestatementObservations([noGraph])[0].graph, undefined);
assert.equal(latestCognition(sync(file, noGraph).records[0]).branches[0].graph.edges.length, 0);
const legacy = { ...note, learningReviewRecords: note.learningReviewRecords!.map(({ argumentRestatementKey, ...record }) => record) };
assert.ok(savedRestatementObservations([legacy])[0].graph, 'legacy untouched user words can reuse an existing bound graph');
assert.equal(savedRestatementObservations([{ ...legacy, learningReviewRecords: legacy.learningReviewRecords.map(record => ({ ...record, userEditedRestatement: true })) }])[0].graph, undefined);
pass('only review-bound graphs are reused; changed/cleared source text, deleted graphs, foreign bindings and ambiguous edited legacy sources do not revive stale structure');

const editedGraph = { ...graph, updated_at: '2026-10-20T03:00:00Z', edges: graph.edges.filter(edge => edge.id !== 'o') };
const graphEdited = saveReviewArgument(note, editedGraph);
const changed = sync(file, graphEdited);
assert.equal(changed.records.length, 1); assert.equal(latestCognition(changed.records[0]).branches[0].graph.edges.length, 2);
assert.equal(changed.records[0].revisions[1].branches[0].graph.edges.length, 3);
const forgotten = applyCognitionMutation(file, { kind: 'forget', expectedRevision: file.revision, confirmed: true, recordId: identity }, { id: 'forget', at: later });
assert.equal(sync(forgotten, note).records.length, 0);
const manuallyUpdated = applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true,
  target: { recordId: identity, revisionId: current.id, branchId: 'primary', nodeId: 'claim', operation: 'revise', reason: '手动修订理解' },
  text: '我只在特定条件下接受这个结论。', mainType: '推理', stance: 'tentative', authorship: 'own_expression' }, { id: 'manual', at: later });
assert.equal(sync(manuallyUpdated, graphEdited), manuallyUpdated);
assert.throws(() => sync(file, { ...note, argumentDocs: [{ ...graph, edges: [{ id: 'bad', source: 'missing', target: 'claim', relation: 'support' }] }] }), /引用缺失/);
assert.throws(() => parseCognitionFile({ ...file, records: [{ ...file.records[0], revisions: [{ ...current, number: 1,
  source: { ...current.source, graph: { argumentDocId: '', updatedAt: later } } }] }] }), /来源/);
pass('graph edits create versions rather than duplicates; manual cognition revisions and forgetting win; malformed edges/source pointers fail closed');

const appSource = readFileSync('src/App.tsx', 'utf8'), ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function handler(name: string, env: Record<string, unknown>): any {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) initializer = node.initializer; ts.forEachChild(node, visit); }; visit(ast); assert.ok(initializer, name);
  const code = ts.transpileModule(`return ${initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-flow-'));
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network/model calls in graph reuse checks');
try {
  const notesRef = { current: [saveFlowReviewRecord(base, session, 'pending_analysis')] };
  const encode = async () => [1, ...Array(383).fill(0)];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
    vault: { loadVault: async () => notesRef.current }, userState: { getAgentTaskScope: async () => 'fixture-root',
      loadCognition: () => loadCognition(temporary), mutateCognition: (input: unknown) => mutateCognition(temporary, input),
      searchCognition: (query: string) => searchPersonalCognition(temporary, query, encode) } } }) });
  await captureRestatementCognition(notesRef.current[0]);
  let rejectSave = false, navigations = 0, captureCount = 0;
  const save = handler('saveArgumentDoc', { notesRef, prepareArgumentPublication,
    persistLearningMutation: async (_id: string, mutate: (latest: NoteItem) => NoteItem) => {
      if (rejectSave) throw new Error('synthetic disk failure'); notesRef.current = [mutate(notesRef.current[0])];
    }, saveReviewArgument, captureRestatementCognition: async (note: NoteItem) => { captureCount++; await captureRestatementCognition(note); },
    setActiveNoteId: () => navigations++, setCurrentView: () => navigations++ });
  const before = await fs.readFile(path.join(temporary, COGNITION_FILE_NAME), 'utf8'); rejectSave = true;
  await assert.rejects(save(graph, base.id, 'new', session.id, false, 'draft', raw), /disk failure/);
  assert.equal(captureCount, 0); assert.equal(await fs.readFile(path.join(temporary, COGNITION_FILE_NAME), 'utf8'), before);
  rejectSave = false; assert.equal(await save(graph, base.id, 'new', session.id, false, 'draft', raw), true);
  assert.equal(captureCount, 1); assert.equal(navigations, 0);
  assert.equal(notesRef.current[0].argumentDocs![0].rag?.publishedSnapshot, undefined);
  let persisted = await loadCognition(temporary); assert.equal(persisted.records.length, 1);
  assert.deepEqual(latestCognition(persisted.records[0]).branches[0].graph.edges, graph.edges);
  await save(graph, base.id, 'new', session.id, false, 'draft', raw);
  persisted = await loadCognition(temporary); assert.equal(persisted.records.length, 1); assert.equal(persisted.records[0].revisions.length, 2);
  pass('actual App save handler persists a draft before private graph sync; disk failure does not ingest unsaved graphs, retry is idempotent and never publishes/navigates');

  let saves = 0, result: any = null, failure = false, error = '';
  const ready = handler('handleArgumentReady', { flowSessionRef: { current: session }, notesRef, flowReviewAdmission,
    saveArgumentDoc: async (...args: any[]) => { saves++; assert.equal(args[3], session.id); assert.equal(args[4], false); assert.equal(args[5], 'draft');
      assert.equal(args[6], raw); if (failure) throw new Error('synthetic cognition failure'); return true; },
    reportLearningSaveError: (cause: Error) => { error = cause.message; },
    setFlowResult: (value: any) => { result = value; }, setIsFlowAnalysisOpen() {}, setAnalysisProgressOpen() {} });
  ready(graph, {}, { ...session, id: 'stale' }); assert.equal(saves, 0);
  ready(undefined, {}, session); assert.equal(saves, 0);
  ready(graph, {}, session); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saves, 1); assert.equal(result.doc.doc_id, graph.doc_id);
  failure = true; ready(graph, {}, session); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(error, 'synthetic cognition failure'); assert.equal(result.doc.doc_id, graph.doc_id);
  pass('actual analysis-completion handler automatically saves/syncs the existing graph, ignores late activity results and preserves the editable canvas on failure');

  // Simulate an old installation that saved the graph but never copied it into private cognition.
  const backfill = path.join(temporary, 'legacy-backfill');
  (window as any).electronAPI.userState = { getAgentTaskScope: async () => 'fixture-root',
    loadCognition: () => loadCognition(backfill), mutateCognition: (input: unknown) => mutateCognition(backfill, input),
    searchCognition: (query: string) => searchPersonalCognition(backfill, query, encode) };
  const hits = await searchCurrentPersonalCognition('心理账户消费决策');
  assert.ok(hits.items.some(hit => hit.neighbors?.length));
  const filled = await loadCognition(backfill); assert.equal(filled.records.length, 1);
  assert.equal(latestCognition(filled.records[0]).branches[0].graph.edges.length, 3);
  const stable = await fs.readFile(path.join(backfill, COGNITION_FILE_NAME), 'utf8');
  await searchCurrentPersonalCognition('心理账户消费决策');
  assert.equal(await fs.readFile(path.join(backfill, COGNITION_FILE_NAME), 'utf8'), stable);
  pass('actual private recall backfills saved historical review graphs, then reuses the unchanged snapshot without rewriting or contacting a model');

  let graphRead = false;
  const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
    hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
  const agentResult = await runAgentTurn({ role: AGENT_ROLES.default, userText: '查看我的认知库，说明我的逻辑关系', ctx, history: [],
    memoryPrefixLoader: async () => '', enableMultiAgent: true, callLlm: async request => {
      if (request.workflow === 'agent-intent-routing') return { content: '', parsedJson: { skillId: 'personalized-qa', confidence: .99,
        standaloneRequest: '查看我的认知库，说明我的逻辑关系', referenceResolution: 'none' } };
      const input = JSON.parse(request.userInput!); const page = input.pages[0];
      assert.ok(page.edges.some((edge: any) => edge.relation === 'context'));
      assert.ok(page.edges.some((edge: any) => edge.relation === 'oppose'));
      const source = page.sources.find((source: any) => source.role === 'claim'); assert.ok(source); graphRead = true;
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: `你记录的结论是：${source.text}`,
        evidence: [{ id: source.id, quote: source.text }] }] } };
    } });
  assert.ok(graphRead); assert.ok(agentResult.toolTrace.some(step => step.call.name === 'read_cognition_page'));
  assert.ok(agentResult.updatedHistory.at(-1)?.cognitionReferences?.some(reference => reference.nodeId === 'claim'));
  assert.equal(await fs.readFile(path.join(backfill, COGNITION_FILE_NAME), 'utf8'), stable);
  pass('actual Agent receives the saved graph roles/directions and returns checked source pointers, with no extraction, publication or cognition mutation');
} finally {
  globalThis.fetch = previousFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  assert.equal(path.dirname(temporary), os.tmpdir()); assert.ok(path.basename(temporary).startsWith('loginote-cognition-flow-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`Cognition flow-graph reuse: ${groups} groups passed; synthetic stores/actual handlers, no real vault, model or network.`);
