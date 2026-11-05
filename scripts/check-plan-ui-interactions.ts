import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import { createPlanWorkspaceDemoNotes } from '../src/services/planDemoFixtures';
import { buildPublishedPlanEditorValue, replacePublishedPlanFromEditor } from '../src/services/publishedPlanEditor';
import { buildExecutionAgendaOccurrences, buildPlanWorkspaceModel, PLAN_OVERVIEW_ID } from '../src/services/planViewModel';
import { homeCalendarDay, homeLocalDate } from '../src/services/homepage/homeTaskScheduling';
import { togglePlanMilestoneCompletion } from '../src/services/planMilestoneState';
import * as planResearch from '../src/services/planResearch';
import type { NoteItem, PlanMeta, PlanNode, PlanTaskBlueprint } from '../src/types';
import type { PlanBuilderDraftValue } from '../src/components/PlanBuilder';

// Invoke the actual component event handlers with isolated hooks and synthetic
// notes. This checks draft interactions without opening a vault or writing data.
type Element = { type: unknown; props: Record<string, any> };
const sameDeps = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

function harness(relativePath: string, exportName: string, initialProps: Record<string, any>, mocks: Record<string, any> = {}) {
  const slots: any[] = [];
  let cursor = 0;
  let changed = false;
  let effects: (() => void)[] = [];
  let tree: Element;
  const dialogs: { open: boolean; close?: () => void; priority: number }[] = [];
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
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { deps, value: callback };
      return slots[index].value;
    },
    useEffect(effect: () => void, deps?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
        slots[index] = { deps };
        effects.push(effect);
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
    exports: module.exports,
    module,
    require(id: string) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === 'react') return { ...hooks, useLayoutEffect: hooks.useEffect };
      if (id === './useDialog') return {
        useDialog(open: boolean, _ref: unknown, close: (() => void) | undefined, priority: number) { dialogs.push({ open, close, priority }); },
        hasActiveDialog: () => false,
        isTextInput: () => false,
      };
      if (id.endsWith('.css')) return {};
      if (id === '../services/llmService') return { callLLM() { throw new Error('The UI check must never call an LLM.'); } };
      return moduleRequire(id);
    },
    Date, Error, Set, Map, Math, Number, String, Boolean, Promise, structuredClone, AbortController, AbortSignal, DOMException,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const props = initialProps;
  const render = () => {
    let passes = 0;
    do {
      changed = false;
      cursor = 0;
      effects = [];
      dialogs.length = 0;
      tree = module.exports[exportName](props);
      effects.forEach((effect) => effect());
      assert.ok(++passes < 12, 'synthetic hooks must settle');
    } while (changed);
    return tree;
  };
  render();
  return { render, dialogs, props, get tree() { return tree; } };
}

function all(element: unknown): Element[] {
  if (Array.isArray(element)) return element.flatMap(all);
  if (!element || typeof element !== 'object' || !('props' in element)) return [];
  const node = element as Element;
  return [node, ...all(node.props.children)];
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
const event = (value?: string) => ({ target: { value }, preventDefault() {}, stopPropagation() {} });

// Actual wizard events: broken optional research does not block clarification,
// changing the goal starts fresh, and an offline draft still requires final save.
{
  let modelCalls = 0, researchCalls = 0, saved = 0;
  let draft: PlanBuilderDraftValue | undefined;
  let savedMeta: Partial<PlanMeta> | undefined;
  const future = (offset: number) => new Date((homeCalendarDay(homeLocalDate())! + offset) * 86400000).toISOString().slice(0, 10);
  const ai = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
    capacitySettings: { learningWeeklyBudgetMinutes: 600 },
    onDraftChange(value: PlanBuilderDraftValue) { draft = value; },
    onBatchCreate(_tree: PlanNode[], meta: Partial<PlanMeta>) { saved++; savedMeta = meta; },
  }, {
    '../services/planResearch': { ...planResearch, preparePlanResearch: (subject: string, signal: AbortSignal) => planResearch.preparePlanResearch(subject, signal, {
      collect: async () => { researchCalls++; throw new Error('synthetic network/invalid evidence failure'); },
    }) },
    '../services/llmService': { callLLM: async (request: any) => {
      modelCalls++;
      assert.match(request.userInput, /未联网核实/);
      if (modelCalls === 1) return { parsedJson: { question: '请说明统计学基础' } };
      if (modelCalls === 2) {
        assert.equal(request.context.planGoal, '线性代数');
        assert.equal(request.messages, undefined, 'old-goal questions must not survive restarting from step 1');
        return { parsedJson: { question: '请说明线性代数基础' } };
      }
      assert.ok(request.messages.some((message: any) => message.content === '请说明线性代数基础'));
      assert.ok(!JSON.stringify(request.messages).includes('请说明统计学基础'));
      return { parsedJson: { rootTitle: '线性代数', planMeta: { summary: '掌握线性代数的关键概念' }, planTree: [{
        key: 'core', title: '核心20%：线性方程组', startDate: future(1), dueDate: future(2), children: [{
          key: 'leaf', title: '理解线性方程组', startDate: future(1), dueDate: future(1), outcome: '独立求解一个线性方程组', children: [],
        }],
      }] } };
    } },
  });
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea').props.onChange(event('统计学')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  assert.match(textContent(byClass(ai.tree, 'plan-ai-dialog')), /请说明统计学基础/);
  assert.match(textContent(byClass(ai.tree, 'plan-ai-dialog')), /联网补充未完成/);
  for (let i = 0; i < 3; i++) { byText(ai.tree, 'button', '上一步').props.onClick(); ai.render(); }
  find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea').props.onChange(event('线性代数')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  assert.doesNotMatch(textContent(byClass(ai.tree, 'plan-ai-dialog')), /请说明统计学基础/);
  const replyField = () => find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'input' && node.props.placeholder === '输入你的回答...');
  replyField().props.onChange(event('已了解基础')); ai.render();
  await replyField().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} });
  // The key handler starts an async request without returning its promise.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  ai.render();
  assert.equal(researchCalls, 2, 'one research attempt per public topic, not per clarification turn');
  assert.equal(modelCalls, 3); assert.equal(saved, 0);
  assert.match(draft!.planMeta.summary!, /^未联网核实/); assert.equal(draft!.planMeta.research, undefined);
  assert.match(textContent(ai.tree), /AI 草稿已导入/);
  assert.match(textContent(ai.tree), /联网补充未完成/);
  byText(ai.tree, 'button', '检查并确认写入').props.onClick(); ai.render();
  await byText(byClass(ai.tree, 'plan-commit-dialog'), 'button', '确认并正式写入').props.onClick(); ai.render();
  assert.equal(saved, 1); assert.match(savedMeta!.summary!, /^未联网核实/); assert.equal(savedMeta!.research, undefined);
  console.log('PASS AI plan wizard: optional network failure -> clarification -> changed goal -> offline draft -> explicit confirmed save; no repeated failed search or stale context.');
}

// Existing completion criteria and wizard expectations share one draft field.
{
  const notes = createPlanWorkspaceDemoNotes('2026-10-06');
  const original = buildPublishedPlanEditorValue(notes, notes.find(note => note.planMeta)!.id)!;
  original.planMeta.conditions = { ...original.planMeta.conditions, goalEvidence: '旧完成证据：通过基础测验' };
  const requests: any[] = [];
  let draft: PlanBuilderDraftValue | undefined;
  const ai = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
    initialValue: original, capacitySettings: { learningWeeklyBudgetMinutes: 600 },
    onDraftChange(value: PlanBuilderDraftValue) { draft = value; },
    onBatchCreate() { assert.fail('a clarification never saves'); },
  }, {
    '../services/planResearch': { ...planResearch, preparePlanResearch: async () => ({ notice: '未联网核实' }) },
    '../services/llmService': { callLLM: async (request: any) => {
      requests.push(request); return { parsedJson: { question: requests.length === 1 ? '旧追问：请补充通过测验所需基础' : '新追问：请说明论文方向' } };
    } },
  });
  const stepField = () => find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea');
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  stepField().props.onChange(event('统计学')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  assert.equal(stepField().props.value, '旧完成证据：通过基础测验', 'the wizard shows the actual saved criterion, not an unrelated empty input');
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  for (let i = 0; i < 2; i++) { byText(ai.tree, 'button', '上一步').props.onClick(); ai.render(); }
  stepField().props.onChange(event('新期望：独立完成研究论文')); ai.render();
  assert.equal(draft!.planMeta.conditions!.goalEvidence, '新期望：独立完成研究论文');
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  assert.equal(requests[1].context.expectedOutcome, '新期望：独立完成研究论文');
  assert.match(requests[1].userInput, /期望效果：新期望：独立完成研究论文/);
  assert.equal(requests[1].messages, undefined);
  assert.doesNotMatch(textContent(byClass(ai.tree, 'plan-ai-dialog')), /旧追问/);
  // Closing generation must not erase an explicitly edited shared plan criterion.
  ai.dialogs.find(dialog => dialog.open && dialog.priority === 55)!.close!(); ai.render();
  assert.equal(draft!.planMeta.conditions!.goalEvidence, '新期望：独立完成研究论文');
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  stepField().props.onChange(event('统计学')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  assert.equal(stepField().props.value, '新期望：独立完成研究论文');
  stepField().props.onChange(event('')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  assert.equal(requests[2].context.expectedOutcome, '未指定', 'explicit clearing cannot restore the original criterion');
  assert.equal(draft!.planMeta.conditions!.goalEvidence, undefined);
  assert.equal(original.planMeta.conditions.goalEvidence, '旧完成证据：通过基础测验', 'draft changes cannot mutate the saved baseline');
  console.log('PASS AI expectation: one shared criterion, fresh context after edits, explicit clearing, retained draft on close, immutable saved baseline.');
}

// A reference-page navigation pauses, rather than discards, the pending answer.
{
  const requests: any[] = [];
  const pending: { resolve: (value: any) => void; signal: AbortSignal }[] = [];
  let mode = 'pending';
  const ai = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
    isActive: true, capacitySettings: { learningWeeklyBudgetMinutes: 600 }, onBatchCreate() { assert.fail('these dialogues never save'); },
  }, {
    '../services/planResearch': { ...planResearch, preparePlanResearch: async () => ({ notice: '未联网核实' }) },
    '../services/llmService': { callLLM: async (request: any, options: any) => {
      requests.push(request);
      if (requests.length === 1 || mode === 'question') return { parsedJson: { question: '请说明当前目标的基础' } };
      if (mode === 'error') throw new Error('合成模型失败');
      if (mode === 'invalid') return { parsedJson: {} };
      return new Promise(resolve => pending.push({ resolve, signal: options.signal })); // Deliberately ignore cancellation.
    } },
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); ai.render(); };
  const field = () => find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'input' && node.props.placeholder === '输入你的回答...');
  const send = (answer: string) => { field().props.onChange(event(answer)); ai.render(); field().props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} }); };
  const pause = () => { ai.props.isActive = false; ai.render(); ai.props.isActive = true; ai.render(); };
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea').props.onChange(event('概率论')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  send('已经掌握集合，想补条件概率'); await flush();
  ai.props.isActive = false; ai.render();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(byText(ai.tree, 'button', '继续生成').props.disabled, true);
  const countBeforeReturn = requests.length;
  ai.props.isActive = true; ai.render();
  assert.equal(requests.length, countBeforeReturn, 'returning never automatically spends another model call');
  assert.equal(field().props.value, '已经掌握集合，想补条件概率');
  field().props.onChange(event('')); ai.render();
  const emptyResume = byText(ai.tree, 'button', '继续生成');
  assert.equal(emptyResume.props.disabled, true);
  await emptyResume.props.onClick();
  assert.equal(requests.length, countBeforeReturn, 'clearing the recovered answer must never send its hidden backup');
  assert.equal(field().props.value, '');
  field().props.onChange(event('已修改：请聚焦条件概率')); ai.render();
  const resumeButton = byText(ai.tree, 'button', '继续生成');
  const resumed = resumeButton.props.onClick(); resumeButton.props.onClick(); await flush();
  assert.equal(requests.length, 3, 'double resume starts only one request');
  assert.ok(requests[2].userInput.startsWith('已修改：请聚焦条件概率'));
  assert.ok(!requests[2].userInput.includes('已经掌握集合，想补条件概率'));
  pending[0].resolve({ parsedJson: { question: '取消请求的迟到追问' } }); await flush();
  assert.ok(all(ai.tree).some(node => node.props['aria-label'] === '正在生成计划草图'), 'a late old response cannot end the resumed loading state');
  assert.doesNotMatch(textContent(ai.tree), /取消请求的迟到追问/);
  pending[1].resolve({ parsedJson: { question: '请解释条件概率的含义' } }); await resumed; ai.render();
  assert.equal(field().props.value, '', 'a successful resume consumes the restored input');
  assert.equal((textContent(byClass(ai.tree, 'plan-ai-dialog')).match(/已修改：请聚焦条件概率/g) || []).length, 1);
  assert.doesNotMatch(textContent(byClass(ai.tree, 'plan-ai-dialog')), /已经掌握集合，想补条件概率/);
  assert.ok(!all(ai.tree).some(node => node.type === 'button' && textContent(node) === '继续生成'));

  mode = 'error'; send('失败时也要保留此回答'); await flush();
  assert.equal(field().props.value, '失败时也要保留此回答');
  assert.match(textContent(byClass(ai.tree, 'plan-ai-dialog')), /合成模型失败/);
  const beforeRetry = requests.length;
  for (const empty of ['', '   ']) {
    field().props.onChange(event(empty)); ai.render();
    const retry = byText(ai.tree, 'button', '重试');
    assert.equal(retry.props.disabled, true);
    await retry.props.onClick();
    assert.equal(requests.length, beforeRetry, 'empty/whitespace retry must not re-send the failed answer');
    assert.equal(field().props.value, empty);
  }
  field().props.onChange(event('修改后的当前回答')); ai.render();
  await byText(ai.tree, 'button', '重试').props.onClick(); ai.render();
  assert.equal(field().props.value, '修改后的当前回答', 'another failure restores the newly edited answer, not the older backup');
  assert.ok(requests.at(-1).userInput.startsWith('修改后的当前回答'));
  mode = 'question'; await byText(ai.tree, 'button', '重试').props.onClick(); ai.render();
  assert.ok(requests.at(-1).userInput.startsWith('修改后的当前回答'));
  assert.ok(!requests.at(-1).userInput.includes('失败时也要保留此回答'));
  assert.equal(field().props.value, '');

  mode = 'invalid'; send('蓝图格式失败也不能丢失此回答'); await flush();
  assert.equal(field().props.value, '蓝图格式失败也不能丢失此回答');
  assert.match(textContent(ai.tree), /模型没有返回可用的计划蓝图/);
  assert.equal(byText(ai.tree, 'button', '重试').props.disabled, false);
  field().props.onChange(event('修改后的蓝图格式重试回答')); ai.render();
  mode = 'question'; await byText(ai.tree, 'button', '重试').props.onClick(); ai.render();
  assert.ok(requests.at(-1).userInput.startsWith('修改后的蓝图格式重试回答'));

  mode = 'pending'; send('改目标前的旧回答'); await flush(); pause();
  for (let i = 0; i < 2; i++) { byText(ai.tree, 'button', '上一步').props.onClick(); ai.render(); }
  find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea').props.onChange(event('新的期望效果')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  mode = 'question'; await byText(ai.tree, 'button', '开始对话').props.onClick(); ai.render();
  assert.equal(requests.at(-1).context.expectedOutcome, '新的期望效果');
  assert.equal(requests.at(-1).messages, undefined);
  assert.ok(!requests.at(-1).userInput.includes('改目标前的旧回答'));
  pending[2].resolve({ parsedJson: { question: '改目标后的迟到旧问答' } }); await flush();
  assert.doesNotMatch(textContent(ai.tree), /改目标后的迟到旧问答/);

  mode = 'pending'; send('主动取消后不应自动恢复'); await flush();
  byText(ai.tree, 'button', '取消生成').props.onClick(); ai.render();
  assert.equal(pending[3].signal.aborted, true);
  pending[3].resolve({ parsedJson: { question: '已取消的旧追问' } }); await flush();
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  assert.ok(!textContent(ai.tree).includes('主动取消后不应自动恢复'));
  assert.ok(!all(ai.tree).some(node => node.type === 'button' && textContent(node) === '继续生成'));
  console.log('PASS AI pause/resume: current edited input only, empty/whitespace sends nothing, repeated failure recovers the edited answer, single resume, stale-result isolation, changed-goal reset and explicit Stop.');
}

// No-answer first attempts can still restart with an empty input, unlike an
// explicitly cleared prior answer. Exercise both initial failure and pause.
for (const interrupt of [false, true]) {
  const requests: any[] = [];
  let release: ((value: any) => void) | undefined;
  const ai = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
    isActive: true, capacitySettings: { learningWeeklyBudgetMinutes: 600 }, onBatchCreate() { assert.fail('these retries never save'); },
  }, {
    '../services/planResearch': { ...planResearch, preparePlanResearch: async () => ({ notice: '未联网核实' }) },
    '../services/llmService': { callLLM: async (request: any) => {
      requests.push(request);
      if (requests.length === 1) {
        if (interrupt) return new Promise(resolve => { release = resolve; });
        throw new Error('首轮合成模型失败');
      }
      return { parsedJson: { question: '恢复后的首轮追问' } };
    } },
  });
  byText(ai.tree, 'button', 'AI 先生成草案').props.onClick(); ai.render();
  find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'textarea').props.onChange(event('首轮概率论')); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  byText(ai.tree, 'button', '下一步').props.onClick(); ai.render();
  const first = byText(ai.tree, 'button', '开始对话').props.onClick();
  for (let i = 0; i < 12; i++) await Promise.resolve(); ai.render();
  if (interrupt) { ai.props.isActive = false; ai.render(); ai.props.isActive = true; ai.render(); }
  else await first;
  ai.render();
  const field = find(byClass(ai.tree, 'plan-ai-dialog'), node => node.type === 'input' && node.props.placeholder === '输入你的回答...');
  assert.equal(field.props.value, '');
  const action = byText(ai.tree, 'button', interrupt ? '继续生成' : '重试');
  assert.equal(action.props.disabled, false, 'no previous answer means an empty input may restart the initial attempt');
  await action.props.onClick(); ai.render();
  assert.equal(requests.length, 2);
  assert.match(requests[1].userInput, /^学习目标：首轮概率论/);
  if (release) { release({ parsedJson: { question: '不能复活的首轮旧追问' } }); await first; ai.render(); }
  assert.match(textContent(ai.tree), /恢复后的首轮追问/);
  assert.doesNotMatch(textContent(ai.tree), /不能复活的首轮旧追问/);
}
console.log('PASS first-attempt recovery: empty initial failure/pause can restart without resurrecting a cancelled request.');

// Exercise the actual controlled input: clearing/retyping must remain visible,
// while incomplete/out-of-range numbers never enter the persisted plan model.
let dailyMinutes = 120;
const minuteWrites: Array<number | undefined> = [];
const minutesInput = harness('src/components/StudyMinutesInput.tsx', 'StudyMinutesInput', {
  value: dailyMinutes,
  onValueChange(value: number | undefined) { minuteWrites.push(value); dailyMinutes = value!; minutesInput.props.value = value; },
});
minutesInput.tree.props.onFocus();
minutesInput.tree.props.onChange(event('')); minutesInput.render();
assert.equal(minutesInput.tree.props.value, '', 'clearing daily minutes stays empty while editing');
assert.equal(dailyMinutes, 120, 'an empty intermediate draft does not overwrite the plan with 5 or 0');
minutesInput.tree.props.onChange(event('1')); minutesInput.render();
assert.equal(minutesInput.tree.props.value, '1', 'a leading digit is not immediately clamped to 5');
assert.equal(dailyMinutes, 120);
minutesInput.tree.props.onChange(event('15')); minutesInput.render();
assert.equal(dailyMinutes, 15); assert.equal(minutesInput.tree.props.value, '15');
minutesInput.tree.props.onChange(event('')); minutesInput.render(); minutesInput.tree.props.onBlur(); minutesInput.render();
assert.equal(minutesInput.tree.props.value, '15', 'leaving a required empty field restores its last valid value');
minutesInput.tree.props.onFocus(); minutesInput.tree.props.onChange(event('9999')); minutesInput.render();
assert.equal(dailyMinutes, 15); assert.equal(minutesInput.tree.props.value, '9999');
minutesInput.tree.props.onBlur(); minutesInput.render();
assert.equal(dailyMinutes, 1440, 'range normalization occurs on blur');
assert.deepEqual(minuteWrites, [15, 1440]);
let inheritedMinutes: number | undefined = 20;
const overrideInput = harness('src/components/StudyMinutesInput.tsx', 'StudyMinutesInput', {
  value: inheritedMinutes, allowEmpty: true,
  onValueChange(value: number | undefined) { inheritedMinutes = value; overrideInput.props.value = value; },
});
overrideInput.tree.props.onFocus(); overrideInput.tree.props.onChange(event('')); overrideInput.render();
overrideInput.tree.props.onBlur(); overrideInput.render();
assert.equal(inheritedMinutes, undefined); assert.equal(overrideInput.tree.props.value, '', 'empty project override keeps inheritance');

let nodes: PlanNode[] = [{
  key: 'parent', title: '父项目', startDate: '2026-10-06', dueDate: '2026-10-20', children: [{
    key: 'child', title: '子项目', startDate: '2026-10-08', dueDate: '2026-10-16', children: [],
  }],
}];
let tasks: PlanTaskBlueprint[] = [{ key: 'execution', text: '合成待办', kind: 'learn', startDate: '2026-10-06', dueDate: '2026-10-20', estimatedMinutes: 30, recurrence: { frequency: 'daily' } }];
let milestoneWrites = 0;
const composer = harness('src/components/PlanDualTrackComposer.tsx', 'PlanDualTrackComposer', {
  nodes, executionTasks: tasks, milestones: [],
  settings: { startDate: '2026-10-06', targetDate: '2026-10-30', weeklyBudgetMinutes: 600, activeWeekdays: [1, 2, 3, 4, 5], preferredSessionMinutes: 30 },
  assessment: { blocking: false, issues: [] },
  onNodesChange(value: PlanNode[]) { nodes = value; composer.props.nodes = value; },
  onExecutionTasksChange(value: PlanTaskBlueprint[]) { tasks = value; composer.props.executionTasks = value; },
  onMilestonesChange() { milestoneWrites += 1; }, onSettingsChange() {},
});
const projectBlock = find(composer.tree, (node) => node.props['data-project-key'] === 'parent');
let stopped = false;
projectBlock.props.onContextMenu({ preventDefault() {}, stopPropagation() { stopped = true; } });
assert.ok(stopped, 'right-clicking a project must not bubble to the milestone insertion target');
const structureRow = byClass(composer.tree, 'dual-structure-row');
structureRow.props.onContextMenu({ target: { closest: () => projectBlock }, preventDefault() {} });
assert.equal(milestoneWrites, 0, 'interactive project targets must never insert milestones');
composer.render();
const projectStart = find(composer.tree, (node) => node.type === 'label' && textContent(node).startsWith('开始'));
find(projectStart, (node) => node.type === 'input').props.onChange(event('2026-10-12'));
assert.equal(nodes[0].startDate, '2026-10-12');
assert.ok(nodes[0].children[0].startDate! >= nodes[0].startDate!, 'editing a parent start clamps descendants');
composer.render();
find(composer.tree, (node) => node.props['data-project-key'] === 'child').props.onClick(event());
composer.render();
find(find(composer.tree, (node) => node.type === 'label' && textContent(node).startsWith('开始')), (node) => node.type === 'input').props.onChange(event('2026-10-01'));
assert.equal(nodes[0].children[0].startDate, '2026-10-12', 'editing a child start respects the parent boundary');
composer.render();
find(find(composer.tree, (node) => node.type === 'label' && textContent(node).startsWith('开始')), (node) => node.type === 'input').props.onChange(event(''));
assert.equal(nodes[0].children[0].startDate, '2026-10-12', 'clearing a date cannot corrupt the scheduled window');
composer.render();
find(composer.tree, (node) => node.props['data-execution-key'] === 'execution').props.onClick(event());
composer.render();
const executionEndInput = () => find(find(composer.tree, (node) => node.type === 'label' && textContent(node) === '结束'), (node) => node.type === 'input');
assert.equal(executionEndInput().props.value, '', 'an indefinite repeat does not pretend that its first occurrence is its end');
executionEndInput().props.onChange(event('2026-10-18'));
composer.render();
assert.equal(tasks[0].recurrence!.endDate, '2026-10-18', 'the real recurrence boundary follows the end-date input');
assert.equal(tasks[0].dueDate, '2026-10-18');
executionEndInput().props.onChange(event(''));
composer.render();
assert.equal(tasks[0].recurrence!.endDate, undefined, 'clearing the boundary explicitly restores indefinite repetition');
assert.equal(tasks[0].startDate, '2026-10-06');
assert.equal(tasks[0].dueDate, '2026-10-06', 'clearing a recurring end leaves a valid first occurrence');
find(find(composer.tree, (node) => node.type === 'label' && textContent(node).startsWith('重复规则')), (node) => node.type === 'select').props.onChange(event('custom'));
assert.equal(tasks[0].recurrence!.frequency, 'custom');
assert.deepEqual(Array.from(tasks[0].recurrence!.weekdays!), [2], 'custom rules explicitly initialize their starting weekday');
composer.render();
find(composer.tree, (node) => node.props['aria-label'] === '每周四').props.onClick();
assert.deepEqual(Array.from(tasks[0].recurrence!.weekdays!), [2, 4]);
composer.render();
find(composer.tree, (node) => node.props['aria-label'] === '每周二').props.onClick();
composer.render();
find(composer.tree, (node) => node.props['aria-label'] === '每周四').props.onClick();
assert.deepEqual(Array.from(tasks[0].recurrence!.weekdays!), [4], 'the final repeating weekday cannot be removed');

// Completing structural work must not hide later manual acceptance checkpoints.
const checkpointProject = (id: string, title: string, parentId?: string): NoteItem => ({ id, title, parentId,
  noteType: 'project', content: '', tags: [], links: [], backlinks: [], createdAt: '2026-10-30', updatedAt: '2026-10-30',
  dueDates: [{ id: `due-${id}-0`, noteId: id, noteTitle: title, taskText: title, startDate: '2026-10-24', dueDate: '2026-10-30', completed: true, priority: 'medium' }],
});
let checkpointNotes: NoteItem[] = [{ ...checkpointProject('checkpoint-root', '八阶段计划'), planMeta: {
  schemaVersion: 2, status: 'completed', startDate: '2026-10-24', targetDate: '2026-10-30',
  milestones: Array.from({ length: 8 }, (_, index) => ({ id: `checkpoint-${index + 1}`, title: `阶段${index + 1}验收`, dueDate: '2026-10-30', completed: index < 6 })),
} }, checkpointProject('checkpoint-leaf', '已完成章节', 'checkpoint-root')];
const checkpoints = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  notes: checkpointNotes, initialPlanId: 'checkpoint-root', onToggleTaskCompleted() {}, onToggleProjectCompleted() {},
  onSelectNoteByTitle() {}, onOpenPlanBuilder() {}, onOpenPlanEditor() {}, onRequestPlanAdjustment() {},
  onToggleMilestoneCompleted(rootId: string, id: string, completed: boolean) {
    if (checkpointNotes.find(note => note.id === rootId)?.planMeta?.milestones?.find(item => item.id === id)?.completed !== completed) {
      checkpointNotes = togglePlanMilestoneCompletion(checkpointNotes, rootId, id, '2026-10-30T02:00:00Z');
    }
    checkpoints.props.notes = checkpointNotes;
  },
});
const checkpointSequence = () => textContent(byClass(checkpoints.tree, 'plan-milestone-sequence'));
const checkpointLanes = () => all(checkpoints.tree).filter(node => (node.type as any)?.name === 'StructureTimelineLane');
assert(checkpointSequence().includes('阶段7验收') && checkpointSequence().includes('阶段8验收'));
assert(!checkpointSequence().includes('阶段1验收'), 'completed early checkpoints yield the summary to pending later checkpoints');
assert.equal(checkpointLanes().length, 1, 'a completed structure retains its track while acceptance is pending');
find(byClass(checkpoints.tree, 'plan-milestone-sequence'), node => node.type === 'button' && textContent(node).includes('阶段7验收')).props.onClick();
checkpoints.render();
await byText(checkpoints.tree, 'button', '确认完成').props.onClick(); checkpoints.render();
assert.equal(checkpointNotes[0].planMeta!.milestones![6].completed, true);
assert(!checkpointSequence().includes('阶段7验收') && checkpointSequence().includes('阶段8验收'), 'the visible summary advances after acceptance');
find(checkpoints.tree, node => node.props['aria-label'] === '关闭里程碑详情').props.onClick(); checkpoints.render();
find(checkpoints.tree, node => node.props['aria-label'] === '查看下一个里程碑：阶段8验收').props.onClick(); checkpoints.render();
await byText(checkpoints.tree, 'button', '确认完成').props.onClick(); checkpoints.render();
assert.equal(checkpointLanes().length, 0, 'the completed track retires only after every checkpoint is accepted');
find(checkpoints.tree, node => node.props['aria-label'] === '关闭里程碑详情').props.onClick(); checkpoints.render();
byText(checkpoints.tree, 'button', '查看全部（8）').props.onClick(); checkpoints.render();
const checkpointArticles = () => all(checkpoints.tree).filter(node => node.type === 'article' && node.props.className?.includes('plan-milestone-detail'));
assert.equal(checkpointArticles().length, 8, 'all completed checkpoints remain reachable as history');
await byText(checkpointArticles().find(article => textContent(article).includes('阶段7验收'))!, 'button', '标记为未完成').props.onClick(); checkpoints.render();
assert.equal(checkpointNotes[0].planMeta!.milestones![6].completed, false);
assert(checkpointSequence().includes('阶段7验收'));
assert.equal(checkpointLanes().length, 1, 'reopening an acceptance checkpoint restores its summary and timeline entry');

const demoNotes = createPlanWorkspaceDemoNotes('2026-10-06');
let resolveSave: (result: boolean) => void = () => {};
let saveCalls = 0;
let capturedInput: any;
const workspace = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  notes: demoNotes, initialPlanId: demoNotes.find((note) => note.planMeta)?.id,
  onToggleTaskCompleted() {}, onToggleProjectCompleted() {}, onToggleMilestoneCompleted() {}, onSelectNoteByTitle() {},
  onOpenPlanBuilder() {}, onOpenPlanEditor() {}, onRequestPlanAdjustment() {},
  onAddStructureItem: async () => true,
  onAddTask(input: any) {
    saveCalls += 1; capturedInput = input;
    return new Promise<boolean>((resolveValue) => { resolveSave = resolveValue; });
  },
});
byText(workspace.tree, 'button', '添加任务').props.onClick();
workspace.render();
let drawer = byClass(workspace.tree, 'plan-add-drawer');
assert.equal(drawer.props.role, 'dialog');
assert.equal(drawer.props['aria-modal'], 'true');
assert.ok(workspace.dialogs.some((dialog) => dialog.open && dialog.priority === 50 && dialog.close), 'add drawer owns keyboard focus');
find(workspace.tree, (node) => node.props.role === 'radio' && textContent(node).startsWith('执行事项')).props.onClick();
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
assert.equal(find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('所属项目')), (node) => node.type === 'select').props.value,
  workspace.props.initialPlanId, 'an independent task defaults to the selected root, not an arbitrary completed leaf');
assert.ok(all(drawer).some((node) => node.type === 'button' && node.props['aria-label'] === '60 分钟' && node.props['aria-pressed'] === true));
for (const minutes of [5, 10, 15]) assert.ok(all(drawer).some(node => node.props['aria-label'] === `${minutes} 分钟`), 'short review durations are reachable');
find(drawer, node => node.props['aria-label'] === '5 分钟').props.onClick();
workspace.render(); drawer = byClass(workspace.tree, 'plan-add-drawer');
find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('任务名称')), (node) => node.type === 'input').props.onChange(event('保留这条输入'));
find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('重复规则')), (node) => node.type === 'select').props.onChange(event('custom'));
workspace.render();
assert.ok(all(workspace.tree).some((node) => node.type === 'label' && textContent(node).startsWith('首次日期')));
find(workspace.tree, (node) => node.props['aria-label'] === '每周四').props.onClick();
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
const pendingSave = drawer.props.onSubmit(event());
drawer.props.onSubmit(event());
assert.equal(saveCalls, 1, 'double-submit must make only one write request');
assert.equal(capturedInput.estimatedMinutes, 5, 'a 5-minute review reaches the save callback unchanged');
assert.ok(capturedInput.recurrenceWeekdays.includes(4), 'selected repeating days travel with the write request');
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
assert.equal(drawer.props['aria-busy'], true);
assert.equal(byClass(drawer, 'plan-add-fields').props.disabled, true);
assert.ok(workspace.dialogs.some((dialog) => dialog.open && !dialog.close), 'Escape cannot dismiss a pending write');
byClass(workspace.tree, 'plan-drawer-backdrop').props.onMouseDown();
workspace.render();
assert.ok(all(workspace.tree).some((node) => node.props.className?.includes('plan-add-drawer')), 'backdrop cannot dismiss a pending write');
resolveSave(false);
await pendingSave;
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
assert.equal(drawer.props['aria-busy'], false);
assert.ok(textContent(find(drawer, (node) => node.props.role === 'alert')).includes('未保存成功'));
assert.equal(find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('任务名称')), (node) => node.type === 'input').props.value, '保留这条输入');
const retry = drawer.props.onSubmit(event());
assert.equal(saveCalls, 2);
resolveSave(true);
await retry;
workspace.render();
assert.ok(!all(workspace.tree).some((node) => node.props.className?.includes('plan-add-drawer')), 'successful save closes the drawer');
byText(workspace.tree, 'button', '添加任务').props.onClick();
workspace.render();
find(workspace.tree, (node) => node.props.role === 'radio' && textContent(node).startsWith('新建结构项目')).props.onClick();
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('项目名称')), (node) => node.type === 'input').props.onChange(event('保留结构输入'));
workspace.props.onAddStructureItem = async () => { throw new Error('合成保存失败'); };
workspace.render();
await byClass(workspace.tree, 'plan-add-drawer').props.onSubmit(event());
workspace.render();
drawer = byClass(workspace.tree, 'plan-add-drawer');
assert.equal(textContent(find(drawer, (node) => node.props.role === 'alert')), '合成保存失败');
assert.equal(find(find(drawer, (node) => node.type === 'label' && textContent(node).startsWith('项目名称')), (node) => node.type === 'input').props.value, '保留结构输入');
workspace.props.onAddStructureItem = async () => true;
workspace.render();
await byClass(workspace.tree, 'plan-add-drawer').props.onSubmit(event());
workspace.render();
assert.ok(!all(workspace.tree).some((node) => node.props.className?.includes('plan-add-drawer')), 'a structure write can retry after a rejected promise');
byText(workspace.tree, 'button', '调整计划').props.onClick();
workspace.render();
assert.equal(byClass(workspace.tree, 'plan-adjust-drawer').props.role, 'dialog');
const adjustDialog = workspace.dialogs.find((dialog) => dialog.open);
assert.ok(adjustDialog?.close);
adjustDialog.close();
workspace.render();
assert.ok(!all(workspace.tree).some((node) => node.props.className?.includes('plan-adjust-drawer')), 'Escape closes the adjustment drawer');

const initialEditorValue = buildPublishedPlanEditorValue(demoNotes, demoNotes.find((note) => note.planMeta)!.id)!;
assert.ok(initialEditorValue, 'the synthetic published plan must have an editable snapshot');
let commitCalls = 0;
let rejectCommit: (reason: Error) => void = () => {};
let resolveCommit: () => void = () => {};
let capturedBaseline: unknown;
let capturedTree: PlanNode[] = [];
const builder = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
  initialValue: initialEditorValue,
  onBatchCreate() { throw new Error('editing a published plan must use the update callback'); },
  onBatchUpdate(_rootId: string, tree: PlanNode[], _meta: unknown, baseline: unknown) {
    commitCalls += 1;
    capturedTree = tree;
    capturedBaseline = baseline;
    return new Promise<void>((resolveValue, rejectValue) => {
      resolveCommit = resolveValue;
      rejectCommit = rejectValue;
    });
  },
});
const titleInput = () => find(builder.tree, (node) => node.type === 'input' && node.props.type === 'text' && node.props.placeholder?.includes('一级目标'));
titleInput().props.onChange(event('失败后保留的计划草图'));
builder.render();

const conditionsButton = byText(builder.tree, 'button', '调整条件');
assert.equal(conditionsButton.props['aria-expanded'], false);
conditionsButton.props.onClick();
builder.render();
const conditionsDialog = byClass(builder.tree, 'plan-condition-panel');
assert.equal(conditionsDialog.props.role, 'dialog');
assert.equal(conditionsDialog.props['aria-modal'], 'true');
assert.equal(conditionsDialog.props['aria-label'], '计划条件');
assert.ok(all(conditionsDialog).some((node) => node.props.className === 'plan-weekday-picker'), 'advanced learning days remain reachable');
assert.ok(all(conditionsDialog).some((node) => node.props['aria-label'] === '截止日期性质'), 'hard/flexible deadline controls remain reachable');
assert.ok(builder.dialogs.some((dialog) => dialog.open && dialog.priority === 50 && dialog.close), 'advanced conditions register keyboard ownership');
builder.dialogs.find((dialog) => dialog.open && dialog.priority === 50)!.close!();
builder.render();
assert.ok(!all(builder.tree).some((node) => node.props.className?.includes('plan-condition-panel')), 'Escape closes advanced conditions');

// The current notes may be refreshed while a draft stays open. Publishing must
// compare against the snapshot the draft was started from, never the refresh.
builder.props.initialValue = {
  ...structuredClone(initialEditorValue),
  tree: [{ ...structuredClone(initialEditorValue.tree[0]), title: '外部更新的计划标题' }],
};
builder.render();
assert.equal(titleInput().props.value, '失败后保留的计划草图', 'a notes refresh must not replace the working draft');
byText(builder.tree, 'button', '检查并确认覆盖').props.onClick();
builder.render();
let commitDialog = byClass(builder.tree, 'plan-commit-dialog');
assert.equal(commitDialog.props.role, 'dialog');
assert.ok(builder.dialogs.some((dialog) => dialog.open && dialog.priority === 60 && dialog.close), 'final review is the keyboard owner above advanced conditions');
const commitButton = byText(commitDialog, 'button', '确认覆盖当前计划');
const waitingCommit = commitButton.props.onClick();
commitButton.props.onClick();
assert.equal(commitCalls, 1, 'double confirmation must make only one publish request');
assert.equal(capturedBaseline, initialEditorValue, 'onBatchUpdate receives the snapshot frozen at initial mount');
assert.notEqual(capturedBaseline, builder.props.initialValue, 'a refreshed prop cannot become the publication baseline');
assert.equal(capturedTree[0].title, '失败后保留的计划草图');
builder.render();
commitDialog = byClass(builder.tree, 'plan-commit-dialog');
assert.equal(commitDialog.props['aria-busy'], true, 'the confirm dialog stays mounted and pending');
assert.equal(find(commitDialog, (node) => node.props['aria-label'] === '关闭确认窗口').props.disabled, true, 'close is disabled during publication');
assert.equal(byText(commitDialog, 'button', '返回继续调整').props.disabled, true, 'back is disabled during publication');
assert.equal(byText(commitDialog, 'button', '正在保存…').props.disabled, true, 'submit is disabled during publication');
assert.ok(builder.dialogs.some((dialog) => dialog.open && dialog.priority === 60 && !dialog.close), 'Escape cannot dismiss a pending publication');
byClass(builder.tree, 'plan-commit-backdrop').props.onMouseDown();
builder.render();
assert.ok(all(builder.tree).some((node) => node.props.className === 'plan-commit-dialog'), 'backdrop cannot dismiss a pending publication');
rejectCommit(new Error('合成发布失败，请重试'));
await waitingCommit;
builder.render();
commitDialog = byClass(builder.tree, 'plan-commit-dialog');
assert.equal(commitDialog.props['aria-busy'], false);
assert.equal(textContent(find(commitDialog, (node) => node.props.role === 'alert')), '合成发布失败，请重试');
assert.equal(titleInput().props.value, '失败后保留的计划草图', 'a failed publication preserves the working title');
const retryCommit = byText(commitDialog, 'button', '重试保存');
assert.equal(retryCommit.props.disabled, false);
const retriedCommit = retryCommit.props.onClick();
assert.equal(commitCalls, 2, 'a failed publication can be retried');
assert.equal(capturedBaseline, initialEditorValue, 'retry still uses the original publication baseline');
builder.render();
resolveCommit();
await retriedCommit;
builder.render();
assert.ok(!all(builder.tree).some((node) => node.props.className === 'plan-commit-dialog'), 'successful publication closes the review dialog');

// Clearing an existing root target must survive both recoverable drafts and
// the actual published-plan mutation, including a JSON save/reload round trip.
let dateDraft: PlanBuilderDraftValue | undefined;
let dateSubmission: { tree: PlanNode[]; meta: Partial<PlanMeta> } | undefined;
const dateBuilder = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
  initialValue: structuredClone(initialEditorValue),
  onBatchCreate() { throw new Error('a published plan must use the update callback'); },
  onDraftChange(value: PlanBuilderDraftValue) { dateDraft = value; },
  onBatchUpdate(_rootId: string, tree: PlanNode[], meta: Partial<PlanMeta>) { dateSubmission = { tree, meta }; },
});
assert.ok(initialEditorValue.planMeta.targetDate, 'fixture starts with an existing target');
byText(dateBuilder.tree, 'button', '调整条件').props.onClick(); dateBuilder.render();
const targetLabel = () => find(byClass(dateBuilder.tree, 'plan-condition-panel'), node => node.type === 'label' && textContent(node).startsWith('目标日期'));
find(targetLabel(), node => node.type === 'input').props.onChange(event('')); dateBuilder.render();
assert.equal(find(targetLabel(), node => node.type === 'input').props.value, '');
assert.equal(dateDraft!.tree[0].dueDate, undefined, 'recoverable tree no longer contains the old root deadline');
assert.equal(dateDraft!.planMeta.targetDate, undefined, 'recoverable metadata no longer restores the old target');
const reloadedDraft = JSON.parse(JSON.stringify(dateDraft)) as PlanBuilderDraftValue;
const restoredDateBuilder = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
  draftValue: reloadedDraft, onBatchCreate() {},
});
byText(restoredDateBuilder.tree, 'button', '调整条件').props.onClick(); restoredDateBuilder.render();
const restoredTarget = find(byClass(restoredDateBuilder.tree, 'plan-condition-panel'), node => node.type === 'label' && textContent(node).startsWith('目标日期'));
assert.equal(find(restoredTarget, node => node.type === 'input').props.value, '', 'reopening a recovered draft preserves the cleared target');
dateBuilder.dialogs.find(dialog => dialog.open && dialog.priority === 50)!.close!(); dateBuilder.render();
byText(dateBuilder.tree, 'button', '检查并确认覆盖').props.onClick(); dateBuilder.render();
assert.match(textContent(byClass(dateBuilder.tree, 'plan-commit-dialog')), /弹性结束/);
await byText(byClass(dateBuilder.tree, 'plan-commit-dialog'), 'button', '确认覆盖当前计划').props.onClick();
assert.equal(dateSubmission!.meta.targetDate, undefined, 'submission must not fall back to generated or initial metadata');
const noTargetNotes = replacePublishedPlanFromEditor(demoNotes, initialEditorValue.rootId, dateSubmission!.tree, dateSubmission!.meta).notes;
const noTargetReload = buildPublishedPlanEditorValue(JSON.parse(JSON.stringify(noTargetNotes)), initialEditorValue.rootId)!;
assert.equal(noTargetReload.planMeta.targetDate, undefined, 'the durable metadata clears the existing target');
assert.equal(noTargetReload.tree[0].dueDate, undefined, 'reloading the actual mutation cannot revive the old root deadline');
assert.equal(initialEditorValue.planMeta.targetDate, buildPublishedPlanEditorValue(demoNotes, initialEditorValue.rootId)!.planMeta.targetDate, 'the source fixture is not mutated');

// Completion controls exercise the actual workspace handlers, including same-frame duplicate clicks.
let completionCalls = 0, rejectCompletion!: (error: Error) => void, resolveCompletion!: () => void;
const completionArgs: unknown[][] = [];
const completionWorkspace = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  ...workspace.props,
  onToggleProjectCompleted(...args: unknown[]) {
    completionCalls++; completionArgs.push(args);
    return new Promise<void>((yes, no) => { resolveCompletion = yes; rejectCompletion = no; });
  },
});
byText(completionWorkspace.tree, 'button', '列表').props.onClick(); completionWorkspace.render();
const projectCheck = find(completionWorkspace.tree, node => node.type === 'button' && node.props.className?.includes('plan-task-check'));
const completionPending = projectCheck.props.onClick();
projectCheck.props.onClick();
assert.equal(completionCalls, 1, 'same-frame completion clicks must coalesce');
completionWorkspace.render();
assert.match(textContent(find(completionWorkspace.tree, node => node.props.role === 'status')), /正在保存状态/);
assert.ok(all(completionWorkspace.tree).filter(node => node.type === 'button' && node.props.className?.includes('plan-task-check')).every(node => node.props.disabled));
assert.ok(completionWorkspace.props.notes.every((note: any, index: number) => note === demoNotes[index]), 'UI waiting does not mutate notes');
rejectCompletion(new Error('sensitive synthetic disk path'));
await completionPending; completionWorkspace.render();
const completionError = find(completionWorkspace.tree, node => node.props.role === 'alert');
assert.match(textContent(completionError), /状态未保存，请重试/);
assert.doesNotMatch(textContent(completionError), /sensitive/);
const desired = completionArgs[0];
const retryCompletion = find(completionWorkspace.tree, node => node.props['aria-label'] === '重试保存任务状态');
const completionRetried = retryCompletion.props.onClick();
await Promise.resolve();
assert.equal(completionCalls, 2);
assert.deepEqual(completionArgs[1], desired, 'retry retains the requested completion rather than reading a later toggle');
resolveCompletion(); await completionRetried; await Promise.resolve(); completionWorkspace.render();
assert.ok(!all(completionWorkspace.tree).some(node => node.props.className === 'plan-completion-feedback'));
const completedPhaseNotes = demoNotes.map(note => ({ ...note, dueDates: note.dueDates.map(item => ({
  ...item, completed: true, completedOccurrenceDates: [new Date().toLocaleDateString('sv-SE')],
})) }));
const completedPhaseWorkspace = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  ...workspace.props, notes: completedPhaseNotes,
});
const completedPhase = byClass(completedPhaseWorkspace.tree, 'plan-current-phase');
assert.match(textContent(completedPhase), /已完成/);
assert.doesNotMatch(textContent(completedPhase), /进行中/);
assert.equal(find(completedPhase, node => node.props.role === 'progressbar').props['aria-valuenow'], 100);
const completedOverviewWorkspace = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  ...workspace.props, notes: completedPhaseNotes, initialPlanId: PLAN_OVERVIEW_ID,
});
assert.match(textContent(byClass(completedOverviewWorkspace.tree, 'plan-phase-carousel-panel')), /已完成/);
const calendarToday = homeLocalDate();
const calendarDate = (offset: number) => new Date((homeCalendarDay(calendarToday)! + offset) * 86_400_000).toISOString().slice(0, 10);
const calendarRoot: NoteItem = { id: 'ui-calendar-root', title: '周期学习计划', noteType: 'project', content: '', tags: [], links: [], backlinks: [],
  createdAt: calendarToday, updatedAt: calendarToday, planMeta: { schemaVersion: 2, status: 'active', startDate: calendarDate(-10), targetDate: calendarDate(10), weeklyBudgetMinutes: 300 },
  dueDates: [{ id: 'daily-ui', noteId: 'ui-calendar-root', noteTitle: '周期学习计划', taskText: '每天计算一题', priority: 'medium', completed: false,
    startDate: calendarDate(-10), dueDate: calendarDate(10), kind: 'practice', estimatedMinutes: 20,
    recurrence: { frequency: 'daily', endDate: calendarDate(10) }, completedOccurrenceDates: [calendarToday] }],
};
const calendarArgs: unknown[][] = [];
const calendarWorkspace = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
  ...workspace.props, notes: [calendarRoot], initialPlanId: calendarRoot.id,
  capacitySettings: { learningWeeklyBudgetMinutes: 300 },
  onToggleTaskCompleted(...args: unknown[]) { calendarArgs.push(args); },
});
const calendarModel = buildPlanWorkspaceModel([calendarRoot], calendarRoot.id, calendarToday);
const calendarWeek = calendarModel.weeks.find(week => week.startDate <= calendarToday && week.endDate >= calendarToday)!;
const calendarAgenda = buildExecutionAgendaOccurrences(calendarModel.tasks, calendarWeek.startDate, calendarWeek.endDate, calendarToday);
assert.equal(calendarAgenda.length, 7);
assert.match(textContent(byClass(calendarWorkspace.tree, 'plan-week-load')), /140\s*\/\s*300/);
const calendarChecks = all(calendarWorkspace.tree).filter(node => node.props.task?.id === 'daily-ui');
assert.equal(calendarChecks.length, 7, 'actual agenda renders each occurrence, not one rule copy');
assert.ok(calendarChecks.filter(node => node.props.task.occurrenceDate > calendarToday).every(node => node.props.disabled), 'future occurrence checks are disabled');
const currentCalendarCheck = calendarChecks.find(node => node.props.task.occurrenceDate === calendarToday)!;
assert.equal(currentCalendarCheck.props.task.completed, true);
await currentCalendarCheck.props.onToggle(); calendarWorkspace.render();
assert.deepEqual(calendarArgs, [[calendarRoot.id, 'daily-ui', calendarToday, false]], 'undo binds the exact displayed date and explicit desired state');
const calendarTimelineBar = find(calendarWorkspace.tree, node => node.type === 'button' && node.props.className?.includes('plan-task-bar'));
assert.ok(!calendarTimelineBar.props.className.includes('is-complete'), 'one completed day cannot dim the entire recurring timeline rule');
byText(calendarWorkspace.tree, 'button', '周视图').props.onClick(); calendarWorkspace.render();
const calendarWeekBoard = byClass(calendarWorkspace.tree, 'plan-week-board');
assert.equal(all(calendarWeekBoard).filter(node => node.type === 'button' && textContent(node).includes('每天计算一题')).length, 7, 'actual week view matches the agenda');
assert.equal(all(calendarWeekBoard).filter(node => node.type === 'button' && node.props.className?.includes('is-complete')).length, 1, 'today completion does not leak into another day');
// The overview selection belongs to a root identity, never its sorted position.
const phaseRootA: NoteItem = { ...calendarRoot, id: 'phase-a', title: '概率论计划', dueDates: [], updatedAt: `${calendarToday}T10:00:00Z` };
const phaseRootB: NoteItem = { ...calendarRoot, id: 'phase-b', title: '认知学习计划', dueDates: [], updatedAt: `${calendarToday}T09:00:00Z` };
const phaseLeaf = (root: NoteItem): NoteItem => ({ ...root, id: `leaf-${root.id}`, title: `${root.title}的当前任务`, parentId: root.id, planMeta: undefined,
  dueDates: [{ id: `deadline-${root.id}`, noteId: `leaf-${root.id}`, noteTitle: `${root.title}的当前任务`, taskText: `${root.title}的当前任务`,
    startDate: calendarToday, dueDate: calendarDate(10), completed: false, priority: 'medium' }] });
const overviewNotes = [phaseRootA, phaseRootB, phaseLeaf(phaseRootA), phaseLeaf(phaseRootB)];
const phaseOverview = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', { ...workspace.props, notes: overviewNotes, initialPlanId: PLAN_OVERVIEW_ID });
const phaseTab = (title: string) => find(phaseOverview.tree, node => node.props.role === 'tab' && textContent(node) === title);
phaseTab(phaseRootB.title).props.onClick(); phaseOverview.render();
assert.match(textContent(byClass(phaseOverview.tree, 'plan-phase-carousel-panel')), /认知学习计划的当前任务/);
phaseOverview.props.notes = overviewNotes.map(note => note.id === phaseRootB.id ? { ...note, updatedAt: `${calendarDate(1)}T00:00:00Z` } : note);
phaseOverview.render();
assert.match(textContent(byClass(phaseOverview.tree, 'plan-phase-carousel-panel')), /认知学习计划的当前任务/, 'saving a root and reordering it must not silently select another root');
const overviewTabs = () => all(phaseOverview.tree).filter(node => node.props.role === 'tab');
assert.equal(overviewTabs().filter(node => node.props.tabIndex === 0).length, 1, 'tab enters the active root once, not every root');
assert.equal(phaseTab(phaseRootB.title).props['aria-selected'], true);
assert.equal(byClass(phaseOverview.tree, 'plan-phase-carousel-panel').props['aria-labelledby'], phaseTab(phaseRootB.title).props.id);
let focusedRoot = '', prevented = 0;
const phaseStrip = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 280 }) };
for (const tab of overviewTabs()) {
  const left = textContent(tab) === phaseRootB.title ? 0 : 108;
  tab.props.ref({ focus() { focusedRoot = textContent(tab); }, parentElement: phaseStrip,
    getBoundingClientRect: () => ({ left: left - phaseStrip.scrollLeft, right: left + 192 - phaseStrip.scrollLeft }),
    scrollIntoView() { throw new Error('root tabs must not scroll their containing main panel'); } });
}
const phaseKey = (title: string, key: string, modifiers = {}) => {
  phaseTab(title).props.onKeyDown({ key, ...modifiers, preventDefault() { prevented++; } }); phaseOverview.render();
};
phaseKey(phaseRootB.title, 'ArrowRight');
assert.equal(focusedRoot, phaseRootA.title);
assert.equal(phaseStrip.scrollLeft, 20, 'only the label strip scrolls to reveal an overflowing tab');
assert.equal(phaseTab(phaseRootA.title).props['aria-selected'], true);
phaseKey(phaseRootA.title, 'ArrowRight');
assert.equal(focusedRoot, phaseRootB.title, 'keyboard wraps to the first root');
assert.equal(phaseStrip.scrollLeft, 0, 'returning to the first tab restores its label without scrolling the page');
phaseKey(phaseRootB.title, 'ArrowLeft');
assert.equal(focusedRoot, phaseRootA.title, 'keyboard wraps to the last root');
phaseKey(phaseRootA.title, 'Home');
assert.equal(focusedRoot, phaseRootB.title);
phaseKey(phaseRootB.title, 'End');
assert.equal(focusedRoot, phaseRootA.title);
const handledPhaseKeys = prevented;
phaseKey(phaseRootA.title, 'ArrowRight', { ctrlKey: true });
phaseKey(phaseRootA.title, 'Escape');
assert.equal(prevented, handledPhaseKeys, 'tabs do not capture modified shortcuts or unrelated keys');
assert.equal(phaseTab(phaseRootA.title).props['aria-selected'], true);
find(phaseOverview.tree, node => node.props['aria-label'] === '下一个根项目').props.onClick(); phaseOverview.render();
assert.equal(phaseTab(phaseRootB.title).props['aria-selected'], true);
assert.equal(focusedRoot, phaseRootA.title, 'pointer arrows do not move keyboard focus into a tab');
find(phaseOverview.tree, node => node.props['aria-label'] === '上一个根项目').props.onClick(); phaseOverview.render();
assert.equal(phaseTab(phaseRootA.title).props['aria-selected'], true);
const defaultPhaseOverview = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', { ...workspace.props, notes: overviewNotes, initialPlanId: PLAN_OVERVIEW_ID });
defaultPhaseOverview.props.notes = phaseOverview.props.notes; defaultPhaseOverview.render();
assert.match(textContent(byClass(defaultPhaseOverview.tree, 'plan-phase-carousel-panel')), /概率论计划的当前任务/, 'the default selection is also anchored before any manual choice');
phaseOverview.props.initialPlanId = phaseRootB.id; phaseOverview.render();
phaseOverview.props.initialPlanId = PLAN_OVERVIEW_ID; phaseOverview.render();
assert.equal(phaseTab(phaseRootA.title).props['aria-selected'], true, 'returning from a single plan retains the overview root');
phaseOverview.props.notes = overviewNotes.filter(note => note.id !== phaseRootA.id && note.parentId !== phaseRootA.id); phaseOverview.render();
assert.equal(phaseTab(phaseRootB.title).props['aria-selected'], true, 'a removed root falls back to an existing phase');
assert.ok(!all(phaseOverview.tree).some(node => node.props['aria-label'] === '下一个根项目'), 'one root needs no carousel arrows');
phaseOverview.props.notes = []; phaseOverview.render();
assert.ok(!all(phaseOverview.tree).some(node => node.props.role === 'tab'), 'empty plans leave no stale root tab');
await import('./check-plan-completion-write');
await import('./check-plan-calendar');
const realDate = globalThis.Date;
const originalTimezone = process.env.TZ;
try {
  for (const clock of [
    { timezone: 'Asia/Shanghai', instant: '2026-10-30T00:05:00+08:00', expected: '2026-10-30' },
    { timezone: 'Asia/Shanghai', instant: '2026-10-30T07:59:00+08:00', expected: '2026-10-30' },
    { timezone: 'Asia/Shanghai', instant: '2026-10-30T08:01:00+08:00', expected: '2026-10-30' },
    { timezone: 'America/Los_Angeles', instant: '2026-10-30T01:05:00Z', expected: '2026-10-29' },
  ]) {
    process.env.TZ = clock.timezone;
    const instant = realDate.parse(clock.instant);
    globalThis.Date = new Proxy(realDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
      get(target, key, receiver) { return key === 'now' ? () => instant : Reflect.get(target, key, receiver); },
    });
    let localDraft: PlanBuilderDraftValue | undefined;
    const localBuilder = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
      onBatchCreate() {}, onDraftChange(value: PlanBuilderDraftValue) { localDraft = value; },
    });
    byText(localBuilder.tree, 'button', '调整条件').props.onClick(); localBuilder.render();
    const startLabel = find(byClass(localBuilder.tree, 'plan-condition-panel'), node => node.type === 'label' && textContent(node).startsWith('开始日期'));
    assert.equal(find(startLabel, node => node.type === 'input').props.value, clock.expected,
      `new plan uses the local calendar date at ${clock.timezone} ${clock.instant}`);
    assert.equal(localDraft!.tree[0].startDate, clock.expected, 'the recoverable draft stores the same local start date');
    assert.equal(localDraft!.planMeta.startDate, clock.expected);
  }
} finally {
  globalThis.Date = realDate;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
}

{
  const originalDate = globalThis.Date;
  const instant = originalDate.parse('2026-10-30T12:00:00');
  globalThis.Date = new Proxy(originalDate, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
    get(target, key, receiver) { return key === 'now' ? () => instant : Reflect.get(target, key, receiver); },
  });
  try {
    const rootNote = (startDate?: string, dueDate?: string): NoteItem => ({ id: 'new-date-root', title: '持续学习计划', noteType: 'project',
      content: '', tags: [], links: [], backlinks: [], createdAt: '', updatedAt: '',
      planMeta: { schemaVersion: 2, status: 'active', startDate, targetDate: dueDate },
      dueDates: dueDate ? [{ id: 'new-date-deadline', noteId: 'new-date-root', noteTitle: '持续学习计划', taskText: '持续学习计划',
        startDate, dueDate, priority: 'medium', completed: false }] : [],
    });
    const newProjectDrawer = (startDate?: string, dueDate?: string) => {
      const writes: any[] = [];
      const panel = harness('src/components/PlanWorkspace.tsx', 'PlanWorkspace', {
        notes: [rootNote(startDate, dueDate)], initialPlanId: 'new-date-root', onToggleTaskCompleted() {},
        onToggleProjectCompleted() {}, onToggleMilestoneCompleted() {}, onSelectNoteByTitle() {}, onOpenPlanBuilder() {},
        onAddTask() {}, onAddStructureItem(input: any) { writes.push(input); return true; },
      });
      byText(panel.tree, 'button', '添加任务').props.onClick(); panel.render();
      find(panel.tree, node => node.props.role === 'radio' && textContent(node).startsWith('新建结构项目')).props.onClick(); panel.render();
      const field = (label: string) => find(find(byClass(panel.tree, 'plan-add-drawer'), node => node.type === 'label' && textContent(node).startsWith(label)), node => node.type === 'input');
      field('项目名称').props.onChange(event('新加入的结构项目')); panel.render();
      return { panel, writes, field };
    };
    for (const [start, end, expectedStart, expectedEnd] of [
      ['2026-09-01', '2026-11-29', '2026-10-30', '2026-11-12'],
      ['2026-11-10', '2026-11-30', '2026-11-10', '2026-11-23'],
      ['2026-09-01', '2026-11-02', '2026-10-30', '2026-11-02'],
      ['2026-09-01', '2026-10-30', '2026-10-30', '2026-10-30'],
      ['2026-09-01', undefined, '2026-10-30', '2026-11-12'],
      [undefined, '2026-11-29', '2026-10-30', '2026-11-12'],
    ]) {
      const { field, panel, writes } = newProjectDrawer(start, end);
      assert.equal(field('开始日期').props.value, expectedStart, 'a new project starts today or at the future parent start');
      assert.equal(field('结束日期').props.value, expectedEnd, 'the initial two-week window stays within the parent end');
      await byClass(panel.tree, 'plan-add-drawer').props.onSubmit(event());
      assert.equal(writes.length, 1); assert.equal(writes[0].startDate, expectedStart); assert.equal(writes[0].dueDate, expectedEnd);
    }
    const ended = newProjectDrawer('2026-09-01', '2026-09-14');
    assert.equal(ended.field('开始日期').props.value, ''); assert.equal(ended.field('结束日期').props.value, '');
    assert.match(textContent(ended.panel.tree), /父项目已于 2026-09-14 结束/);
    assert.equal(byText(ended.panel.tree, 'button', '加入计划').props.disabled, true);
    await byClass(ended.panel.tree, 'plan-add-drawer').props.onSubmit(event()); assert.equal(ended.writes.length, 0);
    ended.field('开始日期').props.onChange(event('2026-09-02')); ended.panel.render();
    ended.field('结束日期').props.onChange(event('2026-09-03')); ended.panel.render();
    assert.equal(byText(ended.panel.tree, 'button', '加入计划').props.disabled, false, 'explicitly entering a valid historical interval remains supported');
    await byClass(ended.panel.tree, 'plan-add-drawer').props.onSubmit(event()); assert.equal(ended.writes.length, 1);

    const edited = newProjectDrawer('2026-09-01', '2026-11-29');
    edited.field('开始日期').props.onChange(event('2026-11-05')); edited.panel.render();
    edited.field('结束日期').props.onChange(event('2026-11-07')); edited.panel.render();
    edited.panel.props.notes = edited.panel.props.notes.map((note: NoteItem) => ({ ...note, content: '背景保存的新正文', updatedAt: '2026-10-30T13:00:00Z' }));
    edited.panel.render();
    assert.equal(edited.field('开始日期').props.value, '2026-11-05'); assert.equal(edited.field('结束日期').props.value, '2026-11-07', 'normal note writes do not reset edited dates');
    edited.panel.props.notes = edited.panel.props.notes.map((note: NoteItem) => ({ ...note,
      dueDates: note.dueDates.map(item => ({ ...item, startDate: '2026-11-10' })), planMeta: { ...note.planMeta!, startDate: '2026-11-10' } }));
    edited.panel.render();
    assert.equal(edited.field('开始日期').props.value, '2026-11-10', 'a genuinely changed parent scheduling window recomputes the default');
    assert.equal(edited.field('结束日期').props.value, '2026-11-23');
    const switching = newProjectDrawer('2026-09-01', '2026-11-29');
    const phase: NoteItem = { ...rootNote('2026-11-10', '2026-11-20'), id: 'future-phase', title: '未来阶段', parentId: 'new-date-root', planMeta: undefined,
      dueDates: [{ id: 'future-phase-deadline', noteId: 'future-phase', noteTitle: '未来阶段', taskText: '未来阶段',
        startDate: '2026-11-10', dueDate: '2026-11-20', priority: 'medium', completed: false }] };
    switching.panel.props.notes = [...switching.panel.props.notes, phase]; switching.panel.render();
    const parentSelect = () => find(find(byClass(switching.panel.tree, 'plan-add-drawer'), node => node.type === 'label' && textContent(node).startsWith('父项目')), node => node.type === 'select');
    parentSelect().props.onChange(event(phase.id)); switching.panel.render();
    assert.equal(switching.field('开始日期').props.value, '2026-11-10'); assert.equal(switching.field('结束日期').props.value, '2026-11-20');
    parentSelect().props.onChange(event('new-date-root')); switching.panel.render();
    assert.equal(switching.field('开始日期').props.value, '2026-10-30'); assert.equal(switching.field('结束日期').props.value, '2026-11-12');
  } finally { globalThis.Date = originalDate; }
}
{
  const draft: PlanBuilderDraftValue = {
    tree: [{ key: 'rest-root', title: '学习日检查', startDate: '2026-11-02', dueDate: '2026-11-13', children: [{
      key: 'rest-core', title: '核心20%：交付分析报告', startDate: '2026-11-02', dueDate: '2026-11-07', children: [{
        key: 'rest-leaf', title: '交付销售数据分析报告', startDate: '2026-11-07', dueDate: '2026-11-07', children: [],
      }],
    }] }],
    planMeta: { schemaVersion: 2, status: 'draft', startDate: '2026-11-02', targetDate: '2026-11-13',
      dailyStudyMinutes: 60, activeWeekdays: [1, 2, 3, 4, 5], conditions: { deadlineMode: 'flexible' } },
  };
  const original = JSON.stringify(draft);
  const warnings = harness('src/components/PlanBuilder.tsx', 'PlanBuilder', {
    draftValue: draft, capacitySettings: { learningWeeklyBudgetMinutes: 480 }, allPlanNotes: [],
    onBatchCreate() { assert.fail('a reminder must never save without confirmation'); },
  });
  const reminder = find(warnings.tree, node => node.props['aria-label'] === '计划条件提醒');
  assert.equal(reminder.props.role, 'status'); assert.ok(reminder.props.className.includes('is-warning'));
  assert.match(textContent(reminder), /交付销售数据分析报告.*2026-11-07，周六/);
  assert.equal(all(warnings.tree).some(node => node.type === 'summary' && textContent(node).includes('核心20%范围')), false,
    'the extra core-explanation section was removed; the track itself expresses the scope');
  const composerProps = () => find(warnings.tree, node => (node.type as any)?.name === 'PlanDualTrackComposer').props;
  const inspector = harness('src/components/PlanDualTrackComposer.tsx', 'PlanDualTrackComposer', composerProps());
  assert.match(textContent(byClass(inspector.tree, 'dual-assessment')), /排期有提醒/);
  assert.doesNotMatch(textContent(byClass(inspector.tree, 'dual-assessment')), /排期条件可执行/);
  byText(warnings.tree, 'button', '调整条件').props.onClick(); warnings.render();
  byText(byClass(warnings.tree, 'plan-weekday-picker'), 'button', '六').props.onClick(); warnings.render();
  assert.equal(all(warnings.tree).some(node => node.props['aria-label'] === '计划条件提醒'), false,
    'explicitly enabling Saturday clears the reminder immediately');
  byText(byClass(warnings.tree, 'plan-weekday-picker'), 'button', '六').props.onClick(); warnings.render();
  assert.ok(all(warnings.tree).some(node => node.props['aria-label'] === '计划条件提醒'));
  const rescheduled = structuredClone(composerProps().nodes) as PlanNode[];
  rescheduled[0].children[0].startDate = rescheduled[0].children[0].dueDate = '2026-11-06';
  composerProps().onNodesChange(rescheduled); warnings.render();
  assert.equal(all(warnings.tree).some(node => node.props['aria-label'] === '计划条件提醒'), false,
    'moving the leaf back to Friday clears the reminder');
  assert.equal(JSON.stringify(draft), original, 'a reminder or date draft must not mutate the original plan');
}
console.log('Plan UI interactions passed: menus, capacity drafts, publish retry, target clearing, local start dates, new-project date defaults, completion controls, stable overview identity, visible leaf-day warnings and no extra core-explanation section.');
