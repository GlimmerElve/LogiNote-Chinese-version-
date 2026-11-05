import React, { useContext, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteItem } from '../../types';
import type { TextbookManifest } from '../../services/textbook/types';
import { openDocument } from '../../services/documentRagClient';
import { readSourceEvidence } from '../../services/textbook/sourceEvidence';
export { readSourceEvidence } from '../../services/textbook/sourceEvidence';
export type { TextbookSourcePointer } from '../../services/textbook/sourceEvidence';
import { textbookPublicUrl } from '../../services/textbook/boundUrls';
import { useDialog } from '../useDialog';
import { useResourceOpen } from '../useResourceOpen';
import { ResourceOpenFeedback } from '../ResourceOpenFeedback';
import { TextbookSourceContext } from './TextbookSourceContext';

export interface SourceReferenceProps {
  sourceId: string; manifest?: TextbookManifest; allNotes?: NoteItem[];
  active?: boolean;
  onOpenKnowledge?: (id: string) => void | Promise<void>; onOpenDocument?: (id: string) => void | Promise<void>;
}
const EMPTY_NOTES: NoteItem[] = [];
export function SourceReference(props: SourceReferenceProps) {
  const inherited = useContext(TextbookSourceContext);
  const { sourceId, manifest } = props;
  const allNotes = props.allNotes ?? inherited?.allNotes ?? EMPTY_NOTES;
  const onOpenKnowledge = props.onOpenKnowledge ?? inherited?.onOpenKnowledge;
  const onOpenDocument = props.onOpenDocument ?? inherited?.onOpenDocument;
  const active = props.active ?? inherited?.active ?? true;
  const source = manifest?.sources?.find((item) => item.sourceId === sourceId);
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [evidence, setEvidence] = useState<{ text: string; nextCursor?: number }>({ text: '' }), [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null); const heading = useId(); const requestRevision = useRef(0);
  const mounted = useRef(false), readLock = useRef<symbol | null>(null);
  const readStarted = useRef(false);
  const evidenceRef = useRef(evidence); evidenceRef.current = evidence;
  const [failedRead, setFailedRead] = useState<'initial' | 'more' | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const openFeedback = useRef<HTMLDivElement>(null);
  const close = () => { requestRevision.current++; readLock.current = null; setOpened(false); };
  useDialog(active && opened && Boolean(source), dialog, close);
  useLayoutEffect(() => { if (!active && opened) close(); }, [active, opened]);
  const currentNotes = useRef(allNotes); currentNotes.current = allNotes;
  const knowledgeNote = source?.kind === 'knowledge' ? allNotes.find((item) => item.id === source.id) : undefined;
  const knowledgeAliases = knowledgeNote?.aliases?.join('\n');
  // Parent rerenders may recreate the manifest: ownership follows content, not object identity.
  const sourceKey = useMemo(() => JSON.stringify([manifest?.projectNoteId, source, knowledgeNote?.title, knowledgeNote?.content, knowledgeAliases]),
    [manifest?.projectNoteId, source, knowledgeNote?.title, knowledgeNote?.content, knowledgeAliases]);
  const sourceOwner = useRef(sourceKey);
  const original = useResourceOpen(`${sourceKey}:${opened}`, async () => {
    if (!source) throw new Error('missing-source');
    if (source.kind === 'knowledge') {
      if (!onOpenKnowledge) throw new Error('missing-navigation');
      await onOpenKnowledge(source.id);
    } else if (source.kind === 'web') {
      const bridge = (window as unknown as { electronAPI?: { openExternal(url: string): Promise<void> } }).electronAPI;
      if (!source.web || !bridge?.openExternal) throw new Error('missing-web-opener');
      await bridge.openExternal(textbookPublicUrl(source.web.finalUrl));
    } else await (onOpenDocument ? onOpenDocument(source.id) : openDocument(source.id));
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestRevision.current++; }; }, []);
  useLayoutEffect(() => {
    sourceOwner.current = sourceKey; requestRevision.current++; readLock.current = null; readStarted.current = false;
    evidenceRef.current = { text: '' };
    // Newly mounted citations are already empty. A fresh empty object here
    // forced every citation into a second synchronous layout-effect render.
    setEvidence(previous => previous.text || previous.nextCursor !== undefined ? { text: '' } : previous);
    setError(''); setFailedRead(null); setBusy(false);
  }, [sourceKey, opened]);
  const load = async (kind: 'initial' | 'more') => {
    if (!active || !source || !opened || readLock.current || original.isBusy() || sourceOwner.current !== sourceKey) return;
    const cursor = kind === 'more' ? evidenceRef.current.nextCursor : undefined;
    if (kind === 'more' && cursor === undefined) return;
    const token = Symbol('source-read'), revision = requestRevision.current;
    readLock.current = token; setBusy(true); setError(''); setFailedRead(null);
    const current = () => mounted.current && revision === requestRevision.current && sourceOwner.current === sourceKey;
    try {
      const value = await readSourceEvidence(source, currentNotes.current, cursor, manifest?.projectNoteId);
      if (!current()) return;
      const next = kind === 'more' ? { text: `${evidenceRef.current.text}\n${value.text}`, nextCursor: value.nextCursor } : value;
      evidenceRef.current = next; setEvidence(next);
    } catch {
      if (current()) { setError(kind === 'more' ? '续读未成功，已读取内容保留，请重试续读。' : '原文暂时无法读取，请重试读取；来源已变化时，可打开来源核对。'); setFailedRead(kind); }
    } finally {
      if (readLock.current === token) readLock.current = null;
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    if (!active || !opened || !source) return;
    const nativeDialog = dialog.current; nativeDialog?.showModal();
    return () => { nativeDialog?.close(); };
  }, [active, opened, Boolean(source)]);
  useEffect(() => {
    if (opened && source && !readStarted.current && !original.isBusy()) { readStarted.current = true; void load('initial'); }
  }, [opened, sourceKey, original.pending]);
  useEffect(() => {
    if (failedRead && !busy && document.activeElement === document.body) retryButton.current?.focus({ preventScroll: true });
  }, [failedRead, busy]);
  useEffect(() => {
    if (opened && original.feedback?.kind === 'error' && !busy && !original.pending && document.activeElement === document.body) {
      openFeedback.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    }
  }, [opened, original.feedback, original.pending, busy]);
  if (!source) return <span className="textbook-source-missing" title="来源未在教材清单中授权">[{sourceId}]</span>;
  const openOriginal = async () => {
    if (readLock.current) return;
    await original.start({ title: source.title, url: source.web?.finalUrl || '', documentId: source.kind === 'document' ? source.id : undefined }, source.kind === 'knowledge' ? close : undefined);
  };
  return <>
    <button type="button" className="textbook-source-reference" onClick={() => setOpened(true)} title={`查看来源：${source.title}`} aria-label={`查看来源 ${sourceId}：${source.title}`}>[{sourceId}]</button>
    {active && opened && typeof document !== 'undefined' && createPortal(<dialog ref={dialog} className="textbook-source-dialog" aria-labelledby={heading} aria-busy={busy || original.pending} onCancel={(event) => { event.preventDefault(); close(); }} onClose={event => { if (!event.currentTarget.open) close(); }}>
      <header><div><span>{sourceId} · {source.kind === 'web' ? '公开资源快照' : source.kind === 'document' ? '资料原文' : '知识点来源'}</span><h2 id={heading}>{source.title}</h2></div><button type="button" onClick={close} aria-label="关闭来源阅读" autoFocus>关闭</button></header>
      <p className="textbook-source-location">版本 {source.version.slice(0, 12)} {source.locator ? `· ${JSON.stringify(source.locator)}` : ''}</p>
      {source.web && <p className="textbook-source-location">{source.web.url}<br />读取于 {new Date(source.web.readAt).toLocaleString('zh-CN')} · {source.web.format === 'transcript' ? '字幕/文字稿' : source.web.contentKind === 'abstract' ? '论文摘要（非全文）' : '正文'}{source.web.coverage === 'excerpt' ? '选段（非整份资料）' : '快照'}{source.web.acquisition === 'anonymous_browser' ? ' · 匿名浏览器渲染' : ''}。以下内容读取本机冻结快照；打开网页会显示网站当前版本。</p>}
      {error && <p role="alert" className="textbook-format-error">{error}</p>}
      {failedRead && <button ref={retryButton} type="button" disabled={busy || original.pending} onClick={() => void load(failedRead)}>{failedRead === 'more' ? '重试续读' : '重试读取'}</button>}
      {busy && <p role="status">正在读取本地原文…</p>}
      {evidence.text && <pre className="textbook-source-evidence" tabIndex={0}>{evidence.text}</pre>}
      <div ref={openFeedback}><ResourceOpenFeedback feedback={original.feedback} disabled={busy || original.pending} onRetry={() => void openOriginal()} /></div>
      <footer>{evidence.nextCursor !== undefined && <button type="button" disabled={busy || original.pending} onClick={() => void load('more')}>继续读取引用原文</button>}<button type="button" disabled={busy || original.pending} onClick={() => void openOriginal()}>{original.pending ? '正在打开…' : `打开${source.kind === 'web' ? '网页当前版本' : source.kind === 'document' ? '源文件' : '知识点'}`}</button></footer>
    </dialog>, document.body)}
  </>;
}
