import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareLogicCheckSource } from '../src/services/textbook/noteContent';
import { parseWikiLink } from '../src/services/noteResolver';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows } from '../src/services/progressiveLearning/knowledgeProjection';

// Execute actual editor event handlers without rendering or loading any IO service.
const source = readFileSync('src/components/NoteEditor.tsx', 'utf8');
const ast = ts.createSourceFile('NoteEditor.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
function visit(node: ts.Node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(ast);
function run<T>(node: ts.Node, env: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${node.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), code)(...Object.values(env));
}
function variable(name: string) {
  const node = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name) as ts.VariableDeclaration;
  assert.ok(node?.initializer, `real handler ${name} exists`); return node.initializer;
}
let focused = '', open = true, position: unknown = { top: 1 }, dialog = false;
const buttons = ['auto', 'link', 'analysis'].map(name => ({ focus: () => {}, name }));
// Stable synthetic focus objects, not production browser/storage objects.
for (const button of buttons) button.focus = () => { focused = button.name; documentMock.activeElement = button; };
const documentMock = { activeElement: buttons[0], addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
const listeners = new Map<string, any>(), resizeListeners = new Map<string, any>();
const trigger = { focus: () => { focused = 'trigger'; }, contains: (node: unknown) => node === trigger };
const panel = { querySelector: () => buttons[0], querySelectorAll: () => buttons, contains: (node: unknown) => buttons.includes(node as any) };
const env = { document: documentMock, window: { addEventListener: (name: string, fn: any) => resizeListeners.set(name, fn), removeEventListener: (name: string) => resizeListeners.delete(name) },
  moreMenuRef: { current: panel }, moreBtnRef: { current: trigger }, moreOpen: true, isActive: true,
  setMoreOpen: (value: boolean) => { open = value; }, setMoreMenuPos: (value: unknown) => { position = value; }, hasActiveDialog: () => dialog };
const key = (name: string, extra = {}) => ({ key: name, currentTarget: panel, nativeEvent: {}, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra });
const handle = run<any>(variable('handleMoreMenuKey'), env);
handle(key('ArrowDown')); assert.equal(focused, 'link');
handle(key('End')); assert.equal(focused, 'analysis');
handle(key('ArrowDown')); assert.equal(focused, 'auto');
handle(key('ArrowUp')); assert.equal(focused, 'analysis');
handle(key('Home')); assert.equal(focused, 'auto');
for (const flags of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { defaultPrevented: true }]) {
  handle(key('ArrowDown', flags)); assert.equal(focused, 'auto');
}
const effect = nodes.find(n => ts.isArrowFunction(n) && ts.isCallExpression(n.parent) && n.parent.expression.getText(ast) === 'useEffect'
  && ts.isBlock(n.body) && n.body.getText(ast).includes('if (!isActive || !moreOpen) return;'));
assert.ok(effect);
const cleanup = run<any>(effect, env)(); assert.equal(focused, 'auto');
listeners.get('mousedown')({ target: buttons[1] }); assert.equal(open, true, 'portal items are inside the menu');
listeners.get('keydown')(key('Escape', { isComposing: true })); assert.equal(open, true);
dialog = true; listeners.get('keydown')(key('Escape')); assert.equal(open, true, 'dialog owns Escape');
dialog = false; listeners.get('keydown')(key('Escape')); assert.equal(open, false); assert.equal(position, null); assert.equal(focused, 'trigger');
open = true; listeners.get('mousedown')({ target: {} }); assert.equal(open, false);
open = true; resizeListeners.get('resize')(); assert.equal(open, false);
cleanup(); assert.equal(listeners.size, 0); assert.equal(resizeListeners.size, 0);
run<any>(effect, { ...env, isActive: false })();
assert.equal(listeners.size, 0, 'hidden menu cannot subscribe to keyboard or outside clicks');
run<any>(variable('closeMoreMenu'), env)(); assert.equal(focused, 'trigger');

const search = nodes.find(n => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.attributes.getText(ast).includes('aria-label="搜索或新建关联笔记"')) as ts.JsxOpeningElement;
assert.ok(search);
const enterAttribute = search.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onKeyDown') as ts.JsxAttribute;
const enter = (enterAttribute.initializer as ts.JsxExpression).expression!;
const created: string[] = [];
const enterHandler = run<any>(enter, { linkSearchQuery: '  新知识  ', handleCreateAndLinkNewNote: (title: string) => created.push(title) });
enterHandler(key('Enter', { nativeEvent: { isComposing: true } }));
enterHandler(key('Enter', { nativeEvent: { keyCode: 229 } }));
assert.equal(created.length, 0, 'IME confirmation cannot create/link');
enterHandler(key('Enter')); assert.deepEqual(created, ['新知识']);
assert.match(source, /useDialog\(isActive && showAddLinkModal, addLinkDialogRef/);
assert.match(source, /restoreLinkFocus\(\);\s*focusAfterLinkRef.current = true/);
assert.match(source, /role="dialog" aria-modal="true" aria-label="划词关联知识点"/);
assert.match(source, /useDialog\(isActive && argumentPanelOpen && narrowEditor, inspectorRef/);
assert.match(source, /useState\(\(\) => !narrowEditor\)/);
const css = readFileSync('src/index.css', 'utf8');
assert.match(css, /\.note-editor-body \{ flex: 1 0 240px; min-height: 240px; \}/,
  'short editor expands the whole body, not a clipped child');
assert.match(css, /\.note-editor-compose \.mdxeditor-toolbar \{ position: relative; top: auto;/,
  'toolbar outside body scroller cannot stick over an auto-scrolled reference');

const wikiSource = readFileSync('src/components/WikiLinkNode.tsx', 'utf8');
const wikiAst = ts.createSourceFile('WikiLinkNode.tsx', wikiSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const wiki = wikiAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'WikiLinkComponent')!;
const wikiCode = ts.transpileModule(`${wiki.getText(wikiAst)}\nreturn WikiLinkComponent;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const clicks: string[] = [];
const component = new Function('React', 'useCellValue', 'wikiLinkHandlers$', 'parseWikiLink', wikiCode)(
  { createElement: (_type: any, props: any) => props }, () => ({ onClick: (title: string) => clicks.push(title) }), {}, parseWikiLink);
const props = component({ title: '条件概率' });
for (const flags of [{ altKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) props.onKeyDownCapture(key('Enter', flags));
assert.equal(clicks.length, 0);
props.onKeyDownCapture(key('Enter')); props.onKeyDownCapture(key(' ')); assert.deepEqual(clicks, ['条件概率', '条件概率']);
assert.equal(props.title, '预览关联笔记：条件概率');

// Manual-activation tabs keep Alt+arrows available for page return.
const tabEnv = { document: documentMock };
const tabKey = run<any>(variable('handleInspectorTabKey'), tabEnv);
documentMock.activeElement = buttons[0]; focused = 'auto';
const tabEvent = (name: string, extra = {}) => key(name, { currentTarget: { querySelectorAll: () => buttons }, ...extra });
tabKey(tabEvent('ArrowLeft')); assert.equal(focused, 'analysis');
tabKey(tabEvent('Home')); assert.equal(focused, 'auto');
tabKey(tabEvent('End')); assert.equal(focused, 'analysis');
for (const flags of [{ altKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
  tabKey(tabEvent('ArrowRight', flags)); assert.equal(focused, 'analysis');
}
documentMock.activeElement = trigger as any;
tabKey(tabEvent('ArrowRight')); assert.equal(focused, 'analysis', 'close button does not own tab navigation');
assert.match(source, /role="tabpanel" id=\{`\$\{inspectorId\}-panel`\}/);

function actionHarness() {
  const leaf = { id: 'leaf', title: '原始标题', content: '原始正文', noteType: 'project', parentId: 'root',
    tags: ['原标签'], generatedContentBlocks: ['旧任务'] };
  const writes: any[] = [], toasts: string[] = [], markdown: string[] = [], requests: any[] = [];
  let analyzing = false, generating = false, analysis: any = null, error: any = null;
  const actionEnv: any = {
    note: leaf, allNotes: [leaf], content: leaf.content, title: leaf.title,
    isActiveRef: { current: true },
    actionScopeRef: { current: { mounted: true, version: 0 } },
    logicRequestRef: { current: null }, taskRequestRef: { current: null },
    recommendationRequestRef: { current: null }, resourceCheckRequestRef: { current: null }, resourcePickerRequestRef: { current: null },
    setIsRecommending: () => {}, setIsCheckingResources: () => {}, setIsChoosingResources: () => {},
    latestNoteRef: { current: leaf }, latestContentRef: { current: leaf.content }, allNotesRef: { current: [leaf] },
    AbortController, isLocalTypingRef: { current: false },
    mdxEditorRef: { current: { setMarkdown: (value: string) => markdown.push(value) } },
    moreBtnRef: { current: trigger },
    isLeafProjectNote: (id: string, notes: any[]) => !notes.some(item => item.parentId === id),
    buildAncestorTitles: () => ['根项目'], captureSelectionText: () => '',
    onUpdateNote: (value: any) => writes.push(value), setContent: () => {},
    setIsAnalyzing: (value: boolean) => { analyzing = value; }, setIsGeneratingTasks: (value: boolean) => { generating = value; },
    setLogicResult: (value: any) => { analysis = value; }, setLogicError: (value: any) => { error = value; },
    setLogicScopeNotice: () => {}, prepareLogicCheckSource,
    setToastMessage: (value: unknown) => { if (typeof value === 'string') toasts.push(value); },
    toastTimerRef: { current: null }, localTypingTimeoutRef: { current: null }, titleSaveTimerRef: { current: null }, clearTimeout, setTimeout: () => 1,
    callLLM: (input: any, options: any) => new Promise((resolve, reject) => requests.push({ input, resolve, reject, signal: options.signal })),
  };
  actionEnv.isCurrentAction = run<any>(variable('isCurrentAction'), actionEnv);
  actionEnv.showToast = run<any>(variable('showToast'), actionEnv);
  const scopeEffect = nodes.find(n => ts.isArrowFunction(n) && ts.isCallExpression(n.parent)
    && n.parent.expression.getText(ast) === 'useEffect' && n.getText(ast).includes('actionScopeRef.current.mounted = true'))!;
  assert.ok(scopeEffect);
  const cleanup = run<any>(scopeEffect, actionEnv)();
  return { env: actionEnv, requests, writes, toasts, markdown, cleanup,
    generate: run<any>(variable('handleGenerateStudyTasks'), actionEnv),
    analyze: run<any>(variable('handleLogicalAnalysis'), actionEnv),
    close: run<any>(variable('closeLogicalAnalysis'), actionEnv),
    stopTasks: run<any>(variable('stopTaskGeneration'), actionEnv),
    state: () => ({ analyzing, generating, analysis, error }) };
}
{
  const h = actionHarness(), job = h.generate();
  await h.generate(); assert.equal(h.requests.length, 1, 'same-frame generation is single-flight');
  h.env.latestContentRef.current = '等待时继续编辑的新正文';
  h.env.latestNoteRef.current = { ...h.env.note, title: '新标题', tags: ['新标签'], generatedContentBlocks: ['后来添加的任务'] };
  h.requests[0].resolve({ parsedJson: { tasks: ['验证假设'] } }); await job;
  assert.equal(h.writes[0].content, '- [ ] 验证假设\n\n等待时继续编辑的新正文');
  assert.equal(h.writes[0].title, '新标题'); assert.deepEqual(h.writes[0].tags, ['新标签']);
  assert.deepEqual(h.writes[0].generatedContentBlocks, ['后来添加的任务', '- [ ] 验证假设']);
  assert.equal(h.state().generating, false);
}
for (const mutation of ['switch', 'removed', 'became-parent', 'unmount', 'return-same-id']) {
  const h = actionHarness(), job = h.generate();
  if (mutation === 'switch') h.env.latestNoteRef.current = { id: 'other' };
  if (mutation === 'removed') h.env.allNotesRef.current = [];
  if (mutation === 'became-parent') h.env.allNotesRef.current.push({ id: 'child', parentId: 'leaf' });
  if (mutation === 'unmount' || mutation === 'return-same-id') {
    h.cleanup(); assert.equal(h.requests[0].signal.aborted, true);
    if (mutation === 'return-same-id') h.env.actionScopeRef.current.mounted = true;
  }
  h.requests[0].resolve({ parsedJson: { tasks: ['不应写入'] } }); await job;
  assert.equal(h.writes.length, 0, mutation); assert.equal(h.markdown.length, 0, mutation);
}
{
  const h = actionHarness();
  h.env.content = '旧React快照'; h.env.latestContentRef.current = '尚未重绘的最新正文';
  const job = h.analyze();
  assert.ok(h.requests[0].input.userInput.includes('尚未重绘的最新正文'));
  assert.ok(!h.requests[0].input.userInput.includes('旧React快照'));
  h.requests[0].resolve({ parsedJson: { summary: '合成分析' } }); await job;
}
{
  const h = actionHarness(), job = h.analyze(); await h.analyze();
  assert.equal(h.requests.length, 1); h.close(); assert.equal(h.requests[0].signal.aborted, true);
  const next = h.analyze(); assert.equal(h.requests.length, 2, 'closed operation permits a fresh request');
  h.requests[0].resolve({ parsedJson: { summary: '过时分析' } }); await job;
  assert.equal(h.state().analyzing, true, 'old finally cannot clear new waiting state');
  assert.equal(h.state().analysis, null);
  h.requests[1].resolve({ parsedJson: { summary: '本次分析' } }); await next;
  assert.equal(h.state().analysis.summary, '本次分析'); assert.equal(h.state().analyzing, false);
}
{
  const h = actionHarness(), job = h.generate(); h.stopTasks();
  assert.equal(h.requests[0].signal.aborted, true); assert.equal(h.state().generating, false);
  const next = h.generate(); h.requests[0].resolve({ parsedJson: { tasks: ['已停止的任务'] } }); await job;
  assert.equal(h.writes.length, 0); assert.equal(h.state().generating, true);
  h.requests[1].resolve({ parsedJson: { tasks: ['重新生成'] } }); await next;
  assert.equal(h.writes.length, 1);
}
{
  const h = actionHarness(), job = h.generate(); h.requests[0].reject(new Error('合成失败')); await job;
  assert.equal(h.writes.length, 0); assert.equal(h.state().generating, false); assert.ok(h.toasts.includes('合成失败'));
  const next = h.generate(); h.requests[1].resolve({ parsedJson: { tasks: ['重试'] } }); await next;
  assert.equal(h.writes.length, 1);
}
function resourceHarness() {
  const h = actionHarness(), jobs: any[] = [], stored: any[] = [];
  let shown = false, recommending = false, choosing = false, checking = false, error: any = null, notice: any = null;
  const env = h.env;
  Object.assign(env, {
    resourcesRef: { current: [] }, resourcePanelOpenRef: { current: true }, resourceState: { health: {} },
    normalizeResourceUrl: (url: string) => url.trim(),
    basename: (path: string) => path.split(/[\\/]/).at(-1), pathToFileUrl: (path: string) => `file:///${path.replaceAll('\\', '/')}`,
    detectLocalFileType: () => 'pdf',
    setResources: (value: any) => { env.resourcesRef.current = value; }, setResourceState: () => {},
    setShowResourcePanel: (value: boolean) => { shown = value; },
    setResourceError: (value: any) => { error = value; }, setResourceNotice: (value: any) => { notice = value; },
    setIsRecommending: (value: boolean) => { recommending = value; }, setIsChoosingResources: (value: boolean) => { choosing = value; },
    setIsCheckingResources: (value: boolean) => { checking = value; },
    onRecommendProjectResources: () => new Promise((resolve, reject) => jobs.push({ kind: 'recommend', resolve, reject })),
    checkResourceHealth: (url: string) => new Promise((resolve, reject) => jobs.push({ kind: 'check', url, resolve, reject })),
    storeResourceHealth: async (result: any) => { stored.push(result); return { health: {} }; },
    window: { electronAPI: { chooseLocalFiles: () => new Promise((resolve, reject) => jobs.push({ kind: 'picker', resolve, reject })) } },
  });
  return { ...h, jobs, stored, state: () => ({ shown, recommending, choosing, checking, error, notice }),
    add: run<any>(variable('handleAddLocalResource'), env), remove: run<any>(variable('handleDeleteResource'), env),
    recommend: run<any>(variable('handleResourceRecommendation'), env), check: run<any>(variable('handleCheckResources'), env) };
}
{
  const h = resourceHarness(), job = h.add(); await h.add();
  assert.equal(h.jobs.length, 1); assert.equal(h.state().choosing, true);
  h.env.latestContentRef.current = '附件等待时新正文';
  h.env.latestNoteRef.current = { ...h.env.note, title: '新标题', tags: ['新标签'] };
  h.env.resourcesRef.current = [{ title: '同时添加的引用', url: 'https://synthetic.invalid/new' }];
  h.jobs[0].resolve(['C:/synthetic/demo.pdf', 'C:/synthetic/demo.pdf', null, '']); await job;
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].content, '附件等待时新正文');
  assert.deepEqual(h.writes[0].tags, ['新标签']); assert.equal(h.writes[0].resources.length, 2);
  assert.equal(h.state().choosing, false);
  h.remove(h.writes[0].resources[1]); assert.equal(h.writes[1].resources.length, 1);
  assert.equal(h.writes[1].content, '附件等待时新正文'); assert.match(h.toasts.at(-1)!, /原文件未删除/);
  h.remove({ url: 'missing' }); assert.equal(h.writes.length, 2, 'remove by identity never removes the new item at an old index');
}
for (const mode of ['cancel', 'switch', 'unmount', 'removed', 'failure']) {
  const h = resourceHarness(), job = h.add();
  if (mode === 'switch') h.env.latestNoteRef.current = { id: 'other' };
  if (mode === 'unmount') h.cleanup();
  if (mode === 'removed') h.env.allNotesRef.current = [];
  if (mode === 'failure') h.jobs[0].reject(new Error('合成文件选择失败'));
  else h.jobs[0].resolve(mode === 'cancel' ? [] : ['C:/synthetic/demo.pdf']);
  await job; assert.equal(h.writes.length, 0, mode); assert.equal(h.state().shown, false, mode);
  if (mode === 'failure') assert.match(h.state().error, /合成文件选择失败/);
  else assert.equal(h.toasts.length, 0, mode);
}
{
  const h = resourceHarness(), job = h.add();
  h.env.resourcePanelOpenRef.current = false;
  h.jobs[0].resolve(['C:/synthetic/demo.pdf']); await job;
  assert.equal(h.writes.length, 1); assert.equal(h.state().shown, false, 'closing the drawer during a chooser does not reopen it');
}
{
  const h = resourceHarness(); h.env.resourcesRef.current = [{ title: '已有', url: 'https://synthetic.invalid/saved' }];
  await h.recommend(); assert.equal(h.jobs.length, 0, 'viewing saved resources does not search');
  const job = h.recommend(true); await h.recommend(true); assert.equal(h.jobs.length, 1);
  h.env.resourcePanelOpenRef.current = false;
  h.env.latestNoteRef.current = { ...h.env.note, resources: [{ title: '最新资源', url: 'https://synthetic.invalid/latest' }] };
  h.jobs[0].resolve({ status: 'workbench-opened', resources: [{ title: '未保存候选' }], message: '请在工作台确认' }); await job;
  assert.equal(h.env.resourcesRef.current[0].title, '最新资源'); assert.equal(h.toasts.length, 0);
  assert.equal(h.writes.length, 0, 'review result does not write candidates'); assert.equal(h.state().recommending, false);
}
for (const mode of ['switch', 'unmount', 'removed']) {
  const h = resourceHarness(), job = h.recommend(true);
  if (mode === 'switch') h.env.latestNoteRef.current = { id: 'other' };
  if (mode === 'unmount') h.cleanup();
  if (mode === 'removed') h.env.allNotesRef.current = [];
  h.jobs[0].resolve({ resources: [], message: '旧结果' }); await job;
  assert.equal(h.state().notice, null); assert.equal(h.toasts.length, 0);
}
{
  const h = resourceHarness(), job = h.recommend(true); h.jobs[0].reject(new Error('合成推荐失败')); await job;
  assert.equal(h.state().recommending, false); assert.match(h.state().error, /合成推荐失败/);
  const retry = h.recommend(true); h.jobs[1].resolve({ resources: [], message: '重试成功' }); await retry;
  assert.equal(h.state().error, null); assert.equal(h.state().notice, '重试成功');
}
{
  const h = resourceHarness(); h.env.resourcesRef.current = [
    { url: 'https://synthetic.invalid/a' }, { url: 'https://synthetic.invalid/a' },
    { url: 'file:///synthetic/local', kind: 'local' }, { url: 'https://synthetic.invalid/b' },
    { url: 'https://synthetic.invalid/c' }, { url: 'https://synthetic.invalid/d' },
  ];
  const job = h.check(); await h.check(); assert.equal(h.jobs.length, 3, 'deduplicated, single-flight batch');
  h.env.latestNoteRef.current = { id: 'other' };
  h.jobs.forEach(item => item.resolve({ url: item.url, status: 'available' })); await job;
  assert.equal(h.stored.length, 0, 'late checks cannot persist after changing note'); assert.equal(h.jobs.length, 3, 'no next batch');
}
{
  const h = resourceHarness(); h.env.resourcesRef.current = [{ url: 'https://synthetic.invalid/a' }];
  const job = h.check(); h.jobs[0].resolve({ url: h.jobs[0].url, status: 'available' }); await job;
  assert.equal(h.stored.length, 1); assert.equal(h.state().checking, false); assert.match(h.toasts.at(-1)!, /已复核 1/);
}
assert.match(source, /useDialog\(isActive && showResourcePanel, resourceDialogRef/);
assert.match(source, /isActive && showResourcePanel && createPortal/);
assert.match(source, /aria-label="关闭学习资源"/);
assert.match(css, /\.note-resource-panel \{ position: fixed/);
assert.match(readFileSync('src/components/useDialog.ts', 'utf8'), /event.isComposing \|\| event.keyCode === 229/);
console.log('PASS real note editor: menu/dialog/wiki/tab keyboard, IME, generation rebase/scope, resources single-flight/rebase/cancel/identity/late-result and viewport dialog; all services synthetic');
{
  const h = resourceHarness(), job = h.add();
  h.env.isActiveRef.current = false; h.env.resourcePanelOpenRef.current = false;
  h.jobs[0].resolve(['C:/synthetic/demo.pdf']); await job;
  assert.equal(h.writes.length, 1, 'accepted picker writes to the original note even when hidden');
  assert.equal(h.writes[0].id, 'leaf'); assert.equal(h.state().shown, false); assert.equal(h.toasts.length, 0);
  await h.add(); await h.recommend(true); await h.check();
  assert.equal(h.jobs.length, 1, 'inactive UI cannot initiate new IO');
}
{
  const h = actionHarness(), job = h.generate(); h.env.isActiveRef.current = false;
  h.requests[0].resolve({ parsedJson: { tasks: ['后台已确认的任务'] } }); await job;
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].id, 'leaf'); assert.equal(h.toasts.length, 0);
}
const inactiveEffect = nodes.find(n => ts.isArrowFunction(n) && ts.isCallExpression(n.parent) && n.parent.expression.getText(ast) === 'useEffect'
  && n.getText(ast).includes('setShowResourcePanel(false); setShowAddLinkModal(false); setPreviewingNote(null);'))!;
assert.ok(inactiveEffect);
const cleared: string[] = [];
const hiddenEnv = { isActive: false, setMoreOpen: () => cleared.push('menu'), setMoreMenuPos: () => {},
  setShowResourcePanel: () => cleared.push('resources'), setShowAddLinkModal: () => cleared.push('link'),
  setPreviewingNote: () => cleared.push('preview'), setToastMessage: () => cleared.push('toast'),
  focusAfterLinkRef: { current: true }, toastTimerRef: { current: null }, clearTimeout };
run<any>(inactiveEffect, hiddenEnv)(); assert.deepEqual(cleared, ['menu', 'resources', 'link', 'preview', 'toast']);
assert.equal(hiddenEnv.focusAfterLinkRef.current, false);
assert.match(source, /inert=\{!isActive\} aria-hidden=\{!isActive\}/);
console.log('PASS editor visibility: hidden branch retains accepted writes/drafts, cannot open portals/toasts/keyboard owners, and clears transient overlays without focusing');

// Execute the real external-update Effect and real input handler at the race
// boundary: background knowledge commits while the live editor is still typing.
const knowledgeRows = [{ title: '输入限制', summary: '先明确允许输入的范围。' }];
const localBody = '正在输入的未保存草稿';
const incomingBody = appendProjectKnowledgeRows(localBody, knowledgeRows);
const knowledgeNote = { id: 'knowledge-project', title: '项目', noteType: 'project', content: incomingBody, dueDates: [], resources: [] };
const knowledgeEnv = {
  note: knowledgeNote, isActive: true, readTextbook: false, title: knowledgeNote.title, content: localBody,
  prevNoteIdRef: { current: knowledgeNote.id }, previousActiveRef: { current: true },
  previousTaskCompletionRef: { current: JSON.stringify([knowledgeNote.id, []]) },
  isLocalTypingRef: { current: true }, localTypingTimeoutRef: { current: null },
  latestContentRef: { current: localBody }, latestNoteRef: { current: knowledgeNote },
  pendingKnowledgeRef: { current: { noteId: knowledgeNote.id, rows: [] as typeof knowledgeRows } },
  metadataDraftRef: { current: { patch: { tags: [], aliases: [] } } }, invalidAliasesDraftRef: { current: null },
  titleDraftRef: { current: { value: '项目', baseline: '项目' } }, editingNoteIdRef: { current: knowledgeNote.id },
  appendProjectKnowledgeRows, pendingProjectKnowledgeRows,
  mdxEditorRef: { current: { setMarkdown: () => { throw Error('cannot replace live document during typing'); } } },
  setContent: () => { throw Error('cannot reset live input snapshot during typing'); }, setResources: () => {},
};
const externalUpdate = nodes.find(n => ts.isArrowFunction(n) && ts.isCallExpression(n.parent) && n.parent.expression.getText(ast) === 'useEffect'
  && n.getText(ast).includes('const completionVersion = JSON.stringify'))!;
assert.ok(externalUpdate);
run<any>(externalUpdate, knowledgeEnv)();
assert.equal(knowledgeEnv.latestContentRef.current, incomingBody);
assert.deepEqual(knowledgeEnv.pendingKnowledgeRef.current.rows, knowledgeRows);
let typedBody = '';
const actualInput = run<any>(variable('handleContentChange'), { ...knowledgeEnv,
  onEditNote: (_id: string, patch: { content: string }) => { typedBody = patch.content; } });
actualInput(localBody + '继续输入');
assert.equal(typedBody, appendProjectKnowledgeRows(localBody + '继续输入', knowledgeRows));
assert.equal(knowledgeEnv.pendingKnowledgeRef.current.rows.length, 1, 'keep protecting the not-yet-imported append');
actualInput(typedBody);
assert.equal(knowledgeEnv.pendingKnowledgeRef.current.rows.length, 0, 'stop protecting after the editor catches up');
console.log('PASS background knowledge: actual editor Effect/input retain new links and live typing without replacing the IME document');
