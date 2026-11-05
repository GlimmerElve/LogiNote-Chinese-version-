import type { LlmTool } from '../../types';
import type { AgentRole, AgentRuntimeContext, AgentToolDefinition } from './types';
import { restrictCognitionRole } from './cognitionAssistantPolicy';

const tools = new Map<string, AgentToolDefinition>();

export function registerTool(definition: AgentToolDefinition): void {
  tools.set(definition.name, definition);
}

export function getTool(name: string): AgentToolDefinition | undefined {
  return tools.get(name);
}

export function listToolsForRole(role: AgentRole): AgentToolDefinition[] {
  const allowed = new Set(restrictCognitionRole(role).allowedTools);
  return [...tools.values()].filter((tool) => allowed.has(tool.name));
}

export function toLlmTools(definitions: AgentToolDefinition[]): LlmTool[] {
  return definitions.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function describeToolConfirmation(
  definition: AgentToolDefinition,
  args: Record<string, unknown>,
  ctx?: AgentRuntimeContext,
) {
  return definition.confirmation?.(args, ctx) || {
    title: definition.name,
    description: definition.description,
  };
}

export function toolRequiresApproval(
  definition: AgentToolDefinition,
  args: Record<string, unknown>,
  ctx: AgentRuntimeContext,
): boolean {
  if (definition.requiresExplicitApproval) return true;
  try {
    if (definition.isPreauthorized?.(args, ctx)) return false;
  } catch { /* 本地授权判定异常时安全回退到人工确认 */ }
  return definition.permission === 'write' || definition.requiresConfirmation === true;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentRuntimeContext,
  execution?: { signal?: AbortSignal; userApproved?: boolean; cognitionContext?: boolean },
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const tool = tools.get(name);
  if (!tool) return { ok: false, error: `未知工具：${name}` };
  try {
    if (tool.requiresExplicitApproval && execution?.userApproved !== true) throw new Error(tool.requiresCognitionContext
      ? '必须先由用户确认具体变更，聊天表态或自动模式不能授权修改认知库'
      : '必须先由用户确认这批具体操作，聊天表态或自动模式不能代替确认卡');
    if (tool.requiresCognitionContext && execution?.cognitionContext !== true) throw new Error('只有当前明确的个人认知管理请求才能使用此工具');
    execution?.signal?.throwIfAborted();
    return { ok: true, result: await tool.execute(args, ctx, execution) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Never model-selectable: the engine uses this only after validating every visible approval item. */
export async function executeApprovedToolBatch(name: string, args: Record<string, unknown>[], ctx: AgentRuntimeContext,
  execution: { signal?: AbortSignal; userApproved?: boolean; cognitionContext?: boolean }): Promise<{ ok: boolean; results?: unknown[]; error?: string }> {
  const tool = tools.get(name);
  try {
    if (!tool?.executeApprovedBatch || execution.userApproved !== true) throw new Error('批量写入必须先确认每项具体变更');
    if (tool.requiresCognitionContext && execution.cognitionContext !== true) throw new Error('只有当前明确的个人认知管理请求才能使用此工具');
    execution.signal?.throwIfAborted();
    const results = await tool.executeApprovedBatch(args, ctx, { ...execution, userApproved: true });
    return { ok: true, results };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export function clearToolRegistryForTests(): void {
  tools.clear();
}
