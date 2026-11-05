import React, { useEffect, useId, useRef, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import type { NoteItem, UploadedDocument } from '../types';
import { directDocumentProjects } from '../services/documentProjectBindings';
import { projectAncestors, projectDisplayPath } from '../services/projectResourceScope';

export type SaveDocumentBindings = (document: UploadedDocument, projectIds: string[], expectedIds: string[], scopeId: string) => Promise<void>;
const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]';

export function DocumentProjectBindingSection({ document, notes, disabled, getScope, onSave, onBusyChange }: {
  document: UploadedDocument; notes: NoteItem[]; disabled: boolean; getScope: () => Promise<string>;
  onSave: SaveDocumentBindings; onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState(() => directDocumentProjects(notes, document.id));
  const expected = useRef(selected), busy = useRef(false), alive = useRef(true);
  const [scope, setScope] = useState<string>();
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    alive.current = true;
    let active = true;
    void getScope().then(value => { if (active && alive.current) setScope(value); }).catch(reason => { if (active && alive.current) setError(reason?.message || '资料库范围读取失败'); });
    return () => { active = false; alive.current = false; };
  }, []);
  const projects = notes.filter(note => note.noteType === 'project').map(note => {
    let inherited = '', invalid = false;
    try { inherited = projectAncestors(note, notes).slice(1).find(parent => selected.includes(parent.id))?.title || ''; }
    catch { invalid = true; }
    return { note, path: projectDisplayPath(note, notes), inherited, invalid };
  }).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  const visible = projects.filter(item => item.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const changed = JSON.stringify([...selected].sort()) !== JSON.stringify([...expected.current].sort());
  const save = async () => {
    if (busy.current || disabled || !scope || !changed) return;
    busy.current = true; onBusyChange(true); setError(''); setNotice('');
    const snapshot = [...selected];
    try {
      await onSave(document, snapshot, [...expected.current], scope);
      if (alive.current) { expected.current = snapshot; setNotice('项目绑定已保存；子项目自动继承父项目资料，原文件未移动。'); }
    } catch (reason: any) { if (alive.current) setError(reason?.message || '保存项目绑定失败，请重试'); }
    finally { busy.current = false; if (alive.current) onBusyChange(false); }
  };
  return <fieldset disabled={disabled} className="mt-5 space-y-3 border-t border-[var(--ln-border)] pt-4">
    <legend className="sr-only">项目绑定</legend>
    <h4 className="flex items-center gap-2 text-sm font-bold"><Link2 className="h-4 w-4 text-[var(--ln-accent)]" aria-hidden="true" />项目绑定</h4>
    <p id={`${id}-help`} className="text-xs leading-5 text-[var(--ln-text-secondary)]">整本教材可绑定父项目，下方子项目自动继承，无需逐个勾选。分类仅用于整理列表，不改变绑定或检索范围。取消绑定只移除引用，不删除文件。</p>
    <label htmlFor={`${id}-search`} className="block text-xs font-semibold">查找项目</label>
    <input id={`${id}-search`} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} placeholder="搜索项目名称或父级路径"
      className={`min-h-11 w-full rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-app)] px-3 text-sm ${focus}`} />
    <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-[var(--ln-border)] p-2" aria-describedby={`${id}-help`}>
      {visible.map(({ note, path, inherited, invalid }) => <label key={note.id} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-[var(--ln-bg-subtle)] ${invalid ? 'opacity-60' : ''}`}>
        <input type="checkbox" checked={selected.includes(note.id)} disabled={invalid && !selected.includes(note.id)}
          className={`mt-1 h-4 w-4 shrink-0 accent-[var(--ln-accent)] ${focus}`} onChange={event => {
            setSelected(current => event.target.checked ? [...current, note.id] : current.filter(value => value !== note.id)); setNotice('');
          }} />
        <span className="min-w-0 text-xs"><span className="block break-words font-semibold">{path}</span>
          <span className="mt-1 block text-[var(--ln-text-secondary)]">{selected.includes(note.id) ? '直接绑定 · 子项目可继承' : inherited ? `继承自「${inherited}」` : invalid ? '父级关系异常，请先修复' : '未绑定'}</span></span>
      </label>)}
      {!visible.length && <p className="p-3 text-xs text-[var(--ln-text-secondary)]">{projects.length ? '没有匹配的项目' : '暂无项目，请先建立学习项目'}</p>}
    </div>
    <p className="text-xs text-[var(--ln-text-secondary)]">已选择 {selected.length} 个直接绑定项目{changed ? ' · 尚未保存' : ''}</p>
    {error && <p role="alert" className="break-words text-xs text-[var(--ln-danger)]">{error}</p>}
    {notice && <p role="status" className="text-xs text-[var(--ln-accent)]">{notice}</p>}
    <button type="button" disabled={disabled || !scope || !changed} onClick={() => void save()}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--ln-accent)] px-4 py-2 text-xs font-bold text-[var(--ln-bg-surface)] disabled:opacity-50 ${focus}`}>
      {busy.current ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}保存项目绑定
    </button>
  </fieldset>;
}
