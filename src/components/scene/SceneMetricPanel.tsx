/**
 * 指标面板：把运行态指标渲染为可读的进度条 / 状态标签 / 数值。
 *
 * 视觉约定（沿用项目令牌）：
 * - 正向变化 / 达标 → 黛绿 #3F7A50、浅绿 #5C9E6D
 * - 负向变化 / 触失败阈值 → 淡红 #B8574A
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { MetricSpec, MetricValue } from '../../types';
// 判定口径统一收拢到 sceneMetricValue.ts，UI 层只做渲染，不重复实现业务规则。
import { isMetricMet, isMetricFailed } from '../../services/scene/sceneMetricValue';

interface SceneMetricPanelProps {
  specs: MetricSpec[];
  values: MetricValue[];
  /** 紧凑模式：用于对话页侧栏 */
  compact?: boolean;
}


/** 连续型进度百分比（依 range 归一化；无 range 时以 target 为参考上限） */
function progressPercent(spec: MetricSpec, value: MetricValue['value']): number {
  if (typeof value !== 'number') return 0;
  const [min, max] = spec.range ?? [0, typeof spec.target === 'number' ? spec.target : 100];
  if (max === min) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/** 变化量徽标：数值型显示正负号，其余显示文字 */
function DeltaBadge({ spec, value }: { spec: MetricSpec; value: MetricValue }) {
  if (value.lastDelta === undefined || value.lastDelta === null || value.lastDelta === '') return null;

  const numDelta = typeof value.lastDelta === 'number' ? value.lastDelta : Number(value.lastDelta);
  const isNum = Number.isFinite(numDelta);
  const dir = isNum ? (numDelta > 0 ? 'up' : numDelta < 0 ? 'down' : 'flat') : 'flat';

  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const color =
    dir === 'up' ? 'text-[#3F7A50]' : dir === 'down' ? 'text-[#B8574A]' : 'text-slate-400';
  const text = isNum ? `${numDelta > 0 ? '+' : ''}${numDelta}` : String(value.lastDelta);

  return (
    <span className={`scene-metric-delta is-${dir} inline-flex items-center gap-0.5 text-[11px] font-semibold ${color}`}>
      <Icon className="w-3 h-3" />
      {text}
    </span>
  );
}

export const SceneMetricPanel: React.FC<SceneMetricPanelProps> = ({ specs, values, compact = false }) => {
  if (specs.length === 0) {
    return (
      <div className="scene-metric-empty">
        <p className="text-xs text-slate-400">本场景为开放式对话，未设定量化指标</p>
      </div>
    );
  }

  return (
    <div className={`scene-metric-list ${compact ? 'scene-metric-list--compact' : ''}`}>
      {specs.map((spec) => {
        const v = values.find((x) => x.metricId === spec.id);
        const value = v?.value;
        const met = value !== undefined && isMetricMet(spec, value);
        const failed = value !== undefined && isMetricFailed(spec, value);
        const numeric = spec.type === 'continuous' || spec.type === 'count' || spec.type === 'time';

        return (
          <div key={spec.id} className="scene-metric-item">
            <div className="scene-metric-head">
              <span className="scene-metric-name">{spec.name}</span>
              <div className="flex items-center gap-2">
                <DeltaBadge spec={spec} value={v ?? { metricId: spec.id, value: value ?? 0 }} />
                <span
                  className={`scene-metric-value ${
                    failed ? 'is-failed' : met ? 'is-met' : ''
                  }`}
                >
                  {String(value ?? spec.initial)}
                  {spec.unit ? <span className="scene-metric-unit">{spec.unit}</span> : null}
                </span>
              </div>
            </div>

            {numeric && (
              <div className="scene-metric-bar">
                <div
                  className={`scene-metric-bar-fill ${
                    failed ? 'is-failed' : met ? 'is-met' : ''
                  }`}
                  style={{ width: `${progressPercent(spec, value ?? 0)}%` }}
                />
                {/* 目标刻度：连续型给出目标位置参考 */}
                {spec.range && typeof spec.target === 'number' && (
                  <div
                    className="scene-metric-bar-target"
                    style={{
                      left: `${progressPercent(spec, spec.target)}%`,
                    }}
                    title={`目标 ${spec.target}`}
                  />
                )}
              </div>
            )}

            {spec.type === 'boolean' && (
              <span className={`scene-metric-chip ${value === true ? 'is-met' : ''}`}>
                {value === true ? '已达成' : '未达成'}
              </span>
            )}

            <div className="scene-metric-foot">
              <span className="text-[10px] text-slate-400">
                目标 {String(spec.target)}
                {spec.failureThreshold !== undefined ? `｜失败 ≤ ${String(spec.failureThreshold)}` : ''}
              </span>
            </div>

            {v?.lastReason && !compact && (
              <p className="scene-metric-reason">{v.lastReason}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};
