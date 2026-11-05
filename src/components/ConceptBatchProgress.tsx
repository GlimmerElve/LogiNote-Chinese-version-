import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, ChevronDown, CircleAlert, Clock3, LoaderCircle, PauseCircle, X } from 'lucide-react';
import { conceptBatchJobs, conceptBatchSummary } from '../services/conceptBatchService';
import './ConceptBatchProgress.css';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', stopping: '正在停止', paused: '已暂停', completed: '已保存',
  partial: '部分完成', failed: '未完成', archived: '已归档', pending: '待处理', retrieving: '检索中', generating: '生成中', saving: '保存中', conflict: '编辑冲突', skipped: '已跳过' };
const activeStatuses = new Set(['queued', 'running', 'stopping']);
const DISMISSED_PROGRESS_KEY = 'loginote.agent-background-progress-dismissed.v1';

function loadDismissedJobs(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(DISMISSED_PROGRESS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(-60) : []);
  } catch {
    return new Set();
  }
}

function saveDismissedJobs(ids: Set<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_PROGRESS_KEY, JSON.stringify([...ids].slice(-60)));
  } catch {
    // Hiding still works for this mounted panel when local storage is unavailable.
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 aria-hidden="true" />;
  if (status === 'failed' || status === 'partial') return <CircleAlert aria-hidden="true" />;
  if (status === 'paused') return <PauseCircle aria-hidden="true" />;
  if (status === 'queued') return <Clock3 aria-hidden="true" />;
  return <LoaderCircle className="is-spinning" aria-hidden="true" />;
}

export function ConceptBatchProgress({ runtime = conceptBatchJobs }: { runtime?: typeof conceptBatchJobs } = {}) {
  const jobs = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [dismissedJobs, setDismissedJobs] = useState(loadDismissedJobs);
  useEffect(() => { void runtime.ensureReady().catch(() => {}); }, [runtime]);
  const available = jobs.filter(job => job.status !== 'archived' && !dismissedJobs.has(job.id)).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = available.filter(job => activeStatuses.has(job.status));
  const visible = active.length ? active.slice(0, 3) : available.slice(0, 1);
  if (!visible.length) return null;
  const latestSucceeded = visible[0].status === 'completed';
  const dismissVisible = () => {
    const next = new Set(dismissedJobs);
    visible.forEach(job => next.add(job.id));
    setDismissedJobs(next);
    saveDismissedJobs(next);
  };
  return <section className={`agent-concept-progress${active.length ? ' is-active' : ''}`} aria-label="后台任务进度">
    <header>
      <span>
        {active.length ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <StatusIcon status={visible[0].status} />}
        <span><strong>{active.length ? '后台处理中' : latestSucceeded ? '最近完成' : '后台任务需处理'}</strong><small>切换页面不会中断</small></span>
      </span>
      <span className="agent-concept-progress-actions">
        <em>{active.length ? `${active.length} 项进行中` : labels[visible[0].status]}</em>
        <button type="button" onClick={dismissVisible}
          aria-label={active.length ? '隐藏后台任务进度，任务仍会继续' : '关闭后台任务完成提示'}
          title={active.length ? '隐藏进度提示，不会停止任务' : '关闭完成提示'}><X aria-hidden="true" /></button>
      </span>
    </header>
    <div className="agent-concept-progress-list" role="status" aria-live="polite" aria-atomic="true">
      {visible.map(job => {
        const summary = conceptBatchSummary(job);
        const percent = summary.totalUnits ? Math.round(summary.completedUnits / summary.totalUnits * 100) : 0;
        const current = job.items.find(item => !['completed', 'skipped'].includes(item.status));
        return <article key={job.id} data-status={job.status}>
          <div className="agent-concept-progress-row">
            <span className="agent-concept-progress-icon"><StatusIcon status={job.status} /></span>
            <span className="agent-concept-progress-copy">
              <strong>{job.projectTitle}</strong>
              <small>{activeStatuses.has(job.status) && current ? `${labels[current.status]} · ${current.wikiTitle}` : labels[job.status]}</small>
            </span>
            <span className="agent-concept-progress-count"><strong>{summary.completedUnits}/{summary.totalUnits}</strong><small>{percent}%</small></span>
          </div>
          <div className="agent-concept-progress-meter" role="progressbar" aria-label={`${job.projectTitle} 完成进度`}
            aria-valuemin={0} aria-valuemax={summary.totalUnits} aria-valuenow={summary.completedUnits} aria-valuetext={`已保存 ${summary.completedUnits}/${summary.totalUnits}`}>
            <i style={{ width: `${percent}%` }} />
          </div>
          <details>
            <summary><span>逐篇结果</span><ChevronDown aria-hidden="true" /></summary>
            <ul>{job.items.map(item => <li key={item.noteId} data-status={item.status}>
              <span>{item.wikiTitle}<small>{labels[item.status]}{item.draft ? ' · 草稿已保留' : ''}</small></span>
              {item.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : item.status === 'failed' || item.status === 'conflict' ? <CircleAlert aria-hidden="true" /> : null}
              {item.error && <small role="alert">{item.error}</small>}
            </li>)}</ul>
            {job.error && <p role="alert">{job.error}</p>}
          </details>
        </article>;
      })}
    </div>
    {runtime.getPersistenceError() && <p className="agent-concept-progress-error" role="alert">{runtime.getPersistenceError()}</p>}
  </section>;
}
