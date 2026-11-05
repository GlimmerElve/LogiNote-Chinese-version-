import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import { buildCognitionManagement, cognitionGraphPositions, cognitionOverviewPositions, COGNITION_OVERVIEW_NODE_SIZE } from '../src/services/cognition/management';
import { buildInquirySnapshot, resolveInquiryQuestion } from '../src/services/cognition/inquiry';
import { isCognitionManagerOpenRequest, openCognitionManager } from '../src/services/cognition/managerWindow';
import { syncSavedRestatementsForCognition } from '../src/services/cognition/store';
import { registerUiTools } from '../src/services/agent/tools/uiTools';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import type { AgentRuntimeContext } from '../src/services/agent/types';

export function cognitionManagementFixture() {
  const at = '2026-10-20T01:00:00Z';
  let file = emptyCognitionFile();
  for (const [docId, title, nodes, edges] of [
    ['mental', '心理账户与消费决策', [
      { id: 'p', role: 'premise', mainType: '事实陈述', text: '我会给不同来源的钱分配不同的用途。' },
      { id: 'c', role: 'claim', mainType: '推理', text: '心理账户的分类会改变我的消费决策。' },
      { id: 'o', role: 'premise', mainType: '假设', text: '但我在某些情况下仍然可以灵活调整分类。', stance: 'tentative' },
    ], [{ id: 'support', source: 'p', target: 'c', relation: 'support' }, { id: 'oppose', source: 'o', target: 'c', relation: 'oppose' }]],
    ['flow', '心流与注意力', [
      { id: 'p', role: 'premise', mainType: '事实陈述', text: '目标清晰时，我更容易保持注意力。' },
      { id: 'c', role: 'claim', mainType: '推理', text: '适当的挑战有助于我进入心流。' },
    ], [{ id: 'support', source: 'p', target: 'c', relation: 'support' }]],
    ['lone', '概率与不确定性', [{ id: 'p', role: 'claim', mainType: '假设', text: '我需要区分事件的不确定性与自己缺少的信息。' }], []],
  ] as const) {
    file = applyCognitionMutation(file, { kind: 'confirm', confirmed: true, expectedRevision: file.revision, operation: 'initial',
      authorship: 'own_expression', stance: 'endorsed', reason: '', doc: { doc_id: docId, title, nodes, edges } }, { id: docId, at });
  }
  return file;
}

if (process.argv[1]?.endsWith('check-cognition-management.ts')) {
let groups = 0; const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
let file = cognitionManagementFixture();
const original = JSON.stringify(file), model = buildCognitionManagement(file);
assert.equal(model.groups.length, 3); assert.equal(model.summary.nodes, 6); assert.equal(model.summary.endorsed, 5);
assert.equal(model.summary.tentative, 1); assert.equal(model.summary.isolated, 1); assert.equal(model.summary.connectedGroups, 2);
assert.equal(model.summary.edges, 3); assert.equal(model.summary.brokenReferences, 0);
assert.equal(new Set(model.groups.flatMap(group => group.nodes.map(node => node.id))).size, 6, 'same local ID in different activities never merges');
assert.equal(buildCognitionManagement(file, { filter: 'isolated' }).groups[0].recordId, 'lone');
assert.equal(buildCognitionManagement(file, { filter: 'tentative' }).groups[0].recordId, 'mental');
assert.equal(buildCognitionManagement(file, { query: '保持注意力' }).groups[0].nodes.length, 2, 'search preserves connected context instead of fabricating isolation');
assert.equal(JSON.stringify(file), original); assert.deepEqual(buildInquirySnapshot(file, '查看我的认知库').graphSummary, model.summary);
pass('graph view and Agent share exact current topology, beliefs, tentative states and disconnected groups; search never creates false isolation or cross-activity edges');
const record = file.records[0], revision = latestCognition(record);
file = applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true, target: {
  recordId: record.id, revisionId: revision.id, branchId: 'primary', nodeId: 'p', operation: 'revise', reason: '限定我自己的表述' },
  text: '我只在特定收入情境下划分心理账户。', mainType: '事实陈述', stance: 'endorsed', authorship: 'own_expression' }, { id: 'revised', at: '2026-10-20T02:00:00Z' });
assert.equal(buildCognitionManagement(file).summary.needsReview, 1);
assert.equal(buildCognitionManagement(file, { filter: 'review' }).groups[0].recordId, record.id);
assert.equal(buildCognitionManagement({ ...file, records: file.records.map(record => ({ ...record, withdrawn: true })) }).summary.nodes, 0);
const cyclic = cognitionGraphPositions([{ id: 'a' }, { id: 'b' }], [{ id: '1', source: 'a', target: 'b', relation: 'support' }, { id: '2', source: 'b', target: 'a', relation: 'support' }]);
assert.equal(cyclic.size, 2); assert.ok([...cyclic.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
pass('current revisions replace old views, withdrawn records disappear, dependency review flags remain independent from truth/mastery and cyclic graphs lay out safely');

const overviewInput = Array.from({ length: 80 }, (_, i) => ({ id: `overview-${i}` })), overviewBefore = JSON.stringify(overviewInput);
for (const viewport of [{ width: 375, height: 430 }, { width: 700, height: 520 }, { width: 1500, height: 500 }, { width: 0, height: 0 }]) {
  for (const count of [0, 1, 2, 3, 12, 80]) {
    const input = overviewInput.slice(0, count), result = cognitionOverviewPositions(input, viewport), points = [...result.values()];
    assert.equal(result.size, count);
    assert.deepEqual([...result.keys()], input.map(group => group.id), 'layout never changes reading/activation order');
    assert.deepEqual(result, cognitionOverviewPositions(input, viewport), 'no random movement on repeated renders');
    for (let i = 0; i < points.length; i++) {
      assert.ok(Number.isFinite(points[i].x) && Number.isFinite(points[i].y));
      for (let j = i + 1; j < points.length; j++) assert.ok(Math.abs(points[i].x - points[j].x) >= COGNITION_OVERVIEW_NODE_SIZE.width + 40
        || Math.abs(points[i].y - points[j].y) >= COGNITION_OVERVIEW_NODE_SIZE.height + 32, 'overview cards and their spacing must not overlap');
    }
    if (count) {
      assert.ok(Math.abs(Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x)) + COGNITION_OVERVIEW_NODE_SIZE.width) <= 1);
      assert.ok(Math.abs(Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y)) + COGNITION_OVERVIEW_NODE_SIZE.height) <= 1);
    }
    if (count >= 12) assert.ok(new Set(points.map(point => point.x)).size > 4, 'default positions cannot regress to two rigid columns');
  }
}
assert.equal(JSON.stringify(overviewInput), overviewBefore);
assert.notDeepEqual(cognitionOverviewPositions(overviewInput, { width: 375, height: 430 }), cognitionOverviewPositions(overviewInput, { width: 1500, height: 500 }));
pass('overview uses deterministic centered spatial packing without columns, overlaps, reordered groups, mutations or unsafe zero-sized viewport values');

const main = readFileSync('src/electron/main.ts', 'utf8'), ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
function compile(name: string, env: Record<string, unknown>) {
  let source = ''; const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) source = node.getText(ast); ts.forEachChild(node, visit); }; visit(ast); assert.ok(source);
  const js = ts.transpileModule(`${source}\nreturn ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
const handlers = new Map<string, (...args: any[]) => any>();
const root = path.resolve('synthetic-renderer-root'), mainContents: any = { mainFrame: { url: pathToFileURL(path.join(root, 'dist/index.html')).href } };
let instance: any, windows = 0, decision = 0;
class WindowMock {
  handlers = new Map<string, (...args: any[]) => void>();
  webContents: any = { mainFrame: { url: pathToFileURL(path.join(root, 'dist/cognition.html')).href }, on: (name: string, fn: any) => this.handlers.set(name, fn) };
  destroyed = false; shown = 0; config: any;
  constructor(config: any) { windows++; instance = this; this.config = config; }
  isDestroyed() { return this.destroyed; } on(name: string, fn: any) { this.handlers.set(name, fn); }
  show() { this.shown++; } focus() {} async loadFile(file: string) { assert.equal(file, path.join(root, 'dist/cognition.html')); }
  destroy() { this.destroyed = true; this.handlers.get('closed')?.(); }
}
const shared: Record<string, any> = { BrowserWindow: WindowMock, app: { getAppPath: () => root }, path, URL, fileURLToPath,
  mainWindow: { webContents: mainContents }, currentWindowTheme: 'light', windowThemeReady: true, windowThemeBackground: () => 'background',
  ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn), on: (name: string, fn: any) => handlers.set(name, fn) },
  installMainWindowNavigationGuard() {}, isTrustedRendererLocation: () => true, normalizeWindowTheme() {}, publishWindowTheme() {},
  dialog: { showMessageBoxSync: () => decision }, cognitionWindow: null, cognitionWindowBusy: false };
// Mutable native state must stay in the same closure as the actual handlers.
const registerSource = main.slice(main.indexOf('function registerWindowControls()'), main.indexOf('function createArgumentWindow()'));
const callerSource = main.slice(main.indexOf('function isCognitionWindowCaller('), main.indexOf('/** A frameless app window'));
const js = ts.transpileModule(`let cognitionWindow = null, cognitionWindowBusy = false; ${callerSource}\n${registerSource}\nregisterWindowControls();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { cognitionWindow: unused, cognitionWindowBusy: unusedBusy, ...env } = shared;
new Function(...Object.keys(env), js)(...Object.values(env));
await assert.rejects(handlers.get('cognition-manager:open')!({ sender: {}, senderFrame: {} }), /无权/);
await handlers.get('cognition-manager:open')!({ sender: mainContents, senderFrame: mainContents.mainFrame });
assert.equal(windows, 1); assert.equal(instance.config.webPreferences.contextIsolation, true); assert.equal(instance.config.webPreferences.nodeIntegration, false);
await handlers.get('cognition-manager:open')!({ sender: mainContents, senderFrame: mainContents.mainFrame }); assert.equal(windows, 1);
const ownEvent = { sender: instance.webContents, senderFrame: instance.webContents.mainFrame };
handlers.get('cognition-manager:busy')!(ownEvent, true);
let prevented = 0; instance.handlers.get('close')({ preventDefault: () => prevented++ }); assert.equal(prevented, 1);
handlers.get('cognition-manager:busy')!({ sender: {}, senderFrame: ownEvent.senderFrame }, false);
instance.handlers.get('close')({ preventDefault: () => prevented++ }); assert.equal(prevented, 2, 'foreign renderer cannot release a saving window');
handlers.get('cognition-manager:busy')!(ownEvent, false); decision = 0;
instance.handlers.get('will-prevent-unload')({ preventDefault: () => prevented++ }); assert.equal(prevented, 2);
decision = 1; instance.handlers.get('will-prevent-unload')({ preventDefault: () => prevented++ }); assert.equal(prevented, 3);
pass('actual native handlers enforce main-frame opening, single-instance focus, context isolation, owned busy signalling and recoverable dirty-close decisions');

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), fetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('No network');
try {
  let opened = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { cognitionManager: { open: async () => { opened++; } } } } });
  assert.equal(isCognitionManagerOpenRequest('请打开我的个人认知图谱窗口'), true);
  assert.equal(isCognitionManagerOpenRequest('不要打开个人认知窗口'), false);
  assert.equal(isCognitionManagerOpenRequest('我的认知里有哪些观点'), false);
  assert.equal(resolveInquiryQuestion('打开我的认知库窗口', []), undefined);
  await openCognitionManager(); assert.equal(opened, 1);
  registerUiTools();
  const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
    hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
  const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '请打开我的个人认知图谱窗口', history: [], ctx,
    memoryPrefixLoader: async () => '', callLlm: async request => {
      assert.equal(request.workflow, 'agent-intent-routing', 'opening a window needs no QA, cognition-content read or model completion');
      return { content: '', parsedJson: { skillId: 'personalized-qa', confidence: .99, standaloneRequest: '打开我的个人认知图谱窗口', referenceResolution: 'none' } };
    } });
  assert.equal(opened, 2); assert.ok(result.toolTrace.some(step => step.call.name === 'open_cognition_manager' && step.ok));
  assert.equal(result.pendingApproval, undefined); assert.match(result.reply, /已打开/);
  (window as any).electronAPI.cognitionManager.open = async () => { throw new Error('synthetic open failure'); };
  await assert.rejects(openCognitionManager(), /open failure/);
  delete (window as any).electronAPI.cognitionManager;
  await assert.rejects(openCognitionManager(), /重启/);
  (window as any).electronAPI = { userState: { getAgentTaskScope: async () => 'synthetic-scope',
    searchCognition: async () => assert.fail('Source sync must not run retrieval or embeddings') }, vault: { loadVault: async () => [] } };
  assert.equal((await syncSavedRestatementsForCognition()).warning, '');
  (window as any).electronAPI.vault.loadVault = async () => { throw new Error('synthetic source unavailable'); };
  assert.match((await syncSavedRestatementsForCognition()).warning, /同步暂不可用/);
  pass('actual Agent opens the manager without QA/private-read side effects, reports native failure truthfully and never falls back to a public browser store on a stale desktop bridge');
} finally { globalThis.fetch = fetch; if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window'); }
console.log(`Cognition management: ${groups} groups passed; synthetic native/UI boundaries, no user vault/model/network.`);
}
