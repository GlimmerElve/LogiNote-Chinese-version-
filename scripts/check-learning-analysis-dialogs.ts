import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { matchKnownKnowledgePoints } from '../src/services/knownKnowledgeMatcher';
import { resolveNoteByTitleOrAlias } from '../src/services/noteResolver';

// Execute production hooks/components and App handlers. No model, vault or network.
globalThis.fetch = async () => assert.fail('Learning analysis UI checks must not access network');
function runtime() {
  const slots: any[] = [], effects: any[] = []; let cursor = 0;
  const hooks = {
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return `analysis-${cursor++}`; }, useMemo: (fn: () => any) => fn(), useCallback: (fn: any) => fn,
    useEffect(fn: () => any, deps: any[]) { const i = cursor++; if (!effects[i] || deps.some((v, j) => v !== effects[i].deps[j])) effects[i] = { deps, fn, pending: true, cleanup: effects[i]?.cleanup }; },
  };
  return { ...hooks, useLayoutEffect: hooks.useEffect, begin() { cursor = 0; },
    flush() { effects.forEach(e => { if (e?.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } }); },
    unmount() { effects.forEach(e => e?.cleanup?.()); }, slots };
}
function compile(path: string, bindings: any, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const js = ts.transpileModule(`${code}\nreturn { ${names.join(', ')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const defer = () => { let resolve!: (value: any) => void, reject!: (error: any) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const known: any = { id: 'a', name: '条件概率', category: 'known', existingNoteTitle: '条件概率' };
const potential: any = { id: 'b', name: '贝叶斯更新', category: 'potential', discoverySource: 'explicit', evidence: '使用先验概率和证据。' };
const state = runtime();
const controller = compile('src/components/useKnowledgeDiscovery.ts', state, ['useKnowledgeDiscovery']);
let session = 'one', gate = defer(), calls = 0;
const hook = () => { state.begin(); const value = controller.useKnowledgeDiscovery((text: string) => { assert.equal(text, 'saved input'); calls++; return gate.promise; }, (id: string) => id === session); state.flush(); return value; };
let discovery = hook(); void discovery.start('saved input', session); void discovery.retry(); assert.equal(calls, 1);
gate.reject(new Error('secret path')); await settle(); discovery = hook(); assert.match(discovery.error, /识别失败/); assert.doesNotMatch(discovery.error, /secret/); assert.equal(discovery.loading, false);
gate = defer(); void discovery.retry(); void discovery.retry(); assert.equal(calls, 2); assert.equal(hook().loading, true);
gate.reject(new Error('again')); await settle(); discovery = hook(); assert.match(discovery.error, /重新识别/);
gate = defer(); void discovery.retry(); gate.resolve({ candidates: [known, potential] }); await settle(); discovery = hook(); assert.equal(discovery.candidates.length, 2); assert.equal(discovery.error, '');
gate = defer(); void discovery.start('saved input', session); discovery.cancel(); gate.resolve({ candidates: [known] }); await settle(); discovery = hook(); assert.equal(discovery.candidates.length, 0); assert.equal(discovery.loading, false);
gate = defer(); void discovery.start('saved input', 'one'); const oldGate = gate; session = 'two'; gate = defer(); void discovery.start('saved input', session);
oldGate.resolve({ candidates: [known] }); await settle(); assert.equal(hook().loading, true); gate.resolve({ candidates: [potential], error: '部分失败' }); await settle(); discovery = hook(); assert.deepEqual(discovery.candidates, [potential]); assert.equal(discovery.error, '部分失败');
gate = defer(); void discovery.start('saved input', session); state.unmount(); const before = state.slots.slice(); gate.resolve({ candidates: [known] }); await settle(); assert.deepEqual(state.slots, before);

const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : node?.props ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
const flat = (node: any): any[] => Array.isArray(node) ? node.flatMap(flat) : node?.props ? [node, ...flat(node.props.children)] : [];
const button = (tree: any, label: string) => { const found = flat(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, label); return found; };
const icons = Object.fromEntries(['Check', 'UserCheck2', 'Lightbulb', 'Loader2', 'X', 'RefreshCw', 'AlertCircle', 'Brain'].map(name => [name, () => null]));
const uiState = runtime(); let dialogClose: (() => void) | undefined;
const doc = { body: {}, activeElement: null }; doc.activeElement = doc.body as any;
const ui = compile('src/components/KnowledgePointSelectionModal.tsx', { ...uiState, React, ...icons, document: doc,
  useDialog(_open: any, _ref: any, onClose: any) { dialogClose = onClose; } }, ['KnowledgePointSelectionModal', 'MergeField']);
let confirmed: any[] = [], closed = 0;
let props: any = { candidates: [known, potential], knowledgeNotes: [], onClose() { closed++; }, onConfirm(value: any) { confirmed.push(value); } };
const render = () => { uiState.begin(); const tree = ui.KnowledgePointSelectionModal(props); uiState.flush(); return tree; };
let tree = render(); assert.ok(flat(tree).some(node => node.props.role === 'dialog' && node.props['aria-modal']));
button(tree, '全选已选 0 / 2').props.onClick(); tree = render(); assert.equal(button(tree, '开始复盘分析（2）').props.disabled, false);
props = { ...props, candidates: [potential] }; render(); tree = render(); assert.equal(button(tree, '开始复盘分析（1）').props.disabled, false, 'removed candidates do not inflate count');
const targetField = () => flat(tree).find(node => typeof node.type === 'function' && node.type.name === 'MergeField');
targetField().props.onChange('missing target'); tree = render(); assert.equal(button(tree, '开始复盘分析（1）').props.disabled, true);
button(tree, '开始复盘分析（1）').props.onClick(); assert.equal(confirmed.length, 0, 'unknown merge target cannot silently discard scoring');
props.knowledgeNotes = [{ id: 'bayes', title: '贝叶斯定理', aliases: ['Bayes'] }];
targetField().props.onChange('Bayes'); tree = render(); assert.equal(button(tree, '开始复盘分析（1）').props.disabled, false);
targetField().props.onChange(''); tree = render();
props.error = '识别失败'; tree = render(); assert.equal(button(tree, '开始复盘分析（1）').props.disabled, false, 'partial failure keeps local candidates usable');
props.loading = true; tree = render(); const busyConfirm = button(tree, '开始复盘分析（1）'); assert.equal(busyConfirm.props.disabled, true); busyConfirm.props.onClick(); assert.equal(confirmed.length, 0); props.loading = false;
props.error = ''; tree = render(); button(tree, '开始复盘分析（1）').props.onClick(); button(tree, '开始复盘分析（1）').props.onClick(); assert.equal(confirmed.length, 1); assert.equal(confirmed[0][0].existingNoteTitle, undefined);
dialogClose?.(); assert.equal(closed, 0, 'confirmation owns the close transition');

const mergeState = runtime(); const merge = compile('src/components/KnowledgePointSelectionModal.tsx', { ...mergeState, React, ...icons, useDialog() {} }, ['MergeField']);
let value = '', open = true;
let mergeProps: any = { name: 'new', value, open, knowledgeNotes: [{ id: 'note', title: '贝叶斯定理', aliases: ['Bayes'] }], onChange(next: string) { value = next; }, onOpenChange(next: boolean) { open = next; } };
const renderMerge = () => { mergeState.begin(); return merge.MergeField({ ...mergeProps, value, open }); };
const key = (key: string, extra: any = {}) => ({ key, nativeEvent: {}, preventDefault() {}, ...extra });
let mergeTree = renderMerge(); let input = flat(mergeTree).find(node => node.type === 'input');
input.props.onKeyDown(key('ArrowDown')); mergeTree = renderMerge(); input = flat(mergeTree).find(node => node.type === 'input');
assert.ok(input.props['aria-activedescendant']); input.props.onKeyDown(key('Enter', { nativeEvent: { isComposing: true } })); assert.equal(value, '');
input.props.onKeyDown(key('Enter')); assert.equal(value, '贝叶斯定理'); assert.equal(open, false);
value = 'Bayes'; open = true; mergeTree = renderMerge(); assert.equal(flat(mergeTree).filter(node => node.props.role === 'option').length, 1);
flat(mergeTree).find(node => node.props.role === 'option').props.onClick(); assert.equal(value, '贝叶斯定理');
value = ''; open = true; mergeProps.knowledgeNotes = []; mergeTree = renderMerge(); input = flat(mergeTree).find(node => node.type === 'input'); assert.equal(input.props['aria-activedescendant'], undefined);

const progressState = runtime(); let progressClose: any;
const progress = compile('src/components/AnalysisProgressModal.tsx', { ...progressState, React, ...icons, document: doc,
  useDialog(_open: any, _ref: any, close: any) { progressClose = close; } }, ['AnalysisProgressModal']);
progressState.begin(); let waitTree = progress.AnalysisProgressModal({ phase: 'evidence', offline: false, onClose() { closed++; } }); progressState.flush();
assert.equal(progressClose, undefined); assert.match(text(waitTree), /正在整理/); assert.doesNotMatch(text(waitTree), /快好了/);
progressState.begin(); waitTree = progress.AnalysisProgressModal({ phase: 'evidence', offline: true, onClose() { closed++; } }); progressState.flush();
assert.equal(typeof progressClose, 'function'); assert.ok(flat(waitTree).some(node => node.props.role === 'alert')); button(waitTree, '返回笔记').props.onClick(); assert.equal(closed, 1);

// Run actual App scoring handler with controlled failure boundaries; never execute scoring writes.
const app = readFileSync('src/App.tsx', 'utf8');
const appAst = ts.createSourceFile('src/App.tsx', app, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let handler: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(appAst) === 'handleConfirmKnowledgePoints') handler = node; ts.forEachChild(node, visit); }
visit(appAst); assert.ok(handler?.initializer);
const handlerJs = ts.transpileModule(`return ${handler!.initializer!.getText(appAst)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
for (const failure of ['offline', 'empty', 'throw']) {
  const received: any = {}; let writes = 0;
  const bindings: any = { flowSessionRef: { current: { id: 'flow', incrementalText: 'saved input' } }, flowEpisodeIdRef: { current: 'flow' },
    patchLearningEpisode: async () => {}, finishStoredFlowReview: async () => {}, reportLearningSaveError() {},
    setIsSelectionOpen() {}, setAnalysisOffline(v: any) { received.offline = v; }, setAnalysisError(v: any) { received.error = v; },
    setAnalysisPhase() {}, setAnalysisProgressOpen(v: any) { received.open = v; }, setIsFlowAnalysisOpen() {},
    probeLlmConnection: async () => failure !== 'offline', scoreKnowledgePointsInParallel: async () => { if (failure === 'throw') throw new Error('synthetic'); return []; },
    handleUpdateNote() { writes++; }, console: { warn() {} },
  };
  await new Function(...Object.keys(bindings), handlerJs)(...Object.values(bindings))([known]);
  assert.equal(received.open, true, failure); assert.ok(received.offline || received.error, failure); assert.equal(writes, 0);
}
assert.match(app, /candidates: knowledgeDiscovery.candidates/); assert.match(app, /void knowledgeDiscovery.retry\(\)/);
assert.doesNotMatch(app, /\[analysisOffline\]\)/, 'failure is not silently dismissed by a timer');
assert.match(app, /knowledgeDiscovery.cancel\(\)/);
assert.match(app, /discoverKnowledgePointsDetailed\(text, notesRef.current\)/);

// Execute the production service with real local matching and synthetic model responses.
let modelResponse: any = null;
const service = compile('src/services/knowledgeScoringService.ts', { matchKnownKnowledgePoints, resolveNoteByTitleOrAlias,
  callLLM: async () => { if (modelResponse instanceof Error) throw modelResponse; return modelResponse; } }, ['discoverKnowledgePointsDetailed', 'discoverKnowledgePoints']);
const knowledgeNote: any = { id: 'note', title: '条件概率', aliases: [], noteType: 'knowledge' };
modelResponse = new Error('provider secret'); let result = await service.discoverKnowledgePointsDetailed('条件概率说明', [knowledgeNote]);
assert.equal(result.candidates.length, 1); assert.match(result.error, /已知知识点仍可选择/); assert.doesNotMatch(result.error, /secret/);
assert.equal((await service.discoverKnowledgePoints('条件概率说明', [knowledgeNote])).length, 1, 'legacy best-effort contract');
modelResponse = { parsedJson: null }; result = await service.discoverKnowledgePointsDetailed('新概念', []); assert.match(result.error, /识别失败/);
modelResponse = { parsedJson: { knowledgePoints: [] } }; result = await service.discoverKnowledgePointsDetailed('新概念', []); assert.equal(result.error, undefined); assert.equal(result.candidates.length, 0);
modelResponse = { parsedJson: { knowledgePoints: [{ name: '先验', source: 'explicit', evidence: '先验', confidence: 1 }] } };
result = await service.discoverKnowledgePointsDetailed('我用先验更新判断', []); assert.equal(result.candidates.length, 1); assert.equal(result.error, undefined);
console.log('PASS learning analysis dialogs: retry deduplication, preserved session, late/unmounted requests, valid selection, mouse/keyboard/IME merge, protected waiting and persistent App failures.');
