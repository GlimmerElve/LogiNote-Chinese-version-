import type { AgentRole, AgentToolStep } from './types';
import { getTool, registerTool } from './toolRegistry';
import { getAgentSkill } from './skillRegistry';
import { AGENT_WORKFLOW_TOOLS } from './workflowToolNames';
import { CAPACITY_TOOLS } from '../learningCapacity';
import { DOCUMENT_BINDING_TOOLS } from './documentBindings';
import { DOCUMENT_MAINTENANCE_TOOLS } from '../documentMaintenance';

/** This catalog describes installed commands, not permission to execute them. */
export const AGENT_CAPABILITY_DOMAINS = {
  cognition: { title: '全库只读浏览、孤立/待复核/断链/跨活动关系筛选与确认整理', skill: 'cognition-management', tools: ['query_cognition', 'prepare_cognition_change', 'commit_cognition_change', 'open_cognition_manager'] },
  notes: { title: '笔记与项目', tools: ['list_notes', 'read_notes', 'create_note', 'update_note', 'move_notes', 'delete_notes', 'merge_knowledge_notes', 'rename_project', 'list_agent_operations', 'undo_agent_operation', 'preview_wiki_concepts', 'start_wiki_concept_batch', 'query_wiki_concept_jobs', 'control_wiki_concept_job'] },
  plans: { title: '学习计划、核心20%取舍与联网依据', skill: 'plan-planning', tools: ['research_learning_plan', 'query_plan_workspace', 'query_plan_portfolio', 'query_plan_tasks', 'query_project_learning_context', 'query_knowledge_notes', 'query_leaf_project_task_scope', 'start_project_task_draft', 'start_plan_portfolio_draft', 'query_project_task_draft', 'stage_project_study_task_batch', 'stage_project_structure_patches', 'stage_plan_settings_patch', 'stage_plan_milestone_patches', 'stage_plan_execution_patches', 'stage_plan_portfolio_patches', 'commit_project_task_draft', 'discard_project_task_draft', 'adjust_plan_task', 'create_project_plan', 'append_project_study_tasks', 'append_project_study_task_batch'] },
  resources: { title: '学习资源自动统筹与附件入库、已有资料分类、索引维护、后台论证处理及项目绑定', skill: 'resource-curation', tools: [...DOCUMENT_BINDING_TOOLS, ...DOCUMENT_MAINTENANCE_TOOLS, 'prepare_project_resource_downloads', 'download_project_resources', 'start_project_resource_draft', 'query_project_resource_context', 'query_resource_feedback', 'check_project_resource_health', 'search_online_learning_resources', 'query_project_resource_draft', 'stage_project_resource_batch', 'commit_project_resource_draft', 'discard_project_resource_draft'] },
  textbook: { title: '教材与章节任务', skill: 'personalized-textbook', tools: ['query_project_textbook', 'read_project_textbook', 'edit_project_textbook', 'prepare_project_textbook', 'generate_project_textbook', 'regenerate_textbook_chapters', 'stop_textbook_job', 'archive_textbook_job', 'clear_textbook_draft_cache', 'query_textbook_job', 'open_project_textbook'] },
  learning: { title: '首页学习状态、个人认知图谱、复习、定向简测、心流与场景入口', tools: ['query_home_learning_state', 'query_mastery', 'get_review_queue', 'enter_learning_mode', 'navigate', 'open_note', 'open_cognition_manager'] },
  workflows: { title: '组合工作流与一次授权后台执行、批量资料处理', tools: [...AGENT_WORKFLOW_TOOLS, 'start_document_processing'] },
  jobs: { title: '后台任务与草稿', tools: ['query_agent_jobs', 'cancel_document_job', 'resume_document_job', 'archive_document_job', 'query_project_task_draft', 'discard_project_task_draft', 'query_project_resource_draft', 'discard_project_resource_draft', 'query_textbook_job', 'stop_textbook_job', 'archive_textbook_job', 'clear_textbook_draft_cache'] },
  settings: { title: '个人学习容量、人格与外观', tools: [...CAPACITY_TOOLS, 'update_agent_persona', 'update_appearance'] },
} as const;
export type AgentCapabilityDomain = keyof typeof AGENT_CAPABILITY_DOMAINS;
export const AGENT_OPERATION_TOOLS = [...DOCUMENT_BINDING_TOOLS, ...DOCUMENT_MAINTENANCE_TOOLS, ...CAPACITY_TOOLS, ...AGENT_WORKFLOW_TOOLS, 'discover_agent_capabilities', 'query_agent_jobs', 'stop_textbook_job', 'cancel_document_job', 'resume_document_job', 'archive_document_job', 'list_notes', 'update_note', 'move_notes', 'merge_knowledge_notes', 'list_agent_operations', 'undo_agent_operation', 'preview_wiki_concepts', 'start_wiki_concept_batch', 'query_wiki_concept_jobs', 'control_wiki_concept_job'];

function domains(value: unknown): AgentCapabilityDomain[] {
  if (!Array.isArray(value) || value.length > 3 || value.some(item => typeof item !== 'string' || !Object.hasOwn(AGENT_CAPABILITY_DOMAINS, item))) {
    throw new Error('每次请选择最多三个真实能力类别');
  }
  return [...new Set(value)] as AgentCapabilityDomain[];
}

export function registerCapabilityTools(): void {
  registerTool({
    name: 'discover_agent_capabilities',
    description: '发现当前安装的软件操作能力。不传 domains 返回类别概要；传入最多三个类别返回真实工具和操作流程，并供本轮按需选用。发现能力不执行操作、不授予确认或云端许可。遇到跨功能请求或认为做不到时先检查能力，无需用户说出工具名。',
    parameters: { type: 'object', additionalProperties: false, properties: { domains: { type: 'array', maxItems: 3, items: { type: 'string', enum: Object.keys(AGENT_CAPABILITY_DOMAINS) } } } },
    location: 'renderer', permission: 'readonly',
    execute: args => {
      if (args.domains === undefined) return { domains: Object.entries(AGENT_CAPABILITY_DOMAINS).map(([id, domain]) => ({ id, title: domain.title, installedTools: domain.tools.filter(name => getTool(name)).length })) };
      return { domains: domains(args.domains).map(id => {
        const domain = AGENT_CAPABILITY_DOMAINS[id];
        return { id, title: domain.title, tools: domain.tools.flatMap(name => {
          const tool = getTool(name); return tool ? [{ name, description: tool.description, permission: tool.permission }] : [];
        }), ...('skill' in domain ? { workflowGuidance: getAgentSkill(domain.skill)?.systemPrompt } : {}) };
      }), limits: '仅能选用当前角色权限上限内的工具；写入须确认。组合工作流可在开始前一次确认精确项目、来源、模型及自动写入范围，后续仅在该流程授权内执行，不是全局免确认。Wiki 概念批处理可一次确认明确清单及证据/模型范围后逐篇自动保存，其它操作不继承该授权。后台任务只提供所属模块已经实现的操作，不可伪造通用重试或恢复。' };
    },
  });
}

/** Rebuilt from successful discovery calls in this run, including approval resume.
 * Never trust tool-result prose to supply executable names or widen the ceiling. */
export function expandAgentCapabilities(role: AgentRole, steps: AgentToolStep[]): AgentRole {
  const ceiling = new Set(role.skillToolCeiling || role.allowedTools);
  const enabled = new Set(role.allowedTools.filter(name => ceiling.has(name)));
  if (!enabled.has('discover_agent_capabilities')) return { ...role, allowedTools: [...enabled] };
  for (const step of steps) {
    if (!step.ok || step.call.name !== 'discover_agent_capabilities' || step.call.arguments.domains === undefined) continue;
    try {
      for (const id of domains(step.call.arguments.domains)) for (const name of AGENT_CAPABILITY_DOMAINS[id].tools) {
        if (ceiling.has(name) && getTool(name)) enabled.add(name);
      }
    } catch { /* Malformed historical discovery is never a permission grant. */ }
  }
  return { ...role, allowedTools: [...enabled] };
}

/** Distinguish missing definitions from a real role boundary; never unlock on a failed call. */
export function agentToolAvailabilityError(role: AgentRole, name: string): string {
  if (!getTool(name)) return `工具未注册：${name}。不能把模型生成的工具名称当作真实接口；请检查已安装能力，不原样重试。`;
  const ceiling = role.skillToolCeiling || role.allowedTools;
  if (!ceiling.includes(name)) return `当前角色权限上限禁止使用工具：${name}。能力发现和用户口头要求都不能越过角色边界；不要重复调用。`;
  const domain = Object.entries(AGENT_CAPABILITY_DOMAINS).find(([, value]) => (value.tools as readonly string[]).includes(name))?.[0];
  if (domain && ceiling.includes('discover_agent_capabilities') && role.allowedTools.includes('discover_agent_capabilities')) return `当前Skill尚未加载工具：${name}，不是软件缺少写入接口。先调用discover_agent_capabilities，参数${JSON.stringify({ domains: [domain] })}，取得真实定义后再调用；不能原样重试，也不能跳过该工具的用户确认。`;
  return `当前会话未加载工具：${name}。请核对当前角色及工具列表；不要宣称已经写入或重复调用不可用工具。`;
}
