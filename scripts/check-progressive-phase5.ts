import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LearningPreparationQueue } from '../src/electron/learningPreparation';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { prepareLearningStateMigration, copyLearningStateMigration } from '../src/electron/learningStateMigration';
import { preparationRoot, preparationCandidates, preparationGoal, plannedPreparationDocuments, mergePreparationResources, rebasePreparedResources } from '../src/services/progressiveLearning/preparation';
import { projectDocumentBindings } from '../src/services/projectResourceScope';
import { shareProgressiveTeaching, sharedTeachingMarkdown } from '../src/services/progressiveLearning/share';
import { exportCommunitySnapshot } from '../src/services/community/snapshotExport';
import { exportCommunityNotes } from '../src/services/community/resourceExport';
import { prepareCommunityNotes } from '../src/services/community/resourceImport';
import { readResourcePackage } from '../apps/community-api/src/resourceFormat';
import { CommunityHost } from '../src/electron/communityHost';
import { writeTextbookRegion } from '../src/services/textbook/noteContent';
import { buildPersistedPlanHandoff, normalizeWorkflowHandoff } from '../src/services/agent/workflowHandoff';
import { analyzeProgressivePart } from '../src/services/progressiveLearning/reviewAnalysis';
import { progressiveReviewModelReply } from './fixtures/progressive-phase4';
import { loadProgressiveMaterials } from '../src/services/progressiveLearning/materials';
import { ResourceDownloadBatchStore } from '../src/electron/resourceDownloadBatch';
import type { NoteItem, ResourceItem } from '../src/types';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveQuestion } from '../src/services/progressiveLearning/types';

globalThis.fetch = async () => assert.fail('Phase5 uses offline adapters; no cloud requests');
const directory = await fs.mkdtemp(path.resolve('build/progressive-phase5-contract-'));
const checks: string[] = [], at = '2026-11-01T00:00:00Z';
const note = (id: string, title: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title, noteType: 'project', content: 'PRIVATE_NOTE_BODY', tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at, ...extra });
let root = note('root', '函数', { planMeta: { schemaVersion: 2, status: 'active', resourcePreparationVersion: 1, dailyStudyMinutes: 30 }, flowSummary: 'PRIVATE_SUMMARY' });
const leaf = note('leaf', '函数的定义', { parentId: root.id, dueDates: [{ id: 'due-leaf', noteId: 'leaf', noteTitle: '函数的定义', taskText: '函数的定义', dueDate: '2026-11-03', priority: 'medium', completed: false, estimatedMinutes: 40 }] });
const resource = (title = '函数'): ResourceItem => ({ title: `${title}公开教材`, kind: 'online', url: `https://open.example.edu/${encodeURIComponent(title)}.pdf`, accessType: 'public', isFree: true, description: `${title}将每个允许输入对应到唯一输出，这是实际取得的公开片段。`.repeat(5) });

function preparation(name: string, initialAuto = false) {
  const folder = path.join(directory, name), calls: string[] = [], collections: string[] = [];
  let automatic = initialAuto, failCollect = false, failSave = false, hold = false, release: (() => void) | undefined;
  const host = {
    notes: async (id: string) => [root, leaf].filter(note => note.id === id),
    automatic: async () => automatic, current: () => true, changed: (_id: string) => {},
    search: async (title: string, signal: AbortSignal) => {
      calls.push(title); assert.ok(!title.includes('PRIVATE'));
      if (hold) { hold = false; await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
      signal.throwIfAborted(); return [resource(title)];
    },
    collect: async (job: any, resources: ResourceItem[], signal: AbortSignal) => {
      signal.throwIfAborted(); if (failCollect) { failCollect = false; throw Error('合成下载中断'); }
      collections.push(job.goalKey); root = mergePreparationResources(root, resources); return resources.length;
    },
    write: async (file: string, text: string) => { if (failSave) { failSave = false; throw Error('合成落盘失败'); } await fs.writeFile(file, text); },
  };
  let queue = new LearningPreparationQueue(folder, host);
  return { calls, collections, get queue() { return queue; }, set automatic(value: boolean) { automatic = value; }, set failCollect(value: boolean) { failCollect = value; }, set failSave(value: boolean) { failSave = value; },
    holdSearch() { hold = true; }, release() { release?.(); }, async rebuild() { await queue.stop(); queue = new LearningPreparationQueue(folder, host); await queue.recover(); }, folder };
}
const waitFor = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(test()); };

const review = preparation('review');
await review.queue.command({ op: 'enqueue', rootId: root.id }); await review.queue.idle();
let job = (await review.queue.command({ op: 'status', rootId: root.id }))!;
assert.equal(job.status, 'recommended'); assert.equal(review.collections.length, 0); assert.equal(root.resources, undefined);
await review.queue.command({ op: 'enqueue', rootId: root.id }); await review.queue.idle(); assert.equal(review.calls.length, 1);
await assert.rejects(review.queue.command({ op: 'enqueue', rootId: leaf.id }), /已保存的根学习项目/);
await assert.rejects(review.queue.command({ op: 'accept', rootId: root.id, goalKey: job.goalKey, urls: ['https://unrelated.example.com'] }), /推荐已变化/);
await review.queue.command({ op: 'accept', rootId: root.id, goalKey: job.goalKey, urls: [job.candidates[0].url] }); await review.queue.idle();
assert.equal((await review.queue.command({ op: 'status', rootId: root.id }))!.status, 'ready');
checks.push('筛选模式先推荐不收录；实际选择后收录，重复入队不重复搜索，叶子与任意URL不能冒充根目标');

const automatic = preparation('auto', true); await automatic.queue.command({ op: 'enqueue', rootId: root.id }); await automatic.queue.idle();
assert.equal((await automatic.queue.command({ op: 'status', rootId: root.id }))!.status, 'ready'); assert.equal(automatic.collections.length, 1);
assert.equal(root.resources!.length, 1);
automatic.failCollect = true; await automatic.queue.command({ op: 'retry', rootId: root.id }); await automatic.queue.idle();
assert.equal((await automatic.queue.command({ op: 'status', rootId: root.id }))!.status, 'failed');
await automatic.rebuild(); await automatic.queue.idle();
assert.equal((await automatic.queue.command({ op: 'status', rootId: root.id }))!.status, 'failed', 'failures await explicit retry');
await automatic.queue.command({ op: 'retry', rootId: root.id }); await automatic.queue.idle();
assert.equal((await automatic.queue.command({ op: 'status', rootId: root.id }))!.status, 'ready'); assert.equal(root.resources!.length, 1);
checks.push('自动收录与失败状态真实落盘；重启不无限重试，明确重试复用选择且不重复资源');

const switchMode = preparation('switch-mode', true); switchMode.holdSearch();
await switchMode.queue.command({ op: 'enqueue', rootId: root.id }); await waitFor(() => switchMode.calls.length === 1);
switchMode.automatic = false; switchMode.release(); await switchMode.queue.idle();
assert.equal((await switchMode.queue.command({ op: 'status', rootId: root.id }))!.status, 'recommended'); assert.equal(switchMode.collections.length, 0);
checks.push('用户在搜索期间关闭自动模式后，只保留推荐，不自动下载或写入');

const changedGoal = preparation('changed-goal', true); changedGoal.holdSearch();
await changedGoal.queue.command({ op: 'enqueue', rootId: root.id }); await waitFor(() => changedGoal.calls.length === 1);
root = { ...root, title: '极限' }; await changedGoal.queue.command({ op: 'enqueue', rootId: root.id }); changedGoal.release(); await changedGoal.queue.idle();
job = (await changedGoal.queue.command({ op: 'status', rootId: root.id }))!;
assert.equal(job.title, '极限'); assert.equal(job.status, 'ready'); assert.equal(changedGoal.collections.length, 1); assert.deepEqual(changedGoal.calls, ['函数', '极限']);
checks.push('迟到的旧目标搜索不能覆盖新目标检查点或绑定旧推荐');

const interrupted = preparation('interrupted'); interrupted.holdSearch();
await interrupted.queue.command({ op: 'enqueue', rootId: root.id }); await waitFor(() => interrupted.calls.length === 1); await interrupted.rebuild(); await interrupted.queue.idle();
assert.equal((await interrupted.queue.command({ op: 'status', rootId: root.id }))!.status, 'recommended');
assert.equal(interrupted.calls.length, 2);
const failedDisk = preparation('disk'); failedDisk.failSave = true;
await assert.rejects(failedDisk.queue.command({ op: 'enqueue', rootId: root.id }), /落盘失败/); assert.equal(failedDisk.calls.length, 0);
checks.push('搜索中退出后从持久检查点恢复；队列落盘失败不发起搜索、不虚报已准备');

const bad: ResourceItem[] = [resource('极限'), { ...resource('极限'), kind: 'local' }, { ...resource('极限'), url: 'https://open.example.edu/book?token=SECRET' },
  { ...resource('极限'), url: 'http://127.0.0.1/book' }, { ...resource('极限'), url: 'https://open.example.edu/private', accessType: 'authenticated' }];
assert.equal(preparationCandidates(bad, '极限').length, 1);
assert.ok(!JSON.stringify(preparationCandidates(bad, '极限')).includes('SECRET'));
const local = plannedPreparationDocuments([{ id: 'doc-uploaded', title: '教材.pdf', indexable: true }]);
const boundRoot = { ...root, resources: [...(root.resources || []), ...local] };
const siblingRoot = note('other', '其他根目标', { resources: [{ ...local[0], documentId: 'doc-other' }] });
assert.equal(preparationRoot(leaf, [boundRoot, leaf, siblingRoot])!.id, root.id);
assert.deepEqual(projectDocumentBindings(leaf, [boundRoot, leaf, siblingRoot]).map(binding => binding.documentId), ['doc-uploaded']);
checks.push('公开候选与上传采用限定字段，拒绝凭据/内网/受限目标；根资源向子项目继承，不跨其他根项目');

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), readIds: string[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { ragDocs: {
  materialList: async () => ({ ok: true, value: [] }), materialPrepare: async () => ({ ok: true, value: {} }),
  materialCatalog: async (request: any) => { readIds.push(request.docId); return { ok: true, value: { document: { docId:request.docId,parseStatus: 'ready', version: 'v1' }, sections: [{ id: 's1', title: '函数', sectionPath: '函数' }] } }; },
  materialRead: async (request: any) => ({ ok: true, value: { docId:request.docId,fileName: request.docId, version: 'v1', excerpts: [{ blockId:request.docId+':block:1',kind:'paragraph',sectionPath:'函数',textStart:0,textEnd:256,text: '函数将允许输入对应到唯一输出，根资料为子项目提供讲解依据。'.repeat(8) }] } }),
} } } });
try {
  const documents = Array.from({ length: 4 }, (_, index) => ({ ...local[0], title: `函数教材${index + 1}`, documentId: `doc-material-${index + 1}`, url: `loginote-document://doc-material-${index + 1}` }));
  const packets = await loadProgressiveMaterials(leaf, [{ ...root, resources: documents }, leaf]);
  assert.equal(packets.length, 4); assert.ok(readIds.includes('doc-material-4')); assert.ok(!readIds.includes('doc-other'));
} finally { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as any).window; }
checks.push('实际材料读取保持有界，新增同等相关教材进入后续上下文，不读取其他根项目或依赖向量完成');

let healthStarted = false;
const download = new ResourceDownloadBatchStore({ notes: async () => [{ ...root, resources: [resource()] }], scope: () => 'offline', documents: async () => [],
  health: async () => { healthStarted = true; return new Promise(() => {}); }, download: async () => assert.fail('no download after cancelled probe'), importFile: async () => assert.fail('no import after cancelled probe') });
const abort = new AbortController(), probe = download.prepare(1, root.id, [resource().url], abort.signal);
await waitFor(() => healthStarted); const cancelledProbe = assert.rejects(probe, { name: 'AbortError' }); abort.abort(); await cancelledProbe;
checks.push('附件探测尚未返回时可立即取消，关闭或迁移不等待网络健康检查，无迟到下载或入库');

const before = note('rebase', '编辑中的根项目', { resources: [resource('函数')] });
const docResource: ResourceItem = { title: '函数教材', kind: 'local', documentId: 'doc-background', url: 'loginote-document://doc-background', sourceUrl: resource('函数').url };
const update = { noteId: before.id, before: before.resources!, resources: [docResource], updatedAt: '2026-11-01T01:00:00Z' };
const current = { ...before, content: 'PRIVATE_UNSAVED_BODY', title: '未保存标题', updatedAt: '2026-11-01T00:30:00Z' };
const rebased = rebasePreparedResources(current, before, update)!;
assert.equal(rebased.note.content, current.content); assert.equal(rebased.note.title, current.title); assert.equal(rebased.note.updatedAt, current.updatedAt);
assert.equal(rebased.note.resources![0].documentId, 'doc-background'); assert.equal(rebased.saved.content, before.content);
assert.deepEqual(rebasePreparedResources({ ...current, resources: [] }, before, update)!.note.resources, []);
assert.equal(rebasePreparedResources(current, { ...before, resources: [] }, update), null);
checks.push('后台资源更新只重基资源；未保存正文/标题和主动移除保留，旧通知不推进错误保存基线');

root = { ...root, title: '函数' };
const state = path.join(directory, 'course-source');
const deps = { readTarget: async () => ({ note: leaf, root, isLeaf: true }) };
const store = new ProgressiveLearningStore(state, deps);
const command = async <T = any>(input: any): Promise<T> => store.command(input, 77) as Promise<T>;
const plan = { title: '函数入门', objectives: ['理解唯一对应'], pages: [{ id: 'main-1', title: '唯一对应', objectives: ['说明函数条件'] }, { id: 'main-2', title: '定义域', objectives: ['列出输入限制'] }] };
const quote = '每个允许的输入对应唯一输出，不同输入可以有相同输出。';
const body = `# 公共教学内容\n\n${quote}\n\n${'从允许输入和唯一输出两个方面检查对应关系，先检验条件，再说明结论。'.repeat(12)}`;
const question: ProgressiveQuestion = { id: 'q1', kind: 'choice', prompt: '一个输入可以同时有两个输出吗？', objective: '检查唯一性', conceptKeys: ['unique'], focus: 'concept', options: [{ id: 'A', text: '不能' }, { id: 'B', text: '能' }], correctOptionId: 'A', referenceAnswer: '不能', explanation: '同一输入的输出必须唯一。', referenceQuote: quote };
async function publish(begin: ProgressiveBeginReply) {
  assert.ok(begin.lease);
  return command<ProgressiveCourse>({ op: 'publish', lease: begin.lease, teaching: { sequence: begin.course.generation.sequence + 1, plan,
    title: plan.pages[begin.course.generation.mainlineIndex || 0].title, body, questions: [question], concepts: [{ key: 'unique', title: '唯一对应', summary: quote }], hook: { id: 'hook', kind: 'reflection', prompt: '请说明唯一输出与输入范围的关系。' } } });
}
let course = await publish(await command({ op: 'begin', projectNoteId: leaf.id, sourcePackets: [{ id: 'S1', kind: 'document', title: 'PRIVATE_DOCUMENT_NAME', text: 'PRIVATE_SOURCE_CONTEXT', locator: 'PRIVATE_DOCUMENT_POINTER' }] }));
const firstHash = course.pages![0].contentHash;
course = await publish(await command({ op: 'next', projectNoteId: leaf.id, request: { environmentId: course.environmentId, courseId: course.id, expectedRevision: course.revision, requestId: 'page-2', intent: 'mainline', fromPageId: 'main-1' } }));
course = await command({ op: 'save-progress', projectNoteId: leaf.id, progress: { environmentId: course.environmentId, courseId: course.id, expectedProgressVersion: course.progress.version,
  patch: { restatementDraft: 'PRIVATE_RESTATEMENT：每个输入都只有唯一输出，定义域需要明确。', summaryDraft: 'PRIVATE_REVIEW_SUMMARY', currentPageId: 'main-2', scrollTop: 315 } } });
await command({ op: 'study', projectNoteId: leaf.id, request: { environmentId: course.environmentId, courseId: course.id, pageId: 'main-2', expectedVersion: course.study!.version,
  mutation: { kind: 'draft', drafts: { q1: { text: 'PRIVATE_ANSWER', optionId: 'B' } } } } });
const exit = await command({ op: 'review-exit', projectNoteId: leaf.id, environmentId: course.environmentId, courseId: course.id, expectedProgressVersion: course.progress.version, exitId: 'phase5-review', analyze: true });
await command({ op: 'review-activate', projectNoteId: leaf.id, environmentId: course.environmentId, courseId: course.id, exitId: 'phase5-review' });
const claimed = await command({ op: 'review-claim', projectNoteId: leaf.id, reviewId: exit.record.id });
const packet = await command({ op: 'review-packet', lease: claimed.lease, partId: 'part-1' });
const analysis = await analyzeProgressivePart(packet, { call: async request => ({ content: JSON.stringify(progressiveReviewModelReply(JSON.parse(request.userInput))) }) });
await command({ op: 'review-result', lease: claimed.lease, partId: 'part-1', result: analysis });
await command({ op: 'review-finish', lease: claimed.lease });
course = await command({ op: 'load', projectNoteId: leaf.id });
assert.ok(course.lastSuccessfulReview);
const teaching = (await store.exportTeaching(leaf.id))!;
assert.equal(teaching.pages.length, 2); assert.deepEqual(teaching.pages.map(page => page.title), ['唯一对应', '定义域']);
assert.equal(course.pages![0].contentHash, firstHash);
assert.ok(!JSON.stringify(teaching).includes('PRIVATE_')); assert.ok(!JSON.stringify(teaching).includes('environmentId'));
assert.equal((await command<ProgressiveCourse>({ op: 'load', projectNoteId: leaf.id })).progress.currentPageId, 'main-2');
checks.push('真实课程导出全部已发布页，不只当前页；不更改阅读位置、课程哈希或个人记录');

const snapshot = exportCommunitySnapshot({ ...leaf, content: 'PRIVATE_NOTE_AND_REVIEW_TEXT' }, teaching);
assert.ok(snapshot.body.includes('唯一对应') && snapshot.body.includes('定义域'));
assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_')); assert.ok(!snapshot.body.includes('315'));
const host = new CommunityHost({ apiUrl: 'http://127.0.0.1:5180/api/community/v1', origin: 'http://127.0.0.1:5174',
  environment: () => ({ vaultRoot: path.join(directory, 'vault'), userStateDir: state, dataRoot: directory, epoch: 1 }), loadNotes: async () => [root, leaf],
  progressiveTeaching: id => store.exportTeaching(id), encrypt: () => null, decrypt: () => '', changeNotes: async () => assert.fail('export never writes notes'), importDocument: async () => assert.fail('export never imports'), documentStatus: async () => 'stored' });
const preview = await host.prepare({ noteIds: [leaf.id], kind: 'notes', includeDescendants: false });
assert.equal(preview.body, snapshot.body); assert.ok(!JSON.stringify(preview).includes('PRIVATE_'));
await assert.rejects(host.prepare({ noteIds: [root.id], kind: 'notes', includeDescendants: false }), /尚无已生成教材/);
const legacy = writeTextbookRegion({ ...leaf, content: 'PRIVATE_OUTSIDE_OLD_TEXTBOOK' }, body, { schemaVersion: 1, textbookId: 'old', projectNoteId: leaf.id, rootProjectId: root.id, regionId: 'old-region', revisionId: 'old-version', createdAt: at, updatedAt: at });
assert.ok(!exportCommunitySnapshot(legacy).body.includes('PRIVATE_'));
assert.throws(() => exportCommunitySnapshot({ ...legacy, content: 'PRIVATE_BROKEN_BOUNDARY' }), /教材边界异常/);
checks.push('实际社区预览入口只读取教学白名单；旧教材排除私人正文，边界损坏不回退分享原笔记');

const exported = exportCommunityNotes([leaf], [leaf.id], { kind: 'notes', progressiveTeaching: new Map([[leaf.id, teaching]]) });
const unpacked = readResourcePackage(exported.bytes);
assert.ok(!JSON.stringify(unpacked.manifest).includes('PRIVATE_'));
const restored = prepareCommunityNotes([], unpacked.manifest, unpacked.files, { accountId: 'new-account', entryId: 'entry', versionId: 'version' }, id => 'import-' + id);
assert.ok(restored.notes.some(note => note.content.includes('唯一对应')));
assert.ok(restored.notes.every(note => !('flowSummary' in note) && !('learningReviewRecords' in note) && !('dsrState' in note)));
assert.ok(!JSON.stringify(restored.notes).includes('PRIVATE_'));
checks.push('组合资源的真实导出/解包/导入也仅含静态教学；导入者没有作者作答、复盘、进度或掌握度');

const sourceJson = JSON.stringify(teaching);
const injected = sharedTeachingMarkdown({ ...teaching, pages: [{ ...teaching.pages[0], body: body + '\n\n```textbook-image\n{"assetId":"PRIVATE_ASSET_POINTER"}\n```\n\n```textbook-references\n{"sourceIds":["PRIVATE_POINTER"]}\n```\n[S1]' }] });
assert.ok(!injected.includes('PRIVATE_')); assert.ok(!injected.includes('[S1]')); assert.equal(JSON.stringify(teaching), sourceJson);
assert.throws(() => sharedTeachingMarkdown({ schemaVersion: 1, title: '空课程', pages: [] }), /尚未生成/);
checks.push('教材分享移除本机资料与插图指针；空课程不偷用私人正文，无原对象修改');

await fs.mkdir(path.join(state, 'progressive-derived/project-test'), { recursive: true });
await fs.writeFile(path.join(state, 'progressive-derived/project-test/page-index.json'), JSON.stringify({ vector: [1, 2], pageHash: firstHash }));
await fs.mkdir(path.join(state, 'learning-preparation'), { recursive: true });
await fs.writeFile(path.join(state, 'learning-preparation/probe.json'), JSON.stringify({ private: 'PRIVATE_PENDING_PREPARATION' }));
const target = path.join(directory, 'migrated');
const migration = await prepareLearningStateMigration(state, target); await copyLearningStateMigration(migration);
for (const file of migration.files) assert.deepEqual(await fs.readFile(path.join(target, file.relative)), await fs.readFile(path.join(state, file.relative)));
const migrated = new ProgressiveLearningStore(target, deps);
const loaded = await migrated.command({ op: 'load', projectNoteId: leaf.id }, 88) as ProgressiveCourse;
assert.equal(loaded.id, course.id); assert.notEqual(loaded.environmentId, course.environmentId); assert.equal(loaded.lastSuccessfulReview!.reviewId, course.lastSuccessfulReview!.reviewId);
assert.equal(loaded.progress.currentPageId, 'main-2'); assert.equal(loaded.progress.scrollTop, 315); assert.equal(loaded.study!.drafts.q1.text, 'PRIVATE_ANSWER');
await assert.rejects(migrated.command({ op: 'save-progress', projectNoteId: leaf.id, progress: { environmentId: course.environmentId, courseId: course.id, expectedProgressVersion: loaded.progress.version, patch: { scrollTop: 0 } } }, 88), /环境|课程|许可|变化/);
assert.equal((await migrated.exportTeaching(leaf.id))!.pages.length, 2);
checks.push('本地迁移逐文件保留教材、作答、归档分析、有效回执、位置和索引；新环境拒绝旧请求且不重生成');

const conflict = path.join(directory, 'conflict'); await fs.mkdir(path.join(conflict, path.dirname(migration.files[0].relative)), { recursive: true });
await fs.writeFile(path.join(conflict, migration.files[0].relative), 'DIFFERENT_DESTINATION');
await assert.rejects(prepareLearningStateMigration(state, conflict), /目标已有不同/);
assert.equal(await fs.readFile(path.join(conflict, migration.files[0].relative), 'utf8'), 'DIFFERENT_DESTINATION');
const changedSource = await prepareLearningStateMigration(state, path.join(directory, 'changed-source-target'));
const last = changedSource.files.at(-1)!; await fs.writeFile(path.join(state, last.relative), 'SOURCE_CHANGED_AFTER_PREFLIGHT');
await assert.rejects(copyLearningStateMigration(changedSource), /发生变化/);
checks.push('不同的目标学习记录不被覆盖；复制前后源变化会失败，不把部分副本当成功迁移');

const handoff = buildPersistedPlanHandoff({ scopeProjectId: root.id, scopeProjectTitle: root.title, taskCount: 0 })!;
assert.equal(handoff.actions[0].destination, 'learning'); assert.ok(!handoff.actions.some(action => action.id === 'generate-study-tasks'));
assert.equal(normalizeWorkflowHandoff(handoff)!.actions[0].destination, 'learning');
checks.push('计划 Agent 移交直接开始心流，不强制生成任务；恢复的移交仍保留直接进入动作');

await Promise.all([review.queue.stop(), automatic.queue.stop(), switchMode.queue.stop(), changedGoal.queue.stop(), interrupted.queue.stop(), failedDisk.queue.stop()]);
const result = { status: 'passed', version: '1.0.10', directory, checks: checks.length, coverage: checks, network: 'blocked', model: 'deterministic fixtures; no new semantic quality claim' };
await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
