import assert from 'node:assert/strict';
import { createNoteNavigationSave } from '../src/services/ui/noteAutosave';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { EMPTY_CONTEXT_NAVIGATION, openContextNote, moveContextNavigation } from '../src/services/ui/contextNavigation';
import { createCognitionLeaveRegistry } from '../src/services/ui/cognitionLeave';

// Execute production handlers with memory-only state, not reimplementations of their rules.
function source(path: string) { const text = readFileSync(path, 'utf8'); return ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX); }
function pick(ast: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function walk(node: ts.Node) { if (found) return; if (predicate(node)) found = node; else ts.forEachChild(node, walk); }
  walk(ast); assert.ok(found); return found;
}
function variable(ast: ts.SourceFile, name: string) {
  const node = pick(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name) as ts.VariableDeclaration;
  assert.ok(node.initializer);
  return ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useCallback'
    ? node.initializer.arguments[0].getText(ast) : node.initializer.getText(ast);
}
function execute(code: string, env: Record<string, any>): any {
  return new Function(...Object.keys(env), ts.transpileModule(`return (${code});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}
const app = source('src/App.tsx');
let allowed = false, changes = 0;
const registry = createCognitionLeaveRegistry();
registry.register({ blocked: () => !allowed, element: () => null, notify() {} });
const allowCognitionLeave = () => registry.allow();
const route = { current: 'profile' }, revision = { current: 0 };
const env = { notesReadyRef: { current: true }, allowCognitionLeave, reviewExitGuard: { allowNavigation: () => true }, sceneGuard: { allowNavigation: () => true },
  requestNoteNavigation: (commit: () => void) => commit(),
  currentViewRef: route, navigationRevisionRef: revision, contextNavigation: { reset: () => changes++ }, setCurrentViewState: () => changes++ };
const workspace = execute(variable(app, 'allowWorkspaceNavigation'), env);
env.notesReadyRef.current = false; allowed = true; assert.equal(workspace(), false, 'startup failure cannot open Agent/navigation');
env.notesReadyRef.current = true; allowed = false;
const setView = execute(variable(app, 'setCurrentView'), env);
assert.equal(workspace(), false); setView('graph');
assert.equal(route.current, 'profile'); assert.equal(changes, 0); assert.equal(revision.current, 0);
allowed = true; assert.equal(workspace(), true); setView('graph'); assert.equal(route.current, 'graph'); assert.equal(changes, 2);
// Global shortcuts must leave IME-owned keystrokes untouched, including older
// Chromium events that report keyCode 229 without isComposing.
for (const key of ['k', 'j']) {
  const handler = pick(app, n => ts.isVariableDeclaration(n) && n.name.getText(app) === 'h'
    && Boolean(n.initializer?.getText(app).includes(`e.key.toLowerCase() === "${key}"`))) as ts.VariableDeclaration;
  let prevented = 0, opened = 0;
  const shortcut = execute(handler.initializer!.getText(app), {
    hasActiveDialog: () => false, allowWorkspaceNavigation: () => true,
    setIsCommandPaletteOpen: () => opened++, setIsAgentOpen: () => opened++,
  });
  const event = { key, ctrlKey: true, preventDefault: () => prevented++ };
  shortcut({ ...event, isComposing: true }); shortcut({ ...event, keyCode: 229 });
  assert.equal(prevented, 0); assert.equal(opened, 0);
  shortcut(event); assert.equal(prevented, 1); assert.equal(opened, 1);
}
function property(ast: ts.SourceFile, name: string) {
  return (pick(ast, n => ts.isPropertyAssignment(n) && n.name.getText(ast) === name) as ts.PropertyAssignment).initializer.getText(ast);
}
const facade = execute(property(app, 'navigate'), { ...env, setCurrentView: setView });
const tools = source('src/services/agent/tools/uiTools.ts');
const registration = pick(tools, n => ts.isCallExpression(n) && n.expression.getText(tools) === 'registerTool'
  && n.arguments[0].getText(tools).includes("name: 'navigate'")) as ts.CallExpression;
const tool = execute(registration.arguments[0].getText(tools), { NAVIGABLE_VIEWS: new Set(['home', 'graph']) });
allowed = false; const beforeBlockedTool = changes;
assert.throws(() => tool.execute({ view: 'home' }, { navigate: facade }), /个人理解尚未保存/);
assert.equal(changes, beforeBlockedTool, 'the actual tool cannot report success after blocked App navigation');
allowed = true; assert.deepEqual(tool.execute({ view: 'home' }, { navigate: facade }), { navigated: true, view: 'home' });
assert.equal(route.current, 'home');

// Programmatic plan imports must check leave permission before changing queues,
// clearing a staged draft or closing the Agent panel.
let imports = 0, panelOpen = true, staged = { id: 'synthetic-plan', scopeProjectId: 'root', purpose: 'planning' };
const projection = { notes: [{ id: 'root', noteType: 'project' }], summary: { rootProjectTitle: '合成计划' } };
const importEnv = { allowWorkspaceNavigation: workspace, getAgentPlanNotes: () => [],
  planDraftSessionRef: { current: staged }, buildPlanDraftMutation: () => projection, recalculateBacklinks: (notes: any) => notes,
  buildPublishedPlanEditorValue: () => ({ rootId: 'root' }), buildPlanEditorBaseRevisions: () => ({}),
  setAgentNewPlanDraft: () => imports++, setAgentPlanEditorQueue: () => imports++, setAgentPlanEditorBaseRevisions: () => imports++,
  setEditingPlanRootId: () => imports++, setPlanWorkspaceFocusId: () => imports++,
  updatePlanDraftSession: (next: any) => { importEnv.planDraftSessionRef.current = next; },
  setIsAgentOpen: (value: boolean) => { panelOpen = value; }, setCurrentView: setView,
};
const commit = execute(property(app, 'commitPlanDraftSession'), importEnv);
allowed = false; await assert.rejects(commit(), /先保存或取消/);
assert.equal(imports, 0); assert.equal(panelOpen, true); assert.equal(importEnv.planDraftSessionRef.current, staged);
await assert.rejects(execute(variable(app, 'createAgentProjectPlan'), importEnv)({}), /先保存或取消/);
assert.equal(imports, 0);
await assert.rejects(execute(property(app, 'applyPlanTaskChange'), { ...importEnv,
  assertNoPendingAgentPlanEditorDraft() {}, applyPlanTaskChange: () => ({ ...projection, changedNote: projection.notes[0] }),
})({}), /先保存或取消/);
assert.equal(imports, 0); assert.equal(panelOpen, true);
allowed = true; const imported = await commit();
assert.equal(imported.draftImported, true); assert.equal(imports, 5); assert.equal(panelOpen, false);
assert.equal(importEnv.planDraftSessionRef.current, null); assert.equal(route.current, 'plan');

const review = source('src/components/ReviewChat.tsx');
let reviewSaves = 0;
const reviewLock = { current: false };
allowed = false;
await execute(variable(review, 'handleFinishReview'), { materialOpen: { isBusy: () => false }, allowCognitionLeave, finishLock: reviewLock, finishedRef: { current: false },
  isScoring: false, isTutorResponding: false, isDiscardingDraft: false, setIsSavingCognition: () => reviewSaves++,
  onExitSaveStateChange: () => { panelOpen = false; reviewSaves++; },
})();
assert.equal(reviewLock.current, false); assert.equal(reviewSaves, 0,
  'review finish cannot start its saving guard and unmount a dirty Agent editor');

const agent = source('src/components/AgentPanel.tsx');
const panelRef = { current: {} };
let closed = 0, audit = 0, confirmations = 0;
const agentEnv = { panelRef, allowCognitionLeave, onClose: () => closed++, setAuditOpen: () => audit++ };
function buttonAction(ast: ts.SourceFile, label: string) {
  const element = pick(ast, n => ts.isJsxOpeningElement(n) && n.attributes.properties.some(p =>
    ts.isJsxAttribute(p) && p.name.getText(ast) === 'aria-label' && ts.isStringLiteral(p.initializer!) && p.initializer.text === label)) as ts.JsxOpeningElement;
  const attr = element.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onClick') as ts.JsxAttribute;
  return (attr.initializer as ts.JsxExpression).expression!.getText(ast);
}
allowed = false;
execute(buttonAction(agent, '关闭学习助手'), agentEnv)();
execute(buttonAction(agent, '查看本地运行审计'), agentEnv)();
let clearConfirmation = true;
await execute(variable(agent, 'clearConversation'), { ...agentEnv, busy: false, pendingApproval: null, requestBusyRef: { current: false },
  setClearConfirmOpen: (value: boolean) => { confirmations++; clearConfirmation = value; } })();
assert.equal(closed, 0); assert.equal(audit, 0); assert.equal(confirmations, 1); assert.equal(clearConfirmation, false,
  'blocked clear request returns to the retained editor without leaving a stale confirmation or mutating conversation');
const escape = pick(agent, n => ts.isVariableDeclaration(n) && n.name.getText(agent) === 'handler'
  && n.initializer!.getText(agent).includes('clearConfirmOpen')) as ts.VariableDeclaration;
execute(escape.initializer!.getText(agent), { ...agentEnv, hasActiveDialog: () => false, clearConfirmOpen: false, auditOpen: false })({ key: 'Escape' });
assert.equal(closed, 0); allowed = true;
execute(buttonAction(agent, '关闭学习助手'), agentEnv)(); assert.equal(closed, 1);

const editor = source('src/components/ArgumentEditView.tsx');
for (const name of ['onSubmit', 'onDelete', 'onQualityReview']) {
  const attr = pick(editor, n => ts.isJsxAttribute(n) && n.name.getText(editor) === 'onClick'
    && (n.initializer as ts.JsxExpression)?.expression?.getText(editor).includes(`${name}();`)) as ts.JsxAttribute;
  let operations = 0;
  const action = execute((attr.initializer as ts.JsxExpression).expression!.getText(editor), {
    allowCognitionLeave, workspaceRef: panelRef, [name]: () => operations++, setPanelKind: () => operations++, setShowPanel: () => operations++,
  });
  allowed = false; action(); assert.equal(operations, 0, `${name} cannot unmount an unsaved cognition editor`);
  allowed = true; action(); assert.ok(operations > 0);
}

// Run the actual context hook, including browser popstate rollback, without a browser or IO.
const context = source('src/components/useContextNavigation.ts');
const hook = pick(context, n => ts.isFunctionDeclaration(n) && n.name?.text === 'useContextNavigation');
const slots: any[] = [], effects: Array<() => void> = [], listeners = new Map<string, (event: any) => void>();
let cursor = 0, pushes = 0; const moves: number[] = [];
const history = { state: {} as any, replaceState(value: any) { this.state = value; }, pushState(value: any) { this.state = value; pushes++; }, go(delta: number) { moves.push(delta); } };
class FakeElement {}
const contextHook = execute(hook.getText(context).replace('export function', 'function'), {
  immediately: (commit: () => void) => commit(),
  EMPTY_CONTEXT_NAVIGATION, openContextNote, moveContextNavigation, allowCognitionLeave, HISTORY_KEY: 'loginoteNoteVisit',
  useRef: (value: any) => slots[cursor++] ||= { current: value },
  useState: (value: any) => { const i = cursor++; slots[i] ||= { value }; return [slots[i].value, (next: any) => { slots[i].value = next; }]; },
  useCallback: (fn: any) => { cursor++; return fn; },
  useEffect: (fn: any) => { cursor++; effects.push(fn); },
  crypto: { randomUUID: () => 'session-fixture' }, HTMLElement: FakeElement,
  document: { activeElement: null, querySelector: () => null },
  window: { history, addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
});
const navigation = contextHook(); effects.forEach(fn => fn());
allowed = false; navigation.open('a'); assert.equal(pushes, 0); assert.equal(navigation.getSnapshot().cursor, -1);
allowed = true; navigation.open('a'); const currentMarker = history.state; assert.equal(pushes, 1);
allowed = false; navigation.move(-1); assert.deepEqual(moves, []);
const pop = (state: any) => { history.state = state; listeners.get('popstate')!({ state }); };
pop({ loginoteNoteVisit: { session: 'session-fixture', cursor: -1 } });
assert.deepEqual(moves, [1]); assert.equal(navigation.getSnapshot().cursor, 0);
pop(currentMarker); assert.deepEqual(moves, [1], 'restored marker cannot create a rollback loop');
allowed = true; pop({ loginoteNoteVisit: { session: 'session-fixture', cursor: -1 } });
assert.equal(navigation.getSnapshot().cursor, -1);
// Same production context hook with an asynchronous note-save gate: native
// back must retain the editor on failure and restore the browser history marker.
let dirty = false, failWrite = false, complete!: () => void;
let write = Promise.resolve();
const saveGate = createNoteNavigationSave();
cursor = 0;
const guarded = contextHook((commit: () => void, cancel?: () => void) => saveGate.request(commit, {
  capture() {}, dirty: () => dirty, revision: () => 1,
  flush: async () => { await write; if (failWrite) throw Error('synthetic save failure'); dirty = false; },
}, cancel));
guarded.open('a'); const savedMarker = history.state;
dirty = true; failWrite = true; write = new Promise<void>(yes => { complete = yes; });
pop({ loginoteNoteVisit: { session: 'session-fixture', cursor: -1 } });
assert.equal(guarded.getSnapshot().cursor, 0, 'native back cannot hide the dirty editor before acknowledgement');
complete(); for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(guarded.getSnapshot().cursor, 0); assert.equal(moves.at(-1), 1, 'failed native back rolls browser history forward');
pop(savedMarker); failWrite = false; write = Promise.resolve(); const beforeBack = moves.length;
guarded.move(-1); guarded.move(-1); guarded.move(-1);
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(moves.length, beforeBack + 1, 'repeated back requests during a save must issue only one native traversal');
guarded.move(-1); assert.equal(moves.length, beforeBack + 1, 'await native popstate before allowing another history.go');
assert.equal(moves.at(-1), -1, 'manual back begins only after a successful save');
pop({ loginoteNoteVisit: { session: 'session-fixture', cursor: -1 } });
assert.equal(guarded.getSnapshot().cursor, -1);
console.log('PASS cognition leave: actual App routes, Agent close/Escape/audit/clear, argument exit/delete/quality and context/browser back rollback; all memory-only.');
