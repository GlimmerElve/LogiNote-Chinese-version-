import type { LlmCallRequest, LlmCallResponse, SceneSpec } from '../../src/types';
import { browserDefinition, browserTemplateDefinition, browserModelDefinition, browserResourceDefinition, browserRecordFormDefinition, browserGroupFormDefinition, browserListFormDefinition, browserNamedListFormDefinition, browserFreeTemplateDefinition, browserManualReuseDefinition } from './s2-browser-definition';
import { s2DesignFixtureResponse } from './s2-design-model';
import { reviewTaskDefinition, manualPromptDefinition } from './s2-review-task';
import { browserDeclaredFormDefinition } from './s2-browser-definition';
import { experimentDefinition, experimentImageDefinition, experimentMaterialDefinition } from './s2-experiment';

// Production scene-entry imports also reach the experiment module. This
// isolated boundary must never read a real configured model/provider.
export function resolveProvider(): never { throw new Error('Real model providers are disabled in isolated scene acceptance'); }

export type BrowserFixtureMode = 'explain' | 'edit' | 'execute' | 'delay' | 'host-failure';
export type BrowserFixtureScenario = 'records' | 'text-template' | 'model-test' | 'resources' | 'record-form' | 'group-form' | 'list-form' | 'named-list-form' | 'declared-form' | 'template-layout' | 'review-task' | 'manual-reuse' | 'manual-prompt' | 'experiment' | 'image-experiment' | 'material-experiment';
const experiments = ['experiment', 'image-experiment', 'material-experiment'];
export interface BrowserFixtureCall {
  id: number; stage: string; mode: BrowserFixtureMode; scenario: BrowserFixtureScenario; origin?: string; memoryWritable?: boolean;
  memoryEnabled?: boolean; abortedAtDispatch: boolean; status: 'pending' | 'returned' | 'failed';
  memoryRepair: boolean; responseRepair: boolean; skillIds: string[];
}
const listeners = new Set<() => void>();
const pending: Array<{ resolve: (value: LlmCallResponse) => void; response: LlmCallResponse; record: BrowserFixtureCall }> = [];
export const browserFixtureState = {
  synthetic: true, realModelCalls: 0, networkCalls: 0, persistentWrites: 0, memoryOnly: true,
  syntheticModelRequests: [] as Array<{ prompt: string; input: string; maxOutputTokens: number; imageIds?: string[] }>,
  mode: 'explain' as BrowserFixtureMode, scenario: 'records' as BrowserFixtureScenario, calls: [] as BrowserFixtureCall[], callCounts: {} as Record<string, number>,
  lastOrigin: undefined as string | undefined, lastMemoryWritable: undefined as boolean | undefined,
  settingsReads: 0, settingsMemoryOnly: true, storeReads: 0, storeWrites: 0,
  pendingResponses: 0, releasedResponses: 0, savedTemplates: [] as SceneSpec[],
  /** Actual readonly projection observed in production requests; not an independently committed memory ledger. */
  readonlyMemoryRecords: [] as unknown[], lastTriggeredExecutionStatus: undefined as string | undefined,
};
export function subscribeBrowserFixture(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notifyBrowserFixture() { listeners.forEach(listener => listener()); }
export function setBrowserFixtureMode(mode: BrowserFixtureMode) {
  if (!['explain', 'edit', 'execute', 'delay', 'host-failure'].includes(mode)) throw new Error('Unknown synthetic browser fixture mode');
  browserFixtureState.mode = mode; notifyBrowserFixture();
}
export function setBrowserFixtureScenario(scenario: BrowserFixtureScenario) {
  if (!['records', 'text-template', 'model-test', 'resources', 'record-form', 'group-form', 'list-form', 'named-list-form', 'declared-form', 'template-layout', 'review-task', 'manual-reuse', 'manual-prompt', ...experiments].includes(scenario)) throw new Error('Unknown synthetic browser fixture scenario');
  if (['resources', 'record-form', 'group-form', 'list-form', 'named-list-form', 'declared-form', 'template-layout', 'review-task', 'manual-reuse', 'manual-prompt'].includes(scenario)) browserFixtureState.mode = 'explain';
  browserFixtureState.scenario = scenario; notifyBrowserFixture();
}
export function releaseBrowserFixtureResponse(): boolean {
  const next = pending.shift(); if (!next) return false;
  browserFixtureState.pendingResponses = pending.length; browserFixtureState.releasedResponses++;
  next.record.status = 'returned'; next.resolve(next.response); notifyBrowserFixture(); return true;
}
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
function recordRequest(request: LlmCallRequest, input: Record<string, any>, signal?: AbortSignal): BrowserFixtureCall {
  if (request.workflow !== 'agent-scene-setup' || request.skipMemoryInjection !== true || request.skipProfileInjection !== true
    || request.tools?.length || request.images?.length) throw new Error('Synthetic browser boundary only accepts isolated S2 setup requests');
  const record: BrowserFixtureCall = { id: browserFixtureState.calls.length + 1, stage: String(input.stage ?? (input.origin && input.context?.canvas ? 'public-interaction' : 'unknown')), mode: browserFixtureState.mode, scenario: browserFixtureState.scenario,
    origin: input.origin, memoryWritable: input.memoryWritable, memoryEnabled: input.memoryEnabled,
    abortedAtDispatch: !!signal?.aborted, status: 'pending', memoryRepair: !!input.memoryRepair, responseRepair: !!input.responseRepair,
    skillIds: Array.isArray(input.intent?.skillIds) ? [...input.intent.skillIds] : [] };
  browserFixtureState.calls.push(record); browserFixtureState.callCounts[record.stage] = (browserFixtureState.callCounts[record.stage] ?? 0) + 1;
  if (typeof record.origin === 'string') browserFixtureState.lastOrigin = record.origin;
  if (typeof record.memoryWritable === 'boolean') browserFixtureState.lastMemoryWritable = record.memoryWritable;
  if (Array.isArray(input.workingMemory?.records)) browserFixtureState.readonlyMemoryRecords = structuredClone(input.workingMemory.records);
  notifyBrowserFixture(); return record;
}
function hostReply(input: Record<string, any>, scenario: BrowserFixtureScenario): string {
  const actual = input.triggeredExecution, workflow = actual?.workflow;
  const status = actual?.available === true && typeof workflow?.status === 'string' ? workflow.status : 'unavailable';
  browserFixtureState.lastTriggeredExecutionStatus = status;
  const identity = actual?.available === true && typeof actual.workflowRunId === 'string' ? `（${actual.workflowRunId}）` : '';
  if (status === 'succeeded' && (scenario === 'model-test' || experiments.includes(scenario))) {
    const test = Array.isArray(workflow.nodes) ? workflow.nodes.find((node: any) => node.nodeId === 'testModel') : undefined;
    return `合成协议回应：真实宿主本次运行${identity}为 succeeded，testModel节点状态为 ${test?.status ?? 'unavailable'}。输出由隔离合成传输生成，不是真实LLM回包或提示词效果验收。不自动评审、改图或追加调用，是否满足目标须另按明确指标判断。`;
  }
  if (status === 'succeeded' && ['text-template', 'template-layout'].includes(scenario)) {
    const render = Array.isArray(workflow.nodes) ? workflow.nodes.find((node: any) => node.nodeId === 'render') : undefined;
    const renderStatus = typeof render?.status === 'string' ? render.status : 'unavailable';
    return `合成协议回应：真实本地宿主本次运行${identity}状态为 succeeded，render节点状态为 ${renderStatus}。完整装配文本以界面真实产物为准；这里只做单遍字面装配，没有发送LLM请求，不代表模型回复或提示词效果。本轮不改图、不再运行、不写用户记忆。`;
  }
  if (status === 'succeeded') return `合成协议回应：真实本地宿主本次运行${identity}状态为 succeeded。它证明所选本地链路完成，不证明姓名、分数业务合格，也不证明真实模型语义理解；本轮不改图、不再运行、不写用户记忆。`;
  if (status === 'failed') return `合成协议回应：真实本地宿主本次运行${identity}状态为 failed。应查看界面保留的实际错误和节点记录；我不声称已展示成功，不重跑工具，不写用户记忆。`;
  return '合成协议回应：本轮没有可精确匹配的已结束宿主工作流记录，不能推断执行成功。保留已有画布和执行记录，不改图、不运行、不写用户记忆。';
}

/** Deterministic UI-boundary fixture. Mode is a test control, NOT semantic intent recognition. No fetch/settings/storage access. */
export async function callLLM(request: LlmCallRequest, options?: { signal?: AbortSignal }): Promise<LlmCallResponse> {
  const input = JSON.parse(request.userInput) as Record<string, any>;
  const record = recordRequest(request, input, options?.signal);
  try {
    if (options?.signal?.aborted) throw new DOMException('Synthetic request stopped', 'AbortError');
    let result: LlmCallResponse;
    if (input.stage === undefined && input.origin === 'user' && input.context?.canvas && input.scope) {
      result = response({ reply: '合成协议回应：按当前任务解释提示词与材料，保留现有内容和连线。', actions: [] });
    } else if (['understand', 'assemble', 'review'].includes(input.stage)) {
      const experiment = record.scenario === 'experiment' ? experimentDefinition : record.scenario === 'image-experiment' ? experimentImageDefinition : record.scenario === 'material-experiment' ? experimentMaterialDefinition : undefined;
      result = experiment && input.stage === 'assemble' ? response(structuredClone(experiment))
        : s2DesignFixtureResponse(request, structuredClone(experiment ?? (record.scenario === 'manual-prompt' ? manualPromptDefinition : record.scenario === 'declared-form' ? browserDeclaredFormDefinition : record.scenario === 'manual-reuse' ? browserManualReuseDefinition : record.scenario === 'review-task' ? reviewTaskDefinition : record.scenario === 'template-layout' ? browserFreeTemplateDefinition : record.scenario === 'named-list-form' ? browserNamedListFormDefinition : record.scenario === 'list-form' ? browserListFormDefinition : record.scenario === 'group-form' ? browserGroupFormDefinition : record.scenario === 'record-form' ? browserRecordFormDefinition : record.scenario === 'resources' ? browserResourceDefinition : record.scenario === 'model-test' ? browserModelDefinition : record.scenario === 'text-template' ? browserTemplateDefinition : browserDefinition)));
    }
    else if (input.stage === 'turn-understand') {
      if (input.origin === 'host-event' && record.mode === 'host-failure') throw new Error('Synthetic host interpretation failure');
      const host = input.origin === 'host-event', manual = ['resources', 'record-form', 'group-form', 'list-form', 'named-list-form', 'declared-form', 'template-layout', 'review-task', 'manual-reuse', 'manual-prompt'].includes(record.scenario), edit = !host && !manual && record.mode === 'edit', execute = !host && !manual && ['execute', 'host-failure'].includes(record.mode);
      result = response({ understanding: '合成浏览器模式选择，仅验证生产协议与界面状态，不是模型语义理解', desiredOutcome: host ? '读取实际宿主结果' : '执行显式选择的浏览器验收模式',
        actions: ['reply', ...(edit ? ['edit'] : []), ...(execute ? ['execute'] : [])], constraints: [record.scenario === 'model-test' ? '保留原文，模型测试预算与逐次请求分别确认；仅合成传输，不自动评审' : record.scenario === 'text-template' ? '保留四段合成文本原文，只做本地装配，修改与运行分别确认' : '保留用户原文，修改与运行分别确认'], questions: [], evaluation: 'advice',
        assistance: edit ? 'demonstrate' : 'scaffold', ...(!host && !experiments.includes(record.scenario) ? { skillIds: ['Types'] } : {}),
        // Deliberately invalid, unauthorized host sidecar verifies the REAL readonly guard, not fixture memory emulation.
        ...(host ? { memoryUpdate: { set: [{ id: 'ForgedHostDecision', kind: 'decision', text: '不可保存的合成宿主决定', quote: '不是用户原文', nodeIds: [] }], retire: [] } } : {}),
      });
    } else if (input.stage === 'turn-act') {
      if (input.origin === 'host-event' && record.mode === 'host-failure') throw new Error('Synthetic host interpretation failure');
      if (input.origin === 'host-event') result = response({ understanding: '只解读真实宿主完成通知', plan: '不改图、不执行、不修改本局记忆', reply: hostReply(input, record.scenario), commands: [],
        memoryUpdate: { retire: [{ id: 'ForgedHostDecision', quote: '系统通知不是用户同意', reason: '故意验证真实只读隔离' }] } });
      else if (record.scenario === 'declared-form') result = response({ understanding: '合成声明表单验收，不是语义识别', plan: '只解释，不改图、运行或评价',
        reply: '合成协议回应：按名称填写练习要求，应用失败时会标出具体问题，修改后再次应用；应用和运行分开，0、否与空值完整保留。本轮不替你操作。', commands: [] });
      else if (record.scenario === 'manual-prompt') result = response({ understanding: '合成空图提示词验收，不是语义识别', plan: '只解释，不代替添加、填写、运行或本人确认',
        reply: '合成协议回应：从普通库自己添加汇集、装配和本人确认步骤。按中文用途填写和排版，选择真实输出设置分支；运行与提交选择分开，保存重开必须重新确认。本轮不替你操作，也不评判提示词效果。', commands: [] });
      else if (record.scenario === 'manual-reuse') result = response({ understanding: '合成手动组合与复用验收，不是语义识别', plan: '只解释普通入口，不添加、填写、运行或确认',
        reply: '合成协议回应：从普通库选已有步骤，在具名表单填写并应用材料，按名称连接后另行运行。保存只留已应用设计；重新打开要开始新试验，不恢复资料许可、等待或结果。本轮不替你操作。', commands: [] });
      else if (record.scenario === 'review-task') result = response({ understanding: '合成组合任务验收，不是语义识别', plan: '仅解释，不读取、不代选、不确认、不运行',
        reply: '合成协议回应：先明确允许并在读取步骤选用参考资料。按名称编辑模板并应用后，单独运行两个结果目标；人工核对处展示完整文本，可讨论、不同意或取消。同意不是模型授权或质量评价，本轮不替你操作。', commands: [] });
      else if (record.scenario === 'template-layout') result = response({ understanding: '合成自由排版验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：用文字片段和具名材料引用自由排版；应用时更新原排版块，之后单独运行装配。装配完成只生成文本，不等于模型效果通过。本轮不修改、不运行、不评分。', commands: [] });
      else if (record.scenario === 'named-list-form') result = response({ understanding: '合成具名列表验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：按名称展开知识点或参考例子列表，逐项填写并明确应用，再独立运行查看。各列表和其他字段独立保留；展开不应用、应用不运行，不自动评分。', commands: [] });
      else if (record.scenario === 'list-form') result = response({ understanding: '合成普通列表验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：普通列表逐项填写，不需要字段名称；应用才更新材料，再单独运行查看。空文字、0、否和空值分别保留；不自动转表格，本轮不改图、不运行、不评分。', commands: [] });
      else if (record.scenario === 'group-form') result = response({ understanding: '合成信息分组验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：按学习者信息与练习设置分组填写，应用后才更新原始材料，再独立运行查看指定组。各组名称独立，0、否、空值和缺失不能混同；本轮不改图、不运行、不评分。', commands: [] });
      else if (record.scenario === 'record-form') result = response({ understanding: '合成记录表单验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：在整理我的记录中逐条填写；只有点击应用才更新材料，之后另行选择展示目标并运行。记录字段可以不同，未填字段不会补成空值。本轮不改图、不运行、不评分。', commands: [] });
      else if (record.scenario === 'resources') result = response({ understanding: '合成资料界面验收，不是语义识别', plan: '不改图，不执行，不评分',
        reply: '合成协议回应：请用本局资料入口逐份允许，再在读取步骤按名称选用，最后手动运行。撤回和失效不会抹除历史结果；已有输出不代表本次读取成功。两类权限独立，本轮不改图、不运行、不评分。', commands: [] });
      else if (experiments.includes(record.scenario) && record.mode === 'edit') result = response({ understanding: '合成实验协作回应，不是语义识别', plan: '此例已有完整链路，不凭空补线或执行',
        reply: '合成协议回应：此例已连接完整。你可以修改任意内容块，或在组装节点调整顺序和段落标题，再自行运行；本轮不擅自修改或发送。', commands: [] });
      else if (record.mode === 'edit') {
        const links = input.current?.execution?.links ?? input.current?.executionLinks ?? [];
        const link = record.scenario !== 'records'
          ? { source: { nodeId: 'bindConstraints', portId: 'variables' }, target: { nodeId: 'render', portId: 'variables' } }
          : { source: { nodeId: 'rows', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } };
        const exists = links.some((item: any) => item.source?.nodeId === link.source.nodeId && item.source?.portId === link.source.portId && item.target?.nodeId === link.target.nodeId && item.target?.portId === link.target.portId);
        result = response({ understanding: '显式合成协作模式', plan: '只提出待确认补线，不覆盖输入和笔记，不执行',
          reply: exists ? '合成协议回应：目标连线已存在，无需重复修改；没有运行。' : '合成协议回应：提出一条最小补线建议，输入与笔记原文保持不变；尚未应用或运行，请使用界面的独立确认。',
          commands: exists ? [] : [{ op: 'connect-ports', link }],
        });
      } else if (['execute', 'host-failure'].includes(record.mode)) result = response(record.scenario === 'model-test' || experiments.includes(record.scenario)
        ? { understanding: '显式合成受控模型测试申请', plan: '仅申请testModel及必要上游；本申请不是预算或逐次发送授权',
          reply: '合成协议回应：仅提出模型测试目标，尚未执行。需要本局独立预算和实际完整提示词逐次确认；这里的模型传输为合成，不验证真实提示词效果。', commands: [], executionRequest: { targetNodeIds: ['testModel'], reason: '合成协议验收受控模型节点，预算和发送分别由用户确认，不自动评审或重试' } }
        : record.scenario === 'text-template'
        ? { understanding: '显式合成本地装配申请模式', plan: '仅申请render及真实上游，等待独立确认',
          reply: '合成协议回应：仅申请本地文本装配目标，尚未运行，不调用LLM；执行须由界面单独确认。', commands: [], executionRequest: { targetNodeIds: ['render'], reason: '合成浏览器验收，仅本地变量绑定和单遍装配，等待独立确认' } }
        : { understanding: '显式合成申请执行模式', plan: '申请本地展示目标，等待用户单独确认',
          reply: '合成协议回应：仅申请当前本地表格展示目标，尚未运行；执行须由界面单独确认。', commands: [], executionRequest: { targetNodeIds: ['view'], reason: '合成浏览器验收，仅本地解析、转换和展示，等待独立确认' } });
      else if (experiments.includes(record.scenario)) result = response({ understanding: '合成实验解释，不是模型语义识别', plan: '只解释内容、材料与结果，不改图、不运行、不评分',
        reply: '合成协议回应：内容块只存原文，组装节点决定顺序和用途，生成完整提示词。待处理文本、资料或原图单独传给测试节点；修改后由你运行并核对实际请求。结果先原样展示，需要时再请助手分析。此页是合成传输，不能证明真实模型效果。', commands: [] });
      else if (record.scenario === 'model-test') result = response({ understanding: '合成解释模式，不是模型语义识别', plan: '只解释装配、逐次模型确认和评价边界，不修改或运行',
        reply: '合成协议回应：本地先将角色、任务和约束装入模板。模型节点默认关闭；用户先批准固定模型和预算，再核对每次实际完整提示词与试验输入，才能发送。拒绝不会发送；截断结果不能交给下游。本示例使用合成传输，不是真实LLM回包，不自动评分、改图或追加调用。', commands: [] });
      else if (record.scenario === 'text-template') result = response({ understanding: '合成解释模式，不是模型语义识别', plan: '解释单遍字面装配与模型测试的区别，不修改或运行',
        reply: '合成协议回应：角色、任务和约束像三个标签，bind把各段原文放入字符串字典，render只把模板中的同名占位符替换一次。变量值里的$&和{{literal}}仍是字面原文，不会递归展开或执行。装好信不等于寄出：这里不调用LLM，也不验证提示词效果。本轮保留四段原文，不改图、不运行、不评分。', commands: [] });
      else result = response({ understanding: '合成解释模式，不是模型语义识别', plan: '解释类型边界，不修改、执行或正式评价',
        reply: '合成协议回应：文本像封好的信，解析得到可读取的JSON值，再把记录整理为表格。打开信封不代表内容符合业务标准；请观察不同端口类型。原文和练习保留，本轮不直接给完整补线答案，不改图、不运行、不评分。', commands: [] });
      if (record.mode === 'delay') {
        // Intentionally ignore later abort: the real production abort/staleness gates must reject this late response.
        return await new Promise<LlmCallResponse>(resolve => { pending.push({ resolve, response: result, record }); browserFixtureState.pendingResponses = pending.length; notifyBrowserFixture(); });
      }
    } else if (input.stage === 'turn-proposal-review') {
      const query = Array.isArray(input.sources) ? input.sources.find((source: any) => source.id === 'query') : undefined;
      if (!query || typeof query.text !== 'string' || !query.text.trim()) throw new Error('Synthetic proposal review needs actual query source');
      result = response({ verdict: 'accept', reason: '合成协议桩：允许向用户展示待确认方案，不代表真实模型语义复核', evidence: [{ sourceId: query.id, quote: query.text.slice(0, 500) }] });
    } else throw new Error('Unknown synthetic browser S2 request stage');
    record.status = 'returned'; notifyBrowserFixture(); return result;
  } catch (error) { record.status = 'failed'; notifyBrowserFixture(); throw error; }
}
