import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { readSourceEvidence } from '../src/services/textbook/sourceEvidence';

// Execute production components/hooks; disk, native dialogs and IPC are memory-only boundaries.
function compile(path: string, bindings: Record<string, any>, names: string[]) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const source = ast.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
  const code = ts.transpileModule(`${source}\nreturn {${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
function runtime() {
  const slots: any[] = [], effects: any[] = []; let cursor = 0, changes = 0;
  const effect = (fn: any, deps: any[]) => { const i = cursor++;
    if (!effects[i] || deps.some((v, j) => v !== effects[i].deps[j])) effects[i] = { deps, fn, pending: true, cleanup: effects[i]?.cleanup }; };
  return {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { changes++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useMemo(work: () => any, deps: any[]) { const i = cursor++, old = slots[i];
      if (!old || deps.some((value, j) => value !== old.deps[j])) slots[i] = { deps, value: work() }; return slots[i].value; },
    useEffect: effect, useLayoutEffect: effect, useId: () => 'memory-title',
    begin() { cursor = 0; }, flush() { effects.forEach(e => { if (e?.pending) { e.pending = false; e.cleanup?.(); e.cleanup = e.fn(); } }); },
    unmount() { effects.forEach(e => e?.cleanup?.()); }, changes: () => changes,
  };
}
const defer = () => { let resolve!: (value?: any) => void, reject!: (error: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const find = (tree: any, type: string) => flat(tree).find(node => node.type === type);
const button = (tree: any, label: string) => { const found = flat(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; };
const submit = (tree: any) => find(tree, 'form').props.onSubmit({ preventDefault() {} });

// Review editing: actual form handlers, same-frame locks and failure draft retention.
const reviewHooks = runtime(); let reviewGate = defer(), patches: any[] = [];
let reviewPending: () => string | null = () => null;
let record: any = { id: 'memory-review', title: '原始标题', editedRestatement: '原始复述', rawRestatement: '原始复述', expanded: true, status: 'text_only', argumentDocIds: [] };
const dom: any = { body: {}, activeElement: {} }; const frames: any[] = [];
const reviewModule = compile('src/components/textbook/LearningReviewBlock.tsx', { React, ...reviewHooks, document: dom,
  useEditorInputLeave: (pending: () => string | null) => { reviewPending = pending; return { notice: '', clearNotice() {} }; },
  requestAnimationFrame: (fn: any) => frames.push(fn), ReactMarkdown: () => null, remarkGfm: {} }, ['LearningReviewBlock']);
const reviewRetryFocus = { focus() { dom.activeElement = this; } };
function review() { let tree: any; const owner = record.id; for (let i = 0; i < 3; i++) { reviewHooks.begin(); tree = reviewModule.LearningReviewBlock({ record, onPatch: async (patch: any) => { patches.push(patch); await reviewGate.promise; if (record.id === owner) record = { ...record, ...patch }; } }); const submitButton = flat(tree).find(n => n.type === 'button' && n.props.type === 'submit'); if (submitButton) submitButton.props.ref.current = reviewRetryFocus; reviewHooks.flush(); } return tree; }
let tree = review(); button(tree, '编辑复述').props.onClick(); tree = review();
find(tree, 'textarea').props.onChange({ target: { value: '必须保留的草稿' } }); assert.match(reviewPending()!, /复述有未保存/); tree = review();
const oldForm = tree; submit(oldForm); submit(oldForm); assert.equal(patches.length, 1);
tree = review(); assert.equal(find(tree, 'textarea').props.disabled, true); assert.equal(button(tree, '修改标题').props.disabled, true);
button(oldForm, '修改标题').props.onClick(); find(oldForm, 'textarea').props.onChange({ target: { value: '不应进入' } });
dom.activeElement = dom.body; reviewGate.reject(new Error('PRIVATE-PATH')); await settle(); tree = review();
assert.equal(dom.activeElement, reviewRetryFocus, 'failed save restores lost keyboard focus to retry');
assert.equal(find(tree, 'textarea').props.value, '必须保留的草稿'); assert.match(text(tree), /编辑内容已保留/); assert.doesNotMatch(text(tree), /PRIVATE-PATH/);
reviewGate = defer(); submit(tree); reviewGate.resolve(); await settle(); tree = review();
assert.equal(find(tree, 'form'), undefined); assert.match(text(tree), /修改已保存/); assert.equal(record.editedRestatement, '必须保留的草稿');
assert.equal(reviewPending(), null, 'acknowledged review save releases the leave protection');
button(tree, '修改标题').props.onClick(); tree = review(); find(tree, 'input').props.onChange({ target: { value: '待提交标题' } }); tree = review();
reviewGate = defer(); submit(tree); record = { ...record, id: 'other-record', title: '新的记录' }; tree = review();
reviewGate.resolve(); await settle(); tree = review(); assert.doesNotMatch(text(tree), /修改已保存/); assert.equal(find(tree, 'form'), undefined);
button(tree, '修改标题').props.onClick(); tree = review(); reviewGate = defer(); submit(tree);
reviewHooks.unmount(); const afterUnmount = reviewHooks.changes(); reviewGate.reject(new Error('late')); await settle(); assert.equal(reviewHooks.changes(), afterUnmount);

// Saved-graph status: real block effect, private/nonfactual status and late-result ownership.
const indexHooks = runtime(); let indexGate = defer();
let indexRecord: any = { ...record, id: 'indexed-review', projectNoteId: 'project', expanded: true, argumentDocIds: ['graph'], status: 'completed' };
const indexModule = compile('src/components/textbook/LearningReviewBlock.tsx', { React, ...indexHooks, document: dom,
  useEditorInputLeave: () => ({ notice: '', clearNotice() {} }),
  requestAnimationFrame: () => {}, ReactMarkdown: () => null, remarkGfm: {},
  readFlowReviewIndexStatus: () => indexGate.promise }, ['LearningReviewBlock']);
function indexView() { indexHooks.begin(); const tree = indexModule.LearningReviewBlock({ record: indexRecord }); indexHooks.flush(); return tree; }
indexView(); indexGate.resolve({ graphIds: ['graph'], vectorStatus: 'ready', processing: false }); await settle();
assert.match(text(indexView()), /已进入个人素材检索；立场未确认，不作为事实依据/u);
indexGate = defer(); indexRecord = { ...indexRecord, updatedAt: 'new' }; indexView();
indexGate.resolve({ graphIds: ['graph'], vectorStatus: 'unavailable', processing: false }); await settle();
assert.match(text(indexView()), /向量暂不可用，当前可按词项和关系查找/u);
indexGate = defer(); indexRecord = { ...indexRecord, updatedAt: 'next' }; indexView();
indexHooks.unmount(); const indexChanges = indexHooks.changes(); indexGate.resolve(null); await settle();
assert.equal(indexHooks.changes(), indexChanges, 'Late index reads do not update an unmounted review');

// Agent citation ownership: first read, open, reindex, close, scope change and unmount.
const citationHooks = runtime(); let citationGate = defer(), readCalls = 0, openCalls = 0, indexCalls = 0, scope = 'role:open';
let readFails = false;
const preview: any = { document: { id: 'memory-document', status: 'ready' }, chunks: [{ id: 'chunk' }], focusedChunkId: 'chunk' };
const citationModule = compile('src/components/useDocumentCitationPreview.ts', { ...citationHooks,
  previewDocument: async () => { readCalls++; await citationGate.promise; if (readFails) throw Error('PRIVATE'); return preview; },
  openDocument: async () => { openCalls++; await citationGate.promise; }, retryDocument: async () => { indexCalls++; await citationGate.promise; } }, ['useDocumentCitationPreview']);
function citation() { citationHooks.begin(); citationModule.useDocumentCitationPreview(scope); citationHooks.flush(); citationHooks.begin(); return citationModule.useDocumentCitationPreview(scope); }
let state = citation(); const first = state.read('memory-document', 'chunk', 'source-1'); void state.read('memory-document'); assert.equal(readCalls, 1);
citationGate.reject(new Error('PRIVATE')); await first; state = citation(); assert.match(state.error, /再次点击引用重试/); assert.doesNotMatch(state.error, /PRIVATE/);
citationGate = defer(); const retry = state.read('memory-document', 'chunk'); citationGate.resolve(); await retry; state = citation(); assert.equal(state.preview, preview);
citationGate = defer(); const opened = state.open(); void state.open(); assert.equal(openCalls, 1); assert.equal(citation().operation, 'open'); citationGate.reject(new Error('PRIVATE')); await opened;
state = citation(); assert.match(state.error, /重试打开/); assert.equal(state.preview, preview);
citationGate = defer(); await state.reindex(); assert.equal(indexCalls, 0, 'Opening the confirmation does not submit indexing');
state = citation(); assert.equal(state.confirmBody, true);
const index = state.confirmReindex(); void state.confirmReindex(); assert.equal(indexCalls, 1); state.close(); citationGate.resolve(); await index; assert.equal(citation().preview, null, 'late index result must not resurrect closed dialog');
citationGate = defer(); const loadAgain = citation().read('memory-document'); citationGate.resolve(); await loadAgain; state = citation();
citationGate = defer(); readFails = true; await state.reindex(); state = citation();
const partial = state.confirmReindex(); citationGate.resolve(); await partial; state = citation();
assert.equal(state.preview.document.status, 'pending'); assert.equal(state.preview.chunks.length, 0); assert.match(state.error, /无需再次提交/);
readFails = false; citationGate = defer(); const previous = state.read('memory-document'); scope = 'different-role'; state = citation(); citationGate.resolve(); await previous; assert.equal(citation().preview, null);
citationGate = defer(); const last = citation().read('memory-document'); citationHooks.unmount(); const writes = citationHooks.changes(); citationGate.resolve(); await last; assert.equal(citationHooks.changes(), writes);

// Textbook source: execute actual modal/read/open hooks; no real portal, source, browser or disk.
const sourceHooks = runtime(); let sourceGate = defer(), sourceReads = 0, originalGate = defer(), originalCalls = 0, nativeOpens = 0, nativeCloses = 0;
const resourceModule = compile('src/components/useResourceOpen.ts', { ...sourceHooks, openLearningResource: async () => {} }, ['useResourceOpen']);
const nativeDialog = { open: false, showModal() { this.open = true; nativeOpens++; }, close() { this.open = false; nativeCloses++; } };
const sourceModule = compile('src/components/textbook/SourceReference.tsx', { React, ...sourceHooks, document: dom,
  useContext: () => null, TextbookSourceContext: {},
  readSourceEvidence,
  useDialog: () => {}, createPortal: (node: any) => node, useResourceOpen: resourceModule.useResourceOpen, ResourceOpenFeedback: () => null,
  readLocalMaterialPage: async () => {}, textbookHash: async () => '', readTextbookWebEvidence: async () => {}, textbookPublicUrl: (v: any) => v,
  openDocument: async () => {}, window: {},
}, ['SourceReference', 'readSourceEvidence']);
// Replace only the IO reader boundary in the compiled actual component, preserving its callback implementation.
const sourceAst = ts.createSourceFile('source', readFileSync('src/components/textbook/SourceReference.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const sourceDecl = sourceAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SourceReference')!;
const sourceCode = ts.transpileModule(`${sourceDecl.getText(sourceAst).replace(/^export /, '')}\nreturn SourceReference;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const bindings: any = { React, ...sourceHooks, document: dom, window: {}, EMPTY_NOTES: [], useDialog: () => {}, createPortal: (n: any) => n,
  useContext: () => null, TextbookSourceContext: {},
  useResourceOpen: resourceModule.useResourceOpen, ResourceOpenFeedback: () => null, textbookPublicUrl: (v: any) => v,
  openDocument: async () => { originalCalls++; await originalGate.promise; },
  readSourceEvidence: async () => { sourceReads++; return sourceGate.promise; } };
const Source = new Function(...Object.keys(bindings), sourceCode)(...Object.values(bindings));
// Exercise the real NoteEditor -> TextbookReader opener, so a void/catch wrapper
// cannot report success before the native reader acknowledges its request.
const noteAst = ts.createSourceFile('NoteEditor.tsx', readFileSync('src/components/NoteEditor.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let readerOpener: ts.Expression | undefined;
function findReaderOpener(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(noteAst) === 'TextbookReader') {
    const prop = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(noteAst) === 'onOpenDocument') as ts.JsxAttribute | undefined;
    if (prop?.initializer && ts.isJsxExpression(prop.initializer)) readerOpener = prop.initializer.expression;
  }
  ts.forEachChild(node, findReaderOpener);
}
findReaderOpener(noteAst); assert.ok(readerOpener);
const readerOpenerCode = ts.transpileModule(`return (${readerOpener.getText(noteAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const parentOpenDocument = new Function('openDocument', readerOpenerCode)(bindings.openDocument);
let manifest: any = { projectNoteId: 'project', sources: [{ sourceId: 'L1', id: 'doc', kind: 'document', title: '合成原文', version: 'version' }] };
const sourceRetryFocus = { focus() { dom.activeElement = this; } };
function source() { let value: any; for (let i = 0; i < 3; i++) { sourceHooks.begin(); value = Source({ sourceId: 'L1', manifest, onOpenDocument: parentOpenDocument }); const modal = find(value, 'dialog'); if (modal) modal.props.ref.current = nativeDialog; const feedbackOwner = flat(value).find(n => n.type === 'div' && n.props.ref); if (feedbackOwner) feedbackOwner.props.ref.current = { querySelector: () => sourceRetryFocus }; sourceHooks.flush(); } return value; }
tree = source(); button(tree, '[L1]').props.onClick(); tree = source(); assert.equal(sourceReads, 1); assert.equal(nativeOpens, 1);
sourceGate.reject(new Error('PRIVATE-PATH')); await settle(); tree = source(); assert.ok(button(tree, '重试读取')); assert.doesNotMatch(text(tree), /PRIVATE/);
sourceGate = defer(); button(tree, '重试读取').props.onClick(); button(tree, '重试读取').props.onClick(); assert.equal(sourceReads, 2);
sourceGate.resolve({ text: '第一页', nextCursor: 100 }); await settle(); tree = source();
manifest = JSON.parse(JSON.stringify(manifest)); tree = source(); assert.equal(sourceReads, 2); assert.equal(nativeCloses, 0, 'manifest identity change must not close native dialog');
sourceGate = defer(); button(tree, '继续读取引用原文').props.onClick(); button(tree, '继续读取引用原文').props.onClick(); assert.equal(sourceReads, 3);
sourceGate.reject(new Error('PRIVATE')); await settle(); tree = source(); assert.equal(text(find(tree, 'pre')), '第一页'); assert.ok(button(tree, '重试续读'));
sourceGate = defer(); button(tree, '重试续读').props.onClick(); sourceGate.resolve({ text: '第二页' }); await settle(); tree = source(); assert.equal(text(find(tree, 'pre')), '第一页\n第二页');
originalGate = defer(); button(tree, '打开源文件').props.onClick(); button(tree, '打开源文件').props.onClick(); assert.equal(originalCalls, 1); tree = source(); assert.equal(button(tree, '正在打开…').props.disabled, true);
dom.activeElement = dom.body; originalGate.reject(new Error('PRIVATE')); await settle(); tree = source(); assert.equal(sourceReads, 4, 'opening a source does not reload or replace its continued evidence');
assert.equal(dom.activeElement, sourceRetryFocus, 'failed native open restores lost focus inside source dialog');
const feedback = flat(tree).find(n => n.props.feedback)?.props.feedback; assert.equal(feedback.kind, 'error'); assert.equal(text(find(tree, 'pre')), '第一页\n第二页');
sourceGate = defer(); manifest = { ...manifest, sources: [{ ...manifest.sources[0], version: 'new-version' }] }; tree = source(); assert.equal(nativeOpens, 1, 'source change refreshes evidence, not native modal');
button(tree, '关闭').props.onClick(); tree = source(); sourceGate.resolve({ text: '迟到正文' }); await settle(); tree = source(); assert.equal(find(tree, 'dialog'), undefined);
sourceGate = defer(); button(tree, '[L1]').props.onClick(); tree = source(); sourceHooks.unmount(); const updates = sourceHooks.changes(); sourceGate.reject(new Error('late')); await settle(); assert.equal(sourceHooks.changes(), updates);

// Production Agent passes feedback and lock to the shared dialog, rather than discarded promises.
const agent = readFileSync('src/components/AgentPanel.tsx', 'utf8');
assert.match(agent, /busy=\{documentCitation.operation !== null\}/); assert.match(agent, /error=\{documentCitation.error\}/);
assert.match(agent, /onOpen=\{\(\) => void documentCitation.open\(\)\}/); assert.match(agent, /notice=\{documentCitation.notice\}/);
assert.ok(sourceModule.readSourceEvidence, 'the authoritative version/pointer reader is preserved');
console.log('reference/review recovery UI checks passed: actual callbacks/hooks, memory-only IO');
