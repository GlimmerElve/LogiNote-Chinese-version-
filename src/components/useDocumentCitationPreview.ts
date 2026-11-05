import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DocumentPreview } from '../types';
import { openDocument, previewDocument, retryDocument } from '../services/documentRagClient';

type Operation = 'read' | 'open' | 'reindex';

/** Shared ownership for citation reads and actions; closing never resurrects an old preview. */
export function useDocumentCitationPreview(scope: string) {
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [loadingId, setLoadingId] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmBody,setConfirmBody]=useState(false);
  const mounted = useRef(false), generation = useRef(0), lock = useRef(false), owner = useRef(scope);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useLayoutEffect(() => {
    owner.current = scope; generation.current++;
    setPreview(null); setError(''); setNotice('');setConfirmBody(false);
  }, [scope]);

  const close = () => { generation.current++; setPreview(null); setError(''); setNotice('');setConfirmBody(false); };
  const run = async (kind: Operation, documentId: string, chunkId?: string, sourceId = '') => {
    if (lock.current || owner.current !== scope) return false;
    lock.current = true;
    const version = generation.current;
    const current = () => mounted.current && version === generation.current && owner.current === scope;
    setOperation(kind); setLoadingId(sourceId); setError(''); setNotice('');
    let submitted = false;
    try {
      if (kind === 'open') {
        await openDocument(documentId);
        if (current()) setNotice('打开请求已交给系统阅读器。');
      } else {
        if (kind === 'reindex') {
          await retryDocument(documentId); submitted = true;
          if (current()) setPreview(previous => previous?.document.id === documentId
            ? { ...previous, document: { ...previous.document, status: 'pending', error: undefined }, chunks: [], totalChunkCount: 0, truncated: false } : previous);
        }
        const next = await previewDocument(documentId, chunkId);
        if (current()) {
          setPreview(next);
          if (kind === 'reindex'){setNotice('正在本地重建正文索引，未请求论证抽取模型。论证图生成或重建请到资料库操作。');setConfirmBody(false);}
        }
      }
      return current();
    } catch {
      if (current()) setError(kind === 'open' ? '原文件暂时无法打开，请重试打开。'
        : kind === 'reindex' ? submitted ? '索引任务已提交，但最新状态读取失败；请重新打开引用或到资料库核对，无需再次提交。'
          : '索引操作失败或结果未确认，请到资料库核对后再操作。'
          : '引用资料暂时无法读取，请再次点击引用重试。');
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) { setOperation(null); setLoadingId(''); }
    }
  };
  return { preview, loadingId, operation, error, notice, close,confirmBody,cancelReindex:()=>setConfirmBody(false),
    read: (id: string, chunkId?: string, sourceId?: string) => run('read', id, chunkId, sourceId),
    open: () => preview ? run('open', preview.document.id) : Promise.resolve(false),
    reindex: () => {if(preview)setConfirmBody(true);return Promise.resolve(!!preview);},
    confirmReindex: () => preview ? run('reindex', preview.document.id, preview.focusedChunkId) : Promise.resolve(false),
  };
}
