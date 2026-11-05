import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as model from '../src/services/knowledgeGraphModel';
import * as mastery from '../src/services/masteryReadModel';

// Execute the real component handlers, with pure graph data and synthetic focus targets only.
globalThis.fetch = async () => assert.fail('Graph UI checks must not access services');
const source = readFileSync('src/components/GraphView.tsx', 'utf8');
assert.match(source, /role="button" tabIndex=\{0\} aria-current=\{selected \? 'true' : undefined\}/, 'graph content nodes expose a real keyboard-operable button');
assert.match(source, /event\.currentTarget\.click\(\)/, 'Enter or Space reuses the graph node click path');
assert.match(source, /nodesFocusable=\{false\}/, 'React Flow wrapper focus is disabled so each node has one focus target');
const ast = ts.createSourceFile('GraphView.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = ast.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(ast)).join('\n').replace(/^export\s+/gm, '');
const code = ts.transpileModule(`${body}\nreturn GraphView;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const flatten = (n: any): any[] => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(flatten) : [n, ...flatten(n.props?.children)];
const slots: any[] = [], pending: any[] = [], cleanup: any[] = [], listeners = new Map<string, any>();
let cursor = 0, tree: any[] = [], focused = '', focusReopens = false;
const same = (a: any[], b: any[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hooks = {
  useId: () => 'graph-test',
  useState(initial: any) { const i = cursor++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (v: any) => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useMemo(fn: any, deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
  useCallback(fn: any, deps: any[]) { return hooks.useMemo(() => fn, deps); },
  useEffect(fn: any, deps: any[]) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { slots[i] = { deps }; pending.push(() => { cleanup[i]?.(); cleanup[i] = fn(); }); } },
};
const names = ['Background','BaseEdge','Controls','EdgeLabelRenderer','Handle','MiniMap','ReactFlow',
  'BookOpen','ChevronRight','ExternalLink','Filter','FolderTree','Layers3','Link2','Network','Route','Search','Settings2','Target','X', 'KnowledgeMasteryStatus', 'QuickCheckButton'];
const env = { ...model, ...mastery, ...hooks, ...Object.fromEntries(names.map(n => [n, n])),
  BackgroundVariant: { Dots: 'dots' }, MarkerType: { ArrowClosed: 'arrow' }, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  document: { addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) },
  React: { ...hooks, Fragment: 'fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
};
const Graph = new Function(...Object.keys(env), code)(...Object.values(env));
const base: any = { content: '', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-07', updatedAt: '2026-10-07' };
const notes = [{ ...base, id: 'root', title: '根项目', noteType: 'project' },
  { ...base, id: 'leaf', parentId: 'root', title: '学习判断', noteType: 'project', links: ['条件概率'] },
  { ...base, id: 'first', title: '同名笔记', noteType: 'knowledge' },
  { ...base, id: 'chosen', title: '同名笔记', noteType: 'knowledge' },
  { ...base, id: 'probability', title: '条件概率', noteType: 'knowledge' }];
const opened: any[] = [], legacy: any[] = [];
let props: any = { notes, onOpenNote: (...args: any[]) => opened.push(args), onSelectNoteByTitle: (title: string) => legacy.push(title) };
const find = (test: (n: any) => boolean) => { const n = tree.find(test); assert.ok(n, 'control exists'); return n.props; };
const input = () => find(n => n.type === 'input' && n.props['aria-label'] === '搜索知识图谱');
const search = () => find(n => n.props.className === 'knowledge-graph-search-wrap');
const resultButtons = () => tree.filter(n => n.type === 'button' && n.props.onClick && flatten(n).some(c => c.type === 'strong' && c.props.children.includes('同名笔记')));
const key = (name: string, target: any, extra = {}) => ({ key: name, target, nativeEvent: {}, defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra });
const focusTarget = (name: string) => ({ focus: () => { focused = name; if (name === 'input' && focusReopens) input().onFocus(); } });
const inputTarget = focusTarget('input'), resultTargets = [focusTarget('result-0'), focusTarget('result-1')];
function render() {
  for (const n of tree) if (n.props.ref) n.props.ref.current = null;
  cursor = 0; tree = flatten(Graph(props));
  for (const n of tree) {
    if (n.props.ref && n.type === 'input') n.props.ref.current = inputTarget;
    if (n.props.className === 'knowledge-graph-search-results') n.props.ref.current = { querySelectorAll: () => resultTargets };
    if (n.props.className === 'knowledge-graph-layout-trigger') n.props.ref.current = { contains: () => false };
    if (n.type === 'button' && flatten(n).some(c => c.props.children.includes('布局设置'))) n.props.ref.current = focusTarget('layout');
  }
  pending.splice(0).forEach(fn => fn());
}
render(); render();
input().onChange({ target: { value: '同名' } }); render();
search().onBlur({ currentTarget: { contains: () => true }, relatedTarget: resultTargets[0] }); render();
assert.equal(resultButtons().length, 2, 'Tab into result must not close search');
search().onKeyDown(key('ArrowDown', inputTarget)); assert.equal(focused, 'result-0');
search().onKeyDown(key('End', resultTargets[0])); assert.equal(focused, 'result-1');
search().onKeyDown(key('ArrowDown', resultTargets[1])); assert.equal(focused, 'result-0');
search().onKeyDown(key('Enter', inputTarget, { nativeEvent: { isComposing: true } })); render();
assert.equal(resultButtons().length, 2, 'IME confirmation cannot select a result');
search().onKeyDown(key('Escape', resultTargets[1])); render(); assert.equal(focused, 'input');
assert.equal(resultButtons().length, 0);
search().onKeyDown(key('ArrowUp', inputTarget)); render(); assert.equal(focused, 'result-1', 'closed results reopen and focus last match');
focusReopens = true; resultButtons()[1].props.onClick(); render();
assert.equal(resultButtons().length, 0, 'restoring focus cannot reopen removed results');
assert.equal(focused, 'input');
const inspector = () => find(n => typeof n.type === 'function' && n.type.name === 'GraphInspector');
inspector().onOpenNote(notes[3]); assert.deepEqual(opened.at(-1), ['chosen', null]);
find(n => n.type === 'button' && flatten(n).some(c => c.type === 'strong' && c.props.children.includes('根项目'))).onClick(); render();
inspector().onOpenNote(notes[4]); assert.deepEqual(opened.at(-1), ['probability', 'root'], 'knowledge retains only its own selected scope');
inspector().onOpenNote(notes[3]); assert.deepEqual(opened.at(-1), ['chosen', null], 'unrelated knowledge clears inherited scope');
const staleOpen = inspector().onOpenNote;
props = { ...props, notes: notes.filter(n => n.id !== 'chosen') }; render(); staleOpen(notes[3]); render();
assert.equal(opened.length, 3, 'deleted identity never opens another same-title object');
assert.match(find(n => n.props.className === 'knowledge-graph-navigation-notice').children[0], /已移除/);
props = { ...props, notes: notes.map(n => n.id === 'chosen' ? { ...n, title: '新名称' } : n), onOpenNote: undefined }; render();
inspector().onOpenNote(notes[3]); assert.deepEqual(legacy, ['新名称']);
const layout = () => find(n => n.type === 'button' && flatten(n).some(c => c.props.children.includes('布局设置')));
layout().onClick(); render(); assert.equal(listeners.has('pointerdown'), true);
find(n => n.props.className === 'knowledge-graph-layout-trigger').onKeyDown(key('Escape', null)); render();
assert.equal(focused, 'layout'); assert.equal(layout()['aria-expanded'], false); assert.equal(listeners.has('pointerdown'), false);
layout().onClick(); render();
find(n => n.props.className === 'knowledge-graph-layout-trigger').onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); render();
assert.equal(layout()['aria-expanded'], false, 'Tab outside dismisses without moving focus');
const tabs = [focusTarget('knowledge'), focusTarget('overview'), focusTarget('path')];
const tabEvent = key('ArrowLeft', tabs[0]) as any; tabEvent.currentTarget = { querySelectorAll: () => tabs };
find(n => n.props.role === 'tablist').onKeyDown(tabEvent); assert.equal(focused, 'path');
const backEvent = { ...tabEvent, altKey: true, defaultPrevented: false };
find(n => n.props.role === 'tablist').onKeyDown(backEvent); assert.equal(backEvent.defaultPrevented, false, 'tabs must not consume Alt+Left return navigation');
assert.equal(find(n => n.props.role === 'tab' && n.props['aria-selected'] === true).children[1], '知识关联', 'arrow focus does not activate expensive graph');
find(n => n.props.role === 'tab' && n.props.children.includes('学习路径')).onClick(); render();
inspector().onSelectRelated(notes[2]); render();
assert.equal(inspector().mode, 'knowledge', 'unscoped knowledge search cannot leave an unrelated project path visible');
const app = readFileSync('src/App.tsx', 'utf8');
assert.match(app, /React\.createElement\(GraphView, \{[^\n]*onOpenNote: handleOpenContextNote/);
assert.doesNotMatch(source, /setTimeout/);
cleanup.forEach(fn => fn?.());
console.log('PASS graph UI: exact identity, removed/renamed notes, search focus/IME/arrows, menu dismissal and manual tabs');
