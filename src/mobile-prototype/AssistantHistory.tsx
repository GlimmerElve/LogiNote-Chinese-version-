import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageCircle, Plus, Search, X } from 'lucide-react';
import './assistant-history.css';

export type AssistantHistoryItem = {
  id: string;
  title: string;
  tags: string[];
  updatedAt: string;
};

type Props = {
  items: AssistantHistoryItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

function updatedLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', {
    month: 'numeric', day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Presentational history: messages, drafts and persistence belong to the parent. */
export function AssistantHistory({ items, activeId, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const previousActiveId = useRef(activeId);
  const tags = useMemo(() => [...new Set(items.flatMap(item => item.tags).filter(Boolean))], [items]);
  const term = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => items.filter(item =>
    (tag === null || item.tags.includes(tag)) &&
    (!term || `${item.title} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(term)),
  ).slice().sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), [items, tag, term]);

  // A search or tag change may intentionally hide the active conversation.
  // Reset only when the parent selects a different, filtered-out conversation.
  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    const active = items.find(item => item.id === activeId);
    if (!active) return;
    previousActiveId.current = activeId;
    const matchesTag = tag === null || active.tags.includes(tag);
    const matchesQuery = !term || `${active.title} ${active.tags.join(' ')}`.toLocaleLowerCase().includes(term);
    if (!matchesTag || !matchesQuery) {
      setQuery('');
      setTag(null);
    }
  }, [activeId, items, tag, term]);

  // Renaming tags must not leave a filter whose button no longer exists.
  useEffect(() => {
    if (tag !== null && !tags.includes(tag)) setTag(null);
  }, [tag, tags]);

  return <section className="ix-assistant-history" aria-label="助手对话记录">
    <header className="ix-ah-header">
      <h2>对话记录</h2>
      <button type="button" className="ix-ah-icon" aria-label="新建助手对话" title="新对话" onClick={() => {
        setQuery(''); setTag(null); onCreate();
      }}><Plus size={19} /></button>
    </header>
    <label className="ix-ah-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label="搜索助手对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" className="ix-ah-icon" aria-label="清除对话搜索" onClick={() => setQuery('')}><X size={16} /></button>}
    </label>
    <div className="ix-ah-filters" role="group" aria-label="按对话标签筛选">
      <button type="button" aria-pressed={tag === null} onClick={() => setTag(null)}>全部</button>
      {tags.map(value => <button type="button" key={value} aria-pressed={tag === value} onClick={() => setTag(value)}>{value}</button>)}
    </div>
    <div className="ix-ah-list">
      {visible.map(item => <button type="button" key={item.id} className="ix-ah-conversation"
        aria-label={`打开助手对话：${item.title}`} aria-current={item.id === activeId ? 'true' : undefined}
        onClick={() => onSelect(item.id)}>
        <span className="ix-ah-title"><MessageCircle size={16} aria-hidden="true" /><strong title={item.title}>{item.title}</strong></span>
        <span className="ix-ah-meta">
          <span className="ix-ah-tags" aria-label={`标签：${item.tags.length ? item.tags.join('、') : '无'}`} title={item.tags.join(' · ')}>
            {item.tags.slice(0, 2).map(value => <span key={value}>{value}</span>)}
            {item.tags.length > 2 && <span>+{item.tags.length - 2}</span>}
          </span>
          <time dateTime={Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : undefined}>{updatedLabel(item.updatedAt)}</time>
        </span>
      </button>)}
      {!visible.length && <p className="ix-ah-empty">{items.length ? '没有匹配的对话' : '还没有对话'}</p>}
    </div>
  </section>;
}
