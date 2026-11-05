import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { createNoteEditorMetadataDraft, reconcileNoteEditorMetadataDraft, recordNoteEditorMetadataDraft,
  applyNoteEditorMetadataDraft, sameEditorMetadataList } from '../src/services/ui/noteEditorMetadataDraft';
import { createDeferredNoteIndex } from '../src/services/deferredNoteIndex';
import { noteAliasesError } from '../src/services/noteResolver';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows } from '../src/services/progressiveLearning/knowledgeProjection';

// Actual component/coordinator/batch functions. All IO/models are stubbed.
let checks = 0;
const pass = (label: string) => console.log(`PASS ${++checks}: ${label}`);
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function load(name: string, file: string, env: Record<string, any>) {
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      text = (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(ast);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast).replace(/^export\s+/u, '');
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(text, name);
  const js = ts.transpileModule(`return (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '合成正文', noteType: 'project',
  tags: ['旧标签'], aliases: ['旧别名'], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...extra });
function editor() {
  const source = note('synthetic', { resources: [{ url: 'https://example.invalid/a', kind: 'web' } as any, { url: 'https://example.invalid/b', kind: 'web' } as any] });
  let current = source;
  const env: Record<string, any> = { note: source, title: source.title, editingNoteIdRef: { current: source.id },
    metadataDraftRef: { current: createNoteEditorMetadataDraft(source) },
    latestContentRef: { current: source.content }, latestNoteRef: { current: source },
    resourcesRef: { current: source.resources }, actionScopeRef: { current: { version: 1 } },
    applyNoteEditorMetadataDraft, recordNoteEditorMetadataDraft, noteAliasesError,
    allNotesRef: { current: [source] }, invalidAliasesDraftRef: { current: null }, setAliasesError() {},
    splitAliasTokens: (text: string) => text.split(/[、，,；;]/).map(item => item.trim()).filter(Boolean),
    setTagsText() {}, setAliasesText() {}, setResources() {}, showToast() {}, isCurrentAction: () => true, normalizeResourceUrl: (url: string) => url,
    onEditNote: (_id: string, patch: Partial<NoteItem>) => { current = { ...current, ...patch }; },
    onCommitNote: (value: NoteItem) => { current = value; },
  };
  const file = 'src/components/NoteEditor.tsx';
  env.onUpdateNote = load('onUpdateNote', file, env);
  return { env, source, current: () => current, tags: load('handleTagsChange', file, env), aliases: load('handleAliasesChange', file, env),
    remove: load('handleDeleteResource', file, env), commit: env.onUpdateNote };
}
{
  const f = editor(); f.tags('#新标签, 条件'); f.aliases('新别名；另一个别名');
  f.remove(f.source.resources![0]);
  assert.deepEqual(f.current().tags, ['新标签', '条件']); assert.deepEqual(f.current().aliases, ['新别名', '另一个别名']);
  assert.equal(f.current().resources!.length, 1); assert.equal(f.current().content, f.source.content);
  pass('真实标签/别名输入→保存前移除资源：新草稿字段不回退，资源变更仍提交');
}
{
  const f = editor(); f.tags('新标签'); f.aliases('新别名');
  f.commit({ ...f.source, resources: [...f.source.resources!, { url: 'https://example.invalid/new' } as any], content: '业务显式改动正文' });
  assert.deepEqual(f.current().tags, ['新标签']); assert.deepEqual(f.current().aliases, ['新别名']);
  assert.equal(f.current().resources!.length, 3); assert.equal(f.current().content, '业务显式改动正文');
  pass('旧props整对象添加资源仍合并元数据草稿，不覆盖业务显式提供的新正文');
}
{
  const f = editor(); f.tags('临时标签'); f.aliases('临时别名'); f.tags('旧标签'); f.aliases('旧别名');
  assert.deepEqual(f.env.metadataDraftRef.current.patch, {});
  f.remove(f.source.resources![0]); assert.deepEqual(f.current().tags, ['旧标签']); assert.deepEqual(f.current().aliases, ['旧别名']);
  pass('同帧改回原值清除补丁，最新笔记ref不残留临时标签/别名');
}
{
  const source = note('A'), draft = createNoteEditorMetadataDraft(source);
  recordNoteEditorMetadataDraft(draft, source, { tags: ['本地新标签'], aliases: ['本地新别名'] });
  reconcileNoteEditorMetadataDraft(draft, { ...source, content: '外部只改正文' });
  assert.deepEqual(draft.patch, { tags: ['本地新标签'], aliases: ['本地新别名'] });
  const published = { ...source, tags: ['本地新标签'] };
  reconcileNoteEditorMetadataDraft(draft, published); assert.equal('tags' in draft.patch, false); assert.deepEqual(draft.patch.aliases, ['本地新别名']);
  const external = { ...published, aliases: ['Agent确认后设置的别名'] };
  reconcileNoteEditorMetadataDraft(draft, external); assert.deepEqual(draft.patch, {});
  assert.deepEqual(applyNoteEditorMetadataDraft(external, draft).aliases, ['Agent确认后设置的别名']);
  recordNoteEditorMetadataDraft(draft, external, { tags: ['A新草稿'] });
  const other = note('B'); reconcileNoteEditorMetadataDraft(draft, other);
  assert.deepEqual(draft.patch, {}); assert.deepEqual(applyNoteEditorMetadataDraft(other, draft).tags, other.tags);
  pass('逐字段核销已发布草稿；不清无关草稿，不覆盖较新的外部元数据，切页无补丁串线');
}

const channels = ['private-material', 'knowledge', 'published-argument', 'textbook', 'flow-review'];
{
  const file = 'src/components/NoteEditor.tsx', ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let effect: ts.Expression | undefined;
  const find = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('const completionVersion')) effect = node.arguments[0]; ts.forEachChild(node, find); }; find(ast); assert.ok(effect);
  const js = ts.transpileModule(`return (${effect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const source = note('same'), draft = createNoteEditorMetadataDraft(source), changed: string[] = [];
  recordNoteEditorMetadataDraft(draft, source, { tags: ['新标签'], aliases: ['新别名'] });
  const env: Record<string, any> = { note: source, content: source.content, title: source.title, isActive: true, readTextbook: false,
    previousActiveRef: { current: true }, prevNoteIdRef: { current: source.id }, isLocalTypingRef: { current: true },
    previousTaskCompletionRef: { current: JSON.stringify([source.id, []]) }, localTypingTimeoutRef: { current: null },
    latestContentRef: { current: source.content }, latestNoteRef: { current: source },
    pendingKnowledgeRef: { current: { noteId: source.id, rows: [] } }, appendProjectKnowledgeRows, pendingProjectKnowledgeRows,
    titleDraftRef: { current: { noteId: source.id, baseline: source.title, value: source.title } },
    mdxEditorRef: { current: { setMarkdown() {} } },
    metadataDraftRef: { current: draft }, tagsText: '#新标签 ,', aliasesText: '新别名；', sameEditorMetadataList,
    invalidAliasesDraftRef: { current: null }, setAliasesError() {},
    splitAliasTokens: (text: string) => text.split(/[、，,；;]/).map(item => item.trim()).filter(Boolean),
    setContent() {}, setTitle() {}, setResources() {}, setTagsText: (value: string) => changed.push('tags:' + value),
    setAliasesText: (value: string) => changed.push('aliases:' + value) };
  const apply = () => new Function(...Object.keys(env), js)(...Object.values(env))();
  apply(); assert.deepEqual(changed, []);
  env.note = { ...source, tags: ['新标签'], aliases: ['新别名'] }; reconcileNoteEditorMetadataDraft(draft, env.note); apply();
  assert.deepEqual(changed, [], 'acknowledgement must not normalize separators/move caret');
  env.note = { ...env.note, tags: ['外部标签'], aliases: ['外部别名'] }; reconcileNoteEditorMetadataDraft(draft, env.note); apply();
  assert.deepEqual(changed, ['tags:外部标签', 'aliases:外部别名']);
  pass('真实接收Effect：保存回执保留正在输入的分隔符，真正外部元数据变更才刷新输入框');
}
function coordinator() {
  let saved = [note('saved')], version = 1, root = '/synthetic-A', wakeups = 0;
  let beforeStage: ((name: string) => void) | undefined;
  let argumentBatch: (() => Promise<void>) | undefined;
  const failing = new Set<string>(), calls: string[] = [], receipts = new Map<string, string>();
  const stage = async (name: string) => { calls.push(name); beforeStage?.(name); if (failing.has(name)) throw Error(name + '_unavailable'); };
  const env = { getVaultRoot: () => root, getUserStateDir: () => root + '/private', referenceSourceWriteEpoch: 1,
    applicationExiting: false, referenceEnvironmentSuspended: false, getDataVersion: () => version,
    serializeNoteSourceIndex: async (work: () => Promise<void>) => work(), loadMergedNotes: async () => saved,
    indexedSavedChannelKeys: receipts, createHash, deferredNoteIndex: { request: () => { wakeups++; } }, changedNoteIndex: { remember() {} },
    syncCognitionMaterialNotes: () => stage('private-material'), noteRagIndexNotes: () => stage('knowledge'),
    syncUserArgumentNotes: async () => { await stage('published-argument'); await argumentBatch?.(); },
    generateRagEmbedding: () => assert.fail('must not call a model'), syncTextbookReferenceNotes: () => stage('textbook'),
    syncSavedFlowReviewNotes: () => stage('flow-review'), console,
  };
  const options = load('deferredNoteIndex', 'src/electron/main.ts', env);
  return { run: options.run as () => Promise<void>, calls, failing, receipts, wakeups: () => wakeups,
    before: (value: typeof beforeStage) => { beforeStage = value; },
    arguments: (value: () => Promise<void>) => { argumentBatch = value; },
    edit: () => { saved = [{ ...saved[0], content: '改变后的原文' }]; version++; },
    bump: () => { version++; }, switchRoot: () => { root = '/synthetic-B'; } };
}
{
  const f = coordinator(); f.failing.add('knowledge');
  await assert.rejects(f.run(), /note_index_channels_failed: knowledge/); assert.deepEqual(f.calls, channels);
  assert.equal(f.receipts.has('knowledge'), false); assert.equal(f.receipts.size, 4);
  f.failing.clear(); f.calls.length = 0; await f.run(); assert.deepEqual(f.calls, ['knowledge']); assert.equal(f.receipts.size, 5);
  f.calls.length = 0; await f.run(); assert.deepEqual(f.calls, []);
  pass('真实协调器：知识点失败不阻断发布图/教材/复盘；同源重试只跑失败通道');
}
{
  const f = coordinator(); f.failing.add('private-material'); f.failing.add('textbook');
  await assert.rejects(f.run(), /private-material,textbook/); assert.deepEqual(f.calls, channels);
  assert.equal(f.receipts.size, 3); f.failing.clear(); f.calls.length = 0; await f.run();
  assert.deepEqual(f.calls, ['private-material', 'textbook']);
  pass('首通道和中途多个失败均不阻断其它通道，失败清单与重试范围精确保留');
}
function argumentBatch() {
  let fail = true, ioFailure = '', cleanupFailure = false;
  const attempted: string[] = [], removed: string[] = [], warnings: unknown[] = [];
  const env = { path, shardFile: (id: string) => `/synthetic/user-argument-${id}.json`, indexDir: () => '/synthetic',
    syncUserArgumentNote: async (input: { id: string }) => { attempted.push(input.id); if (fail && input.id === 'bad') throw Error('embedding_unavailable'); },
    fs: { readdir: async () => { if (ioFailure) throw Object.assign(Error(ioFailure), { code: ioFailure }); return ['user-argument-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json']; },
      rm: async (target: string) => { removed.push(target); if (cleanupFailure) throw Error('unlink_failed'); } },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  };
  return { sync: load('syncUserArgumentNotes', 'src/electron/rag/userArgumentIndex.ts', env) as (inputs: any[], embed: any) => Promise<void>,
    attempted, removed, warnings, healthy: () => { fail = false; }, io: (value: string) => { ioFailure = value; }, cleanupFailure: () => { cleanupFailure = true; } };
}
{
  const f = argumentBatch();
  await assert.rejects(f.sync([{ id: 'bad' }, { id: 'good' }], () => assert.fail('no model')), /user_argument_index_partial_failure/);
  assert.deepEqual(f.attempted, ['bad', 'good']); assert.equal(f.removed.length, 1); assert.equal(f.warnings.length, 1);
  f.healthy(); await f.sync([{ id: 'bad' }, { id: 'good' }], () => assert.fail('no model'));
  assert.deepEqual(f.attempted, ['bad', 'good', 'bad', 'good']);
  pass('真实论证批处理：坏笔记不阻断好笔记和派生清理，部分失败明确抛出，恢复后能重试');
}
{
  const f = coordinator(), args = argumentBatch();
  f.arguments(() => args.sync([{ id: 'bad' }, { id: 'good' }], () => assert.fail('no model')));
  await assert.rejects(f.run(), /published-argument/); assert.deepEqual(f.calls, channels); assert.equal(f.receipts.has('published-argument'), false);
  args.healthy(); f.calls.length = 0; await f.run(); assert.deepEqual(f.calls, ['published-argument']);
  assert.deepEqual(args.attempted, ['bad', 'good', 'bad', 'good']); assert.equal(f.receipts.size, 5);
  pass('两个真实函数联验：瞬时论证失败不再被成功哈希吞掉，同源第二次唤醒实际重试');
}
{
  const f = argumentBatch(); f.healthy(); f.io('EACCES');
  await assert.rejects(f.sync([], null), /user_argument_index_partial_failure/);
  f.io('ENOENT'); await f.sync([], null);
  f.io(''); f.cleanupFailure(); await assert.rejects(f.sync([], null), /user_argument_index_partial_failure/);
  pass('目录读取拒绝和派生清理失败不冒充成功；空索引目录ENOENT仍是正常空状态');
}
{
  const f = coordinator(); f.failing.add('knowledge'); f.before(name => { if (name === 'knowledge') f.edit(); });
  await f.run(); assert.deepEqual(f.calls, ['private-material', 'knowledge']); assert.equal(f.wakeups(), 1);
  assert.equal(f.receipts.has('knowledge'), false); assert.equal(f.receipts.has('textbook'), false);
  f.before(undefined); f.failing.clear(); f.calls.length = 0; await f.run(); assert.deepEqual(f.calls, channels);
  pass('失败期间源版本变化优先拒绝旧批次，不能把后续通道写到失效快照；新版本完整重跑');
}
{
  const f = coordinator(); await f.run(); f.calls.length = 0; f.edit(); await f.run(); assert.deepEqual(f.calls, channels);
  f.calls.length = 0; f.switchRoot(); await f.run(); assert.deepEqual(f.calls, channels);
  pass('成功通道缓存按原文指纹和目录隔离；源内容变化和切库都不复用旧回执');
}
{
  const f = coordinator(); f.failing.add('knowledge');
  let next = 0; const timers = new Map<number, () => void>(), errors: unknown[] = [];
  const queue = createDeferredNoteIndex({ run: f.run, onError: error => errors.push(error),
    schedule: work => { timers.set(++next, work); return next as any; }, cancel: timer => { timers.delete(timer as any); } });
  const fire = async () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(work => work()); await tick(); };
  queue.request(); await fire(); assert.equal(errors.length, 1); assert.equal(queue.isPending(), true); assert.equal(timers.size, 0);
  f.failing.clear(); f.calls.length = 0; queue.flush(); await fire(); assert.deepEqual(f.calls, ['knowledge']);
  assert.equal(queue.isPending(), false); assert.equal(timers.size, 0);
  pass('真实队列+协调器：部分失败保留待办、不自动忙重试；显式唤醒后仅补失败通道并清掉待办');
}
console.log(`note editing failure boundaries: ${checks} groups passed`);
