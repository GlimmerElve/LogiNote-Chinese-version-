import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import { researchPlanWeb, planSearchQueries } from '../src/electron/planWebResearch';
import { WebApiError } from '../src/electron/webAcquisition';
import { collectPlanResearch, preparePlanResearch, planResearchSubject, validatePlanResearch, checkPlanResearchCitations, planResearchContext, type PlanResearchBundle, type PlanResearchPreparation } from '../src/services/planResearch';
import { assertGeneratedPlanCoreScope, PLAN_CORE_SCOPE_RULES } from '../src/services/planCoreScope';
import { registerPlanTools } from '../src/services/agent/tools/planTools';
import { getTool, executeTool } from '../src/services/agent/toolRegistry';
import { getAgentSkill } from '../src/services/agent/skillRegistry';
import { rememberPlanResearch, readPlanResearch } from '../src/services/agent/planResearchReceipts';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { buildProjectPlanNotes } from '../src/services/planAdjustmentService';
import { buildPublishedPlanEditorValue, replacePublishedPlanFromEditor } from '../src/services/publishedPlanEditor';
import { assertOptionalBackupNoteData } from '../src/services/noteJsonBackupValidation';
import { serializeMetadata, deserializeVault, markdownFileMap } from '../src/services/vaultFsService';

globalThis.fetch = async () => assert.fail('offline fixtures must never call a real model/search API');
const subject = '合成统计学', now = new Date('2026-10-31T03:00:00Z');
const body = `${subject}课程大纲，必要先修、学习目标和能力验收的合成材料。`.repeat(40);
const bundle: PlanResearchBundle = { subject, retrievedAt: now.toISOString(), queries: ['synthetic syllabus'], warnings: [],
  sources: [{ id: 'P1', title: '合成大纲', url: 'https://curriculum.example.org/syllabus', excerpt: body.slice(0, 1500), coverage: 'page-excerpt' }] };
const core = { key: 'core', title: '核心20%：统计推断闭环', startDate: '2026-11-02', dueDate: '2026-11-04',
  outcome: '独立解释一份置信区间 [P1]', children: [
    { key: 'leaf', title: '解释置信区间', startDate: '2026-11-02', dueDate: '2026-11-02', outcome: '独立解释一个置信区间', children: [] },
  ] };
const expansion = { key: 'more', title: '扩展：高级模型', startDate: '2026-11-05', dueDate: '2026-11-06', outcome: '核心验收通过后解释一个高级模型', children: [] };
const root = { key: 'root', title: '合成计划', startDate: '2026-11-02', dueDate: '2026-11-06', children: [core, expansion] };
let groups = 0;
const pass = (message: string) => { groups++; console.log(`PASS ${message}`); };

{
  assertGeneratedPlanCoreScope(root.children);
  assertGeneratedPlanCoreScope([core]); // A tiny topic must not invent 80% expansion.
  assert.throws(() => assertGeneratedPlanCoreScope([{ ...core, title: '普通阶段' }]), /核心20%/);
  assert.doesNotThrow(() => assertGeneratedPlanCoreScope([{ ...core, outcome: undefined }]));
  assert.doesNotThrow(() => assertGeneratedPlanCoreScope([{ ...core, outcome: '独立解释置信区间' }]));
  assert.throws(() => assertGeneratedPlanCoreScope([{ ...core, title: '核心20%：' }]), /具体项目名称/);
  assert.throws(() => assertGeneratedPlanCoreScope([expansion, core]), /之前/);
  assert.throws(() => assertGeneratedPlanCoreScope([core, { ...expansion, startDate: '2026-11-02' }]), /结束之前/);
  assert.match(PLAN_CORE_SCOPE_RULES, /必要先修.*硬性必修/);
  assert.match(PLAN_CORE_SCOPE_RULES, /不承诺/);
  pass('新AI草图由节点表达核心/扩展与先后顺序，无额外核心说明或四段必填；不机械凑比例，不改旧计划契约');
}
{
  let count = 0;
  const result = await researchPlanWeb(subject, async () => assert.fail('API is supported'), undefined, {
    search: async (query: string, workflow: string, options: any) => {
      assert.equal(workflow, 'plan-generation'); assert.equal(options.needContent, true); assert.ok([...query].length <= 128);
      count++; return [1, 2].map(n => ({ title: `source ${count}-${n}`, url: `https://source${count}-${n}.example.org/syllabus`, content: body, snippet: 'not evidence' }));
    }, fetchPage: async () => assert.fail('already has body'),
  } as any, now);
  assert.equal(count, 3); assert.equal(result.sources.length, 6);
  assert.deepEqual(result.sources.map(item => item.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.ok(planSearchQueries('长'.repeat(120)).every(query => [...query].length <= 128));
  assert.throws(() => planSearchQueries('私人\n正文'));
  pass('公开主题有界三方向检索，绑定规划供应商、最多6个正文来源，不读取本地库');
}
{
  const mixed = [
    { title: '   ', url: 'https://invalid.example.org/a', content: body },
    { title: '错误协议', url: 'ftp://invalid.example.org/a', content: body },
    { title: '坏链接', url: 'not a url', content: body },
    { title: '合成课程', url: 'https://valid.example.org/a', content: body },
  ];
  const result = await researchPlanWeb(subject, async () => assert.fail('valid API source should survive'), undefined,
    { search: async () => mixed } as any, now);
  assert.deepEqual(result.sources.map(source => [source.id, source.title]), [['P1', '合成课程']]);
  assert.ok(result.warnings.some(warning => warning.includes('不完整')));
  const fallback = await researchPlanWeb(subject, async () => mixed.map(item => ({ ...item, type: 'web' as const, sourceId: 'fixture', snippet: item.content })), undefined,
    { search: async () => null } as any, now);
  assert.deepEqual(fallback.sources.map(source => source.id), ['P1']);
  assert.equal(fallback.sources[0].url, 'https://valid.example.org/a');
  await assert.rejects(researchPlanWeb(subject, async () => [], undefined, { search: async () => mixed.slice(0, 3) } as any, now), /已暂停/);
  pass('不合格来源逐条跳过，保留可用材料并重新连续编号；全部无效时仍明确暂停');
}
{
  let browserCalls = 0;
  const browser = async () => { browserCalls++; return [{ sourceId: 'web', type: 'web' as const, title: 'browser', url: bundle.sources[0].url, snippet: body }]; };
  for (const search of [async () => null, async () => [], async () => { throw new WebApiError(503, 'temporary'); }]) {
    const result = await researchPlanWeb(subject, browser, undefined, { search } as any, now);
    assert.equal(result.sources[0].id, 'P1');
  }
  assert.equal(browserCalls, 3);
  await assert.rejects(researchPlanWeb(subject, async () => [], undefined, { search: async () => [] } as any), /已暂停/);
  await assert.rejects(researchPlanWeb(subject, async () => assert.fail('auth failure must not bypass provider'), undefined,
    { search: async () => { throw new WebApiError(401, 'unauthorized'); } } as any), /unauthorized/);
  let reads = 0;
  await assert.rejects(researchPlanWeb(subject, async () => [], undefined, {
    search: async () => [{ title: 'snippet only', url: bundle.sources[0].url, snippet: body, content: '' }],
    fetchPage: async () => { reads++; throw new WebApiError(404, 'no page'); },
  } as any), /已暂停/);
  assert.ok(reads <= 6);
  pass('不支持/临时故障/空正文可浏览器后备；鉴权错误不绕过，无正文明确暂停，搜索摘要不冒充证据');
}
{
  for (const failure of [new WebApiError(503, 'temporary'), new DOMException('timeout', 'TimeoutError'), null]) {
    let calls = 0;
    const result = await researchPlanWeb(subject, async () => assert.fail('validated evidence must not be discarded or wait for another route'), undefined, {
      search: async () => {
        if (++calls === 1) return [{ title: '有效来源', url: bundle.sources[0].url, content: body }];
        if (failure) throw failure;
        return null;
      },
    } as any, now);
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0].id, 'P1');
    assert.ok(result.warnings.some(warning => warning.includes('部分联网检索未完成')));
  }
  const stopped = new AbortController();
  await assert.rejects(researchPlanWeb(subject, async () => assert.fail('Stop is not a fallback'), stopped.signal, {
    search: async () => { stopped.abort(); throw stopped.signal.reason; },
  } as any, now), error => (error as Error).name === 'AbortError');
  pass('先成功再503/超时/接口不支持时保留合格来源，不再清空或额外等待网页后备；主动停止仍中断');
}
{
  for (const error of [new Error('IPC network failed'), new WebApiError(401, 'unauthorized'), new Error('规划来源材料不完整')]) {
    const prepared = await preparePlanResearch(subject, undefined, { collect: async () => { throw error; } });
    assert.equal(prepared.research, undefined); assert.match(prepared.notice!, /未联网核实/);
  }
  const invalid = await preparePlanResearch(subject, undefined, { collect: async () => ({ ...bundle, sources: [] }) });
  assert.equal(invalid.research, undefined);
  let timedOutSignal: AbortSignal | undefined;
  const timeout = await preparePlanResearch(subject, undefined, { timeoutMs: 5, collect: async (_subject, signal) => {
    timedOutSignal = signal; return new Promise(() => {}); // Simulate a bridge which ignores cancellation.
  } });
  assert.equal(timeout.research, undefined); assert.equal(timedOutSignal!.aborted, true);
  const stop = new AbortController();
  const pending = preparePlanResearch(subject, stop.signal, { collect: async () => new Promise(() => {}) });
  stop.abort(); await assert.rejects(pending, error => (error as Error).name === 'AbortError');
  await assert.rejects(preparePlanResearch('private\ntext', undefined, { collect: async () => assert.fail('invalid public subject must not be sent') }));
  assert.deepEqual((await preparePlanResearch(subject, undefined, { collect: async () => bundle })).research, bundle);
  pass('草图专用降级：网络/鉴权/资料校验失败及超时不中断，严格研究接口不放宽，停止不触发离线生成');
}
{
  validatePlanResearch(bundle, subject);
  checkPlanResearchCitations('依据 [P1]', bundle);
  assert.throws(() => checkPlanResearchCitations('伪造 [P9]', bundle));
  assert.throws(() => checkPlanResearchCitations('没有引用', bundle));
  assert.throws(() => checkPlanResearchCitations('离线伪造 [P1]'));
  assert.throws(() => validatePlanResearch({ ...bundle, sources: [] }, subject));
  assert.throws(() => validatePlanResearch({ ...bundle, sources: [{ ...bundle.sources[0], url: 'javascript:alert(1)' }] }, subject));
  assert.match(planResearchContext(bundle), /不可信数据/);
  assert.match(planResearchContext(), /未联网核实/);
  pass('来源编号、正文、协议和离线标注校验，网页不作为指令或固定二八比例的证据');
}
const oldWindow = (globalThis as any).window;
try {
  let searched = 0, canceled = 0, release!: (value: unknown) => void;
  (globalThis as any).window = { electronAPI: { planResearch: {
    search: async () => { searched++; return new Promise(resolve => { release = resolve; }); }, cancel: async () => { canceled++; },
  } } };
  const abort = new AbortController(), pending = collectPlanResearch(subject, abort.signal);
  await Promise.resolve(); abort.abort();
  await assert.rejects(pending, error => (error as Error).name === 'AbortError');
  assert.equal(searched, 1); assert.equal(canceled, 1); release(bundle);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(collectPlanResearch(subject, stopped.signal)); assert.equal(searched, 1);
  pass('渲染端取消立即生效并传给主进程，迟到响应不能复活，已停止请求不发网');

  registerPlanTools();
  let imported: any;
  const ctx = { getConversationId: () => 'synthetic-chat', getPlanDraftSession: () => null,
    createProjectPlan: async (tree: any, meta: any) => { imported = { tree, meta }; return { draftImported: true }; } } as unknown as AgentRuntimeContext;
  (globalThis as any).window.electronAPI.planResearch.search = async (topic: string) => { assert.equal(topic, subject); return bundle; };
  const evidence = await executeTool('research_learning_plan', { subject }, ctx);
  assert.equal(evidence.ok, true); assert.ok(getAgentSkill('plan-planning')?.allowedTools.includes('research_learning_plan'));
  assert.equal(getTool('research_learning_plan')!.permission, 'readonly');
  const researchId = (evidence.result as any).researchId;
  assert.equal((await executeTool('create_project_plan', { root }, ctx)).ok, false);
  const draft = await executeTool('create_project_plan', { root, researchId, planMeta: { summary: '核心先修 [P1]' } }, ctx);
  assert.equal(draft.ok, true, draft.error); assert.deepEqual(imported.meta.research, bundle);
  assert.equal((await executeTool('create_project_plan', { root, researchId }, { ...ctx, getConversationId: () => 'other-chat' })).ok, false);
  const id = rememberPlanResearch(ctx, bundle, 1000);
  assert.throws(() => readPlanResearch(ctx, id, 1000 + 61 * 60_000), /有效规划/);
  const offlineRoot = JSON.parse(JSON.stringify(root).replaceAll(' [P1]', ''));
  const offline = await executeTool('create_project_plan', { root: offlineRoot, offlineDraft: true, planMeta: { summary: '未联网核实' } }, ctx);
  assert.equal(offline.ok, true, offline.error); assert.equal(imported.meta.research, undefined);
  pass('实际Agent工具：先研究后导入、可信收据隔离/过期、拒绝伪造引用；离线明确标注，仍只是编辑器草稿');
} finally { (globalThis as any).window = oldWindow; }

{
  let id = 0;
  const built = buildProjectPlanNotes([], root, now.toISOString(), () => `synthetic-${++id}`, { schemaVersion: 2, status: 'active', dailyStudyMinutes: 60, research: bundle });
  const rootId = built.summary.rootNoteId;
  const reloaded = deserializeVault(serializeMetadata(built.notes), markdownFileMap(built.notes));
  const reopened = buildPublishedPlanEditorValue(reloaded, rootId)!;
  assert.deepEqual(reopened.planMeta.research, bundle);
  assert.equal(reopened.tree[0].children[0].outcome, core.outcome);
  assert.equal(reopened.tree[0].children[0].children[0].outcome, core.children[0].outcome);
  const workspace = await executeTool('query_plan_workspace', { rootProjectId: rootId }, { getNotes: () => reloaded } as unknown as AgentRuntimeContext);
  assert.equal(workspace.ok, true, workspace.error);
  assert.equal((workspace.result as any).projects.find((project: any) => project.title === core.title).outcome, core.outcome);
  reopened.tree[0].children[0].outcome += '（用户修订）';
  const changed = replacePublishedPlanFromEditor(built.notes, rootId, reopened.tree, { ...reopened.planMeta, research: undefined }, now.toISOString());
  const again = buildPublishedPlanEditorValue(deserializeVault(serializeMetadata(changed.notes), markdownFileMap(changed.notes)), rootId)!;
  assert.match(again.tree[0].children[0].outcome!, /用户修订/);
  assert.equal(again.planMeta.research, undefined);
  assert.equal(built.notes.find(note => note.id === rootId)!.planMeta!.research!.subject, subject, 'no pre-save mutation');
  built.notes.forEach(note => assertOptionalBackupNoteData(note));
  assert.throws(() => assertOptionalBackupNoteData({ ...built.notes[0], planMeta: { ...built.notes[0].planMeta, research: { sources: null } } }));
  pass('真实构建→序列化→重开→编辑保存→重开，核心与叶子验收不丢失；来源可替换/移除，旧快照不被污染');
}

// Exercise the actual PlanBuilder async handler with a synthetic closure (no real vault/React DOM).
{
  const file = 'src/components/PlanBuilder.tsx';
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let handler: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'planChatLoop') handler = node; ts.forEachChild(node, visit); }; visit(source);
  assert.ok(handler);
  const code = ts.transpileModule(`const ${handler!.getText(source)}; return planChatLoop;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let searches = 0, modelCalls = 0, imports = 0;
  const planRun = { current: null as AbortController | null }, researchCache = { current: undefined as { subject: string; preparation: PlanResearchPreparation } | undefined };
  let release!: (value: unknown) => void;
  const environment: Record<string, any> = {
    AbortController, isActive: true, homeLocalDate: () => '2026-11-02', WEEKDAYS: [], activeWeekdays: [1, 2, 3, 4, 5], initialValue: undefined,
    rootTitle: '合成目标', planNodes: [], executionTasks: [], draftMilestones: [], aiSubject: subject, goalEvidence: '合成验收', aiExpectation: '合成验收',
    STARTING_LEVEL_LABEL: { new: '新手' }, startingLevel: 'new', PACE_LABEL: { balanced: '均衡' }, pace: 'balanced', rootStartDate: '2026-11-02', rootDueDate: '2026-11-06', deadlineMode: 'flexible',
    weeklyBudgetMinutes: 600, preferredSessionMinutes: 60, preferredTimeOfDay: 'flexible', reviewCadence: 'standard', autoAdjustPolicy: 'ask', constraintNotes: '',
    planRun, planSession: { current: null }, lastAttemptReply: { current: undefined }, onlineResearch: true, publicResearchSubject: subject, researchCache,
    planResearchSubject: (value: string) => value, preparePlanResearch: async () => { searches++; return { research: bundle }; },
    callLLM: async (request: any) => { modelCalls++; assert.ok(request.userInput.includes(bundle.sources[0].excerpt)); assert.match(request.userInput, /核心优先/); return { parsedJson: { rootTitle: '合成计划', planTree: root.children, planMeta: { summary: '核心 [P1]' } } }; },
    dailyStudyMinutes: 60, aiDailyHours: 1, previewDraftCapacity: () => [], allPlanNotes: [], capacitySettings: {}, chatMessages: [], generatedPlanMeta: {}, initialMeta: {}, rootPriority: 'medium', currentConditions: {},
    planResearchContext, PLAN_CORE_SCOPE_RULES, assertGeneratedPlanCoreScope, checkPlanResearchCitations,
    parsePlanNodes: (value: any) => value, assertPlanStructureGranularity: () => {}, extractExecutionTasks: (nodes: any) => ({ nodes, executionTasks: [] }), collectMilestones: () => [],
    asDate: (value: any) => value, withoutNodeMilestones: (nodes: any) => nodes,
    setImportedDraft: () => { imports++; }, setAiError: (error: any) => { if (error) throw new Error(error); },
  };
  for (const name of ['setAiLoading', 'setAiInterrupted', 'setResearchNotice', 'setChatMessages', 'setRootTitle', 'setRootDueDate', 'setGeneratedPlanMeta', 'setDraftMilestones', 'setPlanNodes', 'setExecutionTasks', 'setAiStep', 'setChatInput']) environment[name] = () => {};
  const make = () => new Function(...Object.keys(environment), code)(...Object.values(environment));
  await make()(); await make()('补充目标');
  assert.equal(searches, 1); assert.equal(modelCalls, 2); assert.equal(imports, 2);
  environment.callLLM = async () => new Promise(resolve => { release = resolve; });
  const pending = make()(); await Promise.resolve(); await Promise.resolve();
  const duplicate = make()(); await duplicate;
  planRun.current!.abort(); planRun.current = null;
  release({ parsedJson: { rootTitle: '迟到结果', planTree: root.children, planMeta: { summary: '[P1]' } } }); await pending;
  assert.equal(imports, 2);
  pass('实际页面异步链：澄清轮复用取证，重复启动受保护，取消后迟到模型响应不导入');

  // Full page handler: failed evidence -> offline model -> imported draft metadata.
  let metadata: any, notice = '', offlineRequests = 0;
  researchCache.current = undefined; environment.planSession.current = null;
  environment.preparePlanResearch = (topic: string, signal: AbortSignal) => preparePlanResearch(topic, signal, {
    collect: async () => { searches++; throw new Error('synthetic source validation failure'); },
  });
  environment.setResearchNotice = (value: string) => { notice = value; };
  environment.setGeneratedPlanMeta = (update: any) => { metadata = update({}); };
  environment.callLLM = async (request: any) => {
    offlineRequests++; assert.match(request.userInput, /未联网核实/);
    return { parsedJson: { rootTitle: '离线草图', planTree: JSON.parse(JSON.stringify(root.children).replaceAll(' [P1]', '')), planMeta: { summary: '模型未加标记的计划摘要' } } };
  };
  await make()();
  assert.equal(imports, 3); assert.equal(metadata.research, undefined); assert.match(metadata.summary, /^未联网核实/); assert.match(notice, /未联网核实/);
  const priorSearches = searches;
  environment.callLLM = async (request: any) => {
    offlineRequests++; assert.match(request.userInput, /未联网核实/); return { parsedJson: { question: '还需什么基础？' } };
  };
  environment.setChatMessages = (messages: any) => { environment.chatMessages = messages; };
  await make()(); await make()('继续按现有目标');
  assert.equal(searches, priorSearches, 'offline clarification rounds must not repeat a failed optional search');
  assert.equal(offlineRequests, 3);
  environment.aiSubject = '新目标：线性代数'; environment.publicResearchSubject = environment.aiSubject;
  environment.lastAttemptReply.current = '旧重试回复';
  environment.callLLM = async (request: any) => {
    assert.equal(request.context.planGoal, '新目标：线性代数');
    assert.equal(request.messages, undefined, 'changed goal must not leak old clarification history');
    assert.ok(!request.userInput.includes('旧重试回复'));
    return { parsedJson: { question: '请说明线性代数基础' } };
  };
  await make()('旧重试回复');
  assert.equal(environment.lastAttemptReply.current, undefined);
  assert.equal(environment.chatMessages.length, 1);
  assert.equal(environment.chatMessages[0].content, '请说明线性代数基础');
  pass('实际页面网络失败仍导入带未核实标记的草图，追问不反复重试联网；切换目标清空旧对话及旧重试回复');

  researchCache.current = undefined;
  environment.preparePlanResearch = (topic: string, signal: AbortSignal) => preparePlanResearch(topic, signal, { collect: async () => new Promise(() => {}) });
  environment.callLLM = async () => assert.fail('cancelled research must never start an offline model request');
  const researchPending = make()(); await Promise.resolve();
  planRun.current!.abort(); planRun.current = null;
  await researchPending; assert.equal(imports, 3);
  pass('页面联网阶段主动取消：不调用模型，不导入草图，迟到请求不能复活');

  let earlyError = '', restoredInput = '';
  environment.planResearchSubject = planResearchSubject;
  environment.publicResearchSubject = '';
  environment.lastAttemptReply.current = '不相关的旧回答';
  environment.setAiError = (value: string) => { earlyError = value; };
  environment.setChatInput = (value: any) => { restoredInput = typeof value === 'function' ? value(restoredInput) : value; };
  await make()('当前刚编辑的新回答');
  assert.match(earlyError, /公开学习主题/);
  assert.equal(restoredInput, '当前刚编辑的新回答');
  assert.equal(environment.lastAttemptReply.current, '当前刚编辑的新回答');
  pass('公开主题早期校验失败也保留本次当前输入，不恢复前一次隐藏回答');
}
{
  const file = 'src/electron/main.ts', text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const statements: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(source) === 'ipcMain.handle'
      && ['plan-research:search', 'plan-research:cancel'].includes((node.expression.arguments[0] as ts.StringLiteral).text)) statements.push(node.getText(source));
    ts.forEachChild(node, visit);
  }; visit(source); assert.equal(statements.length, 2);
  const handlers = new Map<string, (...args: any[]) => any>(), requests = new Map<string, AbortController>();
  let allowed = true, phase = 'idle', searches = 0;
  let research: (...args: any[]) => Promise<any> = async (topic, browser, signal) => {
    searches++; signal.throwIfAborted(); await browser(topic, ['synthetic syllabus'], signal); return bundle;
  };
  const environment = {
    ipcMain: { handle: (name: string, callback: any) => handlers.set(name, callback) },
    planSearchRequests: requests, referenceCallerAllowed: () => allowed, applicationExiting: false,
    applicationShutdown: { getPhase: () => phase }, AbortController, AbortSignal, mainWindow: {},
    researchPlanWeb: (...args: any[]) => research(...args),
    searchConceptEvidenceInBrowser: async (topic: string, aliases: any[], _window: unknown, _signal: AbortSignal, options: any) => {
      assert.equal(topic, subject); assert.deepEqual(aliases, []); assert.equal(options.strictBody, true); return [];
    },
  };
  const js = ts.transpileModule(statements.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  new Function(...Object.keys(environment), js)(...Object.values(environment));
  const sender = Object.assign(new EventEmitter(), { id: 7 }), event = { sender };
  const search = handlers.get('plan-research:search')!, cancel = handlers.get('plan-research:cancel')!;
  allowed = false; await assert.rejects(search(event, subject, crypto.randomUUID()), /状态无效/); allowed = true;
  phase = 'preparing'; await assert.rejects(search(event, subject, crypto.randomUUID()), /状态无效/); phase = 'idle';
  await assert.rejects(search(event, 'topic\nprivate notes', crypto.randomUUID()), /状态无效/);
  assert.equal(searches, 0);
  await search(event, subject, crypto.randomUUID()); assert.equal(searches, 1); assert.equal(requests.size, 0);
  research = async (_topic, _browser, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const id = crypto.randomUUID(), pending = search(event, subject, id);
  await assert.rejects(search(event, subject, id), /正在执行/);
  assert.equal(cancel({ sender: { id: 8 } }, id), false);
  assert.equal(cancel(event, id), true); await assert.rejects(pending);
  assert.equal(requests.size, 0); assert.equal(sender.listenerCount('destroyed'), 0);
  const destroyed = search(event, subject, crypto.randomUUID()); sender.emit('destroyed'); await assert.rejects(destroyed);
  assert.equal(requests.size, 0); assert.equal(sender.listenerCount('destroyed'), 0);
  research = async () => bundle;
  await search(event, subject, crypto.randomUUID()); assert.equal(requests.size, 0);
  pass('实际主进程IPC：窗口/退出状态及主题检查、重复请求隔离、按发送窗口取消、销毁清理与失败重试');
}
console.log(`Plan core scope and research: ${groups} offline groups passed (no live semantic accuracy claim).`);
