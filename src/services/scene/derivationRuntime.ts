/**
 * S4 推导场景运行态（纯函数，零 LLM 依赖）
 *
 * 职责与 sceneRuntime.ts 一致：只做纯状态变换。
 * 本模块是 S4 的「系统侧裁判」，对应《场景设计原则》原则 10「LLM 生成、系统执行」
 * 与原则 11「指标可衡量」。
 */

import type { SceneSpec, SceneRunState, MetricSpec, MetricValue } from '../../types';
import {
  INDEPENDENCE_BONUS_FACTOR,
} from '../../types/sceneS4';
import type {
  DerivationCanvasState,
  DerivationEvent,
  DerivationNode,
  DerivationNodeStatus,
  NodeVerification,
} from '../../types/sceneS4';
import { emptyCanvasState } from '../../modules/derivationCanvas/derivationStore';
import { resolveS4MetricBinding, s4HelpLimit, s4HelpPenalty, s4SubmissionLimit } from './sceneS4Policy';
import { createS4ProofEvidence } from './sceneS4Evidence';
import { isS4GoalAchieved, pendingS4GoalNodes } from './sceneS4Goal';

/* ==================== 一、画布初始化 ==================== */

const GIVEN_START_X = 40;
const GIVEN_START_Y = 40;
const GIVEN_GAP_Y = 132;

/**
 * 求助能力、公式预算和显式上限的统一口径；未授权或显式零预算时为零。
 */
export function computeMaxHelp(spec: SceneSpec): number {
  return s4HelpLimit(spec);
}

/**
 * ComputeSpec.given → 已知条件节点（只读，铺入左侧一列）。
 *
 * **前提链架构的三态分支**（对应 `GivenItem.entries` 语义）：
 * - entries 非空   → 前提包：逐条目作为数学式子渲染，note 显示框外解释，
 *                    entries 随节点下传，供 `collectBranchPremises` 逐条展开
 * - entries 空数组 → 解构失败降级：该节点**不可被引用**，unitHint 明确标注，
 *                    避免用户在不知情的情况下连了一条永远无效的线
 * - entries 缺省   → 旧场景兼容：display 放进 note 位置（原行为，逐字节一致）
 *
 * 为什么必须区分「空数组」与「缺省」（关键）：
 *   前者是「LLM 尝试解构但失败」，后者是「旧格式数据」。
 *   若把空数组也回退 display 兜底，一条含分号的多条目式子会被当成**单条**
 *   喂给引擎 → 必然解析失败，且用户看到的是一个「正常显示」的节点，
 *   完全无从知道它其实不可用。
 */
function buildGivenNodes(spec: SceneSpec): DerivationNode[] {
  const given = spec.compute?.given ?? [];
  return given.map((g, i) => {
    const base = {
      id: `dgiven-${i + 1}`,
      type: 'given' as const,
      position: { x: GIVEN_START_X, y: GIVEN_START_Y + i * GIVEN_GAP_Y },
    };

    if (Array.isArray(g.entries)) {
      if (g.entries.length === 0) {
        // 解构失败降级：不可引用，UI 显式标注
        return {
          ...base,
          data: {
            label: `已知 ${g.name}`,
            note: g.note || g.display || g.name,
            status: 'frozen' as DerivationNodeStatus,
            frozen: true,
            unitHint: '此前提无法被引擎识别',
            entries: [],
          },
        };
      }
      return {
        ...base,
        data: {
          label: `已知 ${g.name}`,
          /**
           * 逐条目数学式子（MathLive 渲染）。
           * 用 LaTeX 的换行符分隔，使多条前提在节点内各占一行 ——
           * 用 '\n' 无效（KaTeX 不识别换行）。
           */
          latex: g.entries.map((e) => e.display).join(' \\\\ '),
          // 框外解释：优先用 LLM 写的 note（与 display 严格分离）
          note: g.note || '',
          status: 'frozen' as DerivationNodeStatus,
          frozen: true,
          unitHint: g.unit,
          // 前提条目下传：premiseChain 据此逐条展开为 facts / domains
          entries: g.entries,
        },
      };
    }

    // entries 缺省 → 旧场景兼容路径（行为与改造前一致）
    return {
      ...base,
      data: {
        label: `已知 ${g.name}`,
        note: g.display || g.name,
        status: 'frozen' as DerivationNodeStatus,
        frozen: true,
        unitHint: g.unit,
      },
    };
  });
}

/** 初始化画布运行态 */
export function initCanvasState(spec: SceneSpec): DerivationCanvasState {
  const base = emptyCanvasState();
  return {
    ...base,
    nodes: buildGivenNodes(spec),
    maxHelp: computeMaxHelp(spec),
    independenceScore: 1,
  };
}

/* ==================== 二、求助惩罚与最终得分 ==================== */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Successful help consumes one quota and the scene-configured independence penalty. */
export function applyHelpPenalty(canvas: DerivationCanvasState, spec?: Pick<SceneSpec, 'help'>): DerivationCanvasState {
  return {
    ...canvas,
    helpUsed: canvas.helpUsed + 1,
    independenceScore: clamp01(Number((canvas.independenceScore - s4HelpPenalty(spec)).toFixed(10))),
  };
}

/** S4 本地达标口径；误差绑定是上限，其他数值指标沿用下限。 */
function isMetricSatisfied(def: MetricSpec, value: MetricValue['value']): boolean {
  if (def.type === 'boolean') return value === def.target;
  if (typeof value === 'number' && typeof def.target === 'number') {
    if (resolveS4MetricBinding(def) === 'numerical-error') return value <= def.target;
    return value >= def.target;
  }
  return String(value) === String(def.target);
}

/**
 * 最终得分（第八章 6.7 唯一口径）。不参与成败判定，仅用于评估展示。
 * final = base × (1 − used_help × penalty) + independence × 0.1
 */
export function computeFinalScore(spec: SceneSpec, run: SceneRunState): number {
  const current = refreshS4EngineMetrics(spec, run);
  const total = spec.metrics.length;
  const metCount = current.metrics.reduce((acc, v) => {
    const def = spec.metrics.find((m) => m.id === v.metricId);
    if (!def) return acc;
    return acc + (isMetricSatisfied(def, v.value) ? 1 : 0);
  }, 0);

  const baseScore = total === 0 ? 1 : metCount / total;
  const canvas = run.canvas;
  const usedHelp = canvas?.helpUsed ?? 0;
  const penalty = s4HelpPenalty(spec);
  const independence = canvas?.independenceScore ?? 1;

  const finalScore = baseScore * (1 - usedHelp * penalty) + independence * INDEPENDENCE_BONUS_FACTOR;
  return Math.max(0, Number(finalScore.toFixed(4)));
}

/* ==================== 三、事件流与节点结果 ==================== */

/** 追加一条事件（不可变） */
export function appendDerivationEvent(run: SceneRunState, ev: DerivationEvent): SceneRunState {
  return { ...run, derivationEvents: [...(run.derivationEvents ?? []), ev] };
}

/** 构造带时间戳的事件 */
export function makeDerivationEvent<T extends DerivationEvent['type']>(
  type: T,
  payload: Omit<Extract<DerivationEvent, { type: T }>, 'type' | 'at'>,
): DerivationEvent {
  return { ...(payload as object), type, at: new Date().toISOString() } as DerivationEvent;
}

/** 更新节点状态与验证结果（不可变） */
export function updateNodeResult(
  run: SceneRunState,
  nodeId: string,
  status: DerivationNodeStatus,
  verification?: NodeVerification,
): SceneRunState {
  const canvas = run.canvas;
  if (!canvas) return run;
  const nodes = canvas.nodes.map((n) =>
    n.id === nodeId
      ? { ...n, data: { ...n.data, status, verification: verification ?? n.data.verification } }
      : n,
  );
  return { ...run, canvas: { ...canvas, nodes } };
}

/** 直写指标值（engine/rule 指标由系统写入） */
export function setMetricValue(
  run: SceneRunState,
  metricId: string,
  value: MetricValue['value'],
  reason?: string,
): SceneRunState {
  const exists = run.metrics.some((m) => m.metricId === metricId);
  const metrics = exists
    ? run.metrics.map((m) =>
        m.metricId === metricId ? { ...m, value, lastReason: reason ?? m.lastReason } : m,
      )
    : [...run.metrics, { metricId, value, lastReason: reason }];
  return { ...run, metrics };
}

/** Rebuild correctness from live engine-backed proof branches, never a deleted/edited last response.
 * A separate bad branch does not invalidate a still-valid branch. System givens and consistent
 * assumptions are premises, not evidence that a user formula has been proved.
 */
/** Metrics and completion deliberately share the same live, authorized proof evidence. */
export function refreshS4EngineMetrics(spec: SceneSpec, run: SceneRunState): SceneRunState {
  if (spec.meta.sceneSkill !== 'S4') return run;
  const definitions = spec.metrics.filter(metric => metric.source === 'engine' && resolveS4MetricBinding(metric) === 'formula-correctness');
  if (!definitions.length) return run;
  const value = createS4ProofEvidence(spec, run.canvas).hasFormula;
  let next = run;
  for (const metric of definitions) if (next.metrics.find(item => item.metricId === metric.id)?.value !== value) {
    next = setMetricValue(next, metric.id, value, value
      ? '当前画布仍有有效的引擎验证支路' : '当前画布暂无有效的引擎验证证据，请重新提交验证');
  }
  return next;
}

// 轮次 N 删除 `markStepIndex`：达成度标记依赖「参考解比对」，
// 而该链路已随「取消参考链判定」整体移除（用户明确要求不再判定达成度）。
// `DerivationCanvasState.matchedStepIndexes` 字段同步删除。

/* ==================== 四、边界条件解析（第八章 6.5） ==================== */

const BOUNDARY_RE = /^\s*([A-Za-z_]\w*)\s*->\s*(.+?)\s*$/;

/** SymPy 内置名放行（非用户声明符号） */
const BUILTIN_SYMBOLS = new Set([
  'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'pi', 'E', 'oo', 'Abs', 'Rational', 'Pow', 'Integer',
]);

/**
 * 解析边界条件 `var->target`。
 * target 中出现的符号若未声明，则 valid=false（不参与 coverage 判定）。
 */
export function parseBoundaryCondition(
  raw: string,
  symbolNames: Set<string>,
): { var: string; target: string; valid: boolean } | null {
  if (typeof raw !== 'string') return null;
  const m = BOUNDARY_RE.exec(raw);
  if (!m) return null;

  const varName = m[1];
  const target = m[2];

  const idsInTarget = target.match(/[A-Za-z_]\w*/g) ?? [];
  const valid = [varName, ...idsInTarget].every(
    (id) => symbolNames.has(id) || BUILTIN_SYMBOLS.has(id) || /^\d+$/.test(id),
  );

  return { var: varName, target, valid };
}

/** 批量解析边界条件，过滤格式非法项 */
export function parseBoundaryConditions(
  spec: SceneSpec,
): Array<{ raw: string; parsed: { var: string; target: string; valid: boolean } }> {
  const list = spec.compute?.boundary_conditions ?? [];
  const symbolNames = new Set((spec.compute?.symbols ?? []).map((s) => s.name));
  const out: Array<{ raw: string; parsed: { var: string; target: string; valid: boolean } }> = [];
  for (const raw of list) {
    const parsed = parseBoundaryCondition(raw, symbolNames);
    if (parsed) out.push({ raw, parsed });
  }
  return out;
}

/* ==================== 五、成败判定 ==================== */

/** Events recover historical S4 counts; the mirror count is monotonic across canvas undo/redo. */
export function s4SubmissionCount(run: SceneRunState): number {
  const recorded = (run.derivationEvents ?? []).filter(event => event.type === 'node_submit').length;
  const mirror = typeof run.turnCount === 'number' && Number.isFinite(run.turnCount) ? Math.max(0, Math.floor(run.turnCount)) : 0;
  return Math.max(recorded, mirror);
}

/**
 * S4 成败判定。
 * 成功需同时满足：engine/rule 指标全部达标 + 至少一条完整且已验证的结论支路。
 * 其他互不相连支路上的草稿或错误不阻断已完成的正确支路。
 */
export function checkS4Completion(
  spec: SceneSpec,
  run: SceneRunState,
): { status: 'running' | 'success' | 'failure'; reason?: string } {
  if (run.status !== 'running') {
    return {
      status: run.status === 'success' ? 'success' : 'failure',
      reason: run.endReason,
    };
  }

  const canvas = run.canvas;
  if (!canvas) return { status: 'running' };

  const current = refreshS4EngineMetrics(spec, run);
  const strictMetrics = spec.metrics.filter((m) => m.source === 'engine' || m.source === 'rule');
  const allStrictMet = strictMetrics.every((def) => {
    const cur = current.metrics.find((v) => v.metricId === def.id);
    return cur ? isMetricSatisfied(def, cur.value) : false;
  });

  const hasPassConclusion = createS4ProofEvidence(spec, run.canvas).conclusions
    .some(node => isS4GoalAchieved(spec, run, node.id));

  if (allStrictMet && hasPassConclusion) {
    return { status: 'success', reason: '结论支路已通过引擎验证、覆盖题目目标且全部指标达标' };
  }

  const maxSubmissions = s4SubmissionLimit(spec);
  if (s4SubmissionCount(run) >= maxSubmissions) {
    if (allStrictMet && pendingS4GoalNodes(spec,run).length) return {
      status:'running',reason:'数学验证已通过，题目目标暂未确认；可单独重试目标检查或主动结束。',
    };
    return { status: 'failure', reason: `已达节点验证提交上限（${maxSubmissions} 次），推导未完成` };
  }

  return { status: 'running' };
}

/** 应用 S4 结束语义（供 SceneMode.handleEnd 调用） */
export function applyS4Completion(
  spec: SceneSpec,
  run: SceneRunState,
  opts: { userIntentEnd?: boolean; signalReason?: string } = {},
): SceneRunState {
  run = refreshS4EngineMetrics(spec, run);
  const verdict = checkS4Completion(spec, run);

  if (opts.userIntentEnd) {
    return {
      ...run,
      status: verdict.status === 'success' ? 'success' : 'failure',
      turnCount: s4SubmissionCount(run),
      endReason: opts.signalReason || '用户结束了本次推导',
      endedAt: new Date().toISOString(),
      finalScore: computeFinalScore(spec, run),
      /**
       * 标记「用户主动结束」（用户明确口径）。
       *
       * 主动结束可解锁参考解；自动结束不放答案，需随后单独主动查看。
       * 后者使用 s4ReferenceUnlocked，不改写本字段所记录的结束来源。
       */
      endedByUser: true,
    };
  }

  if (verdict.status === 'running') return run;

  return {
    ...run,
    status: verdict.status,
    turnCount: s4SubmissionCount(run),
    endReason: verdict.reason,
    endedAt: new Date().toISOString(),
    finalScore: computeFinalScore(spec, run),
    /** 系统自动判定完成：**不**置 `endedByUser`，故参考答案仍保持隐藏。 */
    endedByUser: false,
  };
}

/* ==================== 六、S4 指标更新（D7 决策的落点） ==================== */

/**
 * 把原始值强制转换为指标定义的合法取值（边界⑬⑮）。
 * - boolean：真值化
 * - continuous：clamp 到 range
 * - count/time：非负；count 取整
 * - discrete：不在 options 内则回退到 target
 */
function coerceMetricValue(def: MetricSpec, raw: unknown): MetricValue['value'] {
  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    return String(raw) === 'true';
  }

  if (def.type === 'continuous' || def.type === 'count' || def.type === 'time') {
    let n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) n = 0;
    if (def.type === 'continuous' && def.range) {
      n = Math.min(def.range[1], Math.max(def.range[0], n));
    }
    if (def.type === 'count') n = Math.max(0, Math.round(n));
    if (def.type === 'time') n = Math.max(0, n);
    return n;
  }

  if (def.type === 'discrete') {
    const s = String(raw);
    if (def.options?.length && !def.options.includes(s)) {
      return typeof def.target === 'string' ? def.target : (def.options[0] ?? s);
    }
    return s;
  }

  return String(raw);
}

/**
 * 从节点验证结果派生 engine 指标的原始值。
 *
 * 新指标使用稳定绑定；旧指标仅通过集中维护的兼容映射解析。
 */
export function deriveEngineMetricRaw(def: MetricSpec, v: NodeVerification): unknown {
  const binding = resolveS4MetricBinding(def);
  if (binding === 'formula-correctness') return v.formula_correct;
  if (binding === 'numerical-error') return v.numerical_error;
  if (binding === 'dimension-check') return v.dimension_check;
  if (binding === 'boundary-count') return v.boundary_coverage?.length ?? 0;
  return undefined;
}

/** Help changes rule metrics immediately, without inventing a new engine verdict. */
export function updateS4RuleMetrics(spec: SceneSpec, run: SceneRunState): SceneRunState {
  let next = run;
  for (const def of spec.metrics) {
    if (def.source !== 'rule') continue;
    const binding = resolveS4MetricBinding(def);
    if (binding === 'independence-score') next = setMetricValue(next, def.id, next.canvas?.independenceScore ?? 1, '独立性规则计算');
    if (binding === 'help-used') next = setMetricValue(next, def.id, next.canvas?.helpUsed ?? 0, '求助次数规则计算');
  }
  return next;
}

/**
 * S4 指标更新（**D7 决策的落点**：独立于 `metricEngine.updateMetrics`）。
 *
 * 三类指标分流，对应《场景设计原则》原则 10「LLM 生成、系统执行」与原则 11「指标可衡量」：
 * - `engine`：由 `NodeVerification` 派生（SymPy 计算结果），**系统直写，不问 LLM**
 * - `rule`  ：由运行态派生（`independence_score` 读 canvas），**系统直写**
 * - `llm`   ：由调用方从 analyze 的 LLM 返回中传入（`llmUpdates`）
 *
 * **S1 场景不会调用本函数**，`metricEngine.ts` 完全不受影响（隔离点 I4′）。
 *
 * @param verification 本节点的 SymPy 判定结果
 * @param llmUpdates    analyze LLM 给出的 llm 类指标更新（可选）
 */
export function updateS4Metrics(
  spec: SceneSpec,
  run: SceneRunState,
  verification: NodeVerification,
  llmUpdates?: Array<{ metricId: string; value: MetricValue['value']; reason?: string }>,
): SceneRunState {
  const llmMap = new Map((llmUpdates ?? []).map((u) => [u.metricId, u]));
  let next = updateS4RuleMetrics(spec, run);

  for (const def of spec.metrics) {
    const source = def.source ?? 'llm';

    if (source === 'engine') {
      const raw = deriveEngineMetricRaw(def, verification);
      if (raw === undefined) continue;
      next = setMetricValue(next, def.id, coerceMetricValue(def, raw), '计算引擎判定');
      continue;
    }

    if (source === 'rule') {
      continue;
    }

    // llm 指标：仅当调用方提供更新时才写入（未提供则保持原值）
    const upd = llmMap.get(def.id);
    if (upd) {
      next = setMetricValue(next, def.id, coerceMetricValue(def, upd.value), upd.reason);
    }
  }

  return refreshS4EngineMetrics(spec, next);
}
