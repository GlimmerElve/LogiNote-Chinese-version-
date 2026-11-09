/** Actual native queue, saved model-result fixtures and private files. No live model/network/library. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { ProgressiveReviewWorker } from '../src/services/progressiveLearning/reviewWorker';
import { analyzeProgressivePart } from '../src/services/progressiveLearning/reviewAnalysis';
import { progressiveReviewModelReply } from './fixtures/progressive-phase4';
import { loadCognition, mutateCognition, withCognitionFile } from '../src/electron/cognitionStore';
import { latestCognition } from '../src/services/cognition/core';
import type { NoteItem } from '../src/types';
import type { ProgressiveReviewRecord, ProgressiveReviewGraphReply } from '../src/services/progressiveLearning/reviewTypes';

globalThis.fetch = async () => assert.fail('No network or real model in confirmation checks');
const output = await fs.mkdtemp(path.resolve('build/progressive-cognition-confirmation-'));
let groups = 0;
const pass = (text: string) => { groups++; console.log('PASS ' + text); };
const raw = '我认为时间接近和刺激相似是两个需要分别控制的变量。一次观察只能支持限定条件下的结论，不能推广到所有情况。';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function harness(name: string) {
  const directory = path.join(output, name), projectId = 'synthetic-' + name, at = new Date().toISOString();
  let notes: NoteItem[] = [{ id: projectId, title: '合成论证确认课程', noteType: 'project', projectRole: 'learning', content: '# 合成目标',
    tags: [], links: [], backlinks: [], createdAt: at, updatedAt: at, dueDates: [{ id: 'deadline', noteId: projectId,
      noteTitle: '合成论证确认课程', taskText: '合成论证确认课程', dueDate: '2026-11-08', completed: false, priority: 'medium' }] }];
  let current = true, calls = 0, writes = 0, profiles = 0, failWrites = 0;
  let writeGate: ReturnType<typeof deferred> | undefined, writeEntered: ReturnType<typeof deferred> | undefined;
  const dependencies = { isCurrent: () => current, readTarget: async () => ({ note: notes[0], root: notes[0], isLeaf: true }),
    writeCognition: async (input: any) => {
      writes++; if (failWrites) { failWrites--; throw Error('synthetic cognition refusal'); }
      if (writeGate) { const gate = writeGate; writeGate = undefined; writeEntered!.resolve(); await gate.promise; }
      return mutateCognition(directory, input, () => current);
    } };
  let store = new ProgressiveLearningStore(directory, dependencies);
  const command = <T = any>(input: any): Promise<T> => store.command(input, 84) as Promise<T>;
  const load = () => command<any>({ op: 'load', projectNoteId: projectId });
  const begin = await command<any>({ op: 'begin', projectNoteId: projectId });
  await command({ op: 'publish', lease: begin.lease, teaching: { sequence: begin.course.generation.sequence + 1,
    plan: { title: '合成主线', objectives: ['区分变量'], pages: [{ id: 'main-1', title: '实验控制', objectives: ['区分变量'] }] },
    title: '实验控制', body: '# 合成教材不进入个人认知\n\n' + raw.repeat(8), concepts: [], questions: [],
    hook: { id: 'hook', kind: 'reflection', prompt: '说说你的认识。' } } });
  let course = await load();
  await command({ op: 'save-progress', projectNoteId: projectId, progress: { environmentId: course.environmentId,
    courseId: course.id, expectedProgressVersion: course.progress.version, patch: { restatementDraft: raw,
      restatementSpans: [{ pageId: 'main-1', start: 0, end: raw.length }] } } });
  course = await load();
  const exit = await command<any>({ op: 'review-exit', projectNoteId: projectId, environmentId: course.environmentId,
    courseId: course.id, exitId: 'exit', analyze: true, expectedProgressVersion: course.progress.version });
  await command({ op: 'review-activate', projectNoteId: projectId, environmentId: course.environmentId, courseId: course.id, exitId: 'exit' });
  const read = () => command<ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: projectId, reviewId: exit.record.id });
  const graph = () => command<ProgressiveReviewGraphReply>({ op: 'review-graph-read', projectNoteId: projectId, reviewId: exit.record.id, partId: 'part-1' });
  const run = async () => {
    const worker = new ProgressiveReviewWorker({ command, loadCourse: load, readNotes: () => notes,
      persist: async prepare => { notes = prepare(notes); }, profile: async () => { profiles++; },
      analyze: packet => analyzeProgressivePart(packet, { call: async request => {
        calls++; const input = JSON.parse(request.userInput), reply: any = progressiveReviewModelReply(input);
        if (!input.graph) {
          reply.graph.nodes = [{ id: 'N1', role: 'claim', text: input.rawText.slice(0, 25), rawQuote: input.rawText.slice(0, 25) },
            { id: 'N2', role: 'premise', text: input.rawText.slice(-25), rawQuote: input.rawText.slice(-25) }];
          reply.graph.arguments = [{ id: 'A1', claim: 'N1', support: ['N2'], oppose: [], status: 'argued' }];
        }
        return { content: JSON.stringify(reply) };
      } }), onError: error => { throw error; } });
    worker.kick(projectId); await worker.idle(); worker.stop(); return read();
  };
  const confirmInput = (record: ProgressiveReviewRecord) => ({ op: 'review-cognition-confirm', projectNoteId: projectId,
    reviewId: record.id, environmentId: course.environmentId, courseId: course.id, expectedVersion: record.version, confirmed: true });
  const saveInput = (snapshot: ProgressiveReviewGraphReply, doc = snapshot.doc) => ({ op: 'review-graph-save', projectNoteId: projectId,
    reviewId: snapshot.record.id, partId: 'part-1', environmentId: course.environmentId, courseId: course.id,
    expectedVersion: snapshot.record.version, expectedGraphHash: snapshot.graphHash, doc });
  const edit = async (text: string) => { const record = await read(); return command({ op: 'review-edit', projectNoteId: projectId,
    reviewId: record.id, expectedVersion: record.version, text }); };
  return { command, read, graph, run, confirmInput, saveInput, edit, directory, projectId,
    cognition: () => loadCognition(directory), fail() { failWrites++; },
    restart() { store.releaseOwner(84); store = new ProgressiveLearningStore(directory, dependencies); },
    holdWrite() { writeGate = deferred(); writeEntered = deferred(); return { entered: writeEntered.promise, release: writeGate.resolve }; },
    switchEnvironment() { current = false; },
    failReceipt() { const host = (store as any).reviews.host, save = host.save; let fail = true;
      host.save = async (...args: any[]) => { if (fail) { fail = false; throw Error('synthetic final receipt refusal'); } return save(...args); }; },
    get calls() { return calls; }, get writes() { return writes; }, get profiles() { return profiles; } };
}

const h = await harness('primary');
let record = await h.run();
assert.equal(record.status, 'analyzed'); assert.equal(record.auxiliary, 'ready'); assert.equal(record.cognitionVersion, undefined);
assert.equal(h.writes, 0); assert.equal((await h.cognition()).records.length, 0); assert.equal(h.profiles, 1);
assert.equal((await h.command<any[]>({ op: 'review-work', projectNoteIds: [h.projectId] })).length, 0);
const calls = h.calls; h.restart(); await h.run(); assert.equal(h.calls, calls); assert.equal(h.writes, 0);
pass('analysis, profile and completion settle independently; unconfirmed sources do not ingest or loop after restart');

let snapshot = await h.graph();
const originalBundle = await h.command({ op: 'review-read', projectNoteId: h.projectId, reviewId: record.id, partId: 'part-1' });
const originalBytes = JSON.stringify(originalBundle), originalHash = record.chunks[0].resultHash;
const edited = structuredClone(snapshot.doc); edited.nodes[0].text = '用户核对：只在控制条件不变时成立。'; edited.nodes[0].role = 'claim';
snapshot = await h.command(h.saveInput(snapshot, edited));
assert.equal(snapshot.record.cognitionConfirmation?.status, 'pending'); assert.equal(h.writes, 0);
h.restart(); assert.equal((await h.graph()).doc.nodes[0].text, edited.nodes[0].text);
assert.equal(JSON.stringify(await h.command({ op: 'review-read', projectNoteId: h.projectId, reviewId: record.id, partId: 'part-1' })), originalBytes);
assert.equal((await h.read()).chunks[0].resultHash, originalHash); assert.equal((await h.read()).rawText, raw);
pass('edited graph drafts survive restart without overwriting raw source, original analysis, scores or result blob');

await assert.rejects(h.command(h.saveInput({ ...snapshot, graphHash: '0'.repeat(64) })), /已更新/);
await assert.rejects(h.command({ ...h.confirmInput(snapshot.record), environmentId: 'foreign' }), /环境/);
const invalid = structuredClone(snapshot.doc); invalid.edges[0].target = 'missing';
await assert.rejects(h.command(h.saveInput(snapshot, invalid)), /端点/);
assert.equal(h.writes, 0);
pass('stale graph hash, foreign environment and dangling graph references fail before private writes');

record = (await h.command(h.confirmInput(snapshot.record))).record;
assert.equal(record.cognitionConfirmation?.status, 'confirmed'); assert.equal(record.cognitionVersion, 1);
let file = await h.cognition(); assert.equal(file.records.length, 1);
assert.equal(latestCognition(file.records[0]).branches[0].graph.nodes[0].text, edited.nodes[0].text);
assert.equal(latestCognition(file.records[0]).branches[0].graph.edges[0].source, snapshot.doc.edges[0].source);
const confirmedBytes = JSON.stringify(file), confirmedVersion = record.version;
await h.command(h.confirmInput(snapshot.record));
assert.equal((await h.read()).version, confirmedVersion); assert.equal(JSON.stringify(await h.cognition()), confirmedBytes);
pass('one explicit confirmation commits the saved edited graph; repeated confirmation is revision/byte idempotent');

snapshot = await h.graph(); const next = structuredClone(snapshot.doc); next.nodes[0].text += ' 同时限制样本范围。';
snapshot = await h.command(h.saveInput(snapshot, next));
assert.equal(snapshot.record.cognitionConfirmation?.status, 'pending'); assert.equal(JSON.stringify(await h.cognition()), confirmedBytes);
await h.command(h.confirmInput(snapshot.record)); file = await h.cognition();
assert.equal(file.records.length, 1); assert.equal(file.records[0].revisions.length, 2);
pass('later edits remain drafts until reconfirmed, retaining the prior belief and stable source identity');

const failing = await harness('failure'); await failing.run(); record = await failing.read(); const request = failing.confirmInput(record);
failing.fail(); await assert.rejects(failing.command(request), /cognition refusal/);
assert.notEqual((await failing.read()).cognitionConfirmation?.status, 'confirmed'); assert.equal((await failing.cognition()).records.length, 0);
failing.failReceipt(); await assert.rejects(failing.command(request), /receipt refusal/);
assert.equal((await failing.cognition()).records.length, 1); failing.restart();
await failing.command(request); assert.equal((await failing.cognition()).records[0].revisions.length, 1); assert.equal(failing.calls, 2);
pass('private write failure and lost final receipt remain explicitly retriable across restart without duplicate beliefs/models');

const race = await harness('race'); await race.run(); record = await race.read();
const hold = race.holdWrite(), commit = race.command(race.confirmInput(record)); await hold.entered;
let cleared = false; const clear = race.edit('').then(() => { cleared = true; });
await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(cleared, false);
hold.release(); await commit; await clear; assert.ok((await race.cognition()).records.every(row => row.withdrawn));
await assert.rejects(race.command(race.confirmInput(await race.read())), /清空/);
pass('the real native queue orders confirmation before a concurrent clear; no late confirmation resurrects the source');

const withdrawal = await harness('withdrawal'); await withdrawal.run(); await withdrawal.command(withdrawal.confirmInput(await withdrawal.read()));
withdrawal.fail(); await assert.rejects(withdrawal.edit(''), /cognition refusal/); assert.equal((await withdrawal.read()).cognitionWithdrawalPending, true);
withdrawal.restart(); await withdrawal.run(); assert.ok((await withdrawal.cognition()).records.every(row => row.withdrawn));
assert.equal((await withdrawal.read()).cognitionWithdrawalPending, false); assert.equal(withdrawal.calls, 2);
pass('failed source withdrawal has its own recovery journal and restarts without new cognition adoption or model analysis');

file = await h.cognition(); const kept = file.records[0], revision = latestCognition(kept);
await mutateCognition(h.directory, { kind: 'edit_graph', expectedRevision: file.revision, confirmed: true,
  edit: { action: 'update_node', target: { recordId: kept.id, revisionId: revision.id, branchId: 'primary', nodeId: revision.branches[0].graph.nodes[0].id },
    text: '用户在认知库中的手工修订优先。', role: 'claim', stance: 'endorsed', operation: 'revise', reason: '合成保护回归' } });
await assert.rejects(h.command(h.confirmInput(await h.read())), /手工调整|手工修订/);
assert.equal(latestCognition((await h.cognition()).records[0]).branches[0].graph.nodes[0].text, '用户在认知库中的手工修订优先。');
file = await h.cognition(); await mutateCognition(h.directory, { kind: 'forget', expectedRevision: file.revision, confirmed: true, recordId: kept.id });
await assert.rejects(h.command(h.confirmInput(await h.read())), /遗忘/); assert.equal((await h.cognition()).records.length, 0);
pass('manual cognition revisions and forgotten sources remain protected; no-op private writes cannot pretend confirmation succeeded');

const foreign = await harness('foreign'); await foreign.run(); record = await foreign.read(); const foreignHold = foreign.holdWrite();
const late = foreign.command(foreign.confirmInput(record)); await foreignHold.entered; foreign.switchEnvironment(); foreignHold.release();
await assert.rejects(late, /环境/); assert.equal((await loadCognition(foreign.directory)).records.length, 0);
pass('environment identity is checked again inside the private commit, blocking late cross-scope confirmations');

const removed = await harness('removed-nodes'); await removed.run(); await removed.command(removed.confirmInput(await removed.read()));
let empty = await removed.graph(); empty = await removed.command(removed.saveInput(empty, { ...empty.doc, nodes: [], edges: [] }));
assert.ok((await removed.cognition()).records.every(row => !row.withdrawn));
await removed.command(removed.confirmInput(empty.record));
assert.ok((await removed.cognition()).records.every(row => row.withdrawn));
assert.equal((await removed.cognition()).records[0].revisions.length, 1);
pass('confirming an intentionally emptied graph withdraws current automatic nodes instead of synthesizing a raw-text replacement block');

console.log(JSON.stringify({ status: 'passed-offline', groups, output, networkCalls: 0,
  boundary: 'actual course queue/authority and private files with deterministic model fixtures; no live model, user library or semantic quality claim' }, null, 2));
