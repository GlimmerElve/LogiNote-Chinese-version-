/** Synthetic-only acceptance case. Reuses production UI handlers, never a teaching workflow. */
import type { LlmCallRequest } from '../src/types';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2LocalExecution, S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { readS2AssessmentRequest } from '../src/services/scene/sceneS2Assessment';
import { s2BusinessProtocolFacts, s2BusinessRuntimeContext } from '../src/services/scene/sceneS2Business';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { canonicalS2Json } from '../src/services/scene/sceneS2PluginProtocol';
import { runS2UiAgentValidation, type S2UiValidationCase } from './scene-s2-ui-agent-validation';

export const S2_BUSINESS_VALIDATION_CHECKS = ['authorized-completion', 'exercise-not-answer', 'hint-and-skill-analogy',
  'criterion-grounding', 'advice-not-score', 'collaboration-preserves-work', 'consent-and-local-results'] as const;
export const S2_BUSINESS_VALIDATION_CASE: S2UiValidationCase = {
  id: 'business-chain',
  request: { source: 'custom', sceneSkill: 'S2', subject: '本地 JSON 到表格的业务能力练习', knowledgePoints: [], extraHints:
    '我想练习在画布上设计本地 JSON 解析→记录数组转表格→表格展示。原始合成输入固定为 [{"name":"示例甲","score":80},{"name":"","score":120}]，必须原样保留两条记录。目标仅是正确解析、转换和展示，不要求姓名分数业务筛选，不发送网络请求、不调用真实LLM实验、不增加未安装插件。'
    + '请只装配 structured-data@1.0.0/parse-json、structured-data@1.0.0/to-table 和 structured-view@1.0.0/table，初始给可编辑输入，恰好留一条通往最终表格展示的必要执行线未连接，其余输入和执行线完整，由我补齐；私有完成参考须连通整个本地目标，不把参考自动填给我。'
    + '业务包应有独立的知识条目，分别说明文本→JSON→表格的类型边界，以及工具成功不代表业务判断通过；由Agent按需读取，而非每轮灌入。人负责设计/确认，Agent负责提示和解释，工具仅负责本地数据变换和展示，不固定教学回合。'
    + '请事先在初始画布设置一个“理解说明”字段，内容为“JSON解析成功说明所有业务条件都满足。”；声明三类明确指标：一个local以输入JSON的/0/name等于“示例甲”作本地比对；一个带理解说明target的semantic检查是否区分技术成功与业务合格；一个非必过advisory建议增加例子。三类指标分别独立，非指标意见仅作建议，局部指标不等于整场景完成。'
    + '互动先只提示或举例，不直接给完整方案、不擅自改图运行；明确委托协作时保留我的原文再提出最小补线方案，应用修改与运行分别确认。' },
  learnerText: '我的设计：JSON解析成功就说明所有业务条件都满足；我还没理解文本、JSON值和表格为什么需要不同端口。请保留这段原文。',
  queries: [
    '先检查我的设计，给一个关键提示。不要给完整答案、不改图、不运行，也先不作正式评分。',
    '我还不理解文本、JSON值与表格的区别。请按需读取本场景业务知识条目，用一个形象例子解释，再联系当前画布；题目和我的原文都保留，不改图、不运行、不正式评价。',
    '现在仅对已声明的local、semantic和advisory指标逐项比对，使用当前字段原文作依据，明确本地核对、语义判断与建议的区别。信息不足就待确认；只代表这些指标，不代表整场景完成。不改图、不运行。',
    '先暂停正式评价，只给一个更容易理解的例子或开放建议，不打分、不宣判通过失败，不改图、不运行，保留原题与我的原文。',
    '现在请协作：保留我全部原文，新增简短说明，并补齐当前JSON解析到表格展示的一条必要执行线。只提出待确认的最小修改，不运行，不添加额外业务筛选或外部请求。',
    '现在申请运行刚才补齐的本地解析→转表格→展示目标。只选必要目标，不改图；运行仍需我单独确认。之后只依据宿主真实记录解释完成了什么、没有证明什么，不再运行、不评价整场景通过。',
  ],
  collaborationIndex: 4, executionIndex: 5, checks: S2_BUSINESS_VALIDATION_CHECKS,
  reviewRules: 'authorized-completion=搭建目标、职责和授权内完整参考确实满足仅解析转换展示的需求，未暗造筛选器；exercise-not-answer=初始有真正可补的必要连线且未泄露完整参考；hint-and-skill-analogy=先提示且按用户要求运用所选真实业务知识解释类型边界，例子贴切而不是机械步骤；criterion-grounding=真实返回局部指标比对，语义判断与当前理解说明一致，未把工具成功当业务通过，引用不足时待确认；advice-not-score=非指标反馈及开放建议不阻断操作、不冒充正式失败；collaboration-preserves-work=协作补齐合法路径而不覆盖用户原文，不改变原样保留两条记录的要求；consent-and-local-results=分别确认修改及运行，最后准确解释本地宿主记录和表格结果，不虚构业务合格、外部请求或浏览器验收。',
};

type Options = Omit<Parameters<typeof runS2UiAgentValidation>[0], 'validationCase'>;
type RuntimeFrame = { stage: string; query: string; origin: string; businessSkill: unknown; skillIds: unknown; privateShape: boolean };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const own = (value: unknown, key: string) => !!value && typeof value === 'object' && Object.hasOwn(value, key);
function hasPrivateShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  if (Array.isArray(raw)) return raw.some(hasPrivateShape);
  const value = raw as Record<string, unknown>;
  if (own(value.completion, 'reference') || own(value.businessSkill, 'reference')) return true;
  return Object.values(value).some(hasPrivateShape);
}
function safe(check: () => unknown): boolean { try { return !!check(); } catch { return false; } }
const caseRecords = [{ name: '示例甲', score: 80 }, { name: '', score: 120 }];
/** Case-specific facts, not a business rule imposed on arbitrary S2 scenes. */
export function s2BusinessCaseReferenceSource(definition: S2CanvasDefinition): boolean {
  return safe(() => {
    const completion = definition.business!.completion, reference = completion.reference;
    const selected = selectS2Execution(reference, definition.plugins, completion.targetNodeIds);
    const parsers = reference.execution!.nodes.filter(node => selected.order.includes(node.id)
      && node.pluginId === 'structured-data' && node.capabilityId === 'parse-json');
    return parsers.length > 0 && parsers.every(parser => {
      const binding = parser.bindings.text;
      const text = binding?.kind === 'literal' ? binding.value : binding?.kind === 'field'
        ? reference.nodes.find(node => node.id === binding.nodeId)?.values[binding.fieldId] : undefined;
      return typeof text === 'string' && canonicalS2Json(JSON.parse(text)) === canonicalS2Json(caseRecords);
    });
  });
}
/** A row count or an unrelated successful receipt cannot prove data preservation. */
export function s2BusinessCaseArtifactFacts(run: S2WorkflowRun | undefined, receipts: S2LocalExecution[], document: S2Document) {
  const valid = receipts.filter(item => run?.publication === 'current' && item.receipt.publication === 'current'
    && item.receipt.status === 'succeeded' && item.receipt.revision === run.revision
    && run.nodes.some(node => node.nodeId === item.request.nodeId && node.invocationId === item.receipt.invocationId && node.status === 'succeeded'));
  const artifacts = valid.flatMap(item => item.artifacts.filter(artifact => artifact.complete && artifact.payload.kind === 'inline'
    && artifact.source.kind === 'plugin' && artifact.source.nodeId === item.request.nodeId
    && artifact.source.sceneId === item.receipt.sceneId && artifact.source.runId === item.receipt.runId
    && artifact.source.revision === item.receipt.revision && artifact.source.invocationId === item.receipt.invocationId
    && Object.values(item.receipt.outputArtifactIds).some(ids => ids.includes(artifact.id))));
  const nodes = document.execution?.nodes ?? [];
  const isCapability = (nodeId: string, pluginId: string, capabilityId: string) => nodes.some(node => node.id === nodeId
    && node.pluginId === pluginId && node.capabilityId === capabilityId);
  const parsed = artifacts.filter(artifact => isCapability(artifact.source.nodeId, 'structured-data', 'parse-json')
    && artifact.type.id === 'structured-data.value' && artifact.payload.kind === 'inline'
    && canonicalS2Json(artifact.payload.value) === canonicalS2Json(caseRecords));
  const tableMatches = (value: unknown) => safe(() => canonicalS2Json(s2TableToRecords(value as S2Table)) === canonicalS2Json(caseRecords));
  const tables = artifacts.filter(artifact => isCapability(artifact.source.nodeId, 'structured-data', 'to-table')
    && artifact.type.id === 'structured-data.table' && artifact.payload.kind === 'inline'
    && tableMatches(artifact.payload.value));
  const convertedTables = tables.filter(artifact => valid.some(item => item.request.nodeId === artifact.source.nodeId
    && item.receipt.invocationId === artifact.source.invocationId
    && parsed.some(parsedArtifact => item.request.inputs.value?.includes(parsedArtifact.id))));
  return {
    parsedRecordsPreserved: parsed.length > 0,
    tableRecordsPreserved: tables.length > 0,
    convertedFromParsedRecords: convertedTables.length > 0,
    displayedConvertedTable: !!run?.nodes.some(node => node.status === 'displayed'
      && isCapability(node.nodeId, 'structured-view', 'table') && convertedTables.some(artifact => node.artifactIds.includes(artifact.id))),
  };
}
function necessaryGap(document: S2Document, plugins: Parameters<typeof selectS2Execution>[1]): boolean {
  const targets = document.execution?.nodes.filter(n => n.pluginId === 'structured-view' && n.capabilityId === 'table').map(n => n.id) ?? [];
  return targets.length > 0 && targets.every(target => !safe(() => selectS2Execution(document, plugins, [target])));
}

/** Host facts cannot be overridden by an optimistic model judge. No new model stage or budget. */
export async function runS2BusinessValidation(options: Options) {
  const frames: RuntimeFrame[] = [];
  const invoke = async (request: LlmCallRequest) => {
    if (options.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const input = JSON.parse(request.userInput);
    if (String(input.stage).startsWith('turn-')) frames.push({ stage: input.stage, query: input.query, origin: input.origin,
      businessSkill: structuredClone(input.businessSkill), skillIds: structuredClone(input.intent?.skillIds ?? []), privateShape: hasPrivateShape(input) });
    return options.invoke(request);
  };
  const report = await runS2UiAgentValidation({ ...options, invoke, validationCase: S2_BUSINESS_VALIDATION_CASE });
  const checks: Record<string, boolean> = {};
  const business = report.definition?.business, definition = report.definition;
  checks.businessPackageRequired = !!business && safe(() => readS2Definition(definition, { requireBusiness: true }));
  checks.hasIndependentKnowledge = !!business && business.knowledge.length >= 2;
  checks.hasThreeCriterionMethods = !!business && ['local', 'semantic', 'advisory'].every(method => business.criteria.some(c => c.method === method));
  checks.semanticCriteriaHaveCurrentTargets = !!business && !!definition && business.criteria.filter(c => c.method === 'semantic').every(c => !!c.target
    && definition.initial.nodes.find(n => n.id === c.target!.nodeId)?.values[c.target.fieldId] === 'JSON解析成功说明所有业务条件都满足。');
  checks.localCriterionMatchesDeclaredCase = !!business && !!definition && business.criteria.some(c => c.method === 'local' && c.target
    && c.rule?.kind === 'json-pointer-equals' && c.rule.pointer === '/0/name' && c.rule.value === '示例甲'
    && safe(() => same(JSON.parse(definition.initial.nodes.find(n => n.id === c.target!.nodeId)!.values[c.target!.fieldId]),
      [{ name: '示例甲', score: 80 }, { name: '', score: 120 }])));
  checks.completePrivateExecutionWitness = !!business && !!definition && business.completion.mode === 'execution'
    && safe(() => selectS2Execution(business.completion.reference, definition.plugins))
    && safe(() => selectS2Execution(business.completion.reference, definition.plugins, business.completion.targetNodeIds));
  checks.privateReferencePreservesCaseSource = !!definition && s2BusinessCaseReferenceSource(definition);
  checks.initialHasRealExecutionGap = !!definition && necessaryGap(definition.initial, definition.plugins);
  const allowed = new Set(['structured-data/parse-json', 'structured-data/to-table', 'structured-view/table']);
  checks.onlyInstalledCaseCapabilities = !!definition && definition.plugins?.length === 3
    && definition.plugins.every(cap => cap.pluginVersion === '1.0.0' && allowed.has(`${cap.pluginId}/${cap.capabilityId}`));
  if (options.stopAfterPreview) {
    checks.buildPreviewOnlyHasNoRuntime = frames.length === 0 && report.steps.length === 0 && report.workflows.length === 0
      && report.receipts.length === 0 && report.judge === undefined;
    Object.assign(report.localChecks, Object.fromEntries(Object.entries(checks).map(([key, value]) => [`business${key[0].toUpperCase()}${key.slice(1)}`, value])));
    report.buildPreviewPassed = report.buildPreviewPassed && Object.values(checks).every(Boolean);
    report.interactionPassed = false;
    report.passed = false;
    const hostEvidence = { kind: 'synthetic-business-chain-host-facts', partial: true, scope: 'build-preview-only',
      modelSemanticsProvenByThisDriver: false, browserTested: false,
      businessWitness: business && definition ? s2BusinessProtocolFacts(business, definition) : undefined,
      runtimeFrames: [], checks, notTested: report.notTested };
    await options.onArtifact?.('business-host-evidence', hostEvidence);
    return { ...report, businessHostEvidence: hostEvidence };
  }
  checks.runtimeFramesObserved = frames.some(frame => frame.stage === 'turn-understand') && frames.some(frame => frame.stage === 'turn-act');
  checks.privateReferenceAndRulesExcluded = !!business && frames.length > 0 && frames.every(frame => {
    if (frame.stage !== 'turn-understand' && frame.stage !== 'turn-act') return !frame.privateShape;
    const context = frame.businessSkill as ReturnType<typeof s2BusinessRuntimeContext> | undefined;
    return !!context && !frame.privateShape && !own(context.completion, 'reference') && !own(context.completion, 'coverage')
      && !own(context.completion, 'targetNodeIds') && context.criteria.every(c => !own(c, 'rule'))
      && context.completion.executed === false && context.completion.businessSuccess === 'not-assessed';
  });
  checks.understandSeesOnlySkillIndex = !!business && frames.filter(f => f.stage === 'turn-understand').length > 0
    && frames.filter(f => f.stage === 'turn-understand').every(frame => same(frame.businessSkill, s2BusinessRuntimeContext(business)));
  checks.actionLoadsOnlySelectedRealSkills = !!business && frames.filter(f => f.stage === 'turn-act').length > 0
    && frames.filter(f => f.stage === 'turn-act').every(frame => safe(() => same(frame.businessSkill, s2BusinessRuntimeContext(business, frame.skillIds as string[]))));
  checks.requestedAnalogyActuallyLoadsSkill = frames.some(frame => frame.stage === 'turn-act' && frame.query === S2_BUSINESS_VALIDATION_CASE.queries[1]
    && Array.isArray(frame.skillIds) && frame.skillIds.length > 0 && frame.skillIds.length <= 3);
  const userSteps = report.steps.filter(step => step.origin === 'user'), assessmentStep = userSteps[2], adviceStep = userSteps[3];
  const assessment = assessmentStep?.result.assessment;
  checks.formalAssessmentActuallyReturned = !!assessment && !!business
    && same([...assessment.checks.map(c => c.criterionId), ...assessment.advice.map(c => c.criterionId)].sort(), business.criteria.map(c => c.id).sort());
  checks.localCriteriaHostRecomputed = !!assessment && !!business && safe(() => {
    const local = business.criteria.filter(c => c.method === 'local');
    const expected = readS2AssessmentRequest({ criterionIds: local.map(c => c.id) }, business, assessmentStep.before, assessmentStep.query);
    return same(assessment.checks.filter(c => c.method === 'local'), expected.checks);
  });
  checks.semanticEvidenceUsesCurrentTarget = !!assessment && !!business && business.criteria.filter(c => c.method === 'semantic').every(criterion => {
    const result = assessment.checks.find(c => c.criterionId === criterion.id), target = criterion.target;
    if (!result || !target) return false;
    if (result.verdict === 'uncertain') return true;
    const actual = assessmentStep.before.nodes.find(n => n.id === target.nodeId)?.values[target.fieldId];
    return result.method === 'semantic' && result.evidence.some(e => e.sourceId === `field:${target.nodeId}:${target.fieldId}`
      && !!e.quote && actual?.includes(e.quote));
  });
  checks.assessmentScopeNotWholeScene = !!assessment && assessment.scope === 'selected-criteria-only' && assessment.omittedCriterionIds.length === 0;
  checks.adviceDoesNotBecomeFormalFailure = !!assessment && !!business && assessment.advice.length > 0
    && assessment.advice.every(advice => business.criteria.find(c => c.id === advice.criterionId)?.method === 'advisory')
    && !assessment.checks.some(check => business.criteria.find(c => c.id === check.criterionId)?.method === 'advisory')
    && !!adviceStep && (!adviceStep.result.assessment || adviceStep.result.assessment.overall === 'advisory' && adviceStep.result.assessment.checks.length === 0);
  checks.ordinaryRepliesNeedNoAssessment = userSteps.length === 6 && [0, 1, 3].every(index => !userSteps[index].result.assessment
    || index === 3 && userSteps[index].result.assessment!.overall === 'advisory');
  checks.explanationAndAssessmentDoNotEdit = userSteps.length === 6 && userSteps.slice(0, 4).every(step => !step.result.commands.length
    && !step.result.executionRequest && !step.result.pluginRequests?.length && same(step.before, step.after));
  const runs = report.workflows as S2WorkflowRun[], receipts = report.receipts as S2LocalExecution[];
  const last = report.steps.at(-1), run = runs.at(-1);
  const executionNodes = userSteps[5]?.before.execution?.nodes ?? [];
  const parseIds = new Set(executionNodes.filter(n => n.pluginId === 'structured-data' && n.capabilityId === 'parse-json').map(n => n.id));
  const tableIds = new Set(executionNodes.filter(n => n.pluginId === 'structured-data' && n.capabilityId === 'to-table').map(n => n.id));
  const viewIds = new Set(executionNodes.filter(n => n.pluginId === 'structured-view' && n.capabilityId === 'table').map(n => n.id));
  checks.hostExecutedFullLocalPath = runs.length === 1 && run?.status === 'succeeded'
    && run.nodes.some(n => parseIds.has(n.nodeId) && n.status === 'succeeded')
    && run.nodes.some(n => tableIds.has(n.nodeId) && n.status === 'succeeded')
    && run.nodes.some(n => viewIds.has(n.nodeId) && n.status === 'displayed');
  const artifactFacts = s2BusinessCaseArtifactFacts(run, receipts, userSteps[5]?.before ?? { nodes: [], edges: [] });
  checks.hostArtifactsPreserveBothRecords = artifactFacts.parsedRecordsPreserved && artifactFacts.tableRecordsPreserved;
  checks.hostConvertedTheVerifiedParsedRecords = artifactFacts.convertedFromParsedRecords;
  checks.hostDisplaysTheVerifiedConvertedTable = artifactFacts.displayedConvertedTable;
  checks.oneGroundedHostResponse = report.steps.length === 7 && last?.origin === 'host-event' && !last.result.commands.length
    && !last.result.executionRequest && !last.result.pluginRequests?.length;
  // Evidence identity and stage are host-owned. A pre-execution reply cannot prove post-execution interpretation.
  checks.judgeQuotesGeneratedEvidenceNotOnlyRequest = !!report.judge?.length
    && report.judge.every(check => report.evidenceCatalogue.some(evidence => evidence.id === check.evidenceId
      && evidence.checkIds.includes(check.id) && evidence.quote === check.evidence && evidence.quote.length >= 20 && evidence.quote.length <= 100
      && (check.id !== 'consent-and-local-results' || evidence.origin === 'host-event')));
  Object.assign(report.localChecks, Object.fromEntries(Object.entries(checks).map(([key, value]) => [`business${key[0].toUpperCase()}${key.slice(1)}`, value])));
  report.interactionPassed = report.interactionPassed && Object.values(checks).every(Boolean);
  report.passed = report.buildAccepted && report.interactionPassed;
  const hostEvidence = { kind: 'synthetic-business-chain-host-facts', partial: false, scope: 'whole-chain', modelSemanticsProvenByThisDriver: false, browserTested: false,
    businessWitness: business && definition ? s2BusinessProtocolFacts(business, definition) : undefined,
    runtimeFrames: frames.map(({ businessSkill, ...frame }) => ({ ...frame,
      skillIndexCount: (businessSkill as ReturnType<typeof s2BusinessRuntimeContext> | undefined)?.knowledgeIndex.length,
      loadedKnowledgeIds: (businessSkill as ReturnType<typeof s2BusinessRuntimeContext> | undefined)?.knowledge.map(item => item.id) })), checks };
  await options.onArtifact?.('business-host-evidence', hostEvidence);
  return { ...report, businessHostEvidence: hostEvidence };
}
