/** Classic flow review confirmation; real renderer adapters and native IPC body,
 * synthetic memory only. No private library, external network or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import type { ArgDoc } from '../src/services/argumentDoc/types';
import type { CognitionMutation } from '../src/services/cognition/types';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import { retrieveCurrentCognition } from '../src/services/cognition/retrieval';
import { captureRestatementCognition, captureReviewCognition, loadPersonalCognition, savePersonalCognition,
  searchCurrentPersonalCognition, syncSavedRestatementsForCognition } from '../src/services/cognition/store';
import { saveFlowReviewRecord, saveReviewArgument } from '../src/services/textbook/reviewRecordStore';
import type { FlowSession } from '../src/types';

const at = '2026-11-08T01:00:00.000Z', later = '2026-11-08T02:00:00.000Z';
const raw = '我认为观察结果需要先核对条件，单次相关不能直接当作因果关系。';
const doc: ArgDoc = { doc_id: 'classic-confirmed-graph', title: '条件与观察', created_at: at, updated_at: later,
  iteration: 1, status: 'draft', nodes: [
    { id: 'premise', role: 'premise', mainType: '事实陈述', text: '实验前需要控制条件。', position: { x: 0, y: 0 } },
    { id: 'claim', role: 'claim', mainType: '推理', text: '单次相关不能直接当作因果关系。', position: { x: 0, y: 180 } },
  ] as ArgDoc['nodes'], edges: [{ id: 'support', source: 'premise', target: 'claim', relation: 'support' }] };
const base: NoteItem = { id: 'classic-project', title: '合成复盘', noteType: 'project', content: '合成教材，不是用户认知。',
  createdAt: at, updatedAt: at, tags: [], links: [], backlinks: [], dueDates: [] };
const session = { id: 'classic-session', noteId: base.id, noteTitle: base.title, rootProjectId: base.id,
  startedAt: at, endedAt: later, restateText: raw, incrementalText: raw, durationSeconds: 120 } as FlowSession;
const note = saveReviewArgument(saveFlowReviewRecord(base, session, 'pending_analysis'), doc, session.id, raw);
const originalNote = JSON.stringify(note), originalGraph = JSON.stringify(doc);
const observation = { noteId: note.id, noteTitle: note.title, recordId: session.id, sessionId: session.id,
  observedAt: at, updatedAt: at, text: raw };
let file = applyCognitionMutation(emptyCognitionFile(), { kind: 'record_restatements', observations: [observation] }, { id: 'existing-legacy', at });
const originalLegacy = JSON.stringify(file);
let reads = 0, writes = 0, vaultReads = 0, scope = 'synthetic-root';
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldFetch = globalThis.fetch;
const bridge = Object.assign(new EventTarget(), { electronAPI: {
  vault: { loadVault: async () => { vaultReads++; return [note]; } },
  userState: { getAgentTaskScope: async () => scope, loadCognition: async () => { reads++; return structuredClone(file); },
    searchCognition: async (query: string) => { reads++; return retrieveCurrentCognition(file, query); },
    mutateCognition: async (input: CognitionMutation) => {
      if (input.storageScopeId && input.storageScopeId !== scope) throw Error('scope changed');
      const next = applyCognitionMutation(file, input, { id: `explicit-${writes + 1}`, at: later });
      writes++; file = next; return structuredClone(file);
    } },
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: bridge });
globalThis.fetch = async () => assert.fail('No model or external network in classic confirmation checks');
let groups = 0;
const pass = (message: string) => { groups++; console.log('PASS ' + message); };
try {
  await captureRestatementCognition(note); await captureRestatementCognition(note, session.id);
  await syncSavedRestatementsForCognition();
  assert.deepEqual([reads, writes, vaultReads], [0, 0, 0]); assert.equal(JSON.stringify(file), originalLegacy);
  pass('saving a review/graph and compatibility capture hooks do not read, scan, migrate or write private cognition');

  await loadPersonalCognition(); const first = await searchCurrentPersonalCognition('观察条件');
  assert.ok(first.items.length); await searchCurrentPersonalCognition('观察条件');
  assert.equal(writes, 0); assert.equal(vaultReads, 0); assert.equal(JSON.stringify(file), originalLegacy);
  file = emptyCognitionFile(); await searchCurrentPersonalCognition('观察条件');
  assert.equal(file.records.length, 0); assert.equal(writes, 0); assert.equal(vaultReads, 0);
  pass('opening, querying and restarting the reader preserve existing beliefs and never backfill unconfirmed historical reviews');

  for (const input of [{ kind: 'record_restatements', observations: [observation] },
    { kind: 'record_restatements', confirmed: true, observations: [observation] },
    { kind: 'record_restatements', observations: [] }]) {
    await assert.rejects(savePersonalCognition(input as CognitionMutation), /明确确认/);
  }
  assert.equal(writes, 0);
  Reflect.deleteProperty(globalThis, 'window');
  await assert.rejects(savePersonalCognition({ kind: 'record_restatements', observations: [observation] }), /明确确认/);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: bridge });
  pass('old and forged desktop/browser automatic submissions are refused before any storage adapter is called');

  const editorMutation = (graph: ArgDoc, operation: 'initial' | 'revise'): CognitionMutation => ({ kind: 'confirm',
    confirmed: true, expectedRevision: file.revision, operation, reason: operation === 'initial' ? '' : '用户核对后修订',
    stance: 'endorsed', authorship: 'adopted_with_assistance', doc: graph, noteId: note.id });
  await savePersonalCognition(editorMutation(doc, 'initial'));
  assert.equal(file.records.length, 1); assert.equal(writes, 1);
  assert.deepEqual(latestCognition(file.records[0]).branches[0].graph.edges, doc.edges);
  assert.deepEqual(latestCognition(file.records[0]).source, { kind: 'argument_editor', docId: doc.doc_id, noteId: note.id });
  const firstRevision = structuredClone(file.records[0].revisions[0]);
  const changed = { ...doc, nodes: doc.nodes.map(node => node.id === 'claim' ? { ...node, text: '控制条件和重复观察后，再判断是否支持因果解释。' } : node) };
  const staleInput = editorMutation(changed, 'revise');
  await savePersonalCognition(staleInput);
  assert.equal(file.records[0].revisions.length, 2); assert.deepEqual(file.records[0].revisions[0], firstRevision);
  assert.match(latestCognition(file.records[0]).branches[0].graph.nodes[1].text, /重复观察/);
  const stable = JSON.stringify(file); await assert.rejects(savePersonalCognition(staleInput), /其他窗口更新/);
  assert.equal(JSON.stringify(file), stable); assert.equal(JSON.stringify(note), originalNote); assert.equal(JSON.stringify(doc), originalGraph);
  pass('the explicit editor confirmation writes the reviewed snapshot; revisions preserve the original graph, text and scores, while stale retries fail closed');

  const beforeAnswer = file.records.length;
  await captureReviewCognition({ id: 'review-answer', startedAt: at, endedAt: later, questionText: '你怎样理解观察？', knowledgeContext: '',
    messages: [{ id: 'own-answer', role: 'user', content: '我需要核对观察的具体条件。', timestamp: at }],
    answerEvidence: [{ messageId: 'own-answer', answer: '我需要核对观察的具体条件。', hintLevel: 0, consultedMaterialIds: [], targetKnowledgeNames: [] }] },
    { id: note.id, title: note.title });
  assert.equal(file.records.length, beforeAnswer + 1); assert.equal(latestCognition(file.records.at(-1)!).source.kind, 'review_answer');
  pass('the separate review-answer recording boundary is preserved and does not inherit the new flow-review confirmation gate');

  // Execute the actual public native IPC callback rather than a reimplemented guard.
  const source = ts.createSourceFile('main.ts', fs.readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
  let handler: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'user-state:mutate-cognition') handler = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(handler);
  const compiled = ts.transpileModule(`return ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let nativeWrites = 0;
  const invoke = new Function('referenceEnvironmentSuspended', 'taskScope', 'getUserStateDir', 'referenceSourceWriteEpoch',
    'mutateCognition', 'BrowserWindow', 'onWriteCommitted', compiled)(false, () => scope, () => 'synthetic-private-dir', 1,
    async (_directory: string, input: unknown, current: () => boolean) => { assert.ok(current()); nativeWrites++; return input; },
    { getAllWindows: () => [] }, () => {}) as (event: unknown, input: unknown) => Promise<unknown>;
  for (const recordId of [session.id, 'progressive:course:review:part']) {
    await assert.rejects(invoke({}, { kind: 'record_restatements', confirmed: true, observations: [{ ...observation, recordId }] }), /明确确认/);
  }
  assert.equal(nativeWrites, 0);
  await invoke({}, editorMutation(changed, 'revise')); assert.equal(nativeWrites, 1);
  scope = 'different-root'; await assert.rejects(invoke({}, { ...editorMutation(changed, 'revise'), storageScopeId: 'synthetic-root' }), /当前资料库/);
  assert.equal(nativeWrites, 1);
  pass('the production native IPC denies classic/progressive automatic ingress and forged consent, while explicit editor writes retain the storage-scope guard');
} finally {
  globalThis.fetch = oldFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Classic cognition confirmation: ${groups} groups passed; synthetic state only, no private library/model/network/installer.`);
