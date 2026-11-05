import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { FlowResultWriteController, type FlowResultOperation } from '../src/services/ui/flowResultWrite';
import { createMockFlowResult } from '../src/services/flowAnalysis/mockResult';
import type { FlowResultData } from '../src/components/FlowResultView';

// Synthetic memory only: never load a vault, invoke a provider or call IPC.
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let current: FlowResultData | null = createMockFlowResult();
let phase: FlowResultOperation | null = null, notice = '', closes = 0, saves = 0;
const controller = new FlowResultWriteController();
let gate = deferred<boolean>();
const dependencies = {
  current: () => current,
  phase: (value: FlowResultOperation | null) => { phase = value; },
  notice: (value: string) => { notice = value; },
  save: async (_snapshot: FlowResultData) => { saves++; return gate.promise; },
  reassess: async (doc: FlowResultData['doc']) => ({ ...doc, iteration: (doc.iteration || 0) + 1 }),
  apply: (value: FlowResultData) => { current = value; },
  saved: () => { closes++; current = null; },
};
const first = controller.run('save', dependencies);
assert.equal(controller.busy, true);
assert.equal(phase, 'save');
await controller.run('save', dependencies);
await controller.run('reassess', dependencies);
assert.equal(saves, 1, 'save and reassessment share a synchronous same-frame lock');
current = { ...current!, doc: { ...current!.doc, title: '保存期间的新修改' } };
gate.resolve(true);
assert.equal(await first, false);
assert.equal(closes, 0, 'successful old snapshot cannot close a newer draft');
assert.match(notice, /新修改尚未保存/);
assert.equal(controller.busy, false);

// Failed saves retain the draft and can be retried; false acknowledgements are failures.
gate = deferred<boolean>();
const failed = controller.run('save', dependencies);
gate.resolve(false);
assert.equal(await failed, false);
assert.equal(current!.doc.title, '保存期间的新修改');
assert.match(notice, /未能保存/);
gate = deferred<boolean>();
const retry = controller.run('save', dependencies);
gate.resolve(true);
assert.equal(await retry, true);
assert.equal(closes, 1);

// Position-only edits matter, and stale reassessment cannot overwrite them.
current = createMockFlowResult();
const assessment = deferred<FlowResultData['doc']>();
const report = current.report;
const reassess = controller.run('reassess', { ...dependencies, reassess: () => assessment.promise });
current = { ...current, doc: { ...current.doc, nodes: current.doc.nodes.map((node, index) => index ? node
  : { ...node, position: { x: node.position.x + 1, y: node.position.y } }) } };
assessment.resolve({ ...current.doc, iteration: 100 });
assert.equal(await reassess, false);
assert.notEqual(current.doc.iteration, 100);
assert.equal(current.report, report, 'reassessment never changes the original spoken report or scores');
assert.match(notice, /未覆盖/);

// A replaced result is a new session even if note, graph and timestamp happen to match.
gate = deferred<boolean>();
const stale = controller.run('save', dependencies);
current = { ...current, report: structuredClone(current.report) };
gate.resolve(true);
assert.equal(await stale, false);
assert.equal(closes, 1);
await controller.run('reassess', dependencies);
assert.equal(current.report !== report, true);
const failedAssessment = deferred<FlowResultData['doc']>();
const failingReassessment = controller.run('reassess', { ...dependencies, reassess: () => failedAssessment.promise });
const preserved = current;
failedAssessment.reject(new Error('synthetic provider unavailable'));
assert.equal(await failingReassessment, false);
assert.equal(current, preserved);
assert.match(notice, /重评失败/);
const beforeNoop = current;
let noopApplies = 0;
await controller.run('reassess', { ...dependencies, reassess: async doc => structuredClone(doc), apply: () => { noopApplies++; } });
assert.equal(current, beforeNoop);
assert.equal(noopApplies, 0);
assert.match(notice, /未发送模型请求/);

// Actual production view, isolated hooks + boundary components: test handlers, not source labels alone.
let cursor = 0;
const slots: any[] = [];
const hooks = { ...React,
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
    return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useEffect() {}, useMemo: (fn: () => any) => fn(), useCallback: (fn: any) => fn,
};
const path = resolve('src/components/FlowResultView.tsx');
const localRequire = createRequire(path);
const module = { exports: {} as any };
const store = Object.assign((selector: any) => selector({ doc: current!.doc }), { getState: () => ({ doc: current!.doc }) });
runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} }).outputText, { module, exports: module.exports, require(id: string) {
  if (id === 'react') return hooks;
  if (id === './useDialog') return { useDialog() {} };
  if (id === './ArgumentPublicationDialog') return { ArgumentPublicationDialog: () => null };
  if (id === './PersonalCognitionPanel') return { PersonalCognitionPanel: () => null };
  if (id === './FlowResultStyleCards') return { FlowResultStyleCards: () => null };
  if (id === './KnowledgeMasteryDetails') return { KnowledgeMasteryDetails: () => null, KnowledgeMasteryStateGuide: () => null };
  if (id === './StructureReviewPanel') return { StructureReviewPanel: () => null };
  if (id.endsWith('/ui/cognitionLeave')) return { allowCognitionLeave: () => true };
  if (id.endsWith('/ui/argumentPublication')) return { prepareArgumentPublication: () => ({
    assessment: { score: 70, issues: [] }, semanticFresh: true, evidenceAssessment: { grade: 'B' },
    effective: { score: 70, admission: 'publishable' }, corrections: [], canPublish: true, draftReason: null,
  }) };
  if (id.includes('/store/canvasStore')) return { useCanvasStore: store };
  if (id === '@xyflow/react') return { ReactFlowProvider: () => null };
  if (id.includes('/argumentCanvas/') || id.endsWith('/layout')) return {};
  return localRequire(id);
}, Date, Set, Math });
const flatten = (node: any): any[] => Array.isArray(node) ? node.flatMap(flatten)
  : node?.props ? [node, ...flatten(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('')
  : node?.props ? text(node.props.children) : typeof node === 'string' ? node : '';
let backs = 0;
const props: any = { data: current, onChange() {}, onSave() {}, onResubmit() {}, onBack() { backs++; } };
const render = () => { cursor = 0; return module.exports.FlowResultView(props); };
const button = (tree: any, label: string) => { const result = flatten(tree).find(node => node.type === 'button' && text(node) === label);
  assert.ok(result, label); return result; };
props.operation = 'save';
let tree = render();
assert.equal(button(tree, '正在保存结果…').props.disabled, true);
assert.equal(button(tree, '再次提交结构评价').props.disabled, true);
assert.equal(button(tree, '检查整张图').props.disabled, true);
assert.equal(button(tree, '返回笔记').props.disabled, true);
assert.ok(flatten(tree).find(node => node.props.className === 'flow-result-canvas' && node.props.inert));
props.operation = null;
const originalData = props.data;
props.data = { ...originalData, report: { ...originalData.report, unscoredLayers: ['reasoning'] } };
tree = render();
const rings = flatten(tree).filter(node => String(node.props.className || '').startsWith('flow-result-score-ring'));
assert.equal(rings[2].props.children.props.children, '—', 'Unscored reasoning must not render its compatibility zero');
assert.ok(text(tree).includes('暂不可评'), 'Unknown performance is explicit text, not just a ring color');
props.data = originalData;
tree = render();
button(tree, '返回笔记').props.onClick();
assert.equal(backs, 0, 'return first asks for confirmation');
tree = render();
assert.ok(flatten(tree).find(node => node.props.role === 'dialog'));
button(tree, '继续编辑').props.onClick();
tree = render();
assert.ok(!flatten(tree).find(node => node.props.role === 'dialog'));
button(tree, '返回笔记').props.onClick();
tree = render();
button(tree, '放弃并返回').props.onClick();
assert.equal(backs, 1);

const app = readFileSync('src/App.tsx', 'utf8');
// Execute the actual App dispatcher with memory boundaries, including a store edit
// not yet emitted by the canvas effect and navigation during a pending save.
const parsedApp = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let dispatcher = '';
let beforeUnload = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsedApp) === 'runFlowResultOperation') dispatcher = node.initializer!.getText(parsedApp);
  if (ts.isVariableDeclaration(node) && node.name.getText(parsedApp) === 'beforeUnload'
    && node.initializer?.getText(parsedApp).includes('flowResultRef.current')) beforeUnload = node.initializer.getText(parsedApp);
  ts.forEachChild(node, visit);
}
visit(parsedApp);
assert.ok(dispatcher);
const resultRef = { current: { ...createMockFlowResult(), isMock: false } as FlowResultData | null };
const viewRef = { current: 'editor' };
const canvasMemory = { doc: { ...resultRef.current!.doc, title: '尚未由 React 回传的编辑' }, initDoc(doc: FlowResultData['doc']) { this.doc = doc; } };
let captured: FlowResultData['doc'] | undefined, navigateAfterSave: boolean | undefined, publicationChoice: string | undefined;
let navigations = 0;
let reassessMode = '';
let appGate = deferred<boolean>();
const appContext: any = {
  exports: {}, FlowResultWriteController,
  flowResultRef: resultRef, currentViewRef: viewRef,
  flowResultWriteRef: { current: new FlowResultWriteController() },
  useCanvasStore: { getState: () => canvasMemory },
  setFlowResultOperation() {}, setFlowResultNotice() {},
  saveArgumentDoc(doc: FlowResultData['doc'], _note: string, _mode: string, _session: string, navigate: boolean, publication: string) {
    captured = doc; navigateAfterSave = navigate; publicationChoice = publication; return appGate.promise;
  },
  reassessArgumentStructure: async (doc: FlowResultData['doc'], _caller: unknown, mode: string) => { reassessMode = mode; return { ...doc, iteration: 99 }; },
  setFlowResult(value: FlowResultData | null) { resultRef.current = value; },
  setActiveNoteId() {}, setCurrentView() { navigations++; },
  Date, Promise,
};
runInNewContext(ts.transpileModule(`const run = ${dispatcher}; globalThis.run = run;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, appContext);
const appSave = appContext.run('save');
assert.equal(captured!.title, '尚未由 React 回传的编辑');
assert.equal(navigateAfterSave, false);
assert.equal(publicationChoice, 'draft');
viewRef.current = 'review';
appGate.resolve(true);
await appSave;
assert.equal(navigations, 0, 'late result save cannot force navigation out of another session');
assert.ok(resultRef.current);
viewRef.current = 'editor';
appGate = deferred<boolean>();
const appRetry = appContext.run('save');
appGate.resolve(true);
await appRetry;
assert.equal(navigations, 1);
assert.equal(resultRef.current, null);
assert.ok(beforeUnload);
runInNewContext(ts.transpileModule(`const unload = ${beforeUnload}; globalThis.unload = unload;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, appContext);
let prevented = 0;
const unloadEvent = { preventDefault() { prevented++; }, returnValue: 'unchanged' };
appContext.unload(unloadEvent);
assert.equal(prevented, 0);
resultRef.current = createMockFlowResult();
appContext.unload(unloadEvent);
assert.equal(prevented, 1, 'the actual unload callback sees pending result immediately');
assert.equal(unloadEvent.returnValue, '');
resultRef.current = { ...createMockFlowResult(), isMock: false };
canvasMemory.doc = resultRef.current.doc;
await appContext.run('reassess', 'draft', 'full');
assert.equal(reassessMode, 'full', 'manual full-check choice reaches the production service');

assert.match(app, /saveArgumentDoc\(snapshot\.doc, snapshot\.noteId, snapshot\.entryMode, snapshot\.reviewSessionId, false, publication\)/,
  'the persistence helper cannot navigate before the version acknowledgement check');
assert.match(app, /currentViewRef\.current !== entryView/);
assert.match(app, /if \(flowResultWriteRef\.current\.busy\) return;/);
assert.match(app, /flowResultRef\.current = next/);
console.log('Flow result checks passed: shared lock, acknowledgement, draft retention/retry, late-response isolation, positions, fixed scores, busy UI and protected return.');
