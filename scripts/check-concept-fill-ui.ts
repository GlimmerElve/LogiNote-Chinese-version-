import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { prepareConceptNoteWrite } from '../src/services/ui/conceptNoteWrite';
import { conceptFillFailureFeedback, conceptFillFailureReason } from '../src/services/ui/conceptFillFeedback';
import { safeLlmHttpError } from '../src/services/llmHttpFailure';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { searchConceptEvidence } from '../src/electron/conceptWebResearch';
import { prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation } from '../src/services/conceptAugmentation';
import { CONCEPT_AUGMENTATION_PROMPT } from '../src/workflows/conceptGenerationPrompt';
import { normalizeConceptCitationMarkers as normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList } from '../src/services/conceptCitationMarkers';

globalThis.fetch = async () => assert.fail('Concept UI regression must not use network');
function runtime() {
  const slots: any[] = [], effects: any[] = []; let cursor = 0;
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return `concept-${cursor++}`; },
    useEffect(fn: () => any, deps: any[]) { const i = cursor++; if (!effects[i] || deps.some((v, j) => v !== effects[i].deps[j])) effects[i] = { deps, fn, pending: true, cleanup: effects[i]?.cleanup }; },
  };
  return { ...hooks, begin() { cursor = 0; }, flush() { effects.forEach(e => { if (e?.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } }); }, unmount() { effects.forEach(e => e?.cleanup?.()); } };
}
function compile(path: string, bindings: any, names: string[]) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
  const js = ts.transpileModule(`${code}\nreturn { ${names.join(', ')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const defer = () => { let resolve!: (value: any) => void, reject!: (error: any) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const button = (tree: any, label: string) => { const found = flat(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label)); assert.ok(found, label); return found; };
const icons = Object.fromEntries(['BookOpenText', 'ExternalLink', 'FileText', 'FolderSearch', 'Globe2', 'Layers3', 'Loader2', 'ShieldCheck', 'Sparkles', 'Square', 'X'].map(name => [name, () => null]));
const note: any = { id: 'concept', noteType: 'knowledge', title: '条件概率', content: 'original', updatedAt: 'old', tags: ['retain'] };
const draft = { content: '# 条件概率\n\n草稿 [1]', references: [{ sourceId: '1', type: 'web', title: '合成来源', url: 'https://example.invalid/evidence' }, { sourceId: '2', title: 'unsafe', url: 'javascript:alert(1)' }] };
const state = runtime(); const doc: any = { body: {}, activeElement: null }; doc.activeElement = doc.body;
const browserWindow: any = {};
let dialogClose: (() => void) | undefined, generation = defer(), writes = defer(), calls = 0, saves = 0, closed = 0, signal: AbortSignal | undefined;
const ui = compile('src/components/ConceptFillModal.tsx', { ...state, React, ...icons, document: doc, window: browserWindow, conceptFillFailureFeedback,
  useDialog(_open: any, _ref: any, close: any) { dialogClose = close; },
  generateConcept(_note: any, _source: any, options: any) { assert.equal(_note.content, 'original'); assert.equal(options.mode, 'augment', 'nonempty body requests additive generation'); calls++; signal = options.signal; options.onStage('generating'); return generation.promise; },
}, ['ConceptFillModal']);
const props: any = { note, onClose() { closed++; }, onConfirm(content: string) { assert.equal(content, draft.content); saves++; return writes.promise; } };
const render = () => { state.begin(); const tree = ui.ConceptFillModal(props); state.flush(); return tree; };
let tree = render(); button(tree, '检索并生成').props.onClick(); button(tree, '检索并生成').props.onClick(); assert.equal(calls, 1);
tree = render(); assert.match(text(tree), /证据已读取/); button(tree, '停止研究').props.onClick(); assert.equal(signal?.aborted, true);
tree = render(); assert.match(text(tree), /不会继续生成或写入/); const old = generation; generation = defer(); button(tree, '检索并生成').props.onClick(); old.resolve({ content: 'late draft' }); await settle(); assert.doesNotMatch(text(render()), /late draft/);
generation.resolve(draft); await settle(); tree = render(); assert.match(text(tree), /草稿 \[1\]/);
const links = flat(tree).filter(node => node.type === 'a'); assert.equal(links.length, 1); assert.equal(links[0].props.rel, 'noopener noreferrer');
let prevented = 0; await links[0].props.onClick({ preventDefault() { prevented++; } }); assert.equal(prevented, 0, 'browser anchor remains usable');
browserWindow.electronAPI = { openExternal: async () => { throw new Error('private path'); } };
await links[0].props.onClick({ preventDefault() { prevented++; } }); tree = render(); assert.equal(prevented, 1); assert.match(text(tree), /来源未能打开/); assert.doesNotMatch(text(tree), /private path/);
const confirm = button(tree, '确认写入笔记').props.onClick; confirm(); confirm(); assert.equal(saves, 1); tree = render(); dialogClose!(); assert.equal(closed, 0); assert.equal(button(tree, '取消').props.disabled, true);
writes.reject(new Error('filesystem secret')); await settle(); tree = render(); assert.match(text(tree), /写入未完成，草稿已保留/); assert.doesNotMatch(text(tree), /filesystem secret/); assert.match(text(tree), /草稿 \[1\]/);
writes = defer(); button(tree, '确认写入笔记').props.onClick(); assert.equal(calls, 2, 'save retry does not regenerate'); writes.resolve(undefined); await settle(); assert.equal(closed, 1); dialogClose!(); assert.equal(closed, 1);
// Unmounted replies cannot close another page.
state.unmount();
// Existing one-line notes and empty placeholders intentionally choose different
// service modes. Merely opening/canceling either cannot save or modify undo.
for (const content of ['', '   ', '请对该知识点进行定义描述']) {
  const emptyState = runtime(); let emptyClosed = 0, emptyCalls = 0;
  const emptyUi = compile('src/components/ConceptFillModal.tsx', { ...emptyState, React, ...icons, document: doc, window: {}, useDialog() {}, conceptFillFailureFeedback,
    generateConcept(_note: any, _source: any, options: any) { assert.equal(options.mode, undefined, 'empty/placeholder retains the legacy fill protocol'); emptyCalls++; return Promise.resolve(draft); },
  }, ['ConceptFillModal']);
  const emptyProps = { note: { ...note, content }, onClose() { emptyClosed++; }, onConfirm: async () => assert.fail('cancel never writes') };
  emptyState.begin(); const emptyTree = emptyUi.ConceptFillModal(emptyProps); emptyState.flush();
  button(emptyTree, '检索并生成').props.onClick(); await settle();
  emptyState.begin(); const finalTree = emptyUi.ConceptFillModal(emptyProps); emptyState.flush();
  button(finalTree, '取消').props.onClick(); assert.equal(emptyCalls, 1); assert.equal(emptyClosed, 1); emptyState.unmount();
}
const lateState = runtime(), lateGate = defer(); let lateClosed = 0, lateSignal: AbortSignal | undefined;
const lateUi = compile('src/components/ConceptFillModal.tsx', { ...lateState, React, ...icons, document: doc, window: {}, useDialog() {}, conceptFillFailureFeedback,
  generateConcept(_note: any, _source: any, options: any) { lateSignal = options.signal; return lateGate.promise; },
}, ['ConceptFillModal']);
lateState.begin(); const lateTree = lateUi.ConceptFillModal({ note, onClose() { lateClosed++; }, onConfirm: async () => assert.fail('unmounted generation cannot save') }); lateState.flush();
button(lateTree, '检索并生成').props.onClick(); lateState.unmount(); assert.equal(lateSignal?.aborted, true); lateGate.resolve(draft); await settle(); assert.equal(lateClosed, 0);

// Failure text must describe actual state, not invent a hidden draft cache.
const feedbackState = runtime(); let feedbackGate = defer(), feedbackCloses = 0, feedbackWrites = 0;
const feedbackUi = compile('src/components/ConceptFillModal.tsx', { ...feedbackState, React, ...icons, document: doc, window: {}, useDialog() {}, conceptFillFailureFeedback,
  generateConcept() { return feedbackGate.promise; },
}, ['ConceptFillModal']);
const feedbackRender = () => { feedbackState.begin(); const node = feedbackUi.ConceptFillModal({ note,
  onClose() { feedbackCloses++; }, onConfirm: async () => { feedbackWrites++; } }); feedbackState.flush(); return node; };
let feedbackTree = feedbackRender(); button(feedbackTree, '检索并生成').props.onClick();
feedbackGate.reject(new Error('没有检索到可公开访问且内容足够的概念来源')); await settle(); feedbackTree = feedbackRender();
assert.match(text(feedbackTree), /没有检索到可公开访问且内容足够的概念来源/);
assert.match(text(feedbackTree), /本次未生成可用草稿，没有新增草稿缓存/);
assert.doesNotMatch(text(feedbackTree), /已有草稿未被清除|上一份草稿仍/);
assert.equal(button(feedbackTree, '确认写入笔记').props.disabled, true);
assert.equal(flat(feedbackTree).filter(node => node.type === 'pre').length, 0);
feedbackGate = defer(); button(feedbackTree, '检索并生成').props.onClick(); feedbackGate.resolve(draft); await settle(); feedbackTree = feedbackRender();
assert.match(text(feedbackTree), /仅保留当前一份草稿/);
const staleClear = button(feedbackTree, '清除草稿').props.onClick;
feedbackGate = defer(); button(feedbackTree, '重新检索并生成').props.onClick(); staleClear();
assert.equal(button(feedbackRender(), '清除草稿').props.disabled, true);
feedbackGate.reject(safeLlmHttpError(429, 'provider private body')); await settle(); feedbackTree = feedbackRender();
assert.match(text(feedbackTree), /模型服务触发了请求频率限制/);
assert.match(text(feedbackTree), /上一份草稿仍在下方“概念草稿”区域/);
assert.equal(flat(feedbackTree).filter(node => node.type === 'pre').length, 1);
assert.equal(button(feedbackTree, '确认写入笔记').props.disabled, false);
feedbackGate = defer(); button(feedbackTree, '重新检索并生成').props.onClick();
feedbackGate.resolve({ ...draft, content: '# 新草稿\n\n新结果覆盖旧结果 [1]' }); await settle(); feedbackTree = feedbackRender();
assert.equal(flat(feedbackTree).filter(node => node.type === 'pre').length, 1);
assert.doesNotMatch(text(feedbackTree), /草稿 \[1\]/);
button(feedbackTree, '清除草稿').props.onClick(); feedbackTree = feedbackRender();
assert.match(text(feedbackTree), /已清除当前草稿和引用，笔记未修改/);
assert.equal(flat(feedbackTree).filter(node => node.type === 'pre' || node.type === 'a').length, 0);
assert.equal(button(feedbackTree, '确认写入笔记').props.disabled, true);
assert.equal(feedbackWrites, 0); assert.equal(feedbackCloses, 0);
button(feedbackTree, '取消').props.onClick(); assert.equal(feedbackCloses, 1); feedbackState.unmount();
assert.equal(conceptFillFailureReason(new Error("Error invoking remote method 'concept-research:search': Error: 搜索页面加载超时")), '搜索页面加载超时');
assert.match(conceptFillFailureReason(new Error('搜索引擎返回了 7 个候选，但没有页面完整命中“术语”或已登记别名')), /未完整匹配/);
assert.match(conceptFillFailureReason(new Error('已找到 3 个候选，但隔离浏览器未能读取到足够正文')), /未取得足够正文/);
for (const hidden of ['EPERM C:\\private\\draft.json', 'api_key=secret-token', 'private model response', '未知错误：正文及画像不应显示']) {
  const diagnostic = conceptFillFailureFeedback(new Error(hidden), false);
  assert.doesNotMatch(diagnostic, /private|secret-token|正文及画像/);
}
const next = prepareConceptNoteWrite({ ...note, title: 'new title', tags: ['new metadata'] }, note, draft.content, draft.references as any);
assert.equal(next.title, 'new title'); assert.deepEqual(next.tags, ['new metadata']); assert.equal(next.content, draft.content);
assert.throws(() => prepareConceptNoteWrite({ ...note, content: 'user edits' }, note, draft.content), /未覆盖/);
assert.throws(() => prepareConceptNoteWrite({ ...note, referenceSources: [{ title: 'user citation' }] }, note, draft.content), /未覆盖/);
assert.throws(() => prepareConceptNoteWrite({ ...note, id: 'other' }, note, draft.content), /目标已变化/);
assert.equal(prepareConceptNoteWrite(next, note, draft.content, draft.references as any).content, draft.content, 'failed-save retry can persist the same draft');
assert.equal(note.content, 'original', 'pure preparation never mutates input');

// Execute production evidence/model cancellation through synthetic dependencies.
let search = defer(), model = defer(), modelCalls = 0; const stages: string[] = [];
const service = compile('src/services/conceptFillService.ts', { window: { electronAPI: { conceptResearch: { search: () => search.promise } } },
  searchDocuments: async () => [], searchNotes: async () => [], callLLM: async (_request: any, options: any) => { assert.ok(options.signal); modelCalls++; return model.promise; },
  prepareConceptAugmentation, numberAugmentationEvidence, composeConceptAugmentation, CONCEPT_AUGMENTATION_PROMPT, normalizeConceptCitationMarkersProtected, extractConceptCitationIdsProtected, stripConceptModelSourceList,
}, ['generateConcept']);
const abort = new AbortController(); const job = service.generateConcept(note, 'browser', { signal: abort.signal, onStage: (s: string) => stages.push(s) });
abort.abort(); await assert.rejects(job, { name: 'AbortError' }); search.resolve([{ type: 'web', title: 'source', snippet: 'evidence' }]); await settle(); assert.equal(modelCalls, 0);
const stopped = new AbortController(); stopped.abort(); await assert.rejects(service.generateConcept(note, 'rag', { signal: stopped.signal }), { name: 'AbortError' });
search = defer(); model = defer(); const mid = new AbortController(); const running = service.generateConcept(note, 'browser', { signal: mid.signal }); search.resolve([{ type: 'web', title: 'source', snippet: 'evidence' }]); await settle(); assert.equal(modelCalls, 1); mid.abort(); model.resolve({ content: 'late [1]' }); await assert.rejects(running, { name: 'AbortError' });

const requestIds: string[] = [], cancellations: string[] = [], cancellableGate = defer();
const cancellableService = compile('src/services/conceptFillService.ts', { window: { electronAPI: { conceptResearch: {
  search: (_title: string, _aliases: string[], id: string) => { requestIds.push(id); return cancellableGate.promise; },
  cancel: async (id: string) => { cancellations.push(id); cancellableGate.reject(new DOMException('Stopped', 'AbortError')); return true; },
} } }, searchDocuments: async () => [], searchNotes: async () => [], callLLM: async () => assert.fail('cancelled retrieval cannot start model'),
}, ['generateConcept']);
const retrievalStop = new AbortController(), retrieving = cancellableService.generateConcept(note, 'browser', { signal: retrievalStop.signal });
retrievalStop.abort(); await assert.rejects(retrieving, { name: 'AbortError' }); await settle();
assert.equal(requestIds.length, 1); assert.deepEqual(cancellations, requestIds);

// Execute actual main-process IPC handlers with the real route helper. No app,
// credentials or network: only the provider's pending transport is replaced.
const hostAst = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
const hostHandlers: Record<string, ts.Node> = {};
function findResearchHandlers(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(hostAst) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0])
    && ['concept-research:search', 'concept-research:cancel'].includes(node.arguments[0].text)) hostHandlers[node.arguments[0].text] = node.arguments[1];
  ts.forEachChild(node, findResearchHandlers);
} findResearchHandlers(hostAst);
const ownedRequests = new Map<string, AbortController>(); let fallbackBrowsers = 0, researchApiCalls = 0;
const pendingApi = { search: async (_query: string, _workflow: string, options: { signal?: AbortSignal }) => {
  researchApiCalls++; return new Promise<never>((_, reject) => { options.signal!.throwIfAborted(); options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }); });
}, fetchPage: async () => null };
const hostBindings: any = { conceptResearchRequests: ownedRequests, randomUUID, mainWindow: null,
  searchConceptEvidence: (term: string, aliases: string[], browser: any, _api: unknown, signal: AbortSignal) => searchConceptEvidence(term, aliases, browser, pendingApi, signal),
  searchConceptEvidenceInBrowser: async () => { fallbackBrowsers++; return []; },
};
const hostHandler = (name: string) => new Function(...Object.keys(hostBindings), ts.transpileModule(`return ${hostHandlers[name].getText(hostAst)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText)(...Object.values(hostBindings));
const hostSearch = hostHandler('concept-research:search'), hostCancel = hostHandler('concept-research:cancel');
const sender = Object.assign(new EventEmitter(), { id: 901 }), otherSender = Object.assign(new EventEmitter(), { id: 902 });
const requestId = randomUUID(), hostJob = hostSearch({ sender }, '心理账户', [], requestId);
await settle(); assert.equal(researchApiCalls, 1); assert.equal(ownedRequests.size, 1);
assert.equal(await hostCancel({ sender: otherSender }, requestId), false); assert.equal(ownedRequests.values().next().value!.signal.aborted, false);
await assert.rejects(hostSearch({ sender }, '心理账户', [], requestId), /正在执行/u);
assert.equal(await hostCancel({ sender }, requestId), true); await assert.rejects(hostJob, { name: 'AbortError' });
assert.equal(fallbackBrowsers, 0); assert.equal(ownedRequests.size, 0); assert.equal(sender.listenerCount('destroyed'), 0);
assert.equal(await hostCancel({ sender }, requestId), false);
const closingJob = hostSearch({ sender }, '心理账户', [], randomUUID()); await settle(); sender.emit('destroyed');
await assert.rejects(closingJob, { name: 'AbortError' }); assert.equal(ownedRequests.size, 0); assert.equal(fallbackBrowsers, 0);
await assert.rejects(hostSearch({ sender }, '心理账户', [], '../invalid'), /编号无效/u);
console.log('PASS real renderer Stop→owned main IPC cancellation→API abort, zero browser fallback/model call; wrong window and duplicate requests rejected, close cleans listeners/map');

// Actual Agent handler must defer replacement without touching the existing input.
const panel = readFileSync('src/components/AgentPanel.tsx', 'utf8'); const ast = ts.createSourceFile('AgentPanel.tsx', panel, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const handlers: Record<string, ts.VariableDeclaration> = {};
function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && ['useAcceptancePrompt', 'replacePendingInput'].includes(node.name.getText(ast))) handlers[node.name.getText(ast)] = node; ts.forEachChild(node, visit); } visit(ast);
const replacements: any[] = [], inputs: any[] = [];
const bindings: any = { useCallback: (fn: any) => fn, input: 'unsent draft', pendingApproval: null, requestBusyRef: { current: false }, busy: false,
  pendingInputReplacement: 'new instruction', setAuditOpen() {}, setError() {}, setInput(value: any) { inputs.push(value); }, setPendingInputReplacement(value: any) { replacements.push(value); }, inputRef: { current: null }, requestAnimationFrame: (fn: any) => fn() };
const extract = (name: string) => new Function(...Object.keys(bindings), ts.transpileModule(`return ${handlers[name].initializer!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(bindings));
extract('useAcceptancePrompt')('new instruction'); assert.deepEqual(inputs, []); assert.deepEqual(replacements, ['new instruction']);
extract('replacePendingInput')(); assert.deepEqual(inputs, ['new instruction']);
bindings.requestBusyRef.current = true; extract('replacePendingInput')(); assert.equal(inputs.length, 1, 'pending execution forbids replacement');
const { AgentPromptReplacement } = compile('src/components/AgentPromptReplacement.tsx', { React }, ['AgentPromptReplacement']);
let kept = 0, replaced = 0; const replacementTree = AgentPromptReplacement({ prompt: 'new', busy: true, onKeep() { kept++; }, onReplace() { replaced++; } });
button(replacementTree, '保留原输入').props.onClick(); assert.equal(kept, 1); assert.equal(button(replacementTree, '替换输入').props.disabled, true); assert.equal(replaced, 0);
// Verify App uses the acknowledged writer, not the delayed optimistic update path.
const app = readFileSync('src/App.tsx', 'utf8');
assert.doesNotMatch(readFileSync('src/components/NoteEditor.tsx', 'utf8'), /onOpenConceptFill|>\s*概念补全\s*</u, 'no duplicate concept-fill header button or obsolete callback');
assert.doesNotMatch(app, /onOpenConceptFill\s*:/u, 'App no longer passes the removed header-button callback');
const appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX); let confirmHandler: ts.ArrowFunction | undefined, openHandler: ts.FunctionDeclaration | undefined;
function findConfirm(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleOpenConceptFill') openHandler = node;
  if (ts.isCallExpression(node) && node.expression.getText(appAst) === 'React.createElement' && node.arguments[0]?.getText(appAst) === 'ConceptFillModal') {
    const properties = (node.arguments[1] as ts.ObjectLiteralExpression).properties;
    const property = properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(appAst) === 'onConfirm') as ts.PropertyAssignment;
    confirmHandler = property.initializer as ts.ArrowFunction;
  }
  ts.forEachChild(node, findConfirm);
} findConfirm(appAst); assert.ok(confirmHandler); assert.ok(openHandler);
let appWrites = 0, flushes = 0; const appGate = defer();
const latestNotes = { current: [{ ...note, tags: ['latest'] }] };
const actualConfirm = new Function('conceptFillNote', 'flushPendingChanges', 'notesRef', 'prepareConceptNoteWrite', 'commitSelectedKnowledgeChange', ts.transpileModule(`return ${confirmHandler!.getText(appAst)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
  note, async () => { flushes++; }, latestNotes, prepareConceptNoteWrite, async (change: any) => { assert.equal(flushes, 1); assert.equal(change.kind, 'edit'); assert.equal(change.knowledgeOnly, true); assert.equal(change.before[0].content, note.content); assert.equal(change.after[0].content, draft.content); assert.deepEqual(change.after[0].tags, ['latest']); appWrites++; await appGate.promise; latestNotes.current = change.after; },
);
let appFinished = false; const appJob = actualConfirm(draft.content, draft.references).then(() => { appFinished = true; }); await settle(); assert.equal(appFinished, false); assert.equal(appWrites, 1);
appGate.resolve(undefined); await appJob; assert.equal(appFinished, true);
await actualConfirm(draft.content, draft.references); assert.equal(appWrites, 1, 'acknowledged identical retry is a no-op, without a second operation/undo item');
latestNotes.current = [{ ...note, content: 'newest user input', tags: ['latest'] }];
await assert.rejects(actualConfirm(draft.content, draft.references), /未覆盖/); assert.equal(appWrites, 1); assert.equal(latestNotes.current[0].content, 'newest user input');
latestNotes.current = []; await assert.rejects(actualConfirm(draft.content, draft.references), /已不存在/); assert.equal(appWrites, 1);
let opens = 0, openInput: any, openFlush = defer(); const opening = { current: false };
latestNotes.current = [{ ...note, content: 'before pending flush' }];
const actualOpen = new Function('conceptFillOpeningRef', 'conceptFillNote', 'allowWorkspaceNavigation', 'flushPendingChanges', 'notesRef', 'setConceptFillNote', ts.transpileModule(`${openHandler!.getText(appAst)}\nreturn handleOpenConceptFill;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
  opening, null, () => true, () => openFlush.promise, latestNotes, (snapshot: any) => { opens++; openInput = snapshot; },
);
const openingJob = actualOpen(note); await settle(); assert.equal(opens, 0); assert.equal(opening.current, true);
await actualOpen(note); assert.equal(opens, 0, 'opening lock prevents duplicate overlapping modals');
latestNotes.current = [{ ...note, content: 'the final just-typed user input' }]; openFlush.resolve(undefined); await openingJob;
assert.equal(openInput.content, 'the final just-typed user input'); assert.equal(opens, 1); assert.equal(opening.current, false);
openFlush = defer(); const invalidOpen = actualOpen({ ...note, id: 'removed' }); openFlush.resolve(undefined); await assert.rejects(invalidOpen, /已变化/); assert.equal(opens, 1); assert.equal(opening.current, false);
console.log('PASS concept fill UI: truthful empty/retained draft feedback, safe failure diagnostics, single draft replacement/clear, generation/stop/late replies, acknowledged write/retry, safe sources, cancellation, conflict protection and Agent draft replacement.');
