import type { SceneInteractionPack, ScenePackConfig } from '../../types/sceneInteractionPack';
import type { S2CanvasDefinition, S2Document } from '../../types/sceneS2';
import type { S2InteractionAction, S2InteractionScope } from '../../types/sceneS2Interaction';
import { readS2Definition, readS2Document } from './sceneS2Canvas';
import { snapshotS2CompositeData } from './sceneS2Composite';
import { pruneS2CanvasComposites } from './sceneS2CompositeCanvas';
import { readS2InteractionActions, readS2InteractionScope } from './sceneS2InteractionProtocol';
import { pruneS2Groups } from './sceneS2Layout';
import { assertS2PublicEdit, compileS2PublicCanvas, projectS2PublicCanvas, S2PublicAuthoringError, type S2PublicCanvas } from './sceneS2PublicAuthoring';
import { selectS2Execution } from './sceneS2Workflow';
import { scenePackAllowsExecution } from './sceneInteractionPackProtocol';

export class S2InteractionActionError extends Error {
  constructor(readonly code: string, readonly path: string, readonly reason: string) {
    super(`S2 交互操作 [${code}] ${path}：${reason}`); this.name = 'S2InteractionActionError';
  }
}
const fail = (code: string, index: number, reason: string): never => { throw new S2InteractionActionError(code, `/actions/${index}`, reason); };
const copy = <T>(value: T): T => snapshotS2CompositeData(value, { maxBytes: 786432, maxEntries: 48000 });
const edited = (action: S2InteractionAction) => !['run', 'cancel'].includes(action.type);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
type EditAction = Exclude<S2InteractionAction, { type: 'run' | 'cancel' }>;
type Step = { indexes: number[]; type: 'edit'; actions: EditAction[] }
  | { indexes: number[]; type: 'run'; action: Extract<S2InteractionAction, { type: 'run' }> }
  | { indexes: number[]; type: 'cancel'; action: Extract<S2InteractionAction, { type: 'cancel' }> };

export interface S2PreparedInteractionActions {
  readonly actionCount: number;
  readonly hasEdits: boolean;
  readonly hasExecution: boolean;
}
interface PreparedData {
  pack: SceneInteractionPack;
  scope: S2InteractionScope;
  baseline: Pick<S2Document, 'nodes'>;
  steps: Step[];
}
const plans = new WeakMap<S2PreparedInteractionActions, PreparedData>();

const safeReasons: Record<string, string> = {
  PUBLIC_PARAMETER_TYPE: '参数值不符合公开取值规则', PUBLIC_PARAMETER_VALUE: '参数值不符合公开取值规则',
  PUBLIC_CONNECTION_TYPE: '连接两端的公开类型、版本、必填及多值约定不匹配',
  PUBLIC_CONNECTION_CARDINALITY: '单路输入最多一个来源，多路输入最多32个来源',
  PUBLIC_CONNECTION_CYCLE: '执行依赖不能形成环', PUBLIC_CONNECTION_DUPLICATE: '连线不能重复',
  PUBLIC_INPUT_CONFLICT: '连接不能覆盖已有参数，请先明确断开原来源',
  PUBLIC_PORT_PRIVATE: '连接只能引用公开实例的公开端口',
  PUBLIC_COMPONENT_PRIVATE: '组件、字段或参数没有公开',
  PUBLIC_COMPONENT_AMBIGUOUS: '历史节点的公开组件身份不明确',
  PUBLIC_INTERNAL_IMMUTABLE: '不能修改包内固定实例或关系',
};
const safeParameterReasons = new Set(['需要数字', '需要布尔值', '需要字符串', '需要数组', '需要对象',
  '需要安全整数', '数值不符合公开范围', '参数值不符合公开取值规则']);
function diagnosis(error: unknown, index: number): S2InteractionActionError {
  if (error instanceof S2InteractionActionError) return error;
  if (error instanceof S2PublicAuthoringError && Object.hasOwn(safeReasons, error.code)) {
    const parameter = error.code === 'PUBLIC_PARAMETER_TYPE' || error.code === 'PUBLIC_PARAMETER_VALUE';
    return new S2InteractionActionError(error.code, `/actions/${index}`,
      parameter && safeParameterReasons.has(error.reason) ? error.reason : safeReasons[error.code]);
  }
  // Raw native errors may name private instances or fixed parameter values.
  return new S2InteractionActionError('INTERACTION_EDIT_INVALID', `/actions/${index}`, '操作未通过公开接口、类型或只读校验');
}
function checkedConfig(pack: SceneInteractionPack, raw: ScenePackConfig, baseline: Pick<S2Document, 'nodes'>): ScenePackConfig {
  const definition = readS2Definition(copy(raw.definition));
  const config = { definition, document: readS2Document(copy(raw.document), definition) };
  assertS2PublicEdit(pack, config, config, baseline);
  return config;
}
function target(scope: S2InteractionScope, id: string, canvas: S2PublicCanvas, index: number) {
  if (scope.nodeIds !== undefined && !scope.nodeIds.includes(id)) fail('INTERACTION_SCOPE', index, '目标不在本轮公开对象范围内');
  if (!canvas.nodes.some(node => node.id === id)) fail('INTERACTION_TARGET', index, '目标不是当前公开节点');
}
function permission(scope: S2InteractionScope, kind: 'edit' | 'execute', index: number) {
  if (!scope.actions.includes(kind)) fail('INTERACTION_SCOPE', index, kind === 'edit' ? '本轮未允许修改画布' : '本轮未允许执行');
}

/** Preserve editor-only graph data while replacing only public compiled values,
 * bindings and connections. This is deliberately not a canvas-wide replacement. */
function preserveDocument(before: ScenePackConfig, compiled: ScenePackConfig): ScenePackConfig {
  const original = before.document;
  const document: S2Document = { ...structuredClone(original),
    nodes: compiled.document.nodes.map(node => ({ ...structuredClone(original.nodes.find(previous => previous.id === node.id) ?? node), ...node })),
    edges: structuredClone(original.edges),
  };
  if (compiled.document.execution) document.execution = { ...structuredClone(original.execution ?? compiled.document.execution),
    nodes: compiled.document.execution.nodes.map(node => {
      const previous = original.execution?.nodes.find(previous => previous.id === node.id);
      return { ...structuredClone(previous ?? node), ...node,
        ...(previous?.presentation || node.presentation ? { presentation: { ...structuredClone(previous?.presentation), ...node.presentation } } : {}) };
    }), links: structuredClone(compiled.document.execution.links) };
  else delete document.execution;
  const ids = new Set([...document.nodes, ...(document.execution?.nodes ?? [])].map(node => node.id));
  document.edges = document.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  pruneS2Groups(document); pruneS2CanvasComposites(document);
  const interaction = before.definition.interaction === undefined ? undefined : {
    ...structuredClone(before.definition.interaction), triggers: before.definition.interaction.triggers
      .filter(trigger => ids.has(trigger.on.nodeId)).map(trigger => ({ ...structuredClone(trigger),
        ...(trigger.scope?.nodeIds !== undefined ? { scope: { ...structuredClone(trigger.scope), nodeIds: trigger.scope.nodeIds.filter(id => ids.has(id)) } } : {}) })),
  };
  const definition = readS2Definition({ ...structuredClone(before.definition), blockTypes: compiled.definition.blockTypes,
    plugins: compiled.definition.plugins, initial: document,
    ...(interaction === undefined ? {} : { interaction }) });
  return { definition, document: readS2Document(document, definition) };
}
function applyEdits(pack: SceneInteractionPack, before: ScenePackConfig, actions: EditAction[], scope: S2InteractionScope,
  baseline: Pick<S2Document, 'nodes'>, firstIndex: number): ScenePackConfig {
  const canvas = projectS2PublicCanvas(pack, before.definition, before.document);
  actions.forEach((action, offset) => {
    const index = firstIndex + offset; permission(scope, 'edit', index);
    if (action.type === 'addNode') {
      if (scope.nodeIds !== undefined) fail('INTERACTION_SCOPE', index, '限定已有节点的任务不能新增节点');
      if (canvas.nodes.some(node => node.id === action.node.id)) fail('INTERACTION_TARGET', index, '新增节点标识重复');
      canvas.nodes.push(structuredClone(action.node));
    } else if (action.type === 'setValues') {
      target(scope, action.nodeId, canvas, index);
      const node = canvas.nodes.find(node => node.id === action.nodeId)!;
      node.values = { ...node.values, ...structuredClone(action.values) };
    } else if (action.type === 'removeNode') {
      target(scope, action.nodeId, canvas, index);
      canvas.nodes = canvas.nodes.filter(node => node.id !== action.nodeId);
      canvas.connections = canvas.connections.filter(connection => connection.source.nodeId !== action.nodeId && connection.target.nodeId !== action.nodeId);
    } else {
      target(scope, action.connection.source.nodeId, canvas, index); target(scope, action.connection.target.nodeId, canvas, index);
      const found = canvas.connections.findIndex(connection => equal(connection, action.connection));
      if (action.type === 'connect') canvas.connections.push(structuredClone(action.connection));
      else {
        if (found < 0) fail('INTERACTION_TARGET', index, '指定的公开连接不存在');
        canvas.connections.splice(found, 1);
      }
    }
  });
  const compiled = compileS2PublicCanvas(pack, canvas, { goal: before.definition.goal, instructions: before.definition.instructions });
  const next = preserveDocument(before, compiled);
  assertS2PublicEdit(pack, before, next, baseline);
  return next;
}
function validateRun(pack: SceneInteractionPack, current: ScenePackConfig, action: Extract<S2InteractionAction, { type: 'run' }>, scope: S2InteractionScope, index: number) {
  permission(scope, 'execute', index);
  const canvas = projectS2PublicCanvas(pack, current.definition, current.document);
  for (const id of action.targetNodeIds) {
    target(scope, id, canvas, index);
    if (!current.document.execution?.nodes.some(node => node.id === id)) fail('INTERACTION_TARGET', index, '运行目标必须是公开执行节点');
  }
  selectS2Execution(current.document, current.definition.plugins, action.targetNodeIds);
}

/** Pure preflight. Every edit segment and execution target is checked before any
 * callbacks can commit state or start work. Runtime ownership remains local. */
export function prepareS2InteractionActions(pack: SceneInteractionPack, before: ScenePackConfig, rawActions: unknown,
  rawScope: S2InteractionScope, readOnlyBaseline: Pick<S2Document, 'nodes'> = before.definition.initial): S2PreparedInteractionActions {
  if (!pack.authoring) fail('INTERACTION_PUBLIC_REQUIRED', 0, '当前包没有公开交互接口');
  const actions = readS2InteractionActions(rawActions);
  const forbidden = actions.findIndex(action => !scenePackAllowsExecution(pack) && ['run', 'cancel'].includes(action.type));
  if (forbidden >= 0) fail('PACK_EXECUTION_DISABLED', forbidden, '当前插件包仅编辑，不能追加运行或取消流程；编辑直接生效');
  const scope = readS2InteractionScope(rawScope), baseline = copy(readOnlyBaseline);
  let current = checkedConfig(pack, before, baseline);
  const visible = new Set(projectS2PublicCanvas(pack, current.definition, current.document).nodes.map(node => node.id));
  if (scope.nodeIds?.some(id => !visible.has(id))) fail('INTERACTION_SCOPE', 0, '范围包含未公开或不存在的节点');
  const steps: Step[] = [];
  for (let index = 0; index < actions.length;) {
    const action = actions[index], first = index;
    try {
      if (edited(action)) {
        const first = index, edits: EditAction[] = [];
        while (index < actions.length && edited(actions[index])) edits.push(actions[index++] as EditAction);
        current = applyEdits(pack, current, edits, scope, baseline, first);
        steps.push({ type: 'edit', indexes: edits.map((_, offset) => first + offset), actions: edits });
      } else if (action.type === 'run') {
        validateRun(pack, current, action, scope, index);
        steps.push({ type: 'run', indexes: [index++], action });
      } else if (action.type === 'cancel') {
        permission(scope, 'execute', index);
        steps.push({ type: 'cancel', indexes: [index++], action });
      }
    } catch (error) { throw diagnosis(error, first); }
  }
  const token = Object.freeze({ actionCount: actions.length, hasEdits: steps.some(step => step.type === 'edit'), hasExecution: steps.some(step => step.type !== 'edit') });
  plans.set(token, { pack, scope: copy(scope), baseline, steps });
  return token;
}

export interface S2InteractionActionServices {
  /** Terminal-owned request revision/epoch/abort check, never a model field. */
  guard(): void;
  readConfig(): ScenePackConfig;
  applyConfig(config: ScenePackConfig): void | Promise<void>;
  /** Settle after the real local job; do not return a speculative model result. */
  run(targetNodeIds: string[]): unknown | Promise<unknown>;
  /** Must verify the run belongs to this host and this request's public scope. */
  cancel(runId: string): unknown | Promise<unknown>;
}
export interface S2InteractionActionReport {
  status: 'completed' | 'failed' | 'cancelled';
  steps: Array<{ indexes: number[]; type: 'edit' | 'run' | 'cancel'; status: 'completed' | 'failed' | 'cancelled'; result?: unknown }>;
  failedAt?: number;
  error?: { code: string; path: string; reason: string };
}
function resultState(result: unknown): 'completed' | 'failed' | 'cancelled' {
  if (!result || typeof result !== 'object') return 'completed';
  const status = Object.getOwnPropertyDescriptor(result, 'status')?.value;
  if (status === 'cancelled') return 'cancelled';
  if (['failed', 'blocked', 'unknown', 'waiting', 'queued', 'running'].includes(status)) return 'failed';
  return 'completed';
}
/** Editing commits atomically within each continuous segment. Execution is a
 * side-effect boundary: earlier effects are reported, never rolled back/retried. */
export async function executeS2InteractionActions(prepared: S2PreparedInteractionActions,
  services: S2InteractionActionServices): Promise<S2InteractionActionReport> {
  const data = plans.get(prepared);
  if (!data) throw new S2InteractionActionError('INTERACTION_PLAN', '/actions', '需要由本地公开动作预检生成执行计划');
  plans.delete(prepared); // one-shot dispatch, independent of promise settlement
  const report: S2InteractionActionReport = { status: 'completed', steps: [] };
  for (const step of data.steps) {
    const index = step.indexes[0];
    try {
      services.guard();
      const current = checkedConfig(data.pack, services.readConfig(), data.baseline);
      if (step.type === 'edit') {
        const next = applyEdits(data.pack, current, step.actions, data.scope, data.baseline, index);
        services.guard(); await services.applyConfig(next);
        report.steps.push({ indexes: [...step.indexes], type: step.type, status: 'completed' });
      } else {
        if (step.type === 'run') validateRun(data.pack, current, step.action, data.scope, index);
        else permission(data.scope, 'execute', index);
        services.guard();
        const result = step.type === 'run' ? await services.run([...step.action.targetNodeIds]) : await services.cancel(step.action.runId);
        const status = resultState(result);
        report.steps.push({ indexes: [...step.indexes], type: step.type, status, ...(result === undefined ? {} : { result }) });
        if (status !== 'completed') {
          report.status = status; report.failedAt = index;
          report.error = { code: status === 'cancelled' ? 'INTERACTION_CANCELLED' : 'INTERACTION_RUN_FAILED', path: `/actions/${index}`,
            reason: status === 'cancelled' ? '本次运行已取消，后续操作已停止' : '本次运行未成功完成，后续操作已停止' };
          return report;
        }
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError' || error instanceof Error && error.name === 'AbortError';
      const issue = cancelled ? new S2InteractionActionError('INTERACTION_CANCELLED', `/actions/${index}`, '本次交互已取消，后续操作已停止') : diagnosis(error, index);
      report.status = cancelled ? 'cancelled' : 'failed'; report.failedAt = index;
      report.error = { code: issue.code, path: issue.path, reason: issue.reason };
      report.steps.push({ indexes: [...step.indexes], type: step.type, status: report.status });
      return report;
    }
  }
  return report;
}
