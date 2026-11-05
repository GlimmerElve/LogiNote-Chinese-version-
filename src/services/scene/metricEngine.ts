/**
 * 指标引擎（全 LLM 驱动，无规则引擎）。
 *
 * 设计要点：
 * - 指标的名称、初值、阈值由 sceneGenerator 产出；本模块只负责运行时的数值更新与判定。
 * - 每轮判定复用同一次 LLM 调用同时完成：① 指标更新 ② 成败判定 ③ condition 型突发事件条件判定。
 * - clampMetricValue 保证数值不越界（边界⑬），离散值非法时回退到最近合法选项（边界⑮）。
 * - mode='signal' 的场景不做指标判定，直接短路返回 ongoing（结束由角色输出的 [结束:...] 决定）。
 */

import { callLLM } from '../llmService';
import { parseJsonLenient } from '../reviewSegmentScoring';
import {
  SceneSpec,
  SceneRunState,
  SceneMessage,
  SceneRunOverrides,
  MetricSpec,
  MetricValue,
  MetricDelta,
  MetricUpdateResult,
  MetricDiffItem,
} from '../../types';
import { clampMetricValue, defaultMetricValue, isMetricMet } from './sceneMetricValue';

// 指标达标/失败判定与值规范化的实现统一收拢到 sceneMetricValue.ts，
// 本模块仅做「调 LLM 更新指标」的业务编排，避免同一口径多处实现。
// 此处 re-export 保持原有对外 API 不变（SceneMetricPanel 等仍可从本模块取用）。
export { isMetricMet, isMetricFailed } from './sceneMetricValue';

/** 取指标定义（按 id） */
function findMetricSpec(spec: SceneSpec, metricId: string): MetricSpec | undefined {
  return spec.metrics.find((m) => m.id === metricId);
}

/** 初始化本局指标值（以指标定义的 initial 为准，并做一次 clamp 防御） */
export function initMetricValues(spec: SceneSpec): MetricValue[] {
  return spec.metrics.map((m) => ({
    metricId: m.id,
    value: clampMetricValue(m, defaultMetricValue(m)),
  }));
}

/** 把指标定义渲染成供 LLM 判定的说明段 */
function renderMetricDefs(spec: SceneSpec, run: SceneRunState): string {
  return spec.metrics
    .map((m) => {
      const cur = run.metrics.find((v) => v.metricId === m.id);
      const parts = [
        `- id=${m.id}｜名称：${m.name}｜类型：${m.type}`,
        `  当前值：${cur?.value ?? m.initial}｜目标：${m.target}`,
      ];
      if (m.failureThreshold !== undefined) parts.push(`  失败阈值：${m.failureThreshold}`);
      if (m.range) parts.push(`  取值范围：${m.range[0]}~${m.range[1]}`);
      if (m.options?.length) parts.push(`  可选值：${m.options.join(' / ')}`);
      if (m.unit) parts.push(`  单位：${m.unit}`);
      parts.push(`  语义：${m.description}`);
      return parts.join('\n');
    })
    .join('\n');
}

/** 把最近若干轮对话渲染成判定依据（控制长度，避免 prompt 膨胀） */
function renderMessageEvidence(message: SceneMessage): string {
  const parts = [message.content];
  if (message.interaction) {
    parts.push(`结构化交互：${JSON.stringify(message.interaction)}`);
  }
  if (message.interactionResponse) {
    const response = JSON.stringify(
      message.interactionResponse,
      (key, value) => key === 'submittedAt' ? undefined : value,
    );
    parts.push(`结构化响应：${response}`);
  }
  return parts.join('\n');
}

function renderRecentDialogue(run: SceneRunState, limit = 12): string {
  const recent = run.messages.filter((m) => m.speakerType !== 'action').slice(-limit);
  if (recent.length === 0) return '（暂无对话）';
  return recent
    .map((m) => {
      const who =
        m.speakerType === 'user'
          ? '用户'
          : m.speakerType === 'role'
            ? '对方角色'
            : m.speakerType === 'event'
              ? '突发事件'
              : '旁白';
      return `【${who}】${renderMessageEvidence(m)}`;
    })
    .join('\n');
}

/** 把未触发的 condition 型事件渲染成待判定清单 */
function renderPendingConditions(run: SceneRunState): string {
  const pending = (run.events || []).filter((e) => !e.fired && e.trigger.type === 'condition');
  if (pending.length === 0) return '（无待判定的条件型事件）';
  return pending.map((e) => `- id=${e.id}｜条件：${e.trigger.condition || e.description}`).join('\n');
}

/**
 * 每轮指标更新 + 成败判定 + 突发事件条件判定（一次 LLM 调用）。
 *
 * mode='signal' 时短路返回 ongoing：该模式无量化目标，结束完全由角色输出的 [结束:...] 决定。
 */
export async function updateMetrics(
  spec: SceneSpec,
  run: SceneRunState,
  latest: SceneMessage,
): Promise<MetricUpdateResult> {
  // 无指标（或 signal 模式）：不做 LLM 判定，保持原值
  if (spec.metrics.length === 0 || spec.completion.mode === 'signal') {
    return {
      metrics: run.metrics,
      deltas: [],
      completionStatus: 'ongoing',
      triggeredEvents: [],
    };
  }

  const userInput = [
    `## 指标定义与当前值`,
    renderMetricDefs(spec, run),
    ``,
    `## 成功条件`,
    spec.completion.successExpression || '（未设定）',
    spec.completion.failureExpression ? `\n## 失败条件\n${spec.completion.failureExpression}` : '',
    ``,
    `## 最近对话`,
    renderRecentDialogue(run),
    ``,
    `## 用户最新发言`,
    renderMessageEvidence(latest),
    ``,
    `## 待判定的突发事件条件`,
    renderPendingConditions(run),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await callLLM({ providerId: '', model: '', workflow: 'scene-metric-update', userInput });
    const parsed = parseJsonLenient(resp.content) as Partial<MetricUpdateResult> | null;

    // 归一化：以场景定义为基准逐个校验，未返回的指标保持原值
    const returned = new Map<string, MetricValue>(
      Array.isArray(parsed?.metrics)
        ? parsed!.metrics!.filter((m) => m && typeof m.metricId === 'string').map((m) => [m.metricId, m])
        : [],
    );
    const metrics: MetricValue[] = spec.metrics.map((def) => {
      const cur = run.metrics.find((v) => v.metricId === def.id);
      const next = returned.get(def.id);
      if (!next) return cur ?? { metricId: def.id, value: clampMetricValue(def, def.initial) };
      const value = clampMetricValue(def, next.value);
      return {
        metricId: def.id,
        value,
        lastDelta: next.lastDelta ?? cur?.lastDelta,
        lastReason: next.lastReason ?? cur?.lastReason,
      };
    });

    // deltas 只保留真实发生变化的项
    const deltas: MetricDelta[] = [];
    for (const def of spec.metrics) {
      const before = run.metrics.find((v) => v.metricId === def.id)?.value;
      const after = metrics.find((v) => v.metricId === def.id)?.value;
      if (before === after) continue;
      const raw = Array.isArray(parsed?.deltas) ? parsed!.deltas!.find((d) => d.metricId === def.id) : undefined;
      deltas.push({
        metricId: def.id,
        metricName: def.name,
        delta: raw?.delta ?? (typeof before === 'number' && typeof after === 'number' ? after - before : String(after)),
        reason: raw?.reason || metrics.find((v) => v.metricId === def.id)?.lastReason || '语义变化',
      });
    }

    // condition 型事件：只接受真实存在且未触发的 id（防 LLM 臆造）
    const validIds = new Set(
      (run.events || []).filter((e) => !e.fired && e.trigger.type === 'condition').map((e) => e.id),
    );
    const triggeredEvents = (Array.isArray(parsed?.triggeredEvents) ? parsed!.triggeredEvents! : []).filter((id) =>
      validIds.has(id),
    );

    const status =
      parsed?.completionStatus === 'success' || parsed?.completionStatus === 'failure'
        ? parsed.completionStatus
        : 'ongoing';

    return {
      metrics,
      deltas,
      completionStatus: status,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined,
      triggeredEvents,
    };
  } catch (e) {
    // 判定失败不阻塞对话：保持原值，继续本轮
    console.warn('[scene] 指标更新失败，保持原值:', (e as Error)?.message);
    return { metrics: run.metrics, deltas: [], completionStatus: 'ongoing', triggeredEvents: [] };
  }
}

/**
 * 应用反事实重跑的覆盖项到场景定义（不改动原对象）。
 * - role：整体替换角色定义
 * - metrics：按 metricId 覆盖 initial / target；未知 id 忽略（边界⑰）
 */
export function applyOverrides(spec: SceneSpec, ov: SceneRunOverrides): SceneSpec {
  const next: SceneSpec = { ...spec };

  if (ov.role) {
    next.role = {
      ...ov.role,
      attributes: (ov.role.attributes || []).map((a) => ({ ...a })),
    };
  }

  if (ov.metrics) {
    next.metrics = spec.metrics.map((m) => {
      const patch = ov.metrics?.[m.id];
      if (!patch) return m;
      return {
        ...m,
        initial: patch.initial !== undefined ? patch.initial : m.initial,
        target: patch.target !== undefined ? patch.target : m.target,
      };
    });
  }

  return next;
}

/**
 * 指标差异对比（上一局 vs 本局）。
 * 仅统计两局共有的 metricId；连续型额外给出 delta。
 */
export function diffMetrics(
  prev: SceneRunState,
  curr: SceneRunState,
  spec: SceneSpec,
): MetricDiffItem[] {
  const items: MetricDiffItem[] = [];
  for (const def of spec.metrics) {
    const p = prev.metrics.find((v) => v.metricId === def.id);
    const c = curr.metrics.find((v) => v.metricId === def.id);
    if (!p || !c) continue;
    const delta =
      typeof p.value === 'number' && typeof c.value === 'number' ? c.value - p.value : undefined;
    items.push({
      metricId: def.id,
      metricName: def.name,
      previousValue: p.value,
      currentValue: c.value,
      target: def.target,
      delta,
      previousMet: isMetricMet(def, p.value),
      currentMet: isMetricMet(def, c.value),
    });
  }
  return items;
}
