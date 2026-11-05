import type { SceneInteractionDirective, SceneMessage, SceneRunState, SceneTaskUpdate } from '../../types';
import { normalizeSceneInteractionDirective, normalizeSceneInteractionResponse, SCENE_RUNTIME_INTERACTION_TYPES } from './sceneInteraction';

function storedDirective(message: SceneMessage): SceneInteractionDirective | undefined {
  const type = message.interaction?.type;
  if (!type || !SCENE_RUNTIME_INTERACTION_TYPES.includes(type)) return undefined;
  return normalizeSceneInteractionDirective(message.interaction, {
    version: '1.0', allowedTypes: [...SCENE_RUNTIME_INTERACTION_TYPES], defaultType: type, allowTextFallback: false,
  });
}

/** Only validated local responses, never model-authored memory, own pending state. */
export function getPendingSceneInteraction(run: SceneRunState): SceneMessage | undefined {
  const retired = new Set(run.retiredInteractionIds ?? []);
  let textFallback: SceneMessage | undefined;
  for (let index = run.messages.length - 1; index >= 0; index--) {
    const message = run.messages[index];
    if (message.speakerType !== 'role' || message.isStreaming) continue;
    const directive = storedDirective(message);
    if (!directive || retired.has(directive.id)) continue;
    const answered = run.messages.slice(index + 1).some(response => response.speakerType === 'user' && !response.isStreaming
      && response.inputKind !== 'conversation' && response.interactionResponse
      && Boolean(normalizeSceneInteractionResponse(response.interactionResponse, directive)));
    if (answered) continue;
    const pending = { ...message, interaction: directive };
    if (directive.type !== 'text') return pending;
    if (!textFallback) textFallback = pending;
  }
  return textFallback;
}

/** Protected public task context never contains the private answer key. */
export function pendingSceneContext(run: SceneRunState) {
  const pending = getPendingSceneInteraction(run);
  return pending ? { id: pending.id, taskMessageId: pending.id, interactionId: pending.interaction!.id,
    content: pending.content, directive: pending.interaction! } : undefined;
}

export class SceneTaskUpdateProtocolError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message); this.name = 'SceneTaskUpdateProtocolError';
  }
}
export function validateSceneTaskUpdate(raw: unknown, run: SceneRunState,
  nextInteraction?: SceneInteractionDirective): SceneTaskUpdate | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SceneTaskUpdateProtocolError('invalid-task-update', 'taskUpdate', '待答任务变更必须为结构化对象。');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['operation', 'interactionId', 'sourceUserMessageId', 'reason'].includes(key))
    || (value.operation !== 'replace' && value.operation !== 'cancel')) throw new SceneTaskUpdateProtocolError('invalid-task-operation', 'taskUpdate.operation', '待答任务变更操作或字段无效。');
  const pending = getPendingSceneInteraction(run);
  const latestUser = run.messages.findLast(message => message.speakerType === 'user' && !message.isStreaming);
  if (!pending?.interaction) throw new SceneTaskUpdateProtocolError('no-pending-task', 'taskUpdate.interactionId', '没有可变更的待答任务。');
  if (value.interactionId !== pending.interaction.id) throw new SceneTaskUpdateProtocolError('wrong-pending-id', 'taskUpdate.interactionId', '变更必须引用控件interactionId，不是任务消息taskMessageId。');
  if (!latestUser || latestUser.inputKind !== 'conversation' || value.sourceUserMessageId !== latestUser.id) {
    throw new SceneTaskUpdateProtocolError('invalid-task-source', 'taskUpdate.sourceUserMessageId', '变更必须引用最新真实用户交流，不能冒充已提交答案或历史请求。');
  }
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) throw new SceneTaskUpdateProtocolError('invalid-task-reason', 'taskUpdate.reason', '待答任务变更需要500字符以内的明确原因。');
  if (value.operation === 'replace' && (!nextInteraction || !nextInteraction.id.trim()
    || nextInteraction.id === pending.interaction.id)) throw new SceneTaskUpdateProtocolError('invalid-replacement', 'interaction.id', '换题必须提供不同ID的完整新交互。');
  if (value.operation === 'cancel' && nextInteraction !== undefined) throw new SceneTaskUpdateProtocolError('cancel-with-interaction', 'interaction', '取消任务时不得同时生成新交互；如需换题应使用replace。');
  return { operation: value.operation, interactionId: pending.interaction.id,
    sourceUserMessageId: latestUser.id, reason: value.reason.trim() };
}

/** Transport facts are validated locally; a conversational quote is never a submitted option. */
export function sceneInputFacts(run: SceneRunState) {
  const latest = run.messages.findLast(message => message.speakerType === 'user' && !message.isStreaming);
  const pending = getPendingSceneInteraction(run);
  let submittedInteractionId: string | undefined;
  if (latest?.inputKind !== 'conversation' && latest?.interactionResponse && !run.retiredInteractionIds?.includes(latest.interactionResponse.interactionId)) {
    const before = run.messages.slice(0, run.messages.indexOf(latest));
    const source = before.findLast(message => message.speakerType === 'role' && !message.isStreaming
      && message.interaction?.id === latest.interactionResponse!.interactionId);
    const directive = source && storedDirective(source);
    if (directive && normalizeSceneInteractionResponse(latest.interactionResponse, directive)) submittedInteractionId = directive.id;
  }
  return { sourceUserMessageId: latest?.id, inputKind: latest?.inputKind || 'response',
    hasSubmittedAnswer: Boolean(submittedInteractionId), submittedInteractionId,
    pendingInteractionId: pending?.interaction?.id, pendingTaskMessageId: pending?.id,
    canUpdatePending: Boolean(pending && latest?.inputKind === 'conversation' && !submittedInteractionId) };
}

/** Canonicalize proven no-ops, never a replacement/cancellation or a permission expansion. */
export function normalizeSceneTaskNoop(raw: unknown, run: SceneRunState, expected: 'keep' | 'replace' | 'cancel') {
  if (raw === undefined) return { value: undefined, normalization: undefined };
  if (expected !== 'keep') return { value: raw, normalization: undefined };
  if (raw === null) return { value: undefined, normalization: 'null-noop' as const };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, normalization: undefined };
  const value = raw as Record<string, unknown>;
  if (value.operation !== 'keep') return { value: raw, normalization: undefined };
  const pending = getPendingSceneInteraction(run),latest = run.messages.findLast(message => message.speakerType === 'user' && !message.isStreaming);
  if (Object.keys(value).some(key => !['operation','interactionId','sourceUserMessageId','reason'].includes(key))
    || (value.interactionId !== undefined && value.interactionId !== pending?.interaction?.id)
    || (value.sourceUserMessageId !== undefined && value.sourceUserMessageId !== latest?.id)
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 500))) {
    throw new SceneTaskUpdateProtocolError('invalid-keep-noop', 'taskUpdate', 'keep仅允许当前任务的无状态确认，不能携带其他任务、旧来源或未知字段。');
  }
  return { value: undefined, normalization: 'keep-noop' as const };
}
