import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock3, GitBranch, RefreshCw } from 'lucide-react';
import { loadProgressiveCourse } from '../../services/progressiveLearning/client';
import { onProgressiveChange, progressiveReviewCommand } from '../../services/progressiveLearning/reviewClient';
import { createProgressiveReviewRefreshQueue } from '../../services/progressiveLearning/reviewRefresh';
import type { ProgressiveReviewGraphReply } from '../../services/progressiveLearning/reviewTypes';
import { ProgressiveReviewDialog, type ProgressiveReviewDialogTarget } from './ProgressiveReviewDialog';
import './progressiveReviewDialog.css';

const SavedGraph = lazy(() => import('../../modules/argumentCanvas/components/ArgumentDocEmbed').then(module => ({ default: module.ArgumentDocEmbed })));
type Preview = ProgressiveReviewGraphReply & { target: ProgressiveReviewDialogTarget; at: string };
/** A current-project-only projection. It never initializes a course or writes cognition. */
export function ProgressiveLatestArgument({ noteId, noteTitle, enabled, legacyUpdatedAt, children }: {
  noteId: string; noteTitle: string; enabled: boolean; legacyUpdatedAt?: string; children?: React.ReactNode;
}) {
  const [savedPreview, setPreview] = useState<Preview | null>(null), [loading, setLoading] = useState(enabled), [error, setError] = useState('');
  const [target, setTarget] = useState<ProgressiveReviewDialogTarget | null>(null);
  const request = useRef(0), refresh = useRef<ReturnType<typeof createProgressiveReviewRefreshQueue> | null>(null);
  const titleRef = useRef(noteTitle); titleRef.current = noteTitle;
  useEffect(() => {
    setPreview(null); setTarget(null); setError(''); setLoading(enabled); ++request.current;
    if (!enabled) return;
    let alive = true;
    const queue = createProgressiveReviewRefreshQueue(async () => {
      const ticket = ++request.current;
      try {
        const course = await loadProgressiveCourse(noteId);
        if (!alive || ticket !== request.current) return;
        if (course && course.projectNoteId !== noteId) throw Error('结构图所属项目不匹配。');
        let found: Preview | null = null;
        if (course) {
          const rows = [...(course.reviews || [])].filter(row => row.status === 'analyzed' && row.completedParts > 0)
            .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
          for (const row of rows) {
            if (!alive || ticket !== request.current) return;
            const record = await progressiveReviewCommand<import('../../services/progressiveLearning/reviewTypes').ProgressiveReviewRecord>({ op: 'review-read', projectNoteId: noteId, reviewId: row.id });
            if (!alive || ticket !== request.current) return;
            if (record.courseId !== course.id || record.projectNoteId !== noteId) throw Error('课程已变化，请重新读取结构图。');
            const part = record.chunks.find(item => item.resultHash); if (!part) continue;
            const graph = await progressiveReviewCommand<ProgressiveReviewGraphReply>({ op: 'review-graph-read', projectNoteId: noteId, reviewId: row.id, partId: part.id });
            if (!alive || ticket !== request.current) return;
            if (graph.record.courseId !== course.id || graph.record.projectNoteId !== noteId) throw Error('结构图所属课程已变化。');
            if (!graph.doc?.nodes?.length) continue;
            found = { ...graph, at: graph.doc.updated_at || row.submittedAt, target: { projectNoteId: noteId, noteTitle: titleRef.current,
              reviewId: row.id, courseId: course.id, environmentId: course.environmentId, partId: part.id } };
            break;
          }
        }
        if (alive && ticket === request.current) { setPreview(found); setError(''); setLoading(false); }
      } catch (cause) {
        if (alive && ticket === request.current) { setError(cause instanceof Error ? cause.message : '结构图暂时读取失败。'); setLoading(false); }
      }
    });
    refresh.current = queue;
    const off = onProgressiveChange(id => { if (id === noteId) void queue.refresh(); });
    void queue.refresh();
    return () => { alive = false; ++request.current; off(); queue.stop(); if (refresh.current === queue) refresh.current = null; };
  }, [noteId, enabled]);
  if (!enabled) return <>{children}</>;
  // A title is display metadata, not the lifetime of this project's editor.
  // Keep its mounted dialog separate from which read-only preview wins, so a
  // rename or a newer legacy preview cannot bypass the dialog's leave guard.
  const preview = savedPreview?.target.projectNoteId === noteId ? savedPreview : null;
  const activeDialog = target?.projectNoteId === noteId
    ? <ProgressiveReviewDialog target={{ ...target, noteTitle }} onClose={() => setTarget(null)} /> : null;
  const useLegacy = Boolean(legacyUpdatedAt && (!preview || Date.parse(legacyUpdatedAt) > Date.parse(preview.at)));
  return <>{useLegacy ? children : <section className="note-inspector-card progressive-latest-argument" aria-label="最近的复盘论证结构">
    <div className="note-inspector-card-head"><h2>论证结构</h2>{preview && <button type="button" onClick={() => setTarget({ ...preview.target, noteTitle })}>查看与编辑 <ArrowUpRight aria-hidden="true" /></button>}</div>
    {preview ? <div className="note-argument-panel-content">
      <div className="note-argument-meta"><span><Clock3 aria-hidden="true" />{new Date(preview.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <span>{preview.doc.nodes.length} 节点</span><span>{preview.doc.edges.length} 关系</span><span>{preview.record.cognitionConfirmation?.status === 'confirmed' ? '已确认入库' : '待确认草稿'}</span></div>
      <div className="note-argument-canvas" aria-label="当前项目最近论证结构图"><Suspense fallback={<p role="status">正在展示结构图…</p>}><SavedGraph key={preview.record.id + ':' + preview.graphHash} doc={preview.doc} /></Suspense></div>
      <p className="note-argument-footnote">{preview.record.cognitionConfirmation?.status === 'confirmed' ? '可打开编辑器继续调整；修订后需再次确认。' : '结构图已保存，编辑并确认后写入个人认知库。'}</p>
    </div> : <div className="note-argument-empty is-card-empty"><div><GitBranch aria-hidden="true" /></div><h3>{loading ? '正在读取最近结构图' : error ? '结构图读取未完成' : '暂无复盘论证图'}</h3>
      <p>{loading ? '只读取当前项目已保存的复盘。' : error || '完成一次复盘分析后，最近的结构图会显示在这里。'}</p></div>}
    {error && preview && <p className="progressive-review-notice" role="alert">{error} 已保留上一次有效预览。</p>}
    {error && <button type="button" className="progressive-latest-retry" onClick={() => { setLoading(true); void refresh.current?.refresh(); }}><RefreshCw aria-hidden="true" />重新读取结构图</button>}
  </section>}{activeDialog}</>;
}
