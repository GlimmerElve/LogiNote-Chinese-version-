import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { prepareAgentNoteCreation } from '../src/services/agent/noteCreation';
import { applyWorkspaceNoteChange, prepareNoteEdit, prepareNoteMove, type WorkspaceNoteChange } from '../src/services/agent/workspaceOperations';
import { commitAgentWorkspaceChange, createAgentOperationStore, prepareOperationUndo } from '../src/services/agent/operationStore';
import { getChildProjectNotes, getLeafProjectNotesInScope, getProjectNotesInScope, isLeafProjectNote } from '../src/services/knowledgePointSelector';
import { buildLearningProjectQueue } from '../src/services/learningProjectQueue';
import { buildHomeScheduledTasks } from '../src/services/homepage/homeTaskScheduling';
import { buildHomeFocusProject } from '../src/services/homepage/homepageViewModel';
import { buildLearningCapacity, prepareLearningCapacityPatch } from '../src/services/learningCapacity';
import { getLearningCompletionTarget } from '../src/services/learningCompletion';
import { getScheduledProjectDeadline, getScheduledProjectState } from '../src/services/planProjectState';
import { buildPlanWorkspaceModel } from '../src/services/planViewModel';
import { buildPublishedPlanEditorValue, replacePublishedPlanFromEditor } from '../src/services/publishedPlanEditor';
import { createPlanDraftSession, stagePlanStructurePatches, assertPlanDraftFresh } from '../src/services/agent/planDraftService';
import { projectPreparationState, todayLearningProjects } from '../src/services/agent/homeLearningState';
import { appendProjectStudyTasks, applyPlanTaskChange } from '../src/services/planAdjustmentService';
import { runStudyTaskWorkflow } from '../src/services/agent/studyTaskWorkflow';
import { rootLearningNotes, textbookProject } from '../src/services/textbook/context';
import { projectPlanningSnapshot } from '../src/services/textbook/fingerprint';
import { parseNoteMetadata, recalculateBacklinks } from '../src/services/storage';
import { splitSharableFields, mergeNote } from '../src/services/userStateService';
import { serializeMetadata, deserializeVault, markdownFileMap } from '../src/services/vaultFsService';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { bootstrapAgentRuntime } from '../src/services/agent/bootstrap';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import { executeTool, getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';

const today = '2026-10-19', now = '2026-10-19T04:00:00Z';
const note = (id: string, extra: Partial<NoteItem> = {}): NoteItem => ({ id, title: id, noteType: 'project', content: '',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: now, updatedAt: now, ...extra });
const scheduled = (id: string, parentId?: string, end = today) => note(id, { parentId, dueDates: [{ id: `due-${id}-0`,
  noteId: id, noteTitle: id, taskText: id, startDate: today, dueDate: end, completed: false, priority: 'medium' }] });
const root = scheduled('心理学计划', undefined, '2026-10-25');
root.planMeta = { schemaVersion: 2, status: 'active', startDate: today, targetDate: '2026-10-25', dailyStudyMinutes: 60 };
const middle = scheduled('心理学阶段', root.id, '2026-10-25'), leaf = scheduled('人类心理3000年', middle.id);
const knowledge = note('认知', { noteType: 'knowledge' }), original = [root, middle, leaf, knowledge];
const body = '# 心理学时间轴\n```mermaid\ntimeline\n  古代 : 早期思想\n```\n[[认知]]\n- [ ] 日期示例 @due(2030-01-01)';
const reference = (id: string, parentId: string) => note(id, { parentId, projectRole: 'reference', content: body });
const refs = [reference('根资料', root.id), reference('阶段资料', middle.id), reference('叶子资料', leaf.id)];
const withRefs = [...original, ...refs];
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const cache = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => cache.get(key) || null,
  setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) } });

for (const ref of refs) {
  const result = applyWorkspaceNoteChange(original, { kind: 'create', label: '资料创建', before: [], after: [ref], dependencies: [original.find(n => n.id === ref.parentId)!] });
  assert.deepEqual(result.at(-1), ref); assert.ok(original.every((n, i) => result[i] === n));
}
assert.throws(() => applyWorkspaceNoteChange(original, { kind: 'create', label: '', before: [], after: [note('真正学习节点', { parentId: leaf.id })] }), /计划结构草案/);
assert.throws(() => applyWorkspaceNoteChange(original, { kind: 'create', label: '', before: [], after: [{ ...refs[0], planMeta: root.planMeta }] }), /资料型/);
assert.throws(() => applyWorkspaceNoteChange(original, { kind: 'create', label: '', before: [], after: [{ ...refs[0], dueDates: leaf.dueDates }] }), /资料型/);
assert.throws(() => prepareAgentNoteCreation({ title: '新', content: '正文', noteType: 'project', parentProjectId: refs[0].id }, withRefs), /资料型/);
assert.throws(() => prepareAgentNoteCreation({ title: '新', content: body, noteType: 'knowledge', projectRole: 'reference' }, original), /projectRole/);
assert.throws(() => prepareAgentNoteCreation({ title: '新', content: body, noteType: 'project', projectRole: ['reference'] }, original), /projectRole/);
pass('reference creation works at root/middle/leaf, learning creation and fake planning payloads stay guarded');

assert.ok(isLeafProjectNote(leaf.id, withRefs)); assert.equal(isLeafProjectNote(refs[2].id, withRefs), false);
assert.deepEqual(getLeafProjectNotesInScope(root.id, withRefs).map(n => n.id), [leaf.id]);
assert.equal(getChildProjectNotes(leaf.id, withRefs).length, 1); assert.equal(getProjectNotesInScope(root.id, withRefs).length, 6);
assert.deepEqual(buildLearningProjectQueue(withRefs, today), buildLearningProjectQueue(original, today));
assert.deepEqual(buildHomeScheduledTasks(withRefs, today), buildHomeScheduledTasks(original, today));
assert.deepEqual(buildHomeFocusProject(withRefs, today), buildHomeFocusProject(original, today));
assert.deepEqual(todayLearningProjects(withRefs, today).projects.map(n => n.projectNoteId), todayLearningProjects(original, today).projects.map(n => n.projectNoteId));
assert.ok(projectPreparationState(leaf, withRefs).leaf);
assert.deepEqual(buildLearningCapacity(withRefs, today, {}, today), buildLearningCapacity(original, today, {}, today));
assert.deepEqual(buildPlanWorkspaceModel(withRefs, root.id, today), buildPlanWorkspaceModel(original, root.id, today));
assert.deepEqual(getScheduledProjectState(withRefs, leaf.id), getScheduledProjectState(original, leaf.id));
assert.deepEqual(projectPlanningSnapshot(leaf, withRefs), projectPlanningSnapshot(leaf, original));
assert.deepEqual(rootLearningNotes(leaf, withRefs), rootLearningNotes(leaf, original));
pass('organizational hierarchy retained; learning leaf, Home, flow queue, background preflight, capacity and plan views unchanged');

const parsed = parseNoteMetadata(refs[0]); assert.deepEqual(parsed.dueDates, []); assert.deepEqual(parsed.links, [knowledge.title]);
const recalculated = recalculateBacklinks(withRefs); assert.deepEqual(recalculated.at(-1)!.dueDates, []);
assert.ok(recalculated.find(n => n.id === knowledge.id)!.backlinks.includes(refs[0].title));
const roundtrip = mergeNote(JSON.parse(JSON.stringify(splitSharableFields(refs[0]))));
assert.equal(roundtrip.projectRole, 'reference'); assert.equal(roundtrip.content, body);
const vaultRoundtrip = deserializeVault(serializeMetadata(withRefs), markdownFileMap(withRefs));
assert.equal(vaultRoundtrip.find(n => n.id === refs[0].id)!.projectRole, 'reference');
assert.ok(isLeafProjectNote(leaf.id, vaultRoundtrip));
assert.equal(prepareNoteEdit(withRefs, { noteId: refs[0].id, appendText: '- [ ] 另一条日期示例 @due(2030-01-02)' }).after[0].projectRole, 'reference');
const poisoned = { ...refs[0], dueDates: [{ ...leaf.dueDates[0], noteId: refs[0].id, taskText: refs[0].title }] };
assert.equal(getScheduledProjectDeadline(poisoned), undefined);
assert.equal(getLearningCompletionTarget([...original, poisoned], { noteId: poisoned.id, taskId: poisoned.dueDates[0].id }), null);
assert.throws(() => prepareLearningCapacityPatch(withRefs, { leafEfforts: [{ noteId: refs[0].id, minutes: 60 }] }), /资料型/);
assert.throws(() => applyPlanTaskChange(withRefs, { operation: 'add', noteTitle: refs[0].title, taskText: '不应变成任务', dueDate: today }), /资料型/);
pass('metadata roundtrip retains explicit purpose; Wiki/backlinks work but checkbox/date prose cannot become learning tasks');

const ctx = { getNotes: () => withRefs, getActiveNote: () => refs[0] } as AgentRuntimeContext;
assert.throws(() => textbookProject(ctx, refs[0].id), /资料型/);
assert.equal(textbookProject(ctx, leaf.id).id, leaf.id);
assert.ok(appendProjectStudyTasks(withRefs, { projectTitle: leaf.title, tasks: ['解释 [[认知]]'] }).notes.find(n => n.id === leaf.id)!.content.includes('[[认知]]'));
assert.throws(() => appendProjectStudyTasks(withRefs, { projectTitle: refs[0].title, tasks: ['解释 [[认知]]'] }), /末级/);
let modelCalls = 0;
await assert.rejects(runStudyTaskWorkflow(refs[0], withRefs, {} as any, new AbortController().signal, async () => {},
  async () => { modelCalls++; throw new Error('not reached'); }), /资料型/);
assert.equal(modelCalls, 0);
const backgroundSource = readFileSync('src/services/agent/backgroundWorkflowService.ts', 'utf8');
const backgroundAst = ts.createSourceFile('background.ts', backgroundSource, ts.ScriptTarget.ES2022, true);
const backgroundGuard = backgroundAst.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(backgroundAst) === 'findProject')?.initializer;
assert.ok(backgroundGuard);
const guardCode = ts.transpileModule(`const guard = ${backgroundGuard.getText(backgroundAst)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const findBackgroundProject = new Function('isLeafProjectNote', 'BackgroundBoundaryError', `${guardCode}\nreturn guard;`)(isLeafProjectNote, Error);
assert.equal(findBackgroundProject(ctx, leaf.id).id, leaf.id);
assert.throws(() => findBackgroundProject(ctx, refs[0].id), /学习叶子/);
pass('task/textbook targets remain learning-only without paid calls; legacy unmarked learning leaf remains usable');

const editor = buildPublishedPlanEditorValue(withRefs, root.id)!;
assert.deepEqual(editor, buildPublishedPlanEditorValue(original, root.id));
const saved = replacePublishedPlanFromEditor(withRefs, root.id, editor.tree, editor.planMeta, now);
for (const ref of refs) assert.deepEqual(saved.notes.find(n => n.id === ref.id), ref);
const draft = createPlanDraftSession(original, { selectedProjectId: root.id, mode: 'revise-subtree' }, now);
assert.doesNotThrow(() => assertPlanDraftFresh(withRefs, draft));
assert.throws(() => stagePlanStructurePatches(withRefs, draft, [{ operation: 'update', projectTitle: refs[0].title, dueDate: today }], now), /资料型/);
assert.throws(() => stagePlanStructurePatches(withRefs, draft, [{ operation: 'delete_subtree', projectTitle: middle.title }], now), /包含资料型/);
assert.throws(() => prepareNoteMove(withRefs, [leaf.id], root.id), /计划结构/);
const manyRefs = [...original, ...Array.from({ length: 65 }, (_, i) => reference(`资料${i}`, leaf.id))];
assert.doesNotThrow(() => stagePlanStructurePatches(manyRefs, draft, [{ operation: 'update', projectTitle: leaf.title, priority: 'high' }], now));
pass('plan edit/save preserves reference bodies; reference creation does not stale plan drafts or consume node limit; no implicit conversion/deletion');

// Exercise the actual App create handler and queued commit callback, not a reimplementation.
const source = readFileSync('src/App.tsx', 'utf8'), ast = ts.createSourceFile('src/App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let commitCallback: ts.Expression | undefined, createCallback: ts.Expression | undefined;
const visit = (node: ts.Node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'commitAgentNoteChange') commitCallback = node.initializer;
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'createNote' && node.initializer.getText(ast).includes('prepareAgentNoteCreation')) createCallback = node.initializer;
  ts.forEachChild(node, visit);
}; visit(ast); assert.ok(commitCallback); assert.ok(createCallback);
function evaluate(expression: ts.Expression, env: Record<string, unknown>) {
  const code = ts.transpileModule(`const callback = ${expression.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(env), `${code}\nreturn callback;`)(...Object.values(env));
}
function harness() {
  const notesRef = { current: structuredClone(original) }, pendingNotesRef = { current: null as NoteItem[] | null };
  let disk = structuredClone(original), file: unknown = null, saves = 0, failSave = false, planDraft = false;
  let beforeStoreWrite: (() => void) | undefined, lane: Promise<unknown> = Promise.resolve();
  const store = createAgentOperationStore({ read: async () => structuredClone(file), write: async value => {
    const hook = beforeStoreWrite; beforeStoreWrite = undefined; hook?.(); file = structuredClone(value);
  } });
  const commit = evaluate(commitCallback!, {
    enqueueLearningWrite: (_ref: unknown, work: () => Promise<unknown>) => { const next = lane.catch(() => {}).then(work); lane = next; return next; }, learningWriteQueueRef: {}, agentTaskScope: async () => 'synthetic',
    assertNoPendingAgentPlanEditorDraft: () => { if (planDraft) throw new Error('计划草案未确认'); },
    commitAgentWorkspaceChange: (change: WorkspaceNoteChange, deps: any) => commitAgentWorkspaceChange(change, { ...deps, store }),
    notesRef, pendingNotesRef, applyWorkspaceNoteChange, recalculateBacklinks, personalNotePatches: () => null,
    personalOnlySaveRef: { current: null }, trackPersonalOnlySave: () => null, saveTimerRef: { current: null }, clearTimeout,
    setNotes: () => {}, noteSaveRevisionRef: { current: 0 }, setNoteSaveState: () => {}, acknowledgedSaveState: () => 'saved',
    savePersonalStateOnly: async () => false, saveAllNotesToStorage: async (notes: NoteItem[]) => { saves++; if (failSave) throw new Error('synthetic disk failure'); disk = structuredClone(notes); },
    acknowledgePersonalSave: () => null, deleteNoteIndex: async () => {}, indexNote: async () => {}, setActiveNoteIdState: () => {}, setActiveProjectContextId: () => {},
    finishDeletedNoteIndexCleanup: async () => {},
  });
  const create = evaluate(createCallback!, { prepareAgentNoteCreation, notesRef, commitAgentNoteChange: commit,
    navigationRevisionRef: { current: 0 }, allowWorkspaceNavigation: () => false, setActiveNoteId: () => {}, setActiveProjectContextId: () => {}, setCurrentView: () => {} });
  const ctx = { getNotes: () => notesRef.current, getActiveNote: () => notesRef.current[0], ensureDataFresh: async () => {},
    getPlanDraftSession: () => null, getResourceDraftSession: () => null, createNote: create } as unknown as AgentRuntimeContext;
  return { ctx, create, store, notesRef, pendingNotesRef, get disk() { return disk; }, get saves() { return saves; },
    set failSave(value: boolean) { failSave = value; }, set planDraft(value: boolean) { planDraft = value; },
    set beforeStoreWrite(value: () => void) { beforeStoreWrite = value; } };
}
bootstrapAgentRuntime(AGENT_ROLES.default);
const planQuery = await executeTool('query_plan_workspace', { rootProjectId: root.id }, ctx);
assert.ok(planQuery.ok); assert.deepEqual((planQuery.result as any).projects.map((n: any) => n.projectId), [root.id, middle.id, leaf.id]);
const args = { title: '人类心理时间轴', noteType: 'project', projectRole: 'reference', parentProjectId: leaf.id, content: body };
const originalFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
try {
  const h = harness(); assert.ok(toolRequiresApproval(getTool('create_note')!, args, h.ctx));
  const turn = await runAgentTurn({ role: AGENT_ROLES.default, userText: '在这个项目下面新建一个资料型子项目笔记，放心理学 Mermaid 时间轴，不修改学习计划',
    history: [], ctx: h.ctx, memoryPrefixLoader: async () => '', enableMultiAgent: false,
    callLlm: async request => {
      if (request.workflow === 'agent-intent-routing') {
        assert.match(request.systemPromptOverride || '', /资料型子项目/);
        return { content: '', parsedJson: { skillId: 'general', confidence: 0.99, standaloneRequest: '在指定项目下创建资料型子项目并放入时间轴正文', referenceResolution: 'resolved' } };
      }
      assert.ok(request.tools?.some(tool => tool.name === 'create_note'));
      return { content: '', toolCalls: [{ id: 'create', name: 'create_note', arguments: args }] };
    } });
  assert.ok(turn.pendingApproval); assert.equal(h.saves, 0); assert.match(turn.pendingApproval.items[0].description, /资料型/);
  await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval, approved: false, history: turn.updatedHistory, ctx: h.ctx, callLlm: async () => ({ content: '已取消' }) });
  assert.equal(h.saves, 0); assert.equal(h.notesRef.current.length, original.length);
  h.ctx.getActiveNote = () => knowledge;
  const result = await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval, approved: true, history: turn.updatedHistory, ctx: h.ctx, callLlm: async () => ({ content: '已保存资料型子项目' }) });
  const write = result.toolTrace.find(step => step.ok && step.call.name === 'create_note')!; assert.ok(write);
  assert.equal((write.result as any).saved, true); assert.equal(h.saves, 1);
  const created = h.disk.find(n => n.title === args.title)!; assert.equal(created.projectRole, 'reference'); assert.equal(created.parentId, leaf.id); assert.equal(created.content, body); assert.deepEqual(created.dueDates, []);
  assert.equal(isLeafProjectNote(leaf.id, h.disk), true);
  const operation = await h.store.get((write.result as any).operationId);
  const undone = applyWorkspaceNoteChange(h.notesRef.current, prepareOperationUndo(h.notesRef.current, operation));
  assert.equal(undone.some(n => n.id === created.id), false); assert.deepEqual(undone.find(n => n.id === leaf.id)!.dueDates, leaf.dueDates);
  assert.equal(((await executeTool('list_notes', { noteType: 'project' }, h.ctx)).result as any).notes.find((n: any) => n.id === created.id).projectRole, 'reference');
  assert.equal(((await executeTool('read_notes', { noteIds: [created.id] }, h.ctx)).result as any).notes[0].projectRole, 'reference');
  pass('actual Agent confirmation/cancel → actual App create + save → explicit parent despite page change → metadata reads → recoverable undo');

  const stale = harness(), call = { id: 'stale', name: 'create_note', arguments: args };
  const binding = await createAgentApprovalBinding(call, stale.ctx);
  stale.notesRef.current = stale.notesRef.current.map(n => n.id === leaf.id ? { ...n, updatedAt: '2026-10-20' } : n);
  await assert.rejects(validateAgentApprovalBinding({ call, binding, title: 'test', description: 'test' }, stale.ctx));
  const race = harness(); race.beforeStoreWrite = () => { race.notesRef.current = race.notesRef.current.map(n => n.id === leaf.id ? { ...n, content: '同时编辑父项目' } : n); };
  await assert.rejects(race.create(args), /父项目.*变化/); assert.equal(race.saves, 0);
  const failed = harness(); failed.failSave = true;
  await assert.rejects(failed.create(args), /disk failure/); assert.equal(failed.disk.length, original.length); assert.ok(failed.pendingNotesRef.current);
  const prepared = await failed.store.list(); assert.equal(prepared[0].status, 'prepared');
  assert.equal(prepareOperationUndo(failed.notesRef.current, await failed.store.get(prepared[0].id)).kind, 'restore');
  const blocked = harness(); blocked.planDraft = true; await assert.rejects(blocked.create(args), /计划草案/); assert.equal(blocked.saves, 0);
  pass('stale approval, queued parent conflict, failed disk persistence and pending plan draft all fail safely with recovery retained');
} finally { globalThis.fetch = originalFetch; }
assert.equal(network, 0);
console.log(`Reference projects: ${groups} groups passed, synthetic offline data only; no real vault, model or build output touched.`);
