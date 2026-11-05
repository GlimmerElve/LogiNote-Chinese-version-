import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FlowSession, NoteItem } from '../src/types';
import { mixedTextbookNote, TEXTBOOK_FIXTURE as fixture } from './fixtures/textbook-phase-zero';
import { saveFlowReviewRecord, finishFlowReviewRecord, saveReviewArgument, patchLearningReviewRecord, detachReviewArgument } from '../src/services/textbook/reviewRecordStore';
import { migrateLearningContent, recoverLearningReviewReferences } from '../src/services/textbook/migration';
import { writeTextbookRegion, stripTextbookRegion, textbookRegionMarkers, learningReviewMarker, prepareLogicCheckSource } from '../src/services/textbook/noteContent';
import { splitSharableFields, splitUserStateFields, mergeNote, serializeUserStateFile, deserializeUserStateFile } from '../src/services/userStateService';
import { deserializeVault, markdownFileMap, serializeMetadata } from '../src/services/vaultFsService';
import { buildNoteRagIndexInput } from '../src/services/ragService';
import { personalProjectContent, projectMaterialRows } from '../src/services/ragSourcePolicy';
import { saveVaultSnapshot, recoverVaultSnapshot } from '../src/electron/vaultSnapshot';
import { atomicWriteTextFile } from '../src/electron/atomicWrite';
import { parseNoteMetadata } from '../src/services/storage';
import { extractProjectTasks } from '../src/services/agent/resourceDraftService';

let passed = 0;
function pass(message: string) { passed++; console.log(`PASS ${message}`); }
function jsonSnapshot<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
const base = mixedTextbookNote();
const session: FlowSession = { id: fixture.sessions[0].id, noteId: base.id, noteTitle: base.title,
  rootProjectId: fixture.rootProjectId, startedAt: fixture.sessions[0].startedAt, endedAt: fixture.sessions[0].endedAt,
  durationSeconds: 2100, reviewIntervalMinutes: 20, restateText: fixture.restatement,
  incrementalText: fixture.restatement, summary: '检查适用条件', analyze: true };
const doc = { ...base.argumentDocs![0], doc_id: 'argument-new-session-1' };
const pending = saveFlowReviewRecord(base, session, 'pending_analysis');
assert.equal(pending.content, base.content);
assert.equal(pending.learningReviewRecords!.length, 1);
assert.equal(pending.learningReviewRecords![0].rawRestatement, fixture.restatement);
assert.equal(pending.learningReviewRecords![0].rootProjectId, fixture.rootProjectId);
assert.equal(pending.learningContentMigration!.originalContent, base.content);
assert.equal(migrateLearningContent(pending), pending);
pass('暂存只写会话数据，不覆盖教材、任务、旧复述或旧图入口；迁移有原文备份且幂等');

const saved = saveReviewArgument(pending, doc, session.id);
const retry = saveReviewArgument(saveFlowReviewRecord(saved, session, 'pending_analysis'), doc, session.id);
assert.equal(retry.learningReviewRecords!.length, 1);
assert.equal(retry.learningReviewRecords![0].status, 'completed');
assert.equal(retry.argumentDocs!.filter((item) => item.doc_id === doc.doc_id).length, 1);
assert.equal(retry.content.split(learningReviewMarker(session.id)).length - 1, 1);
assert.ok(retry.content.includes(`<ArgumentBlock id="${fixture.graphId}" />`));
assert.ok(!retry.content.includes(`<ArgumentBlock id="${doc.doc_id}" />`), 'New graph is displayed inside the review component, not a second standalone entry');
assert.deepEqual(retry.learningReviewRecords![0].argumentDocIds, [doc.doc_id]);
pass('最终保存图文同一记录，重试不重复图或框，无法关联的旧入口保留');

const second = { ...session, id: fixture.sessions[1].id, startedAt: fixture.sessions[1].startedAt, endedAt: fixture.sessions[1].endedAt };
const two = saveFlowReviewRecord(retry, second, 'text_only', true);
assert.equal(two.learningReviewRecords!.length, 2);
assert.ok(two.content.includes(learningReviewMarker(second.id)));
let edited = patchLearningReviewRecord(two, session.id, { title: '我的条件判断复盘', editedRestatement: '我补充了条件判断。', expanded: true });
edited = saveReviewArgument(edited, { ...doc, title: '图编辑回传后的标题' });
assert.equal(edited.learningReviewRecords![0].title, '我的条件判断复盘');
assert.equal(edited.learningReviewRecords![0].rawRestatement, fixture.restatement);
assert.equal(edited.learningReviewRecords![0].editedRestatement, '我补充了条件判断。');
assert.equal(edited.learningReviewRecords![0].expanded, true);
assert.equal(edited.argumentDocs!.find((item) => item.doc_id === doc.doc_id)!.title, '图编辑回传后的标题');
assert.throws(() => patchLearningReviewRecord(edited, session.id, { title: '  ' }));
pass('同日不同会话独立成框；修改标题、文本、展开状态后图回传保留原记录与原始转写');

const failed = finishFlowReviewRecord(pending, session.id, 'analysis_failed', '离线');
assert.ok(failed.content.includes(learningReviewMarker(session.id)));
assert.equal(failed.learningReviewRecords![0].rawRestatement, fixture.restatement);
assert.deepEqual(failed.learningReviewRecords![0].argumentDocIds, []);
assert.equal(saveReviewArgument(failed, doc, session.id).learningReviewRecords!.length, 1);
assert.throws(() => saveFlowReviewRecord({ ...base, id: 'other' }, session, 'text_only'));
assert.throws(() => saveReviewArgument(base, doc, 'missing-session'));
assert.throws(() => saveReviewArgument(saved, { ...doc, doc_id: 'unexpected-new-id' }, session.id));
const detached = detachReviewArgument(saved, doc.doc_id);
assert.deepEqual(detached.learningReviewRecords![0].argumentDocIds, []);
assert.equal(detached.learningReviewRecords![0].rawRestatement, fixture.restatement);
pass('分析失败保留文本且不编造图；恢复补图不多建框；跨项目/失效会话/错误图 ID 被拒绝');

const interrupted = recoverLearningReviewReferences(jsonSnapshot(pending));
assert.ok(interrupted.content.includes(learningReviewMarker(session.id)));
assert.equal(interrupted.learningReviewRecords![0].status, 'pending_analysis');
assert.deepEqual(interrupted.learningReviewRecords![0].argumentDocIds, []);
assert.equal(recoverLearningReviewReferences(interrupted), interrupted);
const intentionallyHidden = { ...saved, content: saved.content.replace(learningReviewMarker(session.id), '') };
assert.equal(recoverLearningReviewReferences(intentionallyHidden), intentionallyHidden, 'Do not undo a user removing a completed record reference');
pass('重启后暂存文本有可见入口且状态真实，恢复不伪造图、不多建框');

const cleanBase = { ...edited, content: edited.content.replace(fixture.textbook, '') };
let managed = writeTextbookRegion(cleanBase, fixture.textbook, {
  schemaVersion: 1, projectNoteId: base.id, textbookId: 'textbook-choice', rootProjectId: fixture.rootProjectId,
  revisionId: 'revision-1', regionId: 'region-choice', createdAt: session.endedAt, updatedAt: session.endedAt,
});
managed = { ...managed, content: managed.content.replace('选择过载效应教材', '选择过载效应教材 用户修改') };
assert.ok(stripTextbookRegion(managed.content, managed.textbook).valid);
assert.ok(!personalProjectContent(buildNoteRagIndexInput(managed)).includes('选择过载效应教材'));
assert.ok(personalProjectContent(buildNoteRagIndexInput(managed)).includes('我补充了条件判断'));
assert.ok(!personalProjectContent(buildNoteRagIndexInput(managed)).includes('<ArgumentBlock'));
assert.ok(!personalProjectContent(buildNoteRagIndexInput(managed)).includes('LearningReviewBlock'));
assert.ok(projectMaterialRows(buildNoteRagIndexInput(managed)).every((row) => row.usableAsFactEvidence === false));
const rewritten = writeTextbookRegion(managed, '新版教材', { ...managed.textbook!, revisionId: 'revision-2' });
assert.deepEqual(rewritten.learningReviewRecords, managed.learningReviewRecords);
assert.deepEqual(rewritten.argumentDocs, managed.argumentDocs);
assert.ok(rewritten.content.includes(fixture.plan));
assert.ok(rewritten.content.includes(learningReviewMarker(session.id)));
assert.throws(() => writeTextbookRegion(managed, '错项目', { ...managed.textbook!, projectNoteId: 'other' }));
pass('教材改标题仍按区域分源；任务与图标记不入复述；教材替换保留个人框、旧图和任务');

const [start, end] = textbookRegionMarkers(managed.textbook!.regionId);
const logicContent = `我的判断：选项更多不一定更好。\n\n${start}\n\n教材正文：这里是条件与示例。\n\n${end}\n\n我的结论：还要考虑时间压力。`;
const logicSource = prepareLogicCheckSource(logicContent, '', managed.textbook);
assert.equal(logicSource.ok, true);
if (logicSource.ok) {
  assert.equal(logicSource.scope, 'note_without_textbook');
  assert.ok(logicSource.text.includes('选项更多不一定更好'));
  assert.ok(logicSource.text.includes('还要考虑时间压力'));
  assert.ok(!logicSource.text.includes('教材正文'));
  assert.ok(!logicSource.text.includes('TextbookBoundary'));
}
const textbookSelection = prepareLogicCheckSource(logicContent, '教材正文：这里是条件与示例。', managed.textbook);
assert.equal(textbookSelection.ok, true);
if (textbookSelection.ok) {
  assert.equal(textbookSelection.scope, 'note_without_textbook');
  assert.ok(!textbookSelection.text.includes('教材正文'));
}
pass('逻辑检查仅取教材边界外的个人正文；教材内选区不能把教材文本送入模型');
const damaged = { ...managed, content: managed.content.replace(end, '') };
assert.equal(stripTextbookRegion(damaged.content, damaged.textbook).valid, false);
assert.equal(prepareLogicCheckSource(damaged.content, '', damaged.textbook).ok, false);
assert.ok(!personalProjectContent(buildNoteRagIndexInput(damaged)).includes('选择过载效应教材'));
assert.ok(personalProjectContent(buildNoteRagIndexInput(damaged)).includes('我补充了条件判断'));
assert.throws(() => writeTextbookRegion(damaged, '不能猜测替换', damaged.textbook!));
const forged = { ...managed, content: '```md\n' + start + '\n示例\n' + end + '\n```' };
assert.equal(stripTextbookRegion(forged.content, forged.textbook).valid, false);
assert.equal(stripTextbookRegion('    ' + start + '\n    缩进代码示例\n    ' + end, managed.textbook).valid, false);
assert.equal(prepareLogicCheckSource(managed.content, '', undefined).ok, false);
assert.equal(prepareLogicCheckSource('```md\n' + start + '\n示例\n' + end + '\n```\n\n用户正文', '', undefined).ok, true);
const cleared = patchLearningReviewRecord(managed, session.id, { editedRestatement: '' });
assert.ok(!personalProjectContent(buildNoteRagIndexInput(cleared)).includes('我补充了条件判断'));
pass('损坏/代码示例边界不冒充真实区域，来源不明时拒绝全文推作复述；清空复述不偷偷索引原文');

const markerExample = `\`\`\`md\n${start}\n旧代码示例\n${end}\n\`\`\`\n\n`;
const withExample = { ...managed, content: markerExample + managed.content };
const exactRewrite = writeTextbookRegion(withExample, '只替换真实教材', withExample.textbook!);
assert.ok(exactRewrite.content.startsWith(markerExample));
assert.ok(!exactRewrite.content.includes('选择过载效应教材'));
assert.ok(exactRewrite.content.includes('只替换真实教材'));
const markerCodeOnly = { ...base, content: `\`\`\`md\n${learningReviewMarker(session.id)}\n\`\`\`` };
assert.ok(saveFlowReviewRecord(markerCodeOnly, session, 'text_only', true).content.endsWith(learningReviewMarker(session.id)));
const tasks = { ...managed, content: '- [ ] 真实任务 [[选择过载]] @due(2026-10-07)\n\n' + managed.content + '\n- [ ] 末尾真实任务 @due(2026-10-08)' };
const demonstrated = writeTextbookRegion(tasks, '- [ ] 教材演示 [[示例概念]] @due(2099-01-01)', tasks.textbook!);
const planned = { ...demonstrated, content: '\`\`\`md\n- [ ] 代码示例 @due(2099-02-02)\n\`\`\`\n' + demonstrated.content };
assert.ok(!extractProjectTasks(planned.content, planned.textbook).some((task) => /演示|代码示例/u.test(task)));
assert.deepEqual(parseNoteMetadata(planned).dueDates.map((due) => due.dueDate).filter((due) => due.startsWith('2099')), []);
assert.ok(parseNoteMetadata(planned).dueDates.some((due) => due.taskText.includes('末尾真实任务')));
const tailIndex = planned.content.split('\n').findIndex((line) => line.includes('末尾真实任务'));
assert.equal(parseNoteMetadata(planned).dueDates.find((due) => due.taskText.includes('末尾真实任务'))!.id, `due-${planned.id}-${tailIndex}`);
pass('读写复用真实边界坐标；教材与代码示例不形成真实任务/日程，原行号与外围内容保留');

for (const indent of ['    ', '\t']) {
  for (const withTextbook of [false, true]) {
    for (const newline of ['\n', '\r\n']) {
      const realTaskLines = [
        '- [ ] 主任务 [[概念]] @due(2026-10-08)',
        `${indent}- [ ] 嵌套的真实任务 [[概念]] @due(2026-10-09)`,
        `${indent}${indent}- [x] 更深的真实任务 [[概念]] @due(2026-10-10)`,
        `${indent}- [ ] 并列的真实任务 [[概念]] @due(2026-10-11)`,
      ];
      const outside = realTaskLines.join(newline);
      const nested = withTextbook
        ? writeTextbookRegion({ ...base, content: outside }, '- [ ] 教材演示 @due(2099-03-03)', managed.textbook!)
        : { ...base, content: outside };
      const description = `${indent === '\t' ? 'Tab' : '四空格'}嵌套列表/${withTextbook ? '有' : '无'}教材/${newline === '\n' ? 'LF' : 'CRLF'}`;
      assert.equal(extractProjectTasks(nested.content, nested.textbook).length, 4, description);
      const nestedDates = parseNoteMetadata(nested).dueDates;
      assert.deepEqual(nestedDates.map((due) => due.dueDate), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'], description);
      assert.deepEqual(nestedDates.map((due) => due.id), realTaskLines.map((_, index) => `due-${base.id}-${index}`), description);
      assert.equal(nestedDates[2].completed, true, description);
    }
  }
}
const trueCodeExamples = [
  '    - [ ] 顶层缩进代码 @due(2099-01-01)',
  '\t- [ ] 顶层 Tab 代码 @due(2099-01-02)',
  '- [ ] 真实父任务 @due(2026-10-08)',
  '',
  '      - [ ] 列表内的缩进代码 @due(2099-01-03)',
  '    - [ ] 真正的子任务 @due(2026-10-09)',
  '',
  '    ```md',
  '    - [ ] 列表内的围栏代码 @due(2099-01-04)',
  '    ```',
  '    - [ ] 围栏后的真实子任务 @due(2026-10-10)',
  '',
  '普通段落终止列表',
  '',
  '    - [ ] 列表外的缩进代码 @due(2099-01-05)',
  '',
  '```md',
  '- [ ] 顶层围栏代码 @due(2099-01-06)',
  '```',
].join('\n');
assert.deepEqual(extractProjectTasks(trueCodeExamples), ['真实父任务', '真正的子任务', '围栏后的真实子任务']);
assert.deepEqual(parseNoteMetadata({ ...base, content: trueCodeExamples }).dueDates.map((due) => due.dueDate), ['2026-10-08', '2026-10-09', '2026-10-10']);
const listStartingWithFence = '- ```md\n  - [ ] 列表项围栏内的示例 @due(2099-01-07)\n  ```\n- [ ] 围栏后的根任务 @due(2026-10-12)';
assert.deepEqual(extractProjectTasks(listStartingWithFence), ['围栏后的根任务']);
assert.deepEqual(parseNoteMetadata({ ...base, content: listStartingWithFence }).dueDates.map((due) => due.dueDate), ['2026-10-12']);
assert.deepEqual(extractProjectTasks('1. 有序列表父项\n    - [ ] 真实子任务 @due(2026-10-09)'), ['真实子任务']);
pass('四空格/Tab 的真实嵌套任务与日期保留，有无教材及 LF/CRLF 一致；真实缩进和列表内围栏代码仍被排除');

const share = splitSharableFields(managed), privateState = splitUserStateFields(managed);
assert.equal(share.learningReviewRecords, undefined);
assert.equal(share.learningContentMigration, undefined);
assert.equal(share.textbookReadingState, undefined);
assert.ok(share.textbook);
assert.ok(!serializeMetadata([managed]).includes('我的条件判断复盘'));
assert.ok(!JSON.stringify([...markdownFileMap([share]).values()]).includes('我补充了条件判断'));
const merged = mergeNote(share, deserializeUserStateFile(serializeUserStateFile({ [managed.id]: privateState }))[managed.id]);
assert.deepEqual(merged.learningReviewRecords, jsonSnapshot(managed.learningReviewRecords));
assert.deepEqual(merged.argumentDocs, managed.argumentDocs);
pass('教材分享白名单不带新复述/标题/个人展开状态；完整个人状态序列化重载保留图文关系');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'loginote-textbook-records-'));
const vault = path.join(tempRoot, 'vault'), states = path.join(tempRoot, 'user-state');
async function diskNotes(): Promise<NoteItem[]> {
  const metadata = await readFile(path.join(vault, 'metadata.json'), 'utf8');
  const md = new Map([[`${managed.id}.md`, await readFile(path.join(vault, 'notes', `${managed.id}.md`), 'utf8')]]);
  const privateFile = deserializeUserStateFile(await readFile(path.join(states, 'user-state.json'), 'utf8'));
  return deserializeVault(metadata, md).map((note) => mergeNote(note, privateFile[note.id]));
}
try {
  await saveVaultSnapshot(vault, states, [managed]);
  assert.deepEqual((await diskNotes())[0].learningReviewRecords, jsonSnapshot(managed.learningReviewRecords));
  assert.deepEqual((await diskNotes())[0].argumentDocs, managed.argumentDocs);
  await assert.rejects(readFile(path.join(states, 'vault-pending-snapshot.json')), { code: 'ENOENT' });
  pass('真实临时磁盘写入与重载：教材、个人框、标题和原图关系完整，已完成事务清除 journal');

  const newer = { ...patchLearningReviewRecord(managed, session.id, { title: '中断恢复后的标题' }), updatedAt: '2026-10-17T00:00:00.000Z' };
  let injected = false;
  await assert.rejects(saveVaultSnapshot(vault, states, [newer], async (file, text) => {
    if (!injected && file.endsWith('metadata.json')) { injected = true; throw new Error('模拟中断'); }
    return atomicWriteTextFile(file, text);
  }), /模拟中断/);
  assert.ok(await readFile(path.join(states, 'vault-pending-snapshot.json'), 'utf8'));
  await recoverVaultSnapshot(vault, states);
  assert.equal((await diskNotes())[0].learningReviewRecords![0].title, '中断恢复后的标题');
  await recoverVaultSnapshot(vault, states);
  assert.equal((await diskNotes())[0].learningReviewRecords!.length, 2);
  pass('注入多文件写入中断后报错而非成功；恢复重放完整快照且幂等');

  assert.throws(() => saveVaultSnapshot(vault, states, [{ ...managed, id: '../escape' }]));
  await mkdir(path.join(vault, 'notes'), { recursive: true });
  await writeFile(path.join(vault, 'notes', 'manual-untracked.md'), '用户手工文件');
  await Promise.all([saveVaultSnapshot(vault, states, [managed]), saveVaultSnapshot(vault, states, [newer])]);
  assert.equal((await diskNotes())[0].learningReviewRecords![0].title, '中断恢复后的标题');
  assert.equal(await readFile(path.join(vault, 'notes', 'manual-untracked.md'), 'utf8'), '用户手工文件');
  pass('拒绝路径越界；并发快照串行提交，保留手工文件，不批量删除正文');
} finally {
  // 唯一删除目标由 mkdtemp 创建，始终限定本次合成测试目录。
  await rm(tempRoot, { recursive: true, force: true });
}
console.log(`\n${passed} textbook record/persistence checks passed (synthetic, temporary disk, no cloud). UI/native IPC remains separate acceptance.`);
