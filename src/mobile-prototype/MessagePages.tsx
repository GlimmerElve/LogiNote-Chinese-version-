import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, MessageCircle, MoreHorizontal, Search, Send, ShieldCheck, X } from 'lucide-react';
import { conversations, type DemoMessage } from './data';
import './message-pages.css';

export type MessagesPageProps = {
  conversationId: string | null;
  messages: DemoMessage[];
  blockedIds: string[];
  draft: string;
  onDraftChange: (text: string) => void;
  onOpen: (id: string) => void;
  onBack: () => void;
  onSend: () => void;
  onReport: () => void;
  onUnblock: () => void;
};

/** Presentation only. Drafts and local send receipts belong to the parent. */
export function MessagesPage({ conversationId, messages, blockedIds, draft, onDraftChange, onOpen, onBack, onSend, onReport, onUnblock }: MessagesPageProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const current = conversations.find(c => c.id === conversationId);
  const currentMessages = messages.filter(message => message.conversation === conversationId);
  const blocked = current ? blockedIds.includes(current.id) : false;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [conversationId, currentMessages.length]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = '0px';
    const borderHeight = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(132, Math.max(48, input.scrollHeight + borderHeight))}px`;
  }, [draft, conversationId, blocked]);

  // Some mobile browsers overlay the soft keyboard rather than resizing dvh.
  // Constrain the chat, while leaving focus and keyboard choice to the system.
  useLayoutEffect(() => {
    if (!current) return;
    const node = pageRef.current!;
    const fit = () => {
      const viewport = window.visualViewport;
      const visibleBottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight);
      node.style.maxHeight = `${Math.max(160, Math.floor(visibleBottom - node.getBoundingClientRect().top - 8))}px`;
    };
    fit();
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    return () => {
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
      node.style.removeProperty('max-height');
    };
  }, [current?.id]);

  if (current) {
    return <div ref={pageRef} className="mx-page mx-chat">
      <header className="mx-chat-header">
        <button className="mx-icon-button" aria-label="返回消息列表" onClick={onBack}><ArrowLeft size={21} /></button>
        <span className={`mx-avatar mx-avatar-${current.id}`} aria-hidden="true">{current.avatar}</span>
        <h1>{current.name}</h1>
        <button className="mx-icon-button" aria-label="举报与屏蔽" onClick={onReport}><MoreHorizontal size={23} /></button>
      </header>
      <div ref={scrollRef} className="mx-chat-messages" role="log" aria-label={`${current.name}的消息`} aria-relevant="additions">
        <div className="mx-incoming"><span className={`mx-avatar mx-avatar-${current.id}`} aria-hidden="true">{current.avatar}</span><p className="mx-message">{current.text}</p></div>
        {currentMessages.map((message, index) => <div key={message.id} className={message.self ? 'mx-outgoing' : 'mx-incoming'}>
          {!message.self && <span className={`mx-avatar mx-avatar-${current.id}`} aria-hidden="true">{current.avatar}</span>}
          <div className="mx-message-stack"><p className="mx-message">{message.text}</p>{message.self && index === currentMessages.length - 1 && <small className="mx-delivery-state">未发送</small>}</div>
        </div>)}
      </div>
      <div className="mx-composer-wrap">
        {blocked ? <div className="mx-blocked"><ShieldCheck size={18} /><span>已屏蔽</span><button onClick={onUnblock}>解除屏蔽</button></div>
          : <form className="mx-composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) onSend(); }}>
            <textarea ref={inputRef} aria-label="演示聊天消息" placeholder="消息" rows={1} maxLength={1000} enterKeyHint="enter" value={draft} onChange={event => onDraftChange(event.target.value)} />
            <button className="mx-send" type="submit" aria-label="发送演示消息" disabled={!draft.trim()}><Send size={20} /></button>
          </form>}
      </div>
    </div>;
  }

  const term = query.trim().toLocaleLowerCase();
  const filtered = conversations.filter(conversation => !term || `${conversation.name} ${conversation.subtitle}`.toLocaleLowerCase().includes(term));
  return <div className="mx-page mx-list">
    <header className="mx-list-header"><h1>消息</h1><button className="mx-icon-button" aria-label={searchOpen ? '收起会话搜索' : '打开会话搜索'} aria-expanded={searchOpen} onClick={() => {
      setSearchOpen(!searchOpen);
      if (searchOpen) setQuery('');
    }}><Search size={21} /></button></header>
    {searchOpen && <label className="mx-search"><Search size={17} /><input ref={searchRef} aria-label="搜索会话" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="mx-icon-button" aria-label="清除会话搜索" onClick={() => setQuery('')}><X size={17} /></button>}</label>}
    <div className="mx-thread-list">{filtered.map(conversation => {
      const latest = messages.filter(message => message.conversation === conversation.id).at(-1);
      return <button key={conversation.id} className="mx-conversation-item mp-conversation-item" onClick={() => onOpen(conversation.id)}>
        <span className={`mx-avatar mx-avatar-${conversation.id}`} aria-hidden="true">{conversation.avatar}</span>
        <div className="mx-thread-content"><div className="mx-thread-name"><h2>{conversation.name}</h2>{conversation.type === '共学群' && <span>群</span>}</div><p>{blockedIds.includes(conversation.id) ? '已屏蔽' : latest?.text || conversation.subtitle}</p></div>
      </button>;
    })}</div>
    {!filtered.length && <div className="mx-empty"><MessageCircle size={27} strokeWidth={1.4} /><p>没有找到会话</p></div>}
  </div>;
}
