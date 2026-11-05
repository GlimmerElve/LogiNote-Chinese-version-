import type { S2AgentComponentDescription } from './sceneS2AgentCatalog';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { S2PublicAuthoringError } from './sceneS2PublicAuthoring';
import { S2InteractionProtocolError } from './sceneS2InteractionProtocol';

export interface S2PublicRepairIssue { code: string; path: string; reason: string }
export interface S2PublicRepair {
  issue: S2PublicRepairIssue;
  /** A failed public draft, not a validated canvas, native graph or authority. */
  candidate: { canvas: Record<string, unknown>; instructions?: Record<string, unknown>; interaction?: Record<string, unknown> };
}

/** Errors produced by the public output envelope checks, before native compilation. */
export class S2PublicDesignValidationError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) {
    super(`S2 公开搭建：${reason}；原画布未修改`); this.name = 'S2PublicDesignValidationError';
  }
}

// Never forward arbitrary error messages, stacks, native implementation paths,
// package defaults or internal node identities to a model request.
const reasons: Record<string, string> = {
  PUBLIC_FIELD: '包含未公开字段或缺少必需字段，只使用公开配置字段',
  PUBLIC_ID: '标识符须以英文字母开头，仅含字母、数字、下划线或横线，最多64字符',
  PUBLIC_TEXT: '文本为空或超过公开长度限制',
  PUBLIC_VERSION: '公开画布version必须为1',
  PUBLIC_POSITION: '位置须为有限数值，绝对值不超过100000',
  PUBLIC_DATA: '公开字段的数据类型不正确',
  PUBLIC_PARAMETER_VALUE: '参数值不符合公开取值规则',
  PUBLIC_PARAMETER_TYPE: '参数值不符合公开取值规则',
  PUBLIC_COMPONENT_PRIVATE: '只能使用已读取的公开组件',
  PUBLIC_COMPONENT_UNREAD: '只能使用已读取的公开组件',
  PUBLIC_PORT_PRIVATE: '只能连接公开实例的公开输出与输入端口',
  PUBLIC_INPUT_CONFLICT: '连接不能覆盖已填写参数，请遵守端口的单路或多路规则',
  PUBLIC_CONNECTION_DUPLICATE: '连线不能重复',
  PUBLIC_CONNECTION_TYPE: '连接两端的公开语义类型和版本必须一致，并满足输入输出约束',
  PUBLIC_CONNECTION_CARDINALITY: '单路输入最多一个来源，多路输入最多32个来源',
  PUBLIC_CONNECTION_CYCLE: '执行依赖不能形成环，请调整公开连线',
  PUBLIC_INSTANCE_COLLISION: '节点标识符重复或不可用，请使用唯一的公开实例标识',
  PUBLIC_READONLY: '保留原画布固定原文的实例、类型、内容和只读状态',
  PUBLIC_INSTRUCTIONS: '互动策略需要完整的understanding、planning、response文本，每项最多6000字符',
  INTERACTION_FIELD: '自动规则只使用已公开的version、triggers、id、on、task、scope字段',
  INTERACTION_VERSION: '自动规则version必须为1',
  INTERACTION_LIMIT: '最多16条规则，task最多4000字符，范围节点最多80项，actions为非空不重复数组',
  INTERACTION_REFERENCE: '事件须在interactionEvents中，来源及范围须引用候选画布公开实例，s2.node事件来源须为执行组件',
  INTERACTION_SCOPE: '规则只能引用公开实例，动作限reply、edit、execute；空nodeIds保留为空范围',
  INTERACTION_ID: '规则与节点使用合法公开标识，event使用interactionEvents中的完整事件ID',
  INTERACTION_DATA: '规则字段须为规定类型的完整文本或原生JSON值',
  INTERACTION_DUPLICATE: '规则ID、actions及nodeIds不得重复',
};
const parameterReasons = new Set(['需要数字', '需要布尔值', '需要字符串', '需要数组', '需要对象',
  '需要安全整数', '数值不符合公开范围', '参数值不符合公开取值规则']);
const segment = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function pick(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

/** A strict public path vocabulary. In particular, native /nodes/<internal-id>
 * paths cannot be passed off as public /nodes/<array-index> diagnostics. */
function issuePath(path: string, design: boolean): string | undefined {
  const value = design ? path : path === '/' ? '/canvas' : `/canvas${path}`;
  if (value === '/canvas' || value === '/' || value === '/instructions') return value === '/' ? '/canvas' : value;
  if (/^\/instructions\/(understanding|planning|response)$/.test(value)) return value;
  if (/^\/interaction(?:\/(version|triggers)(?:\/(0|[1-9]\d*)(?:\/(id|task|on|scope)(?:\/(event|nodeId|actions|nodeIds)(?:\/(0|[1-9]\d*))?)?)?)?)?$/.test(value)) return value;
  if (/^\/canvas\/(version|nodes|connections)$/.test(value)) return value;
  if (/^\/canvas\/nodes\/(0|[1-9]\d*)(\/(id|componentId|label|readOnly|position|values))?(\/([A-Za-z][A-Za-z0-9_-]{0,63}))?$/.test(value)) return value;
  if (/^\/canvas\/connections\/(0|[1-9]\d*)(\/(source|target)(\/(nodeId|portId))?)?$/.test(value)) return value;
  return undefined;
}

/** A pure, bounded repair projection. Complete permitted fields are retained;
 * unknown metadata/parameter fields are omitted rather than echoed as authority.
 * Malformed/oversized drafts fail closed instead of sending truncated fragments. */
export function createS2PublicRepair(error: unknown, raw: unknown,
  components: readonly S2AgentComponentDescription[]): S2PublicRepair | undefined {
  const design = error instanceof S2PublicDesignValidationError || error instanceof S2InteractionProtocolError;
  if (!design && !(error instanceof S2PublicAuthoringError)) return undefined;
  if (!Object.hasOwn(reasons, error.code)) return undefined;
  let path = issuePath(error.path, design);
  if (!path) return undefined;
  let output: Record<string, unknown>;
  try {
    const snapshot = snapshotS2CompositeData(raw, { maxBytes: 256000, maxEntries: 48000 });
    if (!record(snapshot) || JSON.stringify(snapshot).length > 64000) return undefined;
    output = snapshot;
  } catch { return undefined; }
  if (!record(output.canvas)) return undefined;
  const canvas = output.canvas;
  if (!Array.isArray(canvas.nodes) || canvas.nodes.length > 80 || !Array.isArray(canvas.connections) || canvas.connections.length > 80) return undefined;
  const selected = new Map(components.map(component => [component.id, component]));
  const nodes: Record<string, unknown>[] = [];
  for (const item of canvas.nodes) {
    if (!record(item) || !record(item.position)) return undefined;
    const node = pick(item, ['id', 'componentId', 'position', 'label', 'readOnly']);
    node.position = pick(item.position, ['x', 'y']);
    if (Object.hasOwn(item, 'values')) {
      if (!record(item.values)) return undefined;
      const component = typeof item.componentId === 'string' ? selected.get(item.componentId) : undefined;
      node.values = pick(item.values, component?.parameters.map(parameter => parameter.id) ?? []);
    }
    nodes.push(node);
  }
  const connections: Record<string, unknown>[] = [];
  for (const item of canvas.connections) {
    if (!record(item) || !record(item.source) || !record(item.target)) return undefined;
    // An incorrect endpoint value remains visible for targeted repair. These are
    // only the model's proposed public endpoint fields, never the private graph.
    connections.push({ source: pick(item.source, ['nodeId', 'portId']), target: pick(item.target, ['nodeId', 'portId']) });
  }
  let reason = reasons[error.code];
  if (['PUBLIC_PARAMETER_VALUE', 'PUBLIC_PARAMETER_TYPE'].includes(error.code) && parameterReasons.has(error.reason)) reason = error.reason;
  // The public compiler may identify the values object as a whole. Point to the
  // unknown short key while keeping its rejected value out of the next request.
  const valuesPath = /^\/canvas\/nodes\/(0|[1-9]\d*)\/values$/.exec(path);
  if (error.code === 'PUBLIC_FIELD' && valuesPath) {
    const original = canvas.nodes[Number(valuesPath[1])];
    if (record(original) && record(original.values) && typeof original.componentId === 'string') {
      const publicIds = new Set(selected.get(original.componentId)?.parameters.map(parameter => parameter.id));
      const unknown = Object.keys(original.values).find(key => !publicIds.has(key));
      if (unknown && segment.test(unknown)) path += `/${unknown}`;
    }
  }
  const candidate: S2PublicRepair['candidate'] = { canvas: { ...pick(canvas, ['version']), nodes, connections } };
  if (Object.hasOwn(output, 'instructions')) {
    if (!record(output.instructions)) return undefined;
    candidate.instructions = pick(output.instructions, ['understanding', 'planning', 'response']);
  }
  if (Object.hasOwn(output, 'interaction')) {
    if (!record(output.interaction) || !Array.isArray(output.interaction.triggers) || output.interaction.triggers.length > 16) return undefined;
    const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
    const interaction = pick(output.interaction, ['version']);
    if (Object.values(interaction).some(value => !primitive(value))) return undefined;
    const triggers: Record<string, unknown>[] = [];
    for (const item of output.interaction.triggers) {
      if (!record(item) || !record(item.on)) return undefined;
      const trigger = pick(item, ['id', 'task']), on = pick(item.on, ['event', 'nodeId']);
      if ([...Object.values(trigger), ...Object.values(on)].some(value => !primitive(value))) return undefined;
      trigger.on = on;
      if (Object.hasOwn(item, 'scope')) {
        if (!record(item.scope)) return undefined;
        const scope = pick(item.scope, ['actions', 'nodeIds']);
        for (const [key, values] of Object.entries(scope))
          if (!Array.isArray(values) || values.length > (key === 'actions' ? 3 : 80) || values.some(value => !primitive(value))) return undefined;
        trigger.scope = scope;
      }
      triggers.push(trigger);
    }
    candidate.interaction = { ...interaction, triggers };
  }
  try {
    // Recheck after projection as an exported helper may be called directly.
    const repair = snapshotS2CompositeData({ issue: { code: error.code, path, reason }, candidate }, { maxBytes: 256000, maxEntries: 48000 });
    return JSON.stringify(repair.candidate).length <= 64000 ? repair : undefined;
  } catch { return undefined; }
}
