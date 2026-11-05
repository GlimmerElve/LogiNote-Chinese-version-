/**
 * 反事实重跑面板：调整角色字段与指标初值/阈值后重跑，并展示指标差异对比表。
 */

import React, { useState } from 'react';
import { Play, X, ArrowRight, Check, AlertTriangle } from 'lucide-react';
import { SceneSpec, SceneRunState, SceneRunOverrides, MetricDiffItem } from '../../types';
import { SceneMetricPanel } from './SceneMetricPanel';

interface Props {
  spec: SceneSpec;
  prevRun: SceneRunState;
  busy: boolean;
  diff: MetricDiffItem[];
  onConfirm: (overrides: SceneRunOverrides) => void;
  onClose: () => void;
}

export const SceneRerunPanel: React.FC<Props> = ({ spec, prevRun, busy, diff, onConfirm, onClose }) => {
  const [draft, setDraft] = useState<SceneRunOverrides>(() => ({
    role: { ...spec.role, attributes: spec.role.attributes.map((a) => ({ ...a })) },
    metrics: Object.fromEntries(spec.metrics.map((m) => [m.id, { initial: m.initial, target: m.target }])),
  }));

  const patchAttr = (id: string, value: string) => {
    if (!draft.role) return;
    setDraft({
      ...draft,
      role: { ...draft.role, attributes: draft.role.attributes.map((a) => (a.id === id ? { ...a, value } : a)) },
    });
  };

  const patchMetric = (id: string, key: 'initial' | 'target', raw: string) => {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) return;
    setDraft({
      ...draft,
      metrics: { ...(draft.metrics || {}), [id]: { ...(draft.metrics?.[id] || {}), [key]: n } },
    });
  };

  const hasDiff = diff.length > 0;

  return (
    <div className="scene-rerun">
      <div className="scene-rerun-head">
        <div className="scene-rerun-title">反事实重跑</div>
        <button type="button" className="scene-icon-btn" onClick={onClose} title="关闭"><X className="w-4 h-4" /></button>
      </div>

      <p className="scene-rerun-hint">
        改变下列条件后重跑，对话将清空、指标重置，用于观察「同样的话题在不同初始条件下会走向何方」。
      </p>

      {/* 指标差异对比：仅在完成过一次重跑后展示 */}
      {hasDiff && (
        <div className="scene-diff">
          <div className="scene-side-title">指标差异对比（上一局 → 本局）</div>
          <table className="scene-diff-table">
            <thead>
              <tr><th>指标</th><th>上一局</th><th /><th>本局</th><th>目标</th><th>达标</th></tr>
            </thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.metricId}>
                  <td>{d.metricName}</td>
                  <td className={d.previousMet ? 'is-met' : ''}>{String(d.previousValue)}</td>
                  <td className="scene-diff-arrow"><ArrowRight className="w-3 h-3" /></td>
                  <td className={d.currentMet ? 'is-met' : ''}>{String(d.currentValue)}</td>
                  <td>{String(d.target)}</td>
                  <td>
                    {d.currentMet ? (
                      <span className="scene-diff-tag is-met"><Check className="w-3 h-3" />达标</span>
                    ) : (
                      <span className="scene-diff-tag is-fail"><AlertTriangle className="w-3 h-3" />未达</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="scene-rerun-section">
        <div className="scene-side-title">上一局结果</div>
        <SceneMetricPanel specs={spec.metrics} values={prevRun.metrics} compact />
      </div>

      <div className="scene-rerun-section">
        <div className="scene-side-title">角色特征调整</div>
        {draft.role?.attributes.filter((a) => a.enabled).map((a) => (
          <div key={a.id} className="scene-field-row">
            <label className="scene-field-label">{a.key}</label>
            <textarea className="scene-textarea" rows={2} value={a.value} disabled={busy}
              onChange={(e) => patchAttr(a.id, e.target.value)} />
          </div>
        ))}
        {(!draft.role || draft.role.attributes.filter((a) => a.enabled).length === 0) && (
          <p className="text-xs text-slate-400">该场景未启用角色字段</p>
        )}
      </div>

      {spec.metrics.length > 0 && (
        <div className="scene-rerun-section">
          <div className="scene-side-title">指标初值与目标调整</div>
          {spec.metrics.map((m) => (
            <div key={m.id} className="scene-metric-edit">
              <div className="scene-metric-edit-name">{m.name}</div>
              <div className="scene-metric-edit-fields">
                <label>
                  初值
                  <input className="scene-input scene-input--sm" disabled={busy}
                    defaultValue={String(draft.metrics?.[m.id]?.initial ?? m.initial)}
                    onBlur={(e) => patchMetric(m.id, 'initial', e.target.value)} />
                </label>
                <label>
                  目标
                  <input className="scene-input scene-input--sm" disabled={busy}
                    defaultValue={String(draft.metrics?.[m.id]?.target ?? m.target)}
                    onBlur={(e) => patchMetric(m.id, 'target', e.target.value)} />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="scene-preview-actions">
        <button type="button" className="scene-btn scene-btn--ghost" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="scene-btn scene-btn--primary" disabled={busy} onClick={() => onConfirm(draft)}>
          <Play className="w-4 h-4" />确认并重跑
        </button>
      </div>
    </div>
  );
};