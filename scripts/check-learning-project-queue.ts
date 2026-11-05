import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem, DueDateItem } from '../src/types';
import { buildLearningProjectQueue } from '../src/services/learningProjectQueue';
import { homeLocalDate } from '../src/services/homepage/homeTaskScheduling';
import { getScheduledProjectState } from '../src/services/planProjectState';

globalThis.fetch = async () => assert.fail('Learning queue checks must never access a model or network');
const today = '2026-10-07';
const note = (id: string, parentId?: string): NoteItem => ({ id, title: `合成-${id}`, parentId,
  noteType: 'project', content: '', tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: `${today}T00:00:00Z`, updatedAt: `${today}T00:00:00Z` });
const due = (owner: NoteItem, patch: Partial<DueDateItem> = {}): DueDateItem => ({ id: `deadline-${owner.id}`,
  noteId: owner.id, noteTitle: owner.title, taskText: owner.title, completed: false, priority: 'medium',
  startDate: today, dueDate: today, ...patch });
const root = note('root');
const middle = note('middle', root.id);
const current = note('current', middle.id);
current.dueDates = [due(current, { dueDate: '2026-10-10' }), due(current, {
  id: 'recurring', taskText: '每天练习一题', startDate: '2026-01-01', dueDate: '2026-01-01',
  recurrence: { frequency: 'daily' }, completedOccurrenceDates: [today],
})];
const future = note('future', root.id); future.dueDates = [due(future, { startDate: '2026-10-08', dueDate: '2026-10-08' })];
const done = note('done', root.id); done.dueDates = [due(done, { completed: true }), current.dueDates[1]];
const free = note('free', root.id);
const knowledge = { ...note('knowledge', current.id), noteType: 'knowledge' as const, dueDates: [due(current, { taskText: '旧知识点待办', dueDate: '2026-01-02' })] };
const pausedRoot = { ...note('paused-root'), planMeta: { schemaVersion: 2 as const, status: 'paused' as const } };
const paused = note('paused', pausedRoot.id); paused.dueDates = [due(paused, { dueDate: '2026-01-01', startDate: '2026-01-01' })];
const notes = [root, middle, current, future, done, free, knowledge, pausedRoot, paused];
const before = JSON.stringify(notes);
const entries = buildLearningProjectQueue(notes, today);
assert.deepEqual(entries.map(entry => entry.note.id), ['current', 'future', 'free', 'done', 'paused']);
const byId = new Map(entries.map(entry => [entry.note.id, entry]));
assert.equal(byId.get(current.id)!.nearestDueDate, '2026-10-10', 'execution and knowledge deadlines do not replace the structural deadline');
assert.equal(byId.get(current.id)!.totalTasks, 1);
assert.deepEqual(byId.get(current.id)!.parentChain.map(parent => parent.id), ['root', 'middle']);
assert.equal(byId.get(done.id)!.isFullyCompleted, true, 'a recurring rule never makes a completed project incomplete');
assert.equal(byId.get(done.id)!.completedTasks, 1);
assert.equal(byId.get(future.id)!.isTomorrow, true);
assert.equal(byId.get(future.id)!.isFuture, true);
assert.equal(byId.get(paused.id)!.inactiveStatus, 'paused');
assert.equal(byId.get(free.id)!.totalTasks, 0, 'unscheduled notes remain available for free learning');
assert.equal(JSON.stringify(notes), before, 'reading the queue never rewrites deadlines or notes');
assert.equal(buildLearningProjectQueue(notes, '2026-02-30').length, 0);
assert.equal(buildLearningProjectQueue([root, { ...free, dueDates: [due(free, { dueDate: '2026-02-30' })] }], today)[0].nearestDueDate, null);
assert.equal(buildLearningProjectQueue([root, current, { ...current }], today).some(entry => entry.note.id === current.id), false);
const cycleA = note('cycle-a', 'cycle-b'), cycleB = note('cycle-b', 'cycle-a'), cycleLeaf = note('cycle-leaf', 'cycle-a');
assert.deepEqual(buildLearningProjectQueue([cycleA, cycleB, cycleLeaf], today), [], 'a corrupt ancestor cycle cannot hang learning');
const originalTZ = process.env.TZ;
try {
  process.env.TZ = 'Asia/Shanghai';
  assert.equal(homeLocalDate(new Date('2026-10-06T17:30:00Z')), today, 'early morning uses the local calendar, not the previous UTC date');
} finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }

type Tree = { type: unknown; props: Record<string, any> };
const React = { createElement: (type: unknown, props: any, ...children: any[]): Tree => ({ type, props: { ...props, children } }) };
const all = (value: any): Tree[] => !value || typeof value !== 'object' ? []
  : Array.isArray(value) ? value.flatMap(all) : [value, ...all(value.props?.children)];
function compile(path: string, environment: Record<string, unknown>, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const js = ts.transpileModule(`${code}\nreturn { ${names.join(', ')} };`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
  } }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment));
}
const icons = Object.fromEntries(['Folder', 'ChevronRight', 'ChevronDown', 'Check', 'ArrowRight', 'BookOpen', 'BrainCircuit',
  'CalendarClock', 'CheckCircle2', 'Clock3', 'FolderTree', 'Layers3', 'MessageSquare', 'Route', 'Sparkles', 'TimerReset'].map(name => [name, name]));
const treeModule = compile('src/components/ProjectTreePanel.tsx', { React, ...icons, useId: () => 'tree', getScheduledProjectState },
  ['buildProjectTree', 'buildProjectTreeStructure', 'isProjectFullyCompleted', 'ProjectTreePanel']);
assert.equal(treeModule.isProjectFullyCompleted(done, notes), true);
assert.equal(treeModule.buildProjectTree(cycleA, [cycleA, cycleB]).length, 2);
assert.deepEqual(treeModule.buildProjectTreeStructure([cycleA, cycleB]), []);
assert.equal(treeModule.buildProjectTreeStructure([root, free, free])[0].children.length, 0);
const selected: string[] = [], toggled: string[] = [];
const tree = treeModule.ProjectTreePanel({ nodes: treeModule.buildProjectTreeStructure(notes), expandedIds: new Set([root.id]),
  selectedTreeId: current.id, onSelect: (id: string) => selected.push(id), onToggleExpand: (id: string) => toggled.push(id) });
const treeButtons = all(tree).filter(node => node.type === 'button');
const expandRoot = treeButtons.find(node => node.props['aria-label'] === `收起${root.title}`)!;
assert.equal(expandRoot.props['aria-expanded'], true);
assert.ok(expandRoot.props['aria-controls']); expandRoot.props.onClick();
assert.deepEqual(toggled, [root.id]); assert.deepEqual(selected, [], 'expansion cannot accidentally launch or select');
treeButtons.find(node => node.props.title === root.title)!.props.onClick();
assert.deepEqual(selected, [root.id]);
assert.ok(treeButtons.every(node => node.props.type === 'button'));

const slots: any[] = []; let cursor = 0;
const effects: (() => void)[] = [];
const useState = (initial: any) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
  return [slots[slot].value, (value: any) => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }]; };
const useRef = (value: any) => { const slot = cursor++; return slots[slot] ||= { current: value }; };
const useEffect = (effect: () => void, deps: any[]) => { const slot = cursor++; if (!slots[slot] || deps.some((dep, i) => dep !== slots[slot][i])) { slots[slot] = deps; effects.push(effect); } };
const focuses: string[] = [], launches: any[] = [];
const hubModule = compile('src/components/LearnHub.tsx', { React, ...icons, useState, useRef, useEffect, useId: () => 'mode',
  useMemo: (callback: () => any) => callback(), useCallback: (callback: any) => callback,
  buildProjectTreeStructure: treeModule.buildProjectTreeStructure, buildLearningProjectQueue, useLocalCalendarDate: () => today,
  FlowEntranceModal: 'flow-entry', ProjectTreePanel: 'project-tree', StormMode: 'storm', SceneBuilderPanel: 'scene',
  window: { matchMedia: () => ({ matches: true }) },
}, ['LearnHub', 'DueBadge']);
const props = { notes, flowSettings: { reviewIntervalMinutes: 35 }, onEnterFlow: (...args: any[]) => launches.push(args), onUpdateNote: () => assert.fail('queue may not write') };
const render = (nextProps = props) => { cursor = 0; const nodes = all(hubModule.LearnHub(nextProps));
  nodes.filter(node => node.props.ref).forEach(node => node.props.ref({ focus: () => focuses.push(node.props.id || node.props.className), scrollIntoView: () => {} }));
  effects.splice(0).forEach(effect => effect()); return nodes; };
let nodes = render(); nodes = render();
const flowTab = nodes.find(node => node.props.id === 'mode-flow')!;
flowTab.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
assert.equal(focuses.at(-1), 'mode-storm');
nodes = render(); assert.ok(!nodes.some(node => node.type === 'storm'), 'arrow navigation does not mount a model-backed mode');
nodes.find(node => node.type === 'project-tree')!.props.onToggleExpand(root.id);
nodes = render({ ...props, notes: [...notes] });
assert.equal(nodes.find(node => node.type === 'project-tree')!.props.expandedIds.has(root.id), false, 'autosave does not reopen a collapsed branch');
const projectCard = nodes.find(node => node.type === 'button' && String(node.props.className || '').includes('flow-project-card'))!;
assert.equal(projectCard.props.type, 'button', 'learning queue cards use native button semantics');
assert.match(projectCard.props['aria-label'], /^打开项目：/);
assert.equal(projectCard.props.role, undefined, 'native controls do not need a simulated button role');
projectCard.props.onClick(); nodes = render();
const entrance = nodes.find(node => node.type === 'flow-entry')!;
assert.equal(entrance.props.note.id, future.id, 'keyboard activation enters the chosen leaf, not its root');
entrance.props.onConfirm(future.id, 40);
assert.deepEqual(launches, [[future.id, 40]]);
assert.equal(render().some(node => node.type === 'flow-entry'), false);
nodes = render(); nodes.find(node => node.type === 'button' && String(node.props.className || '').includes('flow-project-card'))!.props.onClick();
const changedProps = { ...props, notes: [...notes, note('new-child', future.id)] };
nodes = render(changedProps); nodes.find(node => node.type === 'flow-entry')!.props.onConfirm(future.id, 35);
assert.equal(launches.length, 1, 'a leaf changed into a container while the dialog was open cannot launch as stale work');
assert.ok(render(changedProps).some(node => node.props.role === 'alert'));

let localDay = today, stateDay: string | undefined, cleanup: (() => void) | undefined;
const dateListeners = new Map<string, () => void>(); let cleared = false;
const clockHook = compile('src/components/useLocalCalendarDate.ts', {
  useState: (initial: () => string) => [initial(), (value: string) => { stateDay = value; }],
  useEffect: (effect: () => () => void) => { cleanup = effect(); }, homeLocalDate: () => localDay,
  window: { setInterval: (callback: () => void, interval: number) => { assert.equal(interval, 60_000); dateListeners.set('tick', callback); return 7; },
    clearInterval: (id: number) => { assert.equal(id, 7); cleared = true; },
    addEventListener: (event: string, callback: () => void) => dateListeners.set(event, callback), removeEventListener: (event: string) => dateListeners.delete(event) },
  document: { addEventListener: (event: string, callback: () => void) => dateListeners.set(event, callback), removeEventListener: (event: string) => dateListeners.delete(event) },
}, ['useLocalCalendarDate']);
assert.equal(clockHook.useLocalCalendarDate(), today); localDay = '2026-10-08'; dateListeners.get('visibilitychange')!();
assert.equal(stateDay, localDay, 'returning to a page after midnight refreshes its calendar without editing notes');
cleanup!(); assert.equal(cleared, true); assert.equal(dateListeners.has('focus'), false); assert.equal(dateListeners.has('visibilitychange'), false);
console.log('Learning queue passed: leaf-only structural state, local calendar, future/paused ordering, recurrence separation, malformed/cyclic data, independent tree controls, manual keyboard tabs, collapse preservation and exact leaf launch. No IO.');
