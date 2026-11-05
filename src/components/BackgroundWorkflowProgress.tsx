import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { backgroundWorkflows, backgroundWorkflowSummary } from '../services/agent/backgroundWorkflowService';
import { backgroundWorkflowActive } from '../services/agent/backgroundWorkflowTypes';
import './ConceptBatchProgress.css';
const names = { 'study-tasks': '学习任务', 'wiki-concepts': '知识点补全', textbook: '教材生成' };
const statuses: Record<string, string> = { prepared: '待确认', queued: '排队中', running: '执行中', stopping: '正在停止', paused: '已暂停', blocked: '前置条件待处理', completed: '已完成', skipped: '已有，跳过', pending: '待处理' };
const button = 'min-h-9 rounded-lg border border-[var(--ln-border)] px-3 text-xs text-[var(--ln-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)] disabled:opacity-50';
export function BackgroundWorkflowProgress({ runtime = backgroundWorkflows, onResume, resumeDisabled = false }: { runtime?: typeof backgroundWorkflows; onResume?: (id: string) => void; resumeDisabled?: boolean }) {
  const jobs = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; let active = true;
    void runtime.ensureReady().catch(() => { if (active) setError('组合任务状态读取失败，请检查存储或重启桌面应用'); });
    return () => { active = false; mounted.current = false; }; }, [runtime]);
  const sorted = jobs.filter(job => !job.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const active = sorted.filter(backgroundWorkflowActive), visible = active.length ? active.slice(0, 3) : sorted.slice(0, 1);
  if (!visible.length && !error) return null;
  return <section className="agent-concept-progress" aria-label="组合工作流后台状态">
    <header><strong>后台组合任务</strong><small>切页继续 · 完全退出后暂停</small></header>
    <div className="agent-concept-progress-list" role="status" aria-live="polite">{visible.map(job => {
      const summary = backgroundWorkflowSummary(job), percent = summary.totalUnits ? Math.round(summary.completedUnits / summary.totalUnits * 100) : 0;
      const current = job.projects.flatMap(project => project.steps.filter(step => !['completed', 'skipped'].includes(step.status)).map(step => `${project.title} · ${names[step.kind]}`))[0];
      return <article key={job.id}>
        <div className="agent-concept-progress-row"><span aria-hidden="true">{job.status === 'completed' ? '✓' : '○'}</span>
          <span className="agent-concept-progress-copy"><strong>{job.title}</strong><small>{statuses[job.status]}{current ? ` · ${current}` : ''}</small></span>
          <span className="agent-concept-progress-count">{summary.completedUnits}/{summary.totalUnits}</span></div>
        <div className="agent-concept-progress-meter" role="progressbar" aria-label={`${job.title} 已处理步骤`} aria-valuemin={0} aria-valuemax={summary.totalUnits} aria-valuenow={summary.completedUnits}><i style={{ width: `${percent}%` }} /></div>
        <details><summary>逐项目审核与结果</summary><ul>{job.projects.map(project => <li key={project.id}><span>{project.title}
          {project.steps.map(step => <small key={step.kind}>{names[step.kind]}：{statuses[step.status]}{step.draftTasks ? ' · 草稿保留' : ''}{step.error ? ` · ${step.error}` : ''}</small>)}</span></li>)}</ul></details>
        {job.error && <p role="alert">{job.error}</p>}
        <div className="mt-2 flex gap-2">{backgroundWorkflowActive(job) ? <button type="button" className={button} disabled={job.status === 'stopping'}
          onClick={() => { void runtime.stop(job.id).catch(() => { if (mounted.current) setError('停止请求未保存，请重试；已保存结果不会删除'); }); }}>{job.status === 'stopping' ? '正在停止…' : '停止后续步骤'}</button>
          : job.status !== 'completed' && onResume ? <button type="button" className={button} disabled={resumeDisabled} onClick={() => onResume(job.id)}>重新确认续办</button> : null}</div>
      </article>;
    })}</div>
    {(error || runtime.getPersistenceError()) && <p role="alert" className="agent-concept-progress-error">{error || runtime.getPersistenceError()}</p>}
  </section>;
}
