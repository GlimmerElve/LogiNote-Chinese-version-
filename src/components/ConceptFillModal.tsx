import React, { useEffect, useId, useRef, useState } from 'react';
import { BookOpenText, ExternalLink, FileText, FolderSearch, Globe2, Layers3, Loader2, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { useDialog } from './useDialog';
import type { ConceptDraft, ConceptSource, NoteItem } from '../types';
import { generateConcept } from '../services/conceptFillService';
import { conceptFillFailureFeedback } from '../services/ui/conceptFillFeedback';
import './ConceptFillModal.css';

interface ConceptFillModalProps {
  note: NoteItem;
  onClose: () => void;
  /** Resolves only after persistence acknowledges the confirmed draft. */
  onConfirm: (content: string, references?: ConceptDraft['references']) => Promise<void>;
}
const SOURCE_OPTIONS = [
  { value: 'hybrid', label: '混合检索', description: '结合本地笔记、资料库与公开网页。', privacy: '概念标题用于公开检索；证据交给当前配置的模型生成草稿。', icon: Layers3 },
  { value: 'rag', label: '仅本地资料', description: '检索已有笔记和资料，不访问搜索引擎。', privacy: '不进行公开网页检索；本地证据仍交给当前配置的模型。', icon: FolderSearch },
  { value: 'browser', label: '仅公开网页', description: '优先联网 API；不支持时使用隔离浏览器。', privacy: '搜索词与公开 URL 发送至当前供应商；不使用持久登录 Cookie，证据用于生成草稿。', icon: Globe2 },
] satisfies Array<{ value: ConceptSource; label: string; description: string; privacy: string; icon: typeof Layers3 }>;
function sourceUrl(value?: string): string | undefined {
  try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

export const ConceptFillModal: React.FC<ConceptFillModalProps> = ({ note, onClose, onConfirm }) => {
  const titleId = useId();
  const [source, setSource] = useState<ConceptSource>('hybrid');
  const [draft, setDraft] = useState<ConceptDraft | null>(null);
  const [phase, setPhase] = useState<'retrieving' | 'generating' | 'saving' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const operationRef = useRef<{ controller: AbortController; saving: boolean } | null>(null);
  const mountedRef = useRef(false);
  const closedRef = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const focusAfterRef = useRef<'confirm' | 'generate' | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; operationRef.current?.controller.abort(); operationRef.current = null; };
  }, []);
  useEffect(() => {
    const target = focusAfterRef.current;
    if (!phase && target) {
      focusAfterRef.current = null;
      if (!document.activeElement?.isConnected || document.activeElement === document.body || document.activeElement === dialogRef.current || document.activeElement === confirmRef.current || document.activeElement === generateRef.current) {
        (target === 'confirm' ? confirmRef : generateRef).current?.focus({ preventScroll: true });
      }
    }
  }, [phase]);
  const close = () => {
    if (operationRef.current?.saving || closedRef.current) return;
    closedRef.current = true; operationRef.current?.controller.abort(); operationRef.current = null; onClose();
  };
  useDialog(true, dialogRef, close, 300);
  const stop = () => {
    if (!operationRef.current || operationRef.current.saving) return;
    operationRef.current.controller.abort(); operationRef.current = null;
    focusAfterRef.current = 'generate'; setPhase(null); setError('');
    setNotice('已停止等待，不会继续生成或写入；已发出的资料检索可能在后台结束。');
  };
  const selectSource = (next: ConceptSource) => {
    if (operationRef.current || next === source) return;
    setSource(next); setDraft(null); setError(''); setNotice(''); setSourceError('');
  };
  const clearDraft = () => {
    if (operationRef.current || !draft || closedRef.current) return;
    setDraft(null); setError(''); setSourceError('');
    focusAfterRef.current = 'generate';
    setNotice('已清除当前草稿和引用，笔记未修改。');
    generateRef.current?.focus({ preventScroll: true });
  };
  const handleGenerate = async () => {
    if (operationRef.current || closedRef.current) return;
    const operation = { controller: new AbortController(), saving: false };
    operationRef.current = operation; setPhase('retrieving'); setError(''); setNotice(''); setSourceError('');
    const current = () => mountedRef.current && !closedRef.current && operationRef.current === operation;
    try {
      const result = await generateConcept(note, source, { signal: operation.controller.signal, onStage: next => { if (current()) setPhase(next); } });
      if (current()) { if (!result.content?.trim()) throw new Error('empty draft'); setDraft(result); focusAfterRef.current = 'confirm'; }
    } catch (error) {
      if (current()) { setError(conceptFillFailureFeedback(error, !!draft)); focusAfterRef.current = 'generate'; }
    } finally {
      if (current()) { operationRef.current = null; setPhase(null); }
    }
  };
  const confirm = async () => {
    if (!draft?.content.trim() || operationRef.current || closedRef.current) return;
    const operation = { controller: new AbortController(), saving: true };
    operationRef.current = operation; setPhase('saving'); setError(''); setNotice('');
    const current = () => mountedRef.current && !closedRef.current && operationRef.current === operation;
    try {
      await onConfirm(draft.content, draft.references);
      if (current()) { operationRef.current = null; setPhase(null); close(); }
    } catch {
      if (current()) {
        operationRef.current = null; focusAfterRef.current = 'confirm'; setPhase(null);
        setError('写入未完成，草稿已保留。请核对笔记是否被修改，并检查笔记库保存状态后重试。');
      }
    }
  };
  const openSource = async (event: React.MouseEvent<HTMLAnchorElement>, url: string) => {
    const native = (window as unknown as { electronAPI?: { openExternal?: (url: string) => Promise<void> } }).electronAPI?.openExternal;
    if (!native) return;
    event.preventDefault(); setSourceError('');
    try { await native(url); }
    catch { if (mountedRef.current && !closedRef.current) setSourceError('来源未能打开，请重试或复制来源链接。'); }
  };
  const researching = phase === 'retrieving' || phase === 'generating';
  const busy = phase !== null;
  return <div className="concept-fill-overlay" onClick={close}>
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="concept-fill-dialog" onClick={event => event.stopPropagation()}>
      <header><div><span className="concept-fill-eyebrow">CONCEPT RESEARCH</span><h2 id={titleId}><Sparkles aria-hidden="true" />补全概念「{note.title}」</h2><p>先检查草稿与引用，确认保存成功后才关闭。</p></div><button type="button" className="concept-fill-icon" aria-label="关闭概念补全" onClick={close} disabled={phase === 'saving'}><X aria-hidden="true" /></button></header>
      <div className="concept-fill-controls"><fieldset disabled={busy}><legend>选择证据来源</legend><div className="concept-fill-sources">{SOURCE_OPTIONS.map(option => {
        const Icon = option.icon;
        return <button key={option.value} type="button" aria-pressed={source === option.value} onClick={() => selectSource(option.value)}><span><Icon aria-hidden="true" />{option.label}</span><small>{option.description}</small></button>;
      })}</div></fieldset><p className="concept-fill-privacy"><ShieldCheck aria-hidden="true" />{SOURCE_OPTIONS.find(option => option.value === source)?.privacy}</p>
        <div className="concept-fill-research-actions">{draft && <button type="button" onClick={clearDraft} disabled={busy}>清除草稿</button>}{researching && <button ref={stopRef} type="button" onClick={stop}><Square aria-hidden="true" />停止研究</button>}<button ref={generateRef} type="button" className="is-primary" onClick={() => void handleGenerate()} disabled={busy}>{researching ? <Loader2 className="is-spinning" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{researching ? '正在研究' : draft ? '重新检索并生成' : '检索并生成'}</button></div>
      </div>
      <div className="concept-fill-content" aria-busy={busy}>
        {phase && <p className="concept-fill-status" role="status"><Loader2 className="is-spinning" aria-hidden="true" />{phase === 'saving' ? '正在保存草稿，请等待保存结果…' : phase === 'generating' ? '证据已读取，正在生成概念草稿…' : '正在检索所选资料来源…'}</p>}
        {notice && <p className="concept-fill-status" role="status">{notice}</p>}{error && <p className="concept-fill-error" role="alert">{error}</p>}
        {!draft && !busy && !error && <div className="concept-fill-empty"><BookOpenText aria-hidden="true" /><p>选择来源，开始研究这个概念</p><small>结果只作为草稿预览，确认前不会修改笔记。</small></div>}
        {draft && <><p className="concept-fill-status" role="status">仅保留当前一份草稿；重新生成成功会替换它，关闭弹窗后丢弃。确认写入前不会修改笔记。</p><section><h3>概念草稿</h3><pre>{draft.content}</pre></section><section><h3>已采用证据 <small>共 {draft.references?.length || 0} 条</small></h3>{sourceError && <p className="concept-fill-error" role="alert">{sourceError}</p>}<div className="concept-fill-references">{draft.references?.map((reference, index) => {
          const Icon = reference.type === 'web' ? Globe2 : reference.type === 'document' ? FileText : BookOpenText;
          const url = sourceUrl(reference.url);
          return <article key={`${reference.sourceId || index}-${reference.title}`}><Icon aria-hidden="true" /><div><small>[{reference.sourceId || index + 1}] · {reference.type === 'web' ? '公开网页' : reference.type === 'document' ? '本地资料' : '本地笔记'}{reference.sectionPath ? ` · ${reference.sectionPath}` : ''}</small><strong>{reference.title}</strong>{reference.snippet && <p>{reference.snippet}</p>}{url && <a href={url} target="_blank" rel="noopener noreferrer" onClick={event => void openSource(event, url)} aria-label={`打开来源：${reference.title}`}><ExternalLink aria-hidden="true" />查看来源</a>}</div></article>;
        })}</div></section></>}
      </div>
      <footer><p>确认写入会替换当前正文与引用，其他属性保持不变。</p><div><button type="button" onClick={close} disabled={phase === 'saving'}>取消</button><button ref={confirmRef} type="button" className="is-primary" onClick={() => void confirm()} disabled={!draft?.content.trim() || busy}>{phase === 'saving' ? '正在保存…' : '确认写入笔记'}</button></div></footer>
    </section>
  </div>;
};
