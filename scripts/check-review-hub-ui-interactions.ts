import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

// Actual component handlers + pure schedulers, isolated hooks/timers and notes.
// No Electron bridge, real storage, network, WebGL, or LLM is exposed to the UI.
type Element = { type: unknown; props: Record<string, any> };
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));

function all(element: unknown): Element[] {
  if (Array.isArray(element)) return element.flatMap(all);
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element;
  const localTree = typeof node.type === 'function' && node.type.name === 'ProjectTree' ? node.type(node.props) : null;
  return [node, ...all(localTree || node.props.children)];
}
const textContent = (node: any): string => Array.isArray(node) ? node.map(textContent).join('')
  : node && typeof node === 'object' && node.props ? textContent(node.props.children)
    : typeof node === 'string' || typeof node === 'number' ? String(node) : '';
function find(tree: Element, predicate: (node: Element) => boolean) {
  const match = all(tree).find(predicate);
  assert.ok(match, 'expected rendered control was not found');
  return match;
}
const byText = (tree: Element, type: string, text: string) => find(tree, (node) => node.type === type && textContent(node) === text);
const byClass = (tree: Element, className: string) => find(tree, (node) => node.props.className?.split(' ').includes(className));
const tab = (tree: Element, text: string) => find(tree, (node) => node.props.role === 'tab' && textContent(node) === text);
function keyEvent(key: string, extra: Record<string, any> = {}) {
  return { key, defaultPrevented: false, repeat: false, nativeEvent: { isComposing: false }, target: null,
    preventDefault() { this.defaultPrevented = true; }, ...extra };
}

function harness(relativePath: string, exportName: string, initialProps: Record<string, any>) {
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let effects: (() => void)[] = [];
  let tree: Element;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const listeners = new Map<string, Set<(event: any) => void>>();
  const environment = { dialogOpen: false, textInput: false, connected: true, inert: false, visible: true };
  const hooks = {
    ...React,
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; changed = true; }
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useMemo(factory: () => any, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(callback: (...args: any[]) => any, deps?: unknown[]) {
      return hooks.useMemo(() => callback, deps);
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        const previousCleanup = slots[index]?.cleanup;
        const slot = { deps, cleanup: undefined as undefined | (() => void) };
        slots[index] = slot;
        effects.push(() => { previousCleanup?.(); slot.cleanup = effect() || undefined; });
      }
    },
  };
  const filePath = resolve(relativePath);
  const moduleRequire = createRequire(filePath);
  const source = ts.transpileModule(readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  runInNewContext(source, {
    exports: module.exports, module,
    require(id: string) {
      if (id === 'react') return hooks;
      if (id === './useDialog') return {
        hasActiveDialog: () => environment.dialogOpen,
        isTextInput: () => environment.textInput,
      };
      if (id === './FloatingLines') return { __esModule: true, default: () => null };
      if (/llm|storage|episodeStore/i.test(id)) throw new Error(`Forbidden UI-check dependency: ${id}`);
      return moduleRequire(id);
    },
    Date, Set, Map, Math, Number, String, Boolean, URLSearchParams,
    window: {
      location: { search: '' },
      addEventListener(name: string, listener: (event: any) => void) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      removeEventListener(name: string, listener: (event: any) => void) { listeners.get(name)?.delete(listener); },
    },
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  const props = initialProps;
  const render = () => {
    let passes = 0;
    do {
      changed = false; cursor = 0; effects = [];
      tree = module.exports[exportName](props);
      for (const node of all(tree)) {
        if (node.props.ref && typeof node.props.ref === 'object' && node.props.ref.current === null) {
          node.props.ref.current = {
            get isConnected() { return environment.connected; },
            closest: () => environment.inert ? {} : null,
            getClientRects: () => environment.visible ? [{}] : [],
          };
        }
      }
      effects.forEach((effect) => effect());
      assert.ok(++passes < 20, 'synthetic hooks must settle');
    } while (changed);
    return tree;
  };
  const runNextTimer = () => {
    const pending = timers.entries().next().value as [number, () => void] | undefined;
    if (!pending) return false;
    timers.delete(pending[0]); pending[1](); render(); return true;
  };
  render();
  return {
    props, render, environment, timers,
    get tree() { return tree; },
    runNextTimer,
    runTimers() { let runs = 0; while (runNextTimer()) assert.ok(++runs < 100, 'roll timers must stop'); },
    emitKey(event: any) { listeners.get('keydown')?.forEach((listener) => listener(event)); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function note(id: string, title: string, noteType: NoteItem['noteType'], extra: Partial<NoteItem> = {}): NoteItem {
  return { id, title, noteType, content: `${title} 当前正文`, tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra };
}
const alpha = note('alpha', 'Alpha', 'knowledge');
const beta = note('beta', 'Beta', 'knowledge', { aliases: ['目标别名'] });
const project = note('project', '主项目', 'project', {
  questions: [{ id: 'question', question: '可选问题', answer: '不应提前暴露的标准答案', noteId: 'project', createdAt: '2026-10-01' }],
});
const child = note('child', '子项目', 'project', { parentId: 'project' });
const fixtures = [alpha, beta, project, child];
const entries: any[][] = [];
const hub = harness('src/components/ReviewHub.tsx', 'ReviewHub', {
  allNotes: fixtures,
  launchRequest: { id: 'target-1', scope: 'knowledge', strategy: 'smart', noteTitle: '目标别名' },
  onEnterReview(...args: any[]) { entries.push(args); },
});
assert.equal(textContent(find(byClass(hub.tree, 'review-focus-card'), (node) => node.type === 'h2')), 'Beta', 'requested alias must select its note, not reset to the first candidate');
const selectedCard = byClass(hub.tree, 'review-focus-card');
selectedCard.props.onKeyDown(keyEvent('Enter', { repeat: true }));
selectedCard.props.onKeyDown(keyEvent('Enter', { defaultPrevented: true }));
assert.equal(entries.length, 0, 'handled/repeated keys must not enter review');
assert.equal(textContent(byClass(hub.tree, 'review-knowledge-start')), '开始复习', 'knowledge review exposes an explicit primary action');
selectedCard.props.onClick();
assert.equal(entries[0][0], 'beta');
byClass(hub.tree, 'review-knowledge-start').props.onClick();
selectedCard.props.onKeyDown(keyEvent('Enter'));
assert.equal(entries.length, 1, 'rapid card/button/keyboard activation cannot launch the same review more than once');

tab(hub.tree, '项目复习').props.onClick(); hub.render();
const projectPicker = byClass(hub.tree, 'review-project-tree');
const collapse = find(projectPicker, (node) => node.props['aria-label'] === '收起项目：主项目');
assert.equal(collapse.type, 'button');
assert.equal(collapse.props['aria-expanded'], true);
collapse.props.onClick(); hub.render();
assert.equal(all(byClass(hub.tree, 'review-project-tree')).some((node) => node.type === 'button' && textContent(node) === '子项目'), false);
hub.props.allNotes = fixtures.map((item) => ({ ...item })); hub.render();
assert.equal(tab(hub.tree, '项目复习').props['aria-selected'], true, 'an already consumed launch request must not replay after unrelated note updates');
assert.equal(all(byClass(hub.tree, 'review-project-tree')).some((node) => node.type === 'button' && textContent(node) === '子项目'), false, 'note updates must preserve the user-collapsed project branch');
find(hub.tree, (node) => node.props['aria-label'] === '展开项目：主项目').props.onClick(); hub.render();
assert.equal(textContent(find(byClass(hub.tree, 'review-project-detail-head'), (node) => node.type === 'h2')), '主项目', 'expanding does not select a different project');
byText(hub.tree, 'button', '子项目').props.onClick(); hub.render();
assert.equal(textContent(find(byClass(hub.tree, 'review-project-detail-head'), (node) => node.type === 'h2')), '子项目');
const childRow = all(hub.tree).find((node) => node.props.className?.startsWith('review-project-tree-row') && textContent(node).includes('子项目'))!;
assert.equal(childRow.props.style.paddingLeft, '1.55rem', 'project depth remains visible');
byText(hub.tree, 'button', '主项目').props.onClick(); hub.render();
assert.ok(!textContent(byClass(hub.tree, 'review-project-questions')).includes('不应提前暴露的标准答案'), 'selection cards do not mount their answer text');
byClass(hub.tree, 'review-project-start').props.onClick();
assert.match(entries.at(-1)![2], /自由复述/);
byText(hub.tree, 'button', '可选问题').props.onClick(); hub.render();
assert.equal(byText(hub.tree, 'button', '可选问题').props['aria-pressed'], true);
byClass(hub.tree, 'review-project-start').props.onClick();
assert.match(entries.at(-1)![2], /可选问题/);
assert.ok(!entries.at(-1)![2].includes('自由复述'), 'selected questions replace the generic project opening');
assert.ok(entries.at(-1)![3].includes('用户选中的问题卡'));
hub.props.allNotes = hub.props.allNotes.map((item: NoteItem) => item.id === 'project' ? { ...item, questions: [...item.questions!,
  { id: 'second-question', question: '第二个选中的问题', answer: '第二个隐藏答案', noteId: 'project', createdAt: '2026-10-01' }] } : item); hub.render();
byText(hub.tree, 'button', '第二个选中的问题').props.onClick(); hub.render();
byClass(hub.tree, 'review-project-start').props.onClick();
assert.match(entries.at(-1)![2], /已选 2 个问题，先从第 1 题开始/);
assert.match(entries.at(-1)![2], /可选问题/);
assert.ok(!entries.at(-1)![2].includes('第二个选中的问题'), 'multi-question review opens with one selected question at a time');
assert.ok(entries.at(-1)![3].includes('第二个选中的问题'), 'all selected questions remain available to the later tutor');
assert.ok(!textContent(byClass(hub.tree, 'review-project-questions')).includes('隐藏答案'));
hub.props.allNotes = fixtures.map((item) => item.id === 'project' ? { ...item, title: '主项目已更新', content: '最新项目正文' } : { ...item }); hub.render();
assert.equal(textContent(find(byClass(hub.tree, 'review-project-detail-head'), (node) => node.type === 'h2')), '主项目已更新', 'selected project uses the current note object');
assert.equal(byText(hub.tree, 'button', '可选问题').props['aria-pressed'], true, 'valid question selection survives an unrelated note update');
hub.props.allNotes = hub.props.allNotes.map((item: NoteItem) => item.id === 'project' ? { ...item, questions: [] } : item); hub.render();
assert.equal(textContent(byClass(hub.tree, 'review-project-start')), '开始自由复述', 'removed questions cannot remain counted as selected');
byClass(hub.tree, 'review-project-start').props.onClick();
assert.equal(entries.at(-1)![0], 'project', 'a project without selected questions or linked knowledge remains reviewable');
assert.equal(entries.at(-1)![1], '主项目已更新');
assert.ok(entries.at(-1)![3].includes('项目：主项目已更新'), 'project entry context uses the current project title');

let focusedIndex = -1;
const tabs = [0, 1].map((index) => ({ focus() { focusedIndex = index; } }));
const navigationEvent = keyEvent('ArrowLeft', { currentTarget: { parentElement: { querySelectorAll: () => tabs } } });
tab(hub.tree, '项目复习').props.onKeyDown(navigationEvent); hub.render();
assert.equal(navigationEvent.defaultPrevented, true);
assert.equal(focusedIndex, 0);
assert.equal(tab(hub.tree, '知识点复习').props.tabIndex, 0, 'arrow navigation moves selection and keyboard focus together');
assert.equal(tab(hub.tree, '项目复习').props.tabIndex, -1);

tab(hub.tree, '完全随机').props.onClick(); hub.render();
assert.equal(byClass(hub.tree, 'review-focus-card').props.role, undefined, 'random mode cannot enter before a result is chosen');
const draw = byText(hub.tree, 'button', '开始随机抽取');
draw.props.onClick(); draw.props.onClick(); hub.render();
assert.equal(hub.timers.size, 1, 'double activation schedules only one roll');
assert.equal(byText(hub.tree, 'button', '取消抽取').props.disabled, undefined, 'the running roll exposes one actionable cancel control');
const canceledTick = hub.timers.values().next().value!;
tab(hub.tree, '完全随机').props.onClick(); hub.render();
canceledTick(); hub.render(); hub.runTimers();
assert.ok(!byText(hub.tree, 'button', '开始随机抽取').props.disabled, 'clicking the current strategy cancels rolling instead of leaving a stuck state');
byText(hub.tree, 'button', '开始随机抽取').props.onClick(); hub.render();
byText(hub.tree, 'button', '取消抽取').props.onClick(); hub.render();
assert.equal(hub.timers.size, 0);
assert.equal(byClass(hub.tree, 'review-focus-card').props.role, undefined);
byText(hub.tree, 'button', '开始随机抽取').props.onClick(); hub.render();
const scopeCanceledTick = hub.timers.values().next().value!;
tab(hub.tree, '项目复习').props.onClick(); hub.render();
scopeCanceledTick(); hub.render();
assert.equal(hub.timers.size, 0, 'switching scope invalidates even a queued roll callback');
tab(hub.tree, '知识点复习').props.onClick(); hub.render();
byText(hub.tree, 'button', '开始随机抽取').props.onClick(); hub.render();
const sameSizeOutdatedTick = hub.timers.values().next().value!;
hub.props.allNotes = [alpha, note('gamma', 'Gamma', 'knowledge'), project, child]; hub.render();
sameSizeOutdatedTick(); hub.render(); hub.runTimers();
assert.equal(hub.timers.size, 0, 'replacing a candidate cancels rolling even when pool size is unchanged');
assert.equal(byClass(hub.tree, 'review-focus-card').props.role, undefined);
byText(hub.tree, 'button', '开始随机抽取').props.onClick(); hub.render();
const outdatedTick = hub.timers.values().next().value!;
hub.props.allNotes = [project, child]; hub.render(); outdatedTick(); hub.render(); hub.runTimers();
assert.ok(textContent(hub.tree).includes('还没有可复习的知识点'));
assert.equal(all(hub.tree).some((node) => node.props.className?.includes('review-focus-card')), false, 'removed knowledge cannot be selected by an old timer');
hub.props.allNotes = fixtures; hub.render();
byText(hub.tree, 'button', '开始随机抽取').props.onClick(); hub.render(); hub.runTimers();
assert.equal(byClass(hub.tree, 'review-focus-card').props.role, 'button');
byClass(hub.tree, 'review-focus-card').props.onKeyDown(keyEvent(' '));
assert.ok(['alpha', 'beta'].includes(entries.at(-1)![0]), 'settled random results are enterable by keyboard');
hub.unmount(); assert.equal(hub.timers.size, 0);

const hydrated = harness('src/components/ReviewHub.tsx', 'ReviewHub', {
  allNotes: [], launchRequest: { id: 'hydrated', scope: 'knowledge', strategy: 'weak', noteTitle: 'Beta' },
});
// Weak mode now excludes unassessed notes. Keep the hydration/alias scenario,
// but give its intended target genuine provisional evidence, not a legacy score.
const hydratedBetaMastery = createMasteryShadowState(beta.id);
setMasteryLayerFixture(hydratedBetaMastery, 'concept', 'provisional');
hydrated.props.allNotes = fixtures.map((item) => item.id !== beta.id ? item : {
  ...item, dsrState: { difficulty: 5, stability: 10, lastReviewedAt: null, reviewCount: 1,
    consecutiveCorrect: 0, consecutiveWrong: 0, masteryShadow: hydratedBetaMastery },
});
hydrated.render();
assert.equal(textContent(find(byClass(hydrated.tree, 'review-focus-card'), (node) => node.type === 'h2')), 'Beta', 'a launch request waits for notes to hydrate');
hydrated.props.launchRequest = { id: 'new-target', scope: 'knowledge', strategy: 'smart', noteTitle: 'Alpha' }; hydrated.render();
assert.equal(textContent(find(byClass(hydrated.tree, 'review-focus-card'), (node) => node.type === 'h2')), 'Alpha', 'a new request is located after its strategy changes');
hydrated.unmount();

let exits = 0;
const bubbleEntries: any[][] = [];
const bubble = harness('src/components/ReviewBubbleMode.tsx', 'ReviewBubbleMode', {
  allNotes: fixtures,
  onExit() { exits += 1; }, onBubbleClick(...args: any[]) { bubbleEntries.push(args); },
});
assert.equal(byText(bubble.tree, 'button', '开始复习').props.disabled, true);
byText(bubble.tree, 'button', '开始复习').props.onClick();
assert.equal(bubbleEntries.length, 0, 'a missing choice cannot launch bubble review');
const bubbleDraw = byText(bubble.tree, 'button', '随机抽取');
bubbleDraw.props.onClick(); bubbleDraw.props.onClick(); bubble.render();
assert.equal(bubble.timers.size, 1);
const oldBubbleTick = bubble.timers.values().next().value!;
bubble.props.allNotes = [project]; bubble.render(); oldBubbleTick(); bubble.render(); bubble.runTimers();
assert.equal(bubble.timers.size, 0);
assert.equal(byText(bubble.tree, 'button', '开始复习').props.disabled, true, 'rebuilding the queue cannot revive a removed choice');
assert.ok(textContent(bubble.tree).includes('暂无需要复习的知识点'));
bubble.props.allNotes = fixtures; bubble.render();
byText(bubble.tree, 'button', '随机抽取').props.onClick(); bubble.render();
byText(bubble.tree, 'button', '取消抽取').props.onClick(); bubble.render();
assert.equal(bubble.timers.size, 0);
byText(bubble.tree, 'button', '随机抽取').props.onClick(); bubble.render(); bubble.runTimers();
assert.equal(byText(bubble.tree, 'button', '开始复习').props.disabled, false);
byText(bubble.tree, 'button', '开始复习').props.onClick();
assert.ok(['alpha', 'beta'].includes(bubbleEntries[0][0]));
bubble.environment.dialogOpen = true; bubble.emitKey(keyEvent('Escape'));
bubble.environment.dialogOpen = false; bubble.emitKey(keyEvent('Escape', { defaultPrevented: true }));
bubble.environment.textInput = true; bubble.emitKey(keyEvent('Escape'));
bubble.environment.textInput = false; bubble.environment.inert = true; bubble.emitKey(keyEvent('Escape'));
bubble.environment.inert = false; bubble.environment.visible = false; bubble.emitKey(keyEvent('Escape'));
bubble.environment.visible = true; bubble.environment.connected = false; bubble.emitKey(keyEvent('Escape'));
assert.equal(exits, 0, 'Escape belongs only to the active bubble surface, not a dialog or text input');
bubble.environment.connected = true;
byText(bubble.tree, 'button', '随机抽取').props.onClick(); bubble.render();
const escapedTick = bubble.timers.values().next().value!;
const escapeEvent = keyEvent('Escape'); bubble.emitKey(escapeEvent);
assert.equal(exits, 1); assert.equal(escapeEvent.defaultPrevented, true);
escapedTick(); bubble.render(); assert.equal(bubble.timers.size, 0, 'exit invalidates pending roll callbacks');
byText(bubble.tree, 'button', '随机抽取').props.onClick(); bubble.render(); bubble.unmount();
assert.equal(bubble.timers.size, 0, 'unmount clears roll timers');

console.log('Review hub/bubble UI interaction checks passed (isolated notes, hooks, and timers; no vault writes or LLM calls).');
