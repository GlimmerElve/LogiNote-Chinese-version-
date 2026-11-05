/**
 * 场景运行态管理（一局）。
 *
 * 职责边界：
 * - 本模块只做纯状态变换（不调 LLM、不读写磁盘），便于测试与复用；
 * - 指标的实际数值由 metricEngine 依 LLM 判定产出，本模块只负责装载/合并。
 *
 * 结束优先级（checkCompletion）：用户意图 > 指标判定 > 最大回合耗尽。
 */

import {
  SceneSpec,
  SceneRunState,
  SceneMessage,
  SceneEvent,
  SceneRunOverrides,
  MetricValue,
  MetricDelta,
} from '../../types';
import { clampMetricValue, defaultMetricValue, isMetricMet } from './sceneMetricValue';
import { initCanvasState, refreshS4EngineMetrics, updateS4RuleMetrics } from './derivationRuntime';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from './sceneRuntimeContract';

// defaultMetricValue 的实现已迁至 sceneMetricValue.ts（纯语义模块，零 LLM 依赖）。
// 此处 re-export 保持对外 API 不变。
export { defaultMetricValue } from './sceneMetricValue';

/** 生成运行 id */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成消息 id */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 应用 overrides 到指标值：仅覆盖已存在的 metricId，未知 id 忽略（边界⑰） */
function applyMetricOverrides(
  values: MetricValue[],
  spec: SceneSpec,
  overrides?: SceneRunOverrides,
): MetricValue[] {
  if (!overrides?.metrics) return values;
  const defined = new Set(spec.metrics.map((m) => m.id));
  return values.map((v) => {
    if (!defined.has(v.metricId)) return v;
    const ov = overrides.metrics?.[v.metricId];
    if (!ov) return v;
    return { ...v, value: ov.initial !== undefined ? ov.initial : v.value };
  });
}

/**
 * 创建一局运行态。
 * overrides 同时作用于角色定义之外的指标初值（反事实重跑）；角色覆盖由调用方传 spec 时体现。
 */
export function createRunState(spec: SceneSpec, overrides?: SceneRunOverrides): SceneRunState {
  // 初值同样过一遍 clampMetricValue（边界⑬）：手工填写或 LLM 生成的 initial
  // 可能越出 range 或不在 options 内，开局即应落在合法取值上。
  const initialMetrics: MetricValue[] = spec.metrics.map((m) => ({
    metricId: m.id,
    value: clampMetricValue(m, defaultMetricValue(m)),
  }));

  // ===== S4 专属：仅当 spec.compute 存在时初始化推导画布（隔离点 I7）=====
  // S1 场景 spec.compute 为 undefined，canvas 保持 undefined，下方 return 走原路径，
  // checkCompletion 等既有逻辑完全不受影响。
  const canvas = spec.compute ? initCanvasState(spec) : undefined;

  const run: SceneRunState = {
    runId: generateRunId(),
    sceneId: spec.sceneId,
    sceneName: spec.meta?.name || '未命名场景',
    metrics: spec.meta.sceneSkill === 'S4' || isScenePromptModuleEnabled(spec, 'metric-state')
      ? applyMetricOverrides(initialMetrics, spec, overrides) : [],
    // 开场旁白作为首条 system 消息入列，保证角色首轮发言有上下文
    messages: spec.openingNarrative && (spec.meta.sceneSkill === 'S4' || isScenePromptModuleEnabled(spec, 'scenario-framing'))
      ? [
          {
            id: generateMessageId(),
            speakerType: 'system',
            speakerName: '旁白',
            content: spec.openingNarrative,
            timestamp: new Date().toISOString(),
          },
        ]
      : [],
    turnCount: 0,
    // 深拷贝事件，避免运行态修改污染 SceneSpec 中的预设
    events: (spec.meta.sceneSkill === 'S4' || isScenePromptModuleEnabled(spec, 'event-system') ? spec.events || [] : [])
      .map((e) => ({ ...e, trigger: { ...e.trigger }, fired: false })),
    status: 'running',
    startedAt: new Date().toISOString(),
    overrides,
    // S4 专属字段（S1 场景下均为 undefined）
    canvas,
    derivationEvents: canvas ? [] : undefined,
  };
  // A new S4 run has no verified proof or consumed help, even if a saved initial/override says otherwise.
  return spec.meta.sceneSkill === 'S4' ? refreshS4EngineMetrics(spec, updateS4RuleMetrics(spec, run)) : run;
}

/** 追加一条消息（不改动原对象） */
export function appendMessage(run: SceneRunState, msg: SceneMessage): SceneRunState {
  return { ...run, messages: [...run.messages, msg] };
}

/** 批量追加消息（如一次回复拆出的多条 action） */
export function appendMessages(run: SceneRunState, msgs: SceneMessage[]): SceneRunState {
  if (msgs.length === 0) return run;
  return { ...run, messages: [...run.messages, ...msgs] };
}

/** 合并指标结果：以 LLM 返回的值为准，未在返回中出现的指标保持原值 */
export function updateRunMetrics(
  run: SceneRunState,
  metrics: MetricValue[],
  deltas?: MetricDelta[],
): SceneRunState {
  const byId = new Map(metrics.map((m) => [m.metricId, m]));
  const merged = run.metrics.map((cur) => {
    const next = byId.get(cur.metricId);
    if (!next) return cur;
    const delta = deltas?.find((d) => d.metricId === cur.metricId);
    return {
      ...cur,
      value: next.value,
      lastDelta: delta?.delta ?? next.lastDelta ?? cur.lastDelta,
      lastReason: delta?.reason ?? next.lastReason ?? cur.lastReason,
    };
  });
  return { ...run, metrics: merged };
}

/** 回合数 +1 */
export function incrementTurn(run: SceneRunState): SceneRunState {
  return { ...run, turnCount: run.turnCount + 1 };
}

/**
 * 检查并触发突发事件，返回「本轮新触发」的事件列表。
 * - turn 型：本模块按回合数自行判定
 * - condition 型：由每轮 metricEngine 的 LLM 调用带回 id（llmTriggeredIds）
 *
 * 已 fired 的事件不会重复触发；返回的 run 中已同步 fired 标记。
 */
export function checkEventTriggers(
  run: SceneRunState,
  llmTriggeredIds?: string[],
): { run: SceneRunState; fired: SceneEvent[] } {
  const llmSet = new Set(llmTriggeredIds || []);
  const fired: SceneEvent[] = [];

  const events = run.events.map((e) => {
    if (e.fired) return e;
    const byTurn = e.trigger.type === 'turn' && typeof e.trigger.turn === 'number' && run.turnCount >= e.trigger.turn;
    const byCondition = e.trigger.type === 'condition' && llmSet.has(e.id);
    if (!byTurn && !byCondition) return e;
    const next = { ...e, fired: true };
    fired.push(next);
    return next;
  });

  if (fired.length === 0) return { run, fired };
  return { run: { ...run, events }, fired };
}

/**
 * 判定本局是否结束。
 * 优先级：用户明确结束意图 > 指标/信号判定结果 > 最大回合耗尽（边界⑨⑩）。
 *
 * @param userIntentEnd 用户是否明确表达了结束意图
 * @param metricStatus  指标更新的判定结果（'ongoing' 表示未结束）
 * @param signalReason  角色输出的结束信号原因（mode='signal' 场景）
 */
export function checkCompletion(
  spec: SceneSpec,
  run: SceneRunState,
  opts?: {
    userIntentEnd?: boolean;
    metricStatus?: 'ongoing' | 'success' | 'failure';
    signalReason?: string;
  },
): SceneRunState {
  if (run.status !== 'running') return run;

  const finish = (status: 'success' | 'failure', reason: string): SceneRunState => ({
    ...run,
    status,
    endReason: reason,
    endedAt: new Date().toISOString(),
    completionOutcome: status === 'success' ? 'completed' : 'failed',
  });

  // 运行态「全部指标达标」判定（无指标视为达标）。
  // 口径复用 sceneMetricValue.isMetricMet，与 metricEngine 保持单一实现。
  const allMetricsMet = (): boolean =>
    spec.metrics.length === 0 ||
    run.metrics.every((v) => {
      const def = spec.metrics.find((m) => m.id === v.metricId);
      return def ? isMetricMet(def, v.value) : false;
    });

  // 优先级 1：用户主动结束
  if (opts?.userIntentEnd) {
    // 用户主动收场时，按当前指标是否达标给出成败（无指标则记成功）
    return { ...finish(allMetricsMet() ? 'success' : 'failure', opts.signalReason || '用户结束了会话'), completionOutcome: 'stopped' };
  }

  const contract = resolveSceneRuntimeContract(spec);
  if (contract.completion === 'objective' && opts?.signalReason && spec.completion.mode === 'signal') {
    return finish('success', opts.signalReason);
  }

  // 优先级 2：指标/信号判定
  if (contract.completion === 'objective' && opts?.metricStatus === 'success') return finish('success', opts.signalReason || '达成成功条件');
  if (contract.completion === 'objective' && opts?.metricStatus === 'failure') return finish('failure', opts.signalReason || '触发失败条件');

  // 优先级 3：最大回合耗尽 → 按当前指标判定
  const maxTurns = spec.completion?.maxTurns || 12;
  if (run.turnCount >= maxTurns) {
    return { ...finish('success', `已达最大回合数（${maxTurns}），会话已收场；不据此判定目标完成`), completionOutcome: 'limit-reached' };
  }

  return run;
}

/**
 * 反事实重跑：清空对话、重置指标（应用 overrides）、事件 fired 归零、回合归零。
 * 保留 runId 之外的场景信息；overrides 由调用方合并后传入。
 */
export function resetForRerun(spec: SceneSpec, run: SceneRunState): SceneRunState {
  return createRunState(spec, run.overrides);
}
