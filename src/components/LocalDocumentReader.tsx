import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { readDocumentSource, prepareLocalMaterial, readLocalMaterialCatalog, readLocalMaterialPage, readLocalMaterialImage } from '../services/documentRagClient';
import type { DocumentReadingSource, MaterialCatalog, MaterialExcerpt, MaterialPage } from '../services/textbook/materialTypes';
import { MaterialError } from '../services/textbook/materialScope';
import { isLocalRasterDataUrl } from '../services/textbook/localImages';
import { queueTextbookImageRead } from '../services/textbook/imagePreview';
import { FormulaBlock } from './textbook/FormulaBlock';
import { TextbookVisualGate } from './textbook/TextbookVisualGate';
import './localDocumentReader.css';

const PAGE_CHARS = 8_000;
const plugins = [remarkGfm, remarkMath];
const markdownComponents: Components = {
  pre: ({ node, children }) => {
    const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
    if (code?.type === 'element' && String(code.properties.className || '').includes('math-display')) {
      return <FormulaBlock displayMode latex={code.children.filter(child => child.type === 'text').map(child => child.value).join('')} />;
    }
    return <pre>{children}</pre>;
  },
  code: ({ className, children }) => className?.includes('math-inline')
    ? <FormulaBlock latex={String(children)} /> : <code className={className}>{children}</code>,
  table: ({ children }) => <div className="flow-md-table-wrap"><table>{children}</table></div>,
  img: ({ alt }) => <span>[图片：{alt || '请查看原资料中的图片附件'}]</span>,
};

function LocalImage({ docId, version, blockId, imageIndex, alt }: {
  docId: string; version: string; blockId: string; imageIndex: number; alt: string;
}) {
  const [image, setImage] = useState(''), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setImage(''); setError('');
    void queueTextbookImageRead(async () => {
      const result = await readLocalMaterialImage({ allowedDocIds: [docId], docId, version, blockId, imageIndex });
      if (!isLocalRasterDataUrl(result.dataUrl)) throw new Error('本地图片格式不可用');
      if (!controller.signal.aborted) setImage(result.dataUrl);
    }, controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '图片读取失败'); });
    return () => controller.abort();
  }, [docId, version, blockId, imageIndex, attempt]);
  return image ? <img src={image} alt={alt || '资料图片'} loading="lazy" />
    : <p role={error ? 'alert' : 'status'}>{error || '正在读取图片…'}{error && <button type="button" onClick={() => setAttempt(value => value + 1)}>重试图片</button>}</p>;
}

const Excerpt = React.memo(function Excerpt({ excerpt, docId, version, active }: {
  excerpt: MaterialExcerpt; docId: string; version: string; active: boolean;
}) {
  return <section data-material-block={excerpt.blockId}>
    <ReactMarkdown remarkPlugins={plugins} components={markdownComponents}>{excerpt.text}</ReactMarkdown>
    {excerpt.imageReferences?.map(image => <TextbookVisualGate key={image.imageIndex} active={active} label="资料图片" minHeight={140}>
      <LocalImage docId={docId} version={version} blockId={excerpt.blockId} {...image} />
    </TextbookVisualGate>)}
  </section>;
});

function PdfReader({ source }: { source: Extract<DocumentReadingSource, { kind: 'pdf' }> }) {
  const view = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const guest = view.current;
    const loaded = () => setLoading(false);
    const failed = (event: Event) => {
      const failure = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (failure.errorCode === -3 || failure.isMainFrame === false) return;
      setLoading(false); setError('PDF 暂时无法显示，请重新打开这份资料。');
    };
    guest?.addEventListener('did-stop-loading', loaded);
    guest?.addEventListener('did-fail-load', failed);
    return () => { guest?.removeEventListener('did-stop-loading', loaded); guest?.removeEventListener('did-fail-load', failed); };
  }, [source]);
  return <div className="local-document-pdf">
    {loading && <p role="status">正在载入 PDF…</p>}
    {error && <p role="alert">{error}</p>}
    {React.createElement('webview', { ref: view, src: source.url, className: 'flow-webview',
      title: source.fileName, partition: 'persist:flow-local-document', webpreferences: 'plugins=yes,contextIsolation=yes,sandbox=yes' })}
  </div>;
}

/** Full-source reading independent of vector indexing: one bounded page in the DOM,
 * exact source version on every continuation, no system reader or model invocation. */
export const LocalDocumentReader = React.memo(function LocalDocumentReader({ documentId, title, active = true }: {
  documentId: string; title: string; active?: boolean;
}) {
  const [source, setSource] = useState<DocumentReadingSource>();
  const [catalog, setCatalog] = useState<MaterialCatalog>();
  const [page, setPage] = useState<MaterialPage>();
  const [cursors, setCursors] = useState([0]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const generation = useRef(0), lock = useRef(false), scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const version = ++generation.current;
    const current = () => version === generation.current;
    lock.current = true; setBusy(true); setError(''); setSource(undefined); setCatalog(undefined); setPage(undefined); setCursors([0]);
    void (async () => {
      const nextSource = await readDocumentSource(documentId);
      if (!current()) return;
      setSource(nextSource);
      if (nextSource.kind === 'pdf') return;
      const scope = { allowedDocIds: [documentId], docId: documentId };
      let nextCatalog: MaterialCatalog;
      try { nextCatalog = await readLocalMaterialCatalog({ ...scope, limit: 40 }); }
      catch (reason) {
        if (!current() || !(reason instanceof MaterialError) || reason.code !== 'NOT_PARSED') throw reason;
        await prepareLocalMaterial(scope, documentId);
        if (!current()) return;
        nextCatalog = await readLocalMaterialCatalog({ ...scope, limit: 40 });
      }
      if (!current()) return;
      const nextPage = await readLocalMaterialPage({ ...scope, version: nextCatalog.document.version!, target: { kind: 'document' }, maxChars: PAGE_CHARS, omitImageData: true });
      if (current()) { setCatalog(nextCatalog); setPage(nextPage); }
    })().catch(reason => { if (current()) setError(reason instanceof Error ? reason.message : '资料读取失败'); })
      .finally(() => { if (current()) { lock.current = false; setBusy(false); } });
    return () => { generation.current++; };
  }, [documentId, attempt]);

  const navigate = async (history: number[]) => {
    if (!catalog?.document.version || lock.current) return;
    const version = generation.current;
    lock.current = true; setBusy(true); setError('');
    try {
      const next = await readLocalMaterialPage({ allowedDocIds: [documentId], docId: documentId, version: catalog.document.version,
        target: { kind: 'document' }, cursor: history.at(-1), maxChars: PAGE_CHARS, omitImageData: true });
      if (version !== generation.current) return;
      setPage(next); setCursors(history); scroll.current?.scrollTo({ top: 0 });
    } catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : '正文读取失败，请重试'); }
    finally { if (version === generation.current) { lock.current = false; setBusy(false); } }
  };
  const moreSections = async () => {
    if (!catalog?.nextOffset || lock.current) return;
    const version = generation.current;
    lock.current = true; setBusy(true); setError('');
    try {
      const next = await readLocalMaterialCatalog({ allowedDocIds: [documentId], docId: documentId, version: catalog.document.version, offset: catalog.nextOffset, limit: 40 });
      if (version === generation.current) setCatalog({ ...next, sections: [...catalog.sections, ...next.sections] });
    } catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : '目录读取失败'); }
    finally { if (version === generation.current) { lock.current = false; setBusy(false); } }
  };
  return <div className="local-document-reader" aria-label={`本地资料：${title}`} aria-busy={busy}>
    <div className="local-document-toolbar">
      <strong title={source?.fileName || title}>{source?.fileName || title}</strong>
      {catalog && <select aria-label="跳转资料章节" value="" disabled={busy} onChange={event => {
        const section = catalog.sections.find(item => item.id === event.target.value);
        if (section) void navigate([section.textStart]);
      }}><option value="">跳转章节…</option>{catalog.sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</select>}
      {catalog?.nextOffset !== undefined && <button type="button" disabled={busy} onClick={() => void moreSections()}>更多章节</button>}
    </div>
    {error && <div role="alert" className="local-document-error">{error}<button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取资料</button></div>}
    {source?.kind === 'pdf' ? <PdfReader source={source} /> : <>
      {busy && <p className="local-document-status" role="status">正在读取资料…</p>}
      <div ref={scroll} className="local-document-body focus-flow-note-preview" data-selection-surface="flow" data-selection-source-title={title}>
        {page?.excerpts.map(excerpt => <Excerpt key={`${page.version}:${excerpt.blockId}:${excerpt.textStart}`} excerpt={excerpt} docId={documentId} version={page.version} active={active} />)}
        {!busy && page && !page.excerpts.length && <p>这份资料暂无可显示的正文。</p>}
      </div>
      {page && <nav className="local-document-pages" aria-label="资料正文分页">
        <button type="button" disabled={busy || cursors.length < 2} onClick={() => void navigate(cursors.slice(0, -1))}>上一段</button>
        <span>{Math.min((cursors.at(-1) || 0) + 1, page.targetEnd)}–{page.nextCursor ?? page.targetEnd} / {page.targetEnd} 字符</span>
        <button type="button" disabled={busy || page.nextCursor === undefined} onClick={() => void navigate([...cursors, page.nextCursor!])}>下一段</button>
      </nav>}
    </>}
  </div>;
});
