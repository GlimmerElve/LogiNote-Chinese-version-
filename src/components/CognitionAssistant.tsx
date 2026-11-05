import React, { useEffect, useRef, useState } from 'react';
import { Bot, Send, ShieldCheck, Square, Trash2, X } from 'lucide-react';
import type { CognitionNodeReference } from '../services/cognition/types';
import { CognitionAssistantSession } from '../services/agent/cognitionAssistantSession';
import { AgentRichMessage } from './AgentRichMessage';
import './CognitionAssistant.css';

export interface CognitionAssistantFocus { id: string; reference: CognitionNodeReference }
export function CognitionAssistant({ open, blocked, focusRequest, onClose, onStateChange }: {
  open: boolean; blocked: boolean; focusRequest?: CognitionAssistantFocus;
  onClose: () => void; onStateChange: (state: { busy: boolean; pending: boolean }) => void;
}) {
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const [session] = useState(() => new CognitionAssistantSession({ blocked: () => blockedRef.current }));
  const [view, setView] = useState(() => session.view()), [input, setInput] = useState(''), [clearConfirm, setClearConfirm] = useState(false);
  const [localError, setLocalError] = useState('');
  const endRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), handledFocus = useRef('');
  const leaveState = useRef({ busy: view.busy, pending: !!view.pending, input });
  leaveState.current = { busy: view.busy, pending: !!view.pending, input };
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (!leaveState.current.busy && !leaveState.current.pending && !leaveState.current.input.trim()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);
  useEffect(() => {
    const off = session.subscribe(() => setView(session.view())); void session.initialize();
    return () => { off(); session.dispose(); };
  }, [session]);
  useEffect(() => { onStateChange({ busy: view.busy, pending: !!view.pending }); }, [view.busy, view.pending, onStateChange]);
  useEffect(() => { if (open && view.ready) inputRef.current?.focus({ preventScroll: true }); }, [open, view.ready]);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'nearest' }); }, [open, view.messages.length, view.pending, view.busy]);
  useEffect(() => {
    if (!focusRequest || !view.ready || view.busy || view.pending || handledFocus.current === focusRequest.id) return;
    handledFocus.current = focusRequest.id;
    void session.focus(focusRequest.reference).catch(error => setLocalError(error instanceof Error ? error.message : String(error)));
  }, [focusRequest, view.ready, view.busy, view.pending, session]);
  const disabled = !view.ready || view.busy || !!view.pending || blocked;
  function send(text = input) {
    if (disabled || !text.trim()) return;
    setInput(''); setLocalError(''); setClearConfirm(false); void session.send(text);
  }
  return <section hidden={!open} className="ca-root" aria-label="认知助手专用对话"><div className="ca-content">
    <header className="ca-header"><div><strong><Bot aria-hidden="true" />认知助手</strong><small>仅处理认知库</small></div>
      <div><button type="button" disabled={disabled} onClick={() => setClearConfirm(value => !value)} aria-label="清除认知助手对话" aria-expanded={clearConfirm}><Trash2 aria-hidden="true" /></button>
        <button type="button" onClick={onClose} aria-label="收起认知助手" title="收起不停止本次对话"><X aria-hidden="true" /></button></div></header>
    {clearConfirm && <section className="ca-clear" aria-label="确认清除认知对话"><p>仅清除此窗口对话和定位，不删除认知库数据。</p>
      <button type="button" onClick={() => setClearConfirm(false)}>取消</button><button type="button" onClick={() => { void session.clear().catch(error => setLocalError(String(error))); setClearConfirm(false); }}>确认清除对话</button></section>}
    {view.work.focused && <div className="ca-scope">已定位讨论节点；修改前会重新读取原文。</div>}
    <div className="ca-messages" role="log" aria-label="认知整理对话记录">
      {!view.messages.length && <div className="ca-empty"><Bot aria-hidden="true" /><p>一起检查和整理自己的认识</p>
        <button type="button" disabled={disabled} onClick={() => send('列出认知库中的孤立节点')}>看看孤立节点</button>
        <button type="button" disabled={disabled} onClick={() => send('查看认知库中待复核的节点和跨活动关系')}>检查待复核关系</button></div>}
      {view.messages.map((message, index) => <article className={`ca-message ${message.role}`} key={index} aria-label={message.role === 'user' ? '你的消息' : '认知助手回复'}>
        <AgentRichMessage message={message} onOpenCitation={() => {}} /></article>)}
      {view.pending && <section className="ca-approval" aria-label="认知变更确认"><strong><ShieldCheck aria-hidden="true" />确认具体认知变更</strong>
        {view.pending.items.map(item => <div key={item.call.id}><h3>{item.title}</h3><p>{item.description}</p><ul>{item.impacts?.map((impact, index) => <li key={index}>{impact}</li>)}</ul></div>)}
        <div className="ca-approval-actions"><button type="button" disabled={view.busy || blocked} onClick={() => void session.approve(false)}>取消修改</button>
          <button type="button" disabled={view.busy || blocked} onClick={() => void session.approve(true)}>确认修改认知库</button></div></section>}
      {view.busy && <p className="ca-status" role="status">正在处理认知库…</p>}
      {(view.error || localError) && <p className="ca-error" role="alert">{view.error || localError}</p>}
      {!view.ready && view.error && <button type="button" onClick={() => void session.initialize()}>重新连接认知助手</button>}
      {view.notice && <p className="ca-status" role="status">{view.notice}</p>}
      <div ref={endRef} />
    </div>
    <form className="ca-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <label className="sr-only" htmlFor="ca-input">发送给认知助手的消息</label>
      <textarea id="ca-input" ref={inputRef} value={input} rows={2} maxLength={12000} disabled={disabled} onChange={event => setInput(event.target.value)}
        placeholder={blocked ? '请先保存或取消图谱中的手工编辑' : view.pending ? '请先处理具体变更确认' : '继续讨论这个认识、条件或关联…'}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      {view.busy ? <button type="button" onClick={() => session.stop()} aria-label="停止认知助手"><Square aria-hidden="true" /></button>
        : <button type="submit" disabled={disabled || !input.trim()} aria-label="发送认知消息"><Send aria-hidden="true" /></button>}
    </form>
    </div></section>;
}
