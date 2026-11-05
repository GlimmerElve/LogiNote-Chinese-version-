import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { cognitionManagementFixture } from './check-cognition-management';
import { applyCognitionMutation, latestCognition } from '../src/services/cognition/core';
import { CognitionAssistantSession } from '../src/services/agent/cognitionAssistantSession';
import { COGNITION_ASSISTANT_ROLE, COGNITION_ASSISTANT_TOOLS } from '../src/services/agent/cognitionAssistantPolicy';
import { emptyCognitionAssistantState, normalizeCognitionAssistantState } from '../src/services/agent/cognitionAssistantState';
import { applyAgentTaskStatePatch, normalizeAgentTaskState } from '../src/services/agent/taskStateCodec';
import { listToolsForRole, registerTool, executeTool } from '../src/services/agent/toolRegistry';
import { runAgentTurn } from '../src/services/agent/agentEngine';
import type { AgentLlmCaller } from '../src/services/agent/runtime/types';
import type { CognitionGraphEdit } from '../src/services/cognition/types';

let checks = 0, serial = 0, writes = 0, foreignCalls = 0, scope = 'synthetic-cognition-agent';
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const stamp = () => ({ id: `cognition-agent-${++serial}`, at: '2026-10-21T07:00:00Z' });
let file = cognitionManagementFixture(), tasks = normalizeAgentTaskState(null);
for (let i = 0; i < 14; i++) file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision,
  edit: { action: 'add_node', title: `独立${i}`, text: `合成独立认识${i}`, mainType: '假设', stance: 'tentative', reason: '合成分页样例' } }, stamp());
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: { userState: {
  getAgentTaskScope: async () => scope, loadAgentTaskState: async () => ({ scopeId: scope, state: structuredClone(tasks) }),
  saveAgentTaskState: async (id: string, patch: any) => { assert.equal(id, scope); tasks = applyAgentTaskStatePatch(tasks, patch); },
  loadCognition: async () => structuredClone(file), mutateCognition: async (input: any) => {
    assert.equal(input.storageScopeId, scope); file = applyCognitionMutation(file, input, stamp()); writes++; return structuredClone(file);
  },
} } }) });
globalThis.fetch = async () => assert.fail('No live model/network or real private data');
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ content: '', toolCalls: [{ id, name, arguments: args }] });
const data = (request: Parameters<AgentLlmCaller>[0], name: string) => JSON.parse(request.agentMessages!.findLast(message => message.role === 'tool' && message.toolName === name)!.content).result;
let agent: CognitionAssistantSession;
let responder: AgentLlmCaller = async () => ({ content: '已读取。' });
const invoke: AgentLlmCaller = async request => {
  assert.equal(request.workflow, 'agent-chat', 'fixed domain never invokes intent routing or evidence QA');
  assert.deepEqual(request.tools!.map(item => item.name).sort(), [...COGNITION_ASSISTANT_TOOLS].sort());
  return responder(request);
};
try {
  agent = new CognitionAssistantSession({ callLlm: invoke }); await agent.initialize(); assert.equal(agent.view().ready, true);
  let round = 0;
  responder = async () => ++round === 1 ? tool('first', 'query_cognition', { filter: 'isolated' }) : { content: '找到15个孤立节点，本页8个，可继续或展开。' };
  await agent.send('有哪些孤立节点');
  assert.equal(agent.view().work.query?.nextOffset, 8); assert.equal(agent.view().work.candidates.length, 8); await agent.flush();
  assert.ok(tasks.cognitionAssistant?.work.revision); assert.ok(tasks.cognitionAssistant?.work.candidates[0].reference.revisionId);
  const saved = structuredClone(tasks.cognitionAssistant);
  agent.dispose(); agent = new CognitionAssistantSession({ callLlm: invoke }); await agent.initialize();
  assert.deepEqual(agent.view().work, saved!.work); assert.equal(writes, 0);
  round = 0; responder = async request => {
    assert.match(request.systemPromptOverride!, /nextOffset.*8/);
    return ++round === 1 ? tool('second', 'query_cognition', { offset: 8 }) : { content: '读取了余下7个孤立节点。' };
  };
  await agent.send('继续'); assert.equal(agent.view().work.candidates.length, 7); assert.equal(agent.view().work.candidates[0].number, 9);
  for (const text of ['展开', '详细一点', '这个观点的条件是什么']) {
    const target = agent.view().work.candidates[1].reference;
    round = 0; responder = async () => ++round === 1 ? tool('full', 'query_cognition', { target }) : { content: '这是已读认知的进一步说明，没有修改。' };
    await agent.send(text); assert.deepEqual(agent.view().work.focused, target); assert.equal(agent.view().error, '');
  }
  pass('actual dedicated loop retains node coordinates/filter/version through restart, resumes the right page, and keeps expand/detail questions inside cognition without QA routing');

  for (const name of ['retrieve_qa_evidence', 'create_note', 'discover_agent_capabilities', 'generate_project_textbook']) registerTool({ name, description: 'foreign synthetic tool', location: 'renderer', permission: 'readonly', parameters: {}, execute: () => { foreignCalls++; } });
  assert.deepEqual(listToolsForRole({ ...COGNITION_ASSISTANT_ROLE, allowedTools: [...COGNITION_ASSISTANT_TOOLS, 'create_note'], skillToolCeiling: ['create_note'] }).map(item => item.name).sort(), [...COGNITION_ASSISTANT_TOOLS].sort());
  round = 0; responder = async () => ++round === 1 ? tool('foreign', 'create_note', { title: '禁止越界' }) : { content: '本窗口仅处理认知库，其他操作请到通用助手。' };
  await agent.send('顺便创建一篇笔记'); assert.equal(foreignCalls, 0);
  assert.throws(() => agent.ctx.navigate('home'), /仅允许认知库/);
  pass('closed tool catalog blocks cross-domain calls even with a widened role list; note/page ports also deny access');

  const ref = () => ({ recordId: 'lone', branchId: 'primary', nodeId: 'p', revisionId: latestCognition(file.records.find(record => record.id === 'lone')!).id });
  const edit = (): CognitionGraphEdit => {
    const current = latestCognition(file.records.find(record => record.id === 'lone')!).branches[0].graph.nodes[0];
    const condition = current.conditions?.length ? '对象和情境明确' : '输入信息可靠';
    return { action: 'update_node', target: ref(), text: `${current.text}适用于${condition}的情境。`, mainType: current.mainType, stance: 'endorsed',
      operation: 'add_conditions', reason: '用户要求补充适用条件', meaning: { interpretation: '仅为选中认识新增输入可靠条件，保留原文', preserved: [current.text],
        conditions: { before: current.conditions || [], changes: [{ kind: 'add', after: condition }] } } };
  };
  async function prepare() {
    round = 0; responder = async request => {
      if (++round === 1) return tool('baseline', 'query_cognition', { target: ref() });
      if (round === 2) return tool('preview', 'prepare_cognition_change', { edit: edit() });
      return tool('commit', 'commit_cognition_change', { proposalId: data(request, 'prepare_cognition_change').proposalId });
    };
    await agent.send('帮我给这项认识补充适用条件'); assert.ok(agent.view().pending, agent.view().error);
  }
  await prepare(); assert.equal(writes, 0); await agent.approve(false); assert.equal(writes, 0); assert.equal(agent.view().pending, null);
  await prepare(); responder = async () => ({ content: '已确认保存。' }); await agent.approve(true);
  assert.equal(writes, 1); assert.equal(agent.view().pending, null); assert.match(agent.view().messages.at(-1)!.content, /已按你确认/);
  assert.deepEqual(agent.view().work.candidates, []);
  pass('precise read → condition preview → real approval card → cancel/confirm stays in the dedicated session and only confirmed mutations write');

  await agent.focus(ref());
  for (let index = 0; index < 32; index++) { await prepare(); await agent.approve(false); }
  assert.equal(writes, 1);
  pass('repeated cancelled previews release their in-memory slots without exhausting the session or writing cognition');

  await agent.focus(ref()); await prepare();
  file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision,
    edit: { action: 'add_node', title: '并发', text: '其他窗口更新', mainType: '假设', stance: 'tentative', reason: '合成并发' } }, stamp());
  await agent.approve(true); assert.equal(writes, 1); assert.match(agent.view().error, /变化/); assert.equal(agent.view().pending, null);
  assert.equal((await executeTool('query_cognition', { offset: 8 }, {} as any)).ok, false, 'generic pagination cannot omit snapshot either');
  await agent.flush(); agent.dispose();
  agent = new CognitionAssistantSession({ callLlm: invoke }); await agent.initialize(); assert.equal(agent.view().work.query, undefined); assert.match(agent.view().notice, /版本已变化/);
  pass('concurrent library edits invalidate both approvals and restored browsing state; omitted-version continuation fails closed');

  const pendingState = { ...emptyCognitionAssistantState(), interrupted: true };
  tasks = applyAgentTaskStatePatch(tasks, { kind: 'cognition-assistant', state: pendingState });
  agent.dispose(); agent = new CognitionAssistantSession({ callLlm: invoke }); await agent.initialize();
  assert.equal(agent.view().pending, null); assert.match(agent.view().notice, /不会自动续跑或写入/);
  let release!: () => void, started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  responder = async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { content: 'stopped result must not be used' }; };
  const running = agent.send('继续讨论'); await start; agent.stop(); release(); await running;
  assert.match(agent.view().error, /已停止/); assert.equal(writes, 1);
  scope = 'other-synthetic-root'; await agent.send('继续'); assert.equal(agent.view().ready, false); assert.equal(agent.view().messages.length, 0);
  pass('restart never replays pending changes; stopping is session-local and a changed private root clears old dialogue before any further call');

  const unrelated = applyAgentTaskStatePatch(null, { kind: 'documents', jobs: [] });
  const withChat = applyAgentTaskStatePatch(unrelated, { kind: 'cognition-assistant', state: emptyCognitionAssistantState() });
  const withJobs = applyAgentTaskStatePatch(withChat, { kind: 'workflows', jobs: [] });
  assert.ok(withJobs.cognitionAssistant); assert.deepEqual(applyAgentTaskStatePatch(withJobs, { kind: 'cognition-assistant', state: null }).workflows, []);
  assert.throws(() => normalizeCognitionAssistantState({ ...emptyCognitionAssistantState(), work: { candidates: [], query: { filter: 'all', offset: 8 } } }));
  pass('native category patch codec preserves other job state, never stores executable tools/approvals and rejects malformed working memory');

  // Execute the actual task IPC callbacks with synthetic native ports, not a text-only assertion.
  const main = ts.createSourceFile('main.ts', readFileSync('src/electron/main.ts', 'utf8'), ts.ScriptTarget.ES2022, true);
  const handlers = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(main) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]) && ['user-state:load-agent-tasks', 'user-state:save-agent-tasks'].includes(node.arguments[0].text)) handlers.set(node.arguments[0].text, node.arguments[1].getText(main));
    ts.forEachChild(node, visit);
  }; visit(main);
  let disk = withJobs;
  const env = { referenceCallerAllowed: (event: any) => event.kind === 'main', isCognitionWindowCaller: (event: any) => event.kind === 'cognition', referenceEnvironmentSuspended: false,
    taskScope: () => 'native-test', referenceSourceWriteEpoch: 1, getUserStateDir: () => 'synthetic-directory', readUserStateFileIfExists: async () => JSON.stringify(disk),
    USER_STATE_FILES: { agentTasks: 'synthetic-tasks.json' }, normalizeAgentTaskState, applyAgentTaskStatePatch,
    path: { join: (...values: string[]) => values.join('/') }, userStateWriteQueues: new Map(),
    withRagSourceTransaction: async (_dirs: any, operation: any) => operation(), writeUserStateFileUnlocked: async (_dir: string, _name: string, raw: string) => { disk = JSON.parse(raw); } };
  const compile = (name: string) => new Function(...Object.keys(env), ts.transpileModule(`return (${handlers.get(name)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env));
  const read = compile('user-state:load-agent-tasks'), save = compile('user-state:save-agent-tasks');
  const projection = await read({ kind: 'cognition' }); assert.ok(projection.state.cognitionAssistant); assert.equal(projection.state.workflows, undefined); assert.deepEqual(projection.state.sequences, {});
  await assert.rejects(save({ kind: 'cognition' }, 'native-test', { kind: 'documents', jobs: [] }), /范围/);
  await assert.rejects(read({ kind: 'foreign' }), /不可用/);
  await save({ kind: 'cognition' }, 'native-test', { kind: 'cognition-assistant', state: emptyCognitionAssistantState() }); assert.deepEqual(disk.workflows, []);
  await assert.rejects(save({ kind: 'cognition' }, 'old-root', { kind: 'cognition-assistant', state: null }), /资料库/);
  pass('actual native IPC admits only the owned cognition window, projects only its session category, and refuses foreign-category/root writes while merging safely');
} finally {
  agent!.dispose(); globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Dedicated cognition assistant: ${checks} groups passed; actual runtime/controller/native callback paths, synthetic data and model stubs only.`);
