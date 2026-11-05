import { registerTool } from '../toolRegistry';
import { backgroundWorkflows, backgroundWorkflowSummary } from '../backgroundWorkflowService';
import { BACKGROUND_STEPS, backgroundWorkflowActive } from '../backgroundWorkflowTypes';
import { todayLearningProjects } from '../homeLearningState';
import { buildLearningCapacity, cachedCapacitySettings, learningCapacitySummary, weekStartDate } from '../../learningCapacity';
import { textbookHash } from '../../textbook/fingerprint';
import type { BackgroundWorkflowRequest } from '../backgroundWorkflowRuntime';
const id = (args: Record<string, unknown>) => { if (typeof args.jobId !== 'string' || !args.jobId) throw new Error('请使用真实组合任务 jobId'); return args.jobId; };
const jobSchema = { type: 'object', required: ['jobId'], additionalProperties: false, properties: { jobId: { type: 'string' } } };
export function registerBackgroundWorkflowTools() {
  registerTool({ name: 'query_home_learning_state', description: '读取与首页相同的今日可执行未完成叶子项目，遵守开始日期、活跃计划、复发及真实完成状态，包含任务/Wiki/教材/父级继承本地资料前置状态。不是仅按截止日期等于今天，不受旧任务查询五十条截断。分页带snapshot保证同一列表。不生成、不导航、不写入。',
    parameters: { type: 'object', additionalProperties: false, properties: { date: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, snapshot: { type: 'string' } } },
    location: 'renderer', permission: 'readonly', execute: async (args, ctx) => {
      await ctx.ensureDataFresh(); const value = todayLearningProjects(ctx.getPlanNotes?.() || ctx.getNotes(), typeof args.date === 'string' ? args.date : undefined);
      const snapshot = await textbookHash(value), offset = args.offset ?? 0, limit = args.limit ?? 20;
      if (!Number.isInteger(offset) || (offset as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('分页范围无效');
      if (args.snapshot !== undefined && args.snapshot !== snapshot) throw new Error('首页任务列表已变化，请从第一页重新读取');
      const end = (offset as number) + (limit as number);
      return { ...value, projects: value.projects.slice(offset as number, end), snapshot, ...(end < value.total ? { nextOffset: end } : {}),
        learningCapacity: learningCapacitySummary(buildLearningCapacity(ctx.getPlanNotes?.() || ctx.getNotes(), weekStartDate(value.today), ctx.getLearningCapacitySettings?.() || cachedCapacitySettings(), value.today)),
        resourcePolicy: '仅当前/父项目绑定本地资料及任务关联已补全知识点；无资料时报告缺口，不搜索全库、不联网或启动资源统筹。' };
    } });
  registerTool({ name: 'prepare_background_workflow', description: '按用户目标组合已安装学习工作流：study-tasks（现有学习任务生成）、wiki-concepts（初始化并补全关联知识点）、textbook（教材）。先查询首页或明确稳定项目ID；教材自动纳入前置任务/知识点审核，已有合格结果跳过。返回待确认计划及模型范围，不调用生成模型、不写笔记、不启动资源统筹。不是关键词触发的固定今日流程或任意工具脚本。每批至多20个叶子项目。',
    parameters: { type: 'object', additionalProperties: false, required: ['projectNoteIds', 'steps'], properties: {
      projectNoteIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } }, steps: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: [...BACKGROUND_STEPS] } },
      title: { type: 'string', maxLength: 160 }, localModelOnly: { type: 'boolean', description: '只许可本机模型时true；本地证据不等于本机模型' } } },
    location: 'renderer', permission: 'navigation', execute: async (args, ctx) => {
      const job = await backgroundWorkflows.prepare(args as unknown as BackgroundWorkflowRequest, ctx);
      return { ...backgroundWorkflowSummary(job), status: 'prepared_requires_approval', saved: false, background: false, models: job.modelLabels, remoteModel: job.allowCloud,
        message: '尚未执行。调用 start_background_workflow 出示一次覆盖整批步骤、项目/证据/模型及后续自动写入的确认卡；不能声称后台已启动。' };
    } });
  registerTool({ name: 'start_background_workflow', description: '一次明确确认整个组合任务后后台执行：锁定项目、步骤、来源和模型，范围内后续自动保存，不再逐项确认，可随时停止。切页或关闭助手继续；重启暂停需用原jobId重新确认续办。本授权不适用于其它项目、资源统筹、删除、评分、人格或外观。启动不是生成保存完成。',
    parameters: jobSchema, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: (args, ctx) => backgroundWorkflows.approval(id(args), ctx),
    confirmation: args => {
      const job = backgroundWorkflows.getPlan(id(args)); if (!job) throw new Error('请重新准备组合任务');
      return { title: `一次确认，后台执行：${job.title}`, description: `仅以下 ${job.projects.length} 个叶子项目；按依赖审核、生成和自动保存。可随时停止，已保存成果保留。`,
        impacts: [...job.projects.map(project => `《${project.title}》(${project.id})：${project.steps.map(step => `${step.kind}${step.status === 'skipped' ? '（已有，跳过）' : ''}`).join(' → ')}；本地资料 ${project.documentIds.join('、') || '无，仅使用已补全关联知识点'}`),
          ...job.modelLabels, job.allowCloud ? '确认即授权以上远程模型接收限定项目任务/资料/知识点，以及教材所需可信画像、相关个人认知与最近学习记录；拒绝可取消并要求仅本机模型。' : '仅使用本机模型。',
          '每项目只补缺少的任务及真实任务Wiki关联、至多30个无正文知识点；教材通过原质量/引用/隐私门控后保存，不覆盖用户正文。',
          '不搜索未绑定资料、不联网找资源、不启动资源统筹、不删除笔记、不改评分或认知库。',
          '停止会阻止后续步骤，保留已保存成果；已发出的模型请求可能仍产生用量，已进入保存的操作不会回滚。',
          '任务生成每项目至多两次显式尝试；概念/教材保留各自预算。模型、资料或项目变化停止后续步骤。'] };
    }, execute: async (args, ctx) => ({ ...backgroundWorkflowSummary(await backgroundWorkflows.start(id(args), ctx)), saved: false, status: 'background_started',
      message: '后台已登记，尚未全部保存；请查询逐步状态，不重复启动或把启动当作完成。' }) });
  registerTool({ name: 'query_background_workflows', description: '查询组合流程逐步前置审核/保存状态、关联子任务ID和草稿是否保留。仅元数据，不读私人草稿正文，不调用模型。',
    parameters: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' }, includeArchived: { type: 'boolean' } } }, location: 'renderer', permission: 'readonly',
    execute: async args => { await backgroundWorkflows.ensureReady(); const jobs = backgroundWorkflows.getSnapshot().filter(job => (args.jobId ? job.id === args.jobId : !job.archivedAt || args.includeArchived === true));
      if (args.jobId && !jobs.length) throw new Error('组合任务不存在');
      return { jobs: jobs.map(backgroundWorkflowSummary), persistenceError: backgroundWorkflows.getPersistenceError(), saved: !!args.jobId && jobs[0]?.status === 'completed' }; } });
  registerTool({ name: 'stop_background_workflow', description: '按真实jobId立即请求停止组合任务后续步骤及所属生成请求，无需再次确认；已发请求可能仍产生用量。不删除已保存结果，不回滚已进入保存的操作，不影响无关任务。',
    parameters: jobSchema, location: 'renderer', permission: 'navigation', execute: async args => {
      await backgroundWorkflows.ensureReady(); const target = backgroundWorkflows.getSnapshot().find(job => job.id === id(args));
      if (!target || !backgroundWorkflowActive(target)) throw new Error('组合任务已停止或不存在');
      await backgroundWorkflows.stop(target.id); return { jobId: target.id, status: 'stopping', savedResultsRetained: true }; } });
  registerTool({ name: 'archive_background_workflow', description: '确认后归档或恢复原组合任务，仅隐藏/恢复其私有记录，不删除草稿、笔记或子任务，不调用模型、不重置预算。运行中先停止；恢复不自动执行，续办仍须重新确认原范围。',
    parameters: { type: 'object', required: ['jobId', 'archived'], additionalProperties: false, properties: { jobId: { type: 'string' }, archived: { type: 'boolean' } } },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async args => { await backgroundWorkflows.ensureReady(); const job = backgroundWorkflows.getPlan(id(args)); if (!job) throw new Error('组合任务不存在'); return job; },
    confirmation: args => ({ title: args.archived === true ? '归档组合任务（可恢复）' : '恢复原组合任务', description: '保留草稿、原子任务和全部已保存笔记；不调用模型，不自动续办，不重置任何预算。' }),
    execute: async args => { if (typeof args.archived !== 'boolean') throw new Error('请明确归档还是恢复'); return backgroundWorkflowSummary(await backgroundWorkflows.archive(id(args), args.archived)); } });
}
