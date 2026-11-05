import type { LlmConversationMessage } from '../../types';
import type { AgentRuntimeContext, AgentWorkspaceSnapshot } from './types';

function snapshotFromContext(ctx: AgentRuntimeContext): AgentWorkspaceSnapshot {
  const supplied = ctx.getWorkspaceSnapshot?.();
  if (supplied) return supplied;
  const note = ctx.getActiveNote?.() || null;
  return {
    revision: 0,
    view: 'editor',
    ...(note ? {
      focusedNoteId: note.id,
      focusedNoteTitle: note.title,
      focusedNoteType: note.noteType,
    } : {}),
  };
}

export function agentWorkspaceContextKey(ctx: AgentRuntimeContext): string {
  const snapshot = snapshotFromContext(ctx);
  return [...(ctx.getConversationId ? [ctx.getConversationId()] : []), snapshot.revision, snapshot.view, snapshot.focusedNoteId || '-', snapshot.focusedNoteType || '-'].join(':');
}

export function historyForAgentWorkspace(
  history: LlmConversationMessage[],
  previousContextKey: string,
  currentContextKey: string,
): LlmConversationMessage[] {
  return previousContextKey === currentContextKey ? history : [];
}

export function buildAgentWorkspaceContext(ctx: AgentRuntimeContext): string {
  const snapshot = snapshotFromContext(ctx);
  const focus = snapshot.focusedNoteId
    ? `${snapshot.focusedNoteTitle || '未命名'}（${snapshot.focusedNoteType || '未知类型'}，ID: ${snapshot.focusedNoteId}）`
    : '无';
  const reviewState = snapshot.view === 'review'
    ? '当前正在复习页；只有在用户本轮意图相符时才继续复习。'
    : '当前不在复习页；不得继续、追问或宣称旧复习仍在进行。';
  const recentEvents = (snapshot.recentEvents || []).slice(-6).map((event) => {
    const details = [event.status, Number.isFinite(event.score) ? `得分 ${event.score}` : '', event.noteId ? `noteId=${event.noteId}` : ''].filter(Boolean).join('，');
    return `- ${event.occurredAt} | ${event.kind} | ${event.title}${details ? ` | ${details}` : ''} | ${event.summary}`;
  }).join('\n') || '- 无已记录的近期事件';
  return `【${ctx.getConversationId ? '当前对话标签绑定的工作对象（不是其他标签或当前页面的焦点）' : '当前页面状态（可信、实时）'}】
导航版本：${snapshot.revision}
当前页面：${snapshot.view}
当前焦点笔记：${focus}
${reviewState}
【近期已完成的界面事件（可信）】
${recentEvents}
近期事件是“已发生的事实”，不代表相应页面仍在运行。可在用户询问学习结果、下一步或当前状态时自然承接，不要无端重复追问。
当用户说“这篇”“当前笔记”“这个项目”时，必须绑定上述当前焦点 ID。${ctx.getConversationId ? '本标签拥有独立短时记忆、任务上下文与审批；不能读取或推断其他标签正在讨论什么。切页不改变这里的绑定，用户可用“使用当前页面”更新绑定。' : ''}对话历史里的其他页面、旧项目、旧复习问题和旧任务 ID 只是过去事实，不得覆盖${ctx.getConversationId ? '本标签绑定的工作对象' : '当前页面'}。
项目是否已有教材、已有哪几章以及任务是否完成，必须以对应项目 ID 的当前工具查询结果为准；不能把其他对象的聊天描述当成本项目状态，也不能仅凭旧回复拒绝用户的新生成请求。
已确认并开始的后台任务与页面焦点独立：切换页面或关闭助手不等于取消，任务继续使用其已确认的项目和资料快照。但新的“这篇”请求不得自动复用旧 jobId；只有用户明确说继续/恢复旧任务或点击对应续跑操作时才可续接。`;
}
