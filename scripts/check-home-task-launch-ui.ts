import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DueDateItem, NoteItem } from '../src/types';
import type { HomeFocusProject } from '../src/services/homepage/homepageViewModel';
import { homeAbilitySummary } from '../src/services/homepage/homepageViewModel';
import { isLearningProject } from '../src/services/projectRole';
import { resolveHomeContinueAction } from '../src/services/homepage/homeTaskLaunch';
import {
  buildHomeScheduledTasks, compareHomePendingTasks, homeCalendarDay, homeLocalDate, isHomeRootActionable,
} from '../src/services/homepage/homeTaskScheduling';

// Only pure scheduling modules are imported. App and HomeView are compiled into memory,
// with all IO imports replaced before evaluation. No real notes, model or storage is reachable.
globalThis.fetch = async () => assert.fail('Home launch UI checks must never access the network');
const TODAY = homeLocalDate();
const TOMORROW = new Date((homeCalendarDay(TODAY)! + 1) * 86_400_000).toISOString().slice(0, 10);
const LATER = new Date((homeCalendarDay(TODAY)! + 3) * 86_400_000).toISOString().slice(0, 10);
type Tree = { type: unknown; props: Record<string, any> };
const React = {
  Fragment: Symbol('fragment'),
  createElement: (type: unknown, props: Record<string, any> | null, ...children: any[]): Tree => ({
    type, props: { ...(props || {}), children },
  }),
};
function all(value: any): Tree[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(all);
  return [value, ...all(value.props?.children)];
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(value.props?.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function extract(path: string, name: string): string {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let result: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) result = node.initializer?.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source).replace(/^export\s+/, '');
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(result, `Missing actual production declaration ${name}`);
  return result;
}
function evaluate<T>(expression: string, environment: Record<string, unknown>): T {
  const js = ts.transpileModule(`return (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(environment), js)(...Object.values(environment)) as T;
}
const buildHomeFocusProject = evaluate<(notes: NoteItem[], today?: string) => HomeFocusProject | null>(
  extract('src/services/homepage/homepageViewModel.ts', 'buildHomeFocusProject'),
  { buildHomeScheduledTasks, compareHomePendingTasks, homeCalendarDay, homeLocalDate, isHomeRootActionable, isLearningProject },
);
function note(id: string, parentId?: string, noteType: NoteItem['noteType'] = 'project'): NoteItem {
  return { id, title: `合成-${id}`, parentId, noteType, content: '', dueDates: [], tags: [], links: [], backlinks: [],
    createdAt: `${TODAY}T00:00:00Z`, updatedAt: `${TODAY}T00:00:00Z`,
    ...(parentId ? {} : { planMeta: { schemaVersion: 2, status: 'active' } }) };
}
function task(owner: NoteItem, patch: Partial<DueDateItem> = {}): DueDateItem {
  return { id: 'home-occurrence', noteId: owner.id, noteTitle: owner.title, taskText: '完成一题概率计算',
    startDate: TODAY, dueDate: TODAY, completed: false, priority: 'medium',
    recurrence: { frequency: 'daily' }, executionKind: 'flow', ...patch };
}
const root = note('root');
const linked = note('linked-project', root.id);
const knowledgeNote = note('knowledge', linked.id, 'knowledge');
const executionNotes = (mode: 'flow' | 'scene' | 'review' | 'none', patch: Partial<DueDateItem> = {}): NoteItem[] => [
  { ...root, dueDates: [task(root, { launchMode: mode, linkedProjectId: linked.id, ...patch })] }, linked, knowledgeNote,
];
const focus = (notes: NoteItem[]) => {
  const value = buildHomeFocusProject(notes, TODAY);
  assert.ok(value, 'synthetic planned work must yield a root focus');
  return value;
};

const actualHandler = extract('src/App.tsx', 'handleContinueHomeProject');
function launchHarness(initialNotes: NoteItem[], allow = true) {
  const notesRef = { current: initialNotes };
  const calls: { name: string; args: any[] }[] = [];
  const capture = (name: string) => (...args: any[]) => { calls.push({ name, args }); };
  const environment = {
    notesRef, allowWorkspaceNavigation: () => allow, resolveHomeContinueAction,
    settings: { flowSettings: { reviewIntervalMinutes: 35 } },
    setPlanWorkspaceFocusId: capture('plan-root'), setCurrentView: capture('view'),
    handleEnterFlowMode: capture('flow'), handleEnterBubbleMode: capture('review'), handleEnterScene: capture('scene'),
    collectKnowledgePoints: (id: string, notes: NoteItem[]) => {
      calls.push({ name: 'knowledge', args: [id, notes] });
      return ['正态分布', '条件概率'];
    },
  };
  return { notesRef, calls, run: evaluate<(project: HomeFocusProject) => void>(actualHandler, environment) };
}
for (const mode of ['flow', 'scene', 'review'] as const) {
  const notes = executionNotes(mode);
  const project = focus(notes);
  const expected = { noteId: root.id, taskId: 'home-occurrence', occurrenceDate: TODAY };
  const before = JSON.stringify(notes);
  const launcher = launchHarness(notes);
  launcher.run(project);
  assert.equal(JSON.stringify(notes), before, 'a homepage launch must not mutate notes or mark work complete');
  assert.equal(launcher.calls.filter(call => call.name === mode).length, 1, 'one click performs only the matching launch');
  assert.equal(launcher.calls.some(call => call.name === 'view' || call.name === 'plan-root'), false);
  if (mode === 'flow') {
    assert.deepEqual(launcher.calls, [{ name: 'flow', args: [linked.id, 35, expected] }],
      'flow preserves the exact completion owner/occurrence and uses the configured interval');
  } else if (mode === 'scene') {
    const collection = launcher.calls.find(call => call.name === 'knowledge')!;
    assert.equal(collection.args[0], linked.id); assert.equal(collection.args[1], notes);
    const request = launcher.calls.find(call => call.name === 'scene')!.args[0];
    assert.deepEqual(request, { source: 'build', subject: linked.title, knowledgePoints: ['正态分布', '条件概率'],
      extraHints: '本次计划事项：完成一题概率计算', taskBinding: expected });
    assert.notEqual(request.taskBinding.noteId, request.subject, 'binding remains the execution owner, not the learning object/title');
  } else {
    assert.deepEqual(launcher.calls, [{ name: 'review', args: [{ scope: 'project', strategy: 'smart', noteTitle: linked.title }] }],
      'review focuses the actual linked project rather than the enclosing root');
  }
}

// A knowledge-owned execution uses its own content/title without pretending it is a project.
const knowledgeSceneNotes = [root, linked, { ...knowledgeNote, dueDates: [task(knowledgeNote, { launchMode: 'scene' })] }];
const knowledgeScene = launchHarness(knowledgeSceneNotes);
knowledgeScene.run(focus(knowledgeSceneNotes));
assert.deepEqual(knowledgeScene.calls, [{ name: 'scene', args: [{ source: 'build', subject: knowledgeNote.title,
  knowledgePoints: [knowledgeNote.title], extraHints: '本次计划事项：完成一题概率计算',
  taskBinding: { noteId: knowledgeNote.id, taskId: 'home-occurrence', occurrenceDate: TODAY } }] }]);
const knowledgeReviewNotes = [root, linked, { ...knowledgeNote, dueDates: [task(knowledgeNote, { launchMode: 'review' })] }];
const knowledgeReview = launchHarness(knowledgeReviewNotes);
knowledgeReview.run(focus(knowledgeReviewNotes));
assert.deepEqual(knowledgeReview.calls, [{ name: 'review', args: [{ scope: 'knowledge', strategy: 'smart', noteTitle: knowledgeNote.title }] }]);

const structural = { ...linked, dueDates: [task(linked, { id: 'structural-deadline', taskText: linked.title, dueDate: LATER, recurrence: undefined })] };
const structureNotes = [root, structural, knowledgeNote];
const structureLaunch = launchHarness(structureNotes); structureLaunch.run(focus(structureNotes));
assert.deepEqual(structureLaunch.calls, [{ name: 'flow', args: [linked.id, 35, { noteId: linked.id }] }], 'a structural leaf binds itself, not an artificial execution occurrence');

function assertPlan(current: NoteItem[], rendered: HomeFocusProject, description: string) {
  const action = resolveHomeContinueAction(current, rendered, TODAY);
  assert.deepEqual(action, { kind: 'plan', rootId: root.id }, description);
  const launch = launchHarness(current); launch.run(rendered);
  assert.deepEqual(launch.calls, [{ name: 'plan-root', args: [root.id] }, { name: 'view', args: ['timeline'] }], description);
}
const originallyRendered = focus(executionNotes('scene'));
assertPlan(executionNotes('none'), focus(executionNotes('none')), 'no-launch actions return to the selected plan root');
const future = executionNotes('scene', { startDate: TOMORROW, dueDate: TOMORROW });
assertPlan(future, focus(future), 'future tasks are previews, never early learning launches');
assertPlan([{ ...root, dueDates: [] }, linked, knowledgeNote], originallyRendered, 'removed work is revalidated at click time');
assertPlan(executionNotes('flow'), originallyRendered, 'changing a task launch mode invalidates the rendered recommendation');
assertPlan(executionNotes('scene', { completedOccurrenceDates: [TODAY] }), originallyRendered, 'today completed elsewhere cannot launch again');
const oneOffNotes = executionNotes('flow', { recurrence: undefined, dueDate: LATER });
const oneOffSnapshot = focus(oneOffNotes);
assertPlan(executionNotes('flow', { recurrence: undefined, dueDate: TOMORROW }), oneOffSnapshot, 'changed deadlines invalidate a rendered one-off launch even when owner and task IDs are unchanged');
assertPlan(executionNotes('scene', { recurrence: undefined, completed: true }), originallyRendered, 'a converted/completed task cannot preserve an old recurring authority');
assertPlan(executionNotes('scene').map(item => item.id === root.id ? { ...item, planMeta: { schemaVersion: 2, status: 'paused' } } : item),
  originallyRendered, 'paused plans return to their own planning workspace');
assertPlan(structureNotes.map(item => item.id === linked.id ? { ...item, dueDates: [] } : item), focus(structureNotes),
  'a removed structural time range cannot keep an old learning shortcut');
assertPlan(executionNotes('scene'), { ...originallyRendered, nextLaunch: null }, 'no rendered action must not invent a new launch');
for (const mode of ['flow', 'scene', 'review', 'none'] as const) {
  const guarded = launchHarness(executionNotes(mode), false); guarded.run(focus(executionNotes(mode)));
  assert.deepEqual(guarded.calls, [], 'blocked workspace navigation produces zero mutations/launches');
}

// Evaluate the production card, not a test reimplementation of its action labels/click callback.
const icons = Object.fromEntries(['ArrowRight', 'BookOpenText', 'CalendarClock', 'CheckCircle2', 'CircleGauge', 'Network'].map(name => [name, () => null]));
const ProjectFocusCard = evaluate<(props: any) => Tree>(extract('src/components/HomeView.tsx', 'ProjectFocusCard'), {
  React, ...icons, formatDueDate: (date: string) => date,
});
const cardAction = (project: HomeFocusProject | null, expected: string) => {
  let received: HomeFocusProject | null = null, opens = 0;
  const tree = ProjectFocusCard({ vm: { focusProject: project }, onContinueProject: (value: HomeFocusProject) => { received = value; }, onOpenPlan: () => opens++ });
  const action = all(tree).find(node => node.type === 'button')!;
  assert.equal(text(action), expected);
  assert.equal(action.props.type, 'button');
  action.props.onClick();
  if (project) { assert.equal(received, project, 'the card sends the complete focus object with exact binding'); assert.equal(opens, 0); }
  else { assert.equal(opens, 1); assert.equal(received, null); }
};
cardAction(null, '制定计划');
cardAction(focus(executionNotes('flow')), '继续学习');
cardAction(focus(executionNotes('scene')), '开始练习');
cardAction(focus(executionNotes('review')), '去复习');
cardAction(focus(executionNotes('none')), '查看待办');
cardAction(focus(future), '查看计划');
cardAction({ ...originallyRendered, nextLaunch: null, nextTask: null, completedTasks: 1, totalTasks: 1 }, '查看计划');

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const drain = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
function homeHarness() {
  const slots: any[] = [], cleanups = new Map<number, () => void>();
  let cursor = 0, unmounted = false, updatesAfterUnmount = 0;
  let effects: { index: number; effect: () => void | (() => void) }[] = [];
  let tree: Tree;
  const calls = { refresh: 0, timeline: 0, profile: 0, build: 0 };
  const vm = { focusProject: originallyRendered, reviewEchoes: [], layeredAbility: { concept: 0, judgment: 0, reasoning: 0 } };
  let timeline: () => Promise<any> = async () => ({ version: 1, weeks: [] });
  let refresh: () => Promise<void> = async () => {};
  let builder = () => vm;
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => {
        if (unmounted) updatesAfterUnmount++;
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index][position]))) {
        slots[index] = deps; effects.push({ index, effect });
      }
    },
  };
  const HomeView = evaluate<(props: any) => Tree>(extract('src/components/HomeView.tsx', 'HomeView'), {
    ...hooks, React, ...icons, ProjectFocusCard, LogicFigure: () => null, HomeReviewEchoCard: () => null,
    cachedCapacitySettings: () => ({}), weekStartDate: () => TODAY,
    buildLearningCapacity: () => ({ scheduledMinutes: 0, budgetMinutes: null, percent: null }), homeAbilitySummary,
    refreshLearningAbility: async (notes: NoteItem[]) => { assert.ok(notes.every(item => item.id.startsWith('root') || item.id.startsWith('linked') || item.id.startsWith('knowledge'))); calls.refresh++; await refresh(); },
    loadMasteryTimeline: async () => { calls.timeline++; return timeline(); },
    getUserProfile: () => { calls.profile++; return {}; },
    buildHomeViewModel: () => { calls.build++; return builder(); },
  });
  let notes = executionNotes('scene');
  const render = () => {
    cursor = 0; effects = [];
    tree = HomeView({ notes, onContinueProject: () => {}, onOpenPlan: () => {}, onOpenReview: () => {}, onOpenProfile: () => {} });
    for (const effect of effects) { cleanups.get(effect.index)?.(); const cleanup = effect.effect(); if (cleanup) cleanups.set(effect.index, cleanup); }
    return tree;
  };
  return { render, calls, vm, setTimeline: (value: typeof timeline) => { timeline = value; }, setRefresh: (value: typeof refresh) => { refresh = value; },
    setBuilder: (value: typeof builder) => { builder = value; }, setNotes: (value: NoteItem[]) => { notes = value; },
    unmount: () => { unmounted = true; cleanups.forEach(cleanup => cleanup()); },
    current: () => tree, afterUnmount: () => updatesAfterUnmount };
}

// The actual asynchronous hook catches read failure and recovers through its actual retry button.
const failedHome = homeHarness();
failedHome.setTimeline(async () => { throw new Error('synthetic timeline failure'); });
let view = failedHome.render(); assert.equal(view.props.role, 'status');
await drain(); view = failedHome.render();
assert.equal(view.props.role, 'alert');
assert.ok(text(view).includes('学习线索读取失败，请重试。'));
assert.equal(failedHome.calls.build, 0);
const retry = all(view).find(node => node.type === 'button' && text(node) === '重试读取')!;
failedHome.setTimeline(async () => ({ version: 1, weeks: [] }));
retry.props.onClick(); failedHome.render(); await drain(); view = failedHome.render();
assert.equal(view.type, 'main'); assert.equal(failedHome.calls.timeline, 2); assert.equal(failedHome.calls.build, 1);
assert.equal(all(view).some(node => node.props.role === 'alert'), false);
assert.equal(all(view).find(node => node.type === ProjectFocusCard)!.props.vm, failedHome.vm);
failedHome.setTimeline(async () => { throw new Error('synthetic subsequent timeline failure'); });
failedHome.setNotes(executionNotes('scene'));
failedHome.render(); await drain(); view = failedHome.render();
assert.equal(view.type, 'main', 'a later read failure preserves the previously visible homepage, not a blank loading page');
assert.ok(all(view).some(node => node.props.role === 'alert'));
failedHome.setTimeline(async () => ({ version: 1, weeks: [] }));
all(view).find(node => node.type === 'button' && text(node) === '重试读取')!.props.onClick();
failedHome.render(); await drain(); view = failedHome.render();
assert.equal(all(view).some(node => node.props.role === 'alert'), false);
assert.equal(failedHome.calls.timeline, 4);
failedHome.unmount();

// Refresh failure is nonfatal; an aggregation exception is recoverable too.
const aggregationHome = homeHarness();
aggregationHome.setRefresh(async () => { throw new Error('synthetic refresh failure'); });
aggregationHome.setBuilder(() => { throw new Error('synthetic view model failure'); });
aggregationHome.render(); await drain(); view = aggregationHome.render();
assert.equal(view.props.role, 'alert'); assert.equal(aggregationHome.calls.timeline, 1);
aggregationHome.setBuilder(() => aggregationHome.vm);
all(view).find(node => node.type === 'button')!.props.onClick(); aggregationHome.render(); await drain(); view = aggregationHome.render();
assert.equal(view.type, 'main'); aggregationHome.unmount();

for (const reject of [false, true]) {
  const lateHome = homeHarness();
  const waiting = deferred<any>();
  lateHome.setTimeline(() => waiting.promise);
  lateHome.render(); await drain(); assert.equal(lateHome.calls.timeline, 1);
  lateHome.unmount();
  if (reject) waiting.reject(new Error('synthetic late failure')); else waiting.resolve({ version: 1, weeks: [] });
  await drain();
  assert.equal(lateHome.afterUnmount(), 0, 'late successful/failed IO never updates an unmounted homepage');
  assert.equal(lateHome.calls.profile, 0); assert.equal(lateHome.calls.build, 0);
}
console.log('Home launch UI passed: actual card/App handlers, exact binding/mode/object, configured flow interval, stale/future/completed plan fallback, navigation guard, and read failure/retry/unmount. IO is fully mocked.');
