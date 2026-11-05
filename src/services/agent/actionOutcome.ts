import type { AgentObservedOutcome, AgentRuntimeContext, AgentToolStep } from './types';

export interface AgentActionOutcomeContext {
  existingPlanPreview?: boolean;
  resourceWritebackVerified?: boolean;
}

export function verifyAgentObservedOutcome(outcome: AgentObservedOutcome | undefined, ctx: AgentRuntimeContext): boolean {
  if (!outcome || outcome.kind !== 'resource-writeback' || !outcome.eventId
    || !Number.isSafeInteger(outcome.resourceCount) || outcome.resourceCount < 1 || !outcome.projects.length) return false;
  const notes = ctx.getNotes();
  return outcome.projects.every((project) => {
    const note = notes.find((item) => item.id === project.noteId && item.noteType === 'project');
    const urls = new Set(note?.resources?.map((item) => item.url));
    return Boolean(note && project.resourceUrls.length && project.resourceUrls.every((url) => urls.has(url)));
  });
}

const ACTION_TOOLS: Record<string, string[]> = {
  'personalized-textbook': ['prepare_project_textbook', 'generate_project_textbook', 'edit_project_textbook', 'undo_agent_operation', 'regenerate_textbook_chapters', 'stop_textbook_job', 'archive_textbook_job', 'clear_textbook_draft_cache', 'open_project_textbook'],
  'plan-planning': ['update_learning_capacity', 'create_project_plan', 'adjust_plan_task', 'commit_project_task_draft', 'discard_project_task_draft',
    'stage_project_structure_patches', 'stage_plan_settings_patch', 'stage_plan_milestone_patches', 'stage_plan_execution_patches', 'stage_plan_portfolio_patches'],
  'study-task-generation': ['stage_project_study_task_batch', 'commit_project_task_draft', 'discard_project_task_draft'],
  'resource-curation': ['update_document_project_bindings', 'update_document_categories', 'start_document_processing', 'search_online_learning_resources', 'download_project_resources', 'stage_project_resource_batch', 'commit_project_resource_draft', 'discard_project_resource_draft'],
  'scene-setup': ['enter_learning_mode'],
  'socratic-review': ['enter_learning_mode', 'navigate'],
  'knowledge-capture': ['create_knowledge_note', 'start_wiki_concept_batch', 'control_wiki_concept_job', 'query_wiki_concept_jobs'],
};
export const FALSE_ACTIVE_SKILL_DENIAL = /(?:skill|技能).{0,24}(?:未激活|没有激活|未启用|没有.{0,12}激活|需要.{0,8}激活)|(?:没有|未).{0,20}(?:激活|启用).{0,20}(?:skill|技能)|技能面板|设置页.{0,16}(?:skill|技能)/iu;
const COMPLETION_CLAIM = /(?:已(?:经)?|成功|完成了).{0,16}(?:生成|制定|创建|写入|保存|提交|收录|调整|修改|进入|打开|搭建)/u;
const CONTINUE_PROMISE = /(?:我会|接下来|现在).{0,14}(?:继续)?(?:生成|制定|创建|执行|统筹|搭建)/u;

/** Startup receipts are not completion. Only later, matching module status can prove it. */
function verifiedDocumentMaintenance(trace: AgentToolStep[]): boolean {
  const start = trace.map((step, index) => ({ step, index })).reverse().find(({ step }) => step.ok && step.call.name === 'start_document_processing');
  if (!start) return false;
  const result = start.step.result as { results?: Array<{ documentId: string; status: string; jobId?: string }> };
  if (!Array.isArray(result?.results) || !result.results.length || result.results.some(item => ['failed', 'not-started'].includes(item.status))) return false;
  const operation = start.step.call.arguments.operation;
  const query = trace.slice(start.index + 1).filter(step => step.ok && step.call.name === (operation === 'body-index' ? 'query_local_documents' : 'query_agent_jobs')).at(-1);
  const rows = (query?.result as { documents?: Array<Record<string, unknown>>; tasks?: Array<Record<string, unknown>> } | undefined);
  return result.results.every(item => operation === 'body-index'
    ? rows?.documents?.some(row => row.id === item.documentId && row.status === 'ready' && !['pending', 'processing', 'failed'].includes(String(row.parseStatus)))
    : !!item.jobId && rows?.tasks?.some(row => row.id === item.jobId && row.status === 'completed'
      && (row.scope as { docId?: string } | undefined)?.docId === item.documentId)) === true;
}

export function agentActionRecoveryReason(reply: string, skillId: string | undefined, trace: AgentToolStep[], context: AgentActionOutcomeContext = {}): string | undefined {
  if (!skillId || skillId === 'personalized-qa' || !ACTION_TOOLS[skillId]) return;
  const skillClaim = reply.replace(/(?:无需|不用|不必|不需要)[^。！？；，,.!?;\n]*/gu, '');
  if (FALSE_ACTIVE_SKILL_DENIAL.test(skillClaim)) return 'Skill 已自动激活，不能要求用户开启技能面板。';
  const affirmativeReply = reply.replace(/(?:尚未|还未|并未|未曾|没有|不会|不能|不应|不代表|不需要|无需|不必|未(?=写入|保存|提交|收录|生成|创建))[^。！？；，,.!?;\n]*/gu, '');
  if (skillId === 'plan-planning' && (/(?:需要|必须|请|先).{0,16}(?:上传|提供|导入).{0,12}(?:资料|文档|教材)/iu.test(affirmativeReply)
    || /(?:没有|缺少).{0,12}(?:资料|文档|RAG).{0,16}(?:无法|不能|暂时不)/iu.test(reply))) {
    return '制定计划不要求上传资料；本地资料为空时仍可按目标、时间和学习情况规划。';
  }
  const successful = trace.filter((step) => step.ok && (step.call.name === 'update_note' || ACTION_TOOLS[skillId].includes(step.call.name)
    || ['personalized-textbook', 'study-task-generation', 'knowledge-capture'].includes(skillId)
      && ['prepare_background_workflow', 'start_background_workflow', 'query_background_workflows', 'stop_background_workflow'].includes(step.call.name)));
  const writeClaim = /(?:已(?:经)?|成功).{0,16}(?:写入|保存|收录|创建.{0,5}笔记|发布)/u.test(affirmativeReply)
    || trace.some(step => step.call.name === 'update_note') && /(?:已(?:经)?|成功).{0,16}(?:修改|替换|更新)/u.test(affirmativeReply);
  const maintenanceCompleted = verifiedDocumentMaintenance(trace);
  if (!maintenanceCompleted && successful.some(step => step.call.name === 'start_document_processing')
    && /已(?:经)?(?:全部)?(?:完成|生成|重建|处理完|保存|写入)|(?:生成|重建|索引|处理).{0,6}(?:已完成|完成了|成功)/u.test(affirmativeReply)) {
    return '资料处理工具只返回后台启动回执，不等于索引或论证图完成；请查询真实任务状态后再报告完成。';
  }
  const hasConfirmedWrite = maintenanceCompleted || successful.some((step) => {
    const result = step.result as { requiresUserConfirmation?: boolean; draftImported?: boolean; status?: string; saved?: boolean } | undefined;
    if (result?.requiresUserConfirmation || result?.draftImported) return false;
    if (step.call.name === 'update_learning_capacity') return result?.saved === true;
    if (step.call.name === 'update_note') return result?.saved === true;
    if (step.call.name === 'update_document_project_bindings') return result?.saved === true;
    if (step.call.name === 'update_document_categories') return result?.saved === true;
    if (step.call.name === 'download_project_resources') return result?.saved === true;
    if (step.call.name === 'query_background_workflows') return result?.saved === true;
    if (['generate_project_textbook', 'regenerate_textbook_chapters'].includes(step.call.name)) return result?.status === 'published' && result.saved === true;
    if (['edit_project_textbook', 'undo_agent_operation'].includes(step.call.name)) return result?.saved === true;
    if (step.call.name === 'search_online_learning_resources') return result?.status === 'written' || result?.saved === true;
    if (step.call.name === 'query_wiki_concept_jobs') return result?.saved === true;
    return ['adjust_plan_task', 'commit_project_task_draft', 'commit_project_resource_draft', 'create_knowledge_note'].includes(step.call.name);
  });
  if (writeClaim && !hasConfirmedWrite && !(context.resourceWritebackVerified && skillId === 'resource-curation' && !successful.length)) {
    return skillId === 'study-task-generation'
      ? '学习任务尚未写入；全部生成后调用 commit_project_task_draft 请求确认。'
      : '当前没有最终写入成功记录；草案暂存、导入编辑器或打开工作台不等于写入，不能声称已写入。';
  }
  const verifiedExistingResult = (skillId === 'resource-curation' && context.resourceWritebackVerified)
    || (skillId === 'plan-planning' && context.existingPlanPreview && !writeClaim);
  if (!successful.length && ((!verifiedExistingResult && COMPLETION_CLAIM.test(affirmativeReply))
    || (CONTINUE_PROMISE.test(affirmativeReply) && !/[？?]|请.{0,8}(?:告诉|补充|确认)|需要.{0,8}(?:目标|日期|时间|范围)/u.test(reply)))) {
    return '当前没有对应的操作成功记录；信息充分时必须调用工具，信息不足时只问关键缺项。';
  }
}

export function reconcileAgentActionReply(reply: string, skillId: string | undefined, trace: AgentToolStep[], context: AgentActionOutcomeContext = {}): string {
  const reason = agentActionRecoveryReason(reply, skillId, trace, context);
  if (!reason) return reply;
  const imported = trace.some((step) => step.ok && (step.result as { draftImported?: boolean } | undefined)?.draftImported);
  if (imported) return '草图已导入计划编辑器，尚未写入笔记。请在编辑器中检查并确认。';
  return trace.some((step) => step.ok)
    ? '已完成部分处理，但本次请求尚未完成。已完成的操作保留在运行记录中，请继续处理剩余步骤。'
    : '本次还没有完成该操作，也没有写入数据。请重试；不需要手动激活 Skill，制定计划也不要求上传资料。';
}
