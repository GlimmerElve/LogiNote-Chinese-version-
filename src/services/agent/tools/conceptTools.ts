import type { ConceptSource } from '../../../types';
import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';
import { canonicalAgentValue } from '../approvalBinding';
import { conceptBatchContext, conceptBatchJobs as installedJobs, conceptBatchConfiguration, conceptBatchSummary } from '../../conceptBatchService';
import { conceptBatchActive } from '../../conceptBatchTypes';
import { rendererExitPreparation } from '../../ui/applicationExit';
import type { ConceptBatchConfiguration } from '../../conceptBatchRuntime';

function request(args: Record<string, unknown>, ctx: AgentRuntimeContext) {
  const active = ctx.getActiveNote?.();
  const projectNoteId = args.projectNoteId ?? (active?.noteType === 'project' ? active.id : undefined);
  if (typeof projectNoteId !== 'string' || !projectNoteId) throw new Error('请指定项目笔记，不能从上一轮任务猜测本次范围');
  const source = args.source ?? 'hybrid';
  if (!['rag', 'browser', 'hybrid'].includes(String(source)) || args.localOnly !== undefined && typeof args.localOnly !== 'boolean') throw new Error('证据来源或本机模型要求无效');
  return { projectNoteId, source: source as ConceptSource, allowCloud: args.localOnly !== true,
    ...(args.titles !== undefined ? { titles: args.titles as string[] } : {}) };
}
const properties = {
  projectNoteId: { type: 'string', description: '预览返回的稳定项目笔记 ID；预览时可省略以读取当前焦点项目' },
  source: { type: 'string', enum: ['rag', 'browser', 'hybrid'], description: '本地证据、公开网页或二者结合；默认 hybrid' },
  localOnly: { type: 'boolean', description: '用户要求只用本机模型时必须为 true；本地证据不等于本机模型' },
  titles: { type: 'array', maxItems: 30, items: { type: 'string' }, description: '可选：只处理预览中这些 Wiki 条目，不能增加项目未引用的知识点' },
};
export function registerConceptTools(ports?: { jobs: typeof installedJobs; configuration: () => Promise<ConceptBatchConfiguration> }) {
  const conceptBatchJobs = ports?.jobs || installedJobs;
  const configuration = ports?.configuration || conceptBatchConfiguration;
  const resumePreviews = new Map<string, { fingerprint: string; label: string; remote: boolean; source: string; allowCloud: boolean; changed: boolean }>();
  const previews = new Map<string, Awaited<ReturnType<typeof conceptBatchJobs.preview>>>();
  registerTool({ name: 'preview_wiki_concepts',
    description: '读取项目真实 Wiki 链接，预览可复用、待初始化、待补全、已有正文跳过的知识点。排除教材和代码示例，检查别名歧义；不创建笔记、不检索证据、不调用模型。先用它确定批量概念补全范围。',
    parameters: { type: 'object', additionalProperties: false, properties }, location: 'renderer', permission: 'readonly',
    execute: (args, ctx) => conceptBatchJobs.preview(request(args, ctx), conceptBatchContext(ctx)),
  });
  registerTool({ name: 'start_wiki_concept_batch',
    description: '一次确认后后台逐篇初始化并补全项目关联 Wiki 知识笔记，复用现有概念补全工作流和引用校验，自动写入本批批准的新建或空白笔记。必须先预览，使用稳定项目 ID。卡片同时明确证据联网、远程模型发送与写入范围；用户确认前不创建、不联网、不调用模型。已有正文跳过，编辑冲突暂停该条；关闭助手或换页不停止，不抢页面焦点。不要把所有笔记正文塞进工具参数。',
    parameters: { type: 'object', required: ['projectNoteId'], additionalProperties: false, properties },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const state = await conceptBatchJobs.preview(request(args, ctx), conceptBatchContext(ctx));
      if (state.remoteModel && args.localOnly === true) throw new Error('当前概念补全绑定远程模型，与本机要求不符；请先选择本机模型');
      if (!state.eligible) throw new Error('这些 Wiki 已有正文或没有待补全知识点，未覆盖任何笔记');
      if (state.activeJobs.length) throw new Error('该项目已有运行中的概念任务，请查询并沿用原任务');
      if (state.unfinishedJobs.length) throw new Error('这些知识点已有未完成任务，请查询并请求续办原任务，不另起重复批次');
      if (previews.size > 128) previews.clear();
      previews.set(canonicalAgentValue(args), state);
      return state;
    },
    confirmation: args => {
      const state = previews.get(canonicalAgentValue(args));
      if (!state) throw new Error('批量确认范围尚未准备好，请重新预览');
      const source = state.source === 'rag' ? '仅检索本地资料和笔记' : state.source === 'browser' ? '仅检索公开网页' : '检索本地资料、笔记和公开网页';
      return { title: `初始化并补全《${state.projectTitle}》的 ${state.eligible} 个知识点`,
        description: '确认即授权本次清单逐篇生成、校验并自动保存，无需每篇再点击；不授权其它项目或覆盖已有正文。',
        impacts: [
          ...state.candidates.map(item => `${item.title}：${item.action === 'create-and-fill' ? '新建并补全' : item.action === 'fill' ? '补全空白笔记' : '跳过，不修改'}`),
          `证据范围：${source}。${state.source !== 'rag' ? '术语及别名会用于公开网页搜索，不使用登录 Cookie。' : '不进行网页搜索。'}`,
          `${state.modelLabel}。${state.remoteModel ? '本批术语及所选证据片段将发送给该远程服务商；确认同时授权本次发送。' : '由本机模型处理本批术语及所选证据。'}不额外调用画像、私人认知或学习记录接口。`,
          `首次至多 ${state.eligible} 次逐篇模型生成尝试，远程服务可能计费；失败无自动模型重试。续办需确认，复用已存草稿，单篇累计最多三次生成尝试。`,
          '换页和关闭助手不停止；退出应用会按统一退出流程停止后续请求并保存检查点。',
        ] };
    },
    execute: async (args, ctx, execution) => {
      execution?.signal?.throwIfAborted();
      if (rendererExitPreparation.isStopping()) throw new Error('应用正在退出，不再启动概念任务');
      return { ...conceptBatchSummary(await conceptBatchJobs.start(request(args, ctx), conceptBatchContext(ctx))),
        saved: false, background: true, message: '后台任务已登记，不代表知识点已全部生成或写入；请查询逐篇进度。' };
    },
  });
  registerTool({ name: 'query_wiki_concept_jobs', description: '查询当前资料库的 Wiki 概念批处理进度、逐篇结果和可恢复草稿标志。只读元数据，不返回草稿正文、不调用模型。projectNoteId 可限定原项目，jobId 可查原任务；不根据当前页面迁移任务。',
    parameters: { type: 'object', additionalProperties: false, properties: { projectNoteId: { type: 'string' }, jobId: { type: 'string' } } },
    location: 'renderer', permission: 'readonly', execute: async args => {
      await conceptBatchJobs.ensureReady();
      const jobs = conceptBatchJobs.getSnapshot().filter(job => (!args.projectNoteId || job.projectNoteId === args.projectNoteId) && (!args.jobId || job.id === args.jobId));
      if (args.jobId && !jobs.length) throw new Error('该概念任务不存在于当前资料库');
      return { jobs: jobs.map(conceptBatchSummary), saved: jobs.length > 0 && jobs.every(job => job.status === 'completed'),
        ...(conceptBatchJobs.getPersistenceError() ? { error: conceptBatchJobs.getPersistenceError() } : {}) };
    } });
  registerTool({ name: 'control_wiki_concept_job', description: '经确认停止或续办原 Wiki 概念任务。stop 保留初始化笔记、草稿和完成内容；resume 只处理原范围未完成项，已存草稿直接恢复保存，不重复生成成功项。模型配置变化须在新确认卡中明确当前模型与发送范围，资料库变化拒绝。不能借续办覆盖用户编辑、清空尝试次数或扩大清单。',
    parameters: { type: 'object', required: ['jobId', 'action'], additionalProperties: false,
      properties: { jobId: { type: 'string' }, action: { type: 'string', enum: ['stop', 'resume'] }, localOnly: { type: 'boolean', description: '用户要求仅本机模型时必须为 true' } } },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async args => {
      await conceptBatchJobs.ensureReady();
      const job = conceptBatchJobs.getSnapshot().find(item => item.id === args.jobId);
      if (!job || !['stop', 'resume'].includes(String(args.action))) throw new Error('请选择真实概念任务及停止/续办操作');
      if (args.action === 'stop') {
        if (!conceptBatchActive(job)) throw new Error('任务已停止，无需重复停止');
        return { jobId: job.id, scopeId: job.scopeId, active: true };
      }
      if (conceptBatchActive(job) || ['completed', 'archived'].includes(job.status)) throw new Error('此任务无需或不能续办，请重新查询');
      const config = await configuration();
      if (job.scopeId !== conceptBatchJobs.getScopeId()) throw new Error('原资料库已变化，不能将旧任务续办到新库');
      if (args.localOnly !== undefined && typeof args.localOnly !== 'boolean') throw new Error('本机模型要求无效');
      if (args.localOnly === true && !config.local) throw new Error('当前模型不满足本机要求，请先选择本机模型');
      if (resumePreviews.size > 128) resumePreviews.clear();
      resumePreviews.set(canonicalAgentValue(args), { fingerprint: config.fingerprint, label: config.label, remote: !config.local,
        source: job.source, allowCloud: args.localOnly !== true, changed: config.fingerprint !== job.modelFingerprint });
      return { job, modelFingerprint: config.fingerprint, allowCloud: args.localOnly !== true };
    },
    confirmation: args => {
      const preview = resumePreviews.get(canonicalAgentValue(args));
      return { title: args.action === 'stop' ? '停止概念批处理（保留成果）' : '续办概念批处理',
        description: `仅处理原任务 ${args.jobId}。${args.action === 'stop' ? '已发出请求可能仍有用量；保存检查点，不删除笔记。' : '沿用原证据来源和清单，继续未完成项；未保存的生成可能重新消耗用量，累计尝试次数不重置。'}`,
        ...(args.action === 'resume' && preview ? { impacts: [
          `${preview.changed ? '本次确认将采用当前配置：' : '沿用已核对配置：'}${preview.label}。`,
          `原证据来源：${preview.source === 'rag' ? '本地资料和笔记' : preview.source === 'browser' ? '公开网页' : '本地证据与公开网页'}；不扩大知识点清单。`,
          preview.remote ? '确认同时授权将未完成项的术语及所选证据片段发送给当前远程服务商。' : '仅由已核对的本机模型处理。',
          '已存草稿直接恢复保存；已完成项不重做，用户编辑的冲突内容不自动覆盖。',
        ] } : {}) };
    },
    execute: async (args, ctx) => {
      if (args.action === 'stop') { await conceptBatchJobs.stop(String(args.jobId)); return { jobId: args.jobId, status: 'stopping', resultsRetained: true }; }
      if (rendererExitPreparation.isStopping()) throw new Error('应用正在退出，不再续办任务');
      const preview = resumePreviews.get(canonicalAgentValue(args));
      if (!preview) throw new Error('续办配置尚未确认，请重新查询原任务');
      return { ...conceptBatchSummary(await conceptBatchJobs.resume(String(args.jobId), conceptBatchContext(ctx),
        { fingerprint: preview.fingerprint, allowCloud: preview.allowCloud })), saved: false, background: true };
    } });
}
