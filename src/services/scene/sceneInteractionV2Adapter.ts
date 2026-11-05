import type {
  SceneInteractionDirective,
  SceneInteractionProtocol,
  SceneInteractionResponse,
} from '../../types';
import {
  getSceneInteractionComponentV2,
  type SceneInteractionComponentV2Definition,
} from './sceneInteractionComponentV2';
import {
  normalizeSceneInteractionDirective,
  normalizeSceneInteractionResponse,
} from './sceneInteraction';

/** Execution-stage preparation is separate from normalization and rendering. */
export { prepareSceneInteractionTask as prepareSceneInteractionTaskV2 } from './sceneTaskPreparation';

export interface ResolvedSceneInteractionV2 {
  component: SceneInteractionComponentV2Definition;
  directive: SceneInteractionDirective;
}

function requestedType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' ? type.trim() : undefined;
}

/** 先经过 V2 白名单/作用域，再复用已跑通的 V1 字段归一化器。 */
export function resolveSceneInteractionDirectiveV2(
  value: unknown,
  protocol: SceneInteractionProtocol,
): ResolvedSceneInteractionV2 | undefined {
  const type = requestedType(value);
  if (!type) return undefined;
  const component = getSceneInteractionComponentV2(type as never, 'top-level');
  if (!component) return undefined;
  const directive = normalizeSceneInteractionDirective(value, protocol);
  if (!directive || directive.type !== component.capabilityId) return undefined;
  return { component, directive };
}

export function normalizeSceneInteractionDirectiveV2(
  value: unknown,
  protocol: SceneInteractionProtocol,
): SceneInteractionDirective | undefined {
  return resolveSceneInteractionDirectiveV2(value, protocol)?.directive;
}

/** 响应同样必须命中已注册 V2 组件，随后才进入既有防伪造校验。 */
export function normalizeSceneInteractionResponseV2(
  value: unknown,
  directive: SceneInteractionDirective,
): SceneInteractionResponse | undefined {
  const component = getSceneInteractionComponentV2(directive.type, 'top-level');
  if (!component) return undefined;
  const response = normalizeSceneInteractionResponse(value, directive);
  return response?.type === component.capabilityId ? response : undefined;
}
