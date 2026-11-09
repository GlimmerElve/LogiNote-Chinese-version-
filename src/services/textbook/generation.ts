import type { LlmCallRequest, LlmCallResponse, LlmProvider, NoteItem } from '../../types';
import { isLearningProject } from '../projectRole';
import type { AgentRuntimeContext } from '../agent/types';
import { callLLM, resolveProvider } from '../llmService';
import { requireLlmModel } from '../llmModelSelection';
import { effectiveThinkingLevel, resolveLlmThinkingPolicy } from '../llmThinkingPolicy';
import { ensureLlmSettingsLoaded, readLlmSettingsForUse } from '../llmStorage';
import { listDocuments, prepareLocalMaterial, readLocalMaterialCatalog, readLocalMaterialImage, searchDocuments } from '../documentRagClient';
import { assembleLocalMaterialPacket } from './materialPacket.ts';
import { buildTextbookContext, textbookKnowledge, textbookProject, textbookReviewRecommendation } from './context';
import { projectPlanningSnapshot, planningBeforePublication, stableTextbookValue, textbookHash, textbookRoot } from './fingerprint.ts';
import { listTextbookJobs, textbookDocumentHash, textbookJobCommand, readTextbookBoundUrl, supplementTextbookMaterials } from './jobClient';
import { textbookSupplementPolicy, textbookSupplementGaps, textbookWebSource } from './supplement';
import { safeTextbookWebError } from './webErrors';
import { textbookBoundUrls } from './boundUrls';
import { projectDocumentBindings } from '../projectResourceScope';
import { isUnfilledWikiKnowledge } from '../wikiKnowledge';
import { collectBoundTextbookSources } from './webMaterials';
import { assembleTextbook, validateBlueprint, validateChapter, validateTextbookContent, validateTextbookJob } from './validation.ts';
import { readTextbookBody, writeTextbookRegion } from './noteContent.ts';
import { TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_QUALITY_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT, TEXTBOOK_SOURCE_PROMPT, TEXTBOOK_SELECTIVE_THINKING_PROMPT, TEXTBOOK_VISUAL_INPUT_PROMPT } from '../../workflows/textbookPrompt';
import { TEXTBOOK_PROMPT_VERSION, TEXTBOOK_MERMAID_LINE_BREAK_GUIDANCE } from '../../workflows/textbookPromptV2';
import { loadTextbookPrompt } from '../../workflows/textbookPromptLoader';
import { textbookChapterTeachingTypes } from './teachingTypes';
import { usesProgressiveTextbookPrompt, validateTextbookPromptVersion } from './promptVersion';
import type { TextbookChapter, TextbookContext, TextbookFinding, TextbookJob, TextbookJobCommand, TextbookJobReply, TextbookPipelineStage, TextbookPublishInput, TextbookSource } from './generationTypes';
import { textbookChapterContent } from './generationTypes';
import type { MaterialCatalog } from './materialTypes';
import { embeddedLocalImages, PDF_PAGE_IMAGE_INDEX, PDF_FORMULA_IMAGE_INDEX, MAX_PDF_FORMULA_REGIONS } from './localImages';
import { collectTextbookVisualInput } from './visualMaterials.ts';
import { supportsImageInput, LLM_IMAGE_TOKEN_RESERVE } from '../llmImages.ts';
import { assembleTeachingBlueprint } from './blueprint';
import { defaultTextbookModelPolicy, textbookModelPolicySummary, textbookResponseTruncated, validateTextbookModelPolicy, textbookRequestBudget,
  type TextbookModelStage } from './modelPolicy';
import { initialTextbookProgress, publishTextbookProgress, textbookProgressSnapshot } from './progress';
import { chapterInputIdentity, locateTextbookIssue, recordTextbookFailure, TextbookValidationError } from './repair';
import { recordUnreliableTextbookReview, TextbookReviewError } from './quality';
import { reconcileTextbookReviewCheckpoint } from './reviewCheckpoint';
import { consumeTextbookRound, reserveTextbookRequest, settleTextbookRequest, TextbookBudgetError } from './cost';
import { rebindTextbookModelAttempt } from './modelAttempts';
import { indexTextbookReview } from './reviewReferences';
import { indexedTextbookReviewPrompt } from '../../workflows/textbookReviewPrompt';
import { mergeTextbookSectionRepair } from './sectionRepair';
import { acceptTextbookReview, planTextbookReview } from './reviewCache';
import { captureTextbookThinkingSnapshot, textbookThinkingSnapshotSummary, validateTextbookThinkingSnapshot } from './thinkingSnapshot';
import { textbookVisualGuidance } from './visualGuidance';
import { MaterialError } from './materialScope';
import { validateTextbookChapterRegeneration, validatePublishedChapterRegeneration, assertPublishedRevisionBody, queueTextbookChapterRegeneration, clearRegeneratingChapterFailures } from './chapterRegeneration';
import { textbookContinuitySummary, textbookTeachingReviewPrompt } from './teachingPlan';
import { textbookRestatementWritingPrompt } from './restatement';
import { textbookTimelinePrompt } from './timeline';
import { createTextbookRunStop } from './stop';
import { subscribeTextbookStop } from './jobClient';
import { textbookWorkflows as workflows, captureTextbookProviders, hashTextbookProviders, textbookProviderSnapshot, localTextbookEndpoint as localEndpoint } from './providerIdentity';
export { textbookProviderSnapshot } from './providerIdentity';
export { subscribeTextbookProgress } from './progress';
export type { TextbookProgress } from './generationTypes';

const confirmations = new Map<string, { title: string; sources: string[]; remote: boolean; models: string[]; outputPolicy: string; webCount: number; supplement?: string[]; completed: number; total: number; interactive: boolean;
  figureBudget?: import('./interactiveFigureBudget').InteractiveFigureBudget }>();
export interface TextbookGenerationDependencies {
  subscribeStop?: typeof subscribeTextbookStop;
  command: (input: TextbookJobCommand) => Promise<TextbookJobReply>;
  documentHash: typeof textbookDocumentHash;
  providerHash: typeof textbookProviderSnapshot;
  context: typeof buildTextbookContext;
  sources: (job: TextbookJob, context: TextbookContext, model: (workflow: typeof workflows[number], prompt: string, value: unknown) => Promise<unknown>, signal?: AbortSignal) => Promise<TextbookSource[]>;
  model: (request: LlmCallRequest, signal?: AbortSignal, providerSnapshot?: LlmProvider) => Promise<LlmCallResponse>;
  webRead?: typeof readTextbookBoundUrl;
  supplement?: typeof supplementTextbookMaterials;
}
const defaults: TextbookGenerationDependencies = { command: textbookJobCommand, documentHash: textbookDocumentHash,
  providerHash: textbookProviderSnapshot, context: buildTextbookContext, sources: collectTextbookSources,
  model: (request, signal, providerSnapshot) => callLLM(request, { signal, providerSnapshot }), webRead: readTextbookBoundUrl, supplement: supplementTextbookMaterials };

export async function queryTextbookState(ctx: AgentRuntimeContext, projectId?: string): Promise<unknown> {
  const project = textbookProject(ctx, projectId);
  const documents = await listDocuments();
  const jobs = await listTextbookJobs(project.id);
  return { projectNoteId: project.id, title: project.title, rootProjectId: textbookRoot(project, ctx.getNotes()).id,
    status: project.textbook ? 'existing_textbook_continue_reading' : 'not_generated', textbook: project.textbook,
    linkedKnowledge: textbookKnowledge(project, ctx.getNotes()).map((note) => ({ id: note.id, title: note.title, aliases: note.aliases })),
    attachedDocumentIds: (project.resources || []).flatMap((resource) => resource.documentId ? [resource.documentId] : []),
    documentBindings: projectDocumentBindings(project, ctx.getNotes()),
    effectiveDocumentIds: projectDocumentBindings(project, ctx.getNotes()).map(item => item.documentId),
    boundUrls: textbookBoundUrls(project).map((item) => ({ id: item.id, title: item.title, resourceType: item.resourceType, host: new URL(item.url).hostname })),
    availableDocuments: documents.slice(0, 100).map((doc) => ({ id: doc.id, title: doc.fileName, indexable: doc.indexable })),
    availableDocumentsTruncated: documents.length > 100,
    resumableJobs: jobs.filter((job) => job.stage !== 'published' && !job.archivedAt),
    archivedJobs: jobs.filter((job) => !!job.archivedAt),
    reviewRecommendation: await textbookReviewRecommendation(ctx, project) };
}
export async function prepareTextbook(ctx: AgentRuntimeContext, args: { projectNoteId?: string; allowedDocIds?: string[]; allowCloud?: boolean; readBoundUrls?: boolean }, deps = defaults): Promise<unknown> {
  if (args.allowCloud !== undefined && typeof args.allowCloud !== 'boolean') throw new Error('教材模型范围参数无效，请使用布尔值或省略由当前配置决定');
  await ctx.ensureDataFresh(); const project = textbookProject(ctx, args.projectNoteId);
  if (project.textbook) return { status: 'existing_textbook_continue_reading', projectNoteId: project.id, revisionId: project.textbook.revisionId,
    message: '该项目已有完整教材，不因跨天或学习未完成重复生成。局部修改用read_project_textbook/edit_project_textbook；用户明确要求按章重生成时先query_textbook_job读取真实章节ID，再独立确认regenerate_textbook_chapters。' };
  const bindings = projectDocumentBindings(project, ctx.getNotes());
  const allowedDocIds = args.allowedDocIds ?? bindings.map(item => item.documentId);
  if (!Array.isArray(allowedDocIds) || allowedDocIds.length > 12 || allowedDocIds.some((id) => typeof id !== 'string')) throw new Error('请明确选择至多 12 份本地资料');
  const knowledge = textbookKnowledge(project, ctx.getNotes()).filter((note) => note.content.trim() && !isUnfilledWikiKnowledge(note));
  const boundUrls = textbookBoundUrls(project);
  if (boundUrls.length > 12 && args.readBoundUrls !== false) throw new Error('已绑定 URL 超过 12 个，请先缩小目标项目资源范围，或明确选择仅本地模式');
  const readBoundUrls = args.readBoundUrls !== false && boundUrls.length > 0;
  const webSupplement = args.readBoundUrls === false ? undefined : textbookSupplementPolicy(project.title, textbookRoot(project, ctx.getNotes()).title,
    textbookKnowledge(project, ctx.getNotes()).map(n => n.title), project.content);
  if (knowledge.length > 12) throw new Error('关联知识点超过本阶段上限，请缩小目标项目范围');
  if (!allowedDocIds.length && !knowledge.length && !readBoundUrls) throw new Error('没有可用教材物料。请先导入资料、绑定公开 URL 或补全关联知识点；不会以模型常识冒充教材来源。');
  const documentHashes: Record<string, string> = {}; const knowledgeHashes: Record<string, string> = {};
  for (const id of allowedDocIds) documentHashes[id] = await deps.documentHash({ allowedDocIds }, id);
  for (const note of knowledge) knowledgeHashes[note.id] = await textbookHash({ title: note.title, content: note.content, aliases: note.aliases });
  const documents = await listDocuments();
  const sourceTitles = [...allowedDocIds.map((id) => { const binding = bindings.find(item => item.documentId === id);
    return `${documents.find((doc) => doc.id === id)?.fileName || id} (${id})${binding?.inherited ? `（继承自项目《${binding.projectTitle}》）` : ''}`; }), ...knowledge.map((note) => note.title),
    ...(readBoundUrls ? boundUrls.map((item) => `${item.title}（已绑定 URL）`) : [])];
  await ensureLlmSettingsLoaded();
  // Proposed scope, not a consent receipt. The write tool's bound confirmation
  // approves both data sending and generation; explicit local-only still wins.
  const allowCloud = args.allowCloud ?? workflows.some(workflow => {
    const provider = resolveProvider(workflow);
    return !!provider && !localEndpoint(provider.baseUrl);
  });
  const describeModels = () => [...new Set(workflows.map((workflow) => {
    const provider = resolveProvider(workflow);
    if (!provider) return '模型未配置';
    let host = '地址无效'; try { host = new URL(provider.baseUrl).origin; } catch { /* snapshot rejects invalid local endpoint */ }
    const model = requireLlmModel(provider);
    return `${provider.name} / ${model || '默认模型'} / ${host}${supportsImageInput(provider, model) ? '（图片输入已启用；每次至多6张、合计4MiB，图片另计模型用量）' : '（仅文字；原图保留展示）'}`;
  }))];
  const modelSummary = describeModels();
  const modelPolicy = defaultTextbookModelPolicy();
  const thinkingSnapshot = captureTextbookThinkingSnapshot(readLlmSettingsForUse(), modelPolicy, resolveProvider);
  const providerHash = await deps.providerHash(allowCloud, modelPolicy, thinkingSnapshot);
  if (stableTextbookValue(modelSummary) !== stableTextbookValue(describeModels())) throw new Error('准备期间模型配置已变化，请重新准备确认卡；未调用教材模型');
  if (stableTextbookValue(thinkingSnapshot) !== stableTextbookValue(captureTextbookThinkingSnapshot(readLlmSettingsForUse(), modelPolicy, resolveProvider)))
    throw new Error('准备期间思考档位已变化，请重新准备确认卡；未调用教材模型');
  const { job, reused, running } = await deps.command({ op: 'create', reuseExisting: true, spec: { schemaVersion: 1, projectNoteId: project.id, projectTitle: project.title,
    rootProjectId: textbookRoot(project, ctx.getNotes()).id, planningHash: await textbookHash(projectPlanningSnapshot(project, ctx.getNotes(), allowedDocIds)),
    allowedDocIds, documentHashes, knowledgeHashes, sourceTitles, modelSummary, modelPolicy, ...(thinkingSnapshot ? { thinkingSnapshot } : {}), visualCapabilitiesVersion: 3, promptVersion: TEXTBOOK_PROMPT_VERSION,
    boundUrls: readBoundUrls ? boundUrls : [], readBoundUrls, ...(webSupplement ? { webSupplement } : {}),
    providerHash, allowCloud } });
  cacheConfirmation(job);
  const progress = textbookProgressSnapshot(job, running === true);
  publishTextbookProgress(progress);
  return { status: job.archivedAt ? 'textbook_job_archived' : running ? 'textbook_job_running' : 'prepared_requires_approval', jobId: job.id, projectNoteId: project.id, title: project.title, allowedDocIds,
    knowledgeTitles: knowledge.map((note) => note.title), allowCloud: job.spec.allowCloud, readBoundUrls, boundUrlCount: readBoundUrls ? boundUrls.length : 0, modelPolicy: job.spec.modelPolicy,
    reused: reused === true, progress,
    message: job.archivedAt ? '同范围原任务已归档；请明确恢复该任务，不能通过重新准备另建任务清零预算。'
      : running ? '该项目已有同范围教材任务正在执行，已返回原任务；不要再次生成或重新准备，请等待或查询进度。'
      : reused ? `复用原任务，已保存 ${progress.completed}/${progress.total} 章，不从头生成、不重置用量；调用 generate_project_textbook 并使用此 jobId 请求继续确认，原模型范围合并在同一张卡中，不另行口头询问云端许可。`
      : '尚未调用教材模型或写入教材。请调用 generate_project_textbook 出示一次确认卡，合并确认本次模型数据发送范围与生成写入；不必另行口头询问云端许可。' };
}
export function textbookConfirmation(jobId: string): { title: string; description: string; impacts: string[] } {
  const cached = confirmations.get(jobId);
  return { title: `${cached?.completed ? '继续并写入' : '生成并写入'}项目教材${cached ? `：${cached.title}` : ''}`,
    description: `${cached?.completed ? `恢复原任务 ${jobId}，复用已保存的 ${cached.completed}/${cached.total} 章；只处理未完成或经验证需要修复的阶段，不重新生成整本教材。` : ''}读取可信画像、相关认知和当前根项目最近学习记录，优先限定本地资料；${cached?.supplement ? '物料不足时读取绑定 URL 并按批准的公开主题联网补缺；补缺失败不阻断已有物料生成。' : '没有可用本地文档时读取批准的已绑定公开 URL。'}设计蓝图并生成完整章节；校验通过后只写入目标项目教材区域。`,
    impacts: [`原任务：${jobId}；已有检查点和累计用量保留，不重置预算。`, `资料范围：${cached?.sources.join('、') || '此前锁定的资料；范围变化需要重新准备'}`,
      cached ? cached.remote ? '确认本卡即授权本任务向下列远程模型发送限定资料（含已取得的网页正文选段、资料原图）、可信画像、相关个人认知和当前根项目最近学习记录，并生成写入教材；仅明确启用视觉的模型接收图片附件。仅本任务有效，不保存为全局云端许可；取消不发送。' : '仅允许本机模型，不向远程模型发送学习资料。' : '模型数据许可需先读取任务快照核验。',
      cached?.webCount ? `按物料需要读取 ${cached.webCount} 个已绑定公开 URL；不使用持久登录 Cookie、不采用搜索摘要，不向网站发送画像或认知。正文快照保存在本机，重试复用；不可读链接记录后跳过。` : '本任务没有待读取的绑定网页。',
      ...(cached?.supplement ? [`可选联网补缺主题：${cached.supplement.join('、')}；仅发送主题短词，不发送本地资料、画像或认知。优先 Search/Fetch API，不支持才降级内置匿名浏览器；全书最多 2 次搜索、3 个正文来源、3 张本地图片，总时限 45 秒。图片按既有模型视觉许可使用；搜索、网页、表格或图片补充失败均跳过，不重做已保存阶段。`] : ['未批准主动联网补缺，保持原任务来源范围。']),
      `模型：${cached?.models.join('；') || '待核验'}`,
      cached?.outputPolicy || '输出预算与截断重试上限需核验任务快照，变化后必须重新准备和确认。',
      ...(cached?.interactive ? [`若教材安排交互探索，进入心流后使用同一已批准的章节模型，另发最多一次自动请求（${cached.figureBudget
        ? `配置图输出上限 ${cached.figureBudget.configuration} tokens；HTML 交互图输出上限 ${cached.figureBudget.html} tokens，均已包含思考`
        : '输出上限 4096 tokens'}），只发送相邻教材文字；费用独立于教材预算，失败不自动重试。`] : []),
      '保留计划任务、原笔记及折叠复盘记录；不更新画像、认知或掌握度。'] };
}
function cacheConfirmation(job: TextbookJob): void {
  if (confirmations.size >= 128) confirmations.delete(confirmations.keys().next().value!);
  confirmations.set(job.id, { title: job.spec.projectTitle, sources: job.spec.sourceTitles || [...job.spec.allowedDocIds, ...Object.keys(job.spec.knowledgeHashes)], remote: job.spec.allowCloud, models: job.spec.modelSummary || ['批准时锁定的模型配置'],
    outputPolicy: job.spec.modelPolicy ? textbookModelPolicySummary(job.spec.modelPolicy) + (job.spec.thinkingSnapshot ? `\n${textbookThinkingSnapshotSummary(job.spec.thinkingSnapshot)}` : '') : '旧任务尚未锁定输出策略，请重新准备并确认。',
    webCount: job.spec.readBoundUrls ? job.spec.boundUrls?.length || 0 : 0, supplement: job.spec.webSupplement?.topics, completed: job.checkpoint.chapters?.length || 0, total: job.checkpoint.blueprint?.chapters.length || 0, interactive: (job.spec.promptVersion || 0) >= 7,
    ...(job.spec.thinkingSnapshot?.figureBudget ? { figureBudget: job.spec.thinkingSnapshot.figureBudget } : {}) });
}
export async function textbookApprovalSnapshot(ctx: AgentRuntimeContext, jobId: string, deps = defaults): Promise<unknown> {
  const { job } = await deps.command({ op: 'get', jobId }); const project = textbookProject(ctx, job.spec.projectNoteId);
  cacheConfirmation(job);
  const documents: Record<string, string> = {}; const knowledge: Record<string, string> = {};
  for (const id of job.spec.allowedDocIds) documents[id] = await deps.documentHash({ allowedDocIds: job.spec.allowedDocIds }, id);
  for (const id of Object.keys(job.spec.knowledgeHashes)) {
    const note = ctx.getNotes().find((item) => item.id === id && item.noteType === 'knowledge');
    if (!note) throw new Error('批准的知识点已删除');
    knowledge[id] = await textbookHash({ title: note.title, content: note.content, aliases: note.aliases });
  }
  return { spec: job.spec, cacheClearRevision: job.cacheClearRevision || '', planningHash: await textbookHash(projectPlanningSnapshot(project, ctx.getNotes(), job.spec.allowedDocIds)), rootId: textbookRoot(project, ctx.getNotes()).id,
    documents, knowledge, providerHash: await deps.providerHash(job.spec.allowCloud, job.spec.modelPolicy, job.spec.thinkingSnapshot),
    publishedTextbook: project.textbook ? { revisionId: project.textbook.revisionId,
      bodyHash: await textbookHash(readTextbookBody(project.content, project.textbook)) } : null };
}
async function assertCurrent(ctx: AgentRuntimeContext, job: TextbookJob, deps: TextbookGenerationDependencies, publishedClaim = false): Promise<void> {
  validateTextbookModelPolicy(job.spec.modelPolicy);
  validateTextbookThinkingSnapshot(job.spec.thinkingSnapshot, job.spec.modelPolicy);
  validateTextbookPromptVersion(job.spec.promptVersion);
  if (stableTextbookValue(job.spec.modelPolicy) !== stableTextbookValue(defaultTextbookModelPolicy(job.spec.modelPolicy.version))) throw new Error('教材输出策略已变化，请重新准备并确认；原笔记和草稿保留');
  const snapshot = await textbookApprovalSnapshot(ctx, job.id, deps) as { spec: TextbookJob['spec']; planningHash: string; rootId: string; documents: unknown; knowledge: unknown; providerHash: string };
  const planningMatches = publishedClaim
    ? await textbookHash(planningBeforePublication(textbookProject(ctx, job.spec.projectNoteId), ctx.getNotes(), job.spec.allowedDocIds))
      === (job.checkpoint.publishedRevision?.originalPlanningHash || job.spec.planningHash)
    : snapshot.planningHash === job.spec.planningHash;
  if (stableTextbookValue(snapshot.spec) !== stableTextbookValue(job.spec)
    || !planningMatches || snapshot.rootId !== job.spec.rootProjectId
    || stableTextbookValue(snapshot.documents) !== stableTextbookValue(job.spec.documentHashes)
    || stableTextbookValue(snapshot.knowledge) !== stableTextbookValue(job.spec.knowledgeHashes) || snapshot.providerHash !== job.spec.providerHash) {
    throw new Error('目标项目、资料版本或模型配置已变化，请重新准备并确认；原教材和笔记未替换');
  }
}
export async function collectTextbookSources(job: TextbookJob, context: TextbookContext,
  model: (workflow: typeof workflows[number], prompt: string, value: unknown) => Promise<unknown>, signal?: AbortSignal): Promise<TextbookSource[]> {
  const scope = { allowedDocIds: job.spec.allowedDocIds }; const catalogs: MaterialCatalog[] = [];
  job.checkpoint ||= {};
  job.checkpoint.localMaterialWarnings = [];
  for (const docId of scope.allowedDocIds) {
    signal?.throwIfAborted();
    let summary;
    try { summary = await prepareLocalMaterial(scope, docId); }
    catch (error) {
      // Only unavailable/unsupported material can fall back. Scope/version failures still stop.
      if ((!job.spec.webSupplement && (!job.spec.readBoundUrls || !job.spec.boundUrls?.length)) || !(error instanceof MaterialError)
        || !['UNSUPPORTED', 'INVALID_SOURCE'].includes(error.code)) throw error;
      job.checkpoint.localMaterialWarnings.push(`${docId}：${error.message}`); continue;
    }
    if (!summary.version) throw new Error('资料没有稳定的原文版本');
    let offset: number | undefined; let count = 0;
    do {
      const catalog = await readLocalMaterialCatalog({ ...scope, docId, version: summary.version, offset, limit: 100 });
      catalogs.push(catalog); offset = catalog.nextOffset; count += catalog.sections.length;
      if (count > 2000) throw new Error('资料目录过大，请先缩小本地物料范围');
    } while (offset !== undefined);
  }
  const known = new Map(catalogs.flatMap((catalog) => catalog.sections.map((section) => [`${catalog.document.docId}|${section.id}`, { docId: catalog.document.docId, version: catalog.document.version!, section }] as const)));
  const packetSources: TextbookSource[] = [];
  if (known.size) {
    const directories = [...known.values()].map((item) => ({ docId: item.docId, sectionId: item.section.id, title: item.section.title, sectionPath: item.section.sectionPath }));
    if (JSON.stringify(directories).length > 120_000) throw new Error('批准资料的目录超过本阶段预算，请缩小物料范围；不会静默忽略后续目录');
    // Existing RAG embedding is offline-only; missing model/index falls back to directory reading.
    let ragHints: unknown[] = []; let hintStatus = 'directory_fallback';
    try {
      ragHints = await searchDocuments(context.project.knowledgeTitles.slice(0, 3).join(' ') || context.project.title, 8, { allowedDocIds: scope.allowedDocIds, mode: 'auto' });
      if (ragHints.length) hintStatus = 'scoped_rag';
    } catch { /* Local model unavailable: exact directories remain usable. */ }
    const selected = await model('textbook-blueprint', TEXTBOOK_SOURCE_PROMPT, { project: context.project,
      ragHints, hintStatus,
      catalogs: directories }) as { selections?: Array<{ docId: string; sectionId: string }> };
    if (!Array.isArray(selected?.selections) || selected.selections.length > 8) throw new Error('模型选择的教材物料格式无效');
    const selections = selected.selections.map((item) => {
      const found = known.get(`${item.docId}|${item.sectionId}`);
      if (!found) throw new Error('模型选择了批准范围以外的目录');
      return { docId: found.docId, version: found.version, target: { kind: 'section' as const, sectionId: found.section.id } };
    });
    const packet = await assembleLocalMaterialPacket({ ...scope, projectNoteId: job.spec.projectNoteId, selections, maxChars: 72_000 });
    if (packet.gaps.length) throw new Error('选定章节没有完整读完，请缩小阅读范围；不会用片段冒充完整证据');
    const pdfPages = new Set<string>();
    const formulaRegionKeys = new Set<string>();
    let formulaRegions = 0;
    packetSources.push(...packet.citations.map((item) => {
      // Projected excerpts carry original image indices even across pagination.
      // Legacy partial text has no such mapping, so it remains reference-only.
      const images = item.partialBlock ? [] : embeddedLocalImages(item.text).slice(0, 20);
      const assets = (item.imageReferences || images.map(image => ({ imageIndex: image.index, alt: image.alt }))).slice(0, 20)
        .map((image) => ({ id: `${item.sourceId}-image-${image.imageIndex}`, sourceId: item.sourceId,
          docId: item.docId, version: item.version, blockId: item.blockId, imageIndex: image.imageIndex, alt: image.alt }));
      // Regions precede full-page images in vision requests: retain readable
      // symbols without spending the entire image quota on whole pages.
      for (const [index, evidence] of (item.formulaEvidence || []).filter(evidence => evidence.origin === 'pdf_layout'
        && evidence.locator.kind === 'pdf' && evidence.region).slice(0, MAX_PDF_FORMULA_REGIONS).entries()) {
        const regionKey = `${item.docId}:${item.version}:${evidence.locator.kind === 'pdf' ? evidence.locator.page : ''}:${evidence.region!.join(',')}`;
        if (formulaRegionKeys.has(regionKey)) continue;
        if (formulaRegions >= 24) {
          const warning = '本次公式区域候选上限为24个，其余保留提取风险与整页来源；未提供像素的公式不可按已识别内容讲授。';
          if (!job.checkpoint.localMaterialWarnings!.includes(warning)) job.checkpoint.localMaterialWarnings!.push(warning);
          break;
        }
        formulaRegions++;
        formulaRegionKeys.add(regionKey);
        assets.push({ id: `${item.sourceId}-formula-${index}`, sourceId: item.sourceId, docId: item.docId,
          version: item.version, blockId: item.blockId, imageIndex: PDF_FORMULA_IMAGE_INDEX + index,
          alt: `PDF 第 ${evidence.locator.kind === 'pdf' ? evidence.locator.page : ''} 页公式候选区域（待原图核对）` });
      }
      if (item.locator.kind === 'pdf' && pdfPages.size < 24) {
        const key = `${item.docId}:${item.version}:${item.locator.page}`;
        if (!pdfPages.has(key)) {
          pdfPages.add(key);
          assets.push({ id: `${item.sourceId}-pdf-page`, sourceId: item.sourceId, docId: item.docId, version: item.version,
            blockId: item.blockId, imageIndex: PDF_PAGE_IMAGE_INDEX, alt: `PDF 第 ${item.locator.page} 页原图（未执行本地识别）` });
        }
      } else if (item.locator.kind === 'pdf' && !pdfPages.has(`${item.docId}:${item.version}:${item.locator.page}`)
        && !job.checkpoint.localMaterialWarnings!.includes('本次PDF原图候选上限为24页，其余页仅保留文字；未提供的原图不能视为已识别。')) {
        job.checkpoint.localMaterialWarnings!.push('本次PDF原图候选上限为24页，其余页仅保留文字；未提供的原图不能视为已识别。');
      }
      let text = item.text;
      for (const [index, image] of [...images.entries()].reverse()) {
        text = text.slice(0, image.start) + `[本地图片素材 ${assets[index].id}：${image.alt || '无说明'}；仅供显示，不作为已理解的图像事实]` + text.slice(image.end);
      }
      text = text.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/gu, '[图片字节省略；不作为事实证据]');
      return { sourceId: item.sourceId, kind: 'document' as const, id: item.docId, title: item.fileName,
        formulaEvidence: item.formulaEvidence,
        version: item.version, text, locator: item.locator, textStart: item.textStart, textEnd: item.textEnd, blockId: item.blockId, assets };
    }));
  }
  return packetSources;
}
function parsedModel(response: LlmCallResponse): unknown {
  if (textbookResponseTruncated(response.diagnostics?.finishReason)) throw new Error('教材输出在已批准的重试上限内仍被截断，未发布；可缩小目标范围或切换教材模型后重新准备并确认，已有草稿保留');
  if (response.parsedJson) return response.parsedJson;
  const value = response.content.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  try { return JSON.parse(value); } catch { throw new Error('教材模型没有返回完整有效的 JSON，已保留此前草稿'); }
}
function contextIdentity(value: TextbookContext): unknown {
  return { ...value, warnings: [], mastery: ((value.mastery || {}) as { rows?: unknown[] }).rows?.map((raw) => {
    const row = raw as { noteId?: string; title?: string; mastery?: unknown; reviewCount?: number };
    return { noteId: row.noteId, title: row.title, mastery: row.mastery, reviewCount: row.reviewCount };
  }) };
}
export async function generateTextbook(ctx: AgentRuntimeContext, jobId: string, signal?: AbortSignal, deps = defaults, regenerateChapterIds?: string[], expectedPublishedRevisionId?: string): Promise<unknown> {
  const control = createTextbookRunStop(jobId, signal, deps.subscribeStop || subscribeTextbookStop);
  try { return await runTextbookGeneration(ctx, jobId, control.signal, deps, regenerateChapterIds, expectedPublishedRevisionId, control.claim); }
  finally { control.dispose(); }
}
async function runTextbookGeneration(ctx: AgentRuntimeContext, jobId: string, signal: AbortSignal, deps: TextbookGenerationDependencies,
  regenerateChapterIds: string[] | undefined, expectedPublishedRevisionId: string | undefined, claimedLease: (token: string) => void): Promise<unknown> {
  if (!ctx.publishTextbook) throw new Error('教材写入接口不可用，请重启应用');
  await ctx.ensureDataFresh(); let { job } = await deps.command({ op: 'get', jobId });
  if (job.archivedAt) throw new Error('教材任务已归档，请先明确恢复原任务；不会另建任务');
  const already = textbookProject(ctx, job.spec.projectNoteId);
  const publishedClaim = job.stage === 'published' && !!regenerateChapterIds;
  if (expectedPublishedRevisionId && already.textbook?.revisionId !== expectedPublishedRevisionId) throw new Error('教材确认版本已变化，未开始重生成');
  if (publishedClaim) validatePublishedChapterRegeneration(job, already, regenerateChapterIds!);
  else if (regenerateChapterIds) validateTextbookChapterRegeneration(job, regenerateChapterIds);
  if (regenerateChapterIds && already.textbook && !publishedClaim) throw new Error('已发布教材的章节修订请继续原任务，不重复清理已有修订草稿');
  if (already.textbook && already.textbook.generationJobId !== job.id) return { status: 'existing_textbook_continue_reading', projectNoteId: already.id };
  if (job.stage === 'published' && !publishedClaim) {
    if (already.textbook?.generationJobId !== job.id) throw new Error('已发布教材已被移除，不自动重新生成');
    if (readTextbookBody(already.content, already.textbook) === null) throw new Error('已有教材区域边界损坏，请先恢复；不自动重新生成');
    return { status: 'existing_textbook_continue_reading', projectNoteId: already.id, revisionId: already.textbook.revisionId, jobId };
  }
  const revisionSaved = job.checkpoint.publishedRevision && already.textbook?.revisionId === job.checkpoint.publishedRevision.nextRevisionId
    && readTextbookBody(already.content, already.textbook) === job.checkpoint.body?.trim();
  if (!revisionSaved && (!already.textbook || publishedClaim || job.checkpoint.publishedRevision)) await assertCurrent(ctx, job, deps, publishedClaim);
  signal?.throwIfAborted(); const claimed = await deps.command({ op: 'claim', jobId, expectedCacheClearRevision: job.cacheClearRevision || '',
    ...(publishedClaim ? { publishedRevision: { expectedRevisionId: already.textbook!.revisionId, chapterIds: regenerateChapterIds! } } : {}) }); job = claimed.job;
  if (!claimed.token) throw new Error('教材执行许可不可用'); const token = claimed.token;
  claimedLease(token);
  job.checkpoint.progress ||= initialTextbookProgress(job);
  job.checkpoint.progress.startedAt = new Date().toISOString();
  const broadcast = (running = true) => publishTextbookProgress(textbookProgressSnapshot(job, running));
  const save = async (stage: TextbookPipelineStage, checkSignal = true) => {
    if (checkSignal) signal?.throwIfAborted(); job = (await deps.command({ op: 'checkpoint', jobId, token, stage, checkpoint: job.checkpoint })).job; broadcast();
  };
  const updateProgress = async (stage: TextbookPipelineStage, label: string, status: 'running' | 'saved' = 'running', chapter?: { id: string; title: string; index: number }) => {
    const state = job.checkpoint.progress ||= initialTextbookProgress(job);
    const at = new Date().toISOString();
    if (state.currentStage !== stage || state.chapterId !== chapter?.id || state.steps.find((item) => item.stage === stage)?.status !== 'running') state.stageStartedAt = at;
    state.currentStage = stage; state.label = label; state.chapterId = chapter?.id; state.chapterTitle = chapter?.title; state.chapterIndex = chapter?.index;
    state.retry = 0; state.retryLimit = job.spec.modelPolicy?.maxTruncationRetries || 0;
    delete state.requestMaxTokens; delete state.requestThinkingMode;
    delete state.requestThinkingResolved; delete state.requestReasoningEffort; delete state.requestThinkingLevel; delete state.requestThinkingPreference;
    const step = state.steps.find((item) => item.stage === stage); if (step) step.status = status;
    state.history = [...state.history, { at, stage, label }].slice(-24);
    await save(stage);
  };
  const invalidateProgress = (...stages: TextbookPipelineStage[]) => {
    for (const step of job.checkpoint.progress!.steps) if (stages.includes(step.stage)) step.status = 'pending';
  };
  const validateDraft = async (stage: 'blueprint' | 'chapters', label: string, check: () => void, chapterId?: string) => {
    try { check(); }
    catch (error) {
      const issue = `${label}：${error instanceof Error ? error.message : '教材草稿校验未通过'}`;
      const finding: TextbookFinding = error instanceof TextbookValidationError ? { ...error.finding, message: issue }
        : { stage, chapterId, message: issue };
      recordTextbookFailure(job, [finding]);
      await save(stage);
      throw new Error(issue);
    }
  };
  // Credentials stay in memory. The exact approved endpoint/model is used for
  // every request, even if settings change between an async check and IPC send.
  let pinnedProviders: Record<typeof workflows[number], LlmProvider> | undefined;
  const model = async (workflow: typeof workflows[number], prompt: string, value: unknown): Promise<unknown> => {
    validateTextbookModelPolicy(job.spec.modelPolicy);
    const stage: TextbookModelStage = prompt === TEXTBOOK_SOURCE_PROMPT ? 'selection'
      : workflow === 'textbook-blueprint' ? 'blueprint' : workflow === 'textbook-chapter' ? 'chapter' : 'quality';
    const visualTargets = (value as { visualizationGuidance?: { targets?: Array<{ format?: unknown }> } })?.visualizationGuidance?.targets;
    const formats = Array.isArray(visualTargets) ? visualTargets.map(target => target.format).filter((format): format is string => typeof format === 'string') : [];
    const teachingChapter = (value as { chapter?: { id?: string } })?.chapter?.id;
    prompt = await loadTextbookPrompt(prompt, job.spec.promptVersion, job.spec.visualCapabilitiesVersion, formats,
      teachingChapter && job.checkpoint.blueprint ? textbookChapterTeachingTypes(job.checkpoint.blueprint, teachingChapter) : undefined);
    if (stage === 'quality' && usesProgressiveTextbookPrompt(job.spec.promptVersion)) prompt = indexedTextbookReviewPrompt(prompt);
    if (job.spec.promptVersion === undefined && (stage === 'blueprint' || stage === 'chapter')) prompt = textbookTimelinePrompt(prompt, job.spec.visualCapabilitiesVersion);
    if (job.spec.webSupplement && stage !== 'selection') prompt += '\n物料使用次序：本地资料和关联知识点为主，在线来源仅补教学任务的缺口，不扩大学习范围。补缺失败不是重生成理由；未取得的图片/表格不强行补造。网页图片只有本次 attached 像素可供识读，display_only 只展示原图。表格必须依据可读原表，不猜合并单元格、缺失数值或图中数据。';
    const originalBudget = textbookRequestBudget(job.spec.modelPolicy, stage, job.checkpoint.blueprint,
      stage === 'chapter' ? (value as { chapter?: { id?: string } })?.chapter?.id : undefined);
    const approved = job.spec.thinkingSnapshot ? { ...originalBudget, ...job.spec.thinkingSnapshot.stages[stage] } : originalBudget;
    const repairs = (value as { repairSections?: unknown[] })?.repairSections?.length;
    // Patches have much smaller outputs, always WITHIN the originally approved
    // cap. Never silently change an old task's thinking mode or provider hash.
    const budget = repairs && approved.thinkingMode === 'disabled' && !job.spec.thinkingSnapshot?.preferences[workflow] ? { ...approved, maxTokens: Math.min(approved.maxTokens, 1600 + 1600 * repairs),
      retryMaxTokens: Math.min(approved.retryMaxTokens, 3200 + 3200 * repairs) } : approved;
    let userInput = JSON.stringify(value);
    if (!pinnedProviders) {
      await ensureLlmSettingsLoaded();
      const captured = captureTextbookProviders(job.spec.allowCloud);
      if (await hashTextbookProviders(captured, job.spec.modelPolicy, job.spec.thinkingSnapshot) !== job.spec.providerHash) throw new Error('教材模型配置已变化，请重新准备并确认');
      pinnedProviders = captured;
    }
    const pinnedProvider = pinnedProviders[workflow];
    const pinnedModel = requireLlmModel(pinnedProvider);
    const thinkingPreference = job.spec.thinkingSnapshot?.preferences[workflow] || 'default';
    const requestThinking = resolveLlmThinkingPolicy(pinnedProvider, pinnedModel, budget.thinkingMode, thinkingPreference);
    const requestThinkingLevel = requestThinking.thinkingMode === 'disabled' ? 'off' : requestThinking.reasoningEffort
      ? effectiveThinkingLevel(pinnedProvider, pinnedModel, thinkingPreference) ?? (requestThinking.reasoningEffort === 'low' ? 'low' : undefined) : undefined;
    const visualKey = `${pinnedProvider.id}/${pinnedModel}`;
    const visual = await collectTextbookVisualInput((value as { sources?: TextbookSource[] })?.sources || [], job.spec.allowedDocIds,
      stage !== 'selection' && supportsImageInput(pinnedProvider, pinnedModel)
        && !job.checkpoint.visionFallbackModels?.includes(visualKey), undefined, signal);
    let requestImages = visual.images;
    if (visual.materials.length || (value as { sources?: TextbookSource[] })?.sources?.some(source => source.formulaEvidence?.length)) {
      prompt += `\n${TEXTBOOK_VISUAL_INPUT_PROMPT}`;
      userInput = JSON.stringify({ ...(value as object), visualInput: visual.materials });
    }
    // Time-dependent forgetting scores/warnings must not reset a spent request.
    // Material, teaching evidence, blueprint, repair findings and model still bind its identity.
    const identity = value as { context?: TextbookContext };
    const hashForVisual = (materials: typeof visual.materials, promptValue = prompt) => textbookHash({ workflow, prompt: promptValue,
      input: identity?.context ? { ...identity, context: contextIdentity(identity.context) } : value,
      budget, providerHash: job.spec.providerHash, ...(materials.length ? { visualInput: materials } : {}) });
    let inputHash = await hashForVisual(visual.materials);
    const chapterId = stage === 'chapter' ? job.checkpoint.progress!.chapterId : undefined;
    // Some already-running v2–v4 tasks recorded the accidentally extended
    // Mermaid prompt. Match that exact variant only, preserving spent attempts.
    const marker = '时序图须有真实角色顺序。禁止配置、样式、图标、HTML、链接、点击动作；';
    const affectedVersion = job.spec.promptVersion !== undefined && job.spec.promptVersion >= 2 && job.spec.promptVersion <= 4;
    const priorPrompt = affectedVersion && stage === 'chapter' && prompt.includes(marker)
      ? prompt.replace(marker, `时序图须有真实角色顺序。${TEXTBOOK_MERMAID_LINE_BREAK_GUIDANCE}禁止配置、样式、图标、HTML、链接、点击动作；`) : undefined;
    const rebindExactVariant = async (materials: typeof visual.materials) => {
      for (const candidatePrompt of [prompt, ...(priorPrompt ? [priorPrompt] : [])]) {
        const candidate = await hashForVisual(materials, candidatePrompt);
        if (candidate !== inputHash && job.checkpoint.modelAttempts?.some(item => item.inputHash === candidate
          && item.stage === stage && item.chapterId === chapterId)) {
          rebindTextbookModelAttempt(job, candidate, inputHash);
          await save(job.checkpoint.progress!.currentStage);
        }
      }
    };
    if (priorPrompt) await rebindExactVariant(visual.materials);
    // Older versions saved the pre-rejection image fingerprint. Recover it only
    // by exact match to the SAME approved input, never by stage/chapter alone.
    // This bounded local read is migration only; no pixels are sent to a model.
    if (visual.materials.length && job.checkpoint.visionFallbackModels?.includes(visualKey)
      && job.checkpoint.modelAttempts?.some(item => item.inputHash !== inputHash && item.stage === stage
        && item.chapterId === chapterId && (item.truncations > 0 || item.exhausted))) {
      const originalVisual = await collectTextbookVisualInput((value as { sources?: TextbookSource[] })?.sources || [],
        job.spec.allowedDocIds, true, undefined, signal);
      await rebindExactVariant(originalVisual.materials);
    }
    const previous = job.checkpoint.modelAttempts?.find((item) => item.inputHash === inputHash);
    const stageTitle = ({ selection: '选材', blueprint: '教学蓝图', chapter: `章节 ${job.checkpoint.progress!.chapterId || ''}`, quality: '质量复核' })[stage];
    const exhaustedMessage = () => `${stageTitle}输出在已批准上限 ${budget.retryMaxTokens} tokens 下仍截断；同一输入已达到重试上限，继续不会重复请求。请缩小单章范围或重新准备并确认调整后的生成方案；已保存的物料和章节保留`;
    if (previous?.exhausted) throw new Error(exhaustedMessage());
    // Resume the upper-budget request after a stop/network failure, rather than
    // spending the initial budget again. Two truncations remain exhausted across restarts.
    const firstAttempt = previous?.truncations || 0;
    for (let attempt = firstAttempt; attempt <= job.spec.modelPolicy.maxTruncationRetries; attempt++) {
      signal?.throwIfAborted();
      await assertCurrent(ctx, job, deps);
      let maxTokens = attempt === 0 ? budget.maxTokens : budget.retryMaxTokens;
      job.checkpoint.progress!.requestMaxTokens = maxTokens;
      const requestProgress = job.checkpoint.progress!;
      requestProgress.requestThinkingResolved = true;
      requestProgress.requestThinkingPreference = thinkingPreference;
      if (requestThinking.thinkingMode) requestProgress.requestThinkingMode = requestThinking.thinkingMode;
      else delete requestProgress.requestThinkingMode;
      if (requestThinking.reasoningEffort) requestProgress.requestReasoningEffort = requestThinking.reasoningEffort;
      else delete requestProgress.requestReasoningEffort;
      if (requestThinkingLevel) requestProgress.requestThinkingLevel = requestThinkingLevel;
      else delete requestProgress.requestThinkingLevel;
      if (attempt > 0 && firstAttempt > 0) {
        job.checkpoint.progress!.retry = attempt;
        job.checkpoint.progress!.label = `从检查点继续${stageTitle}的已批准上限请求（${maxTokens} tokens）`;
      }
      let reservation: number;
      try { reservation = reserveTextbookRequest(job, prompt, userInput, maxTokens, requestImages.length * LLM_IMAGE_TOKEN_RESERVE); }
      catch (error) { await save(job.checkpoint.progress!.currentStage); throw error; }
      await save(job.checkpoint.progress!.currentStage);
      const request: LlmCallRequest = { providerId: pinnedProvider.id, model: pinnedModel, workflow, userInput, systemPromptOverride: prompt,
        skipMemoryInjection: true, skipProfileInjection: true, outputSchema: { type: 'object' }, thinkingMode: budget.thinkingMode,
        thinkingPreference,
        maxTokensOverride: maxTokens, tokenBudgetMode: 'total', ...(requestImages.length ? { images: requestImages } : {}) };
      let response: LlmCallResponse;
      try { response = await deps.model(request, signal, structuredClone(pinnedProvider)); }
      catch (error) {
        signal?.throwIfAborted();
        if (!requestImages.length || !String(error).includes('LLM_IMAGE_UNSUPPORTED:')) throw error;
        job.checkpoint.visionFallbackModels = [...new Set([...(job.checkpoint.visionFallbackModels || []), visualKey])];
        requestImages = [];
        userInput = JSON.stringify({ ...(value as object), visualInput: visual.materials.map(item => ({ ...item,
          status: item.status === 'attached' ? 'display_only' : item.status })) });
        job.checkpoint.progress!.label = '模型接口不支持图片，改用文字生成并保留原图';
        // Future calls skip pixel reads and mark all assets display_only. Use
        // that same identity NOW, including when the text request is interrupted.
        const textHash = await hashForVisual(visual.materials.map(item => ({ ...item, status: 'display_only' })));
        const textAttempt = rebindTextbookModelAttempt(job, inputHash, textHash);
        inputHash = textHash;
        await save(job.checkpoint.progress!.currentStage);
        if (textAttempt?.exhausted) throw new Error(exhaustedMessage());
        attempt = Math.max(attempt, textAttempt?.truncations || 0);
        maxTokens = attempt === 0 ? budget.maxTokens : budget.retryMaxTokens;
        job.checkpoint.progress!.requestMaxTokens = maxTokens;
        job.checkpoint.progress!.retry = attempt;
        // A rejected image request is still a request. Never reset or hide the cost ledger.
        reservation = reserveTextbookRequest(job, prompt, userInput, maxTokens);
        await save(job.checkpoint.progress!.currentStage);
        await assertCurrent(ctx, job, deps);
        response = await deps.model({ ...request, userInput, images: undefined, maxTokensOverride: maxTokens }, signal, structuredClone(pinnedProvider));
      }
      settleTextbookRequest(job, reservation, response.usage);
      const truncated = textbookResponseTruncated(response.diagnostics?.finishReason);
      const count = (number?: number) => Number.isSafeInteger(number) && number! >= 0 ? number : undefined;
      const diagnostic = { inputHash, stage, chapterId: stage === 'chapter' ? job.checkpoint.progress!.chapterId : undefined,
        truncations: truncated ? attempt + 1 : 0, exhausted: truncated && attempt >= job.spec.modelPolicy.maxTruncationRetries,
        maxTokens, outputChars: response.content?.length || 0, promptTokens: count(response.usage?.promptTokens), completionTokens: count(response.usage?.completionTokens),
        reasoningTokens: count(response.diagnostics?.reasoningTokens), hadReasoningContent: response.diagnostics?.hadReasoningContent === true };
      job.checkpoint.modelAttempts = [...(job.checkpoint.modelAttempts || []).filter((item) => item.inputHash !== inputHash), diagnostic].slice(-64);
      await save(job.checkpoint.progress!.currentStage);
      signal?.throwIfAborted();
      await assertCurrent(ctx, job, deps);
      if (truncated && attempt < job.spec.modelPolicy.maxTruncationRetries) {
        const state = job.checkpoint.progress!;
        state.retry = attempt + 1;
        state.label = `${stageTitle}输出截断（正文 ${diagnostic.outputChars} 字符${diagnostic.completionTokens === undefined ? '' : `，生成 ${diagnostic.completionTokens} tokens`}），仅重试一次：${budget.retryMaxTokens} tokens`;
        state.history = [...state.history, { at: new Date().toISOString(), stage: state.currentStage, label: state.label }].slice(-24);
        await save(state.currentStage);
        continue; // Discard the partial response; never splice or publish incomplete JSON.
      }
      if (truncated) throw new Error(exhaustedMessage());
      return parsedModel(response);
    }
    throw new Error('教材模型重试次数超过已批准上限');
  };
  try {
    // Crash after durable note save but before finishing the private job: reconcile, do not generate again.
    if (already.textbook?.generationJobId === job.id && (!job.checkpoint.publishedRevision
      || already.textbook.revisionId === job.checkpoint.publishedRevision.nextRevisionId)) {
      await updateProgress('publishing', '核验已保存教材，不重新生成'); validateTextbookJob(job, job.checkpoint.body || '');
      job = (await deps.command({ op: 'finish', jobId, token })).job;
      broadcast(false);
      return { status: 'published', saved: true, projectNoteId: already.id, revisionId: already.textbook.revisionId, jobId };
    }
    await updateProgress('context', '核对可信画像与相关认知证据');
    // Chapter revision reuses the approved original teaching context, not a new whole-book design.
    const context = job.checkpoint.publishedRevision ? structuredClone(job.checkpoint.context!) : await deps.context(ctx, job.spec.projectNoteId);
    if (job.checkpoint.context && await textbookHash(contextIdentity(context)) !== await textbookHash(contextIdentity(job.checkpoint.context))) {
      if (regenerateChapterIds || job.checkpoint.chapterRegeneration?.pendingIds.length) throw new Error('画像或教学上下文已变化，无法仅重做指定章节；原草稿保留，请先检查并重新确认范围');
      // Material selection depends on project scope, not on private learning history.
      // Approved versions are checked separately. Keep frozen sources, rebuild dependent teaching artifacts.
      const { sources, progress, cost, modelAttempts, webReads, localMaterialWarnings, visionFallbackModels, webSupplement } = job.checkpoint; job.checkpoint = { sources, progress, cost, modelAttempts, webReads, localMaterialWarnings, visionFallbackModels, webSupplement };
      invalidateProgress('blueprint', 'chapters', 'validating', 'publishing');
      job.checkpoint.progress!.history.push({ at: new Date().toISOString(), stage: 'context', label: '个性化上下文发生变化，保留物料并重新设计教学内容' });
    }
    job.checkpoint.context = context; await updateProgress('context', '画像与认知已核对', 'saved');
    if (regenerateChapterIds && !publishedClaim) { queueTextbookChapterRegeneration(job, regenerateChapterIds); await save('context'); }
    clearRegeneratingChapterFailures(job);
    if (!job.checkpoint.sources) {
      await updateProgress('materials', '读取本地资料目录与完整原文');
      const localMaterialJob = job;
      const sources = await deps.sources(localMaterialJob, context, model, signal);
      job.checkpoint.localMaterialWarnings = localMaterialJob.checkpoint.localMaterialWarnings;
      if (!job.spec.webSupplement && !sources.some((source) => source.kind === 'document') && job.spec.readBoundUrls && job.spec.boundUrls?.length) {
        const materialJob = job;
        sources.push(...await collectBoundTextbookSources(materialJob, token, deps.webRead || readTextbookBoundUrl,
          (label) => { job.checkpoint.webReads = materialJob.checkpoint.webReads; return updateProgress('materials', label); }, signal));
      }
      for (const [index, id] of Object.keys(job.spec.knowledgeHashes).entries()) {
        const note = ctx.getNotes().find((item) => item.id === id && item.noteType === 'knowledge');
        if (!note) throw new Error('关联知识点已失效');
        if (note.content.length > 18_000) throw new Error('知识点原文过长，请先缩小资料范围；不会静默截断');
        sources.push({ sourceId: `N${index + 1}`, kind: 'knowledge', id, title: note.title, version: job.spec.knowledgeHashes[id],
          text: note.content.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+/gu, '[图片字节省略；不作为事实证据]') });
      }
      if (job.spec.webSupplement) {
        const addWarnings = (...items: string[]) => { job.checkpoint.localMaterialWarnings = [...(job.checkpoint.localMaterialWarnings || []), ...items].slice(-20); };
        if (textbookSupplementGaps(job.spec.webSupplement, sources).length && job.spec.readBoundUrls && job.spec.boundUrls?.length) {
          try {
            const materialJob = job;
            sources.push(...await collectBoundTextbookSources(materialJob, token, deps.webRead || readTextbookBoundUrl,
              label => { job.checkpoint.webReads = materialJob.checkpoint.webReads; return updateProgress('materials', label); }, signal, sources.length));
          } catch (error) { signal?.throwIfAborted(); addWarnings(`可选绑定网页读取已跳过：${safeTextbookWebError(error)}`); }
        }
        const gaps = textbookSupplementGaps(job.spec.webSupplement, sources);
        if (gaps.length) {
          await updateProgress('materials', `检查到 ${gaps.length} 项物料覆盖提示，正在可选联网补缺（失败跳过）`);
          try {
            const result = await (deps.supplement || supplementTextbookMaterials)({ jobId: job.id, token, gaps }, signal);
            signal?.throwIfAborted();
            if (!Array.isArray(result.snapshots) || !Array.isArray(result.warnings) || !Array.isArray(result.queries)
              || result.warnings.some(w => typeof w !== 'string') || result.queries.some(q => typeof q !== 'string')) throw new Error('补缺响应无效，使用已有物料继续');
            let usedChars = sources.reduce((sum, s) => sum + s.text.length, 0), count = 0;
            const urls = new Set(sources.filter(s => s.web).map(s => s.web!.url));
            for (const snapshot of result.snapshots.slice(0, 3)) {
              if (snapshot.jobId !== job.id || !/^S[1-3]$/u.test(snapshot.resourceId) || !/^[a-f0-9]{64}$/u.test(snapshot.version)
                || snapshot.web?.snapshotId !== `${job.id}-${snapshot.resourceId}` || !snapshot.text?.trim() || urls.has(snapshot.web.url)) continue;
              const room = Math.min(4000, 98_000 - usedChars); if (room < 500) { addWarnings('现有物料已接近输入预算，未追加在线正文，继续使用本地物料'); break; }
              const source = textbookWebSource(snapshot, `L${sources.length + 1}`, room);
              usedChars += source.text.length; sources.push(source); urls.add(snapshot.web.url); count++;
            }
            job.checkpoint.webSupplement = { queries: result.queries, warnings: result.warnings.slice(0, 8), count };
            addWarnings(...result.warnings.slice(0, 8));
          } catch (error) {
            signal?.throwIfAborted();
            const warning = `联网补缺失败已跳过，继续使用已有物料：${safeTextbookWebError(error)}`;
            job.checkpoint.webSupplement = { queries: gaps.map(g => g.query), warnings: [warning], count: 0 }; addWarnings(warning);
          }
          await updateProgress('materials', `可选联网补缺结束：加入 ${job.checkpoint.webSupplement?.count || 0} 个来源；失败项已跳过`);
        } else job.checkpoint.webSupplement = { queries: [], warnings: [], count: 0 };
      }
      if (!sources.length) throw new Error(`相关物料不足：${job.checkpoint.webReads?.some(item => item.status === 'failed')
        ? '不可读 URL 已跳过，但批准范围内没有其他可用正文' : '批准范围内没有可用正文'}；请补全关联知识点或添加可读资料后重新准备，不会编造来源。`);
      if (sources.reduce((total, item) => total + item.text.length, 0) > 100_000) throw new Error('相关物料超出本阶段预算，请调整资料范围');
      job.checkpoint.sources = sources;
    }
    const failures = job.checkpoint.webReads?.filter((item) => item.status === 'failed') || [];
    await updateProgress('materials', job.checkpoint.sources?.some((source) => source.kind === 'web')
      ? `网页正文选段与物料已保存，后续阶段复用；${failures.length ? `${failures.length} 个 URL 未读取，详见物料状态` : '公开链接读取完成'}`
      : failures.length
        ? `已跳过 ${failures.length} 个不可读 URL；使用已批准的${job.checkpoint.sources?.some((source) => source.kind === 'document') ? '本地资料' : '关联知识点正文'}继续生成，详见物料状态`
        : '本地物料已保存，可在后续阶段复用；未读取网页', 'saved');
    await assertCurrent(ctx, job, deps); const sources = job.checkpoint.sources;
    const reconciled = reconcileTextbookReviewCheckpoint(job);
    if (reconciled) {
      await updateProgress('materials', reconciled === 'retained' ? '旧复核意见待按新标准核验，保留蓝图和章节重新复核' : '旧草稿错误已由代码复现，按位置修复', 'saved');
    }
    // Bind legacy valid chapters before invalidating their blueprint/preceding summary.
    job.checkpoint.chapterInputs ||= {};
    for (const chapter of job.checkpoint.blueprint?.chapters || []) {
      if (job.checkpoint.chapters?.some((item) => item.id === chapter.id) && !job.checkpoint.chapterInputs[chapter.id]) {
        job.checkpoint.chapterInputs[chapter.id] = await textbookHash(chapterInputIdentity(job, chapter));
      }
    }
    if (job.checkpoint.repair && !job.checkpoint.repair.applied) {
      if (job.checkpoint.publishedRevision && job.checkpoint.repair.findings.some(finding => finding.stage === 'blueprint'
        || finding.stage === 'chapters' && !job.checkpoint.publishedRevision!.chapterIds.includes(finding.chapterId || ''))) {
        throw new Error('复核问题超出本次指定章节，旧教材保留；请明确扩大章节范围后另行确认，不自动重写其它章节');
      }
      try { consumeTextbookRound(job, 'repairs'); }
      catch (error) { await save('materials'); throw error; }
      const findings = job.checkpoint.repair.findings;
      if (findings.some((finding) => finding.stage === 'blueprint')) { job.checkpoint.blueprint = undefined; invalidateProgress('blueprint', 'chapters'); }
      const targets = new Set(findings.filter((finding) => finding.stage === 'chapters').map((finding) => finding.chapterId));
      job.checkpoint.sectionRepairs ||= {};
      for (const id of targets) {
        const located = findings.filter((finding) => finding.stage === 'chapters' && finding.chapterId === id);
        if (id && job.checkpoint.chapters?.some((chapter) => chapter.id === id) && located.every((finding) => finding.section)) {
          job.checkpoint.sectionRepairs[id] = [...new Set(located.map((finding) => finding.section!))];
          targets.delete(id);
        }
      }
      job.checkpoint.chapters = (job.checkpoint.chapters || []).filter((chapter) => !targets.has(chapter.id));
      if (targets.size || Object.keys(job.checkpoint.sectionRepairs).length) invalidateProgress('chapters');
      job.checkpoint.quality = undefined; job.checkpoint.body = undefined; job.checkpoint.repair.applied = true;
      invalidateProgress('validating', 'publishing');
      await save('materials');
    }
    const repairIssues = job.checkpoint.repairIssues;
    if (!job.checkpoint.blueprint) {
      await updateProgress('blueprint', usesProgressiveTextbookPrompt(job.spec.promptVersion) ? '识别教材类型并设计教学蓝图' : '设计针对性教学蓝图');
      const prompt = TEXTBOOK_BLUEPRINT_PROMPT + (job.spec.modelPolicy?.version === 4 ? TEXTBOOK_SELECTIVE_THINKING_PROMPT : '');
      const blueprint = await model('textbook-blueprint', prompt, { context, sources, repairIssues });
      await validateDraft('blueprint', '教学蓝图', () => { job.checkpoint.blueprint = assembleTeachingBlueprint(blueprint, context, sources, true, usesProgressiveTextbookPrompt(job.spec.promptVersion)); });
      await save('blueprint');
    }
    if (!job.checkpoint.blueprint) throw new Error('教学蓝图尚未生成');
    const blueprint = job.checkpoint.blueprint;
    await validateDraft('blueprint', '教学蓝图', () => validateBlueprint(blueprint, context, sources));
    await updateProgress('blueprint', '教学蓝图已校验并保存', 'saved');
    job.checkpoint.chapters ||= [];
    job.checkpoint.chapters = job.checkpoint.chapters.filter((chapter) => blueprint.chapters.some((item) => item.id === chapter.id));
    for (const [index, chapter] of blueprint.chapters.entries()) {
      const inputHash = await textbookHash(chapterInputIdentity(job, chapter));
      let existing = job.checkpoint.chapters.find((item) => item.id === chapter.id);
      if (existing && job.checkpoint.chapterInputs![chapter.id] !== inputHash
        && (!job.checkpoint.publishedRevision || job.checkpoint.publishedRevision.chapterIds.includes(chapter.id))) {
        job.checkpoint.chapters = job.checkpoint.chapters.filter((item) => item.id !== chapter.id); existing = undefined;
        job.checkpoint.body = undefined; job.checkpoint.quality = undefined; invalidateProgress('chapters', 'validating', 'publishing');
        delete job.checkpoint.sectionRepairs?.[chapter.id];
      }
      const assetIds = sources.filter((item) => chapter.sourceIds.includes(item.sourceId)).flatMap((item) => (item.assets || []).map((asset) => asset.id));
      const chapterLabel = `章节 ${chapter.id}（允许来源 ${chapter.sourceIds.join('、')}）`;
      await updateProgress('chapters', `${existing ? '复用已保存章节' : '生成教学章节'} ${index + 1}/${blueprint.chapters.length}：${chapter.title}`, 'running', { ...chapter, index: index + 1 });
      const repairSections = job.checkpoint.sectionRepairs?.[chapter.id];
      if (existing && repairSections?.length) {
        await updateProgress('chapters', `只修订 ${chapter.title} 的 ${repairSections.join('、')}；其它小节保留`, 'running', { ...chapter, index: index + 1 });
        const patch = await model('textbook-chapter', textbookRestatementWritingPrompt(TEXTBOOK_SECTION_REPAIR_PROMPT, chapter, repairSections), { context, blueprint, chapter,
          originalChapter: existing, repairSections,
          visualizationGuidance: textbookVisualGuidance(blueprint, chapter.id, repairSections),
          repairFindings: job.checkpoint.repair?.findings.filter((finding) => finding.chapterId === chapter.id),
          previousSummary: textbookContinuitySummary(job.checkpoint.chapters.find((item) => item.id === blueprint.chapters[index - 1]?.id)),
          sources: sources.filter((item) => chapter.sourceIds.includes(item.sourceId)) });
        let merged: TextbookChapter;
        try {
          merged = mergeTextbookSectionRepair(existing, repairSections, patch);
          validateChapter(merged, chapter.id, chapter.sourceIds, assetIds, chapter.writingPlan);
        } catch (error) {
          const message = error instanceof Error ? error.message : '小节修订校验未通过';
          recordTextbookFailure(job, error instanceof TextbookValidationError ? error.findings : repairSections.map((section) => ({ stage: 'chapters', chapterId: chapter.id, section, message })));
          await save('chapters'); throw error;
        }
        job.checkpoint.chapters = job.checkpoint.chapters.map((item) => item.id === chapter.id ? merged : item);
        job.checkpoint.chapterInputs![chapter.id] = inputHash;
        delete job.checkpoint.sectionRepairs![chapter.id];
        await save('chapters'); continue;
      }
      if (existing) { await validateDraft('chapters', chapterLabel, () => validateChapter(existing, chapter.id, chapter.sourceIds, assetIds, chapter.writingPlan), chapter.id); continue; }
      const chapterPrompt = `${textbookRestatementWritingPrompt(TEXTBOOK_CHAPTER_PROMPT, chapter)}\n本章事实来源白名单（以本次提供的原文为准）：${JSON.stringify(chapter.sourceIds)}。只引用这个数组中的编号；不能照抄提示示例的 L1/N1，不能引用其它章来源。`;
      const written = await model('textbook-chapter', chapterPrompt, { context, blueprint, chapter,
        ...(job.checkpoint.chapterRegeneration?.pendingIds.includes(chapter.id)
          ? { explicitRegeneration: { requestedAt: job.checkpoint.chapterRegeneration.requestedAt, chapterIds: job.checkpoint.chapterRegeneration.requestedIds } } : {}),
        visualizationGuidance: textbookVisualGuidance(blueprint, chapter.id),
        repairIssues: job.checkpoint.repair?.findings.filter((finding) => finding.stage === 'blueprint' || finding.chapterId === chapter.id).map((finding) => finding.message) || repairIssues,
        repairFindings: job.checkpoint.repair?.findings.filter((finding) => finding.stage === 'blueprint' || finding.chapterId === chapter.id),
        previousSummary: textbookContinuitySummary(job.checkpoint.chapters.find((item) => item.id === blueprint.chapters[index - 1]?.id)),
        sources: sources.filter((item) => chapter.sourceIds.includes(item.sourceId)) });
      await validateDraft('chapters', chapterLabel, () => validateChapter(written, chapter.id, chapter.sourceIds, assetIds, chapter.writingPlan), chapter.id);
      job.checkpoint.chapters.push(written as TextbookChapter); job.checkpoint.chapterInputs![chapter.id] = inputHash;
      if (job.checkpoint.chapterRegeneration) job.checkpoint.chapterRegeneration.pendingIds = job.checkpoint.chapterRegeneration.pendingIds.filter((id) => id !== chapter.id);
      job.checkpoint.chapters.sort((a, b) => blueprint.chapters.findIndex((item) => item.id === a.id) - blueprint.chapters.findIndex((item) => item.id === b.id));
      await save('chapters');
    }
    await updateProgress('chapters', '全部章节已校验并保存', 'saved');
    const body = assembleTextbook(blueprint, job.checkpoint.chapters, sources);
    assertPublishedRevisionBody(job, body);
    const artifactHash = await textbookHash(body);
    const reviewInput = { context: contextIdentity(context) as TextbookContext, blueprint, sources, chapters: job.checkpoint.chapters.map(textbookChapterContent) };
    const reviewPlan = await planTextbookReview(job, reviewInput);
    const reuseQuality = !!reviewPlan.cachedQuality;
    if (reuseQuality) {
      if (!reviewPlan.cachedQuality!.passed) recordTextbookFailure(job, reviewPlan.cachedQuality!.findings!, 'reviewer');
      job.checkpoint.quality = { ...reviewPlan.cachedQuality!, reviewCriteriaVersion: 3, artifactHash };
    }
    job.checkpoint.body = body;
    await updateProgress('validating', reuseQuality ? reviewPlan.cachedQuality!.passed ? '复用已通过的教材质量校验' : '内容未改变，保留已有真实问题，不重复请求复核' : '先校验结构、引用、来源范围与隐私');
    try { validateTextbookContent(job, body); }
    catch (error) {
      const message = error instanceof Error ? error.message : '教材确定性校验未通过';
      recordTextbookFailure(job, error instanceof TextbookValidationError ? error.findings : [locateTextbookIssue(message, blueprint)]);
      await save('validating'); throw error;
    }
    if (!reuseQuality) {
      await updateProgress('validating', reviewPlan.scoped ? `复用未修改章节的复核，只检查 ${reviewPlan.changed.join('、')} 及相邻承接` : '结构与隐私已通过，复核事实支持、讲授逻辑和任务覆盖');
      try {
        if (job.checkpoint.quality?.status === 'needs_recheck') consumeTextbookRound(job, 'reviews');
        // Only location diagnostics, never the previous verdict/quotes. Retain
        // this feedback across transport/truncation failures for a stable retry.
        const correction = job.checkpoint.quality?.status === 'needs_recheck' ? job.checkpoint.quality.reviewDiagnostics
          ?.filter(item => item.disposition === 'needs_recheck').map(({ findingIndex, field, message }) => ({ findingIndex, field, message })) : undefined;
        const rawReview = await model('textbook-quality', textbookTeachingReviewPrompt(TEXTBOOK_QUALITY_PROMPT, blueprint), {
          ...(usesProgressiveTextbookPrompt(job.spec.promptVersion) ? indexTextbookReview(reviewPlan.input).request : reviewPlan.input),
          ...(correction?.length ? { reportCorrection: { invalidLocations: correction, instruction: '上次报告这些位置未能核验。重新定位当前原文；仅纠正复核报告，不改写教材，不复用上次错误引文。' } } : {}),
          reviewScope: { kind: reviewPlan.scoped ? 'changed_chapters' : 'full_book', chapterIds: reviewPlan.changed },
          deterministicChecks: { passed: true, checks: ['structure', 'source_membership', 'objective_focus_mapping', 'format_safety', 'source_scope', 'privacy'] } });
        const quality = acceptTextbookReview(job, reviewPlan, rawReview, reviewInput);
        if (quality.passed) { delete job.checkpoint.repairIssues; delete job.checkpoint.repair; }
        else recordTextbookFailure(job, quality.findings!, 'reviewer');
        job.checkpoint.quality = { ...quality, reviewCriteriaVersion: 3, artifactHash };
      } catch (error) {
        if (error instanceof TextbookBudgetError) { await save('validating'); throw error; }
        recordUnreliableTextbookReview(job, error instanceof TextbookReviewError ? error : '复核请求未完成，未取得有效复核报告');
        await save('validating');
        if (error instanceof TextbookReviewError) throw new Error(`质量复核报告不可信：${error.message}。未发布教材；蓝图和章节保留，确认后仅重做质量复核`);
        throw error;
      }
      await save('validating');
    }
    if (job.checkpoint.quality?.passed === false) {
      const targets = job.checkpoint.repair?.findings.map((finding) => finding.stage === 'blueprint' ? '教学蓝图'
        : finding.stage === 'validating' ? '尚未定位，需重新复核' : `${finding.chapterId}${finding.section ? `.${finding.section}` : ''}`) || [];
      throw new Error(`教材质量复核未通过；待修复：${[...new Set(targets)].join('、')}。检查点保留，确认后按问题位置恢复`);
    }
    try { validateTextbookJob(job, job.checkpoint.body); }
    catch (error) {
      if (job.checkpoint.quality?.passed) {
        const message = error instanceof Error ? error.message : '教材发布前校验未通过';
        recordTextbookFailure(job, error instanceof TextbookValidationError ? error.findings : [locateTextbookIssue(message, blueprint)]);
        await save('validating');
      }
      throw error;
    }
    const warningCount = job.checkpoint.quality?.warnings?.length || 0;
    await updateProgress('validating', warningCount ? `教材质量校验已通过（${warningCount} 条非阻断改进建议）` : '教材质量校验已通过', 'saved');
    await ctx.ensureDataFresh(); await assertCurrent(ctx, job, deps);
    // Teaching uses the coherent context captured at start. Time-dependent forgetting scores or a new review
    // record must not invalidate an otherwise complete book; a fresh approved retry rechecks context identity.
    await updateProgress('publishing', '保存到目标项目笔记'); signal?.throwIfAborted();
    const published = await ctx.publishTextbook({ job, body: job.checkpoint.body, signal });
    // Persistence is a non-cancellable commit. A late stop cannot turn a completed save into "not written".
    job = (await deps.command({ op: 'finish', jobId, token })).job;
    broadcast(false);
    return { status: 'published', saved: true, jobId, projectNoteId: published.id, revisionId: published.textbook?.revisionId,
      chapterCount: blueprint.chapters.length, sourceCount: sources.length, warningCount, skippedUrlCount: failures.length,
      message: `${failures.length ? `已跳过 ${failures.length} 个不可读 URL，基于其余已批准来源生成。` : ''}教材已写入目标项目笔记，可进入现有心流阅读；此前复习仍使用独立入口。` };
  } catch (error) {
    const cancelled = signal?.aborted === true; const message = error instanceof Error ? error.message : '教材生成失败';
    try { await save(job.checkpoint.progress!.currentStage, false); } catch { /* Reservation was already durable before dispatch. */ }
    try { job = (await deps.command({ op: 'stop', jobId, token, cancelled, error: message })).job; broadcast(false); } catch { /* Preserve original failure; checkpoint remains durable. */ }
    throw error;
  }
}
export async function applyTextbookPublication(note: NoteItem, notes: NoteItem[], input: TextbookPublishInput): Promise<NoteItem> {
  validateTextbookJob(input.job, input.body); input.signal?.throwIfAborted(); const spec = input.job.spec;
  if (note.id !== spec.projectNoteId || !isLearningProject(note) || textbookRoot(note, notes).id !== spec.rootProjectId) throw new Error('教材目标学习项目已失效');
  const revision = input.job.checkpoint.publishedRevision;
  if (note.textbook?.generationJobId === input.job.id && (!revision || note.textbook.revisionId === revision.nextRevisionId)
    && readTextbookBody(note.content, note.textbook) === input.body.trim()) return note;
  if (revision) {
    if (!note.textbook || note.textbook.generationJobId !== input.job.id || note.textbook.revisionId !== revision.revisionId
      || readTextbookBody(note.content, note.textbook) !== revision.body.trim()
      || await textbookHash(projectPlanningSnapshot(note, notes, spec.allowedDocIds)) !== spec.planningHash) throw new Error('教材或项目自确认后已变化，原教材保留；未覆盖最新编辑');
    assertPublishedRevisionBody(input.job, input.body);
    return writeTextbookRegion(note, input.body, { ...note.textbook, revisionId: revision.nextRevisionId, updatedAt: new Date().toISOString() });
  }
  if (note.textbook || await textbookHash(projectPlanningSnapshot(note, notes, spec.allowedDocIds)) !== spec.planningHash) throw new Error('目标项目已有教材或已修改（包含继承资料绑定变化），本次不覆盖');
  const assets = input.job.checkpoint.sources!.flatMap(source => source.assets || []);
  const durableAssets = [];
  for (const asset of assets) {
    input.signal?.throwIfAborted();
    // Web images were already downloaded and durably scoped by the host. Never refetch at publication.
    if (input.job.checkpoint.sources!.some(s => s.kind === 'web' && s.sourceId === asset.sourceId) && asset.attachmentHash) { durableAssets.push(asset); continue; }
    // Old/non-desktop callers retain pointers. In the desktop, persist local
    // bytes before saving the note; source changes never become a silent fallback.
    try {
      const image = await readLocalMaterialImage({ allowedDocIds: spec.allowedDocIds, docId: asset.docId,
        version: asset.version, blockId: asset.blockId, imageIndex: asset.imageIndex, saveAttachment: true });
      durableAssets.push({ ...asset, ...(image.attachmentHash ? { attachmentHash: image.attachmentHash } : {}) });
    } catch (error) {
      if (error instanceof MaterialError && ['SOURCE_CHANGED', 'OUT_OF_SCOPE'].includes(error.code)) throw error;
      durableAssets.push(asset); // Missing optional image must not discard the completed textbook.
    }
  }
  const at = new Date().toISOString();
  return writeTextbookRegion(note, input.body, { schemaVersion: 1, textbookId: input.job.id, regionId: `book-${input.job.id}`,
    projectNoteId: note.id, rootProjectId: spec.rootProjectId, revisionId: `${input.job.id}-v1`, generationJobId: input.job.id,
    createdAt: at, updatedAt: at, chapters: input.job.checkpoint.blueprint!.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
    sources: input.job.checkpoint.sources!.map((source) => ({ sourceId: source.sourceId, kind: source.kind, id: source.id, title: source.title, version: source.version, locator: source.locator,
      blockId: source.blockId, textStart: source.textStart, textEnd: source.textEnd, web: source.web })),
    assets: durableAssets });
}
