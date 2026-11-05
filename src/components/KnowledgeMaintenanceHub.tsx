import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteItem } from '../types';
import type { WorkspaceNoteChange } from '../services/agent/workspaceOperations';
import { knowledgeSelectionIds, prepareKnowledgeDeletion, prepareKnowledgeMerge } from '../services/knowledgeMaintenance';
import { useDialog } from './useDialog';
import './knowledgeMaintenance.css';

export interface KnowledgeMaintenanceRequest { kind: 'delete' | 'merge'; ids: string[] }
export function KnowledgeMaintenanceHub({ notes, getNotes, onPrepare, onCommit, onUndo }: {
  notes: NoteItem[]; getNotes(): NoteItem[]; onPrepare(): Promise<void>;
  onCommit(change: WorkspaceNoteChange): Promise<{ operationId: string }>; onUndo(id: string): Promise<unknown>;
}) {
  const latest = useRef({ notes, getNotes, onPrepare, onCommit, onUndo }); latest.current = { notes, getNotes, onPrepare, onCommit, onUndo };
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [request, setRequest] = useState<KnowledgeMaintenanceRequest | null>(null);
  const [ids, setIds] = useState<string[]>([]), [title, setTitle] = useState(''), [search, setSearch] = useState('');
  const [preview, setPreview] = useState<WorkspaceNoteChange | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<{ id: string; label: string; undone?: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), dialogRef = useRef<HTMLDivElement>(null), busyRef = useRef(false);
  const open = (input: KnowledgeMaintenanceRequest) => { setMenu(null); setRequest(input); setIds(input.ids); setTitle(''); setSearch(''); setPreview(null); setError(''); };
  useDialog(Boolean(request), dialogRef, busy ? undefined : () => setRequest(null), 240);
  useEffect(() => {
    const external = (event: Event) => { const detail = (event as CustomEvent<KnowledgeMaintenanceRequest>).detail;
      if (detail && ['delete', 'merge'].includes(detail.kind) && Array.isArray(detail.ids) && !busyRef.current) open(detail); };
    const context = (event: MouseEvent) => {
      if (event.defaultPrevented || busyRef.current) return;
      const element = event.target instanceof Element ? event.target : null, root = element?.closest<HTMLElement>('[data-knowledge-maintenance-note]');
      if (!root || root.closest('[inert]')) return;
      const current = latest.current.notes, selection = window.getSelection(); let selected: string[] = [];
      if (selection && !selection.isCollapsed && selection.rangeCount && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
        const range = selection.getRangeAt(0);
        for (const link of root.querySelectorAll<HTMLElement>('[data-wiki-target]')) if (range.intersectsNode(link)) selected.push(...knowledgeSelectionIds(`[[${link.dataset.wikiTarget}]]`, current));
        if (!selected.length) selected = knowledgeSelectionIds(selection.toString(), current);
      } else {
        const link = element?.closest<HTMLElement>('[data-wiki-target]');
        selected = link ? knowledgeSelectionIds(`[[${link.dataset.wikiTarget}]]`, current)
          : current.some(note => note.id === root.dataset.knowledgeMaintenanceNote && note.noteType === 'knowledge') ? [root.dataset.knowledgeMaintenanceNote!] : [];
      }
      const unique = [...new Set(selected)]; if (!unique.length) return;
      event.preventDefault(); event.stopPropagation();
      window.dispatchEvent(new Event('loginote:knowledge-menu-open'));
      setMenu({ x: event.clientX, y: event.clientY, ids: unique });
    };
    const close = () => setMenu(null);
    document.addEventListener('contextmenu', context, true); window.addEventListener('loginote:knowledge-maintenance', external);
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('contextmenu', context, true); window.removeEventListener('loginote:knowledge-maintenance', external); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current, bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const run = async (work: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await work(); } catch (failure) { setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { busyRef.current = false; setBusy(false); } };
  const prepare = () => run(async () => { await latest.current.onPrepare(); const current = latest.current.getNotes();
    setPreview(request!.kind === 'delete' ? prepareKnowledgeDeletion(current, ids) : prepareKnowledgeMerge(current, { sourceIds: ids, targetTitle: title })); });
  const commit = () => run(async () => { const receipt = await latest.current.onCommit(preview!); setResult({ id: receipt.operationId, label: preview!.label }); setRequest(null); setPreview(null); });
  const candidates = search.trim() ? notes.filter(note => note.noteType === 'knowledge' && !ids.includes(note.id)
    && [note.title, ...(note.aliases || [])].some(name => name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))).slice(0, 20) : [];
  return createPortal(<>
    {menu && <div ref={menuRef} className="knowledge-maintenance-menu" role="menu" aria-label="知识点笔记操作" style={{ left: menu.x, top: menu.y }}
      onContextMenu={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') setMenu(null);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll('button')]; buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); } }}>
      <small>{menu.ids.length === 1 ? notes.find(note => note.id === menu.ids[0])?.title : `已选 ${menu.ids.length} 篇知识点`}</small>
      <button role="menuitem" onClick={() => open({ kind: 'merge', ids: menu.ids })}>合并知识点笔记…</button>
      <button role="menuitem" onClick={() => open({ kind: 'delete', ids: menu.ids })}>删除知识点笔记…</button>
    </div>}
    {request && <div className="knowledge-maintenance-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setRequest(null); }}>
      <div ref={dialogRef} className="knowledge-maintenance-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-maintenance-title" aria-busy={busy} tabIndex={-1}>
        <h2 id="knowledge-maintenance-title">{request.kind === 'merge' ? '合并知识点笔记' : '删除知识点笔记'}</h2>
        <p>{request.kind === 'merge' ? '按来源标题分节保留原文，保存到目标后移除来源笔记。' : '移除选中的知识点笔记和对应索引。'}项目正文和原有 Wiki 保持原样，可撤销。</p>
        <ul aria-label="已选择的知识点">{ids.map(id => <li key={id}><span>{notes.find(note => note.id === id)?.title || '已移除的知识点'}</span>
          {!preview && request.kind === 'merge' && <button aria-label={`移出来源：${notes.find(note => note.id === id)?.title}`} disabled={busy} onClick={() => setIds(ids.filter(value => value !== id))}>移出</button>}</li>)}</ul>
        {request.kind === 'merge' && !preview && <>
          <label>目标知识点名称<input autoComplete="off" value={title} maxLength={120} disabled={busy} placeholder="例如：极限；已有同名知识点会合入该笔记" onChange={event => setTitle(event.target.value)} /></label>
          <label>添加指定来源<input value={search} disabled={busy} placeholder="按名称查找知识点" onChange={event => setSearch(event.target.value)} /></label>
          {candidates.length > 0 && <div className="knowledge-maintenance-candidates">{candidates.map(note => <button key={note.id} disabled={busy} onClick={() => { setIds([...ids, note.id]); setSearch(''); }}>{note.title}<span>添加</span></button>)}</div>}
        </>}
        {preview && <div className="knowledge-maintenance-preview"><strong>{preview.label}</strong>
          {preview.after[0] && <><p>{preview.after[0].content.length.toLocaleString()} 字符 · 保留公式与代码</p><details><summary>查看合并正文预览</summary><pre>{preview.after[0].content.slice(0, 12000)}</pre>{preview.after[0].content.length > 12000 && <small>预览显示前 12,000 字符，保存内容包含全部选中原文。</small>}</details></>}
          <p>处理范围：{preview.before.length} 篇来源或已有目标；不修改其他笔记。</p></div>}
        {error && <p role="alert" className="knowledge-maintenance-error">{error}</p>}
        <footer><button disabled={busy} onClick={() => { setRequest(null); setError(''); }}>取消</button>
          {preview && <button disabled={busy} onClick={() => { setPreview(null); setError(''); }}>返回调整</button>}
          <button className="is-primary" disabled={busy || !ids.length} onClick={() => void (preview ? commit() : prepare())}>{busy ? '正在处理…' : preview ? '确认并保存' : request.kind === 'merge' ? '预览合并' : '检查删除范围'}</button>
        </footer>
      </div>
    </div>}
    {result && <div className="knowledge-maintenance-notice" role="status"><span>{result.undone ? '已撤销知识点整理' : `${result.label} · 已保存`}</span>
      {!result.undone && <button disabled={busy} onClick={() => void run(async () => { await latest.current.onUndo(result.id); setResult({ ...result, undone: true }); })}>撤销</button>}
      {error && !request && <span role="alert">{error}</span>}<button aria-label="关闭知识点整理提示" disabled={busy} onClick={() => { setResult(null); setError(''); }}>关闭</button></div>}
  </>, document.body);
}
