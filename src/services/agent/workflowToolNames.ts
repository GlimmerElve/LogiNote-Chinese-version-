/** Leaf module: avoid a capabilities ↔ Skill registration initialization cycle. */
import type { LlmToolCall } from '../../types';
export const AGENT_WORKFLOW_TOOLS = ['query_home_learning_state', 'prepare_background_workflow', 'start_background_workflow', 'query_background_workflows', 'stop_background_workflow', 'archive_background_workflow'];
export function backgroundWorkflowResumeCall(jobId: string): LlmToolCall {
  if (!/^workflow-[a-zA-Z0-9_-]{1,100}$/u.test(jobId)) throw new Error('组合任务 ID 无效');
  return { id: `resume-${jobId}`, name: 'start_background_workflow', arguments: { jobId } };
}
export const AGENT_WORKFLOW_GUIDANCE = `【组合目标与后台执行】
先理解用户想完成的目标、范围与否定约束，再决定是否需要工具；疑问句、能力/语气元问题和闲聊不默认答疑或工作流。
用户要求多项学习准备、只生成任务/补全知识点/准备教材或后台处理时，可用现有自由度组合能力，不要求固定关键词：先读 query_home_learning_state（今日可执行未完成叶子项目，不按截止日等于今天猜测），或核对用户明确的稳定项目ID，再 prepare_background_workflow 规划需要的步骤和前置条件。
准备不代表执行。start_background_workflow 必须在开始前出示一次真实项目清单、模型（含远程数据发送范围）、证据及后续自动写入的确认卡。仅在该流程批准范围内，后续步骤由后台服务自动调用已安装工作流并保存，不逐项重复弹确认；这不取消独立工具的确认，也不授权删除/评分/认知写入/其它项目。
这是现有领域单独确认规则的限定例外，只能通过真实 start_background_workflow 的确认启动，不能在聊天中自行宣称“用户已授权”并直接调用其它写入工具。用户可 stop_background_workflow 立即停止后续步骤；查询 query_background_workflows 核对真实成果，后台启动或生成响应不等于保存完成。
前置状态由程序提交与核验：已有学习任务/知识点正文/教材跳过，概念必须先保存且审核通过才准备教材，失败保留原任务与草稿。无当前或父项目绑定本地资源时只用已补全关联知识点，不搜索全库、不联网或默认启动资源统筹；不足就报告具体缺口，不能以常识、占位文本或模型承诺冒充证据。
【资料维护后台编排】用户明确要求整理已有资料、重建索引或生成资料论证图时，先query_local_documents取得真实ID和前置状态。update_document_categories只改展示分类；start_document_processing的body-index仅本地索引，argument-graph生成/继续已有原文的图。只有用户明确要求先重建正文再重建论证图，才选body-and-argument并在整批确认卡说明旧索引/图的替换范围。返回jobId或queued只是已启动，继续用query_agent_jobs/query_local_documents核对状态；取消用原任务ID。最多10份资料一次确认，不由学习准备任务自动发起，不扩展到未选资料，不继承教材组合流程的许可，不开放任意脚本。`;
