import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkGeneratedMath } from '../../services/textbook/generatedMath';
import { remarkGeneratedFormatting } from '../../services/textbook/generatedFormatting';
import type { Element } from 'hast';
import type { NoteItem } from '../../types';
import type { TextbookManifest, TextbookReadingState } from '../../services/textbook/types';
import type { TextbookReadingGetter } from '../../services/textbook/readingState';
import { readTextbookBody } from '../../services/textbook/noteContent';
import { isTextbookBlockLanguage, parseControlledTextbookBlock, parseTextbookAnswer, parseTextbookImage, parseTextbookTip, parseTextbookReferences } from '../../services/textbook/contentSchema';
import { remarkTextbookReferences, textbookSections, textbookUrlTransform, type TextbookSection } from '../../services/textbook/markdown';
import { readLocalMaterialImage } from '../../services/documentRagClient';
import { isLocalRasterDataUrl } from '../../services/textbook/localImages';
import { compactPdfImagePreview, queueTextbookImageRead } from '../../services/textbook/imagePreview';
import { PDF_PAGE_IMAGE_INDEX, PDF_FORMULA_IMAGE_INDEX } from '../../services/textbook/localImages';
import { FormulaBlock } from './FormulaBlock';
import { CodeBlock, TextbookFormatFallback } from './CodeBlock';
import { MermaidBlock } from './MermaidBlock';
import { ChartBlock } from './ChartBlock';
import { FunctionPlotBlock } from './FunctionPlotBlock';
import { ScienceDiagramBlock } from './ScienceDiagramBlock';
import { MoleculeBlock } from './MoleculeBlock';
import { SourceReference } from './SourceReference';
import { TextbookVisualGate } from './TextbookVisualGate';
import { registerPendingCapture } from '../../services/agent/dataFreshness';
import { LongDocumentReader } from './LongDocumentReader';
import { noteHeadingMatches, scrollToNoteHeading } from '../../services/ui/noteHeadingNavigation';
import { LONG_READING_THRESHOLD } from '../../services/textbook/readingDocument';
import { needsBackgroundTextbookReading } from '../../services/textbook/readingBudget';
import type { PreparedFormula } from '../../services/textbook/readingFormula';
import { ReadingPresentationContext, useReaderPresentation, useReadingPresentation } from './ReadingPresentation';
import { TextbookQuote } from './TextbookQuote';
import { EmbeddedReadingBody, ReadingAnswer } from './ReadingFragment';
import { ReadingWorkerBoundary } from './ReadingWorkerContext';
import './textbookReader.css';

const EMPTY_NOTES: NoteItem[] = [];
export interface TextbookBlockProps {
  language: string; code: string; manifest?: TextbookManifest; allNotes?: NoteItem[];
  active?: boolean;
  onOpenKnowledge?: (id: string) => void; onOpenDocument?: (id: string) => void | Promise<void>;
}
type MarkdownProps = Omit<TextbookBlockProps, 'language' | 'code'> & { body: string; sections?: TextbookSection[]; background?: boolean };
function plainHastText(node: { type: string; value?: string; children?: unknown[] }): string {
  return node.type === 'text' ? node.value || '' : (node.children || []).map((item) => plainHastText(item as typeof node)).join('');
}
/** Both reader and editable fence previews use this exact gate and renderer. */
export function RenderedTextbookBlock({ language, code, ...props }: TextbookBlockProps) {
  if (!isTextbookBlockLanguage(language)) return <CodeBlock language={language} code={code} />;
  if (language === 'function-plot') return <TextbookVisualGate active={props.active} label="函数图" minHeight={390}><FunctionPlotBlock code={code} /></TextbookVisualGate>;
  try { parseControlledTextbookBlock(language, code, { sourceIds: props.manifest?.sources?.map((item) => item.sourceId), assetIds: props.manifest?.assets?.map((item) => item.id) }); }
  catch (error) { return <TextbookFormatFallback language={language} code={code} message={`格式块暂不可展示：${error instanceof Error ? error.message : '格式无效'}`} />; }
  if (language === 'mermaid') return <TextbookVisualGate active={props.active} label="结构图" minHeight={300}><MermaidBlock code={code} /></TextbookVisualGate>;
  if (language === 'chart') return <TextbookVisualGate active={props.active} label="数据图表" minHeight={390}><ChartBlock code={code} {...props} /></TextbookVisualGate>;
  if (language === 'science-diagram') return <TextbookVisualGate active={props.active} label="理科示意图" minHeight={300}><ScienceDiagramBlock code={code} {...props} /></TextbookVisualGate>;
  if (language === 'molecule') return <TextbookVisualGate active={props.active} label="分子结构" minHeight={300}><MoleculeBlock code={code} {...props} /></TextbookVisualGate>;
  if (language === 'textbook-image') return <TextbookVisualGate active={props.active} label="教材图片" minHeight={120}><TextbookImageBlock code={code} {...props} /></TextbookVisualGate>;
  if (language === 'textbook-references') {
    const references = parseTextbookReferences(code, { sourceIds: props.manifest?.sources?.map(item => item.sourceId) });
    return <TextbookReferencesBlock entries={references.entries} {...props} />;
  }
  if (language === 'textbook-answer') {
    const answer = parseTextbookAnswer(code);
    return <ReadingAnswer title={answer.title}><TextbookMarkdown body={answer.text} {...props} background /></ReadingAnswer>;
  }
  const tip = parseTextbookTip(code);
  return <aside className={`textbook-tip textbook-tip-${tip.kind}`} role="note"><strong>{tip.title}</strong><TextbookMarkdown body={tip.text} {...props} background /></aside>;
}
function TextbookReferencesBlock({ entries, ...props }: Omit<TextbookBlockProps, 'language' | 'code'> & { entries: ReturnType<typeof parseTextbookReferences>['entries'] }) {
  const [opened, setOpened] = useState(false);
  return <details className="textbook-references" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>参考资料（共 {entries.length} 条）</summary>
    {opened && <ul>{entries.map(entry => <li key={entry.sourceId}>
      <SourceReference sourceId={entry.sourceId} {...props} />
      <div className="textbook-reference-entry"><strong>{entry.title}</strong><small>{entry.detail}</small></div>
    </li>)}</ul>}
  </details>;
}
function TextbookImageBlock({ code, manifest, ...props }: Omit<TextbookBlockProps, 'language'>) {
  const presentation = useReadingPresentation();
  const active = props.active !== false;
  const image = parseTextbookImage(code, { assetIds: manifest?.assets?.map((item) => item.id) });
  const asset = manifest?.assets?.find((item) => item.id === image.assetId);
  const source = manifest?.sources?.find((item) => item.sourceId === asset?.sourceId);
  const [state, setState] = useState<{ dataUrl?: string; preview?: string; error?: string }>({});
  const [expanded, setExpanded] = useState(false);
  const completed = useRef(false);
  useEffect(() => {
    completed.current = false; setState({}); setExpanded(false);
  }, [asset, source]);
  useEffect(() => {
    if (!active || completed.current) return;
    let cancelled = false, cancelPublish = () => {};
    const controller = new AbortController();
    const webImage = source?.kind === 'web' && !!asset?.attachmentHash && asset.blockId === `${source.id}:web-image:${asset.imageIndex}`;
    if (!asset || !source || (!webImage && (source.kind !== 'document' || source.blockId !== asset.blockId)) || source.id !== asset.docId || source.version !== asset.version)
      { setState({ error: '图片指针与授权资料版本/原文块不匹配' }); return; }
    void queueTextbookImageRead(async () => {
        if (cancelled) return;
        const result = await readLocalMaterialImage({ allowedDocIds: [asset.docId], docId: asset.docId, version: asset.version, blockId: asset.blockId, imageIndex: asset.imageIndex,
          ...(asset.attachmentHash ? { attachmentHash: asset.attachmentHash } : {}) });
        if (cancelled) return;
        if (!isLocalRasterDataUrl(result.dataUrl)) throw new Error('只能展示已读取的有限大小本地 PNG/JPEG/GIF/WebP 图片');
        const preview = asset.imageIndex >= PDF_PAGE_IMAGE_INDEX ? await compactPdfImagePreview(result.dataUrl) : result.dataUrl;
        if (!cancelled) {
          const publish = () => { if (!cancelled) { completed.current = true; setState({ dataUrl: result.dataUrl, preview }); } };
          if (presentation) cancelPublish = presentation.enqueue(publish); else publish();
        }
      }, controller.signal).catch((error) => { if (!cancelled) setState({ error: error instanceof Error ? error.message : '本地图片不可用' }); });
    return () => { cancelled = true; controller.abort(); cancelPublish(); };
  }, [asset, source, active, presentation]);
  if (state.error) return <TextbookFormatFallback language="textbook-image" code={code} message={`图片无法显示：${state.error}`} />;
  return <figure className={`textbook-image${asset && asset.imageIndex >= PDF_FORMULA_IMAGE_INDEX ? ' is-formula-image' : ''}`}>
    {state.dataUrl ? <>
      <button type="button" className="textbook-image-toggle" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起为紧凑预览' : '查看完整原图'}</button>
      <div className={expanded ? 'textbook-image-viewport is-expanded' : 'textbook-image-viewport'}>
        <img src={expanded ? state.dataUrl : state.preview || state.dataUrl} alt={asset?.alt || image.caption || '本地教材图片'} loading="lazy" onError={() => setState({ error: '本地图片字节无法解码；原始来源保持不变' })} />
      </div>
    </> : <p role="status">正在读取本地图片…</p>}
    <figcaption>{image.caption || asset?.alt}{asset && <SourceReference sourceId={asset.sourceId} manifest={manifest} {...props} />}</figcaption>
    {asset && !asset.attachmentHash && <small className="textbook-image-source-only">此图依赖原资料，尚未保存为独立教材附件。</small>}
  </figure>;
}
const TextbookMarkdownContext = createContext<Omit<TextbookBlockProps, 'language' | 'code'>>({});
// Renderer component identities must not change on timers, progress saves or note-array updates.
// Context delivers fresh source/navigation data without unmounting diagrams or open dialogs.
const textbookMarkdownComponents: Components = {
    blockquote: TextbookQuote,
    pre: function TextbookPre({ node }) {
      const props = useContext(TextbookMarkdownContext);
      const codeNode = node?.children.find((item) => item.type === 'element' && item.tagName === 'code') as Element | undefined;
      if (!codeNode) return <pre>{plainHastText(node as never)}</pre>;
      const classes = String(codeNode.properties.className || '').split(/[ ,]+/u);
      const code = plainHastText(codeNode);
      if (classes.includes('math-display')) return <FormulaBlock latex={code} displayMode prepared={codeNode.data?.preparedFormula as PreparedFormula | undefined} />;
      const language = classes.find((item) => item.startsWith('language-'))?.slice(9) || '';
      return <RenderedTextbookBlock language={language} code={code.replace(/\n$/u, '')} {...props} />;
    },
    code: ({ className, children, node }) => className?.includes('math-inline')
      ? <FormulaBlock latex={String(children)} prepared={node?.data?.preparedFormula as PreparedFormula | undefined} /> : <code>{children}</code>,
    a: function TextbookLink({ href, children, node: _node, ...attributes }) {
      const props = useContext(TextbookMarkdownContext);
      return href?.startsWith('source:') ? <SourceReference sourceId={href.slice(7)} {...props} />
        : href?.startsWith('#') ? <a href={href} {...attributes}>{children}</a> : <span title="教材不自动访问未经采集的外部链接">{children}</span>;
    },
    img: ({ alt }) => <span className="textbook-format-error">[图片未授权：{alt || '请使用本地素材 ID'}]</span>,
    table: ({ children }) => <div className="textbook-table-scroll" tabIndex={0}><table>{children}</table></div>,
};
// Parse only when the document/schema changes. Fresh source/navigation context
// can update open citations without reparsing thousands of unchanged text nodes.
const ParsedTextbookMarkdown = React.memo(function ParsedTextbookMarkdown({ body, sections, manifest }: Pick<MarkdownProps, 'body' | 'sections' | 'manifest'>) {
  const plugins = useMemo(() => [[remarkGfm, { footnoteLabel: '注释', footnoteBackLabel: '返回正文引用' }], remarkMath,
    remarkGeneratedFormatting, [remarkTextbookReferences, { manifest, sections }], [remarkGeneratedMath, { scope: 'all', citationIds: manifest?.sources?.map(source => source.sourceId) }]] as any, [manifest, sections]);
  return <ReactMarkdown remarkPlugins={plugins} remarkRehypeOptions={{ footnoteLabel: '注释', footnoteBackLabel: '返回正文引用' }} skipHtml urlTransform={textbookUrlTransform} components={textbookMarkdownComponents}>{body}</ReactMarkdown>;
});
export function TextbookMarkdown({ body, sections, manifest, allNotes, onOpenKnowledge, onOpenDocument, active = true, background = false }: MarkdownProps) {
  const callbacks = useRef({ onOpenKnowledge, onOpenDocument }); callbacks.current = { onOpenKnowledge, onOpenDocument };
  const navigation = useMemo(() => ({
    onOpenKnowledge: onOpenKnowledge ? (id: string) => callbacks.current.onOpenKnowledge?.(id) : undefined,
    onOpenDocument: onOpenDocument ? (id: string) => callbacks.current.onOpenDocument?.(id) : undefined,
  }), [Boolean(onOpenKnowledge), Boolean(onOpenDocument)]);
  const context = useMemo(() => ({ manifest, allNotes, active, ...navigation }), [manifest, allNotes, active, navigation]);
  const prepared = useMemo(() => background || needsBackgroundTextbookReading(body, LONG_READING_THRESHOLD), [body, background]);
  return <ReadingWorkerBoundary><TextbookMarkdownContext.Provider value={context}>
    {prepared ? <EmbeddedReadingBody body={body} manifest={manifest} active={active} fragmentKind="textbook" components={textbookMarkdownComponents} />
      : <ParsedTextbookMarkdown body={body} sections={sections} manifest={manifest} />}
  </TextbookMarkdownContext.Provider></ReadingWorkerBoundary>;
}
export interface TextbookReaderProps {
  note: NoteItem; allNotes?: NoteItem[]; className?: string;
  active?: boolean;
  interactive?: boolean;
  onOpenKnowledge?: (id: string) => void; onOpenDocument?: (id: string) => void | Promise<void>;
  onReadingPosition?: (position: { blockAnchor?: string; scrollTop: number }) => void;
  readingPosition?: Partial<TextbookReadingState>;
  getReadingPosition?: TextbookReadingGetter;
  selectionSurface?: 'flow' | 'note';
  headingRequest?: import('../../services/ui/noteHeadingNavigation').NoteHeadingRequest;
  onHeadingResolved?: (found: boolean) => void;
}
export function TextbookReader(props: TextbookReaderProps) {
  const snapshot = useRef<TextbookReaderProps | null>(null);
  if (props.active !== false) snapshot.current = props;
  const content = snapshot.current?.note.content || '';
  const manifest = snapshot.current?.note.textbook;
  const body = useMemo(() => manifest ? readTextbookBody(content, manifest) : content, [content, manifest]);
  const background = useMemo(() => needsBackgroundTextbookReading(body || '', LONG_READING_THRESHOLD), [body]);
  if (!snapshot.current) return null;
  // A retained, hidden reader must not parse every newly saved editor draft.
  // Still propagate inactivity immediately to close dialogs/cancel visual work.
  const current = { ...snapshot.current, active: props.active, interactive: props.interactive };
  if (current.note.textbook && background) return <LongTextbookReader key={`${current.note.id}:${current.note.textbook.revisionId}`} {...current} />;
  return <ContinuousTextbookReader {...current} />;
}
function LongTextbookReader({ note, allNotes = EMPTY_NOTES, onOpenKnowledge, onOpenDocument, ...props }: TextbookReaderProps) {
  const callbacks = useRef({ onOpenKnowledge, onOpenDocument }); callbacks.current = { onOpenKnowledge, onOpenDocument };
  const navigation = useMemo(() => ({
    onOpenKnowledge: onOpenKnowledge ? (id: string) => callbacks.current.onOpenKnowledge?.(id) : undefined,
    onOpenDocument: onOpenDocument ? (id: string) => callbacks.current.onOpenDocument?.(id) : undefined,
  }), [Boolean(onOpenKnowledge), Boolean(onOpenDocument)]);
  const context = useMemo(() => ({ manifest: note.textbook, allNotes, active: props.interactive ?? (props.active !== false), ...navigation }), [note.textbook, allNotes, props.active, props.interactive, navigation]);
  return <TextbookMarkdownContext.Provider value={context}>
    <LongDocumentReader {...props} content={note.content} manifest={note.textbook} noteId={note.id} title={note.title} components={textbookMarkdownComponents} />
  </TextbookMarkdownContext.Provider>;
}
function ContinuousTextbookReader({ note, allNotes = EMPTY_NOTES, onOpenKnowledge, onOpenDocument, onReadingPosition, readingPosition, getReadingPosition, className = '', selectionSurface = 'note', active = true, interactive = active, headingRequest, onHeadingResolved }: TextbookReaderProps) {
  const manifest = note.textbook;
  const body = useMemo(() => manifest ? readTextbookBody(note.content, manifest) : null, [note.content, manifest]);
  const sections = useMemo(() => body === null ? [] : textbookSections(body, manifest), [body, manifest]);
  const reader = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const presentation = useReaderPresentation(reader, active);
  const appliedHeading = useRef<string | undefined>(undefined);
  const headingCallback = useRef(onHeadingResolved); headingCallback.current = onHeadingResolved;
  const callback = useRef(onReadingPosition); callback.current = onReadingPosition;
  const pendingPosition = useRef<{ value: { blockAnchor?: string; scrollTop: number }; callback?: TextbookReaderProps['onReadingPosition'] } | undefined>(undefined);
  const restoring = useRef(false);
  const viewport = useRef<{ noteId: string; revisionId?: string; scrollTop: number; blockAnchor?: string } | undefined>(undefined);
  const cancelRestore = useRef<() => void>(() => {});
  const savedPosition = useRef(readingPosition || note.textbookReadingState);
  savedPosition.current = (manifest && getReadingPosition?.(note.id, manifest.revisionId)) || readingPosition || note.textbookReadingState;
  useLayoutEffect(() => {
    const root = reader.current;
    const retained = viewport.current;
    const position = retained?.noteId === note.id && retained.revisionId === manifest?.revisionId ? retained : savedPosition.current;
    if (!active || !root || !position || position.revisionId !== manifest?.revisionId) return;
    restoring.current = true;
    let stopped = false;
    const restore = () => {
      if (stopped) return;
      const element = position.blockAnchor ? [...root.querySelectorAll<HTMLElement>('[data-textbook-anchor]')].find((item) => item.id === position.blockAnchor) : undefined;
      // Same revision resumes within a long chapter, not merely at its heading.
      if (typeof position.scrollTop === 'number' && Number.isFinite(position.scrollTop)) root.scrollTop = Math.max(0, position.scrollTop);
      else if (element) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top;
      viewport.current = { noteId: note.id, revisionId: manifest?.revisionId, scrollTop: root.scrollTop, blockAnchor: position.blockAnchor };
    };
    restore();
    const frame = requestAnimationFrame(restore);
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (restoring.current) restore(); }) : undefined;
    const article = root.querySelector('article'); if (article) resize?.observe(article);
    const stop = () => {
      stopped = true; restoring.current = false; resize?.disconnect();
      cancelAnimationFrame(frame); clearTimeout(expire);
    };
    const expire = setTimeout(stop, 2000);
    cancelRestore.current = stop;
    return stop;
  }, [note.id, manifest?.revisionId, active]);
  const flushPosition = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const pending = pendingPosition.current; pendingPosition.current = undefined;
    if (pending) pending.callback?.(pending.value);
  };
  useEffect(() => {
    const releaseCapture = registerPendingCapture(flushPosition);
    // Capture phase publishes the last buffered position before App's leave
    // guard checks its pending ref, including native close while scrolling.
    window.addEventListener('beforeunload', flushPosition, true);
    return () => {
      releaseCapture();
      window.removeEventListener('beforeunload', flushPosition, true);
      // The pending value owns its captured old project/revision callback.
      flushPosition();
    };
  }, [note.id, manifest?.revisionId]);
  const capturePosition = () => {
    const root = reader.current; if (!root) return;
    const top = root.getBoundingClientRect().top;
    const headings = root.querySelectorAll<HTMLElement>('[data-textbook-anchor]');
    // Ordered headings: logarithmic layout reads instead of walking the whole
    // book on every scroll event, including when near its final chapter.
    let low = 0, high = headings.length;
    while (low < high) { const mid = (low + high) >>> 1; if (headings[mid].getBoundingClientRect().top <= top + 85) low = mid + 1; else high = mid; }
    const anchor = low ? headings[low - 1].id : undefined;
    viewport.current = { noteId: note.id, revisionId: manifest?.revisionId, blockAnchor: anchor, scrollTop: root.scrollTop };
    pendingPosition.current = { value: { blockAnchor: anchor, scrollTop: root.scrollTop }, callback: callback.current };
  };
  const scroll = () => {
    if (!active || restoring.current) return;
    capturePosition();
    // Leading update protects exit immediately; the fixed trailing deadline
    // publishes the newest position even throughout continuous scrolling.
    if (timer.current === undefined) { flushPosition(); timer.current = setTimeout(flushPosition, 180); }
  };
  const jump = (anchor: string) => {
    const root = reader.current, element = root?.querySelector<HTMLElement>(`#${anchor}`);
    if (!root || !element) return;
    cancelRestore.current();
    root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - 20; capturePosition(); flushPosition();
    element.setAttribute('tabindex', '-1'); element.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!active || body === null || !headingRequest || appliedHeading.current === headingRequest.key || !reader.current) return;
    appliedHeading.current = headingRequest.key;
    const section = sections.find(section => noteHeadingMatches(section.title, headingRequest.heading));
    let found = Boolean(section);
    if (section) jump(section.anchor);
    else {
      cancelRestore.current();
      const prose = reader.current.querySelector<HTMLElement>('.textbook-prose');
      found = Boolean(prose && scrollToNoteHeading(prose, headingRequest.heading));
      if (found) { capturePosition(); flushPosition(); }
    }
    headingCallback.current?.(found);
  }, [active, body, sections, headingRequest?.key, headingRequest?.heading]);
  if (body === null) return <div className="textbook-format-error" role="status">{manifest ? '教材边界损坏，未猜测或展示个人复盘内容；请回到笔记编辑器恢复边界。' : '该项目还没有教材，请先由 Agent 准备并经你确认后生成。'}</div>;
  return <ReadingPresentationContext.Provider value={presentation}><div className={`textbook-reader ${className}`} ref={reader} onScroll={scroll}
    onWheel={() => cancelRestore.current()} onTouchStart={() => cancelRestore.current()}
    onPointerDown={() => cancelRestore.current()} onKeyDown={() => cancelRestore.current()}>
    <header className="textbook-reader-header"><span>项目教材 · {manifest!.revisionId.slice(0, 10)}</span><p>只展示教材内容。个人复述与论证结构图保留在笔记的学习记录中。</p></header>
    {!!sections.length && <nav className="textbook-toc" aria-label="教材章节目录"><details><summary>章节目录（{sections.length}）</summary><ol>{sections.map((section) => <li key={section.anchor}><button type="button" onClick={() => jump(section.anchor)}>{section.title}</button></li>)}</ol></details></nav>}
    <article className="textbook-prose" aria-label="项目教材" data-selection-surface={selectionSurface} data-selection-source-id={note.id} data-selection-context-id={note.id} data-selection-source-title={note.title} data-selection-note-id={note.id}><TextbookMarkdown body={body} manifest={manifest} sections={sections} allNotes={allNotes} active={interactive} onOpenKnowledge={onOpenKnowledge} onOpenDocument={onOpenDocument} /></article>
  </div></ReadingPresentationContext.Provider>;
}
