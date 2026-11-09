import React, { useEffect, useState, useRef } from 'react';
import type { LearningPreparation, LearningPreparationCommand } from '../../services/progressiveLearning/preparation';
import './progressiveCourse.css';

/** One compact, event-driven root panel. No polling, model loading, modal or
 * prerequisite gate is introduced into the Flow entrance. */
export function LearningPreparationPanel({ rootId, title }: { rootId: string; title: string }) {
  const [job, setJob] = useState<LearningPreparation | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const submitting = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setJob(null); setError(''); setSelected([]);
    const api = window.electronAPI?.learningPreparation; if (!api) return;
    const refresh = () => { void api.command({ op: 'status', rootId }).then(value => { if (!cancelled) setJob(value); }).catch(() => {}); };
    refresh(); const off = api.onChange(id => { if (id === rootId) refresh(); });
    return () => { cancelled = true; off(); };
  }, [rootId]);
  useEffect(() => { setSelected(job?.candidates.map(candidate => candidate.url) || []); }, [job?.goalKey, job?.candidates.length]);
  if (!window.electronAPI?.learningPreparation) return null;
  const run = async (input: LearningPreparationCommand) => {
    if (submitting.current) return; submitting.current = true; setBusy(true); setError('');
    try { setJob(await window.electronAPI!.learningPreparation!.command(input)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '资料准备未完成，可继续学习。'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const working = Boolean(job && ['pending', 'searching', 'collecting'].includes(job.status));
  const message = !job ? '可以直接进入心流，也可先补充教材。'
    : job.status === 'pending' || job.status === 'searching' ? '正在后台查找教材与公开资源，可直接开始学习。'
    : job.status === 'collecting' ? '正在收录资源和下载附件，学习无需等待。'
    : job.status === 'recommended' ? `已找到 ${job.candidates.length} 份推荐，选择后收录。`
    : job.status === 'ready' ? '资源已绑定到根项目，各子项目可直接使用。'
    : job.error || '资料准备未完成，可上传教材或直接开始学习。';
  return <section className="learning-preparation" aria-label="学习资料准备">
    <div className="learning-preparation-summary"><div><strong>学习资料</strong><span>{title}</span></div><p role="status">{message}</p></div>
    <div className="learning-preparation-actions">
      {!working && <button type="button" disabled={busy} onClick={() => void run({ op: job ? 'refresh' : 'enqueue', rootId })}>{job ? '重新准备' : '准备推荐资料'}</button>}
      {!working && job?.status === 'failed' && !!job.selected.length && <button type="button" disabled={busy} onClick={() => void run({ op: 'retry', rootId })}>重试收录</button>}
      <button type="button" disabled={busy} onClick={() => void run({ op: 'upload', rootId })}>上传教材</button>
    </div>
    {!!job?.candidates.length && !working && job.status !== 'ready' && <details className="learning-preparation-recommendations">
      <summary>查看推荐（{job.candidates.length}）</summary>
      <fieldset disabled={busy}><legend className="sr-only">选择要收录的教材和公开资源</legend>
        {job.candidates.map(candidate => <label key={candidate.url}><input type="checkbox" checked={selected.includes(candidate.url)} onChange={event => setSelected(values => event.target.checked ? [...values, candidate.url] : values.filter(url => url !== candidate.url))} />
          <span><strong>{candidate.title}</strong><small>{new URL(candidate.url).hostname}{candidate.downloadable ? ' · 可下载附件' : ' · 在线资源'}</small></span></label>)}
      </fieldset>
      <button type="button" disabled={busy || !selected.length} onClick={() => void run({ op: 'accept', rootId, goalKey: job.goalKey, urls: selected })}>收录所选并下载可用附件</button>
    </details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
