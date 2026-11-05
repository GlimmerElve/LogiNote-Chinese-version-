import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { buildAgentAcceptanceSnapshot } from '../src/services/agent/acceptance';
import { readFreshAuditFile, assertAudit, auditRecord } from '../src/services/agent/auditRead';
import { normalizeSceneCapabilityId, normalizeUnifiedSceneRecipeId } from '../src/services/scene/sceneCapabilityRegistry';

globalThis.fetch = async () => assert.fail('Audit UI checks cannot use network');
function compile(path: string, bindings: any, names: string[]) {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export\s+/gm, '');
  const code = ts.transpileModule(`${source}\nreturn {${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings));
}
const defer = () => { let resolve!: (value: any) => void, reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const now = new Date().toISOString();
const run = (id: string) => ({ id, roleId: 'test', userRequest: 'synthetic', status: 'completed', createdAt: now, updatedAt: now, steps: [], approvals: [] });
const configs = [
  { path: 'src/services/agent/auditStore.ts', load: 'loadAgentAudit', key: 'loginote_agent_audit_v1', collection: 'runs',
    file: { version: 2, runs: [run('one')], handoffs: [] }, append: run('two') },
  { path: 'src/services/scene/sceneInteractionAudit.ts', load: 'loadSceneInteractionAudit', key: 'loginote_scene_interaction_audit_v1', collection: 'events',
    file: { version: 1, events: [{ id: 'one', runId: 'run', sceneId: 'scene', turnNumber: 1, outcome: 'accepted', reason: 'accepted', resolvedType: 'text', allowedTypes: ['text'], createdAt: now }] },
    append: { id: 'two', runId: 'run', sceneId: 'scene', turnNumber: 2, outcome: 'text-fallback', reason: 'invalid-fields', resolvedType: 'text', createdAt: now } },
  { path: 'src/services/scene/sceneAssemblyAudit.ts', load: 'loadSceneAssemblyAudit', key: 'loginote_scene_assembly_audit_v1', collection: 'events',
    file: { version: 1, events: [{ id: 'one', sceneId: 'scene', sceneSkill: 'S1', outcome: 'ready', createdAt: now, diagnosticCodes: [] }] },
    append: { id: 'two', sceneId: 'scene', sceneSkill: 'S4', outcome: 'blocked', createdAt: now, diagnosticCodes: [] } },
];
const summaries: any = {};
for (const config of configs) {
  let source: any = structuredClone(config.file), nativeReads = 0, writes = 0, storageText: string | null = null;
  const browser: any = { electronAPI: { isElectron: true, userState: { [config.load]: async (strict?: boolean) => {
    nativeReads++; assert.equal(strict, true); return source;
  } } } };
  const storage: any = { getItem() { return storageText; }, setItem() { writes++; } };
  // Fresh-read helper also runs inside the isolated context, not Node global storage.
  const helper = compile('src/services/agent/auditRead.ts', { window: browser, localStorage: storage }, ['readFreshAuditFile', 'auditRecord', 'assertAudit']);
  const names = [config.load, 'normalizeAgentAuditFile', 'summarizeAgentHandoffAudit', 'summarizeSceneInteractionAudit', 'summarizeSceneAssemblyAudit']
    .filter(name => readFileSync(config.path, 'utf8').includes(`function ${name}(`) || name === config.load);
  const service = compile(config.path, { ...helper, window: browser, localStorage: storage, getTool() {}, normalizeSceneCapabilityId, normalizeUnifiedSceneRecipeId,
    console: { warn() {} } }, names);
  Object.assign(summaries, service);
  const initial = await service[config.load](true);
  assert.equal(initial[config.collection].length, 1);
  const before = JSON.stringify(source);
  source[config.collection].push(config.append);
  const refreshed = await service[config.load](true);
  assert.equal(refreshed[config.collection].length, 2); assert.equal(nativeReads, 2);
  assert.equal(writes, 0, 'refresh never writes to browser/native cache');
  source = null; storageText = before;
  assert.equal((await service[config.load](true))[config.collection].length, 0, 'missing native file cannot resurrect an old cache');
  browser.electronAPI.userState[config.load] = async () => { throw new Error('private native path'); };
  await assert.rejects(service[config.load](true), /private native path/);
  browser.electronAPI.userState = {}; await assert.rejects(service[config.load](true), /接口不可用/);
  browser.electronAPI = undefined;
  storageText = null; assert.equal((await service[config.load](true))[config.collection].length, 0);
  for (const value of ['{broken', 'null', '{}', JSON.stringify({ [config.collection]: [{}] })]) {
    storageText = value; await assert.rejects(service[config.load](true));
  }
  storageText = before; assert.equal((await service[config.load](true))[config.collection].length, 1);
  storageText = '{broken'; assert.equal((await service[config.load]())[config.collection].length, 0, 'legacy tolerant reads remain compatible');
  storageText = before; assert.equal((await service[config.load](true))[config.collection].length, 1, 'fresh path bypasses legacy cache');
  assert.equal((await service[config.load]())[config.collection].length, 0, 'fresh reads do not replace mutable recording caches');
  assert.equal(writes, 0);
}
// Real dashboard reads one Agent file, strict flags, and waits for all clear attempts.
let agentReads = 0, sceneReads = 0;
let clearAgent = defer(), clearInteraction = defer(), clearAssembly = defer();
const dashboard = compile('src/services/agent/auditDashboard.ts', { ...summaries, buildAgentAcceptanceSnapshot,
  loadAgentAudit: async (strict: boolean) => { assert.equal(strict, true); agentReads++; return { runs: [run('one')], handoffs: [] }; },
  loadSceneInteractionAudit: async (strict: boolean) => { assert.equal(strict, true); sceneReads++; return { events: [] }; },
  loadSceneAssemblyAudit: async (strict: boolean) => { assert.equal(strict, true); sceneReads++; return { events: [] }; },
  clearAgentAudit: () => clearAgent.promise, clearSceneInteractionAudit: () => clearInteraction.promise, clearSceneAssemblyAudit: () => clearAssembly.promise,
}, ['loadAgentAuditDashboard', 'clearAgentAuditDashboard', 'buildAgentAuditDashboard']);
const sample = await dashboard.loadAgentAuditDashboard(); assert.equal(sample.agent.total, 1); assert.equal(agentReads, 1); assert.equal(sceneReads, 2);
let clearSettled = false; const clearing = dashboard.clearAgentAuditDashboard().catch(() => { clearSettled = true; });
clearAgent.reject(new Error('private write failure')); await settle(); assert.equal(clearSettled, false);
clearInteraction.resolve(undefined); await settle(); assert.equal(clearSettled, false);
clearAssembly.resolve(undefined); await clearing; assert.equal(clearSettled, true);

// Execute native file helper + IPC handlers + preload forwarding against memory-only IO.
const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const mainAst = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const reader = mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readUserStateFileIfExists')!;
let fileText: string | null = null, code = 'ENOENT';
const context: any = { getUserStateDir: () => 'synthetic', path: { join: (...parts: string[]) => parts.join('/') },
  fs: { readFile: async () => { if (fileText === null) throw Object.assign(new Error('private path'), { code }); return fileText; } },
  USER_STATE_FILES: { agentAudit: 'agent', sceneInteractionAudit: 'interaction', sceneAssemblyAudit: 'assembly' } };
runInNewContext(transpile(reader.getText(mainAst)) + '\nthis.read = readUserStateFileIfExists;', context);
const channels = ['user-state:load-agent-audit', 'user-state:load-scene-interaction-audit', 'user-state:load-scene-assembly-audit'];
const handlers = new Map<string, any>();
function visitNative(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle' && ts.isStringLiteral(node.arguments[0]) && channels.includes(node.arguments[0].text)) {
    handlers.set(node.arguments[0].text, runInNewContext(transpile(`const fn = ${node.arguments[1].getText(mainAst)};`) + '\nfn', { ...context, readUserStateFileIfExists: context.read }));
  } ts.forEachChild(node, visitNative);
} visitNative(mainAst); assert.equal(handlers.size, 3);
for (const [channel, handler] of handlers) {
  fileText = null; code = 'ENOENT'; assert.equal(await handler(null, true), null);
  code = 'EACCES'; await assert.rejects(handler(null, true)); assert.equal(await handler(null), null);
  for (const input of ['', '{broken', 'null', '{}']) {
    fileText = input; await assert.rejects(handler(null, true));
    assert.equal(JSON.stringify(await handler(null)), input === '{}' ? '{}' : 'null');
  }
  fileText = JSON.stringify(channel.includes('load-agent') ? { runs: [], handoffs: [] } : { events: [] }); assert.ok(await handler(null, true));
}
const preloadAst = ts.createSourceFile('preload.ts', readFileSync('src/electron/preload.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let forwarded: unknown[] = [], bridges = 0;
function visitBridge(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && configs.some(config => config.load === node.name.getText(preloadAst))) {
    const fn = runInNewContext(transpile(`const fn = ${node.initializer.getText(preloadAst)};`) + '\nfn', { ipcRenderer: { invoke: (...args: unknown[]) => { forwarded = args; } } });
    fn(true); assert.ok(channels.includes(String(forwarded[0]))); assert.equal(forwarded[1], true); fn(); assert.equal(forwarded[1], undefined); bridges++;
  } ts.forEachChild(node, visitBridge);
} visitBridge(preloadAst); assert.equal(bridges, 3);

function runtime() {
  const slots: any[] = [], effects: any[] = []; let cursor = 0, changes = 0;
  const changed = (a: any[] | undefined, b: any[]) => !a || b.some((value, i) => value !== a[i]);
  return {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { changes++; slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return `audit-${cursor++}`; },
    useCallback(fn: any, deps: any[]) { const i = cursor++; if (changed(slots[i]?.deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn: any, deps: any[]) { const i = cursor++; if (changed(effects[i]?.deps, deps)) effects[i] = { fn, deps, pending: true, cleanup: effects[i]?.cleanup }; },
    begin() { cursor = 0; }, flush() { effects.forEach(effect => { if (effect?.pending) { effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false; } }); },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); }, changes: () => changes,
  };
}
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const button = (tree: any, label: string) => { const found = flat(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; };
const state = runtime(), body = {}, doc = { body, activeElement: body as any };
let readGate = defer(), clearGate = defer(), loads = 0, clears = 0, backs = 0, dialogClose: (() => void) | undefined;
const icons = Object.fromEntries(['Activity', 'AlertTriangle', 'ArrowLeft', 'Blocks', 'CheckCircle2', 'ClipboardEdit', 'RefreshCw', 'Route', 'ShieldCheck', 'Trash2'].map(name => [name, () => null]));
const view = compile('src/components/AgentAuditView.tsx', { React, ...state, ...icons, document: doc,
  useDialog(_open: boolean, _ref: any, close: () => void) { dialogClose = close; },
  loadAgentAuditDashboard: () => { loads++; return readGate.promise; }, clearAgentAuditDashboard: () => { clears++; return clearGate.promise; },
}, ['AgentAuditView', 'statusTone']);
const domButtons = new Map<string, any>();
function render() {
  state.begin(); const tree = view.AgentAuditView({ onBack() { backs++; } });
  const nodes = flat(tree), tabs = nodes.filter(node => node.props.role === 'tab');
  for (const node of nodes) if (node.props.ref) {
    if (node.props.role === 'tablist') node.props.ref.current = { querySelectorAll: () => tabs.map(tab => ({ focus() { doc.activeElement = tab; } })) };
    else if (node.type === 'button') {
      const key = node.props.ref; if (!domButtons.has(key)) domButtons.set(key, { focus() { doc.activeElement = node; } }); node.props.ref.current = domButtons.get(key);
    }
  }
  state.flush(); return tree;
}
let tree = render(); assert.equal(loads, 1); assert.equal(button(tree, '读取中…').props.disabled, true);
button(tree, '读取中…').props.onClick(); assert.equal(loads, 1, 'same-frame refresh uses shared lock');
readGate.reject(new Error('private disk path')); await settle(); tree = render(); assert.match(text(tree), /读取审计记录失败/); assert.doesNotMatch(text(tree), /private disk path|正在读取/);
assert.equal(button(tree, '清除审计记录').props.disabled, true);
readGate = defer(); button(tree, '重新读取').props.onClick(); button(tree, '重新读取').props.onClick(); assert.equal(loads, 2);
tree = render();
readGate.resolve(sample); await settle(); tree = render(); assert.equal(button(tree, '清除审计记录').props.disabled, false); assert.equal(doc.activeElement.type, 'button');
const tabs = flat(tree).filter(node => node.props.role === 'tab'); assert.equal(tabs.filter(node => node.props.tabIndex === 0).length, 1);
const key = (value: string, extra = {}) => ({ key: value, nativeEvent: {}, preventDefault() {}, ...extra });
tabs[0].props.onKeyDown(key('End')); tree = render(); assert.equal(flat(tree).find(node => node.props.role === 'tab' && node.props['aria-selected']).props.children, '场景');
flat(tree).find(node => node.props.role === 'tab' && node.props.children === '场景').props.onKeyDown(key('ArrowRight')); tree = render(); assert.equal(flat(tree).find(node => node.props.role === 'tab' && node.props['aria-selected']).props.children, '概览');
tabs[0].props.onKeyDown(key('End', { ctrlKey: true })); tree = render(); assert.equal(flat(tree).find(node => node.props.role === 'tabpanel').props['aria-labelledby'], tabs[0].props.id);
assert.equal(view.statusTone('passed'), 'good'); assert.equal(view.statusTone('incomplete'), 'warn');
// Refresh failure retains the previous successful snapshot and labels it stale.
readGate = defer(); button(tree, '重新读取').props.onClick(); tree = render(); assert.match(text(tree), /保留上次内容/);
readGate.reject(new Error('private')); await settle(); tree = render(); assert.ok(flat(tree).some(node => node.props.label === 'Agent 运行' && node.props.value === 1));
readGate = defer(); button(tree, '重新读取').props.onClick(); readGate.resolve(sample); await settle(); tree = render();
button(tree, '清除审计记录').props.onClick(); tree = render(); dialogClose!(); tree = render(); assert.equal(clears, 0); assert.ok(!flat(tree).some(node => node.props.role === 'dialog'));
button(tree, '清除审计记录').props.onClick(); tree = render(); const confirm = button(tree, '确认清除').props.onClick; confirm(); confirm(); assert.equal(clears, 1);
tree = render(); dialogClose!(); assert.equal(button(tree, '保留记录').props.disabled, true); assert.equal(button(tree, '返回对话').props.disabled, true);
clearGate.reject(new Error('private secret')); await settle(); tree = render(); assert.match(text(tree), /部分记录可能已清除/); assert.doesNotMatch(text(tree), /private secret/); assert.equal(button(tree, '清除审计记录').props.disabled, true);
readGate = defer(); button(tree, '重新读取').props.onClick(); readGate.resolve(sample); await settle(); tree = render(); assert.equal(clears, 1, 'retry only rereads, never repeats deletion');
clearGate = defer(); readGate = defer(); button(tree, '清除审计记录').props.onClick(); tree = render(); button(tree, '确认清除').props.onClick(); clearGate.resolve(undefined); await settle();
readGate.reject(new Error('private reread')); await settle(); tree = render(); assert.match(text(tree), /清除已成功，但重新读取失败/);
assert.ok(!flat(tree).some(node => node.props.label === 'Agent 运行'), 'acknowledged clear invalidates old snapshot');
readGate = defer(); button(tree, '重新读取').props.onClick(); readGate.resolve(dashboard.buildAgentAuditDashboard({ runs: [], handoffs: [], interactions: [], assemblies: [] })); await settle(); tree = render(); assert.equal(clears, 2);
// Ignore late reads after unmount; no state writes or navigation.
readGate = defer(); button(tree, '重新读取').props.onClick(); state.unmount(); const changes = state.changes(); readGate.resolve(sample); await settle(); assert.equal(state.changes(), changes); assert.equal(backs, 0);
assert.equal(typeof readFreshAuditFile, 'function'); assert.throws(() => auditRecord(null)); assert.throws(() => assertAudit(false));
console.log('PASS Agent audit UI: strict fresh zero-write reads, safe failure/stale states, native IPC/bridge, keyboard tabs, confirmation, shared locks, all-store clear settlement and late replies.');
