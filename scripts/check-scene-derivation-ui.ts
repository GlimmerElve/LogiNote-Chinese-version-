import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as runtime from '../src/services/scene/derivationRuntime';
import * as s4Policy from '../src/services/scene/sceneS4Policy';
import { DERIVATION_STATUS_LABEL, stepDisplay, stepNote, stepSymbolic } from '../src/types/sceneS4';
import { requestHelp } from '../src/services/scene/sceneHelp';
import { useDerivationStore, emptyCanvasState, canvasStructureKey } from '../src/modules/derivationCanvas/derivationStore';
import {s4GoalAssessment} from '../src/services/scene/sceneS4Goal';
import * as goalPolicy from '../src/services/scene/sceneS4Goal';
import {s4HelpInputKey} from '../src/services/scene/sceneS4HelpContext';
import {requestS4GoalCheck} from '../src/services/scene/sceneS4GoalCheck';

globalThis.fetch = async () => assert.fail('S4 UI regression must not call network');
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value: any) => void, reject!: (value: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const all = (node: any): any[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
function compile(path: string, component: string) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n) && !ts.isExportAssignment(n)).map(n => n.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const result = ts.transpileModule(`${body}\nreturn ${component}`, {reportDiagnostics: true, compilerOptions: {jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}});
  assert.equal(result.diagnostics?.length ?? 0, 0, `${path} JSX syntax`);
  return result.outputText;
}
const createElement = (type: any, props: any, ...children: any[]) => ({type, props: {...props, children}});
function mount(code: string, environment: any, initial: any) {
  const slots: any[] = [], effects: any[] = [], cleanups: any[] = [];
  let cursor = 0, props = initial, live = true, afterUnmount = 0, tree: any[];
  const hooks = {
    useState(initial: any) {const i = cursor++; slots[i] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slots[i].value, (next: any) => {if (!live) afterUnmount++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next;}];},
    useRef(initial: any) {const i = cursor++; return slots[i] ||= {current: initial};},
    useCallback(fn: any, _deps: any[]) {cursor++; return fn;}, useMemo(fn: any, _deps: any[]) {cursor++; return fn();},
    useEffect(effect: any, deps: any[]) {const i = cursor++; if (!slots[i] || deps.some((d,j) => d !== slots[i].deps[j])) {
      slots[i] = {deps}; effects.push(() => {cleanups[i]?.(); cleanups[i] = effect();});}},
  };
  const env = { ...environment, ...hooks, React: {createElement, ...hooks} };
  const Component = new Function(...Object.keys(env), code)(...Object.values(env));
  const render = () => {cursor = 0; tree = all(Component(props)); effects.splice(0).forEach(effect => effect());};
  const view = (type: string) => {const node = tree.find(n => n.type === type); assert.ok(node, `${type} rendered`); return node.props;};
  const find = (test: (node: any) => boolean) => {const node = tree.find(test); assert.ok(node, 'requested control rendered'); return node.props;};
  render(); render();
  return {render, view, find, update(next: any) {props = {...props, ...next}; render(); render();},
    get afterUnmount() {return afterUnmount;}, unmount() {live = false; cleanups.forEach(cleanup => cleanup?.());}};
}
const spec: any = {sceneId: 'synthetic-s4', meta: {sceneSkill: 'S4', name: '合成推导', goal: '$x=1$', knowledgePoints: []}, task: '$x=1$',
  compute: {given: [], symbols: [], expected_steps_count: 15}, metrics: [], completion: {mode: 'signal'}, help: {max_help_count: 3}};
const run: any = {runId: 'synthetic-run', status: 'running', metrics: [], derivationEvents: [], canvas: {
  nodes: [{id: 'given', type: 'given', position: {x: 0, y: 0}, data: {latex: 'x>0', label: '前提', status: 'frozen', frozen: true}},
    {id: 'step', type: 'formula', position: {x: 300, y: 0}, data: {latex: 'x=1', label: '步骤', status: 'draft', frozen: false}}],
  edges: [{id: 'edge', source: 'given', target: 'step', type: 'derivation'}], viewport: {x: 0, y: 0, zoom: 1}, maxHelp: 3, helpUsed: 0, independenceScore: 1}};
const code = compile('src/components/scene/SceneDerivationView.tsx', 'SceneDerivationViewInner');
const result = {status: 'warn', verification: {formula_correct: false, dimension_check: false, verdictSource: 'none', feedback: '合成反馈'}, metricUpdates: []};
function harness(previewMode = false, init: () => Promise<any> = async () => ({ok: true})) {
  let analyze = async (_params: any) => result;
  let help = async (_params: any): Promise<any> => ({ok: false, message: '合成求助失败'});
  let goal = async (_params: any): Promise<any> => ({ok:false,message:'合成目标检查失败'});
  const goalChecks:any[]=[];
  const analyzed: any[] = [], helped: any[] = [], initialized: string[] = [], closed: string[] = [], changes: any[] = [];
  let current = structuredClone(run), ui: ReturnType<typeof mount>;
  const env: any = {...runtime, ...s4Policy, ...goalPolicy, s4HelpInputKey, DERIVATION_STATUS_LABEL, useDialog: () => {},
    window: {matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}})},
    crypto: {randomUUID: (() => {let id = 0; return () => `synthetic-${++id}`;})()},
    DerivationCanvas: 'canvas', MathField: 'math', HelperPanel: 'helper', SceneRichMessage: 'rich', SceneMetricPanel: 'metrics',
    CurvePanel: 'curves', StandardSolutionView: 'solution', SceneErrorBoundary: 'boundary', ReactFlowProvider: 'provider',
    buildSessionSymbols: () => [], probeComputeService: async () => assert.fail('read-only idle status must not gate first-use session initialization'),
    sessionInit: async (sid: string) => {initialized.push(sid); return init();}, sessionClose: async (sid: string) => {closed.push(sid);},
    analyzeStep: async (params: any) => {analyzed.push(params); return analyze(params);},
    analyzeAssumptionStep: async (params: any) => {analyzed.push(params); return analyze(params);},
    requestHelp: async (params: any) => {helped.push(params); return help(params);},
    requestS4GoalCheck:async(params:any)=>{goalChecks.push(params);return goal(params);},
    exportSceneLatex: () => {}, exportScenePdf: async () => true, exportScenePng: async () => true,
  };
  for (const icon of ['Loader2','RotateCcw','Flag','Calculator','CircleAlert','Image','FileText','Code','BookOpen','Braces','GitBranch','Info','PanelLeftOpen','PanelRightOpen','X']) env[icon] = icon;
  ui = mount(code, env, {spec, run: current, busy: false, hasPrevRun: true, previewMode,
    onRunChange: (next: any) => {current = next; changes.push(next);}, onEnd() {}, onExit() {}, onRerun() {}});
  return {...ui, analyzed, helped, goalChecks, initialized, closed, changes,
    render() {ui.update({run: current});}, setRun(next: any) {current = next; ui.update({run: current});},
    get run() {return current;}, setAnalyze(fn: any) {analyze = fn;}, setHelp(fn: any) {help = fn;},setGoal(fn:any){goal=fn;}};
}
const startGate = deferred(); const startup = harness(false, () => startGate.promise); await flush(); startup.render();
assert.equal(startup.initialized.length, 1, 'first-use session demand reaches the lazy engine without a ready-status prerequisite');
startup.view('canvas').onSubmitNode('step'); await flush(); startup.render();
assert.equal(startup.analyzed.length, 0, 'no session is usable before successful initialization');
assert.match(startup.view('helper').error, /尚未准备/);
startGate.resolve({ok: true}); await flush(); startup.render();
const pending = deferred(); startup.setAnalyze(() => pending.promise);
const submit = startup.view('canvas').onSubmitNode; submit('step'); submit('step'); startup.render();
assert.equal(startup.analyzed.length, 1, 'same-frame submissions share a synchronous lock');
assert.ok(startup.analyzed[0].sessionId); assert.equal(startup.view('canvas').readOnly, true);
assert.equal(await startup.view('helper').onAsk('不能并发'), false);
startup.view('helper').onInsert('y=2'); startup.view('canvas').onChange({...startup.run.canvas, nodes: []});
assert.equal(startup.run.canvas.nodes.length, 2, 'pending analysis blocks insertion and edits');
startup.setRun({...startup.run, canvas: {...startup.run.canvas, viewport: {x: 99, y: 1, zoom: 2}}});
pending.reject(new Error('合成验证失败')); await flush(); startup.render();
assert.match(startup.view('helper').error, /验证失败/); assert.equal(startup.run.canvas.viewport.x, 99);
assert.equal(startup.run.derivationEvents.filter((e:any) => e.type === 'node_submit').length, 1);
assert.equal(startup.view('canvas').readOnly, false);
startup.setAnalyze(async () => result); startup.view('canvas').onSubmitNode('step'); await flush(); startup.render();
assert.equal(startup.run.canvas.nodes[1].data.verification.feedback, '合成反馈');

const staleVerdict = deferred(); startup.setAnalyze(() => staleVerdict.promise);
startup.view('canvas').onRequestHelp('step'); startup.render();
startup.view('canvas').onSubmitNode('step'); startup.render();
assert.equal(startup.view('helper').tab, 'analysis', 'submission reveals its analysis instead of leaving the help form visible');
assert.equal(startup.run.canvas.nodes[1].data.verification, undefined, 'resubmission immediately invalidates the previous verdict');
staleVerdict.reject(new Error('再次验证失败')); await flush(); startup.render();
assert.equal(startup.view('helper').analyzedNode.id, 'step');
assert.equal(startup.view('helper').analyzedNode.data.verification, undefined, 'failed resubmission cannot display the old result');

const selection = harness(true); await flush(); selection.render();
const first = {...selection.run.canvas.nodes[1], id: 'first', data: {...selection.run.canvas.nodes[1].data, verification: result.verification}};
const last = {...first, id: 'last', data: {...first.data, label: '排列在最后'}};
selection.setRun({...selection.run, canvas: {...selection.run.canvas, nodes: [first, last]}, derivationEvents: [
  {type: 'node_verify', nodeId: 'last'}, {type: 'node_verify', nodeId: 'first'},
]});
assert.equal(selection.view('helper').analyzedNode.id, 'first', 'recent submission follows event order, not canvas array order');
selection.view('canvas').onSelectNode('last'); selection.render();
assert.equal(selection.view('helper').analyzedNode.id, 'last', 'selected step controls both properties and analysis');
selection.setRun({...selection.run, canvas: {...selection.run.canvas, nodes: [first, {...last, data: {...last.data, status: 'draft', verification: undefined}}]}});
assert.equal(selection.view('helper').analyzedNode.data.verification, undefined, 'editing selected step does not fall back to another valid verdict');
selection.view('canvas').onSelectNode(null); selection.render();
assert.equal(selection.view('helper').analyzedNode.id, 'first');
selection.setRun({...selection.run, canvas: {...selection.run.canvas, nodes: [{...first, data: {...first.data, status: 'draft', verification: undefined}}]}});
assert.equal(selection.view('helper').analyzedNode.id, 'first');
assert.equal(selection.view('helper').analyzedNode.data.verification, undefined, 'latest submitted draft remains the analysis subject after deselection');

const changed = harness(); await flush(); changed.render(); const changedGate = deferred(); changed.setAnalyze(() => changedGate.promise);
changed.view('canvas').onSubmitNode('step'); changed.render();
changed.setRun({...changed.run, canvas: {...changed.run.canvas, nodes: changed.run.canvas.nodes.map((n:any) => n.id === 'step' ? {...n, data: {...n.data, latex: 'x=2'}} : n)}});
changedGate.resolve(result); await flush(); changed.render();
assert.equal(changed.run.canvas.nodes[1].data.latex, 'x=2'); assert.equal(changed.run.canvas.nodes[1].data.verification, undefined);
assert.match(changed.view('helper').error, /内容已变化/);

const left = harness(); await flush(); left.render(); const late = deferred(); left.setAnalyze(() => late.promise);
left.view('canvas').onSubmitNode('step'); left.unmount(); const before = left.changes.length;
late.resolve(result); await flush(); assert.equal(left.changes.length, before); assert.equal(left.afterUnmount, 0);
const departedInit = deferred(); const closing = harness(false, () => departedInit.promise); await flush(); closing.unmount();
departedInit.resolve({ok: true}); await flush(); assert.equal(closing.afterUnmount, 0);
assert.ok(closing.closed.length >= 2, 'late initialized session is closed again after cancellation');

const newRun = harness(); await flush(); newRun.render(); const oldGate = deferred(); newRun.setAnalyze(() => oldGate.promise);
newRun.view('canvas').onSubmitNode('step'); newRun.setRun({...structuredClone(run), runId: 'second-run'});
const changedCount = newRun.changes.length; oldGate.resolve(result); await flush(); newRun.render();
assert.equal(newRun.changes.length, changedCount, 'prior run cannot publish into replacement run');

let initAttempts = 0;
const failedInit = harness(false, async () => ++initAttempts === 1 ? {ok: false, error: '合成初始化失败'} : {ok: true}); await flush(); failedInit.render();
assert.match(failedInit.view('helper').error, /初始化失败/);
failedInit.find(n => n.type === 'button' && n.props.children.includes('重试计算引擎')).onClick(); failedInit.render(); await flush(); failedInit.render();
assert.equal(initAttempts, 2); failedInit.view('canvas').onSubmitNode('step'); await flush(); failedInit.render();
assert.equal(failedInit.analyzed.length, 1, 'successful session retry restores submission without restarting the scene');

const helpUi = harness(); await flush(); helpUi.render(); helpUi.view('canvas').onRequestHelp('step'); helpUi.render();
assert.equal(helpUi.view('helper').tab, 'help'); assert.match(helpUi.view('helper').prefill.text, /步骤/);
assert.equal(await helpUi.view('helper').onAsk('保留草稿'), false); helpUi.render(); assert.equal(helpUi.run.canvas.helpUsed, 0);
const helpGate = deferred(); helpUi.setHelp(() => helpGate.promise); const ask = helpUi.view('helper').onAsk;
const successfulAsk = ask('依据是什么'); assert.equal(await ask('重复'), false);
assert.equal(helpUi.helped.at(-1).currentNodeId, 'step');
const helpOriginal = helpUi.run; const content: any = {latex: 'y=2', step_number: 1, step_content: '合成指引', related_knowledge: [], reason: '合成', correction: null};
helpGate.resolve({ok: true, nextRun: {...helpOriginal, canvas: {...helpOriginal.canvas, helpUsed: 1, independenceScore: .9}, derivationEvents: [...helpOriginal.derivationEvents, {type: 'help_response', content, remaining: 2}]}});
assert.equal(await successfulAsk, true); helpUi.render(); assert.equal(helpUi.run.canvas.helpUsed, 1);
const insert = helpUi.view('helper').onInsert; insert('y=2'); insert('z=3'); helpUi.render();
assert.equal(helpUi.run.canvas.nodes.length, 4, 'same-frame insertions preserve both nodes');
assert.equal(new Set(helpUi.run.canvas.nodes.map((n:any) => n.id)).size, 4);
assert.notDeepEqual(helpUi.run.canvas.nodes[2].position, helpUi.run.canvas.nodes[3].position, 'repeated insertion allocates a different node slot');
helpUi.setRun({...helpUi.run, status: 'success'}); assert.equal(helpUi.view('canvas').readOnly, true);
assert.equal(helpUi.view('helper').disabled, true); assert.equal(await helpUi.view('helper').onAsk('终态'), false);
helpUi.view('helper').onInsert('不能插入'); assert.equal(helpUi.run.canvas.nodes.length, 4);
const preview = harness(true); await flush(); preview.render(); preview.view('canvas').onSubmitNode('step'); await flush(); preview.render();
assert.equal(preview.analyzed.length + preview.initialized.length, 0); assert.match(preview.run.canvas.nodes[1].data.verification.feedback, /未调用计算引擎/);

const panelCode = compile('src/components/scene/HelperPanel.tsx', 'HelperPanel');
const analysisCode = compile('src/components/scene/HelperPanel.tsx', 'AnalysisView');
const analysisUi = mount(analysisCode, {katex: {}, DERIVATION_STATUS_LABEL, Lightbulb:'light',AlertTriangle:'alert',CheckCircle2:'check',Plus:'plus',Send:'send',Loader2:'loader'},
  {node: {...first, data: {...first.data, status: 'draft', verification: undefined}}, streaming: false});
assert.ok(analysisUi.find(n => n.props.role === 'status'));
assert.ok(analysisUi.find(n => n.type === 'p' && n.props.children.some((child:any) => typeof child === 'string' && child.includes('本步尚未验证'))));
analysisUi.update({node: {...first, type: 'given', data: {...first.data, status: 'frozen', verification: undefined}}});
assert.ok(analysisUi.find(n => n.type === 'p' && n.props.children.some((child:any) => typeof child === 'string' && child.includes('无需提交验证'))));
let panelAsk = async (_query: string) => false;
const panelUi = mount(panelCode, {katex: {}, DERIVATION_STATUS_LABEL, Lightbulb:'light',AlertTriangle:'alert',CheckCircle2:'check',Plus:'plus',Send:'send',Loader2:'loader',
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}}, {analyzedNode: null, analyzing: false, helpHistory: [], remaining: 2, maxHelp: 2, asking: false, error: null,
  onAsk: (q:string) => panelAsk(q), onInsert() {}, tab: 'help', onTabChange() {}});
panelUi.view('textarea').onChange({target: {value: '不要清空我的问题'}}); panelUi.render();
panelUi.find(n => n.type === 'button' && n.props['aria-label'] === '发起求助').onClick(); await flush(); panelUi.render();
assert.equal(panelUi.view('textarea').value, '不要清空我的问题');
panelAsk = async () => {throw new Error('意外失败');}; panelUi.find(n => n.type === 'button' && n.props['aria-label'] === '发起求助').onClick(); await flush(); panelUi.render();
assert.equal(panelUi.view('textarea').value, '不要清空我的问题'); assert.ok(panelUi.find(n => n.props.role === 'alert'));
panelAsk = async () => true; panelUi.find(n => n.type === 'button' && n.props['aria-label'] === '发起求助').onClick(); await flush(); panelUi.render();
assert.equal(panelUi.view('textarea').value, '');
assert.match(readFileSync('src/modules/derivationCanvas/DerivationCanvas.tsx', 'utf8'), /e.defaultPrevented \|\| hasActiveDialog\(\)/);
const canvasSource = ts.createSourceFile('canvas.tsx', readFileSync('src/modules/derivationCanvas/DerivationCanvas.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const mappings = canvasSource.statements.filter(n => ts.isFunctionDeclaration(n) && ['toFlowNode', 'toFlowEdge'].includes(n.name?.text ?? '')).map(n => n.getText(canvasSource)).join('\n');
const mappingCode = ts.transpileModule(`${mappings}\nreturn [toFlowNode, toFlowEdge];`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const [mapNode, mapEdge] = new Function('MarkerType', 'EDGE_COLOR', 'EDGE_COLOR_HIGHLIGHT', mappingCode)({ArrowClosed:'closed'}, '#315e49', '#d28a3b');
assert.equal(mapNode(first, false, true).selected, true);
assert.equal(mapNode(first, false, false).selected, false);
assert.equal(mapEdge(run.canvas.edges[0], false, true).selected, true);
assert.match(canvasSource.text, /toFlowNode\(n, hl.has\(n.id\), selectedNodeIdsRef.current.has\(n.id\)\)/);
assert.match(canvasSource.text, /toFlowEdge\(e, hl.has\(e.id\), selectedEdgeIdsRef.current.has\(e.id\)\)/);
let editAction!: ts.PropertyAssignment;
const visitEdit = (node: ts.Node) => {if (ts.isPropertyAssignment(node) && node.name.getText(canvasSource) === 'onRequestEdit') editAction = node; ts.forEachChild(node, visitEdit);};
visitEdit(canvasSource); assert.ok(editAction);
const editCode = ts.transpileModule(`return ({${editAction.getText(canvasSource)}}).onRequestEdit;`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const selectedNodes = {current:new Set<string>(['first'])}, selectedEdges = {current:new Set<string>(['edge'])};
let flowNodes = [mapNode(first, false, true), mapNode(last, false, false)], flowEdges = [mapEdge(run.canvas.edges[0], false, true)];
let inspected: string | null = null, editing: string | null = null;
const requestEdit = new Function('canEditNode', 'readOnly', 'selectedNodeIdsRef', 'selectedEdgeIdsRef', 'setNodes', 'setEdges', 'onSelectNode', 'setEditingNodeId', editCode)(
  () => true, false, selectedNodes, selectedEdges, (fn:any) => flowNodes = fn(flowNodes), (fn:any) => flowEdges = fn(flowEdges),
  (id:string) => inspected = id, (id:string) => editing = id);
requestEdit('last');
assert.deepEqual([...selectedNodes.current], ['last']); assert.equal(selectedEdges.current.size, 0);
assert.equal(flowNodes[1].selected, true); assert.equal(flowNodes[0].selected, false); assert.equal(flowEdges[0].selected, false);
assert.equal(inspected, 'last'); assert.equal(editing, 'last', 'keyboard edit selects the same step for analysis');
const errorBoundarySource = readFileSync('src/components/scene/SceneErrorBoundary.tsx', 'utf8');
assert.match(errorBoundarySource, /role="alert"/);
assert.match(errorBoundarySource, /retryRef\.current\?\.focus/);
// A stale historical quota does not grant the optional help capability, including demo mode.
for (const previewMode of [false, true]) {
  const denied = harness(previewMode); await flush();
  denied.update({spec: {...spec, capabilityIds: ['given-node', 'formula-node', 'step-submit']}});
  assert.equal(denied.view('helper').disabled, true);
  assert.equal(denied.view('helper').remaining, 0);
  assert.equal(await denied.view('helper').onAsk('绕过旧额度'), false);
  denied.view('canvas').onRequestHelp('step'); denied.render();
  assert.match(denied.view('helper').error, /未启用/);
  assert.equal(denied.helped.length, 0); assert.equal(denied.run.canvas.helpUsed, 0);
  denied.view('canvas').onSubmitNode('step'); await flush(); denied.render();
  if (!previewMode) assert.equal(denied.analyzed.length, 1, 'no-help scenes still support step analysis');
  denied.unmount();
}
const zeroHelp = harness(); await flush();
zeroHelp.update({spec: {...spec, capabilityIds: ['compute-help'], help: {max_help_count: 0}}});
assert.equal(zeroHelp.view('helper').remaining, 0);
assert.equal(await zeroHelp.view('helper').onAsk('零预算'), false);
assert.equal(zeroHelp.helped.length, 0); zeroHelp.unmount();
const configuredDemo = harness(true); await flush();
configuredDemo.update({spec: {...spec, help: {...spec.help, penalty_per_help: .4}, metrics: [
  {id: 'independence', name: '独立性', source: 'rule', type: 'continuous', s4Binding: 'independence-score', initial: 1, target: .8},
]}});
assert.equal(await configuredDemo.view('helper').onAsk('第一步'), true); configuredDemo.render();
assert.equal(configuredDemo.run.canvas.independenceScore, .6);
assert.equal(configuredDemo.run.metrics.find((item: any) => item.metricId === 'independence').value, .6);
assert.equal(await configuredDemo.view('helper').onAsk('第二步'), true); configuredDemo.render();
assert.equal(configuredDemo.run.canvas.independenceScore, .2); configuredDemo.unmount();

const themeSource = readFileSync('src/index.css', 'utf8');

// Real-mode component + actual help service: no demo/stub state transition can mask merge defects.
const integration = harness(false); await flush();
const integrationSpec = {...spec, help: {...spec.help, penalty_per_help: .4}, metrics: [
  {id: 'independence', name: '独立性', source: 'rule', type: 'continuous', s4Binding: 'independence-score', initial: 1, target: .8},
  {id: 'engine', name: '正确性', source: 'engine', type: 'boolean', s4Binding: 'formula-correctness', initial: false, target: true},
]};
integration.update({spec: integrationSpec});
integration.setRun({...integration.run, sceneId: spec.sceneId, metrics: [
  {metricId: 'independence', value: 1}, {metricId: 'engine', value: true},
], canvas: {...integration.run.canvas,nodes:integration.run.canvas.nodes.map((node:any)=>node.id==='step'?{...node,data:{...node.data,status:'pass',verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'synthetic evidence'}}}:node)}});
const realHelpGate = deferred(); let realCalls = 0;
integration.setHelp((params: any) => requestHelp({...params, callLlm: async () => {realCalls++; return realHelpGate.promise;}}));
const integrationAsk = integration.view('helper').onAsk('下一步怎么做');
integration.setRun({...integration.run, canvas: {...integration.run.canvas, viewport: {x: 77, y: 9, zoom: 2}}});
realHelpGate.resolve({content: JSON.stringify({latex: 'x+1=2', reason: '两边加一'}), diagnostics: {finishReason: 'stop'}});
assert.equal(await integrationAsk, true); integration.render();
assert.equal(realCalls, 1);
assert.equal(integration.run.canvas.independenceScore, .6);
assert.equal(integration.run.metrics.find((item: any) => item.metricId === 'independence').value, .6);
assert.equal(integration.run.metrics.find((item: any) => item.metricId === 'engine').value, true);
assert.equal(integration.run.canvas.viewport.x, 77, 'merge preserves latest viewport, not the service snapshot');
assert.equal(integration.run.derivationEvents.filter((e: any) => e.type === 'help_response').length, 1);
const beforeTruncated = JSON.stringify(integration.run);
integration.setHelp((params: any) => requestHelp({...params, callLlm: async () => {
  realCalls++; return {content: JSON.stringify({latex: 'x=2'}), diagnostics: {finishReason: 'length'}} as any;
}}));
assert.equal(await integration.view('helper').onAsk('截断内容'), false); integration.render();
assert.equal(JSON.stringify(integration.run), beforeTruncated);
assert.equal(realCalls, 2, 'no automatic retry or extra model call');
assert.match(integration.view('helper').error, /截断.*未扣/); integration.unmount();

for (const previewMode of [false, true]) {
  const bounded = harness(previewMode); await flush();
  const boundedSpec = {...spec, capabilityIds: ['given-node', 'formula-node', 'conclusion-node', 'step-submit']};
  bounded.update({spec: boundedSpec});
  assert.deepEqual(bounded.view('canvas').allowedNodeTypes, ['given', 'formula', 'conclusion']);
  const oldAssumption = {...bounded.run.canvas.nodes[1], id: 'old-assumption', type: 'assumption', data: {latex: 'x>1', status: 'pass', frozen: false}};
  bounded.view('canvas').onChange({...bounded.run.canvas, nodes: [...bounded.run.canvas.nodes, oldAssumption]});
  assert.equal(bounded.run.canvas.nodes.length, 2, 'host refuses unauthorized creation');
  bounded.view('canvas').onChange({...bounded.run.canvas, nodes: bounded.run.canvas.nodes.map((n:any) => n.id === 'step' ? {...n, type: 'assumption'} : n)});
  assert.equal(bounded.run.canvas.nodes[1].type, 'formula', 'host refuses retyping');
  bounded.setRun({...bounded.run, canvas: {...bounded.run.canvas, nodes: [...bounded.run.canvas.nodes, oldAssumption]}});
  bounded.view('canvas').onSubmitNode('old-assumption'); await flush(); bounded.render();
  assert.equal(bounded.analyzed.length, 0); assert.equal(bounded.run.canvas.nodes.at(-1).data.status, 'pass');
  assert.match(bounded.view('helper').error, /未启用/);
  bounded.setRun({...bounded.run, canvas: {...bounded.run.canvas, edges: [...bounded.run.canvas.edges,
    {id: 'old-link', source: 'old-assumption', target: 'step', type: 'derivation'}]}});
  bounded.view('canvas').onSubmitNode('step'); await flush(); bounded.render();
  assert.equal(bounded.analyzed.length, 0, 'historical pass cannot bypass permissions as an upstream premise');
  const beforeInsert = bounded.run.canvas.nodes.length;
  bounded.view('canvas').onSelectNode('step'); bounded.render();
  bounded.view('helper').onInsert('x+1>1'); bounded.render();
  assert.equal(bounded.run.canvas.nodes.length, beforeInsert, 'helper insertion cannot auto-connect to a disabled branch');
  bounded.view('canvas').onChange({...bounded.run.canvas, nodes: bounded.run.canvas.nodes.filter((n:any) => n.id !== 'old-assumption'),
    edges: bounded.run.canvas.edges.filter((e:any) => e.source !== 'old-assumption')});
  assert.equal(bounded.run.canvas.nodes.length, 2, 'historical unauthorized nodes may be deleted');
  bounded.update({spec: {...boundedSpec, capabilityIds: [...boundedSpec.capabilityIds, 'assumption-node']}});
  bounded.view('canvas').onChange({...bounded.run.canvas, nodes: [...bounded.run.canvas.nodes, {...oldAssumption, data: {...oldAssumption.data, status: 'draft'}}]});
  bounded.render(); bounded.view('canvas').onSubmitNode('old-assumption'); await flush(); bounded.render();
  if (!previewMode) assert.equal(bounded.analyzed.length, 1, 'explicit authorization restores assumption analysis');
  bounded.unmount();
}

// Execute the actual canvas toolbar/actions/store-return effect, including bypass and undo paths.
const fullCanvasCode = compile('src/modules/derivationCanvas/DerivationCanvas.tsx', 'DerivationCanvas');
let canvasChanges = 0, canvasSubmits = 0;
const allowed = ['given', 'formula', 'conclusion'] as const;
const storeSelector = Object.assign((select: any) => select(useDerivationStore.getState()), {getState: useDerivationStore.getState});
const canvasEnv: any = {...s4Policy, useDerivationStore: storeSelector, emptyCanvasState, canvasStructureKey,
  useReactFlow: () => ({screenToFlowPosition: (p:any) => p}), useNodesState: () => [[], () => {}, () => {}], useEdgesState: () => [[], () => {}, () => {}],
  NodeActionsContext: {Provider: 'actions'}, MarkerType: {ArrowClosed: 'closed'}, EDGE_COLOR: '', EDGE_COLOR_HIGHLIGHT: '',
  document: {addEventListener() {}, removeEventListener() {}}, hideVirtualKeyboard() {}, hasActiveDialog: () => false,
  window: {innerWidth: 1000, innerHeight: 800}, BackgroundVariant: {Dots: 'dots'},
};
for (const name of ['FormulaNode', 'GivenNode', 'ConclusionNode', 'AssumptionNode', 'EdgeWithDeleteButton', 'ReactFlow', 'Background', 'Controls', 'MiniMap', 'Plus', 'Flag', 'Undo2', 'Redo2', 'AlertCircle', 'Sigma', 'Lightbulb']) canvasEnv[name] = name;
const canvasUi = mount(fullCanvasCode, canvasEnv, {canvasState: structuredClone(run.canvas), allowedNodeTypes: allowed,
  onChange() {canvasChanges++;}, onSubmitNode() {canvasSubmits++;}, onRequestHelp() {}});
const assumptionButton = canvasUi.find(n => n.type === 'button' && n.props.className?.includes('assumption'));
assert.equal(assumptionButton.disabled, true);
assert.ok(canvasUi.find(n => n.props.role === 'status' && n.props.children.includes('本场景未启用假设前提')));
assumptionButton.onClick(); assert.equal(useDerivationStore.getState().canvas.nodes.length, 2);
const illegalId = useDerivationStore.getState().addNode('assumption', {position: {x: 5, y: 5}});
canvasUi.find(n => n.type === 'actions').value.onSubmitNode(illegalId);
assert.equal(canvasSubmits, 1, 'canvas delegates submission to the guarded host for a readable error');
assert.equal(useDerivationStore.getState().canvas.nodes.at(-1)!.data.status, 'draft', 'canvas never marks a rejected submission pending');
canvasUi.render(); canvasUi.render();
assert.equal(useDerivationStore.getState().canvas.nodes.length, 2, 'store bypass is rolled back before parent emission');
assert.equal(canvasChanges, 0);
useDerivationStore.setState({past: [{...structuredClone(run.canvas), nodes: [...structuredClone(run.canvas.nodes),
  {id: 'undo-assumption', type: 'assumption', position: {x: 5, y: 5}, data: {latex: 'x>1', label: '历史假设', status: 'draft', frozen: false}}]}]});
useDerivationStore.getState().undo(); canvasUi.render(); canvasUi.render();
assert.equal(useDerivationStore.getState().canvas.nodes.length, 2, 'undo cannot resurrect unauthorized node types');
assert.equal(canvasChanges, 0);
canvasUi.find(n => n.type === 'button' && n.props.children.includes('公式')).onClick(); canvasUi.render();
assert.equal(useDerivationStore.getState().canvas.nodes.length, 3);
assert.equal(canvasChanges, 1, 'authorized creation still reaches the parent');
canvasUi.update({canvasState: useDerivationStore.getState().canvas});
useDerivationStore.getState().undo(); canvasUi.render();
assert.equal(useDerivationStore.getState().canvas.nodes.length, 2, 'authorized undo remains usable');
canvasUi.unmount();

// Real-mode handlers enforce S4 submissions, not conversational rounds or canvas edits.
const cappedSpec = {...spec, completion: {mode: 'signal', maxTurns: 1}};
for (const throws of [false, true]) {
  const capped = harness(false); await flush(); capped.update({spec: cappedSpec});
  capped.setRun({...capped.run, sceneId: spec.sceneId, turnCount: 0});
  if (throws) capped.setAnalyze(async () => {throw new Error('synthetic engine outage');});
  const submit = capped.view('canvas').onSubmitNode;
  submit('step'); submit('step'); await flush(); capped.render();
  assert.equal(capped.analyzed.length, 1); assert.equal(capped.run.turnCount, 1);
  assert.equal(capped.run.derivationEvents.filter((e:any) => e.type === 'node_submit').length, 1);
  assert.equal(capped.run.status, 'failure'); assert.equal(capped.run.endedByUser, false);
  assert.match(capped.run.endReason, /节点验证提交上限/);
  capped.view('canvas').onSubmitNode('step'); await flush();
  assert.equal(capped.analyzed.length, 1, 'terminal state prevents further analysis IO'); capped.unmount();
}
const recovered = harness(false); await flush(); recovered.update({spec: cappedSpec});
recovered.setRun({...recovered.run, turnCount: 0, derivationEvents: [{type: 'node_submit', nodeId: 'step', latex: 'x=1', at: ''}]});
recovered.view('canvas').onSubmitNode('step'); await flush(); recovered.render();
assert.equal(recovered.analyzed.length, 0, 'historical exhausted submissions cannot trigger another request');
assert.equal(recovered.run.turnCount, 1); assert.equal(recovered.run.status, 'failure'); recovered.unmount();
const freeActions = harness(true); await flush(); freeActions.setRun({...freeActions.run, turnCount: 0});
freeActions.view('canvas').onChange({...freeActions.run.canvas, nodes: freeActions.run.canvas.nodes.map((n:any) => n.id === 'step' ? {...n, data: {...n.data, latex: 'x+1=2'}} : n)});
freeActions.render(); assert.equal(await freeActions.view('helper').onAsk('提示不算节点验证'), true); freeActions.render();
freeActions.view('helper').onInsert('x=1'); freeActions.render();
assert.equal(freeActions.run.turnCount, 0); assert.equal(runtime.s4SubmissionCount(freeActions.run), 0); freeActions.unmount();

const lastChance = harness(false); await flush();
const lastSpec = {...spec, completion: {mode: 'signal', maxTurns: 2}, compute: {...spec.compute, expected_formula: 'x=1', expected_steps: ['x=1']}};
lastChance.update({spec: lastSpec}); lastChance.setRun({...lastChance.run, sceneId: spec.sceneId, turnCount: 0});
lastChance.view('canvas').onSubmitNode('step'); await flush(); lastChance.render();
assert.equal(lastChance.run.status, 'running'); assert.equal(lastChance.run.turnCount, 1);
lastChance.view('canvas').onChange({...lastChance.run.canvas, nodes: lastChance.run.canvas.nodes.map((n:any) => n.id === 'step' ? {...n, type: 'conclusion'} : n)});
lastChance.render(); lastChance.setAnalyze(async (params:any) => ({status: 'pass', verification: {
  formula_correct: true, dimension_check: true, verdictSource: 'premise', feedback: 'synthetic valid conclusion',
  goalAssessment:s4GoalAssessment(lastSpec,params.run,params.node.id,{status:'achieved',reason:'synthetic task coverage'})}, metricUpdates: []}));
lastChance.view('canvas').onSubmitNode('step'); await flush(); lastChance.render();
assert.equal(lastChance.run.status, 'success', 'a valid conclusion on the last attempt beats exhaustion');
assert.equal(lastChance.run.turnCount, 2); assert.equal(lastChance.run.endedByUser, false);

const referenceCode = compile('src/components/scene/StandardSolutionView.tsx', 'StandardSolutionView');
const referenceEnv = {...s4Policy, stepDisplay, stepNote, stepSymbolic, katex: {}, ChevronDown: 'down', ChevronRight: 'right', BookOpenCheck: 'book', Flag: 'flag'};
const reference = mount(referenceCode, referenceEnv, {spec: lastSpec, run: lastChance.run, onRequestUnlock: lastChance.view('solution').onRequestUnlock});
assert.equal(reference.view('button')['aria-expanded'], false);
assert.equal(reference.view('button').disabled, false, 'automatic finish has an explicit reference action');
const endSnapshot = structuredClone(lastChance.run);
reference.view('button').onClick(); lastChance.render(); reference.update({run: lastChance.run});
assert.equal(lastChance.run.s4ReferenceUnlocked, true);
assert.equal(reference.view('button')['aria-expanded'], true);
assert.equal(reference.view('code').children[0], 'x=1');
assert.deepEqual({...lastChance.run, s4ReferenceUnlocked: undefined}, {...endSnapshot, s4ReferenceUnlocked: undefined});
reference.view('button').onClick(); reference.render(); assert.equal(reference.view('button')['aria-expanded'], false, 'unlocked references remain collapsible');
reference.unmount(); lastChance.unmount();
// A single-formula answer must have the same unlock path, even without reference steps.
for (const status of ['success', 'failure']) {
  let consent = 0;
  const panel = mount(referenceCode, referenceEnv, {spec: {...lastSpec, compute: {...lastSpec.compute, expected_steps: []}},
    run: {...endSnapshot, status, endedByUser: false}, onRequestUnlock: () => {consent++;}});
  assert.equal(panel.view('button').disabled, false); panel.view('button').onClick(); assert.equal(consent, 1); panel.unmount();
}
let prematureConsent = 0;
const lockedReference = mount(referenceCode, referenceEnv, {spec: lastSpec, run: {...endSnapshot, status: 'running'}, onRequestUnlock: () => {prematureConsent++;}});
assert.equal(lockedReference.view('button').disabled, true); lockedReference.view('button').onClick();
assert.equal(prematureConsent, 0); lockedReference.unmount();

// Production host + production store: invalidation must reach the metric panel and final score.
const evidence = harness(false); await flush();
const evidenceSpec = {...spec, metrics: [{id: 'proof', name: '正确性', source: 'engine', type: 'boolean', initial: false, target: true, s4Binding: 'formula-correctness'}]};
evidence.update({spec: evidenceSpec}); evidence.setRun({...evidence.run, sceneId: spec.sceneId, turnCount: 0, metrics: [{metricId: 'proof', value: false}]});
evidence.setAnalyze(async () => ({status: 'pass', verification: {formula_correct: true, dimension_check: true, verdictSource: 'premise', feedback: 'synthetic verified'}, metricUpdates: []}));
evidence.view('canvas').onSubmitNode('step'); await flush(); evidence.render();
assert.equal(evidence.run.metrics[0].value, true);
const verifiedRun = structuredClone(evidence.run);
useDerivationStore.getState().initCanvas(verifiedRun.canvas);
useDerivationStore.getState().updateNodeDraft('step', {latex: 'x=999'});
evidence.view('canvas').onChange(useDerivationStore.getState().canvas); evidence.render();
assert.equal(evidence.run.canvas.nodes[1].data.status, 'draft'); assert.equal(evidence.run.metrics[0].value, false);
assert.equal(runtime.applyS4Completion(evidenceSpec, evidence.run, {userIntentEnd: true}).finalScore, .1);
useDerivationStore.getState().initCanvas(verifiedRun.canvas); useDerivationStore.getState().removeNode('step');
evidence.view('canvas').onChange(useDerivationStore.getState().canvas); evidence.render();
assert.equal(evidence.run.metrics[0].value, false);
useDerivationStore.getState().undo(); evidence.view('canvas').onChange(useDerivationStore.getState().canvas); evidence.render();
assert.equal(evidence.run.metrics[0].value, true);
useDerivationStore.getState().redo(); evidence.view('canvas').onChange(useDerivationStore.getState().canvas); evidence.render();
assert.equal(evidence.run.metrics[0].value, false);
const immutableHost = JSON.stringify(evidence.run);
evidence.view('canvas').onChange({...evidence.run.canvas, nodes: []}); evidence.render();
assert.equal(JSON.stringify(evidence.run), immutableHost, 'host rejects removal of system givens');
evidence.view('canvas').onChange({...evidence.run.canvas, nodes: evidence.run.canvas.nodes.map((node:any) => ({...node, data: {...node.data, note: 'forged'}}))});
assert.equal(JSON.stringify(evidence.run), immutableHost, 'host rejects rewriting system givens'); evidence.unmount();
for (const previewMode of [false, true]) {
  const empty = harness(previewMode); await flush();
  empty.setRun({...empty.run, turnCount: 0, canvas: {...empty.run.canvas, nodes: empty.run.canvas.nodes.map((node:any) => node.id === 'step' ? {...node, data: {...node.data, latex: '', note: 'x=2'}} : node)}});
  empty.view('canvas').onSubmitNode('step'); await flush(); empty.render();
  assert.equal(empty.analyzed.length, 0); assert.equal(empty.run.turnCount, 0);
  assert.equal(empty.run.derivationEvents.length, 0); assert.match(empty.view('helper').error, /公式输入区.*备注/); empty.unmount();
}
let readonlyKeyboard: (event:any) => void = () => {};
const readonlyCanvas = mount(fullCanvasCode, {...canvasEnv, document: {addEventListener(type:string, handler:any) {if (type === 'keydown') readonlyKeyboard = handler;}, removeEventListener() {}}},
  {canvasState: structuredClone(run.canvas), onChange() {}, onSubmitNode() {}, onRequestHelp() {}});
const systemGiven = JSON.stringify(useDerivationStore.getState().canvas.nodes[0].data);
readonlyCanvas.find(n => n.type === 'actions').value.onToggleFreeze('given');
readonlyCanvas.find(n => n.type === 'actions').value.onDraftSave('given', 'x=999');
readonlyCanvas.find(n => n.type === 'actions').value.onDeleteNode('given');
assert.equal(JSON.stringify(useDerivationStore.getState().canvas.nodes[0].data), systemGiven);
readonlyCanvas.find(n => n.type === 'ReactFlow').onSelectionChange({nodes: [{id: 'given'}, {id: 'step'}], edges: []});
readonlyKeyboard({key: 'Delete', target: null, defaultPrevented: false, preventDefault() {}}); readonlyCanvas.render();
assert.deepEqual(useDerivationStore.getState().canvas.nodes.map(node => node.id), ['given'], 'mixed keyboard selection deletes only user nodes');
assert.equal(JSON.stringify(useDerivationStore.getState().canvas.nodes[0].data), systemGiven);
readonlyCanvas.unmount();
const shellEnv: any = {useNodeActions: () => ({readOnly: false}), DERIVATION_STATUS_LABEL, statusColor: () => '', statusBg: () => '', statusGlow: () => '', NODE_TYPE_LABEL: {given: '已知', formula: '公式'},
  Handle: 'handle', Position: {Top: 'top', Left: 'left', Bottom: 'bottom', Right: 'right'}};
for (const icon of ['CheckCircle2', 'AlertTriangle', 'XCircle', 'Loader2', 'Lock', 'Unlock', 'Circle', 'Trash2', 'HelpCircle', 'Send']) shellEnv[icon] = icon;
const givenShell = mount(compile('src/modules/derivationCanvas/components/NodeShell.tsx', 'NodeShell'), shellEnv,
  {nodeId: 'given', nodeType: 'given', label: '已知', status: 'frozen', frozen: true});
assert.equal(all({props: givenShell.view('div')}).some(node => node.type === 'button'), false, 'givens have no freeze/delete/submit controls');
givenShell.update({nodeType: 'formula', frozen: false, status: 'draft'});
assert.ok(givenShell.find(node => node.type === 'button' && node.props.children.includes('冻结')), 'user node controls remain available'); givenShell.unmount();
assert.match(themeSource, /\.scene-s4-error[\s\S]*?background: var\(--ln-bg-app\)/);
// Successful help changes rule evidence without a submission; completion must react immediately.
for (const previewMode of [false,true]) {
  const helpCompletion = harness(previewMode); await flush();
  const helpSpec = {...spec,metrics:[{id:'helps',name:'求助记录',source:'rule',type:'count',initial:0,target:1,s4Binding:'help-used'}]};
  helpCompletion.update({spec:helpSpec});
  helpCompletion.setRun({...helpCompletion.run,sceneId:spec.sceneId,turnCount:0,metrics:[{metricId:'helps',value:0}],canvas:{...helpCompletion.run.canvas,
    nodes:helpCompletion.run.canvas.nodes.map((node:any)=>node.id==='step'?{...node,type:'conclusion',data:{...node.data,status:'pass',verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'synthetic proof'}}}:node)}});
  const covered=structuredClone(helpCompletion.run);
  covered.canvas.nodes[1].data.verification.goalAssessment=s4GoalAssessment(helpSpec,covered,'step',{status:'achieved',reason:'synthetic task coverage'});
  helpCompletion.setRun(covered);
  assert.equal(runtime.checkS4Completion(helpSpec,helpCompletion.run).status,'running');
  helpCompletion.setHelp((params:any)=>requestHelp({...params,callLlm:async()=>({content:JSON.stringify({latex:'x=1',reason:'synthetic help'})})}));
  assert.equal(await helpCompletion.view('helper').onAsk('解释当前结论'),true); helpCompletion.render();
  assert.equal(helpCompletion.run.status,'success'); assert.equal(helpCompletion.run.canvas.helpUsed,1);
  assert.equal(helpCompletion.run.turnCount,0); assert.equal(helpCompletion.run.endedByUser,false);
  assert.equal(s4Policy.isS4ReferenceUnlocked(helpCompletion.run),false);
  assert.equal(helpCompletion.run.derivationEvents.filter((event:any)=>event.type==='help_request').length,1);
  assert.equal(helpCompletion.run.derivationEvents.filter((event:any)=>event.type==='help_response').length,1);
  assert.equal(await helpCompletion.view('helper').onAsk('不得继续扣费'),false);
  helpCompletion.unmount();
}
console.log('S4 UI passed: startup/lock/lifecycle, help merge/truncation and immediate post-help completion in real/demo modes, capability/premise gates, submission caps, reference consent, store-to-host metric invalidation/undo/redo, blank-input no-IO/no-count, given immutability. Offline synthetic IO, not browser E2E.');

// Insert from a conclusion reuses its incoming premises, never creates a forbidden conclusion output.
const insertAtConclusion=harness(false);await flush();
insertAtConclusion.setRun({...insertAtConclusion.run,canvas:{...insertAtConclusion.run.canvas,nodes:insertAtConclusion.run.canvas.nodes.map((node:any)=>node.id==='step'?{...node,type:'conclusion'}:node)}});
insertAtConclusion.view('canvas').onSelectNode('step');insertAtConclusion.render();
const beforeInsertion=structuredClone(insertAtConclusion.run.canvas);
insertAtConclusion.view('helper').onInsert('x+1=2');insertAtConclusion.render();
const inserted=insertAtConclusion.run.canvas.nodes.at(-1);
assert.ok(insertAtConclusion.run.canvas.edges.some((edge:any)=>edge.source==='given'&&edge.target===inserted.id));
assert.equal(insertAtConclusion.run.canvas.edges.some((edge:any)=>edge.source==='step'),false);
assert.equal(s4Policy.isS4CanvasChangeAuthorized(beforeInsertion,insertAtConclusion.run.canvas,s4Policy.s4AllowedNodeTypes(spec)),true);
insertAtConclusion.unmount();

// Real host accepts only automatic invalidation of a disabled historical descendant.
const historicalHost=harness(false);await flush();
const historicalSpec={...spec,capabilityIds:['given-node','formula-node','conclusion-node','compute-help']};
historicalHost.update({spec:historicalSpec});
historicalHost.setRun({...historicalHost.run,canvas:{...historicalHost.run.canvas,nodes:[...historicalHost.run.canvas.nodes,
  {id:'disabled-old',type:'assumption',position:{x:600,y:0},data:{label:'old',latex:'x>0',status:'pass',frozen:true,verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'synthetic old'}}}],
  edges:[...historicalHost.run.canvas.edges,{id:'old',source:'step',target:'disabled-old',type:'derivation'}]}});
useDerivationStore.getState().initCanvas(historicalHost.run.canvas);
useDerivationStore.getState().updateNodeDraft('step',{latex:'x+1=2'});
historicalHost.view('canvas').onChange(useDerivationStore.getState().canvas);historicalHost.render();
assert.equal(historicalHost.run.canvas.nodes[1].data.latex,'x+1=2');
assert.equal(historicalHost.run.canvas.nodes.at(-1).data.status,'draft');historicalHost.unmount();

const cardEnv={katex:{},Lightbulb:'light',AlertTriangle:'alert',Plus:'plus'};
const pureCard=mount(compile('src/components/scene/HelperPanel.tsx','HelpCard'),cardEnv,
  {content:{step_number:1,latex:'',step_content:'纯解释',reason:'形象例子',related_knowledge:[],correction:null},remaining:1,onInsert(){assert.fail('no formula insertion');}});
assert.equal(all({props:pureCard.view('div')}).some(node=>node.type==='button'),false);
pureCard.unmount();
const goalPanel=mount(analysisCode,{katex:{},DERIVATION_STATUS_LABEL,Lightbulb:'light',AlertTriangle:'alert',CheckCircle2:'check',Plus:'plus',Send:'send',Loader2:'loader'},
  {node:{...first,type:'conclusion',data:{...first.data,status:'pass',verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'数学成立',goalAssessment:{status:'not-achieved',reason:'仍需回答原问题',inputKey:''}}}},streaming:false});
assert.ok(goalPanel.find(node=>node.props.role==='status'&&node.props['aria-live']==='polite'));
assert.ok(goalPanel.find(node=>node.type==='p'&&node.props.children.some((child:any)=>typeof child==='string'&&child.includes('尚未完整回答'))));goalPanel.unmount();
console.log('S4 repair UI passed: safe conclusion insertion, accepted historical proof invalidation, pure-text cards without insert controls and independent accessible goal status. Production handlers; synthetic IO only.');

async function pendingGoalUi() {
  const ui=harness(false);await flush();
  const scene={...spec,completion:{mode:'signal',maxTurns:1}};
  ui.update({spec:scene});ui.setRun({...ui.run,sceneId:scene.sceneId,turnCount:0,canvas:{...ui.run.canvas,
    nodes:ui.run.canvas.nodes.map((node:any)=>node.id==='step'?{...node,type:'conclusion'}:node)}});
  ui.setAnalyze(async(params:any)=>({status:'pass',metricUpdates:[],verification:{formula_correct:true,dimension_check:true,
    verdictSource:'premise',feedback:'数学结果必须保留',goalAssessment:s4GoalAssessment(scene,params.run,'step',undefined)}}));
  ui.view('canvas').onSubmitNode('step');await flush();ui.render();
  assert.equal(ui.run.status,'running');assert.equal(ui.run.turnCount,1);assert.equal(ui.view('helper').goalRetryAvailable,true);
  return {ui,scene};
}
const goalRecovery=await pendingGoalUi();const goalGate=deferred();let goalModelCalls=0;
goalRecovery.ui.setGoal((params:any)=>requestS4GoalCheck({...params,callLlm:async()=>{goalModelCalls++;return goalGate.promise;}}));
const retry=goalRecovery.ui.view('helper').onRetryGoal;
const retrying=retry('step');await retry('step');goalRecovery.ui.render();
assert.equal(goalRecovery.ui.goalChecks.length,1);assert.equal(goalModelCalls,1);assert.equal(goalRecovery.ui.view('helper').goalChecking,true);
goalRecovery.ui.setRun({...goalRecovery.ui.run,canvas:{...goalRecovery.ui.run.canvas,viewport:{x:51,y:12,zoom:2}}});
goalGate.resolve({content:JSON.stringify({goal_assessment:{status:'achieved',reason:'合成覆盖'}})});await retrying;goalRecovery.ui.render();
assert.equal(goalRecovery.ui.run.status,'success');assert.equal(goalRecovery.ui.run.turnCount,1);assert.equal(goalRecovery.ui.run.canvas.helpUsed,0);
assert.equal(goalRecovery.ui.run.canvas.nodes[1].data.verification.feedback,'数学结果必须保留');
assert.equal(goalRecovery.ui.run.canvas.viewport.x,51);assert.equal(goalRecovery.ui.analyzed.length,1);
assert.equal(goalRecovery.ui.run.derivationEvents.filter((event:any)=>event.type==='goal_check_request').length,1);
assert.equal(s4Policy.isS4ReferenceUnlocked(goalRecovery.ui.run),false);goalRecovery.ui.unmount();

const failures=await pendingGoalUi();failures.ui.setGoal(async()=>{throw new Error('synthetic transport failure');});
await failures.ui.view('helper').onRetryGoal('step');failures.ui.render();
assert.equal(failures.ui.run.status,'running');assert.match(failures.ui.view('helper').error,/数学结果已保留/);
await failures.ui.view('helper').onRetryGoal('step');failures.ui.render();
assert.equal(failures.ui.goalChecks.length,2);assert.equal(failures.ui.view('helper').goalRetryAvailable,false);
await failures.ui.view('helper').onRetryGoal('step');assert.equal(failures.ui.goalChecks.length,2);
assert.equal(failures.ui.run.turnCount,1);assert.equal(failures.ui.run.canvas.helpUsed,0);assert.equal(failures.ui.run.status,'running');failures.ui.unmount();
const lateGoal=await pendingGoalUi();const lateGoalGate=deferred();lateGoal.ui.setGoal(()=>lateGoalGate.promise);
const lateGoalRequest=lateGoal.ui.view('helper').onRetryGoal('step');const oldGoalRun=structuredClone(lateGoal.ui.run);
lateGoal.ui.setRun({...structuredClone(run),sceneId:spec.sceneId,runId:'replacement-goal-run'});
const afterReplacement=lateGoal.ui.changes.length;
lateGoalGate.resolve({ok:true,assessment:s4GoalAssessment(lateGoal.scene,oldGoalRun,'step',{status:'achieved',reason:'stale'})});await lateGoalRequest;
assert.equal(lateGoal.ui.changes.length,afterReplacement);assert.equal(lateGoal.ui.run.status,'running');lateGoal.ui.unmount();

const branches=harness(false);await flush();
branches.setRun({...branches.run,sceneId:spec.sceneId,canvas:{...branches.run.canvas,nodes:[...branches.run.canvas.nodes,
  {...branches.run.canvas.nodes[1],id:'branch-b',data:{...branches.run.canvas.nodes[1].data,label:'B',latex:'y=2'}}],
  edges:[...branches.run.canvas.edges,{id:'b-input',source:'given',target:'branch-b',type:'derivation'}]}});
branches.setHelp((params:any)=>requestHelp({...params,callLlm:async()=>({content:JSON.stringify({latex:'y+1=3',reason:'合成B提示'})})}));
branches.view('canvas').onRequestHelp('step');branches.render();
const sameFrameAsk=branches.view('helper').onAsk;branches.view('canvas').onSelectNode('branch-b');
assert.equal(await sameFrameAsk('解释当前选中的B'),true);branches.render();
assert.equal(branches.helped.at(-1).currentNodeId,'branch-b');
const bCard=branches.view('helper').helpHistory.at(-1);assert.equal(bCard.nodeId,'branch-b');assert.ok(bCard.inputKey);
branches.view('canvas').onSelectNode('step');branches.render();
branches.view('helper').onInsert(bCard.content.latex,{nodeId:bCard.nodeId,inputKey:bCard.inputKey});branches.render();
const bInserted=branches.run.canvas.nodes.at(-1);
assert.ok(branches.run.canvas.edges.some((edge:any)=>edge.source==='branch-b'&&edge.target===bInserted.id));
assert.equal(branches.run.canvas.edges.some((edge:any)=>edge.source==='step'&&edge.target===bInserted.id),false);
branches.view('canvas').onChange({...branches.run.canvas,nodes:branches.run.canvas.nodes.map((node:any)=>node.id==='branch-b'?{...node,data:{...node.data,latex:'y=999'}}:node)});branches.render();
const beforeStaleInsertion=branches.run.canvas.nodes.length;
branches.view('helper').onInsert(bCard.content.latex,{nodeId:bCard.nodeId,inputKey:bCard.inputKey});branches.render();
assert.equal(branches.run.canvas.nodes.length,beforeStaleInsertion);assert.match(branches.view('helper').error,/支路已变化/);
const edgeCount=branches.run.canvas.edges.length;
branches.view('helper').onInsert('z=3',{nodeId:null});branches.render();
assert.equal(branches.run.canvas.nodes.length,beforeStaleInsertion+1);assert.equal(branches.run.canvas.edges.length,edgeCount,'legacy cards never silently connect to current selection');branches.unmount();

let forwarded:any[]=[];
const cardForwarder=mount(panelCode,{katex:{},DERIVATION_STATUS_LABEL,Lightbulb:'light',AlertTriangle:'alert',CheckCircle2:'check',Plus:'plus',Send:'send',Loader2:'loader',requestAnimationFrame:()=>0,cancelAnimationFrame(){}},
  {analyzedNode:null,analyzing:false,helpHistory:[bCard],remaining:1,maxHelp:2,asking:false,error:null,onAsk:async()=>false,
    onInsert:(...args:any[])=>{forwarded=args;},tab:'help',onTabChange(){}});
cardForwarder.find(node=>typeof node.type==='function'&&node.type.name==='HelpCard').onInsert();
assert.deepEqual(forwarded,[bCard.content.latex,{nodeId:bCard.nodeId,inputKey:bCard.inputKey}]);cardForwarder.unmount();

const oldProof={...structuredClone(run.canvas),nodes:[...structuredClone(run.canvas.nodes),{id:'disabled-history',type:'assumption',position:{x:600,y:0},
  data:{label:'old',latex:'x>0',status:'pass',frozen:false,verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'old'}}}],
  edges:[...structuredClone(run.canvas.edges),{id:'old-output',source:'step',target:'disabled-history',type:'derivation'}]};
let historyState=oldProof;
const historyUi=mount(fullCanvasCode,canvasEnv,{canvasState:oldProof,allowedNodeTypes:allowed,
  onChange(next:any){assert.equal(s4Policy.isS4CanvasChangeAuthorized(historyState,next,allowed),true);historyState=next;},onSubmitNode(){},onRequestHelp(){}});
useDerivationStore.getState().updateNodeDraft('step',{latex:'x=2'});historyUi.render();historyUi.update({canvasState:historyState});
historyUi.find(node=>node.type==='button'&&node.props.title==='撤销（Ctrl+Z）').onClick();historyUi.render();historyUi.update({canvasState:historyState});
assert.equal(historyState.nodes[1].data.latex,'x=1');assert.equal(historyState.nodes[2].data.status,'draft');assert.equal(useDerivationStore.getState().future.length,1);
historyUi.find(node=>node.type==='button'&&node.props.title==='重做（Ctrl+Y）').onClick();historyUi.render();historyUi.update({canvasState:historyState});
assert.equal(historyState.nodes[1].data.latex,'x=2');assert.equal(historyState.nodes[2].data.verification,undefined);historyUi.unmount();
console.log('S4 recovery UI passed: capped goal-only retry/single-flight/late-run/quota safety, same-frame selection, origin-bound/stale/legacy helper insertion, actual card forwarding and canvas undo/redo projection. Synthetic IO only.');
