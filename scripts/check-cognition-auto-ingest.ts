import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import type { CognitionFile, CognitionMutation, CognitionObservation, RestatementObservation } from '../src/services/cognition/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { adoptPendingReviewAnswers, applyCognitionMutation, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { currentCognitionItems, retrieveCurrentCognition, wantsCognitionRecall } from '../src/services/cognition/retrieval';
import { buildInquirySnapshot } from '../src/services/cognition/inquiry';
import { savedRestatementObservations, restatementRecordId } from '../src/services/cognition/restatements';
import { reviewCognitionObservations } from '../src/services/cognition/observations';
import { captureReviewCognition, captureRestatementCognition, searchCurrentPersonalCognition } from '../src/services/cognition/store';
import { COGNITION_FILE_NAME, COGNITION_INDEX_FILE_NAME, loadCognition, mutateCognition } from '../src/electron/cognitionStore';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { selectAgentSkill } from '../src/services/agent/skillRegistry';

let groups = 0, sequence = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const at = '2026-10-20T01:00:00.000Z';
const apply = (file: CognitionFile, input: unknown) => applyCognitionMutation(file, input, { id: `auto-${++sequence}`, at });
const observation: CognitionObservation = { activityKind: 'review', activityId: 'review-auto', messageId: 'answer-1', role: 'user',
  answer: '我认为心理账户中的钱不能随意互换，这可能影响消费决策。', question: '你如何理解心理账户？',
  observedAt: at, noteId: 'project', noteTitle: '心理账户', hintLevel: 2, consultedMaterialIds: ['local:book'], targetKnowledgeNames: ['心理账户'] };
const review = (rows = [observation]) => ({ kind: 'record_review', enabled: true, observations: rows });
const restatement: RestatementObservation = { noteId: 'project', noteTitle: '概率论', recordId: 'flow-auto', sessionId: 'flow-auto', observedAt: at,
  updatedAt: at, text: '我认为独立事件与互斥事件是同一种关系。' }; // Incorrect understanding is still an actual user belief.
const restate = (row = restatement) => ({ kind: 'record_restatements', observations: [row] });
let file = apply(emptyCognitionFile(), review());
assert.equal(file.records.length, 1); assert.equal(file.candidates![0].status, 'accepted');
assert.equal(latestCognition(file.records[0]).branches[0].stance, 'endorsed');
assert.equal(latestCognition(file.records[0]).branches[0].graph.nodes[0].text, observation.answer);
assert.equal(latestCognition(file.records[0]).authorship, 'adopted_with_assistance');
assert.equal(latestCognition(file.records[0]).source.kind, 'review_answer');
assert.equal(latestCognition(file.records[0]).factSupport, 'not_assessed'); assert.equal(latestCognition(file.records[0]).mastery, 'not_assessed');
assert.equal(retrieveCurrentCognition(file, '心理账户').items.length, 1);
assert.equal(apply(file, review()), file); // Stable source IDs, not fuzzy text deduplication.
assert.throws(() => apply(file, review([{ ...observation, answer: '相同消息 ID 的另一份原文。' }])), /来源身份冲突/);
pass('own review answer enters current cognition immediately, retains assistance/context and raw words, replay is idempotent');

for (const answer of ['好的，谢谢', '请问独立和互斥有什么区别？', '> 这是资料的原话而不是我的观点。', '“心理账户一定有害。”', '资料说选择数量越多越好。']) {
  assert.equal(apply(emptyCognitionFile(), review([{ ...observation, answer }])).records.length, 0, answer);
}
assert.throws(() => apply(emptyCognitionFile(), review([{ ...observation, role: 'assistant' } as never])), /用户/);
const episode = { id: observation.activityId, startedAt: at, endedAt: at, questionText: observation.question, knowledgeContext: 'PRIVATE DOCUMENT NOT USER BELIEF',
  messages: [{ id: 'tutor-1', role: 'assistant' as const, content: observation.question, timestamp: at },
    { id: 'answer-1', role: 'user' as const, content: '货币非中性', timestamp: at },
    { id: 'tutor-2', role: 'assistant' as const, content: 'AI GENERATED FEEDBACK', timestamp: at }],
  answerEvidence: [{ messageId: 'answer-1', answer: '货币非中性', hintLevel: 0 as const, consultedMaterialIds: [], targetKnowledgeNames: ['心理账户'] }] };
const rows = reviewCognitionObservations(episode, { id: 'project', title: '心理账户' });
assert.equal(rows.length, 1); assert.equal(rows[0].answer, '货币非中性');
assert.doesNotMatch(JSON.stringify(rows), /PRIVATE DOCUMENT|AI GENERATED/);
pass('short substantive expressions admitted; questions, quotes, source text, assistant feedback and unsent drafts excluded');

const pending = apply(emptyCognitionFile(), { kind: 'capture_review', enabled: true, observations: [observation] });
const upgraded = adoptPendingReviewAnswers(pending, { id: 'upgrade', at });
assert.equal(upgraded.records.length, 1); assert.equal(upgraded.candidates![0].status, 'accepted');
assert.equal(adoptPendingReviewAnswers(upgraded, { id: 'again', at }), upgraded);
const dismissed = apply(pending, { kind: 'dismiss_candidate', candidateId: pending.candidates![0].id, expectedRevision: pending.revision, confirmed: true });
assert.equal(adoptPendingReviewAnswers(dismissed, { id: 'upgrade', at }).records.length, 0);
const forgotten = apply(upgraded, { kind: 'forget', recordId: upgraded.records[0].id, expectedRevision: upgraded.revision, confirmed: true });
assert.equal(apply(forgotten, review()).records.length, 0);
pass('legacy pending answers upgraded without another confirmation; dismissed or forgotten sources never resurrect');

file = apply(file, restate());
const id = restatementRecordId(restatement), recorded = file.records.find(record => record.id === id)!;
assert.equal(latestCognition(recorded).branches[0].stance, 'endorsed');
assert.equal(latestCognition(recorded).source.kind, 'restatement'); assert.equal(apply(file, restate()), file);
const edit = { ...restatement, text: '独立描述概率乘法关系，互斥描述不能同时发生。', updatedAt: '2026-10-20T02:00:00Z' };
file = apply(file, restate(edit));
assert.equal(file.records.find(record => record.id === id)!.revisions.length, 2);
assert.equal(file.records.find(record => record.id === id)!.revisions[0].branches[0].graph.nodes[0].text, restatement.text);
assert.equal(apply(file, restate()), file, 'stale source snapshot cannot roll back a newer saved revision');
file = apply(file, restate({ ...edit, text: '', updatedAt: '2026-10-20T03:00:00Z' }));
assert.ok(file.records.find(record => record.id === id)!.withdrawn);
assert.equal(apply(file, restate(edit)), file, 'late source replay cannot revive a newer withdrawal');
assert.equal(file.records.find(record => record.id === id)!.revisions.length, 2, 'withdrawal must not rewrite revision provenance');
assert.equal(retrieveCurrentCognition(file, '独立').items.length, 0);
assert.equal(currentCognitionItems(file).some(hit => hit.recordId === id), false);
assert.ok(buildInquirySnapshot(file, '我的概率论认知历史').pages.length);
assert.ok(buildInquirySnapshot(file, '我的概率论认知历史').pages.flatMap(page => page.sources).every(source => !source.current));
assert.equal(buildInquirySnapshot(file, '我的概率论认知是什么').pages.length, 0);
const clearedBeforeSync = apply(emptyCognitionFile(), restate({ ...edit, text: '', updatedAt: '2026-10-20T03:00:00Z' }));
assert.equal(apply(clearedBeforeSync, restate(edit)), clearedBeforeSync, 'empty first sync must also reject older delayed text');
assert.equal(clearedBeforeSync.records.length, 0);
file = apply(file, restate({ ...edit, updatedAt: '2026-10-20T04:00:00Z' }));
assert.equal(file.records.find(record => record.id === id)!.withdrawn, false);
const removed = apply(file, { kind: 'forget', recordId: id, expectedRevision: file.revision, confirmed: true });
assert.equal(apply(removed, restate(edit)).records.some(record => record.id === id), false);
pass('restatement corrections preserve history, empty text withdraws current belief, stale retry/forgotten source cannot overwrite or revive');

const note: NoteItem = { id: 'project', title: '概率论', noteType: 'project', content: 'GENERATED PROJECT BODY', createdAt: at, updatedAt: at,
  tags: [], links: [], backlinks: [], dueDates: [], learningReviewRecords: [{ schemaVersion: 1, id: restatement.recordId, sessionId: restatement.sessionId,
    projectNoteId: 'project', rootProjectId: 'root', startedAt: at, endedAt: at, title: '本次复述', userEditedTitle: false,
    rawRestatement: restatement.text, editedRestatement: restatement.text, userEditedRestatement: false, summary: 'AI SUMMARY MUST NOT BECOME BELIEF',
    argumentDocIds: [], episodeId: restatement.sessionId, status: 'text_only', createdAt: at, updatedAt: at }] };
assert.equal(savedRestatementObservations([note])[0].text, restatement.text);
assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [{ ...note.learningReviewRecords![0], editedRestatement: '' }] }])[0].text, '');
assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [{ ...note.learningReviewRecords![0], editedRestatement: '## 复盘 · 2026-10-20 09:00' }] }])[0].text, '');
assert.equal(savedRestatementObservations([{ ...note, noteType: 'knowledge' }]).length, 0);
assert.equal(savedRestatementObservations([{ ...note, learningReviewRecords: [{ ...note.learningReviewRecords![0], projectNoteId: 'other' }] }]).length, 0);
const long = apply(emptyCognitionFile(), restate({ ...restatement, text: '用户复述的原话。'.repeat(4000) }));
assert.equal(latestCognition(long.records[0]).branches[0].graph.nodes.map(node => node.text).join(''), '用户复述的原话。'.repeat(4000));
assert.doesNotMatch(JSON.stringify(savedRestatementObservations([note])), /GENERATED|AI SUMMARY/);
pass('only saved review-restatement fields admitted, exact empty edits and boilerplate respected, long original preserved without model-generated graph promotion');

for (const query of ['你能查看我的认知RAG库吗', '查看我的认知 RAG 库', '查看我的个人RAG库', '查看我的认知检索库']) {
  assert.ok(wantsCognitionRecall(query)); assert.equal(selectAgentSkill(query)?.id, 'personalized-qa');
  const overview = buildInquirySnapshot(file, query); assert.equal(overview.mode, 'overview'); assert.equal(overview.counts.selectedNodes, 2, query);
}
assert.equal(wantsCognitionRecall('解释 RAG 检索原理'), false);
const topic = buildInquirySnapshot(file, '查看我的认知RAG库中关于心理账户的理解');
assert.equal(topic.counts.selectedNodes, 1);
assert.throws(() => parseCognitionFile({ ...file, suppressedSourceIds: [42] }), /遗忘回执/);
pass('screenshot query and corpus-name variants select overview, real topic filtering remains intact, ordinary RAG QA stays separate');

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-auto-'));
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), originalFetch = globalThis.fetch;
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });
globalThis.fetch = async () => assert.fail('No network/model calls in automatic cognition checks');
try {
  const directory = path.join(temporary, 'real-store');
  await Promise.all([mutateCognition(directory, review()), mutateCognition(directory, review())]);
  let stored = await loadCognition(directory); assert.equal(stored.records.length, 1); assert.equal(stored.revision, 1);
  await mutateCognition(directory, restate()); stored = await loadCognition(directory);
  assert.equal(stored.records.length, 2); assert.ok(retrieveCurrentCognition(stored, '独立').items.length);
  const encode = async (_text: string) => [1, ...Array(383).fill(0)];
  const vector = await searchPersonalCognition(directory, '心理账户', encode);
  assert.equal(vector.method, 'local-hybrid-v1'); assert.ok(vector.items.some(hit => hit.sourceKind === 'review_answer'));
  await mutateCognition(directory, restate({ ...restatement, text: '', updatedAt: '2026-10-20T05:00:00Z' }));
  const current = await searchPersonalCognition(directory, '独立', encode);
  assert.equal(current.items.some(hit => hit.recordId === id), false);
  const pendingDir = path.join(temporary, 'legacy');
  await mutateCognition(pendingDir, { kind: 'capture_review', enabled: true, observations: [observation] });
  await Promise.all([loadCognition(pendingDir), loadCognition(pendingDir)]);
  const upgradedDisk = await loadCognition(pendingDir); assert.equal(upgradedDisk.records.length, 1); assert.equal(upgradedDisk.revision, 2);
  pass('real atomic private store/concurrent replay/legacy upgrade and derived hybrid cache work without live model inference');

  await fs.rm(path.join(directory, COGNITION_INDEX_FILE_NAME), { force: true });
  await fs.mkdir(path.join(directory, COGNITION_INDEX_FILE_NAME)); // An invalid derived-cache target must not cause a source overwrite.
  const before = await fs.readFile(path.join(directory, COGNITION_FILE_NAME), 'utf8');
  await assert.rejects(mutateCognition(directory, review([{ ...observation, messageId: 'answer-2' }])));
  assert.equal(await fs.readFile(path.join(directory, COGNITION_FILE_NAME), 'utf8'), before);
  await fs.rmdir(path.join(directory, COGNITION_INDEX_FILE_NAME));
  await mutateCognition(directory, review([{ ...observation, messageId: 'answer-2' }]));
  assert.equal((await loadCognition(directory)).records.length, 3);
  pass('persistence failure retains previous source; retry succeeds once without losing old cognition');

  let scope = 'scope-a', fail = false, writes = 0, changeOnVaultRead = false;
  const nativeDir = path.join(temporary, 'bridge');
  const bridge = Object.assign(new EventTarget(), { electronAPI: { vault: { loadVault: async () => { if (changeOnVaultRead) scope = 'scope-b'; return [note]; } }, userState: {
    getAgentTaskScope: async () => scope, loadCognition: async () => loadCognition(nativeDir),
    mutateCognition: async (input: CognitionMutation) => {
      if ('storageScopeId' in input && input.storageScopeId !== scope) throw new Error('scope changed');
      if (fail) throw new Error('synthetic disk failure'); writes++; return mutateCognition(nativeDir, input);
    }, searchCognition: async (query: string) => retrieveCurrentCognition(await loadCognition(nativeDir), query),
  } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: bridge });
  fail = true; await assert.rejects(captureReviewCognition(episode, { id: note.id, title: note.title }), /disk failure/);
  assert.equal((await loadCognition(nativeDir)).records.length, 0);
  fail = false; await captureReviewCognition(episode, { id: note.id, title: note.title }); await captureReviewCognition(episode, { id: note.id, title: note.title });
  assert.equal((await loadCognition(nativeDir)).records.length, 1);
  await captureRestatementCognition(note, restatement.recordId); assert.equal((await loadCognition(nativeDir)).records.length, 2);
  const recall = await searchCurrentPersonalCognition('概率论独立事件'); assert.ok(recall.items.some(hit => hit.sourceKind === 'restatement'));
  const sourceBefore = await fs.readFile(path.join(nativeDir, COGNITION_FILE_NAME), 'utf8');
  await searchCurrentPersonalCognition('概率论独立事件'); assert.equal(await fs.readFile(path.join(nativeDir, COGNITION_FILE_NAME), 'utf8'), sourceBefore);
  changeOnVaultRead = true; const writesBefore = writes;
  await assert.rejects(searchCurrentPersonalCognition('概率论'), /资料库已切换/); assert.equal(writes, writesBefore);
  changeOnVaultRead = false; scope = 'scope-a';
  pass('real renderer capture is automatic by default; native failures propagate, saved restatements backfill, reads do not rewrite unchanged sources or cross roots');

  const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '你能查看我的认知RAG库吗', history: [], enableMultiAgent: false,
    ctx: { getNotes: () => [note], getActiveNote: () => note, getPlanDraftSession: () => null, getResourceDraftSession: () => null,
      ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext, memoryPrefixLoader: async () => '',
    callLlm: async request => {
      if (request.workflow === 'agent-intent-routing') return { content: '', parsedJson: { skillId: 'personalized-qa', confidence: 0.99, standaloneRequest: '查看我的认知库', referenceResolution: 'none' } };
      const input = JSON.parse(request.userInput!), source = input.pages[0].sources[0];
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: `你的认知库已经记录了以下理解：${source.text}`, evidence: [{ id: source.id, quote: source.text }] }] } };
    } });
  assert.equal(result.pendingApproval, undefined); assert.ok(result.toolTrace.some(step => step.call.name === 'read_cognition_page'));
  assert.doesNotMatch(result.reply, /没有找到|没有已确认记录|确认保存/);
  assert.ok(result.updatedHistory.at(-1)?.cognitionReferences?.length);
  pass('actual Agent screenshot wording → overview → automatic user belief → checked answer/source pointers, no confirmation or fake empty result');

  const appFile = readFileSync('src/App.tsx', 'utf8'), ast = ts.createSourceFile('App.tsx', appFile, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let patchHandler: ts.Expression | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleLearningReviewPatch') patchHandler = node.initializer; ts.forEachChild(node, visit); }; visit(ast); assert.ok(patchHandler);
  let noteSaved = false, captured = false, shouldFail = false;
  const compiled = ts.transpileModule(`const handler = ${patchHandler.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const handler = new Function('persistLearningMutation', 'patchLearningReviewRecord', 'notesRef', 'captureRestatementCognition', `${compiled}\nreturn handler;`)(
    async () => { if (shouldFail) throw new Error('note save failed'); noteSaved = true; }, () => note, { current: [note] }, async () => { assert.ok(noteSaved); captured = true; });
  await handler(note.id, restatement.recordId, { editedRestatement: '新复述' }); assert.ok(captured);
  captured = false; noteSaved = false; shouldFail = true; await assert.rejects(handler(note.id, restatement.recordId, { editedRestatement: '未保存内容' }), /note save failed/); assert.equal(captured, false);
  assert.ok(appFile.indexOf('await captureRestatementCognition(savedRestatementNote') > appFile.indexOf('const savedRestatementNote'));
  const panel = readFileSync('src/components/PersonalCognitionPanel.tsx', 'utf8'), reviewUi = readFileSync('src/components/ReviewChat.tsx', 'utf8');
  assert.doesNotMatch(panel, /checked=\{confirmed\}|!confirmed/); assert.match(panel, /保存到个人认知库/);
  assert.doesNotMatch(reviewUi, /setCollectCognition|checked=\{collectCognition\}/); assert.match(reviewUi, /无需再次确认/);
  pass('actual App source-before-cognition ordering; failed note save cannot admit unsaved restatement; UI confirmation/opt-in gates removed');
} finally {
  globalThis.fetch = originalFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else Reflect.deleteProperty(globalThis, 'localStorage');
  assert.equal(path.dirname(temporary), os.tmpdir()); assert.ok(path.basename(temporary).startsWith('loginote-cognition-auto-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`Automatic personal cognition: ${groups} groups passed; synthetic private stores/Agent/renderer only, no real vault, model or network.`);
