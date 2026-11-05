import { onProgressiveChange } from '../../services/progressiveLearning/reviewClient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadProgressiveCourse, readProgressivePage } from '../../services/progressiveLearning/client';
import type { ProgressiveCourse } from '../../services/progressiveLearning/types';
import { ProgressiveCourseReader } from './ProgressiveCourseReader';
import { ProgressiveLearningRecords } from './ProgressiveLearningRecords';
import { stableMarkdownBlocks } from '../../services/progressiveLearning/stream';
import type { ProgressiveRuntimeSnapshot } from '../../services/progressiveLearning/runtime';
import './progressiveCourse.css';

/** Read-only course and personal record projection. Viewing never initializes, submits or analyzes. */
export function ProgressiveSavedNotice({ noteId, active, onContinue, onAvailable, mode = 'all', recordsTarget, toolbarTarget }: {
  noteId: string; active: boolean; onContinue?: (noteId: string) => void; onAvailable?: (available: boolean) => void; mode?: 'all' | 'reading' | 'records'; recordsTarget?: HTMLElement | null; toolbarTarget?: HTMLElement | null;
}) {
  const [course, setCourse] = useState<ProgressiveCourse | null>(null);
  const [reading, setReading] = useState<ProgressiveCourse | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
  const [exportState, setExportState] = useState<{ busy?: boolean; message?: string }>({});
  const readRequest = useRef(0);
  useEffect(() => {
    readRequest.current++;
    setCourse(null); setReading(null); setOpened(false); setError('');
    if (!active || !(window as any).electronAPI?.progressiveLearning) return;
    let cancelled = false;
    loadProgressiveCourse(noteId).then(value => { if (!cancelled) { setCourse(value); onAvailable?.(Boolean(value)); } })
      .catch(() => { if (!cancelled) setError('已保存的讲解暂时读取失败，可以重新进入心流恢复。'); });
    return () => { cancelled = true; };
  }, [noteId, active, onAvailable]);
  useEffect(()=>{
    if(!active)return;
    let cancelled=false;
    const off=onProgressiveChange(id=>{if(id===noteId)void loadProgressiveCourse(noteId).then(value=>{if(!cancelled)setCourse(value);}).catch(()=>{});});
    return ()=>{cancelled=true;off();};
  },[noteId,active]);
  const shown = reading || course;
  const snapshot = useMemo<ProgressiveRuntimeSnapshot>(() => {
    const page = shown?.page || shown?.firstPage;
    const ready = Boolean(page);
    const body = page?.body || shown?.generation.bodyDraft || '';
    const markdown = stableMarkdownBlocks(body, ready);
    return { phase: ready ? 'ready' : 'interrupted', course: shown, plan: shown?.plan || null,
      page: shown ? { id: page?.id || shown.generation.pageId, title: page?.title || shown.plan?.pages[shown.generation.mainlineIndex || 0]?.title || '', body, hook: page?.hook || null } : null,
      blocks: markdown.blocks, pendingText: markdown.pendingText, error: null, saveError: null, isDirty: false,
      study: shown?.study, timings: { startedAt: null, preparationMs: null, firstTokenMs: null, firstReadableMs: null, pageCompleteMs: null, pageSavedMs: null } };
  }, [shown]);
  if (!course && !error) return null;
  const body = snapshot.page?.body || '';
  const reader = <ProgressiveCourseReader snapshot={snapshot} active={active} readOnly onRetry={() => {}} onRetrySave={() => {}} onReadingPosition={() => {}}
    onNavigate={pageId => {
      const ticket = ++readRequest.current;
      void readProgressivePage(noteId, pageId).then(value => { if (ticket === readRequest.current) { setReading(value); setError(''); } })
        .catch(() => { if (ticket === readRequest.current) setError('本页教材读取失败，原内容仍保留。'); });
    }} />;
  const notice = <div className={`progressive-saved-notice${toolbarTarget ? ' is-toolbar' : ''}`}>
      <div className="progressive-saved-summary" title={course?.plan?.title || course?.title}><strong>{error || ((course?.page || course?.firstPage) ? `已保存 ${course?.pages?.length || 1} 页讲解` : '学习主线与生成进度已保留')}</strong>
        {!toolbarTarget && course && <small>{course.plan?.title || course.title} · {(course.page || course.firstPage) ? '可继续阅读与复述' : '可从已保存位置继续生成'}</small>}
      </div>
      {mode === 'reading' && snapshot.phase === 'ready' && body && <button type="button" disabled={exportState.busy} title="导出当前教材页的排版 HTML、Markdown 及已生成的交互图" onClick={() => {
        setExportState({ busy: true });
        void (async () => {
          try {
            const api = window.electronAPI?.interactiveFigure;
            if (!api?.portable) throw Error('当前环境不支持导出交互图附件');
            const { buildInteractiveFigureShare, downloadInteractiveFigureShare } = await import('../../services/textbook/interactiveFigureShare');
            const result = await buildInteractiveFigureShare({ noteId, title: snapshot.page?.title || course?.title || '学习教材', body }, { read: api.read, portable: api.portable });
            downloadInteractiveFigureShare(result.bytes, result.name);
            setExportState({ message: result.htmlError ? `Markdown 已导出；HTML 未生成：${result.htmlError}` : result.assetError || result.missingImages || result.missingVisuals ? `已导出；${result.assetError || `${result.missingImages} 张原图、${result.missingVisuals} 张图示未能导出`}` : '本页 HTML 和 Markdown 已导出' });
          } catch (error) { setExportState({ message: error instanceof Error ? error.message : '教材导出失败' }); }
        })();
      }}>{exportState.busy ? '正在导出…' : '导出当前教材页'}</button>}
      {exportState.message && <small role="status">{exportState.message}</small>}
      {onContinue && <button type="button" onClick={() => onContinue(noteId)}>继续心流</button>}
    </div>;
  return <section data-progressive-saved="true" className={`progressive-saved-projection${mode === 'reading' ? ' is-reading' : ''}`}>
    {toolbarTarget ? createPortal(notice, toolbarTarget) : notice}
    {mode === 'reading' && body ? reader : mode === 'all' && body && <details className="textbook-toc" onToggle={event => setOpened(event.currentTarget.open)}>
      <summary>查看已生成教材与目录</summary>
      {opened && reader}
    </details>}
    {course && recordsTarget && createPortal(<ProgressiveLearningRecords course={course} showEmpty />, recordsTarget)}
    {course && !recordsTarget && mode === 'all' && <ProgressiveLearningRecords course={course} />}
  </section>;
}
