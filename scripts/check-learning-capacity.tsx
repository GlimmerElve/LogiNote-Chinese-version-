import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DueDateItem, NoteItem, PlanNode } from '../src/types';
import { assertHardDraftCapacity, buildLearningCapacity, learningCapacitySummary, prepareLearningCapacityPatch, previewDraftCapacity, weekStartDate, CAPACITY_TOOLS } from '../src/services/learningCapacity';
import { buildPublishedPlanEditorValue, replacePublishedPlanFromEditor } from '../src/services/publishedPlanEditor';
import { getScheduledProjectDeadline } from '../src/services/planProjectState';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { registerLearningCapacityTools, readCapacityPatch } from '../src/services/agent/tools/learningCapacityTools';
import { getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { LearningCapacitySettings } from '../src/components/LearningCapacitySettings';
import { DEFAULT_SETTINGS, normalizeAppSettings, parseNoteMetadata } from '../src/services/storage';
import { splitSharableFields, serializeSettingsState, deserializeSettingsState } from '../src/services/userStateService';
import { assessPlanConditions } from '../src/services/planConditionService';
import { registerPlanTools } from '../src/services/agent/tools/planTools';
import { agentActionRecoveryReason } from '../src/services/agent/actionOutcome';
import { applyWorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { createAppSettings } from '../src/components/useAppSettings';
import { buildProjectPlanNotes } from '../src/services/planAdjustmentService';

globalThis.fetch = async () => { throw new Error('No network in offline capacity checks'); };
let groups = 0; const pass = (s: string) => { groups++; console.log(`PASS ${s}`); };
const WEEK = '2026-10-12', TODAY = '2026-10-18', settings = { learningWeeklyBudgetMinutes: 600 };
function project(id: string, parentId?: string, date = WEEK, minutes?: number): NoteItem {
  return { id, title: id, parentId, noteType: 'project', content: `# ${id}\n\n- ${id} @due(${date})`, tags: [], links: [], backlinks: [], createdAt: 'v1', updatedAt: 'v1',
    dueDates: [{ id: `d-${id}`, noteId: id, noteTitle: id, taskText: id, dueDate: date, startDate: date, completed: false, priority: 'medium', estimatedMinutes: minutes }] };
}
function fixture() {
  const a = project('A'); a.planMeta = { schemaVersion: 2, status: 'active', dailyStudyMinutes: 60, weeklyBudgetMinutes: 600 };
  const b = project('B'); b.planMeta = { schemaVersion: 2, status: 'active', dailyStudyMinutes: 30, weeklyBudgetMinutes: 960 };
  a.dueDates[0].dueDate = '2026-10-16'; b.dueDates[0].dueDate = '2026-10-16';
  const notes = [a, b]; for (let i = 0; i < 5; i++) { const date = `2026-10-${12+i}`; notes.push(project(`a${i}`, 'A', date), project(`b${i}`, 'B', date)); }
  return notes;
}
let notes = fixture();
let cap = buildLearningCapacity(notes, WEEK, settings, TODAY);
assert.equal(cap.projectMinutes, 450); assert.equal(cap.scheduledMinutes, 450); assert.equal(cap.budgetMinutes, 600); assert.equal(cap.percent, 75);
assert.equal(cap.entries.filter(e => ['A','B'].includes(e.noteId)).length, 0);
pass('两计划叶子项目共450分钟，共享600分钟，不累计旧预算或父项目');
notes[2].dueDates[0].completed = true; notes[2].dueDates[0].completedAt = '2026-10-17';
cap = buildLearningCapacity(notes, WEEK, settings, TODAY); assert.equal(cap.scheduledMinutes, 450); assert.equal(cap.entries.find(e => e.noteId === 'a0')!.date, WEEK);
notes[3].dueDates[0].dueDate = '2026-10-30';
assert.equal(buildLearningCapacity(notes, WEEK, settings, TODAY).scheduledMinutes, 450);
assert.equal(buildLearningCapacity(notes, '2026-10-19', settings, TODAY).projectMinutes, 0);
pass('已完成保留原排期；跨周项目按开始学习日计一次，不乘日期跨度');
const mutation = prepareLearningCapacityPatch(notes, { planDaily: [{ rootId: 'A', minutes: 90 }], leafEfforts: [{ noteId: 'a1', minutes: 45 }] }, 'v2');
assert.equal(getScheduledProjectDeadline(mutation.notes.find(n => n.id === 'a0')!)!.estimatedMinutes, 60);
assert.equal(getScheduledProjectDeadline(mutation.notes.find(n => n.id === 'a1')!)!.estimatedMinutes, 45);
assert.equal(buildLearningCapacity(mutation.notes, WEEK, settings, TODAY).projectMinutes, 525);
assert.equal(notes.find(n => n.id === 'A')!.planMeta!.dailyStudyMinutes, 60);
assert.ok(mutation.notes.every((n, i) => n.content === notes[i].content));
pass('修改每日默认，保留已完成时长和独立覆盖，不写正文/日期/完成状态');
assert.throws(() => prepareLearningCapacityPatch(notes, { leafEfforts: [{ noteId: 'A', minutes: 30 }] }));
assert.throws(() => prepareLearningCapacityPatch(notes, { leafEfforts: [{ noteId: 'a0', minutes: 30 }] }));
for (const value of [0, -1, NaN, Infinity, 10081, '600']) assert.throws(() => prepareLearningCapacityPatch(notes, { weeklyBudgetMinutes: value as number }));
assert.throws(() => readCapacityPatch({ planDaily: [{ rootId: 'A', minutes: 60 }, { rootId: 'A', minutes: 90 }] }));
assert.throws(() => readCapacityPatch({ weeklyBudgetMinutes: 600, deleteNotes: true }));
pass('严格校验目标/单位/重复对象，禁止借时间工具删除或修改已完成项目');
const task: DueDateItem = { id: 'extra', noteId: 'A', noteTitle: 'A', taskText: '独立复习', dueDate: WEEK, completed: false, priority: 'medium', estimatedMinutes: 30,
  recurrence: { frequency: 'weekdays', endDate: '2026-10-16' }, linkedProjectId: 'a1' };
notes[0].dueDates.push(task);
assert.equal(buildLearningCapacity(notes, WEEK, settings, TODAY).executionMinutes, 150);
const included = prepareLearningCapacityPatch(notes, { executionEfforts: [{ noteId: 'A', taskId: 'extra', capacityKind: 'included' }] }).notes;
assert.equal(buildLearningCapacity(included, WEEK, settings, TODAY).executionMinutes, 120, 'only the matching project learning day is included; other recurring review dates still consume time');
notes[0].dueDates.at(-1)!.linkedProjectId = 'b1';
assert.throws(() => prepareLearningCapacityPatch(notes, { executionEfforts: [{ noteId: 'A', taskId: 'extra', capacityKind: 'included' }] }));
pass('周期事项逐次计时；仅明确包含且同计划真实叶子可去重，关联本身不免计时');
const legacy = fixture(); delete legacy[0].planMeta!.dailyStudyMinutes;
const unknown = buildLearningCapacity(legacy, WEEK, {}, TODAY);
assert.equal(unknown.percent, null); assert.equal(unknown.budgetMinutes, null); assert.equal(unknown.estimatedCount, 5);
legacy[1].planMeta!.status = 'paused';
assert.equal(buildLearningCapacity(legacy, WEEK, settings, TODAY).byRoot.find(r => r.rootId === 'B')!.scheduledMinutes, 0);
pass('旧每日强度标估算，个人预算未确认不假报百分比，暂停计划不占新容量');
const tree: PlanNode[] = [{ key: 'new', title: '新计划', children: [{ key: 'leaf', title: '新叶子', startDate: WEEK, dueDate: WEEK, children: [] }] }];
const preview = previewDraftCapacity(tree, { dailyStudyMinutes: 180 }, fixture(), { learningWeeklyBudgetMinutes: 600 });
assert.equal(preview[0].scheduledMinutes, 630); assert.equal(preview[0].percent, 105);
const replace = previewDraftCapacity(tree, { dailyStudyMinutes: 180 }, fixture(), settings, 'A');
assert.equal(replace[0].scheduledMinutes, 330);
assert.throws(() => assertHardDraftCapacity(tree, { dailyStudyMinutes: 180, conditions: { deadlineMode: 'hard' } }, fixture(), settings), /超过/u);
assert.doesNotThrow(() => assertHardDraftCapacity(tree, { dailyStudyMinutes: 180, conditions: { deadlineMode: 'hard' } }, fixture(), settings, 'A'));
assert.throws(() => assertHardDraftCapacity(tree, { dailyStudyMinutes: 60, conditions: { deadlineMode: 'hard' } }, [], {}), /确认/u);
pass('草稿读取其他计划占用；编辑只替换当前计划，新增排期不独占周预算');
const editBase = fixture(); const editor = buildPublishedPlanEditorValue(editBase, 'A')!;
editor.planMeta.dailyStudyMinutes = 90; editor.tree[0].children[0].estimatedMinutes = 45;
const edited = replacePublishedPlanFromEditor(editBase, 'A', editor.tree, editor.planMeta, 'v3');
assert.equal(getScheduledProjectDeadline(editBase.find(n => n.id === 'a0')!)!.estimatedMinutes, undefined, 'preview must not mutate original live notes');
assert.equal(edited.notes.find(n => n.id === 'A')!.planMeta!.dailyStudyMinutes, 90);
assert.equal(getScheduledProjectDeadline(edited.notes.find(n => n.id === 'a0')!)!.estimatedMinutes, 45);
assert.equal(buildPublishedPlanEditorValue(edited.notes, 'A')!.tree[0].children[0].estimatedMinutes, 45);
assert.ok(edited.notes.filter(n => n.parentId === 'B').every(n => n.updatedAt === 'v1'));
pass('实际计划编辑/保存往返保留每日强度及叶子覆盖，不触碰另一计划');
const newPlan = buildProjectPlanNotes([], { key: 'new-plan', title: '新课程', startDate: WEEK, dueDate: '2026-10-16', children: [
  { key: 'new-lesson', title: '新课第一节', startDate: WEEK, dueDate: WEEK, estimatedMinutes: 45, children: [] },
] }, 'v1', undefined, { dailyStudyMinutes: 90 });
const newRoot = newPlan.createdNotes.find(n => !n.parentId)!;
assert.equal(newRoot.planMeta!.dailyStudyMinutes, 90); assert.equal(newRoot.planMeta!.weeklyBudgetMinutes, undefined);
assert.equal(buildLearningCapacity(newPlan.createdNotes, WEEK, settings, TODAY).projectMinutes, 45);
pass('实际新建计划生成器保留每日投入和叶子覆盖，不创建虚构的计划周预算');
const serialized = deserializeSettingsState(serializeSettingsState({ ...DEFAULT_SETTINGS, ...settings }))!;
assert.equal(serialized.learningWeeklyBudgetMinutes, 600);
assert.equal(normalizeAppSettings({ ...DEFAULT_SETTINGS, learningWeeklyBudgetMinutes: '600' }).learningWeeklyBudgetMinutes, undefined);
assert.equal(splitSharableFields(edited.notes.find(n => n.id === 'A')!).planMeta!.dailyStudyMinutes, 90);
pass('个人预算走原设置持久化，计划数据走原白名单，非法旧设置不当作已确认');
const markup = renderToStaticMarkup(<LearningCapacitySettings settings={{ ...DEFAULT_SETTINGS, ...settings }} notes={fixture()} onUpdate={() => { throw new Error('SSR cannot save'); }} />);
assert.ok(markup.includes('所有计划共用')); assert.ok(markup.includes('确认应用到所有计划'));
// The settings component displays the actual current week, not the fixed fixture week.
assert.ok(markup.includes(`本周全部计划：${buildLearningCapacity(fixture(), weekStartDate(), settings).scheduledMinutes} 分钟`));
assert.ok(!renderToStaticMarkup(<LearningCapacitySettings settings={DEFAULT_SETTINGS} notes={fixture()} onUpdate={() => {}} />).includes('75%'));
pass('设置页标明全局影响，未确认预算不显示伪百分比，渲染不触发写入');
registerLearningCapacityTools(); registerPlanTools();
assert.ok(CAPACITY_TOOLS.every(t => AGENT_ROLES.default.allowedTools.includes(t)));
let liveNotes = fixture(), liveBudget = 600, writes = 0;
const ctx = { getNotes: () => liveNotes, getPlanNotes: () => liveNotes, getActiveNote: () => null, ensureDataFresh: async () => {},
  getPlanDraftSession: () => null, getResourceDraftSession: () => null,
  getLearningCapacitySettings: () => ({ learningWeeklyBudgetMinutes: liveBudget }),
  applyLearningCapacityPatch: async (patch: Parameters<typeof prepareLearningCapacityPatch>[1]) => {
    liveNotes = prepareLearningCapacityPatch(liveNotes, patch).notes; liveBudget = patch.weeklyBudgetMinutes ?? liveBudget; writes++; return { saved: true };
  } } as unknown as AgentRuntimeContext;
assert.equal(toolRequiresApproval(getTool('update_learning_capacity')!, {}, ctx), true);
async function pending() {
  let calls = 0;
  return runAgentTurn({ role: AGENT_ROLES.default, history: [], ctx, userText: '最近比较忙，每周所有学习控制在6小时，A每天改为半小时', memoryPrefixLoader: async () => '',
    callLlm: async request => request.workflow === 'agent-intent-routing' ? { content: '', parsedJson: { skillId: 'general', confidence: 1, standaloneRequest: '修改学习容量', referenceResolution: 'none' } }
      : ++calls === 1 ? { content: '读取后提出确认', toolCalls: [{ id: 'cap', name: 'update_learning_capacity', arguments: { weeklyBudgetMinutes: 360, planDaily: [{ rootId: 'A', minutes: 30 }] } }] } : { content: '等待确认' } });
}
const first = await pending(); assert.ok(first.pendingApproval, JSON.stringify(first)); assert.equal(writes, 0);
liveBudget = 720;
await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: first.pendingApproval!, history: first.updatedHistory, approved: true, callLlm: async () => ({ content: '不应调用' }) }), /变化/u);
assert.equal(writes, 0);
const second = await pending();
await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: second.pendingApproval!, history: second.updatedHistory, approved: true, callLlm: async () => ({ content: '已调整时间，未重排日期' }) });
assert.equal(writes, 1); assert.equal(liveBudget, 360); assert.equal(liveNotes[0].planMeta!.dailyStudyMinutes, 30);
pass('真实Agent循环先确认零写入，预算并发变化拒绝旧卡，新卡确认可组合保存');
const query = await getTool('query_learning_capacity')!.execute({ weekStart: WEEK }, ctx) as ReturnType<typeof buildLearningCapacity>;
assert.equal(query.budgetMinutes, 360); assert.equal(query.scheduledMinutes, 300);
const planQuery = await getTool('query_plan_workspace')!.execute({ rootProjectId: 'A' }, ctx) as any;
assert.equal(planQuery.weeklyLoad.budgetMinutes, 360);
assert.equal(agentActionRecoveryReason('已保存修改', 'plan-planning', [{ ok: true, call: { id: 'x', name: 'update_learning_capacity', arguments: {} }, result: { saved: true } } as never]), undefined);
pass('计划查询与新容量工具共用个人预算，真实保存可证明完成');

// Execute the actual App write callback, isolated from desktop/vault/model APIs.
const appSource = readFileSync('src/App.tsx', 'utf8');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callbackSource = '';
function findCallback(node: ts.Node) { if (ts.isPropertyAssignment(node) && node.name.getText(appAst) === 'applyLearningCapacityPatch') callbackSource = node.initializer.getText(appAst); ts.forEachChild(node, findCallback); }
findCallback(appAst); assert.ok(callbackSource);
const output = ts.transpileModule(`export const run = ${callbackSource};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
async function appPort(options: { failSettings?: boolean; failNotes?: boolean; concurrentBudget?: boolean } = {}) {
  let live = fixture(), settingWrites = 0;
  const controller = createAppSettings({ ...DEFAULT_SETTINGS, ...settings }, async () => ({ ...DEFAULT_SETTINGS, ...settings }), async () => { settingWrites++; if (options.failSettings) throw new Error('synthetic settings write failure'); });
  await controller.load();
  const exports: Record<string, any> = {};
  runInNewContext(output, { exports, Error, Date, Object, JSON, Promise,
    assertNoPendingAgentPlanEditorDraft() {}, notesHydrated: true, isPlanPreviewDemo: false, notesRef: { get current() { return live; } },
    appSettings: { ...controller.getSnapshot(), ...controller }, prepareLearningCapacityPatch, buildLearningCapacity, learningCapacitySummary, weekStartDate,
    commitAgentNoteChange: async (change: Parameters<typeof applyWorkspaceNoteChange>[1]) => {
      if (options.failNotes) throw new Error('synthetic note write failure');
      live = applyWorkspaceNoteChange(live, change);
      if (options.concurrentBudget) controller.update({ learningWeeklyBudgetMinutes: 720 });
      return { operationId: 'synthetic-operation', saved: true };
    },
  });
  return { run: exports.run, read: () => live, controller, writes: () => settingWrites };
}
const partialPort = await appPort({ failSettings: true });
const partial = await partialPort.run({ weeklyBudgetMinutes: 360, planDaily: [{ rootId: 'A', minutes: 30 }] });
assert.equal(partial.saved, false); assert.equal(partial.partial, true); assert.equal(partialPort.read()[0].planMeta!.dailyStudyMinutes, 30);
assert.ok(partialPort.read().every((n, i) => n.content === fixture()[i].content));
const noteFailure = await appPort({ failNotes: true });
await assert.rejects(noteFailure.run({ weeklyBudgetMinutes: 360, planDaily: [{ rootId: 'A', minutes: 30 }] }));
assert.equal(noteFailure.writes(), 0);
pass('实际App组合写回：笔记失败不写预算；设置失败保留已保存计划并明确部分成功，不宣称全部完成');
const raced = await appPort({ concurrentBudget: true });
const raceResult = await raced.run({ weeklyBudgetMinutes: 360, planDaily: [{ rootId: 'A', minutes: 30 }] });
assert.equal(raceResult.saved, false); assert.equal(raced.controller.getSnapshot().settings.learningWeeklyBudgetMinutes, 720);
const cleanPort = await appPort(); const clean = await cleanPort.run({ weeklyBudgetMinutes: 360, planDaily: [{ rootId: 'A', minutes: 30 }] });
assert.equal(clean.saved, true); assert.equal(clean.capacity.budgetMinutes, 360); assert.equal(clean.rescheduled, false);
pass('实际App保存期间的新预算不被旧确认覆盖；正常组合保存从同步控制器读取最终结果');
console.log(`learning capacity: ${groups} groups passed; synthetic state only, no model/network/private vault`);
