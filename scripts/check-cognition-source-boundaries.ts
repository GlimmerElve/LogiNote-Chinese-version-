import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type { NoteItem, UserNoteState } from '../src/types';
import { currentCognitionFixture } from './fixtures/cognition-current-structure';
import { splitSharableFields, splitUserStateFields, mergeNote, mergeLegacyNoteState, hasAnyUserState, serializeUserStateFile, deserializeUserStateFile, USER_STATE_FILES } from '../src/services/userStateService';
import { serializeMetadata, deserializeVault, markdownFileName } from '../src/services/vaultFsService';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { savedRestatementObservations } from '../src/services/cognition/restatements';
import { applyCognitionMutation, emptyCognitionFile, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { buildInquirySnapshot, INQUIRY_PROMPT, type InquirySnapshot } from '../src/services/cognition/inquiry';
import { runCognitionInquiry } from '../src/services/agent/cognitionInquiry';
import type { CognitionFile } from '../src/services/cognition/types';
import type { FlowArgumentStructure } from '../src/services/argumentDoc/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';

let passed = 0;
const pass = (label: string) => { passed++; console.log(`PASS ${label}`); };
const fixture = currentCognitionFixture(), { note, bundle } = fixture;
const source = bundle.argumentDoc.flowStructure!, phrase = source.nodes.find(n => n.id === 'N4')!.text;
const editedDoc = { ...bundle.argumentDoc, nodes: bundle.argumentDoc.nodes.filter(n => n.id !== 'N4'),
  edges: bundle.argumentDoc.edges.filter(e => e.source !== 'N4' && e.target !== 'N4') };
const edited = { ...note, argumentDocs: [editedDoc] }, original = JSON.stringify(edited);
const share = splitSharableFields(edited), privateState = splitUserStateFields(edited);
assert.equal(JSON.stringify(share).includes(phrase), false);
assert.equal(serializeMetadata([edited]).includes(phrase), false);
assert.equal(Object.hasOwn(share.argumentDocs![0], 'flowStructure'), false);
assert.equal(hasAnyUserState({ argumentFlowStructures: privateState.argumentFlowStructures }), true);
assert.deepEqual(privateState.argumentFlowStructures![editedDoc.doc_id], source);
assert.equal(JSON.stringify(edited), original, 'export never mutates the live doc');
const restored = mergeNote(share, deserializeUserStateFile(serializeUserStateFile({ [note.id]: privateState }))[note.id]);
assert.deepEqual(restored.argumentDocs![0].flowStructure, source);
assert.deepEqual(savedRestatementObservations([restored])[0].graph!.structure.flowStructure, source);
assert.equal(mergeNote(share).argumentDocs![0].flowStructure, undefined, 'share recipients have no source snapshot');
assert.equal(mergeNote(edited, { argumentFlowStructures: {} }).argumentDocs![0].flowStructure, undefined, 'explicit private removal cannot revive legacy inline snapshots');
assert.equal(splitUserStateFields(mergeNote({ ...share, argumentDocs: [] }, privateState)).argumentFlowStructures, undefined);
pass('deleted node words cannot enter sharable metadata; private split/merge retains exact source without mutation, orphan restoration or resurrection');

const newer = { pinned: true, color: 'new', learningReviewRecords: [{ ...note.learningReviewRecords![0], title: '较新的个人标题' }] };
const migrated = mergeLegacyNoteState({ ...privateState, pinned: false, color: 'old' }, newer);
assert.equal(migrated.pinned, true); assert.equal(migrated.color, 'new');
assert.equal(migrated.learningReviewRecords![0].title, '较新的个人标题');
assert.deepEqual(migrated.argumentFlowStructures, privateState.argumentFlowStructures);
assert.deepEqual(mergeLegacyNoteState(privateState, { argumentFlowStructures: {} }).argumentFlowStructures, {});
assert.throws(() => mergeNote(share, { argumentFlowStructures: [] as never }));
pass('legacy inline-source migration preserves newer personal records and explicit empty maps, rejecting malformed private structure containers');

// Exercise the actual main-process reader without importing Electron or touching a vault.
const mainAst = ts.createSourceFile('main.ts', await fs.readFile('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
const reader = mainAst.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'loadMergedNotes');
assert.ok(reader, 'main-process migration reader must exist');
const readerCode = ts.transpileModule(`${reader.getText(mainAst)}\nreturn loadMergedNotes;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function migrationHarness(notes: NoteItem[], states?: Record<string, UserNoteState>) {
  const root = path.resolve('synthetic-vault'), stateDir = path.resolve('synthetic-private');
  const metadataPath = path.join(root, 'metadata.json'), privatePath = path.join(stateDir, USER_STATE_FILES.noteStates);
  const disk = new Map<string, string>([
    [metadataPath, JSON.stringify({ version: 1, notesMeta: Object.fromEntries(notes.map(({ content: _body, ...n }) => [n.id, n])) })],
    ...notes.map((n): [string, string] => [path.join(root, 'notes', markdownFileName(n.id)), n.content]),
    ...(states === undefined ? [] : [[privatePath, serializeUserStateFile(states)] as [string, string]]),
  ]);
  const originalDisk = new Map(disk), writes: string[] = [], faults: { target?: 'private' | 'metadata' } = {};
  const write = async (file: string, text: string, target: 'private' | 'metadata') => {
    assert.equal(file, target === 'private' ? privatePath : metadataPath);
    if (faults.target === target) throw new Error(`synthetic ${target} write failure`);
    writes.push(target); disk.set(file, text);
  };
  const env = {
    referenceEnvironmentSuspended: false, referenceSourceWriteEpoch: 1,
    getVaultRoot: () => root, getUserStateDir: () => stateDir, path,
    withSavedVaultSnapshot: async (_root: string, _state: string, action: () => Promise<NoteItem[]>, isCurrent: () => boolean) => {
      assert.ok(isCurrent()); return action();
    },
    fs: {
      mkdir: async () => {},
      readdir: async (directory: string) => { assert.equal(directory, path.join(root, 'notes')); return notes.map(n => markdownFileName(n.id)); },
      readFile: async (file: string) => {
        const text = disk.get(file);
        if (text === undefined) throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' });
        return text;
      },
    },
    deserializeVault, splitUserStateFields, hasAnyUserState, deserializeUserStateFile, mergeLegacyNoteState,
    splitSharableFields, mergeNote, serializeUserStateFile, serializeMetadata, USER_STATE_FILES,
    writeUserStateFileUnlocked: async (directory: string, name: string, text: string) => write(path.join(directory, name), text, 'private'),
    atomicWriteTextFile: async (file: string, text: string) => write(file, text, 'metadata'),
  };
  const load = new Function(...Object.keys(env), readerCode)(...Object.values(env)) as () => Promise<NoteItem[]>;
  return { load, disk, originalDisk, writes, faults, metadataPath, privatePath };
}
// Put the invalid snapshot on the last note: validating just one migrated note is not sufficient.
const laterNote = { ...edited, id: 'synthetic-later-project' };
const dangling = structuredClone(source); dangling.arguments[0].claim = 'missing-source-node';
for (const structures of [[], null, { [editedDoc.doc_id]: { version: 2 } }, { [editedDoc.doc_id]: dangling }]) {
  const h = migrationHarness([edited, laterNote], { [laterNote.id]: { argumentFlowStructures: structures as never } });
  await assert.rejects(h.load(), /结构/);
  assert.deepEqual(h.writes, [], 'validation failure must precede every migration file write');
  assert.deepEqual(h.disk, h.originalDisk, 'both original files and Markdown must remain byte-for-byte unchanged');
}
pass('actual main-process migration validates every merged snapshot before writes; malformed maps, unsupported versions and dangling endpoints preserve all original bytes');

const newerSource = structuredClone(source); newerSource.nodes[0].rawQuote = 'newer private source excerpt';
const existingStates: Array<Record<string, UserNoteState> | undefined> = [undefined,
  { [edited.id]: { ...newer, argumentFlowStructures: { [editedDoc.doc_id]: newerSource } } },
  { [edited.id]: { argumentFlowStructures: {} } }];
for (const existing of existingStates) {
  const h = migrationHarness([edited], existing);
  const loaded = await h.load();
  assert.deepEqual(h.writes, ['private', 'metadata']);
  assert.deepEqual(loaded[0].argumentDocs![0].flowStructure, existing === undefined ? source : existing[edited.id].argumentFlowStructures![editedDoc.doc_id]);
  if (existing?.[edited.id].pinned !== undefined) assert.equal(loaded[0].pinned, true);
  assert.equal(JSON.parse(h.disk.get(h.metadataPath)!).notesMeta[edited.id].argumentDocs[0].flowStructure, undefined);
  const stableDisk = new Map(h.disk);
  assert.deepEqual(await h.load(), loaded);
  assert.deepEqual(h.writes, ['private', 'metadata'], 'successful migration must not repeat on reload');
  assert.deepEqual(h.disk, stableDisk);
}
for (const target of ['private', 'metadata'] as const) {
  const h = migrationHarness([edited]); h.faults.target = target;
  await assert.rejects(h.load(), new RegExp(`synthetic ${target} write failure`));
  assert.equal(h.disk.get(h.metadataPath), h.originalDisk.get(h.metadataPath), 'a write failure cannot remove the valid legacy copy');
  if (target === 'private') assert.deepEqual(h.disk, h.originalDisk);
  else assert.deepEqual(JSON.parse(h.disk.get(h.privatePath)!).noteStates[edited.id].argumentFlowStructures[editedDoc.doc_id], source);
  h.faults.target = undefined;
  assert.deepEqual((await h.load())[0].argumentDocs![0].flowStructure, source);
}
pass('actual main-process migration retains newer/explicit-empty private state, is reload-idempotent and keeps a valid source across write failures and retry');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-source-boundary-'));
try {
  const vault = path.join(directory, 'vault'), state = path.join(directory, 'user-state');
  await assert.rejects(saveVaultSnapshot(vault, state, [edited], async (file, text) => {
    if (file === path.join(vault, 'metadata.json')) throw new Error('synthetic metadata failure');
    await atomicWriteTextFile(file, text);
  }), /synthetic metadata failure/);
  await recoverVaultSnapshot(vault, state);
  const metadata = await fs.readFile(path.join(vault, 'metadata.json'), 'utf8');
  const privateText = await fs.readFile(path.join(state, 'user-state.json'), 'utf8');
  assert.equal(metadata.includes(phrase), false); assert.equal(privateText.includes(phrase), true);
  const body = await fs.readFile(path.join(vault, 'notes', markdownFileName(note.id)), 'utf8');
  const loaded = deserializeVault(metadata, new Map([[markdownFileName(note.id), body]]))
    .map(n => mergeNote(n, deserializeUserStateFile(privateText)[n.id]));
  assert.deepEqual(loaded[0].argumentDocs![0].flowStructure, source);
  assert.equal(serializeMetadata(loaded).includes(phrase), false);
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('loginote-source-boundary-'));
  await fs.rm(directory, { recursive: true, force: true });
}
pass('actual atomic vault transaction and journal recovery separate private source from shared files and restore it after reload');

const allChunks = (snapshot: InquirySnapshot) => snapshot.pages.flatMap(p => p.analysisStructures || []);
const joint = buildInquirySnapshot(fixture.file, '查看我的认知库');
const independent = structuredClone(fixture.file), originalGraph = independent.records[0].revisions[0].branches[0].graph;
const group = originalGraph.flowStructure!.arguments.find(a => a.claim === 'N6')!;
originalGraph.flowStructure!.arguments = originalGraph.flowStructure!.arguments.flatMap(a => a.id !== group.id ? [a]
  : group.support.map((id, index) => ({ ...a, id: `independent-${index}`, support: [id] })));
parseCognitionFile(independent);
const separate = buildInquirySnapshot(independent, '查看我的认知库');
assert.notDeepEqual(joint, separate);
assert.equal(allChunks(joint).flatMap(c => c.arguments).find(a => a.claim === 'N6')!.support.length, 3);
assert.equal(allChunks(separate).flatMap(c => c.arguments).filter(a => a.claim === 'N6').length, 3);
assert.ok(allChunks(joint).some(c => c.unresolved.length));
assert.ok(joint.pages[0].sources.every(s => s.analysisStructure?.state === 'current'));
assert.equal(joint.pages[0].sources[0].analysisStructure!.detailPages!.start, 1);
assert.match(INQUIRY_PROMPT, /support 数组共同构成依据/u);
assert.match(INQUIRY_PROMPT, /source_only/u);
assert.equal(JSON.stringify(allChunks(joint)).includes('"rawQuote"'), false);
const filteredFile = structuredClone(fixture.file);
filteredFile.records[0].revisions[0].branches[0].graph.nodes.find(n => n.id === 'N4')!.stance = 'tentative';
const filtered = buildInquirySnapshot(filteredFile, '我认同哪些观点');
assert.equal(filtered.pages.flatMap(p => p.sources).some(s => s.reference?.nodeId === 'N4'), false);
const filteredGroup = allChunks(filtered).find(c => c.arguments.some(a => a.claim === 'N6'))!;
assert.equal(filteredGroup.memberTextsTruncated, true);
assert.ok(filteredGroup.memberSourcesTotal! > filteredGroup.memberSourcesAvailable!);
pass('general inquiry distinguishes joint versus separate support and transports extraction status/unresolved state without raw snapshots or new tools');

const current = latestCognition(fixture.file.records[0]);
const changed = applyCognitionMutation(fixture.file, { kind: 'edit_graph', confirmed: true, expectedRevision: fixture.file.revision,
  edit: { action: 'update_node', target: { recordId: fixture.file.records[0].id, revisionId: current.id, branchId: 'primary', nodeId: 'N6' },
    text: current.branches[0].graph.nodes.find(n => n.id === 'N6')!.text, role: 'premise', stance: 'endorsed', operation: 'revise', reason: '明确调整角色' } },
  { id: 'role-change', at: '2026-10-21T01:00:00Z' });
const history = buildInquirySnapshot(changed, '我的认知发生了哪些变化');
assert.ok(allChunks(history).some(c => c.header.current && c.header.state === 'source_only'));
assert.ok(allChunks(history).some(c => !c.header.current && c.header.state === 'current'));
assert.ok(history.pages.filter(p => p.analysisStructures).every(p => p.sources.every(s => {
  const header = p.analysisStructures![0].header;
  return s.reference?.recordId === header.recordId && s.reference?.revisionId === header.revisionId && s.reference?.branchId === header.branchId;
})));
pass('history and current/source-only extraction remain independently scoped to exact record, revision and branch');

const ids = Array.from({ length: 40 }, (_, i) => `N${i}${'\\"\u0001'.repeat(38)}`);
const denseSource: FlowArgumentStructure = { version: 1,
  nodes: ids.map((id, index) => ({ id, role: index ? 'premise' : 'claim', text: `合成节点 ${index} 的认识`, rawQuote: '' })),
  arguments: Array.from({ length: 30 }, (_, i) => ({ id: `A${i}`, claim: ids[0], support: ids.slice(1), oppose: [], status: 'argued' })),
  relations: [], unresolved: Array.from({ length: 8 }, (_, i) => ({ nodeId: ids[0], reason: (`未决${i}："\u0001`).repeat(300) })) };
const dense = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', expectedRevision: 0, confirmed: true, operation: 'initial',
  reason: '', stance: 'endorsed', authorship: 'own_expression', doc: { doc_id: 'dense', title: '合成密集分组',
    nodes: denseSource.nodes.map(({ rawQuote, ...n }) => n), edges: [], flowStructure: denseSource } }, { id: 'dense-version', at: '2026-10-21T01:00:00Z' });
const paged = buildInquirySnapshot(dense, '查看我的认知库'), chunks = allChunks(paged);
assert.ok(chunks.length > 2);
assert.ok(paged.pages.filter(p => p.analysisStructures).every(p => JSON.stringify(p).length <= 48000));
for (const expected of denseSource.arguments) {
  const parts = chunks.flatMap(c => c.arguments).filter(a => a.id === expected.id).sort((a, b) => a.part - b.part);
  assert.equal(parts.length, parts[0].parts); assert.deepEqual(parts.flatMap(a => a.support), expected.support);
  assert.ok(parts.every(p => p.supportTotal === expected.support.length && p.status === 'argued'));
}
for (let i = 0; i < denseSource.unresolved.length; i++) {
  const parts = chunks.flatMap(c => c.unresolved).filter(u => u.id === `U${i + 1}`).sort((a, b) => a.part - b.part);
  assert.equal(parts.length, parts[0].parts); assert.equal(parts.map(p => p.reason).join(''), denseSource.unresolved[i].reason);
}
pass('dense/escaped memberships and long unresolved reasons paginate losslessly within serialized budgets without turning fragments into independent arguments');

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
let stored: CognitionFile = fixture.file, writes = 0;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
  vault: { loadVault: async () => [] }, userState: { getAgentTaskScope: async () => 'synthetic-scope',
    loadCognition: async () => structuredClone(stored), mutateCognition: async () => { writes++; throw new Error('write forbidden'); },
    searchCognition: async () => ({ status: 'ready', method: 'local-lexical-v1', fileRevision: stored.revision, items: [], warning: '' }) },
} }) });
globalThis.fetch = async () => { throw new Error('network forbidden'); };
try {
  const requests: any[] = [], ctx = { getNotes: () => [] } as unknown as AgentRuntimeContext;
  const result = await runCognitionInquiry({ question: '查看我的认知库', replyRequest: '详细展开', allowedTools: new Set(['retrieve_qa_evidence']), ctx,
    callLlm: async request => {
      const body = JSON.parse(request.userInput); requests.push(body);
      if (!body.pages.some((p: any) => p.analysisStructures?.length)) return { content: '', parsedJson: { action: 'read', page: body.nextPage } };
      const s = body.pages.flatMap((p: any) => p.sources).find((s: any) => s.reference?.nodeId === 'N6');
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '这些前提在原始抽取中共同构成一组依据。', evidence: [{ id: s.id, quote: s.text }] }] } };
    } });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].pages.some((p: any) => p.analysisStructures?.some((c: any) => c.arguments.some((a: any) => a.claim === 'N6' && a.supportTotal === 3))));
  assert.match(result.answer, /共同构成/u); assert.doesNotMatch(result.answer, /undefined/u); assert.equal(writes, 0);
  const continuation = await runCognitionInquiry({ question: '查看我的认知库', continuePage: true,
    cursor: { question: '查看我的认知库', fileRevision: stored.revision, nextPage: 1 }, allowedTools: new Set(['retrieve_qa_evidence']), ctx,
    callLlm: async request => {
      const body = JSON.parse(request.userInput), anchor = body.pages[0].sources[0];
      assert.ok(body.pages[0].analysisStructures); assert.ok(anchor.text.length >= 4);
      assert.ok(body.pages[0].sources.some((s: any) => s.reference.nodeId === 'N6'));
      assert.ok(body.pages[0].sources.some((s: any) => s.reference.nodeId === 'N4'));
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '本页原始论证详情仅供核对。', evidence: [{ id: anchor.id, quote: anchor.text.slice(0, 30) }] }] } };
    } });
  assert.match(continuation.answer, /本页原始论证详情/u); assert.equal(writes, 0);
} finally {
  globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
pass('actual general inquiry request reads analysis through existing next-page protocol, validates evidence on detail-only continuation and performs zero writes/network calls');
console.log(`Cognition source boundaries: ${passed} groups passed; synthetic data/temporary stores/model stubs only, not semantic accuracy or production-scoring acceptance.`);
