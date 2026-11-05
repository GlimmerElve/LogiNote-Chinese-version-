import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { normalizeSelectedText, resolveSelectionActions } from '../src/services/selectionActions';

function compile(path: string, bindings: Record<string, any>, names: string[]) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
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
    useEffect: effect, useLayoutEffect: effect,
    begin() { cursor = 0; }, flush() { effects.forEach(e => { if (e?.pending) { e.pending = false; e.cleanup?.(); e.cleanup = e.fn(); } }); },
    unmount() { effects.forEach(e => e?.cleanup?.()); }, changes: () => changes,
  };
}
const defer = () => { let resolve!: (value?: any) => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const button = (tree: any, label: string) => { const found = flat(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; };

// Actual clipboard bridge: both missing API and synchronous platform exceptions propagate.
const nav: any = {};
const clip = compile('src/services/ui/selectionClipboard.ts', { navigator: nav }, ['writeSelectionClipboard']);
await assert.rejects(clip.writeSelectionClipboard('x'));
nav.clipboard = { writeText() { throw new Error('private-denial'); } };
assert.throws(() => clip.writeSelectionClipboard('x'));

// Actual selection component with a synthetic DOM selection and IO gates.
const listeners = new Map<string, any>();
class TestElement {
  dataset = { selectionSurface: 'note', selectionNoteId: 'synthetic-note', selectionSourceTitle: 'synthetic' };
  closest() { return this; }
}
const root = new TestElement(); let selectedText = '选中正文'; let collapsed = false, removals = 0;
const selection = { get isCollapsed() { return collapsed; }, rangeCount: 1, anchorNode: root, focusNode: root,
  toString: () => selectedText, getRangeAt: () => ({ getBoundingClientRect: () => ({ width: 120, height: 20, left: 4, top: 60, bottom: 80 }) }),
  removeAllRanges() { removals++; collapsed = true; } };
const dom = { addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
const win = { ...dom, innerWidth: 1000, innerHeight: 700, getSelection: () => selection };
const hooks = runtime(); let gate = defer(), copies: string[] = [], actions = 0;
const hub = compile('src/components/SelectionActionHub.tsx', { React, ...hooks, window: win, document: dom, Element: TestElement,
  normalizeSelectedText, resolveSelectionActions, Copy: () => null, writeSelectionClipboard: (value: string) => { copies.push(value); return gate.promise; } }, ['SelectionActionHub']);
const toolbar = { dataset: {} as any, style: {} as any, contains: (target: any) => target === toolbar,
  getBoundingClientRect: () => ({ width: 510, height: 110 }) };
function renderHub() { hooks.begin(); let tree = hub.SelectionActionHub({ onAction: () => { actions++; } });
  flat(tree).find(node => node.props.className === 'selection-action-hub')?.props.ref && (flat(tree)[0].props.ref.current = toolbar);
  hooks.flush(); hooks.begin(); tree = hub.SelectionActionHub({ onAction: () => { actions++; } }); return tree; }
assert.equal(renderHub(), null);
listeners.get('mouseup')({ target: root }); let tree = renderHub();
assert.equal(toolbar.dataset.placement, 'below', 'large error/toolbar must fit below a near-top selection');
assert.ok(parseFloat(toolbar.style.left) >= 263, 'toolbar cannot spill over the left edge');
button(tree, '复制').props.onClick(); button(tree, '复制').props.onClick(); assert.equal(copies.length, 1); assert.equal(removals, 0);
tree = renderHub(); assert.equal(button(tree, '正在复制').props.disabled, true);
button(tree, '解释这段').props.onClick(); assert.equal(actions, 0, 'even an old handler cannot dispatch while copying');
listeners.get('mouseup')({ target: toolbar }); gate.reject(new Error('private-denial')); await settle(); tree = renderHub();
assert.match(text(tree), /选中文字已保留/); assert.doesNotMatch(text(tree), /private-denial/); assert.equal(removals, 0);
gate = defer(); button(tree, '重试复制').props.onClick(); gate.resolve(); await settle(); tree = renderHub();
assert.match(text(tree), /已复制选中文字/); assert.equal(removals, 1);
listeners.get('selectionchange')(); assert.match(text(renderHub()), /已复制选中文字/, 'collapse notification cannot erase copy receipt');
collapsed = false; selectedText = '全文'.repeat(900); listeners.get('mouseup')({ target: root }); tree = renderHub();
gate = defer(); button(tree, '复制').props.onClick(); assert.equal(copies.at(-1), selectedText, 'copy does not inherit the 800-character agent prompt limit');
selectedText = '后来选择'; listeners.get('mouseup')({ target: root }); gate.resolve(); await settle(); tree = renderHub();
assert.equal(removals, 1, 'late copy success cannot clear a newer selection'); assert.ok(button(tree, '复制'));
gate = defer(); button(tree, '复制').props.onClick(); listeners.get('keydown')({ key: 'Escape' }); gate.reject(new Error('late')); await settle(); assert.equal(renderHub(), null);
collapsed = false; listeners.get('keyup')({ key: 'ArrowRight', shiftKey: true, target: root }); tree = renderHub(); assert.ok(button(tree, '复制'));
gate = defer(); button(tree, '复制').props.onClick(); hooks.unmount(); const writesAfterUnmount = hooks.changes(); gate.resolve(); await settle(); assert.equal(hooks.changes(), writesAfterUnmount);

// Actual external opener, entirely synthetic OS/document/browser boundaries.
let documentCalls: string[] = [], nativeCalls: string[] = [], popupCalls = 0, navigations: string[] = [], closes = 0;
const platform: any = { electronAPI: undefined, open() { popupCalls++; return null; } };
const opener = compile('src/services/ui/openLearningResource.ts', { window: platform, URL,
  openDocument: async (id: string) => { documentCalls.push(id); if (id === 'failed') throw new Error('private-path'); } }, ['openLearningResource']).openLearningResource;
await opener({ documentId: 'local', url: '' }); assert.deepEqual(documentCalls, ['local']);
await assert.rejects(opener({ documentId: 'failed' })); assert.equal(popupCalls, 0);
for (const url of ['javascript:alert(1)', 'data:text/html,test', 'not-a-url', 'file:///C:/synthetic.pdf']) await assert.rejects(opener({ url }));
assert.equal(popupCalls, 0);
platform.electronAPI = { isElectron: true }; await assert.rejects(opener({ url: 'https://example.invalid' })); assert.equal(popupCalls, 0);
platform.electronAPI.openExternal = async (url: string) => { nativeCalls.push(url); throw new Error('native denied'); };
await assert.rejects(opener({ url: 'https://example.invalid' })); assert.equal(popupCalls, 0, 'native failures cannot silently launch browser fallback');
platform.electronAPI.openExternal = async (url: string) => { nativeCalls.push(url); };
await opener({ url: 'file:///C:/synthetic.pdf' }); assert.equal(nativeCalls.length, 2);
platform.electronAPI = undefined; await assert.rejects(opener({ url: 'https://example.invalid' }), /popup-blocked/);
const popup: any = { opener: 'parent', document: { createElement: () => ({}), head: { appendChild(meta: any) { assert.equal(meta.name, 'referrer'); assert.equal(meta.content, 'no-referrer'); } } },
  location: { replace(url: string) { assert.equal(popup.opener, null); navigations.push(url); } }, close() { closes++; } };
platform.open = (url: string, target: string) => { assert.equal(url, 'about:blank'); assert.equal(target, '_blank'); popupCalls++; return popup; };
await opener({ url: 'https://example.invalid/path' }); assert.deepEqual(navigations, ['https://example.invalid/path']); assert.equal(closes, 0);
popup.location.replace = () => { throw new Error('failed navigation'); }; await assert.rejects(opener({ url: 'https://example.invalid' })); assert.equal(closes, 1);

// Actual hook: accepted request alone marks assistance; late replies do not affect another round.
const resourceHooks = runtime(); let opening = defer(), openCalls = 0, consulted = 0, scope = 'round-1';
const hookModule = compile('src/components/useResourceOpen.ts', { ...resourceHooks, openLearningResource: () => { openCalls++; return opening.promise; } }, ['useResourceOpen']);
function renderOpen() { resourceHooks.begin(); const value = hookModule.useResourceOpen(scope); resourceHooks.flush(); resourceHooks.begin(); return hookModule.useResourceOpen(scope); }
let state = renderOpen(); const resource = { title: 'synthetic', url: 'https://example.invalid' };
const start = state.start(resource, () => consulted++); void state.start(resource, () => consulted++); assert.equal(openCalls, 1); assert.equal(state.isBusy(), true);
state = renderOpen(); assert.equal(state.pending, true); opening.reject(new Error('private')); assert.equal(await start, false); state = renderOpen();
assert.equal(consulted, 0); assert.equal(state.feedback.kind, 'error');
opening = defer(); const retry = state.start(resource, () => consulted++); opening.resolve(); assert.equal(await retry, true); state = renderOpen(); assert.equal(consulted, 1);
opening = defer(); const late = state.start(resource, () => consulted++); scope = 'round-2'; state = renderOpen(); assert.equal(state.feedback, null);
opening.resolve(); assert.equal(await late, false); assert.equal(consulted, 1); assert.equal(renderOpen().feedback, null);
opening = defer(); const unmounted = state.start(resource, () => consulted++); resourceHooks.unmount(); const count = resourceHooks.changes(); opening.resolve(); await unmounted;
assert.equal(resourceHooks.changes(), count); assert.equal(consulted, 1);

// Execute the production Review/Flow callbacks, not a reimplemented bookkeeping model.
function callback(path: string, name: string, bindings: Record<string, any>) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX); let code = '';
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) code = node.initializer!.getText(ast); ts.forEachChild(node, visit); } visit(ast);
  assert.ok(code, name); const js = ts.transpileModule(`return (${code});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
let ids: string[] = [], expanded: string | null = null, received: any;
const material = { id: 'resource-id', kind: 'resource', resource };
const actualOpen = callback('src/components/ReviewChat.tsx', 'handleOpenMaterial', {
  previewOnly: false, materialOpen: { isBusy: () => false, start(value: any, mark: any) { received = { value, mark }; } },
  tutorOperationRef: { current: false }, finishLock: { current: false }, isScoring: false, sessionEnded: false, expandedMaterialId: null,
  setConsultedMaterialIds: (update: any) => { ids = update(ids); }, setExpandedMaterialId: (update: any) => { expanded = typeof update === 'function' ? update(expanded) : update; },
});
actualOpen(material); assert.deepEqual(ids, []); assert.equal(received.value, resource); received.mark(); received.mark(); assert.deepEqual(ids, ['resource-id']);
actualOpen({ id: 'note-id', kind: 'note' }); assert.equal(expanded, 'note-id'); assert.deepEqual(ids, ['resource-id', 'note-id']);
for (const name of ['handleSendMessage', 'requestTutorSupport', 'handleEndSession', 'handleFinishReview']) {
  await callback('src/components/ReviewChat.tsx', name, { previewOnly: false, materialOpen: { isBusy: () => true } })('hint');
}
callback('src/components/FlowMode.tsx', 'handleOpenResourceExternal', { resourceOpen: { start(value: any) { assert.equal(value, resource); } } })(resource);
const feedbackUI = compile('src/components/ResourceOpenFeedback.tsx', { React, AlertTriangle: () => null, ExternalLink: () => null, RefreshCw: () => null }, ['ResourceOpenFeedback']);
let retries = 0; const feedbackTree = feedbackUI.ResourceOpenFeedback({ feedback: { kind: 'error', resource }, onRetry(value: any) { assert.equal(value, resource); retries++; } });
assert.equal(feedbackTree.props.role, 'alert'); button(feedbackTree, '重试打开').props.onClick(); assert.equal(retries, 1);
assert.match(text(feedbackTree), /当前学习内容已保留/);
console.log('PASS selection/resources: real clipboard selection retention/full text/late replies, opener receipts/blocked popups/safe protocols, round-safe assistance, locks and actionable themed feedback. All IO synthetic.');
