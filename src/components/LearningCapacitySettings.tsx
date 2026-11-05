import React, { useEffect, useState } from 'react';
import type { NoteItem, VaultSettings } from '../types';
import { buildLearningCapacity, personalWeeklyBudget, validStudyMinutes, weekStartDate } from '../services/learningCapacity';

export function LearningCapacitySettings({ settings, notes, onUpdate }: { settings: VaultSettings; notes: NoteItem[]; onUpdate: (patch: Partial<VaultSettings>) => void }) {
  const budget = personalWeeklyBudget(settings), [draft, setDraft] = useState(budget === null ? '' : String(budget)), [error, setError] = useState('');
  useEffect(() => { setDraft(budget === null ? '' : String(budget)); }, [budget]);
  const capacity = buildLearningCapacity(notes, weekStartDate(), settings);
  return <section className="p-5 rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] space-y-3" aria-labelledby="learning-capacity-title">
    <h2 id="learning-capacity-title" className="font-semibold text-[var(--ln-text-primary)]">学习偏好 · 个人时间容量</h2>
    <p id="learning-capacity-help" className="text-xs leading-relaxed">所有计划共用一份周预算。修改只改变容量约束，不会自动重排项目或改变完成记录。</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
      event.preventDefault(); const value = Number(draft);
      if (!validStudyMinutes(value, 10080)) { setError('请输入 5–10080 分钟的整数。'); return; }
      setError(''); onUpdate({ learningWeeklyBudgetMinutes: value });
    }}>
      <label className="flex flex-col gap-1 text-xs">个人每周总学习时间（分钟）
        <input type="number" min={5} max={10080} step={5} required value={draft} onChange={e => setDraft(e.target.value)}
          aria-describedby="learning-capacity-help" aria-invalid={!!error} className="min-h-11 rounded-lg border border-[var(--ln-border)] bg-[var(--ln-bg-app)] p-2" />
      </label>
      <button type="submit" className="min-h-11 px-4 rounded-lg bg-[var(--ln-accent)] text-white">确认应用到所有计划</button>
    </form>
    {error && <p role="alert" className="text-xs text-[var(--ln-danger)]">{error}</p>}
    <p className="text-xs" role="status">本周全部计划：{capacity.scheduledMinutes} 分钟 · {budget === null ? '个人周预算尚未确认' : `${capacity.percent}% · 剩余 ${capacity.remainingMinutes} 分钟`}</p>
    {budget === null && capacity.legacyBudgets.length > 0 && <p className="text-xs">旧计划预算仅供参考，不会自动相加：{capacity.legacyBudgets.map(r => `${r.title} ${r.minutes}分钟`).join('；')}。请在上方确认个人总预算。</p>}
    {!!capacity.estimatedCount && <p className="text-xs">有 {capacity.estimatedCount} 项时长仍为旧数据估算，可在计划中确认每日投入，或让助手调整。</p>}
  </section>;
}
