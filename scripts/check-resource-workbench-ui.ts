import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createResourceWorkbenchController, type ResourceWorkbenchApi } from '../src/services/ui/resourceWorkbenchController';
import { resourceWorkbenchLayout } from '../src/services/ui/resourceWorkbenchLayout';
import type { ResourceWorkbenchState } from '../src/types';

const resource = { candidateId: 'a', title: '合成资料', url: 'https://synthetic.invalid/a.pdf', kind: 'online' as const, downloadable: true };
const initial = (sessionId = 's1'): ResourceWorkbenchState => ({ sessionId, projectTitle: '合成项目', taskText: '测试',
  knowledgeTitles: [], query: '初始查询', currentUrl: 'https://synthetic.invalid/search', canGoBack: true, canGoForward: false,
  resources: [resource], decisions: {}, downloadCandidateIds: [], busy: false });
function harness() {
  let receive: ((next: ResourceWorkbenchState) => void) | null = null, closed = 0, changed = 0;
  const requests: Array<{ type: string; input: any; resolve(value: any): void; reject(error: any): void }> = [];
  const request = (type: string, input: any) => new Promise<any>((resolve, reject) => requests.push({ type, input, resolve, reject }));
  const api: ResourceWorkbenchApi = { onState: fn => { receive = fn; return () => { receive = null; }; },
    navigate: input => request('navigate', input), setDecision: input => request('decision', input),
    setDownload: input => request('download', input), scan: input => request('scan', input),
    authorize: input => request('authorize', input), commit: input => request('commit', input), close: () => { closed += 1; } };
  const controller = createResourceWorkbenchController(api);
  const cleanup = controller.connect(() => { changed += 1; });
  receive!(initial());
  return { controller, cleanup, requests, push: (next: ResourceWorkbenchState) => receive?.(next),
    get closed() { return closed; }, get changed() { return changed; } };
}

const input = harness(); input.controller.setAddress('尚未提交的搜索词');
const decision = input.controller.decide(resource, 'selected');
input.push({ ...initial(), decisions: { a: 'selected' } });
input.requests[0].resolve({ ...initial(), decisions: {} }); await decision;
assert.equal(input.controller.getSnapshot().address, '尚未提交的搜索词');
assert.equal(input.controller.getSnapshot().state!.decisions.a, 'selected', 'older response cannot overwrite newer event');
const scan = input.controller.scan(); input.push({ ...initial(), notice: '正在扫描', busy: false });
assert.equal(input.controller.getSnapshot().working, true, 'busy false event cannot unlock a pending IPC operation');
await input.controller.scan(); await input.controller.commit(); input.controller.close();
assert.equal(input.requests.length, 2); assert.equal(input.closed, 0);
input.requests[1].resolve({}); await scan;
assert.equal(input.controller.getSnapshot().address, '尚未提交的搜索词');
const nav = input.controller.navigate('go', '尚未提交的搜索词');
input.requests[2].reject(new Error('合成导航失败')); await nav;
assert.equal(input.controller.getSnapshot().address, '尚未提交的搜索词');
assert.equal(input.controller.getSnapshot().error, '合成导航失败');
const retry = input.controller.navigate('go', '尚未提交的搜索词');
input.push({ ...initial(), currentUrl: 'https://synthetic.invalid/new' }); input.requests[3].resolve(true); await retry;
assert.equal(input.controller.getSnapshot().address, 'https://synthetic.invalid/new');
assert.equal(input.controller.getSnapshot().error, '');
await input.controller.navigate('go', '   '); assert.equal(input.requests.length, 4);

const fallback = harness(); const first = fallback.controller.toggleDownload(resource, true);
await fallback.controller.decide(resource, 'rejected');
fallback.requests[0].resolve({ ...initial(), decisions: { a: 'selected' }, downloadCandidateIds: ['a'] }); await first;
assert.equal(fallback.requests.length, 1); assert.deepEqual(fallback.controller.getSnapshot().state!.downloadCandidateIds, ['a']);
await fallback.controller.decide({ ...resource, url: 'https://synthetic.invalid/removed' }, 'selected');
assert.equal(fallback.requests.length, 1, 'stale candidate identity cannot mutate its replacement');

const scope = harness(); const oldDecision = scope.controller.decide(resource, 'selected');
scope.push(initial('s2')); const nextScan = scope.controller.scan();
scope.requests[0].resolve({ ...initial(), decisions: { a: 'selected' } }); await oldDecision;
assert.equal(scope.controller.getSnapshot().state!.sessionId, 's2');
assert.equal(scope.controller.getSnapshot().pending, 'scan', 'old finally cannot clear the new session operation');
scope.requests[1].resolve({}); await nextScan;
const oldAuth = scope.controller.saveSiteLogin(resource); scope.push(initial('s3'));
scope.requests[2].resolve({ resource }); await oldAuth; assert.equal(scope.closed, 0, 'late authorization cannot close new session');

const commit = harness(); await commit.controller.commit(); assert.equal(commit.requests.length, 0);
commit.push({ ...initial(), decisions: { a: 'selected' } });
const save = commit.controller.commit(); await commit.controller.commit();
commit.push({ ...initial(), decisions: { a: 'selected' }, busy: true });
commit.requests[0].resolve({ ok: true, pendingApply: true }); await save;
assert.equal(commit.controller.getSnapshot().pending, 'commit');
await commit.controller.decide(resource, null); commit.controller.close();
assert.equal(commit.requests.length, 1); assert.equal(commit.closed, 0);
commit.push({ ...initial(), decisions: { a: 'selected' }, busy: false, notice: '项目写回失败，请重试' });
assert.equal(commit.controller.getSnapshot().pending, null); assert.equal(commit.controller.getSnapshot().working, false);
const canceled = commit.controller.commit(); commit.requests[1].resolve({ ok: false, canceled: true }); await canceled;
assert.equal(commit.controller.getSnapshot().error, ''); assert.equal(commit.controller.getSnapshot().working, false);
const failed = commit.controller.commit(); commit.requests[2].resolve({ ok: false, error: '写回失败' }); await failed;
assert.equal(commit.controller.getSnapshot().error, '写回失败');
const fast = commit.controller.commit();
commit.push({ ...initial(), busy: true }); commit.push({ ...initial(), busy: false, notice: '已完成' });
commit.requests[3].resolve({ ok: true, pendingApply: true }); await fast;
assert.equal(commit.controller.getSnapshot().working, false, 'early final acknowledgement cannot leave UI stuck');

const unmounted = harness(); const waiting = unmounted.controller.scan(); unmounted.cleanup();
const changeCount = unmounted.changed; unmounted.requests[0].reject(new Error('迟到失败')); await waiting;
unmounted.push(initial('s4')); assert.equal(unmounted.changed, changeCount);
assert.equal(unmounted.controller.getSnapshot().error, '');
const unavailable = createResourceWorkbenchController(); unavailable.connect(() => {});
await unavailable.scan(); unavailable.close();

// Execute the real keyboard handler, not a duplicate of the UI algorithm.
const source = readFileSync('src/components/ResourceWorkbenchApp.tsx', 'utf8');
const ast = ts.createSourceFile('ResourceWorkbenchApp.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let handler: ts.Expression | undefined;
function walk(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleTabKey') handler = node.initializer; ts.forEachChild(node, walk); }
walk(ast); assert.ok(handler);
let focus = 0;
const tabs = [0, 1, 2, 3].map(index => ({ focus() { focus = index; document.activeElement = tabs[index]; } }));
const document = { activeElement: tabs[0] };
const code = ts.transpileModule(`return (${handler.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const keyHandler = new Function('document', code)(document);
const key = (key: string, flags = {}) => ({ key, currentTarget: { querySelectorAll: () => tabs }, nativeEvent: {}, preventDefault() {}, ...flags });
keyHandler(key('ArrowRight')); assert.equal(focus, 1); keyHandler(key('End')); assert.equal(focus, 3);
keyHandler(key('Home')); assert.equal(focus, 0);
for (const flags of [{ altKey: true }, { ctrlKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) keyHandler(key('ArrowRight', flags));
assert.equal(focus, 0, 'tabs preserve IME and return shortcuts');
let focusEffect: ts.ArrowFunction | undefined;
function findFocusEffect(node: ts.Node) {
  if (ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === 'useEffect'
    && node.body.getText(ast).includes('pendingFocusRef.current')) focusEffect = node;
  ts.forEachChild(node, findFocusEffect);
}
findFocusEffect(ast); assert.ok(focusEffect);
const focusCode = ts.transpileModule(`return (${focusEffect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let restored = 0;
const target = { isConnected: true, matches: () => false, focus: () => { restored += 1; } };
const focusDocument = { body: {}, documentElement: {}, activeElement: {} };
const pendingFocusRef = { current: { element: target, sessionId: 's1' } as any };
const invokeFocus = (working: boolean, sessionId = 's1') => new Function('working', 'state', 'pendingFocusRef', 'document', focusCode)(working, { sessionId }, pendingFocusRef, focusDocument)();
focusDocument.activeElement = focusDocument.body;
invokeFocus(true); assert.equal(restored, 0); assert.ok(pendingFocusRef.current);
invokeFocus(false); assert.equal(restored, 1); assert.equal(pendingFocusRef.current, null);
pendingFocusRef.current = { element: target, sessionId: 's1' }; focusDocument.activeElement = {};
invokeFocus(false); assert.equal(restored, 1, 'active input elsewhere cannot lose focus');
pendingFocusRef.current = { element: target, sessionId: 's1' }; focusDocument.activeElement = focusDocument.body;
invokeFocus(false, 's2'); assert.equal(restored, 1, 'session switch cannot restore old focus');
pendingFocusRef.current = { element: { ...target, isConnected: false }, sessionId: 's1' };
invokeFocus(false); assert.equal(restored, 1, 'filtered or removed candidate cannot receive focus');
assert.match(source, /tabIndex=\{active \? 0 : -1\}/);
assert.match(source, /readOnly=\{pending === 'navigate'\}/);
assert.match(source, /error \? <div className="rw-notice is-error" role="alert"/);
assert.match(source, /pending === 'commit' \? '正在写回…' : '确认并写回'/);
const css = readFileSync('src/resourceWorkbench.css', 'utf8');
assert.match(css, /@import '.\/styles\/design-tokens.css'/);
assert.match(css, /prefers-reduced-motion: reduce/);
assert.match(css, /min-height: 44px/);
assert.match(css, /height: var\(--rw-toolbar-height, 176px\)/);
const native = readFileSync('src/electron/resourceBrowser.ts', 'utf8');
assert.match(native, /view.setBounds\(resourceWorkbenchLayout\(width, height,/);
for (const [width, height, hasTabs, sidebar, toolbar] of [[1380, 860, true, 390, 176], [1040, 640, true, 340, 176], [1380, 860, false, 390, 64]] as const) {
  const layout = resourceWorkbenchLayout(width, height, hasTabs);
  assert.equal(layout.sidebarWidth, sidebar); assert.equal(layout.toolbarHeight, toolbar);
  assert.equal(layout.page.width + sidebar, width); assert.equal(layout.page.y + layout.page.height, height);
}
console.log('PASS resource workbench: input preservation, authoritative state, duplicate locks, session/unmount safety, pending apply, retry/cancel, keyboard and native geometry');
let listEffect: ts.Node | undefined;
function findListEffect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect'
    && node.arguments[0]?.getText(ast).includes('resourceListRef.current.scrollTop')) {
    listEffect = node.arguments[0];
    assert.equal(node.arguments[1].getText(ast), '[filter, state?.sessionId]', 'live counts and theme changes must not reset user scroll');
  }
  ts.forEachChild(node, findListEffect);
}
findListEffect(ast); assert.ok(listEffect);
const listCode = ts.transpileModule(`return (${listEffect.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const listRef = { current: { scrollTop: 200 } as { scrollTop: number } | null };
new Function('resourceListRef', listCode)(listRef)(); assert.equal(listRef.current!.scrollTop, 0);
listRef.current = null; new Function('resourceListRef', listCode)(listRef)();
assert.match(source, /ref=\{resourceListRef\}/); assert.match(source, /切换“全部”查看其他候选/);
await import('./check-resource-workbench-write-ui');
await import('./check-window-appearance-ui');
