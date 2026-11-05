import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDialog } from './useDialog';
import type { NoteItem, ViewMode } from '../types';
import { matchesNoteSearch } from '../services/noteSearch';
import { Search, FileText, Folder, Plus, Network, Calendar, X, ArrowUpRight } from 'lucide-react';
import './CommandPalette.css';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  notes: NoteItem[];
  onSelectNote: (id: string) => void;
  onNewNote: () => void;
  onSelectView: (view: ViewMode) => void;
}

const COMMANDS = [
  { id: 'graph', title: '跳转知识图谱', detail: '查看知识点及其关联', keywords: 'graph network 图谱 关系 网络', icon: Network },
  { id: 'timeline', title: '跳转时序计划', detail: '查看项目计划、里程碑与执行事项', keywords: 'timeline plan calendar 计划 日历 时间线', icon: Calendar },
  { id: 'new', title: '新建笔记', detail: '创建一篇可编辑的知识点笔记', keywords: 'new create 新增 创建', icon: Plus },
] as const;

function noteExcerpt(content: string, query: string) {
  const plain = content.replace(/#+\s/g, '').replace(/\s+/g, ' ').trim();
  const match = query ? plain.toLowerCase().indexOf(query) : -1;
  const start = match > 32 ? match - 32 : 0;
  return `${start ? '…' : ''}${plain.slice(start, start + 140)}${plain.length > start + 140 ? '…' : ''}`;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen, onClose, notes, onSelectNote, onNewNote, onSelectView,
}) => {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);
  const outsidePointerRef = useRef(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState('');
  const close = () => { if (!finishedRef.current) { finishedRef.current = true; onClose(); } };
  // Do not autoFocus in JSX: the dialog must capture the original control first.
  useDialog(isOpen, dialogRef, close, 70);
  useLayoutEffect(() => {
    if (isOpen) { finishedRef.current = false; outsidePointerRef.current = false; setQuery(''); setActiveKey(''); }
  }, [isOpen]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    // A closed palette must not scan/format every saved body in the background.
    if (!isOpen) return [];
    const noteRows = notes.filter(note => matchesNoteSearch(note, query)).map(note => ({
        key: `note:${note.id}`, kind: 'note' as const, note, title: note.title || '未命名笔记',
        detail: noteExcerpt(note.content, q) || '暂无正文', icon: note.noteType === 'project' ? Folder : FileText,
      }));
    const commandRows = COMMANDS.filter(command => !q || `${command.title} ${command.detail} ${command.keywords}`.toLowerCase().includes(q))
      .map(command => ({ key: `command:${command.id}`, kind: 'command' as const, command,
        title: command.title, detail: command.detail, icon: command.icon }));
    // Notes come first so pressing Enter without a query does not create a note.
    return [...noteRows, ...commandRows];
  }, [isOpen, notes, q, query]);
  const active = matches.find(row => row.key === activeKey) || matches[0];
  const optionId = (key: string) => `${id}-option-${encodeURIComponent(key)}`;
  useLayoutEffect(() => {
    const list = listRef.current;
    const option = active ? document.getElementById(optionId(active.key)) : null;
    if (!isOpen || !list || !option) return;
    const bounds = list.getBoundingClientRect(), row = option.getBoundingClientRect();
    // Scroll the results only, never the workspace behind the dialog.
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }, [isOpen, active?.key, query, id]);

  const choose = (key: string) => {
    const row = matches.find(item => item.key === key);
    if (!isOpen || finishedRef.current || !row) return;
    finishedRef.current = true;
    // Close first; existing App handlers still own navigation and save/scene guards.
    onClose();
    if (row.kind === 'note') onSelectNote(row.note.id);
    else if (row.command.id === 'new') onNewNote();
    else onSelectView(row.command.id);
  };
  if (!isOpen) return null;
  const noteCount = matches.filter(row => row.kind === 'note').length;
  return <div className="command-search-overlay"
    onPointerDown={event => { outsidePointerRef.current = event.target === event.currentTarget; }}
    onClick={event => { if (outsidePointerRef.current && event.target === event.currentTarget) close(); }}>
    <div ref={dialogRef} className="command-search-dialog" role="dialog" aria-modal="true"
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} tabIndex={-1}>
      <header>
        <div className="command-search-field"><Search aria-hidden="true" />
          <input ref={inputRef} role="combobox" aria-label="搜索笔记或快捷操作"
            aria-autocomplete="list" aria-expanded={true} aria-controls={`${id}-list`}
            aria-activedescendant={active ? optionId(active.key) : undefined} value={query}
            placeholder="搜索笔记、#标签或快捷操作…" onChange={event => { setQuery(event.target.value); setActiveKey(''); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!matches.length) return;
                const index = matches.findIndex(row => row.key === active?.key);
                setActiveKey(matches[(index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length].key);
              } else if (event.key === 'Enter' && active) {
                event.preventDefault(); if (!event.repeat) choose(active.key);
              }
            }} />
          {query && <button type="button" className="command-search-clear" aria-label="清除搜索内容"
            onClick={() => { setQuery(''); setActiveKey(''); inputRef.current?.focus(); }}>清除</button>}
        </div>
        <button type="button" className="command-search-close" onClick={close} aria-label="关闭搜索" title="关闭搜索（Esc）"><X aria-hidden="true" /></button>
      </header>
      <div className="command-search-summary">
        <h2 id={`${id}-title`}>搜索与快捷操作</h2>
        <span role="status" aria-live="polite">{noteCount} 篇笔记 · {matches.length - noteCount} 个操作</span>
      </div>
      <div ref={listRef} id={`${id}-list`} className="command-search-list" role="listbox" aria-label="搜索结果">
        {!matches.length && <p className="command-search-empty">没有匹配的笔记或操作，试试其他关键词。</p>}
        {matches.map((row, index) => <React.Fragment key={row.key}>
          {(index === 0 || matches[index - 1].kind !== row.kind) && <div className="command-search-group" role="presentation">{row.kind === 'note' ? '笔记' : '快捷操作'}</div>}
          <button type="button" role="option" tabIndex={-1} id={optionId(row.key)} aria-selected={active?.key === row.key}
            className="command-search-result" onMouseMove={() => setActiveKey(row.key)}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(row.key)}>
            <span className="command-search-icon"><row.icon aria-hidden="true" /></span>
            <span className="command-search-content"><strong>{row.title}</strong><span>{row.detail}</span></span>
            <span className="command-search-type">{row.kind === 'note' ? row.note.noteType === 'project' ? '项目' : '知识点' : '操作'}</span>
            <ArrowUpRight className="command-search-open" aria-hidden="true" />
          </button>
        </React.Fragment>)}
      </div>
      <footer id={`${id}-help`}><span>匹配标题、正文、别名及标签；#标签只搜索标签</span>
        <span className="command-search-keys"><kbd>↑ ↓</kbd>选择 <kbd>Enter</kbd>打开 <kbd>Esc</kbd>关闭</span></footer>
    </div>
  </div>;
};
