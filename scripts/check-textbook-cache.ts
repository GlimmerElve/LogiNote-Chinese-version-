import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import fileOps from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextbookStore } from '../src/electron/textbookStore';
import { defaultTextbookModelPolicy } from '../src/services/textbook/modelPolicy';
import { textbookHash } from '../src/services/textbook/fingerprint';
import { TEXTBOOK_CHAPTER_SECTIONS, type TextbookJob, type TextbookDraftCacheSelection } from '../src/services/textbook/generationTypes';
import { registerTextbookTools } from '../src/services/agent/tools/textbookTools';
import { getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import { AGENT_ROLES } from '../src/services/agent/agentEngine';
import { AGENT_CAPABILITY_DOMAINS } from '../src/services/agent/capabilities';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { NoteItem } from '../src/types';

const temp = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-cache-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live network forbidden'); };
const project = { id: 'project-cache', title: '隔离缓存验收', noteType: 'project', content: 'MANUAL_NOTE_KEEP',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-16', updatedAt: '2026-10-16' } as NoteItem;
let notes = [project], store = new TextbookStore(temp);
const file = (jobId: string) => path.join(temp, 'textbook-jobs', `${jobId}.json`);
const command = (input: Parameters<TextbookStore['command']>[0]) => store.command(input, 1, async () => notes);
async function seeded(): Promise<TextbookJob> {
  const created = await command({ op: 'create', spec: { schemaVersion: 1, projectNoteId: project.id, rootProjectId: project.id, projectTitle: project.title,
    planningHash: 'a'.repeat(64), providerHash: 'b'.repeat(64), allowedDocIds: [], documentHashes: {}, knowledgeHashes: { knowledge: 'c'.repeat(64) },
    allowCloud: false, readBoundUrls: false, boundUrls: [], modelPolicy: defaultTextbookModelPolicy() } });
  const lease = await command({ op: 'claim', jobId: created.job.id });
  lease.job.checkpoint = {
    context: { project: { id: project.id, rootId: project.id, title: project.title, rootTitle: project.title, tasks: [], knowledgeTitles: [] }, profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] },
    sources: [{ sourceId: 'N1', kind: 'knowledge', id: 'knowledge', title: 'ORIGINAL_SOURCE_KEEP', text: 'REFERENCE_TEXT_KEEP', version: 'c'.repeat(64) }],
    blueprint: { title: 'BLUEPRINT_KEEP', objectives: [], focuses: [], chapters: Array.from({ length: 5 }, (_, i) => ({ id: `ch${i + 1}`, title: `第${i + 1}章`, objectiveIds: [], focusIds: [], sourceIds: ['N1'], bridge: '承接' })) },
    chapters: Array.from({ length: 5 }, (_, i) => ({ id: `ch${i + 1}`, sections: Object.fromEntries(TEXTBOOK_CHAPTER_SECTIONS.map((section) => [section, `GENERATED_CH${i + 1}_${section}_` + '演示教材内容。'.repeat(120)])) as any })),
    chapterInputs: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`ch${i + 1}`, `hash${i + 1}`])),
    body: 'ASSEMBLED_BODY_REMOVE'.repeat(900),
    quality: { passed: false, issues: ['OLD_REVIEW_QUOTE_REMOVE'], origin: 'deterministic', status: 'blocked' },
    repairIssues: ['OLD_REVIEW_QUOTE_REMOVE'], repair: { applied: false, origin: 'deterministic', findings: [{ stage: 'chapters', chapterId: 'ch5', section: 'answer', message: 'OLD_REVIEW_QUOTE_REMOVE' }] },
    sectionRepairs: { ch5: ['answer'] }, reviewCache: { environmentHash: 'old-env', chapterHashes: {}, report: { schemaVersion: 3, passed: true, findings: [] } },
    chapterRegeneration: { requestedIds: ['ch5'], pendingIds: [], requestedAt: '2026-10-16T00:00:00.000Z', previousChapters: [{ id: 'ch5', sections: Object.fromEntries(TEXTBOOK_CHAPTER_SECTIONS.map((section) => [section, 'OLD_BACKUP_REMOVE'.repeat(120)])) as any }] },
    cost: { promptTokens: 12345, completionTokens: 6789, reservedTokens: 1000, requests: 10, repairRounds: 2, reviewRechecks: 1, legacyUsageIncomplete: false, stopped: 'repairs' },
    modelAttempts: [{ inputHash: 'diagnostic-retained', stage: 'chapter', chapterId: 'ch5', truncations: 2, exhausted: true, maxTokens: 24000, outputChars: 200 }],
  };
  await command({ op: 'checkpoint', jobId: created.job.id, token: lease.token!, stage: 'validating', checkpoint: lease.job.checkpoint });
  await command({ op: 'stop', jobId: created.job.id, token: lease.token!, cancelled: true, error: 'synthetic stopped task' });
  return (await command({ op: 'get', jobId: created.job.id })).job;
}
async function clear(job: TextbookJob, selection: TextbookDraftCacheSelection) {
  const preview = await command({ op: 'preview-clear-cache', jobId: job.id, ...selection });
  assert.equal(preview.cacheClear!.revision, await textbookHash(job));
  return command({ op: 'clear-cache', jobId: job.id, ...selection, expectedRevision: preview.cacheClear!.revision });
}
let checks = 0; const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
try {
  const old = await seeded(), duplicate = await seeded();
  const oldFile = await readFile(file(old.id), 'utf8'), before = await readFile(file(duplicate.id), 'utf8');
  const sourceSentinel = path.join(temp, 'original-source.txt'); await writeFile(sourceSentinel, 'SOURCE_FILE_KEEP');
  const snapshotSentinel = path.join(temp, 'textbook-jobs', 'web-snapshots', `${duplicate.id}-U1.json`);
  await mkdir(path.dirname(snapshotSentinel)); await writeFile(snapshotSentinel, 'FROZEN_WEB_SOURCE_KEEP');
  const preview = await command({ op: 'preview-clear-cache', jobId: duplicate.id, scope: 'all_generated' });
  assert.equal(await readFile(file(duplicate.id), 'utf8'), before); assert.equal(preview.cacheClear!.chapterIds.length, 5);
  assert.ok(preview.cacheClear!.beforeBytes > preview.cacheClear!.afterBytes); assert.equal(preview.cacheClear!.autoArchive, true);
  const removed = await command({ op: 'clear-cache', jobId: duplicate.id, scope: 'all_generated', expectedRevision: preview.cacheClear!.revision });
  const after = await readFile(file(duplicate.id), 'utf8');
  for (const marker of ['GENERATED_CH', 'ASSEMBLED_BODY_REMOVE', 'OLD_BACKUP_REMOVE', 'OLD_REVIEW_QUOTE_REMOVE']) assert.ok(!after.includes(marker), marker);
  assert.equal(removed.job.checkpoint.chapters!.length, 0); assert.ok(removed.job.archivedAt);
  assert.equal(removed.job.checkpoint.body, undefined); assert.equal(removed.job.checkpoint.quality, undefined); assert.equal(removed.job.checkpoint.reviewCache, undefined);
  assert.equal(removed.job.checkpoint.chapterRegeneration, undefined); assert.equal(removed.job.checkpoint.repair, undefined);
  assert.deepEqual(removed.job.spec, duplicate.spec); assert.deepEqual(removed.job.checkpoint.sources, duplicate.checkpoint.sources);
  assert.deepEqual(removed.job.checkpoint.context, duplicate.checkpoint.context); assert.deepEqual(removed.job.checkpoint.blueprint, duplicate.checkpoint.blueprint);
  assert.deepEqual(removed.job.checkpoint.cost, duplicate.checkpoint.cost); assert.deepEqual(removed.job.checkpoint.modelAttempts, duplicate.checkpoint.modelAttempts);
  assert.equal(await readFile(file(old.id), 'utf8'), oldFile); assert.equal(await readFile(sourceSentinel, 'utf8'), 'SOURCE_FILE_KEEP');
  assert.equal(await readFile(snapshotSentinel, 'utf8'), 'FROZEN_WEB_SOURCE_KEEP');
  assert.equal(notes[0].content, project.content); assert.ok(removed.cacheClear!.freedBytes > 0);
  assert.equal(removed.cacheClear!.freedBytes, Buffer.byteLength(before) - (await stat(file(duplicate.id))).size);
  pass('真实文件清理释放生成文本：整本/章节/备份/复核副本均移除并归档；原任务、来源文件、蓝图、笔记与用量逐字保留');
  store = new TextbookStore(temp);
  const restart = await command({ op: 'get', jobId: duplicate.id });
  assert.equal(restart.job.checkpoint.chapters!.length, 0); assert.ok(restart.job.archivedAt);
  await command({ op: 'archive', jobId: duplicate.id, archived: false });
  assert.equal((await command({ op: 'get', jobId: duplicate.id })).job.checkpoint.chapters!.length, 0);
  assert.deepEqual((await command({ op: 'get', jobId: duplicate.id })).job.checkpoint.cost, duplicate.checkpoint.cost);
  pass('清理后重启/解除归档不会复活已删除章节或重置预算');
  const selected = await seeded(); const partial = await clear(selected, { scope: 'selected_chapters', chapterIds: ['ch5'] });
  assert.deepEqual(partial.job.checkpoint.chapters, selected.checkpoint.chapters!.slice(0, 4));
  assert.ok(!partial.job.archivedAt); assert.equal(partial.job.checkpoint.chapterInputs!.ch5, undefined);
  assert.deepEqual(partial.job.checkpoint.chapterRegeneration!.previousChapters, []);
  const partialFile = await readFile(file(selected.id), 'utf8');
  assert.ok(!partialFile.includes('GENERATED_CH5') && !partialFile.includes('OLD_BACKUP_REMOVE') && !partialFile.includes('ASSEMBLED_BODY_REMOVE'));
  assert.deepEqual(partial.job.checkpoint.cost, selected.checkpoint.cost);
  await assert.rejects(command({ op: 'claim', jobId: selected.id, expectedCacheClearRevision: '' }), /旧继续请求已失效/u);
  pass('仅清第5章及其备份/全书派生缓存，前四章原样保留；清理前的迟到继续请求不能把缓存重新写回');
  const backups = await seeded(); const backupOnly = await clear(backups, { scope: 'backups_only' });
  assert.deepEqual(backupOnly.job.checkpoint.chapters, backups.checkpoint.chapters); assert.equal(backupOnly.job.checkpoint.body, backups.checkpoint.body);
  assert.deepEqual(backupOnly.job.checkpoint.quality, backups.checkpoint.quality); assert.deepEqual(backupOnly.job.checkpoint.reviewCache, backups.checkpoint.reviewCache);
  assert.deepEqual(backupOnly.job.checkpoint.chapterRegeneration!.previousChapters, []);
  pass('只清旧章备份不影响当前五章、整本教材草稿或已保存的质量状态');
  const invalid = await seeded(), invalidBefore = await readFile(file(invalid.id), 'utf8');
  for (const selection of [{ scope: 'selected_chapters', chapterIds: ['ch999'] }, { scope: 'selected_chapters', chapterIds: ['ch5', 'ch5'] }, { scope: 'all_generated', chapterIds: ['ch5'] }, { scope: 'invalid' }]) {
    await assert.rejects(command({ op: 'preview-clear-cache', jobId: invalid.id, ...selection } as any));
  }
  await assert.rejects(command({ op: 'clear-cache', jobId: invalid.id, scope: 'all_generated', expectedRevision: 'wrong' }), /确认后已变化/u);
  assert.equal(await readFile(file(invalid.id), 'utf8'), invalidBefore);
  const active = await command({ op: 'claim', jobId: invalid.id });
  await assert.rejects(command({ op: 'preview-clear-cache', jobId: invalid.id, scope: 'all_generated' }), /仍在运行/u);
  await command({ op: 'stop', jobId: invalid.id, token: active.token!, cancelled: true, error: 'synthetic stop' });
  const stale = await command({ op: 'preview-clear-cache', jobId: invalid.id, scope: 'all_generated' });
  await command({ op: 'archive', jobId: invalid.id, archived: true });
  await assert.rejects(command({ op: 'clear-cache', jobId: invalid.id, scope: 'all_generated', expectedRevision: stale.cacheClear!.revision }), /确认后已变化/u);
  notes = [{ ...project, textbook: { generationJobId: invalid.id } as any }];
  await assert.rejects(command({ op: 'preview-clear-cache', jobId: invalid.id, scope: 'all_generated' }), /被项目教材引用/u);
  notes = [project];
  const published = (await command({ op: 'get', jobId: invalid.id })).job; published.stage = 'published';
  await writeFile(file(invalid.id), JSON.stringify(published));
  await assert.rejects(command({ op: 'preview-clear-cache', jobId: invalid.id, scope: 'all_generated' }), /已发布教材/u);
  pass('运行中、已发布、发布回执中断、未知/重复章节、失效确认均拒绝清理；先验失败不改文件');
  const locked = await seeded(), lockedBefore = await readFile(file(locked.id), 'utf8');
  const lockedPreview = await command({ op: 'preview-clear-cache', jobId: locked.id, scope: 'all_generated' });
  const originalRename = fileOps.rename;
  fileOps.rename = async (from, to) => { if (String(to) === file(locked.id)) throw Object.assign(new Error(`EACCES: rename '${file(locked.id)}'`), { code: 'EACCES' }); return originalRename(from, to); };
  try {
    await assert.rejects(command({ op: 'clear-cache', jobId: locked.id, scope: 'all_generated', expectedRevision: lockedPreview.cacheClear!.revision }), /原缓存保留/u);
  } finally { fileOps.rename = originalRename; }
  assert.equal(await readFile(file(locked.id), 'utf8'), lockedBefore);
  pass('文件替换被占用时拒绝降级为原地覆盖复制，清理失败保留完整旧文件，不把失败报告成已清理');
  Object.assign(globalThis, { window: { electronAPI: { textbook: { command, list: (id: string) => store.list(id) } } } });
  registerTextbookTools(); const tool = getTool('clear_textbook_draft_cache')!;
  const ctx = { getNotes: () => notes } as AgentRuntimeContext;
  assert.ok(toolRequiresApproval(tool, {}, ctx)); assert.equal(tool.requiresConfirmation, true);
  assert.ok(AGENT_ROLES.default.skillToolCeiling!.includes(tool.name)); assert.ok(AGENT_CAPABILITY_DOMAINS.textbook.tools.includes(tool.name as any));
  const toolJob = await seeded(); const args = { jobId: toolJob.id, scope: 'all_generated' };
  await assert.rejects(async () => tool.execute(args, ctx), /确认已失效/u);
  const call = { id: 'confirmed-cache-clear', name: tool.name, arguments: args };
  const binding = await createAgentApprovalBinding(call, ctx);
  assert.ok(tool.confirmation!(args, ctx).title.includes('不可撤销'));
  const cachedBeforeConfirm = await readFile(file(toolJob.id), 'utf8');
  assert.ok(cachedBeforeConfirm.includes('GENERATED_CH5'));
  await validateAgentApprovalBinding({ call, binding } as never, ctx);
  const result = await tool.execute(args, ctx) as any;
  assert.equal(result.status, 'cache_cleared'); assert.equal(result.reversible, false); assert.equal(result.modelCalled, false); assert.equal(result.noteChanged, false);
  assert.equal(result.chapterIdsCleared.length, 5); assert.ok(!JSON.stringify(result).includes('GENERATED_CH'));
  await assert.rejects(async () => tool.execute(args, ctx), /确认已失效/u);
  pass('真实 Agent 清理工具需独立确认，预览不删除，确认一次才释放缓存；返回计数/字节而非正文，重复执行需重新确认');
  console.log(`textbook cache: ${checks} groups passed; synthetic files only; no real user cache, network or models`);
} finally {
  globalThis.fetch = originalFetch;
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
