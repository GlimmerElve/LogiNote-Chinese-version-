import type { MetricSpec, SceneSpec, SceneRunState } from '../../types';
import { HELP_RATIO, INDEPENDENCE_PENALTY_PER_HELP } from '../../types/sceneS4';
import type { DerivationCanvasState, DerivationNodeType } from '../../types/sceneS4';
import { preservesSystemGivens, sameData } from '../../modules/derivationCanvas/utils/givenIntegrity';
import { collectDescendants } from '../../modules/derivationCanvas/utils/branchGraph';
import { wouldCreateCycle } from '../../modules/derivationCanvas/utils/cycle';

const nodeCapabilities = {
  given: 'given-node', formula: 'formula-node', conclusion: 'conclusion-node', assumption: 'assumption-node',
} as const;

/** S4 reuses the stored maxTurns field, but its unit is accepted node submissions, not dialogue. */
export function s4SubmissionLimit(spec: SceneSpec): number {
  const value = spec.completion?.maxTurns;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 12;
}

/** Only explicit user consent unlocks reference content, never an automatic terminal status. */
export function isS4ReferenceUnlocked(run: SceneRunState): boolean {
  return run.status !== 'running' && (run.endedByUser === true || run.s4ReferenceUnlocked === true);
}

export function unlockS4ReferenceAnswer(spec: SceneSpec, run: SceneRunState): SceneRunState {
  if (spec.meta.sceneSkill !== 'S4' || spec.sceneId !== run.sceneId || run.status === 'running'
    || isS4ReferenceUnlocked(run) || (!spec.compute?.expected_formula && !spec.compute?.expected_steps?.length)) return run;
  return { ...run, s4ReferenceUnlocked: true };
}

/** Absent lists are legacy permissions; an explicit list is the upper bound, never a suggestion. */
export function s4AllowedNodeTypes(spec: SceneSpec): DerivationNodeType[] {
  return (Object.keys(nodeCapabilities) as DerivationNodeType[]).filter(type =>
    spec.meta.sceneSkill === 'S4'
    && (spec.capabilityIds === undefined || spec.capabilityIds.includes(nodeCapabilities[type])));
}

/** Preserve historical nodes for viewing/deletion, but forbid creating, retyping or editing disabled types.
 * Existing links can be removed; new links cannot activate a disabled historical premise.
 */
export function isS4CanvasChangeAuthorized(
  previous: DerivationCanvasState, next: DerivationCanvasState, allowed: readonly DerivationNodeType[],
): boolean {
  if (!preservesSystemGivens(previous, next)) return false;
  const oldNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const newNodes = new Map(next.nodes.map(node => [node.id, node]));
  const invalidationRoots = new Set<string>();
  for (const old of previous.nodes) {
    const current = newNodes.get(old.id);
    if (!current || (allowed.includes(old.type) && old.type === current.type && old.data.latex !== current.data.latex)) invalidationRoots.add(old.id);
  }
  const sameEdge = (a: typeof previous.edges[number], b: typeof previous.edges[number]) =>
    a.id === b.id && a.source === b.source && a.target === b.target && a.type === b.type;
  for (const edge of previous.edges) if (!next.edges.some(item => sameEdge(edge,item))) invalidationRoots.add(edge.target);
  for (const edge of next.edges) if (!previous.edges.some(item => sameEdge(edge,item))) invalidationRoots.add(edge.target);
  const invalidated = new Set(invalidationRoots);
  for (const id of invalidationRoots) for (const canvas of [previous,next]) {
    for (const child of collectDescendants(id,canvas.edges)) invalidated.add(child);
  }
  for (const node of next.nodes) {
    const old = oldNodes.get(node.id);
    if (allowed.includes(node.type) && (!old || allowed.includes(old.type))) continue;
    if (!old || old.type !== node.type) return false;
    if (sameData(old.data,node.data)) continue;
    // System invalidation may only REMOVE proof/lock state downstream of a changed input.
    if (!invalidated.has(node.id) || !sameData(node.data,{...old.data,status:'draft',verification:undefined,frozen:false})) return false;
  }
  const nodes = new Map(next.nodes.map(node => [node.id, node]));
  return next.edges.every(edge => {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target) return false;
    if (previous.edges.some(old => sameEdge(old,edge))) return true;
    return allowed.includes(source.type) && allowed.includes(target.type)
      && source.type !== 'conclusion' && target.type !== 'given'
      && !wouldCreateCycle(edge.source,edge.target,next.edges.filter(item => item !== edge));
  });
}

/** Check the entire incoming branch before any parsing, model request or engine execution. */
export function s4NodeAuthorizationError(spec: SceneSpec, canvas: DerivationCanvasState | undefined, nodeId: string): string | undefined {
  const allowed = s4AllowedNodeTypes(spec);
  const nodes = new Map((canvas?.nodes ?? []).map(node => [node.id, node]));
  const pending = [nodeId], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node && !allowed.includes(node.type)) return '本场景未启用该节点组件，不能编辑、提交或将其用作前提；可删除历史节点后继续。';
    for (const edge of canvas?.edges ?? []) if (edge.target === id) pending.push(edge.source);
  }
  return undefined;
}

type Binding = NonNullable<MetricSpec['s4Binding']>;
const bindings: Record<Binding, { source: 'engine' | 'rule'; types: MetricSpec['type'][] }> = {
  'formula-correctness': { source: 'engine', types: ['boolean'] },
  'numerical-error': { source: 'engine', types: ['continuous'] },
  'dimension-check': { source: 'engine', types: ['boolean'] },
  'boundary-count': { source: 'engine', types: ['count'] },
  'independence-score': { source: 'rule', types: ['continuous'] },
  'help-used': { source: 'rule', types: ['count'] },
};

/** 仅旧数据兼容使用名称推断。显式但错误的绑定不得降级绕过校验。 */
export function resolveS4MetricBinding(metric: MetricSpec): Binding | undefined {
  let binding = metric.s4Binding;
  if (binding === undefined) {
    const key = `${metric.id} ${metric.name}`.toLowerCase();
    if (metric.source === 'engine') {
      if (/numer|误差|error|precision/.test(key)) binding = 'numerical-error';
      else if (/dimension|量纲|unit|单位/.test(key)) binding = 'dimension-check';
      else if (/boundary|边界/.test(key)) binding = 'boundary-count';
      else if (/correct|正确|等价|right|proof_validity|推导合法/.test(key)) binding = 'formula-correctness';
    } else if (metric.source === 'rule') {
      if (/independen|独立/.test(key)) binding = 'independence-score';
      else if (/help|求助/.test(key)) binding = 'help-used';
    }
  }
  if (!binding || !Object.prototype.hasOwnProperty.call(bindings, binding)) return undefined;
  const definition = bindings[binding];
  return definition.source === metric.source && definition.types.includes(metric.type) ? binding : undefined;
}

/** 未声明能力列表的历史 S4 保留原有求助；显式列表是权限上限，不能被 help 配置扩大。 */
export function isS4HelpAuthorized(spec: SceneSpec): boolean {
  return spec.meta.sceneSkill === 'S4'
    && (spec.capabilityIds === undefined || spec.capabilityIds.includes('compute-help'));
}

/** One rate for preview, real/demo deductions and final score; zero is an intentional setting. */
export function s4HelpPenalty(spec: { help?: { penalty_per_help?: number } } = {}): number {
  const value = spec.help?.penalty_per_help;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(1, value) : INDEPENDENCE_PENALTY_PER_HELP;
}

/** 同一口径用于预览、保存、初始化及每次调用；显式零预算必须保留。 */
export function s4HelpLimit(spec: SceneSpec): number {
  if (!isS4HelpAuthorized(spec) || !spec.compute) return 0;
  const nonnegative = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
  const steps = nonnegative(spec.compute.expected_steps_count, spec.compute.expected_steps?.length ?? 10);
  const help = spec.help;
  const formula = Math.max(1, Math.ceil(steps * HELP_RATIO
    * nonnegative(help?.difficulty_factor, 1) * nonnegative(help?.user_factor, 1)));
  if (!Number.isFinite(formula)) return 0;
  return Math.floor(Math.min(formula,
    nonnegative(help?.base_help_count, formula), nonnegative(help?.max_help_count, formula)));
}
