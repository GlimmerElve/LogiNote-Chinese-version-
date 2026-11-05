import { registerTool } from '../toolRegistry';
import { canonicalAgentValue } from '../approvalBinding';
import { documentMaintenanceIdentity, validateDocumentMaintenance } from '../../documentMaintenance';
import { listDocuments, documentProcessingContext, maintainDocument } from '../../documentRagClient';
import { documentBackgroundJobs, startDocumentGraphBackgroundJob } from '../../documentBackgroundJobs';
import { documentJobActive } from '../../documentBackgroundQueue';
import { canProcessDocumentArgument, documentGraphAction } from '../../documentProcessingActions';
import { ensureLlmSettingsLoaded } from '../../llmStorage';
import { resolveProvider } from '../../llmService';
import { getKnowledgeSettings } from '../../knowledgeRagClient';

const defaults = { list: listDocuments, context: documentProcessingContext, maintain: maintainDocument,
  jobs: documentBackgroundJobs, start: startDocumentGraphBackgroundJob, loadModels: ensureLlmSettingsLoaded,
  provider: () => resolveProvider('document-knowledge-extract'), settings: getKnowledgeSettings };
function request(args: Record<string, unknown>, category: boolean) {
  if (Object.keys(args).some(key => !['documentIds', category ? 'category' : 'operation'].includes(key))
    || !Array.isArray(args.documentIds) || !args.documentIds.length || args.documentIds.length > 10
    || args.documentIds.some(id => typeof id !== 'string' || !/^doc-[A-Za-z0-9._-]+$/u.test(id))
    || new Set(args.documentIds).size !== args.documentIds.length) throw new Error('请先查询并选择1至10个不重复的真实资料ID');
  if (category ? typeof args.category !== 'string' || args.category !== args.category.trim() || args.category.length > 80
    || /[\u0000-\u001f\u007f]/u.test(args.category) : !['body-index', 'argument-graph', 'body-and-argument'].includes(String(args.operation))) throw new Error('资料维护操作或分类名称无效');
  return args.documentIds as string[];
}
/** Only existing module runners. No filesystem paths, model settings or arbitrary tool scripts. */
export function registerDocumentMaintenanceTools(deps = defaults): void {
  type Preview = Awaited<ReturnType<typeof snapshot>>;
  const previews = new Map<string, Preview>();
  async function snapshot(args: Record<string, unknown>, category: boolean) {
    const ids = request(args, category), context = await deps.context();
    await deps.jobs.ensureReady();
    const catalog = await deps.list();
    const documents = ids.map(id => {
      const doc = catalog.find(item => item.id === id);
      if (!doc) throw new Error('部分资料已不存在，未按文件名替换目标');
      if (!category && deps.jobs.getSnapshot().some(job => job.docId === id && documentJobActive(job))) throw new Error('该资料已有论证任务，请查询原任务，不重复生成或重建正文');
      if (!category && args.operation === 'body-index') validateDocumentMaintenance({ documentId: id, expectedContext: context,
        expectedIdentity: documentMaintenanceIdentity(doc), operation: 'body-index' }, doc, context);
      if (!category && args.operation === 'argument-graph'
        && (!canProcessDocumentArgument(doc) || doc.documentGraphProgress?.stale || !documentGraphAction(doc).action)) throw new Error('资料正文未就绪、论证图待重建或已经完成；不会自动重建旧图');
      if (!category && args.operation === 'body-and-argument') validateDocumentMaintenance({ documentId: id, expectedContext: context,
        expectedIdentity: documentMaintenanceIdentity(doc), operation: 'body-index' }, doc, context);
      return structuredClone(doc);
    });
    let configuration = '', modelLabel = '';
    if (!category && args.operation !== 'body-index') {
      await deps.loadModels();
      const provider = deps.provider(), settings = await deps.settings();
      if (!provider || !settings.enabled) throw new Error('请先在设置中配置并启用论证抽取模型');
      const url = new URL(provider.baseUrl), local = provider.apiType === 'ollama' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
      if (settings.processingMode === 'local-only' && !local) throw new Error('本机模式不能使用远程模型；不会替用户修改设置');
      configuration = JSON.stringify([provider, settings]);
      modelLabel = `${local ? '本机' : '远程'} ${provider.name} / ${provider.selectedModel || provider.models[0]} / ${url.origin}`;
    }
    if (await deps.context() !== context) throw new Error('资料处理环境变化，请重新确认');
    return { context, documents, configuration, modelLabel };
  }
  for (const category of [true, false]) registerTool({
    name: category ? 'update_document_categories' : 'start_document_processing',
    description: category ? '经确认批量调整已有资料的展示分类，空字符串取消分类；不改项目绑定、原文或索引。先query_local_documents取得真实ID。'
      : '经一次整批确认，将明确选择的已有资料后台重建本地正文索引(body-index)，或生成/继续论证图(argument-graph)。仅用户明确要求“先重建索引再重建论证图”才用body-and-argument，复用资料模块串行编排两步，不自动从其它操作升级为全部重建。最多10份。只调用已有模块，不上传新文件、不删资料、不启动资源搜索。确认包含模型、资料发送和替换范围。返回排队回执不代表完成；用query_local_documents/query_agent_jobs查状态。切页或关闭助手不停止，退出应用不承诺继续运行。',
    parameters: { type: 'object', additionalProperties: false, required: ['documentIds', category ? 'category' : 'operation'], properties: {
      documentIds: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
      ...(category ? { category: { type: 'string', maxLength: 80 } } : { operation: { type: 'string', enum: ['body-index', 'argument-graph', 'body-and-argument'] } }),
    } }, location: 'renderer', permission: 'write', requiresConfirmation: true, requiresExplicitApproval: true,
    approvalSnapshot: async args => {
      const state = await snapshot(args, category);
      if (previews.size >= 80) previews.clear();
      previews.set(canonicalAgentValue(args), state);
      // Approval hashes the private config; never put credentials in confirmation/output.
      return { context: state.context, documents: state.documents.map(documentMaintenanceIdentity), configuration: state.configuration };
    },
    confirmation: args => {
      const state = previews.get(canonicalAgentValue(args));
      if (!state) throw new Error('资料维护预览失效，请重新确认');
      return { title: category ? '确认整理资料分类' : '确认后台处理所选资料',
        description: category ? `分类改为“${args.category || '未分类'}”；项目绑定不变。` : args.operation === 'body-index'
          ? '仅本地重新解析、分块和向量化，不调用论证模型；正文变化可能使原论证图标为待更新。'
          : `${args.operation === 'body-and-argument' ? '先本地重建正文索引，再重新生成论证图（不是继续旧批次）；新图全文完成并保存后替换旧图，正文版本变化后旧图可能暂不可检索。' : '生成或继续论证图，不重新解析正文。'}使用${state.modelLabel}分批处理所列资料正文及必要的前文节点；确认即批准本批资料发送及图谱保存，不代表已证实论证。`,
        impacts: [...state.documents.map(doc => `${doc.fileName} · ${doc.id}${category ? ` · ${doc.category || '未分类'} → ${args.category || '未分类'}` : ''}`),
          '不读取无关资料，不调整模型设置，不修改个人认知、画像、掌握度或项目绑定。',
          category ? '仅修改分类；部分失败会返回逐项结果，不把整批当作全部成功。' : '后台启动不等于完成；论证任务可通过cancel_document_job停止后续请求，已保存结果保留。正文索引目前不提供逐任务停止入口。'] };
    },
    execute: async (args, _ctx, execution) => {
      const key = canonicalAgentValue(args), approved = previews.get(key);
      if (!approved) throw new Error('确认范围已失效');
      const current = await snapshot(args, category);
      if (canonicalAgentValue(current) !== canonicalAgentValue(approved)) throw new Error('资料或模型已变化，未执行维护');
      const results: Array<{ documentId: string; status: string; jobId?: string; error?: string }> = [];
      for (const doc of approved.documents) {
        if (execution?.signal?.aborted) { results.push({ documentId: doc.id, status: 'not-started', error: '用户停止后未启动' }); continue; }
        try {
          if (category || args.operation === 'body-index') await deps.maintain({ documentId: doc.id, expectedContext: approved.context,
            expectedIdentity: documentMaintenanceIdentity(doc), operation: category ? 'category' : 'body-index', ...(category ? { category: args.category as string } : {}) });
          else {
            const live = (await deps.list()).find(item => item.id === doc.id);
            if (!live || documentMaintenanceIdentity(live) !== documentMaintenanceIdentity(doc)) throw new Error('资料自确认后变化');
            const job = await deps.start(doc, args.operation === 'body-and-argument' ? 'all' : 'continue', { expectedContext: approved.context, expectedConfiguration: approved.configuration });
            results.push({ documentId: doc.id, status: job.status, jobId: job.id }); continue;
          }
          results.push({ documentId: doc.id, status: category ? 'saved' : 'queued' });
        } catch (error) { results.push({ documentId: doc.id, status: 'failed', error: error instanceof Error ? error.message : '维护失败' }); }
      }
      previews.delete(key);
      const allAccepted = results.every(item => !['failed', 'not-started'].includes(item.status));
      return { results, allAccepted, status: category ? allAccepted ? 'saved' : 'partially_saved' : allAccepted ? 'queued' : 'partially_queued',
        saved: category && allAccepted, completed: category && allAccepted, background: !category,
        notice: category ? '分类逐项结果如上' : '只返回启动回执；请查询真实后台进度，不宣称已经完成。' };
    },
  });
}
