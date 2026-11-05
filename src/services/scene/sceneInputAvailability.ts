import type { SceneInputForm, SceneRunState, SceneSpec } from '../../types';
import { sceneInputForm } from './sceneInputForm';
import { getPendingSceneInteraction } from './scenePendingTask';

export interface SceneInputAvailability {
  formConfigured: boolean;
  inputForm?: SceneInputForm;
  formAvailable: boolean;
  formBlockedReason?: string;
  pendingInteractionId?: string;
}

/** Local input facts, not teaching policy. A form never retires an unanswered objective task. */
export function resolveSceneInputAvailability(spec: SceneSpec, run: SceneRunState): SceneInputAvailability {
  const formConfigured = Array.isArray(spec.promptModuleIds) && spec.promptModuleIds.includes('input-form');
  let pending: ReturnType<typeof getPendingSceneInteraction>;
  try { pending = getPendingSceneInteraction(run); }
  catch { return { formConfigured, formAvailable: false, formBlockedReason: '当前任务状态无法可靠检查，暂不能提交表单。' }; }
  const pendingInteractionId = pending?.interaction?.id;
  if (!formConfigured) return { formConfigured, formAvailable: false, pendingInteractionId };
  let inputForm: SceneInputForm | undefined;
  try { inputForm = sceneInputForm(spec); }
  catch { return { formConfigured, formAvailable: false, pendingInteractionId, formBlockedReason: '表单配置未通过本地校验；仍可使用其他已授权互动方式或结束本局。' }; }
  const state = { formConfigured, inputForm, pendingInteractionId };
  if (!inputForm) return { ...state, formAvailable: false, formBlockedReason: '本场景未授权表单所需的文本输入，不能使用表单替代指定答题控件。' };
  if (run.status !== 'running') return { ...state, formAvailable: false, formBlockedReason: '场景已结束，表单不再接收提交。' };
  if (pending?.interaction?.type && pending.interaction.type !== 'text') return { ...state, formAvailable: false,
    formBlockedReason: spec.runtimeContract?.allowConversation === false ? '当前原题仍待答；完成原题后可填写。本场景未开放自由交流。'
      : '当前原题仍待答；完成原题或通过场景交流要求切换后可填写。' };
  return { ...state, formAvailable: true };
}

/** Model-visible local facts exclude the full form, which is compiled separately once. */
export function sceneInputAvailabilityContext(spec: SceneSpec, run: SceneRunState): Omit<SceneInputAvailability, 'inputForm'> {
  const { formConfigured, formAvailable, formBlockedReason, pendingInteractionId } = resolveSceneInputAvailability(spec, run);
  return { formConfigured, formAvailable, formBlockedReason, pendingInteractionId };
}
