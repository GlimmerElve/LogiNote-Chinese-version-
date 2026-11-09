import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { progressiveProvenance } from '../../services/progressiveLearning/sourcePolicy';
import type { ProgressiveController, ProgressiveRuntimeSnapshot } from '../../services/progressiveLearning/runtime';
import { TextbookMarkdown } from '../textbook/TextbookReader';
import { ProgressiveQuiz } from './ProgressiveQuiz';
import { ProgressiveContextMenu, captureProgressiveScope, type ProgressiveMenuState } from './ProgressiveContextMenu';
import { QuickCheckText } from '../quickCheck/QuickCheckText';
import './progressiveCourse.css';
import { ReadingPresentationContext, useReaderPresentation } from '../textbook/ReadingPresentation';
import { ReadingWorkerProvider } from '../textbook/ReadingWorkerContext';
import type { ProgressiveSupplementScope } from '../../services/progressiveLearning/types';

const LessonBlock = memo(function LessonBlock({ body, active }: { body: string; active: boolean }) {
  return <TextbookMarkdown body={body} active={active} />;
});

/** Subscribe below FlowMode so token output does not rerender its other two columns. */
export function ProgressiveLessonPanel({ controller, active, onFigureBody, onFigure }: { controller: ProgressiveController; active: boolean; onFigureBody?: (body: string | null) => void; onFigure?: (scope: ProgressiveSupplementScope) => void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const figureBody = snapshot.phase === 'ready' ? snapshot.page?.body || snapshot.course?.page?.body || snapshot.course?.firstPage?.body || null : null;
  useEffect(() => { onFigureBody?.(figureBody); }, [onFigureBody, figureBody]);
  const savePosition = useCallback((scrollTop: number) => controller.saveProgress({ scrollTop }), [controller]);
  return <ProgressiveCourseReader snapshot={snapshot} active={active}
    onRetry={() => { void controller.retry().catch(() => {}); }}
    onRetrySave={() => { void controller.flush().catch(() => {}); }}
    onNext={() => { void controller.next().catch(() => {}); }}
    onNavigate={id => { void controller.navigate(id).catch(() => {}); }}
    controller={controller} onFigure={onFigure}
    onReadingPosition={savePosition} />;
}

interface Props {
  snapshot: ProgressiveRuntimeSnapshot;
  active?: boolean;
  onRetry: () => void;
  onRetrySave: () => void;
  onReadingPosition: (scrollTop: number) => void;
  onNext?: () => void;
  onNavigate?: (id: string) => void;
  controller?: ProgressiveController;
  readOnly?: boolean;
  onFigure?: (scope: ProgressiveSupplementScope) => void;
}

/** Completed blocks stay stable while only the unfinished tail receives tokens. */
export function ProgressiveCourseReader({ snapshot, active = true, onRetry, onRetrySave, onReadingPosition, onNext, onNavigate, controller, readOnly = false, onFigure }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const presentation = useReaderPresentation(viewport, active);
  const restored = useRef<string | null>(null);
  const [menu, setMenu] = useState<ProgressiveMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const course = snapshot.course;
  const pageId = snapshot.page?.id || course?.progress.currentPageId || course?.generation.pageId;
  const ready = snapshot.phase === 'ready';
  const body = snapshot.page?.body || course?.firstPage?.body || course?.generation.bodyDraft || '';
  const blocks = snapshot.blocks.length ? snapshot.blocks : ready && body ? [body] : [];
  const title = snapshot.page?.title || course?.firstPage?.title || '';
  const visibleBlocks = blocks.filter((block, index) => index !== 0
    || !/^#{1,6}\s+/u.test(block.trim())
    || block.trim().replace(/^#{1,6}\s+/u, '').trim() !== title);
  const descriptor = course?.pages?.find(page => page.id === pageId);
  const mainlineIndex = descriptor?.mainlineIndex ?? course?.generation.mainlineIndex ?? 0;
  const objectives = snapshot.plan?.pages[mainlineIndex]?.objectives || [];
  const remaining = snapshot.plan?.pages.filter(page => !course?.pages?.some(saved => saved.id === page.id)) || [];
  const questions = course?.page?.questions || course?.firstPage?.questions || [];
  // Explicit user supplements are independent of the automatic course budget.
  // Automatic next-page routing still uses the backend's bounded availability.
  const canManualExpand = Boolean(ready && controller && active && !readOnly && descriptor);
  const canAutoExpand = Boolean(course?.currentFeedback?.fresh && course.currentFeedback.expansionAvailable);
  useEffect(closeMenu, [pageId, course?.id, descriptor?.contentHash, active, closeMenu]);
  const pending = ready ? '' : snapshot.pendingText;
  const error = snapshot.saveError || snapshot.error;
  const loading = ['loading', 'idle'].includes(snapshot.phase) && !body;
  const generating = snapshot.phase === 'generating';
  const sourcePackets=course?.page?.sourcePackets||course?.firstPage?.sourcePackets||course?.sourcePackets;
  const provenance=useMemo(()=>progressiveProvenance(sourcePackets||[],body),[sourcePackets,body]);
  const hasBoundSources=provenance.sources.length>0;

  useEffect(() => {
    const key = course ? `${course.id}:${pageId}` : null;
    if (!active || !course || !viewport.current || restored.current === key) return;
    // A scroll write can force workspace-wide style/layout. Restore after the
    // commit and cancel it when a quick project switch abandons this reader.
    const frame = requestAnimationFrame(() => {
      if (!viewport.current) return;
      viewport.current.scrollTop = course.progress.scrollTop;
      restored.current = key;
    });
    const element = viewport.current;
    const userMoved = () => { cancelAnimationFrame(frame); restored.current = key; };
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    inputs.forEach(type => element.addEventListener(type, userMoved, { passive: true }));
    return () => { cancelAnimationFrame(frame); inputs.forEach(type => element.removeEventListener(type, userMoved)); };
  }, [active, course?.id, pageId, body.length]);
  useEffect(() => () => {
    if (!readOnly && viewport.current && restored.current) onReadingPosition(viewport.current.scrollTop);
  }, [onReadingPosition, readOnly]);

  return <ReadingWorkerProvider><ReadingPresentationContext.Provider value={presentation}><div ref={viewport} className="textbook-reader progressive-course-reader"
    data-progressive-course="true" data-course-id={course?.id || ''} data-page-id={pageId || ''}
    data-status={snapshot.phase} aria-busy={generating || loading}
    data-first-token-ms={snapshot.timings?.firstTokenMs ?? undefined}
    data-first-readable-ms={snapshot.timings?.firstReadableMs ?? undefined}
    data-page-complete-ms={snapshot.timings?.pageCompleteMs ?? undefined}
    data-page-saved-ms={snapshot.timings?.pageSavedMs ?? undefined}
    onContextMenu={event => {
      if (!controller || !ready || !descriptor || !active || readOnly) return;
      const scope = captureProgressiveScope(event, descriptor.contentHash); if (!scope) return;
      event.preventDefault(); event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, pageId: pageId!, courseId: course!.id, scope, canMainline: remaining.length > 0, canExpand: canManualExpand });
    }}
    onScroll={event => { if (restored.current && controller) onReadingPosition(event.currentTarget.scrollTop); }}>
    <div className="progressive-reading-toolbar">
    <header className="progressive-course-heading">
      <span>{snapshot.plan ? `${descriptor?.kind === 'expansion' || course?.generation.kind === 'expansion' && !ready ? '补充讲解 · ' : ''}主线 ${mainlineIndex + 1} / ${snapshot.plan.pages.length}` : '正在准备学习主线'}</span>
      <span className="progressive-save-state" role="status">{snapshot.saveError ? '尚未保存'
        : snapshot.isDirty || snapshot.phase === 'saving' ? '正在保存'
          : ready ? '已保存' : generating ? '正在生成' : snapshot.phase === 'interrupted' ? '生成已暂停' : '学习内容'}</span>
    </header>
    {course && <details className={`progressive-course-provenance${provenance.excluded || provenance.invalidMarkers ? ' is-warning' : ''}`} data-teaching-provenance={hasBoundSources?'bound-excerpts':provenance.excluded?'unusable-excerpts':'model-knowledge'}>
      <summary>{hasBoundSources ? `查看参考片段（${provenance.sources.length} 段）` : provenance.excluded ? '参考片段不可用' : '未提供资料片段'}{provenance.invalidMarkers > 0 ? ` · ${provenance.invalidMarkers} 处待核对` : ''}</summary>
      <div className="progressive-provenance-details">
      <p>{hasBoundSources?`已提供参考片段：${provenance.sources.length} 段 · ${provenance.characters} 字符 · 正文来源标记 ${provenance.markers} 处`
        :provenance.excluded?'该页保存的参考片段缺少可用正文，不能用于核实教材内容。':'讲解依据：模型已有知识，未提供可用的资料正文片段'}</p>
      {provenance.invalidMarkers>0&&<p>有 {provenance.invalidMarkers} 处来源标记没有可用片段可核对。</p>}
      {hasBoundSources&&<>
        <p>以下为生成时提供的局部材料，来源标记不代表逐条论述已核实。</p>
        {provenance.sources.map(source=><details key={source.id}><summary>{source.id} · {source.title} · {source.text.length} 字符{source.locator?.includes(' / ')?` · ${source.locator.split(' / ').slice(1).join(' / ')}`:''}</summary><pre style={{whiteSpace:'pre-wrap'}}>{source.text}</pre></details>)}
      </>}
      </div>
    </details>}
    {snapshot.plan && <details className="textbook-toc progressive-course-toc">
      <summary>学习主线（{snapshot.plan.pages.length} 页）</summary>
      <ol>{snapshot.plan.pages.map(page => <li key={page.id} aria-current={pageId === page.id ? 'page' : undefined}>
        <button type="button" disabled={!ready || !course?.pages?.some(saved => saved.id === page.id)} onClick={() => onNavigate?.(page.id)}><QuickCheckText text={page.title} /></button>
        <small>{course?.pages?.some(saved => saved.id === page.id) ? '已生成' : pageId === page.id ? '生成中' : '未生成'}</small>
        {course?.pages?.filter(saved => saved.parentPageId === page.id).map(extra => <div key={extra.id} className="progressive-expansion-entry">
          <button type="button" disabled={!ready} onClick={() => onNavigate?.(extra.id)} aria-current={pageId === extra.id ? 'page' : undefined}><QuickCheckText text={extra.title} /></button>
        </div>)}
      </li>)}</ol>
    </details>}
    </div>
    {error && <div className="progressive-course-error" role="alert">
      <p>{error}</p>
      {!readOnly && <button type="button" onClick={snapshot.saveError ? onRetrySave : onRetry}
        disabled={generating || snapshot.phase === 'saving'}>
        {snapshot.saveError ? '重试保存' : body ? '继续生成' : '重新尝试'}
      </button>}
    </div>}
    {!error && snapshot.phase === 'interrupted' && <div className="progressive-course-error" role="status">
      <p>生成已暂停，已保存的讲解和复述仍然保留。</p>
      {!readOnly && <button type="button" onClick={onRetry}>继续生成</button>}
    </div>}
    {loading && <p className="progressive-course-loading" role="status">正在准备主线与第一页讲解…</p>}
    <article className="textbook-prose progressive-lesson" data-lesson-content>
      {title && <h1><QuickCheckText text={title} /></h1>}
      {objectives.length ? <div className="progressive-objectives">
        <strong>本页学习目标</strong><ul>{objectives.map((objective, index) => <li key={index}><QuickCheckText text={objective} /></li>)}</ul>
      </div> : null}
      {visibleBlocks.map((block, index) => <LessonBlock key={index} body={block} active={active} />)}
      {pending && <div className="progressive-stream-tail" aria-label="正在生成的段落">{pending}</div>}
      {generating && <p className="progressive-course-loading" role="status">{body.trim() ? '正在续写讲解，可以继续阅读和复述…'
        : snapshot.modelActivity?.phase === 'reasoning' ? '模型正在思考，尚未开始输出正文'
        : snapshot.modelActivity?.phase === 'responding' ? '正在生成正文，可读内容即将显示…' : '正在等待模型响应'}</p>}
      {!questions.length && (snapshot.page?.hook || course?.firstPage?.hook) && <aside className="progressive-reflection-hook">
        <strong>想一想，用自己的话说说</strong>
        <p><QuickCheckText text={(snapshot.page?.hook || course?.firstPage?.hook)!.prompt} /></p>
      </aside>}
    </article>
    {ready && controller && <ProgressiveQuiz pageId={pageId!} questions={questions} study={snapshot.study}
      busy={Boolean(snapshot.studyBusy)} busyQuestions={snapshot.studyBusyQuestions} error={snapshot.studyError} controller={controller} />}
    {ready && readOnly && questions.length > 0 && <section className="progressive-quiz" aria-label="本页题目预览">
      {questions.map(question => <div key={question.id} className="progressive-question"><QuickCheckText text={question.prompt} recoverPlainMath />
        {question.options && <ol>{question.options.map(option => <li key={option.id}><QuickCheckText text={option.text} recoverPlainMath /></li>)}</ol>}
      </div>)}<p className="progressive-course-footnote">可进入心流作答；已有作答可在学习记录中查看。</p>
    </section>}
    {ready && <footer className="progressive-course-footer">
      <p className="progressive-course-footnote">本页已保存。{remaining.length ? '请在右侧记录理解，再继续下一页。' : '主线讲解已全部生成，仍可复述并退出保存。'}</p>
      {(remaining.length > 0 || canAutoExpand) && onNext && <button type="button" className="progressive-next-page" onClick={onNext}>下一页</button>}
    </footer>}
    {ready && course?.lastDecision && course.lastDecision.requestId === course.generation.requestId && <p className="progressive-course-footnote">{course.lastDecision.reason}</p>}
    {menu && controller && active && <ProgressiveContextMenu menu={menu} onClose={closeMenu} onFigure={onFigure && (scope => {
      const current = controller.getSnapshot();
      if (menu.courseId === current.course?.id && menu.pageId === current.page?.id
        && scope.pageHash === current.course?.pages?.find(page => page.id === menu.pageId)?.contentHash) onFigure(scope);
    })} onAction={(intent, scope) => {
      if (menu.courseId === controller.getSnapshot().course?.id && menu.pageId === controller.getSnapshot().page?.id) void controller.next(intent, scope).catch(() => {});
    }} />}
  </div></ReadingPresentationContext.Provider></ReadingWorkerProvider>;
}
