import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentPanel } from '../src/components/AgentPanel';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { clearToolRegistryForTests, registerTool } from '../src/services/agent/toolRegistry';
import { agentSequenceExecution, buildAgentSequenceStepRequest, constrainAgentSequenceCall, consumeAgentSequenceOutcome,
  createAgentSkillSequence, currentAgentSequenceStep, loadAgentSkillSequence, recordAgentSequenceResult, saveAgentSkillSequence, updateAgentSequenceStep } from '../src/services/agent/skillSequence';
import type { AgentPlanDraftSession, AgentResourceDraftSession, AgentRuntimeContext, AgentTurnResult } from '../src/services/agent/types';
import type { NoteItem } from '../src/types';

// Synthetic fixtures only. No user vault, browser, network, or live LLM access.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live requests forbidden in sequence checks'); };
let checks = 0;
function pass(name: string) { checks++; console.log(`PASS ${name}`); }
function note(id: string, title: string, parentId?: string, content = ''): NoteItem {
  return { id, title, parentId, content, noteType: 'project', createdAt: '2026-10-06', updatedAt: '2026-10-06', tags: [], links: [], backlinks: [], dueDates: [] };
}
let notes: NoteItem[] = [note('old', '旧项目')];
let plan: AgentPlanDraftSession | null = null;
let resource: AgentResourceDraftSession | null = null;
const ctx = { getNotes: () => notes, getActiveNote: () => notes[0], getPlanDraftSession: () => plan, getResourceDraftSession: () => resource,
  ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
let sequence = createAgentSkillSequence('先帮我制定 Python 学习计划，然后生成学习任务清单，最后推荐学习资源', 'default', ctx)!;
assert.deepEqual(sequence.steps.map((step) => step.skillId), ['plan-planning', 'study-task-generation', 'resource-curation']);
assert.equal(sequence.scopeProjectId, undefined);
assert.equal(createAgentSkillSequence('如何生成学习计划并推荐资源？', 'default', ctx), null);
assert.equal(createAgentSkillSequence('制定学习计划，不要生成学习任务，也不要推荐资源', 'default', ctx), null);
assert.equal(createAgentSkillSequence('为“A”生成学习任务，给“B”推荐资源', 'default', ctx), null);
assert.equal(createAgentSkillSequence('请制定学习计划', 'default', ctx), null);
assert.equal(createAgentSkillSequence('帮我做一套包含学习计划、任务清单和学习资源的方案', 'default', ctx)?.steps.length, 3);
pass('只显式串联复合动作，不根据问答、否定、单任务或多项目混合指令扩大授权');

const result = (skillId: string, name?: string, data?: unknown): AgentTurnResult => ({ reply: '', updatedHistory: [], truncated: false,
  toolTrace: name ? [{ call: { id: name, name, arguments: {} }, ok: true, result: data }] : [], activeSkill: { id: skillId, name: skillId }, auditRunId: 'run-1' });
const imported = result('plan-planning', 'create_project_plan', { draftImported: true, requiresUserConfirmation: true, editorDraftId: 'preview-1' });
sequence = recordAgentSequenceResult(sequence, imported, ctx);
assert.equal(currentAgentSequenceStep(sequence)?.status, 'waiting-editor');
assert.equal(currentAgentSequenceStep(sequence)?.skillId, 'plan-planning');
const saveFailure = consumeAgentSequenceOutcome(sequence, { kind: 'plan-writeback-failed', eventId: 'failed', editorDraftId: 'preview-1' }, ctx)!;
assert.equal(currentAgentSequenceStep(saveFailure)?.status, 'paused');
assert.equal(currentAgentSequenceStep(saveFailure)?.skillId, 'plan-planning');
assert.equal(consumeAgentSequenceOutcome(sequence, { kind: 'plan-writeback', eventId: 'fake', editorDraftId: 'preview-1', rootProjectId: 'missing' }, ctx), null);
assert.equal(consumeAgentSequenceOutcome(sequence, { kind: 'plan-writeback', eventId: 'wrong', editorDraftId: 'preview-other', rootProjectId: 'old' }, ctx), null);
notes.push(note('new', 'Python'), note('leaf-1', '基础', 'new'), note('leaf-2', '应用', 'new'));
sequence = consumeAgentSequenceOutcome(sequence, { kind: 'plan-writeback', eventId: 'saved', editorDraftId: 'preview-1', rootProjectId: 'new' }, ctx)!;
assert.equal(currentAgentSequenceStep(sequence)?.skillId, 'study-task-generation');
assert.equal(sequence.scopeProjectId, 'new');
assert.match(buildAgentSequenceStepRequest(sequence, ctx), /"id":"new"/u);
pass('导入编辑器不推进；只有同一草图的真实保存事件才交给任务 Skill，旧页面不成为目标');

plan = { id: 'draft', scopeProjectId: 'new', scopeProjectTitle: 'Python' } as AgentPlanDraftSession;
const execution = agentSequenceExecution(sequence)!;
const pinnedCall = constrainAgentSequenceCall({ id: 'start', name: 'start_project_task_draft', arguments: { purpose: 'study-tasks' } }, execution, ctx);
assert.equal(pinnedCall.arguments.scopeProjectTitle, 'Python');
assert.throws(() => constrainAgentSequenceCall({ id: 'start-wrong', name: 'start_project_task_draft', arguments: { scopeProjectTitle: '旧项目' } }, execution, ctx), /不能切换/u);
plan = { ...plan, scopeProjectId: 'old' };
assert.throws(() => constrainAgentSequenceCall({ id: 'commit', name: 'commit_project_task_draft', arguments: {} }, execution, ctx), /不属于/u);
plan = { ...plan, scopeProjectId: 'new' };
assert.throws(() => constrainAgentSequenceCall({ id: 'stage', name: 'stage_project_study_task_batch', arguments: {} }, { ...execution, skillId: 'plan-planning' }, ctx), /后续/u);
assert.throws(() => constrainAgentSequenceCall({ id: 'unscoped', name: 'commit_project_task_draft', arguments: {} }, { ...execution, scopeProjectId: undefined }, ctx), /先通过/u);
pass('稳定项目 ID 约束真实调用及草案，不能切换到旧项目，也不能提前执行后续环节');

notes = notes.map((item) => item.id === 'leaf-1' ? { ...item, content: '- [ ] 练习 [[变量]]' } : item);
sequence = recordAgentSequenceResult(sequence, result('study-task-generation', 'commit_project_task_draft', { scopeProjectTitle: 'Python', taskCount: 1 }), ctx);
assert.equal(currentAgentSequenceStep(sequence)?.status, 'paused');
assert.equal(currentAgentSequenceStep(sequence)?.skillId, 'study-task-generation');
notes = notes.map((item) => item.id === 'leaf-2' ? { ...item, content: '- [ ] 应用 [[函数]]' } : item);
sequence = recordAgentSequenceResult(sequence, result('study-task-generation', 'commit_project_task_draft', { scopeProjectTitle: 'Python', taskCount: 2 }), ctx);
assert.equal(currentAgentSequenceStep(sequence)?.skillId, 'resource-curation');
assert.match(buildAgentSequenceStepRequest(sequence, ctx), /变量|函数/u);
pass('任务结果必须覆盖范围内末级项目，部分保存不能被当成整环完成');

resource = { id: 'workbench-draft', scopeProjectId: 'new', scopeProjectTitle: 'Python' } as AgentResourceDraftSession;
sequence = recordAgentSequenceResult(sequence, result('resource-curation', 'search_online_learning_resources', { status: 'workbench-opened', requiresUserConfirmation: true }), ctx);
assert.equal(currentAgentSequenceStep(sequence)?.status, 'waiting-workbench');
notes = notes.map((item) => item.id === 'leaf-1' ? { ...item, resources: [{ title: '基础课', url: 'https://example.test/a', taskText: '练习 [[变量]]' }] } : item);
const event = { kind: 'resource-writeback' as const, eventId: 'commit', draftSessionId: 'workbench-draft', resourceCount: 1,
  projects: [{ noteId: 'leaf-1', resourceUrls: ['https://example.test/a'] }] };
assert.equal(consumeAgentSequenceOutcome(sequence, { ...event, draftSessionId: 'wrong-draft' }, ctx), null);
sequence = consumeAgentSequenceOutcome(sequence, event, ctx)!;
assert.equal(currentAgentSequenceStep(sequence)?.status, 'ready');
const remainingRequest = buildAgentSequenceStepRequest(sequence, ctx);
assert.match(remainingRequest, /只继续未覆盖的目标：应用/u);
assert.doesNotMatch(remainingRequest, /未覆盖的目标：基础/u);
resource = { ...resource, id: 'workbench-next' };
sequence = recordAgentSequenceResult(sequence, result('resource-curation', 'search_online_learning_resources', { status: 'workbench-opened' }), ctx);
notes = notes.map((item) => item.id === 'leaf-2' ? { ...item, resources: [{ title: '应用课', url: 'https://example.test/b', taskText: '应用 [[函数]]' }] } : item);
sequence = consumeAgentSequenceOutcome(sequence, { ...event, draftSessionId: 'workbench-next', projects: [{ noteId: 'leaf-2', resourceUrls: ['https://example.test/b'] }] }, ctx)!;
assert.equal(currentAgentSequenceStep(sequence), undefined);
pass('资源工作台按草案身份交接，部分确认后只继续剩余目标，全覆盖才结束任务链');

assert.throws(() => constrainAgentSequenceCall({ id: 'repeat-resource', name: 'search_online_learning_resources', arguments: { projectTitle: '基础', taskText: '练习 [[变量]]' } },
  { sequenceId: sequence.id, stepIndex: 2, skillId: 'resource-curation', scopeProjectId: 'new' }, ctx), /只继续未覆盖/u);
assert.equal(currentAgentSequenceStep(recordAgentSequenceResult(sequence, imported, ctx)), undefined);
pass('实际搜索边界拒绝重复处理已收录目标，完成链不会被旧结果再次启动');

const fresh = createAgentSkillSequence('制定学习计划，并生成学习任务，再推荐资源', 'default', ctx)!;
const cancelled = updateAgentSequenceStep(fresh, 'cancelled');
assert.ok(cancelled.steps.every((step) => step.status === 'cancelled'));
assert.equal(recordAgentSequenceResult(cancelled, imported, ctx).steps[0].status, 'cancelled');
const partial = recordAgentSequenceResult(fresh, { ...imported, truncated: true }, ctx);
assert.equal(currentAgentSequenceStep(partial)?.status, 'paused');
pass('取消和截断不会推进后续环节，返回的旧结果不能复活已取消的任务');

const stored = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
saveAgentSkillSequence(updateAgentSequenceStep(fresh, 'running'));
assert.equal(currentAgentSequenceStep(loadAgentSkillSequence('default')!)?.status, 'paused');
assert.equal(loadAgentSkillSequence('other-role'), null);
const html = renderToStaticMarkup(React.createElement(AgentPanel, {
  open: true, workflowDraftReady: true, role: AGENT_ROLES.default, ctx, planDraftSession: null, resourceDraftSession: null,
  onDiscardPlanDraft: () => {}, onDiscardResourceDraft: () => {}, onOpenResource: () => {}, onDownloadResource: async () => true,
  onScanResourcePage: async () => 0, onAuthorizeResource: async () => true, onSetResourceCandidateDecision: async () => {},
  resourceActivity: null, workflowHandoff: null, onWorkflowHandoffChange: () => {}, onClose: () => {}, onBusyChange: () => {},
}));
assert.doesNotMatch(html, /连续任务状态/u, '持久化恢复前不能把未绑定资料库的旧窗口缓存当作当前任务');
saveAgentSkillSequence(null); assert.equal(loadAgentSkillSequence('default'), null);
if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'sessionStorage');
pass('旧窗口缓存不自动重跑或跨角色恢复；面板等待持久化恢复，不采用未绑定资料库的缓存');

clearToolRegistryForTests();
let changed = 0, calls = 0;
plan = { id: 'real-draft', scopeProjectId: 'new', scopeProjectTitle: 'Python', mode: 'full-task-generation', purpose: 'study-tasks',
  baseProjectRevisions: {}, projects: [], createKnowledgeNotes: [], structurePatches: [], milestonePatches: [], executionPatches: [], createdAt: '2026-10-06', updatedAt: '2026-10-06' };
registerTool({ name: 'commit_project_task_draft', bindsDraft: 'plan', description: 'mock write', permission: 'write', location: 'renderer', parameters: { type: 'object', properties: {} }, execute: () => { changed++; return { scopeProjectTitle: 'Python', taskCount: 2 }; } });
const pending = await runAgentTurn({ role: AGENT_ROLES.default, ctx, userText: '生成学习任务', history: [], requestedSkillId: 'study-task-generation',
  sequenceExecution: execution, memoryPrefixLoader: async () => '', callLlm: async () => { calls++; return { content: '', toolCalls: [{ id: 'actual-commit', name: 'commit_project_task_draft', arguments: {} }] }; } });
assert.equal(pending.pendingApproval?.continuation.checkpoint?.sequenceExecution?.scopeProjectId, 'new');
assert.equal(changed, 0); assert.equal(calls, 1);
plan = { ...plan, scopeProjectId: 'old' };
await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: pending.pendingApproval!, approved: true, history: pending.updatedHistory, callLlm: async () => ({ content: '不应到达' }) }), /变化|不属于/u);
assert.equal(changed, 0);
pass('实际引擎与确认 checkpoint 保留环节及范围锁，草案切换后不会跨项目写入');

plan = { ...plan, scopeProjectId: 'new' };
let prematureResourceWrites = 0, finalCalls = 0;
registerTool({ name: 'search_online_learning_resources', description: 'mock must not run in task skill', permission: 'write', location: 'renderer', parameters: { type: 'object', properties: {} },
  isPreauthorized: () => true, execute: () => { prematureResourceWrites++; return { status: 'written' }; } });
const approved = await resolveAgentApproval({ role: AGENT_ROLES.default, ctx, approval: pending.pendingApproval!, approved: true, history: pending.updatedHistory,
  callLlm: async () => finalCalls++ === 0 ? { content: '', toolCalls: [{ id: 'premature-resources', name: 'search_online_learning_resources', arguments: {} }] } : { content: '学习任务已经写入。' } });
assert.equal(changed, 1); assert.equal(prematureResourceWrites, 0);
assert.ok(approved.toolTrace.some((step) => !step.ok && step.call.name === 'search_online_learning_resources'));
const taskSequence = { ...fresh, scopeProjectId: 'new', steps: fresh.steps.map((step, index) => ({ ...step, status: index === 0 ? 'complete' as const : 'ready' as const })) };
assert.equal(currentAgentSequenceStep(recordAgentSequenceResult(taskSequence, approved, ctx))?.skillId, 'resource-curation');
pass('真实确认成功后才交接下一 Skill，当前环节的权限白名单不会扩展成所有工具');

let adjustment = createAgentSkillSequence('调整“Python”的学习计划，然后生成学习任务清单，最后推荐资源', 'default', ctx)!;
assert.equal(adjustment.scopeProjectId, 'new');
adjustment = recordAgentSequenceResult(adjustment, result('plan-planning', 'commit_project_task_draft', { draftImported: true, requiresUserConfirmation: true, editorDraftId: 'layout-draft' }), ctx);
assert.equal(consumeAgentSequenceOutcome(adjustment, { kind: 'plan-writeback', eventId: 'layout-save', editorDraftId: 'layout-draft', rootProjectId: 'old' }, ctx), null);
adjustment = consumeAgentSequenceOutcome(adjustment, { kind: 'plan-writeback', eventId: 'layout-save', editorDraftId: 'layout-draft', rootProjectId: 'new' }, ctx)!;
assert.equal(currentAgentSequenceStep(adjustment)?.skillId, 'study-task-generation');
pass('既有单根计划调整也通过编辑器来源引用交接，另一根计划的确认不会推进流程');

globalThis.fetch = originalFetch;
console.log(`${checks} agent sequence checks passed; synthetic fixtures only.`);
