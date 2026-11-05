import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { recalculateBacklinks } from '../src/services/noteMetadata';
import { enqueueLatestNotesSave } from '../src/services/ui/learningWriteQueue';
import { acknowledgedSaveState } from '../src/services/ui/saveFeedback';
import { NOTE_AUTOSAVE_IDLE_MS } from '../src/services/ui/noteAutosave';
import { applyNoteRenameReferences } from '../src/services/noteRename';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows } from '../src/services/progressiveLearning/knowledgeProjection';
import { createNoteEditorMetadataDraft, sameEditorMetadataList } from '../src/services/ui/noteEditorMetadataDraft';

// Actual App save handlers and editor acceptance effects, with synthetic notes
// and memory-only storage/timers. No Electron, private vault, or model calls.
let passed = 0, failed = 0;
async function check(label: string, work: () => void | Promise<void>) {
  try { await work(); console.log(`PASS ${++passed}: ${label}`); }
  catch (error) { failed++; console.error(`FAIL: ${label}\n${error instanceof Error ? error.stack : error}`); }
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function sourceFile(file: string) { return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX); }
function evaluate(text: string, env: Record<string, any>) {
  const js = ts.transpileModule(`return (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
function load(name: string, env: Record<string, any>, file = 'src/App.tsx') {
  const ast = sourceFile(file); let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      text = (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(ast);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(ast).replace(/^export\s+/u, '');
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(text, `missing real function ${name}`); return evaluate(text, env);
}
function variable(name: string, env: Record<string, any>, file = 'src/App.tsx') {
  const ast = sourceFile(file); let text = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) text = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }; visit(ast); assert.ok(text, `missing real variable ${name}`); return evaluate(text, env);
}
const publicationFile = 'src/services/ui/noteSnapshotPublication.ts';
function publication(name: string) {
  assert.ok(existsSync(publicationFile), 'the snapshot publication boundary must exist');
  return load(name, {}, publicationFile);
}
const makeNote = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, content: '合成正文', noteType: 'project',
  tags: [], aliases: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', ...extra });
function fixture() {
  let state = 'saved', paints = 0, clock = 0, shouldFail = false;
  let prepare: (notes: NoteItem[]) => Promise<NoteItem[]> = async notes => recalculateBacklinks(notes);
  const timers = new Map<number, { work: () => void; delay: number }>(), writes: NoteItem[][] = [], leases: boolean[] = [];
  const initial = [makeNote('project'), makeNote('knowledge', { noteType: 'knowledge' })];
  const env: Record<string, any> = {
    notesRef: { current: initial }, publishedNotesRef: { current: initial }, pendingNotesRef: { current: null },
    learningWriteQueueRef: { current: Promise.resolve() }, noteSaveRevisionRef: { current: 0 },
    personalOnlySaveRef: { current: null }, readingOnlySaveRef: { current: null }, saveTimerRef: { current: null },
    editingIndexLeaseRef: { current: false }, editingIdleTimerRef: { current: null }, editingActivityRef: { current: 0 },
    setNotes: (notes: NoteItem[]) => { paints++; env.publishedNotesRef.current = notes; },
    setNoteSaveState: (next: string) => { state = next; }, setNoteSaveError() {}, NOTE_AUTOSAVE_IDLE_MS,
    setTimeout: (work: () => void, delay: number) => { timers.set(++clock, { work, delay }); return clock; },
    clearTimeout: (id: number) => { timers.delete(id); },
    prepareNotesMetadata: async (notes: NoteItem[]) => prepare(notes),
    saveReadingPositionOnly: async () => false, savePersonalStateOnly: async () => false, acknowledgePersonalSave: () => null,
    saveAllNotesToStorage: async (notes: NoteItem[]) => { if (shouldFail) throw Error('synthetic disk unavailable'); writes.push(notes); },
    shouldPublishNoteSnapshot: existsSync(publicationFile) ? publication('shouldPublishNoteSnapshot') : undefined,
    enqueueLatestNotesSave, acknowledgedSaveState, applyNoteRenameReferences,
    setNoteIndexEditing: async (active: boolean) => { leases.push(active); }, requestNoteIndexRefresh: async () => {},
    indexNote: () => assert.fail('typing must not directly rebuild indexes'), console: { error() {} },
  };
  env.flushSave = load('flushSave', env);
  return { env, edit: load('handleEditNote', env), finish: load('handleFinishNoteEditing', env), writes, leases, timers,
    state: () => state, paints: () => paints, fail: (value: boolean) => { shouldFail = value; },
    prepare: (value: typeof prepare) => { prepare = value; } };
}

await check('纯正文自动保存只核销权威草稿，不广播全库React快照', async () => {
  const f = fixture(), published = f.env.publishedNotesRef.current;
  for (let i = 0; i < 100; i++) f.edit('project', { content: `持续输入${i}` });
  await f.env.flushSave(f.env.notesRef.current);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0][0].content, '持续输入99');
  assert.equal(f.env.notesRef.current[0].content, '持续输入99'); assert.equal(f.env.pendingNotesRef.current, null);
  assert.equal(f.state(), 'saved'); assert.equal(f.paints(), 0);
  assert.equal(f.env.publishedNotesRef.current, published); assert.equal(published[0].content, '合成正文');
});

await check('Wiki引用、反链和执行日期元数据变化仍立即发布', async () => {
  const f = fixture(); f.edit('project', { content: '[[knowledge]]\n- [ ] 学习 @due(2026-11-05)' });
  await f.env.flushSave(f.env.notesRef.current);
  assert.equal(f.paints(), 1); assert.equal(f.env.publishedNotesRef.current, f.env.notesRef.current);
  assert.deepEqual(f.env.notesRef.current[0].links, ['knowledge']); assert.deepEqual(f.env.notesRef.current[1].backlinks, ['project']);
  assert.equal(f.env.notesRef.current[0].dueDates.length, 1);
});

await check('迟到Worker回执不覆盖新输入、不清新dirty，也不把旧源广播回页面', async () => {
  const f = fixture(), worker = deferred();
  f.prepare(async notes => { await worker.promise; return recalculateBacklinks(notes); });
  f.edit('project', { content: '第一稿 [[knowledge]]' }); const first = f.env.flushSave(f.env.notesRef.current); await tick();
  f.edit('project', { content: '第二稿无关联' }); const latest = f.env.notesRef.current;
  worker.resolve(); await first;
  assert.equal(f.writes[0][0].content, '第一稿 [[knowledge]]'); assert.equal(f.env.notesRef.current, latest);
  assert.equal(f.env.pendingNotesRef.current, latest); assert.equal(f.state(), 'pending'); assert.equal(f.paints(), 0);
  await f.env.flushSave(latest); assert.equal(f.env.notesRef.current[0].content, '第二稿无关联');
  assert.equal(f.env.pendingNotesRef.current, null); assert.equal(f.state(), 'saved'); assert.equal(f.paints(), 0);
});

await check('磁盘失败保留可恢复草稿；重试纯正文成功不额外广播', async () => {
  const f = fixture(), published = f.env.publishedNotesRef.current;
  f.edit('project', { content: '故障后仍须保留的编辑' }); const draft = f.env.notesRef.current; f.fail(true);
  await assert.rejects(f.env.flushSave(draft), /synthetic disk unavailable/);
  assert.equal(f.env.notesRef.current, draft); assert.equal(f.env.pendingNotesRef.current, draft);
  assert.equal(f.env.publishedNotesRef.current, published); assert.equal(f.state(), 'error');
  f.fail(false); await f.env.flushSave(draft);
  assert.equal(f.env.pendingNotesRef.current, null); assert.equal(f.state(), 'saved'); assert.equal(f.paints(), 0);
});

await check('发布比较只忽略正文/更新时间，其余字段、顺序、增删和空库都保留通知', () => {
  const decide = publication('shouldPublishNoteSnapshot'), base = [makeNote('a'), makeNote('b')];
  assert.equal(decide(base, base), false);
  assert.equal(decide(base, base.map(note => ({ ...note, content: '另一正文', updatedAt: 'later' }))), false);
  const patches: Array<Partial<NoteItem>> = [
    { title: '重命名' }, { aliases: ['新别名'] }, { tags: ['新标签'] }, { links: ['关联'] }, { backlinks: ['反链'] },
    { parentId: 'new-parent' }, { dueDates: [{ id: 'new-task', completed: true } as any] },
    { planMeta: { dailyHours: 2 } as any }, { argumentDocs: [{ doc_id: 'new-argument' } as any] },
    { learningReviewRecords: [{ id: 'new-review' } as any] }, { resources: [{ id: 'new-resource' } as any] },
    { textbook: { revisionId: 'new-revision' } as any }, { textbookReadingState: { scrollTop: 77 } as any },
    { noteType: 'knowledge' }, { projectRole: 'reference' }, { isFavorite: true },
  ];
  for (const patch of patches) assert.equal(decide(base, [{ ...base[0], ...patch }, base[1]]), true, JSON.stringify(patch));
  assert.equal(decide(base, [...base].reverse()), true); assert.equal(decide(base, [base[0]]), true);
  assert.equal(decide(base, [...base, makeNote('c')]), true); assert.equal(decide(base, []), true);
  assert.equal(decide([], [makeNote('new')]), true); assert.equal(decide([], []), false);
});

function editorProps() {
  const ast = sourceFile('src/App.tsx'); let value: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node) => {
    if (!value && ts.isCallExpression(node) && node.expression.getText(ast) === 'React.createElement'
      && node.arguments[0]?.getText(ast) === 'NoteEditor' && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) value = node.arguments[1];
    ts.forEachChild(node, find);
  }; find(ast); assert.ok(value, 'main editor real props');
  return { ast, value };
}
function property(name: string, env: Record<string, any>) {
  const { ast, value } = editorProps();
  const prop = value.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === name) as ts.PropertyAssignment | undefined;
  assert.ok(prop, `main editor ${name}`); return evaluate(prop.initializer.getText(ast), env);
}
await check('可见编辑器在Agent/命令面板重绘时读取权威正文，而不是滞后的发布基线', () => {
  const stale = makeNote('project'), current = { ...stale, content: '已保存但未广播的新正文' };
  const env: Record<string, any> = { activeNoteId: current.id, notes: [stale], notesRef: { current: [current] },
    resolveEditorNote: existsSync(publicationFile) ? publication('resolveEditorNote') : undefined };
  env.activeNote = variable('activeNote', env);
  assert.equal(property('note', env), current); assert.equal(property('allNotes', env), env.notesRef.current);
  assert.equal(property('publication', env), env.notes, 'the stable published snapshot is a separate broadcast token');
  env.notesRef.current = []; env.activeNote = variable('activeNote', env);
  assert.equal(property('note', env), null, 'an authority-side deletion cannot resurrect the published note');
  assert.equal(publication('resolveEditorNote')([current], undefined), null);
  assert.equal(publication('resolveEditorNote')([current], 'missing'), null);
});

function acceptance(env: Record<string, any>) {
  const ast = sourceFile('src/components/NoteEditor.tsx'); let text = '';
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('const completionVersion')) text = node.arguments[0].getText(ast);
    ts.forEachChild(node, find);
  }; find(ast); assert.ok(text, 'real external acceptance effect'); return evaluate(text, env)();
}
function acceptanceFixture(note = makeNote('project')) {
  const imports: string[] = [], contents: string[] = [];
  const env: Record<string, any> = { note, content: note.content, title: note.title, isActive: true, readTextbook: false,
    latestContentRef: { current: note.content }, latestNoteRef: { current: note },
    previousActiveRef: { current: true }, prevNoteIdRef: { current: note.id }, isLocalTypingRef: { current: true },
    previousTaskCompletionRef: { current: JSON.stringify([note.id, []]) }, localTypingTimeoutRef: { current: null },
    pendingKnowledgeRef: { current: { noteId: note.id, rows: [] } }, appendProjectKnowledgeRows, pendingProjectKnowledgeRows,
    titleDraftRef: { current: { noteId: note.id, baseline: note.title, value: note.title } },
    metadataDraftRef: { current: createNoteEditorMetadataDraft(note) }, tagsText: '', aliasesText: '',
    invalidAliasesDraftRef: { current: null }, setAliasesError() {}, sameEditorMetadataList,
    splitAliasTokens: (text: string) => text.split(/[,，、；;]/).map(item => item.trim()).filter(Boolean),
    mdxEditorRef: { current: { setMarkdown: (content: string) => imports.push(content) } },
    setContent: (content: string) => contents.push(content), setTitle() {}, setResources() {}, setTagsText() {}, setAliasesText() {},
  };
  return { env, imports, contents, apply: () => acceptance(env) };
}
await check('真实编辑器焦点暂停/恢复不导入旧正文，外部改动和任务勾选仍能被接纳', () => {
  const f = acceptanceFixture(), latest = '持续编辑后的权威正文';
  f.env.latestContentRef.current = latest; f.env.latestNoteRef.current = { ...f.env.note, content: latest };
  f.env.note = { ...f.env.note, content: latest }; f.env.isActive = false; f.apply();
  f.env.isActive = true; f.apply(); assert.deepEqual(f.imports, []); assert.equal(f.env.latestContentRef.current, latest);
  f.env.note = { ...f.env.note, content: 'Agent明确写入的外部新版本' }; f.apply();
  assert.deepEqual(f.imports, ['Agent明确写入的外部新版本']);
  f.env.isLocalTypingRef.current = true; f.env.latestContentRef.current = '本地未发布且含勾选的正文';
  f.env.note = { ...f.env.note, content: '- [x] 已完成', dueDates: [{ id: 'task', completed: true }] }; f.apply();
  assert.equal(f.imports.at(-1), '- [x] 已完成'); assert.equal(f.env.latestContentRef.current, '- [x] 已完成');
});

await check('未编辑的键盘暂停不发布/不排索引；真实编辑结束保留发布和索引释放', async () => {
  const f = fixture(); f.finish(); await tick(); assert.equal(f.paints(), 0); assert.deepEqual(f.leases, []);
  f.edit('project', { content: '结束前的真实草稿' }); f.finish(); await tick();
  assert.equal(f.paints(), 1); assert.equal(f.env.publishedNotesRef.current[0].content, '结束前的真实草稿');
  assert.equal(f.env.pendingNotesRef.current, null); assert.deepEqual(f.leases, [true, false]);
});

function retainedFixture() {
  const refs: Array<{ current: any }> = []; let cursor = 0, creations = 0;
  const type = Symbol('real editor position');
  const env = {
    useRef(value?: any) { return refs[cursor++] ?? (refs[cursor - 1] = { current: value }); },
    React: { createElement(component: unknown, props: any) { creations++; return { type: component, key: props?.key ?? null, props }; } },
    NoteEditor: type, sameProps: load('sameProps', {}, 'src/components/RetainedNoteEditor.tsx'),
    shouldPublishNoteSnapshot: publication('shouldPublishNoteSnapshot'),
  };
  const component = load('RetainedNoteEditor', env, 'src/components/RetainedNoteEditor.tsx');
  return { render: (props: any) => { cursor = 0; return component(props); }, creations: () => creations, type };
}
await check('隐藏引用页只提交一次失活，保留同一编辑器/undo位置；重开接纳最新笔记和外部状态', () => {
  const f = retainedFixture(), original = makeNote('reference'), allNotes = [original];
  const props = { note: original, allNotes, isActive: true, isVisible: true };
  const active = f.render(props), hidden = f.render({ ...props, isActive: false, isVisible: false });
  assert.notEqual(hidden, active); assert.equal(hidden.props.isActive, false); assert.equal(hidden.props.isVisible, false);
  let latest = original;
  for (let index = 0; index < 50; index++) {
    latest = { ...original, content: `后台版本${index}`, argumentDocs: [{ doc_id: 'changed' } as any] };
    assert.equal(f.render({ ...props, note: latest, allNotes: [latest], isActive: false, isVisible: false }), hidden);
  }
  assert.equal(f.creations(), 2, 'hidden autosave/global metadata updates do not rebuild the editor subtree');
  const reopened = f.render({ ...props, note: latest, allNotes: [latest] });
  assert.equal(f.creations(), 3); assert.equal(reopened.type, active.type); assert.equal(reopened.key, active.key);
  assert.equal(reopened.props.note, latest); assert.equal(reopened.props.allNotes[0], latest);
  const removed = f.render({ ...props, note: null, allNotes: [], isActive: false, isVisible: false });
  assert.equal(removed.props.note, null, 'deleted hidden notes are invalidated rather than retained as editable ghosts');
});

await check('isVisible缺省沿用isActive；显式可见时Agent仅让出键盘，不冻结可见更新', () => {
  const f = retainedFixture(), note = makeNote('focus'), initial = { note, allNotes: [note] };
  const active = f.render(initial), implicitHidden = f.render({ ...initial, isActive: false });
  assert.notEqual(implicitHidden, active);
  const hiddenUpdate = f.render({ ...initial, note: { ...note, content: '暂时隐藏的新正文' }, isActive: false });
  assert.equal(hiddenUpdate, implicitHidden);
  const behindAgent = f.render({ ...initial, isActive: false, isVisible: true });
  const updated = { ...note, content: 'Agent侧明确写入的正文' };
  const refreshed = f.render({ ...initial, note: updated, allNotes: [updated], isActive: false, isVisible: true });
  assert.notEqual(refreshed, behindAgent); assert.equal(refreshed.props.note, updated);
  const awakened = f.render({ ...initial, note: updated, isActive: true, isVisible: true });
  assert.equal(awakened.type, active.type); assert.equal(awakened.key, active.key);
});

await check('隐藏页捕获回调保持最新实现、参数、Promise返回值及异常，不吞导航阻断', async () => {
  const f = retainedFixture(), note = makeNote('capture'); let invoked = '';
  const first = f.render({ note, isVisible: true, isActive: true,
    onEditNote: () => { invoked = 'old'; }, getTextbookReadingPosition: () => ({ scrollTop: 1 }) });
  const hidden = f.render({ note, isVisible: false, isActive: false,
    onEditNote: () => { invoked = 'deactivation'; }, getTextbookReadingPosition: () => ({ scrollTop: 2 }) });
  assert.equal(hidden.props.onEditNote, first.props.onEditNote, 'proxies keep plugin/capture callback identities stable');
  const promise = Promise.resolve('latest-return');
  assert.equal(f.render({ note, isVisible: false, isActive: false,
    onEditNote: (id: string, patch: any) => { invoked = `${id}:${patch.title}`; return promise; },
    getTextbookReadingPosition: () => ({ scrollTop: 88 }) }), hidden);
  assert.equal(hidden.props.onEditNote('capture', { title: '隐藏标题捕获' }), promise);
  assert.equal(invoked, 'capture:隐藏标题捕获'); assert.equal(hidden.props.getTextbookReadingPosition().scrollTop, 88);
  assert.equal(f.render({ note, isVisible: false, isActive: false,
    onEditNote: () => { throw Error('标题冲突，应阻断导航'); }, getTextbookReadingPosition: () => ({ scrollTop: 88 }) }), hidden);
  assert.throws(() => hidden.props.onEditNote('capture', {}), /标题冲突/);
  const capabilityRemoved = f.render({ note, isVisible: false, isActive: false,
    onEditNote: undefined, getTextbookReadingPosition: () => ({ scrollTop: 88 }) });
  assert.notEqual(capabilityRemoved, hidden, 'removing a capability must reach even a hidden editor capture');
  assert.equal(capabilityRemoved.props.onEditNote, undefined);
  const shown = f.render({ note, isVisible: true, isActive: true, onEditNote: undefined, onOpenDocument: undefined });
  assert.equal(shown.props.onEditNote, undefined); assert.equal(shown.props.onOpenDocument, undefined);
  assert.equal(first.props.onEditNote('capture', {}), undefined, 'removed callback does not call a stale writer');
  assert.equal(await promise, 'latest-return');
});

await check('可见页稳定函数代理/同值headingRequest复用元素，真实外部版本及位置变化仍更新', () => {
  const f = retainedFixture(), note = makeNote('stable'), allNotes = [note];
  const initial = { note, allNotes, isVisible: true, isActive: true, headingRequest: { key: 'a', heading: '概要' },
    contentVersion: 1, onEditNote() {} };
  const first = f.render(initial);
  assert.equal(f.render({ ...initial, headingRequest: { ...initial.headingRequest }, onEditNote() {} }), first);
  const next = f.render({ ...initial, contentVersion: 2 }); assert.notEqual(next, first);
  const heading = f.render({ ...initial, contentVersion: 2, headingRequest: { key: 'b', heading: '另一个锚点' } });
  assert.notEqual(heading, next);
  const changed = { ...note, learningReviewRecords: [{ id: 'external-review' } as any] };
  assert.notEqual(f.render({ ...initial, note: changed, allNotes: [changed] }), heading);
});

await check('相同publication下正文/回执变化不更换目录输入，重新获焦点或真实发布才接纳最新正文', () => {
  const f = retainedFixture(), original = makeNote('typing'), publication = [original];
  const initial = { note: original, allNotes: publication, publication, isActive: true, isVisible: true, saveState: 'saved' };
  const first = f.render(initial), edited = { ...original, content: 'Lexical当前已拥有的编辑' }, authority = [edited];
  const feedback = f.render({ ...initial, note: edited, allNotes: authority, saveState: 'pending' });
  assert.notEqual(feedback, first, 'feedback may render without replacing note/directory inputs');
  assert.equal(feedback.props.note, original); assert.equal(feedback.props.allNotes, publication);
  assert.equal(feedback.props.saveState, 'pending'); assert.equal('publication' in feedback.props, false);
  const saved = f.render({ ...initial, note: edited, allNotes: authority });
  assert.equal(saved.props.note, original); assert.equal(saved.props.allNotes, publication);
  const behindAgent = f.render({ ...initial, note: edited, allNotes: authority, isActive: false });
  assert.equal(behindAgent.props.note, edited); assert.equal(behindAgent.props.allNotes, authority);
  const later = { ...edited, content: '另一实例的新内容' };
  const returnFocus = f.render({ ...initial, note: later, allNotes: [later] });
  assert.equal(returnFocus.props.note, later, 'keyboard reactivation receives authority and cannot import the old published body');
  const published = f.render({ ...initial, note: later, allNotes: [later], publication: [later] });
  assert.equal(published.props.note, later);
});

await check('相同publication不能吞掉外部强制正文刷新、元数据或笔记身份变更', () => {
  const f = retainedFixture(), original = makeNote('version'), publication = [original];
  const initial = { note: original, allNotes: publication, publication, isActive: true, isVisible: true, contentVersion: 1 };
  f.render(initial);
  const external = { ...original, content: '强制接纳的AI正文' };
  const forced = f.render({ ...initial, note: external, allNotes: [external], contentVersion: 2 });
  assert.equal(forced.props.note, external, 'the forced-refresh effect must receive the new authority body');
  const metadata = { ...external, aliases: ['外部新别名'] };
  assert.equal(f.render({ ...initial, note: metadata, allNotes: [metadata], contentVersion: 2 }).props.note, metadata);
  const another = makeNote('another');
  assert.equal(f.render({ ...initial, note: another, allNotes: [another] }).props.note, another);
});

await check('仅publication收据变化仍核销token，之后纯正文输入不会恢复整库推送', () => {
  const f = retainedFixture(), note = makeNote('receipt'), allNotes = [note], firstToken = [note], nextToken = [note];
  const initial = { note, allNotes, publication: firstToken, isActive: true, isVisible: true };
  const first = f.render(initial);
  assert.equal(f.render({ ...initial, publication: nextToken }), first, 'a receipt alone need not render the inner editor');
  const edited = { ...note, content: '收据核销后的新输入' };
  const typing = f.render({ ...initial, note: edited, allNotes: [edited], publication: nextToken, saveState: 'pending' });
  assert.equal(typing.props.note, note); assert.equal(typing.props.allNotes, allNotes);
});

await check('隐藏标题捕获仍合并最新外部字段；晚到回调不能重建已删笔记', () => {
  const app = fixture(), f = retainedFixture(), source = app.env.notesRef.current[0];
  const initial = { note: source, allNotes: app.env.notesRef.current, isActive: true, isVisible: true, onEditNote: app.edit };
  f.render(initial); const hidden = f.render({ ...initial, isActive: false, isVisible: false });
  const latest = { ...source, resources: [{ id: 'new-background-resource' } as any], argumentDocs: [{ doc_id: 'new-graph' } as any] };
  app.env.notesRef.current = [latest, app.env.notesRef.current[1]];
  assert.equal(f.render({ ...initial, note: latest, allNotes: app.env.notesRef.current, isActive: false, isVisible: false,
    onEditNote: (id: string, patch: any) => app.edit(id, patch) }), hidden);
  hidden.props.onEditNote(source.id, { title: '捕获后的新标题' });
  assert.equal(app.env.notesRef.current[0].title, '捕获后的新标题');
  assert.equal(app.env.notesRef.current[0].resources[0].id, 'new-background-resource');
  assert.equal(app.env.notesRef.current[0].argumentDocs[0].doc_id, 'new-graph');
  app.env.notesRef.current = app.env.notesRef.current.filter((note: NoteItem) => note.id !== source.id);
  hidden.props.onEditNote(source.id, { title: '删除后晚到的标题' });
  assert.equal(app.env.notesRef.current.some((note: NoteItem) => note.id === source.id), false);
});

await check('主编辑器和引用编辑器均接收独立publication；引用目录读权威源并保持预览隔离', () => {
  const ast = sourceFile('src/App.tsx'), editors: ts.ObjectLiteralExpression[] = [];
  let context: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'React.createElement'
      && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      if (node.arguments[0]?.getText(ast) === 'NoteEditor') editors.push(node.arguments[1]);
      if (node.arguments[0]?.getText(ast) === 'ContextNotePages') context = node.arguments[1];
    }
    ts.forEachChild(node, find);
  }; find(ast); assert.equal(editors.length, 2); assert.ok(context);
  const stale = makeNote('reference'), current = { ...stale, content: '最新权威引用正文' }, preview = makeNote('preview');
  const env = { notes: [stale], notesRef: { current: [current] }, isPlanPreviewDemo: false,
    isSceneS1Demo: false, planPreviewNotes: [preview], SCENE_S1_DEMO_NOTES: [] as NoteItem[] };
  const extract = (object: ts.ObjectLiteralExpression, name: string) => {
    const prop = object.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === name) as ts.PropertyAssignment | undefined;
    assert.ok(prop, name); return evaluate(prop.initializer.getText(ast), env);
  };
  for (const editor of editors) {
    assert.equal(extract(editor, 'allNotes'), env.notesRef.current);
    assert.equal(extract(editor, 'publication'), env.notes);
  }
  const get = extract(context, 'getNote'); assert.equal(get(stale.id), current); assert.equal(get('missing'), null);
  env.notesRef.current = []; assert.equal(get(stale.id), null, 'deleted references are not restored from lagging publication');
  env.isPlanPreviewDemo = true; const demoGet = extract(context, 'getNote');
  assert.equal(demoGet(preview.id), preview); assert.equal(demoGet(stale.id), null, 'demo preview cannot leak into real notes');
});

console.log(`note snapshot isolation: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
