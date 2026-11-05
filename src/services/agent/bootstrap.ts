import type { AgentRole } from './types';
import { listAgentSkills } from './skillRegistry';
import { getTool } from './toolRegistry';
import { registerDataTools } from './tools/dataTools';
import { registerPlanTools } from './tools/planTools';
import { registerQaTools } from './tools/qaTools';
import { registerResourceTools } from './tools/resourceTools';
import { registerDocumentTools } from './tools/documentTools';
import { registerDocumentReadTools } from './tools/documentReadTools';
import { registerDocumentMaintenanceTools } from './tools/documentMaintenanceTools';
import { registerUiTools } from './tools/uiTools';
import { registerTextbookTools } from './tools/textbookTools';
import { registerPersonaTools } from './tools/personaTools';
import { registerWorkspaceTools } from './tools/workspaceTools';
import { registerCapabilityTools } from './capabilities';
import { registerWorkspaceOperationTools } from './tools/workspaceOperationTools';
import { registerJobTools } from './tools/jobTools';
import { registerConceptTools } from './tools/conceptTools';
import { registerBackgroundWorkflowTools } from './tools/backgroundWorkflowTools';
import { registerLearningCapacityTools } from './tools/learningCapacityTools';
import { registerCognitionTools } from './tools/cognitionTools';

export interface AgentRuntimeRegistrationReport {
  skillIds: string[];
  toolNames: string[];
  diagnostics: string[];
}

const REQUIRED_SKILL_IDS = [
  'personalized-textbook',
  'knowledge-capture',
  'scene-setup',
  'resource-curation',
  'personalized-qa',
  'study-task-generation',
  'plan-planning',
  'socratic-review',
] as const;

export function validateAgentRuntimeRegistration(role: AgentRole): AgentRuntimeRegistrationReport {
  const skills = listAgentSkills();
  const skillIds = skills.map((skill) => skill.id);
  const diagnostics: string[] = [];
  const toolNames = [...new Set([
    ...role.allowedTools,
    ...skills.flatMap((skill) => skill.allowedTools),
  ])];
  const ceiling = new Set(role.skillToolCeiling || role.allowedTools);

  REQUIRED_SKILL_IDS.forEach((id) => {
    if (!skillIds.includes(id)) diagnostics.push(`缺少主要 Skill：${id}`);
  });
  skills.forEach((skill) => {
    skill.allowedTools.forEach((name) => {
      if (!getTool(name)) diagnostics.push(`Skill ${skill.id} 引用了未注册工具：${name}`);
      if (!ceiling.has(name)) diagnostics.push(`Skill ${skill.id} 的工具不在角色权限上限中：${name}`);
    });
  });
  (role.skillToolCeiling || role.allowedTools).forEach((name) => {
    if (!getTool(name)) diagnostics.push(`角色权限上限引用了未注册工具：${name}`);
  });

  return { skillIds, toolNames, diagnostics: [...new Set(diagnostics)] };
}

/**
 * 所有 Agent 入口共用的唯一启动函数。重复调用是安全的，便于 Electron
 * 多窗口和开发热更新重新建立本地注册表。
 */
export function bootstrapAgentRuntime(role: AgentRole): AgentRuntimeRegistrationReport {
  registerDataTools();
  registerQaTools();
  registerUiTools();
  registerPersonaTools();
  registerWorkspaceTools();
  registerPlanTools();
  registerResourceTools();
  registerDocumentTools();
  registerDocumentReadTools();
  registerDocumentMaintenanceTools();
  registerTextbookTools();
  registerWorkspaceOperationTools();
  registerJobTools();
  registerConceptTools();
  registerBackgroundWorkflowTools();
  registerLearningCapacityTools();
  registerCognitionTools();
  registerCapabilityTools();
  const report = validateAgentRuntimeRegistration(role);
  if (report.diagnostics.length > 0) {
    throw new Error(`Agent 运行时注册不完整：\n${report.diagnostics.join('\n')}`);
  }
  return report;
}
