import { getLeafProjectNotesInScope } from '../../knowledgePointSelector';
import { extractWikiTargets } from '../../planAdjustmentService';
import {
  buildResourceDraftMutation,
  extractProjectTasks,
  sanitizeResourceDraftForAgent,
} from '../resourceDraftService';
import {
  checkResourceHealth,
  deriveResourcePreferenceSignals,
  getResourceStateSnapshot,
  makeResourceFeedbackKey,
  normalizeResourceUrl,
  storeResourceHealth,
} from '../../resourceState';
import type { AgentLearningResourceInput, AgentProjectResourceDraftItem } from '../types';
import { registerTool } from '../toolRegistry';
import { publicResourceDownloadPlan } from '../resourceDownloadClient';

function parseKnowledgeTitles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error('knowledgeTitles 必须包含 1 至 10 个知识点标题');
  }
  return value.map((title) => String(title || '').trim());
}

function parseResource(raw: unknown): AgentLearningResourceInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('资源格式无效');
  const value = raw as Record<string, unknown>;
  const level = value.level ? String(value.level) as AgentLearningResourceInput['level'] : undefined;
  const kind = value.kind ? String(value.kind) as AgentLearningResourceInput['kind'] : undefined;
  return {
    title: String(value.title || '').trim(),
    url: String(value.url || '').trim(),
    platform: value.platform ? String(value.platform).trim() : undefined,
    kind,
    taskText: String(value.taskText || '').trim(),
    knowledgeTitles: parseKnowledgeTitles(value.knowledgeTitles),
    reason: String(value.reason || '').trim(),
    level,
    language: value.language ? String(value.language).trim() : undefined,
    isFree: value.isFree === true,
  };
}

function parseProjects(value: unknown): AgentProjectResourceDraftItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error('projects 必须包含 1 至 5 个末级项目');
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('项目资源格式无效');
    const item = raw as Record<string, unknown>;
    if (item.resources !== undefined && !Array.isArray(item.resources)) throw new Error('resources 必须是数组');
    if (item.removeResourceUrls !== undefined && !Array.isArray(item.removeResourceUrls)) throw new Error('removeResourceUrls 必须是数组');
    return {
      projectTitle: String(item.projectTitle || '').trim(),
      resources: (item.resources as unknown[] | undefined || []).map(parseResource),
      removeResourceUrls: (item.removeResourceUrls as unknown[] | undefined)?.map((url) => String(url || '').trim()),
    };
  });
}

function parseHealthUrls(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new Error('urls 必须包含 1 至 12 个在线资源地址');
  }
  return [...new Set(value.map((item) => normalizeResourceUrl(String(item || ''))))];
}

const resourceSchema = {
  type: 'object',
  required: ['title', 'url', 'taskText', 'knowledgeTitles', 'reason', 'isFree'],
  properties: {
    title: { type: 'string' },
    url: { type: 'string', description: '必须来自 search_online_learning_resources 返回结果，不能自行编造' },
    platform: { type: 'string' },
    kind: { type: 'string', enum: ['online', 'local'] },
    taskText: { type: 'string', description: '项目正文中已存在的完整任务文本' },
    knowledgeTitles: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
    reason: { type: 'string', description: '300 字以内，说明与当前任务和学习者的匹配原因' },
    level: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
    language: { type: 'string' },
    isFree: { type: 'boolean', description: '在线资源必须为 true' },
  },
  additionalProperties: false,
};

export function registerResourceTools(): void {
  registerTool({
    name: 'prepare_project_resource_downloads',
    description: '检查指定项目已收录的 URL，识别可直接下载的 PDF/PPT/DOCX 等附件并预览文件清单、大小及跳过原因。不下载、不写笔记；不能传入未收录 URL。',
    parameters: { type: 'object', additionalProperties: false, properties: { projectTitle: { type: 'string' },
      urls: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' }, description: '可选，仅检查项目已收录 URL 的子集；失败重试时只选失败项' } } },
    location: 'renderer', permission: 'navigation',
    execute: async (args, ctx) => {
      if (!ctx.resourceDownloads) throw new Error('当前环境不支持资源批量下载');
      if (args.urls !== undefined && (!Array.isArray(args.urls) || args.urls.some(u => typeof u !== 'string'))) throw new Error('urls 必须是 URL 数组');
      const plan = await ctx.resourceDownloads.prepare({ projectTitle: args.projectTitle ? String(args.projectTitle) : undefined,
        urls: args.urls as string[] | undefined });
      return publicResourceDownloadPlan(plan);
    },
  });
  registerTool({
    name: 'download_project_resources',
    description: '独立批量下载已有资源：用户确认 prepare_project_resource_downloads 返回的具体文件清单后下载、入本地资料库并绑定原项目。自动资源统筹已默认下载本轮公开附件，不要为其额外调用本工具或询问下载许可。失败保留 URL；支持绑定失败后的无重复下载重试。',
    parameters: { type: 'object', required: ['planId'], additionalProperties: false, properties: { planId: { type: 'string' } } },
    location: 'renderer', permission: 'write', requiresExplicitApproval: true,
    approvalSnapshot: (args, ctx) => ctx.resourceDownloads?.getPlan(String(args.planId || '')),
    confirmation: (args, ctx) => {
      const plan = ctx?.resourceDownloads?.getPlan(String(args.planId || ''));
      if (!plan || !plan.files.length) throw new Error('请先准备有可下载文件的完整预览');
      const knownBytes = plan.files.reduce((sum, f) => sum + (f.size || 0), 0), unknown = plan.files.filter(f => !f.size).length;
      return { title: '确认批量下载到本地资料库', description: `项目“${plan.projectTitle}”：${plan.files.length} 个文件；已知大小 ${(knownBytes / 1024 / 1024).toFixed(1)} MB${unknown ? `，另有 ${unknown} 个大小未知` : ''}。`,
        impacts: [...plan.files.map(f => `${f.title} → ${f.fileName} · ${f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '大小未知'} · ${f.url}`),
          '每批最多 8 个，单文件最多 100 MB；已在资料库的同来源文件优先复用。',
          '成功项以本地资料绑定替换原链接并保留来源；失败项原链接保留，不自动登录、破解验证或下载付费内容。',
          '解析与索引在后台进行，不代表文件下载后立即完成；已有教材正文不会重写。'] };
    },
    execute: (args, ctx, execution) => {
      if (!ctx.resourceDownloads) throw new Error('当前环境不支持资源批量下载');
      return ctx.resourceDownloads.execute(String(args.planId || ''), execution);
    },
  });
  registerTool({
    name: 'start_project_resource_draft',
    description: '开始学习资源统筹草案并锁定一个项目或子树范围。省略 scopeProjectTitle 时使用界面当前选中的项目。',
    parameters: {
      type: 'object',
      properties: { scopeProjectTitle: { type: 'string' } },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => ctx.startResourceDraftSession({
      scopeProjectTitle: args.scopeProjectTitle ? String(args.scopeProjectTitle).trim() : undefined,
    }),
  });

  registerTool({
    name: 'query_resource_feedback',
    description: '读取当前资源草案范围内用户明确给出的使用反馈、搜索候选选择及最近链接复核状态。不会把打开次数、停留或普通点击当偏好。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'readonly',
    execute: (_args, ctx) => {
      const session = ctx.getResourceDraftSession();
      if (!session) throw new Error('请先开始一个资源草案会话');
      const state = getResourceStateSnapshot();
      const projects = getLeafProjectNotesInScope(session.scopeProjectId, ctx.getNotes());
      const currentFeedbackKeys = new Set<string>();
      const rows = projects.flatMap((project) => (project.resources || []).map((resource) => {
        const feedbackKey = makeResourceFeedbackKey(project.id, resource);
        currentFeedbackKeys.add(feedbackKey);
        return {
          projectTitle: project.title,
          title: resource.title,
          url: resource.url,
          platform: resource.platform,
          level: resource.level,
          language: resource.language,
          taskText: resource.taskText,
          feedback: state.feedback[feedbackKey]?.rating || null,
          health: state.health[normalizeResourceUrl(resource.url)] || null,
          historical: false,
        };
      }));
      const projectById = new Map(projects.map((project) => [project.id, project]));
      Object.values(state.feedback).forEach((feedback) => {
        const project = projectById.get(feedback.noteId);
        if (!project || currentFeedbackKeys.has(feedback.key)) return;
        rows.push({
          projectTitle: project.title,
          title: '已移除资源（历史反馈）',
          url: feedback.url,
          platform: undefined,
          level: undefined,
          language: undefined,
          taskText: feedback.taskText,
          feedback: feedback.rating,
          health: state.health[normalizeResourceUrl(feedback.url)] || null,
          historical: true,
        });
      });
      const scopedProjectIds = new Set([session.scopeProjectId, ...projects.map((project) => project.id)]);
      const discoveryPreferences = Object.values(state.discoveryPreferences)
        .filter((preference) => scopedProjectIds.has(preference.noteId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100);
      const scopedFeedback = Object.values(state.feedback)
        .filter((feedback) => scopedProjectIds.has(feedback.noteId));
      return {
        scopeProjectTitle: session.scopeProjectTitle,
        summary: {
          helpful: rows.filter((row) => row.feedback === 'helpful').length,
          notHelpful: rows.filter((row) => row.feedback === 'not-helpful').length,
          completed: rows.filter((row) => row.feedback === 'completed').length,
          broken: rows.filter((row) => row.health?.status === 'broken').length,
          restricted: rows.filter((row) => row.health?.status === 'restricted').length,
          selectedCandidates: discoveryPreferences.filter((item) => item.decision === 'selected').length,
          rejectedCandidates: discoveryPreferences.filter((item) => item.decision === 'rejected').length,
        },
        resources: rows.filter((row) => row.feedback || row.health),
        discoveryPreferences,
        inferredPreferences: deriveResourcePreferenceSignals(discoveryPreferences, scopedFeedback),
      };
    },
  });

  registerTool({
    name: 'check_project_resource_health',
    description: '复核当前资源草案范围内已有或本次搜索发现的在线 URL，并保存最新可用性状态。一次最多检查 12 个；不能检查范围外 URL。',
    parameters: {
      type: 'object', required: ['urls'], additionalProperties: false,
      properties: {
        urls: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } },
      },
    },
    location: 'renderer',
    permission: 'navigation',
    execute: async (args, ctx) => {
      const session = ctx.getResourceDraftSession();
      if (!session) throw new Error('请先开始一个资源草案会话');
      const existing = getLeafProjectNotesInScope(session.scopeProjectId, ctx.getNotes())
        .flatMap((project) => project.resources || []);
      const allowed = new Set([...existing, ...session.discoveredResources]
        .filter((resource) => resource.kind !== 'local' && /^https?:\/\//iu.test(resource.url))
        .map((resource) => normalizeResourceUrl(resource.url)));
      const urls = parseHealthUrls(args.urls);
      const outside = urls.find((url) => !allowed.has(url));
      if (outside) throw new Error(`不能复核当前资源草案范围外的 URL：${outside}`);

      const results = [];
      for (let index = 0; index < urls.length; index += 3) {
        const batch = await Promise.all(urls.slice(index, index + 3).map(checkResourceHealth));
        for (const result of batch) {
          await storeResourceHealth(result);
          results.push(result);
        }
      }
      return {
        checked: results.length,
        available: results.filter((item) => item.status === 'available' || item.status === 'redirected').length,
        restricted: results.filter((item) => item.status === 'restricted').length,
        broken: results.filter((item) => item.status === 'broken').length,
        temporaryError: results.filter((item) => item.status === 'temporary-error').length,
        results,
      };
    },
  });

  registerTool({
    name: 'query_project_resource_context',
    description: '分批查看资源草案范围内的末级项目、正文学习任务、任务知识点和已有资源。搜索资源前必须调用。',
    parameters: {
      type: 'object',
      properties: { offset: { type: 'number', description: '从第几个末级项目开始，默认 0' } },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const session = ctx.getResourceDraftSession();
      if (!session) throw new Error('请先开始一个资源草案会话');
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数');
      const notes = ctx.getNotes();
      const leaves = getLeafProjectNotesInScope(session.scopeProjectId, notes);
      const batch = leaves.slice(offset, offset + 5);
      return {
        scopeProjectTitle: session.scopeProjectTitle,
        totalLeafProjects: leaves.length,
        offset,
        nextOffset: offset + batch.length < leaves.length ? offset + batch.length : null,
        leafProjects: batch.map((project) => ({
          title: project.title,
          tasks: extractProjectTasks(project.content, project.textbook).map((taskText) => ({
            taskText,
            knowledgeTitles: extractWikiTargets(taskText, notes),
          })),
          existingResources: project.resources || [],
        })),
      };
    },
  });

  registerTool({
    name: 'search_online_learning_resources',
    bindsDraft: 'resource',
    description: '为一条真实学习任务搜索资源。自动模式先由资源Agent语义理解目标与偏好、自主制定检索策略，审核真实搜索候选后按比例收录，并执行公开附件下载入库与项目绑定；无合格文件或下载失败时保留可用在线链接。不使用固定关键词拼接，不编造URL，无需二次确认。手动模式打开内置浏览器四标签工作台，用户确认后直接写回。已写入时不得重复提交或下载。',
    parameters: {
      type: 'object',
      required: ['projectTitle', 'taskText', 'knowledgeTitles'],
      properties: {
        projectTitle: { type: 'string' },
        taskText: { type: 'string' },
        knowledgeTitles: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'write',
    requiresConfirmation: true,
    isPreauthorized: (_args, ctx) => ctx.getResourceCollectionMode?.() === 'auto',
    confirmation: (args) => ({
      title: '打开资源统筹工作台',
      description: `将在专用工作台中围绕项目“${String(args.projectTitle || '').trim()}”及其知识点搜索“${String(args.taskText || '').trim()}”。本草案已有工作台时会在同一窗口继续。`,
      impacts: [
        '首次打开当前标签时发起一条短查询；其他标签和备用词只在点击后搜索',
        '普通搜索会话不持久化 Cookie',
        '左侧负责浏览与导航，右侧集中显示候选、偏好事实和可下载资源',
        '点击“确认并写回”即为最终收录授权，无需再次提交草案',
        '确认前只生成候选；确认后已选 URL 或下载资料会写入对应项目资源栏',
      ],
    }),
    execute: (args, ctx, execution) => ctx.searchOnlineLearningResources({
      projectTitle: String(args.projectTitle || '').trim(),
      taskText: String(args.taskText || '').trim(),
      knowledgeTitles: parseKnowledgeTitles(args.knowledgeTitles),
    }, execution),
  });

  registerTool({
    name: 'query_project_resource_draft',
    description: '查看当前资源草案的锁定范围、搜索发现数及已暂存的完整资源清单。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'readonly',
    execute: (_args, ctx) => {
      const session = ctx.getResourceDraftSession();
      return session ? { active: true, ...sanitizeResourceDraftForAgent(session) } : { active: false };
    },
  });

  registerTool({
    name: 'stage_project_resource_batch',
    description: '将 1 至 5 个末级项目的资源变更暂存进草案，不立即写入。resources 表示新增或更新；removeResourceUrls 只能引用该项目已有 URL；两者同时填写表示用新资源替换旧资源。',
    parameters: {
      type: 'object',
      required: ['projects'],
      properties: {
        projects: {
          type: 'array', minItems: 1, maxItems: 5,
          items: {
            type: 'object', required: ['projectTitle'],
            properties: {
              projectTitle: { type: 'string' },
              resources: { type: 'array', maxItems: 15, items: resourceSchema },
              removeResourceUrls: {
                type: 'array', maxItems: 15, items: { type: 'string' },
                description: '需要移除的该项目现有资源 URL；不得填写其他项目或不存在的 URL',
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => ctx.stageResourceDraftBatch(parseProjects(args.projects)),
  });

  registerTool({
    name: 'discard_project_resource_draft',
    description: '放弃当前尚未写入笔记的学习资源草案。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'navigation',
    execute: (_args, ctx) => ctx.discardResourceDraftSession(),
  });

  registerTool({
    name: 'commit_project_resource_draft',
    bindsDraft: 'resource',
    description: '一次性提交完整学习资源草案；会再次验证范围、版本、任务、知识点和搜索来源。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'write',
    confirmation: (_args, ctx) => {
      const session = ctx?.getResourceDraftSession();
      if (!session) throw new Error('当前没有可提交的资源草案');
      if (!ctx) throw new Error('缺少 Agent 运行上下文');
      const summary = buildResourceDraftMutation(ctx.getNotes(), session).summary;
      return {
        title: '提交学习资源统筹草案',
        description: `范围已锁定为“${session.scopeProjectTitle}”，将修改 ${summary.projectCount} 个末级项目。`,
        impacts: [
          `涉及项目：${session.projects.map((project) => project.projectTitle).join('、') || '尚无项目'}`,
          `新增 ${summary.addedResourceCount} 个、更新 ${summary.updatedResourceCount} 个、移除 ${summary.removedResourceCount} 个资源。`,
          '只有草案中明确列出的现有 URL 会被移除；未列出的已有资源保持不变。',
          '范围外项目、项目正文和知识点笔记不会修改。',
        ],
      };
    },
    execute: (_args, ctx) => ctx.commitResourceDraftSession(),
  });
}
