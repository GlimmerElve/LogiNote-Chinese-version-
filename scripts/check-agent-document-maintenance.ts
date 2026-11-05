import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { UploadedDocument } from '../src/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { registerDocumentMaintenanceTools } from '../src/services/agent/tools/documentMaintenanceTools';
import { documentMaintenanceIdentity, validateDocumentMaintenance, DOCUMENT_MAINTENANCE_TOOLS } from '../src/services/documentMaintenance';
import { createAgentApprovalBinding, validateAgentApprovalBinding } from '../src/services/agent/approvalBinding';
import { executeTool, getTool, listToolsForRole, describeToolConfirmation, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { COGNITION_ASSISTANT_ROLE } from '../src/services/agent/cognitionAssistantPolicy';
import { AGENT_OPERATION_TOOLS, AGENT_CAPABILITY_DOMAINS } from '../src/services/agent/capabilities';
import { agentActionRecoveryReason } from '../src/services/agent/actionOutcome';

const doc = (id: string): UploadedDocument => ({ id, fileName: `${id}.pdf`, fileType: 'pdf', extension: '.pdf',
  size: 100, uploadAt: '2026-10-23T00:00:00Z', status: 'ready', parseStatus: 'ready', indexable: true, chunkCount: 2, totalChars: 300 });
let docs = [doc('doc-one'), doc('doc-two')], context = 'scope-a', writes = 0, starts = 0, failId = '';
let active = false, expectedAction = 'continue', modelMode = 'local-only', model = { id: 'local', name: '本机', apiType: 'ollama', baseUrl: 'http://localhost:11434',
  selectedModel: 'synthetic', models: ['synthetic'], apiKey: 'PRIVATE_SYNTHETIC_KEY', enabled: true, createdAt: '' };
const deps = {
  list: async () => structuredClone(docs), context: async () => context,
  maintain: async (input: any) => {
    const target = docs.find(item => item.id === input.documentId);
    validateDocumentMaintenance(input, target, context);
    if (input.documentId === failId) throw new Error('synthetic save failure');
    writes++;
    if (input.operation === 'category') target!.category = input.category || undefined;
    else target!.status = 'pending';
  },
  jobs: { ensureReady: async () => context, getSnapshot: () => active ? [{ id: 'running', docId: 'doc-one', status: 'running' }] : [] },
  start: async (target: UploadedDocument, action: string, options: any) => {
    assert.equal(action, expectedAction); assert.equal(options.expectedContext, context);
    assert.equal(options.expectedConfiguration, JSON.stringify([model, { enabled: true, processingMode: modelMode }]));
    starts++; return { id: `job-${target.id}`, status: 'queued' };
  },
  loadModels: async () => {}, provider: () => model,
  settings: async () => ({ enabled: true, processingMode: modelMode }),
} as unknown as NonNullable<Parameters<typeof registerDocumentMaintenanceTools>[0]>;
registerDocumentMaintenanceTools(deps);
const ctx = {} as AgentRuntimeContext;
let groups = 0;
const pass = (s: string) => { console.log(`PASS ${s}`); groups++; };
async function preview(name: string, args: Record<string, unknown>) {
  const call = { id: `call-${groups}`, name, arguments: args };
  const binding = await createAgentApprovalBinding(call, ctx);
  return { call, binding, ...describeToolConfirmation(getTool(name)!, args, ctx) };
}
async function approved(item: Awaited<ReturnType<typeof preview>>, signal?: AbortSignal) {
  await validateAgentApprovalBinding(item as any, ctx);
  const outcome = await executeTool(item.call.name, item.call.arguments, ctx, { userApproved: true, signal });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.result as any;
}
const category = { documentIds: ['doc-one', 'doc-two'], category: '概率论' };
const first = await preview('update_document_categories', category);
assert.equal(writes, 0); assert.equal(starts, 0);
assert.equal(toolRequiresApproval(getTool(first.call.name)!, category, ctx), true);
assert.equal((await executeTool(first.call.name, category, ctx)).ok, false);
pass('预览零写入，资料维护不继承自动模式权限');
const changed = await approved(first);
assert.equal(changed.completed, true); assert.equal(writes, 2);
assert.deepEqual(docs.map(item => item.category), ['概率论', '概率论']);
assert.equal(agentActionRecoveryReason('资料分类已保存', 'resource-curation', [{ ok: true, call: first.call, result: changed }] as any), undefined);
pass('真实确认绑定→分类批量保存，绑定和正文不变');
const stale = await preview('update_document_categories', { ...category, category: '' });
docs[0].category = '用户新分类';
await assert.rejects(approved(stale), /变化/); assert.equal(writes, 2);
const cross = await preview('update_document_categories', category); context = 'scope-b';
await assert.rejects(approved(cross), /变化/); assert.equal(writes, 2);
pass('确认后人工改分类或切换资料库均拒绝执行');
for (const bad of [{ documentIds: ['doc-one', 'doc-one'], category: '' }, { ...category, path: 'D:/arbitrary' },
  { documentIds: ['doc-missing'], category: '' }, { ...category, category: 'x\ny' }]) await assert.rejects(preview('update_document_categories', bad));
const partial = await preview('update_document_categories', category); failId = 'doc-two';
const partialResult = await approved(partial); failId = '';
assert.deepEqual(partialResult.results.map((x: any) => x.status), ['saved', 'failed']); assert.equal(partialResult.completed, false);
pass('非法/缺失ID拒绝；部分持久化失败按逐项结果报告');
const indexing = await preview('start_document_processing', { documentIds: ['doc-one'], operation: 'body-index' });
const indexed = await approved(indexing); assert.equal(indexed.completed, false); assert.equal(indexed.results[0].status, 'queued'); assert.equal(starts, 0);
await assert.rejects(preview('start_document_processing', { documentIds: ['doc-one'], operation: 'body-index' }), /已在处理/);
docs[0].status = 'ready'; active = true;
await assert.rejects(preview('start_document_processing', { documentIds: ['doc-one'], operation: 'body-index' }), /已有论证任务/); active = false;
pass('正文索引只入队不冒称完成，不触发模型或重复索引/并行论证');
model = { ...model, apiType: 'openai-compatible', baseUrl: 'https://synthetic.invalid', name: '合成远程' };
await assert.rejects(preview('start_document_processing', { documentIds: ['doc-one'], operation: 'argument-graph' }), /本机模式/);
modelMode = 'allow-cloud';
const graph = await preview('start_document_processing', { documentIds: ['doc-one', 'doc-two'], operation: 'argument-graph' });
assert.match(graph.description!, /远程/); assert.ok(!JSON.stringify(graph).includes(model.apiKey)); assert.equal(starts, 0);
const queued = await approved(graph); assert.equal(starts, 2); assert.equal(queued.completed, false);
assert.deepEqual(queued.results.map((x: any) => x.jobId), ['job-doc-one', 'job-doc-two']);
assert.match(agentActionRecoveryReason('已生成论证图', 'resource-curation', [{ ok: true, call: graph.call, result: queued }] as any)!, /启动回执/);
assert.equal(agentActionRecoveryReason('已启动后台处理，请等待队列结果。', 'resource-curation', [{ ok: true, call: graph.call, result: queued }] as any), undefined);
const completedTrace = [{ ok: true, call: graph.call, result: queued }, { ok: true, call: { name: 'query_agent_jobs', arguments: {} },
  result: { tasks: queued.results.map((row: any) => ({ id: row.jobId, status: 'completed', scope: { docId: row.documentId } })) } }];
assert.equal(agentActionRecoveryReason('论证图已完成并保存', 'resource-curation', completedTrace as any), undefined);
completedTrace[1].result.tasks.pop();
assert.match(agentActionRecoveryReason('已生成论证图', 'resource-curation', completedTrace as any)!, /启动回执/);
pass('批量论证一次确认显示远程范围、不泄露密钥，复用后台队列返回真实任务ID');
const changedModel = await preview('start_document_processing', { documentIds: ['doc-one'], operation: 'argument-graph' });
model.selectedModel = 'other'; await assert.rejects(approved(changedModel), /变化/); assert.equal(starts, 2);
docs[0].documentGraphProgress = { version: 'v5.0', completedWindows: 1, totalWindows: 1, published: true, nodes: 1, entities: 0, unresolved: 0 };
await assert.rejects(preview('start_document_processing', { documentIds: ['doc-one'], operation: 'argument-graph' }), /已经完成/);
docs[0].documentGraphProgress.stale = true;
await assert.rejects(preview('start_document_processing', { documentIds: ['doc-one'], operation: 'argument-graph' }), /待重建/);
pass('模型变化、已完成图或旧版本图拒绝；不会自动重建或重置范围');
const combined = await preview('start_document_processing', { documentIds: ['doc-one'], operation: 'body-and-argument' });
assert.match(combined.description!, /先本地重建正文索引/); assert.match(combined.description!, /替换旧图/);
expectedAction = 'all';
const combinedResult = await approved(combined); expectedAction = 'continue';
assert.equal(starts, 3); assert.equal(combinedResult.completed, false);
pass('明确选择组合操作后一次确认串联正文索引与新图生成，替换范围可见，不把入队当完成');
docs[0].documentGraphProgress = undefined;
const stopped = await preview('start_document_processing', { documentIds: ['doc-one'], operation: 'argument-graph' });
const controller = new AbortController(); controller.abort();
await assert.rejects(approved(stopped, controller.signal)); assert.equal(starts, 3);
for (const name of DOCUMENT_MAINTENANCE_TOOLS) assert.ok(AGENT_OPERATION_TOOLS.includes(name));
assert.ok(AGENT_CAPABILITY_DOMAINS.resources.tools.includes('start_document_processing'));
assert.ok(AGENT_CAPABILITY_DOMAINS.workflows.tools.includes('start_document_processing'));
assert.equal(listToolsForRole({ ...COGNITION_ASSISTANT_ROLE, allowedTools: [...DOCUMENT_MAINTENANCE_TOOLS] }).length, 0);
assert.notEqual(documentMaintenanceIdentity(doc('doc-one')), documentMaintenanceIdentity({ ...doc('doc-one'), category: '新分类' }));
pass('停止信号阻止启动，发现目录已注册，专用认知角色不能借此扩大权限');

// Execute the actual Electron admission callback with memory I/O, not Electron or real files.
const mainSource = readFileSync('src/electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.ES2022, true);
let callback = '';
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' && node.arguments[0]?.getText(ast) === "'ragDocs:maintain'") callback = node.arguments[1].getText(ast);
  ts.forEachChild(node, visit);
};
visit(ast); assert.ok(callback);
const executable = ts.transpileModule(`const handler = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const host = { documents: [doc('doc-host')], changeScope: false, suspended: false, queued: [] as string[], writes: 0 };
const handler = new Function('ports', 'validateDocumentMaintenance', `
  let maintenanceLane = Promise.resolve(), backgroundGeneration = 1;
  const listDocumentsWithGraphProgress = async () => { if (ports.changeScope) backgroundGeneration++; return ports.documents; };
  const updateManifest = async (id, patch) => { ports.writes++; Object.assign(ports.documents.find(d=>d.id===id), patch); };
  const enqueueVectorization = id => ports.queued.push(id), notifyRagChanged = () => {};
  let referenceEnvironmentSuspended = ports.suspended;
  ${executable}
  return handler;
`)(host, validateDocumentMaintenance);
const hostCommand = { documentId: 'doc-host', expectedContext: '1', expectedIdentity: documentMaintenanceIdentity(host.documents[0]), operation: 'body-index' as const };
host.changeScope = true; await assert.rejects(handler({}, hostCommand), /变化/); assert.equal(host.writes, 0);
host.changeScope = false;
// New isolated main-process session with a current context.
const hostCurrent = { ...hostCommand, expectedContext: '2' };
await handler({}, hostCurrent); assert.equal(host.writes, 1); assert.deepEqual(host.queued, ['doc-host']);
await assert.rejects(handler({}, hostCurrent), /变化|已在处理/); assert.equal(host.writes, 1);
pass('真实Electron维护回调：异步读取期间切库零写入，当前快照仅入队一次，重复请求拒绝');
console.log(`agent document maintenance: ${groups} groups passed; synthetic only, no model/network/vault`);
