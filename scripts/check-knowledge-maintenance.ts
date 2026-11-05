import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareKnowledgeDeletion, prepareKnowledgeMerge, knowledgeSelectionIds } from '../src/services/knowledgeMaintenance';
import { applyWorkspaceNoteChange, type WorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { createAgentOperationStore, commitAgentWorkspaceChange, prepareOperationUndo } from '../src/services/agent/operationStore';
import { saveVaultNotesDelta, readSavedVaultNotesByIds, validateVaultNotesDelta } from '../src/electron/vaultNoteDelta';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { readKnowledgeLifecycle } from '../src/electron/knowledgeLifecycle';
import { getKnowledgeLifecycle, setKnowledgeLifecycle, knowledgeDisposition } from '../src/services/knowledgeLifecycle';
import { loadNotesFromStorage, saveSelectedKnowledgeDelta } from '../src/services/storage';
import { resolveNoteByTitleOrAlias } from '../src/services/noteResolver';
import { materializeProgressiveKnowledge } from '../src/electron/progressiveKnowledge';
import { createChangedNoteIndex, savedNoteIndexInput } from '../src/electron/changedNoteIndex';
import { createNoteReferenceIndex } from '../src/electron/rag/noteReferenceIndex';
import { prepareSelectedNoteMetadata } from '../src/services/noteMetadataClient';
import { registerWorkspaceTools } from '../src/services/agent/tools/workspaceTools';
import { getTool } from '../src/services/agent/toolRegistry';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import type { NoteItem } from '../src/types';
import type { AgentRuntimeContext, AgentApprovalItem } from '../src/services/agent/types';
import type { VaultNotesDelta } from '../src/services/vaultNoteDelta';

globalThis.fetch = async () => assert.fail('no network or model calls');
const root = await fs.mkdtemp(path.resolve('build/knowledge-maintenance-'));
const vault = path.join(root, 'vault'), state = path.join(root, 'user-state'), at = '2026-11-02T00:00:00Z';
const note = (id: string, title: string, content: string, knowledge = false): NoteItem => ({ id, title, content, noteType: knowledge ? 'knowledge' : 'project',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at });
const project = note('project', '极限项目', '# 原项目正文\n\n[[细分0]]：原有说明与 $x^2$。\n\n[[细分1]]：原有说明。'); project.links = ['细分0', '细分1'];
const members = Array.from({ length: 8 }, (_, i) => ({ ...note('member-' + i, '细分' + i,
  `# 细分${i}\n\n原文${i}：极限的第${i}种情形需要核对条件，公式 $x\\to 0$。\n\n## 示例\n\n详细限定与来源保留。\n\n\`\`\`python\n# 代码标题保持不变\nprint("[[细分0]]")\n\`\`\``, true), parentId: project.id,
  dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: i, consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 30 + i } }));
const untouched = note('untouched-knowledge', '人工知识点', '# 人工知识点\n\n原有知识正文与公式不改变。'.repeat(5), true);
let notes = [project, ...members, untouched, ...Array.from({ length: 990 }, (_, i) => note('other-' + i, '其他项目' + i, 'UNRELATED_BODY_' + i + '。'.repeat(300)))];
await saveVaultNotesDelta(vault, state, { upserts: notes.map(note => ({ note, before: null })), removed: [] });
const originalProject = await fs.readFile(path.join(vault, 'notes/project.md'), 'utf8');
let operationFile: unknown = null;
const operations = createAgentOperationStore({ read: async () => operationFile, write: async file => { operationFile = structuredClone(file); } });
let embeds: string[] = [], syncs: Array<{ id: string; channel: string }> = [], reads: string[] = [], writes: string[] = [], version = 0;
const reference = createNoteReferenceIndex(root, async text => { embeds.push(text); return Array(384).fill(.1); });
await reference.indexAll([...members, untouched].map(savedNoteIndexInput));
const originalIndex = JSON.parse(await fs.readFile(path.join(root, 'note-embeddings.json'), 'utf8')).entries.find((row: any) => row.noteId === untouched.id);
const dirty = createChangedNoteIndex({ scope: () => 'fixture', isCurrent: () => true, version: () => version,
  read: ids => readSavedVaultNotesByIds(vault, state, ids), retry: () => {}, sync: async (channel, item) => { syncs.push({ id: item.id, channel }); if (channel === 'knowledge') await reference.index(savedNoteIndexInput(item)); } });
const checkpoints: unknown[] = [];
const run = async (change: WorkspaceNoteChange, undoRecordId?: string) => {
  const prepared = { ...change, after: await prepareSelectedNoteMetadata(change.after) };
  embeds = []; reads = []; writes = []; syncs = [];
  const receipt = await commitAgentWorkspaceChange(prepared, { readNotes: () => notes, store: operations, undoRecordId,
    saveAndApply: async selected => {
      const next = applyWorkspaceNoteChange(notes, selected), byId = new Map(selected.before.map(note => [note.id, note]));
      const delta: VaultNotesDelta = { upserts: selected.after.map(note => ({ note, before: byId.get(note.id) || null })),
        removed: selected.before.filter(note => !selected.after.some(after => after.id === note.id)).map(note => ({ id: note.id, before: note })),
        ...(selected.knowledgeMerges ? { knowledgeMerges: selected.knowledgeMerges } : {}) };
      await saveVaultNotesDelta(vault, state, delta, { read: (async (file: any, ...args: any[]) => { reads.push(String(file)); return (fs.readFile as any)(file, ...args); }) as typeof fs.readFile,
        write: async (file, text) => { writes.push(file); return atomicWriteTextFile(file, text); } });
      notes = next; version++; setKnowledgeLifecycle(await readKnowledgeLifecycle(state));
      dirty.forget(delta.removed.map(row => row.id));
      dirty.request(delta.upserts.map(row => row.note), delta.upserts.flatMap(row => row.before ? [row.before] : []));
      await reference.removeMany(delta.removed.map(row => row.id)); await dirty.run();
    } });
  const mdReads = reads.filter(file => file.endsWith('.md')).map(file => path.basename(file));
  const mdWrites = writes.filter(file => file.endsWith('.md')).map(file => path.basename(file));
  const allowed = new Set([...change.before, ...change.after].map(note => note.id + '.md'));
  assert.ok(mdReads.every(file => allowed.has(file)) && mdWrites.every(file => allowed.has(file)), 'only selected original bodies are read/written');
  assert.equal(await fs.readFile(path.join(vault, 'notes/project.md'), 'utf8'), originalProject);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'note-embeddings.json'), 'utf8')).entries.find((row: any) => row.noteId === untouched.id), originalIndex);
  checkpoints.push({ kind: change.kind, selected: allowed.size, mdReads, mdWrites, embeddedChunks: embeds.length, indexedKnowledgeIds: syncs.filter(row => row.channel === 'knowledge').map(row => row.id) });
  return receipt;
};

const deletion = await run(prepareKnowledgeDeletion(notes, [members[0].id]));
assert.equal(embeds.length, 0); assert.equal(syncs.length, 0);
assert.equal(resolveNoteByTitleOrAlias(members[0].title, notes), undefined);
const beforeRetryProject = await fs.readFile(path.join(vault, 'notes/project.md'), 'utf8');
assert.deepEqual(await materializeProgressiveKnowledge(vault, state, project.id, 'old-course', [{ key: 'detail-0', title: members[0].title, summary: '旧教材后台恢复不应重建已删除知识点。' }], () => true), []);
assert.equal(await fs.readFile(path.join(vault, 'notes/project.md'), 'utf8'), beforeRetryProject);
await run(prepareOperationUndo(notes, await operations.get(deletion.operationId)), deletion.operationId);
assert.equal(resolveNoteByTitleOrAlias(members[0].title, notes)?.id, members[0].id);
assert.equal(notes.find(note => note.id === members[0].id)?.dsrState?.conceptMastery, 30);

const merge = prepareKnowledgeMerge(notes, { sourceIds: members.map(note => note.id), targetTitle: '极限' }, at);
assert.equal(merge.before.length, 8); assert.equal(merge.after.length, 1);
const mergedId = merge.after[0].id;
const merged = await run(merge);
assert.ok(syncs.filter(row => row.channel === 'knowledge').every(row => row.id === mergedId));
assert.ok(embeds.length > 0 && embeds.every(text => text.startsWith('极限\n')));
assert.equal(notes.find(note => note.id === mergedId)?.dsrState, undefined, 'no averaged or inherited mastery on the new aggregate');
for (const member of members) { assert.ok(merge.after[0].content.includes('原文' + members.indexOf(member))); assert.equal(resolveNoteByTitleOrAlias(member.title, notes)?.id, mergedId); }
assert.ok(merge.after[0].content.includes('# 代码标题保持不变'));
assert.deepEqual(await materializeProgressiveKnowledge(vault, state, project.id, 'old-course', [{ key: 'detail-1', title: members[1].title, summary: '旧页恢复。' }], () => true), [mergedId]);
assert.equal(await fs.readFile(path.join(vault, 'notes/project.md'), 'utf8'), originalProject);
const savedOperation = await operations.get(merged.operationId);
assert.equal(savedOperation.change.before.length, 8); assert.ok(savedOperation.change.before.every(note => note.dsrState));
await run(prepareOperationUndo(notes, savedOperation), merged.operationId);
assert.ok(members.every(member => notes.some(note => note.id === member.id)) && !notes.some(note => note.id === mergedId));
const existing = prepareKnowledgeMerge(notes, { sourceIds: [members[1].id], targetId: untouched.id }, at);
assert.ok(existing.after[0].content.startsWith(untouched.content));
assert.throws(() => prepareKnowledgeDeletion(notes, [project.id]));
assert.throws(() => prepareKnowledgeMerge(notes, { sourceIds: [members[0].id], targetTitle: project.title }));
assert.throws(() => validateVaultNotesDelta({ upserts: [], removed: [], knowledgeMerges: [{ sourceId: members[0].id, targetId: untouched.id }] }));
const changed = { ...members[0], content: '并发编辑后的新正文。' };
assert.throws(() => applyWorkspaceNoteChange(notes.map(note => note.id === changed.id ? changed : note), prepareKnowledgeDeletion(notes, [changed.id])), /发生修改/);
assert.deepEqual(knowledgeSelectionIds('普通段落中提到极限，不能据此模糊匹配并删除', notes), []);
assert.deepEqual(knowledgeSelectionIds('[[细分0]] 和 [[细分1|显示文字]]', notes), [members[0].id, members[1].id]);

registerWorkspaceTools();
const tool = getTool('merge_knowledge_notes')!; assert.ok(tool);
const ctx = { getNotes: () => notes, applyWorkspaceNoteChange: run } as unknown as AgentRuntimeContext;
const call = { id: 'merge-test', name: tool.name, arguments: { sourceIds: [members[0].id, members[1].id], targetTitle: '定向合并' } };
const binding = await createAgentApprovalBinding(call, ctx);
const item = { call, binding, ...tool.confirmation!(call.arguments, ctx) } as AgentApprovalItem;
await validateAgentApprovalBinding(item, ctx);
const original = notes; notes = notes.map(note => note.id === members[0].id ? changed : note);
await assert.rejects(validateAgentApprovalBinding(item, ctx), /变化/); notes = original;
const agentResult = await tool.execute(call.arguments, ctx) as { saved: boolean };
assert.equal(agentResult.saved, true, 'Agent executes the same selected-object operation');
let committedDeltas = 0, lifecycleReads = 0;
(globalThis as any).window = { electronAPI: { vault: { loadVault: async () => [untouched], saveNotesDelta: async () => { committedDeltas++; },
  knowledgeLifecycle: async () => { if (lifecycleReads++) throw Error('synthetic cache refresh failure after commit'); return { version: 1, entries: [] }; } } } };
await loadNotesFromStorage();
await saveSelectedKnowledgeDelta({ upserts: [], removed: [{ id: untouched.id, before: untouched }] });
assert.equal(committedDeltas, 1);
assert.equal(knowledgeDisposition(getKnowledgeLifecycle(), untouched.id)?.id, untouched.id, 'committed deletion remains applied if refreshing its cache fails');
delete (globalThis as any).window;
const proof = { root, status: 'passed', noteCount: 1000, projectBodyHash: createHash('sha256').update(originalProject).digest('hex'),
  untouchedBodiesReadOrWritten: 0, untouchedVectorsChanged: 0, deletionEmbeddingCalls: 0,
  checkpoints, liveCalls: 0, quality: 'production storage/index algorithms with deterministic embedding fixture; native inference checked separately' };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
