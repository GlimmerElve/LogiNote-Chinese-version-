import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ArgDoc } from '../services/argumentDoc/types';
import type { ArgumentPublicationChoice } from '../services/ui/argumentPublication';

export interface ArgumentEditorWriteApi {
  save?: (data: { doc: ArgDoc; noteId: string | null; entryMode: 'new' | 'edit'; publication: ArgumentPublicationChoice }) => Promise<{ ok: boolean; error?: string }>;
  delete?: (docId: string) => Promise<{ ok: boolean; error?: string }>;
  close?: () => Promise<boolean>;
}

/** Only the transport and document source are injected; the UI lifecycle is shared. */
export function useArgumentEditorWrite({ doc, readDoc, getArgumentApi, noteIdRef, entryModeRef,
  modelLock, evidencePending, baselineRef, allowCloseRef, mountedRef }: {
  doc: ArgDoc | null; readDoc: () => ArgDoc; getArgumentApi: () => ArgumentEditorWriteApi;
  noteIdRef: RefObject<string | null>; entryModeRef: RefObject<'new' | 'edit'>;
  modelLock: RefObject<boolean>; evidencePending: RefObject<number>; baselineRef: RefObject<string>;
  allowCloseRef: RefObject<boolean>; mountedRef: RefObject<boolean>;
}) {
  const [writing, setWriting] = useState<'save' | 'delete' | null>(null);
  const [writeError, setWriteError] = useState('');
  const [writeFinished, setWriteFinished] = useState(false);
  const writeFinishedRef = useRef(false);
  const writeLock = useRef(false);
  const writeOrigin = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const origin = writeOrigin.current;
    if (!writing && writeError && origin?.isConnected && !origin.matches(':disabled')
      && (document.activeElement === document.body || document.activeElement === origin)) origin.focus();
  }, [writing, writeError]);

  const performWrite = useCallback(async (kind: 'save' | 'delete', publication: ArgumentPublicationChoice = 'draft') => {
    if (!doc || writeLock.current || modelLock.current || writeFinishedRef.current) return;
    if (evidencePending.current) { setWriteError('证据绑定尚未结束，请稍后再保存。'); return; }
    if (typeof document !== 'undefined') writeOrigin.current = document.activeElement as HTMLElement | null;
    writeLock.current = true;
    setWriting(kind); setWriteError('');
    let persisted = false;
    try {
      const api = getArgumentApi();
      if (!api.save || !api.delete || !api.close) throw new Error('保存接口不可用，请保留窗口并重新连接主窗口。');
      const latestDoc = readDoc();
      const submittedSnapshot = JSON.stringify(latestDoc);
      const result = kind === 'delete' ? await api.delete(latestDoc.doc_id) : await api.save({
        doc: { ...latestDoc, updated_at: new Date().toISOString() },
        noteId: noteIdRef.current, entryMode: entryModeRef.current, publication,
      });
      if (!result?.ok) throw new Error(result?.error || '未收到成功保存回执，请核对原笔记后重试。');
      persisted = true;
      if (!mountedRef.current) return;
      baselineRef.current = submittedSnapshot;
      if (kind === 'save' && JSON.stringify(readDoc()) !== submittedSnapshot) {
        setWriteError('已保存提交时的版本，当前仍有新修改，请再次保存后退出。');
        return;
      }
      writeFinishedRef.current = true;
      setWriteFinished(true);
      allowCloseRef.current = true;
      if (!await api.close()) throw new Error('窗口未关闭');
    } catch (error) {
      if (mountedRef.current) setWriteError(persisted
        ? `已${kind === 'delete' ? '删除' : '保存'}，请使用窗口关闭按钮退出。`
        : `${error instanceof Error ? error.message : '写入失败'} 编辑内容仍保留，可重试。`);
    } finally {
      writeLock.current = false;
      if (mountedRef.current) setWriting(null);
      allowCloseRef.current = false;
    }
  }, [doc, readDoc, getArgumentApi, noteIdRef, entryModeRef, modelLock, evidencePending, baselineRef, allowCloseRef, mountedRef]);
  return { writing, writeError, writeFinished, writeLock, performWrite };
}
