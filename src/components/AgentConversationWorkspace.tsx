import React, { useEffect, useRef, useState } from 'react';
import { Archive, MoreHorizontal, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { AgentPanel } from './AgentPanel';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { loadAgentConversations, saveAgentConversations } from '../services/agent/sessionStore';
import { createConversationContexts } from '../services/agent/conversationSessionContext';
import { MAX_AGENT_CONVERSATIONS, roleForConversation, type AgentConversationLayout } from '../services/agent/conversations';
import type { AgentWorkflowHandoff } from '../services/agent/types';
import { rendererExitPreparation } from '../services/ui/applicationExit';
import { agentTaskScope } from '../services/agent/taskStateClient';
import './AgentConversationWorkspace.css';

type Props = React.ComponentProps<typeof AgentPanel>;
type State = { busy: boolean; pending: boolean; queued: boolean; preview: string; sequenceActive: boolean };
export function AgentConversationWorkspace(props: Props) {
  const live = useRef(props); live.current = props;
  const [layout, setLayout] = useState<AgentConversationLayout>();
  const layoutRef = useRef(layout); layoutRef.current = layout;
  useEffect(() => {
    if (props.open && layout?.activeId) document.getElementById(`agent-tab-${layout.activeId}`)?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [layout?.activeId, layout?.tabs, props.open]);
  const [states, setStates] = useState<Record<string, State>>({});
  const [handoffs, setHandoffs] = useState<Record<string, AgentWorkflowHandoff | null>>({});
  const [error, setError] = useState(''), [renaming, setRenaming] = useState(''), [newTitle, setNewTitle] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  function closeMenu(restoreFocus = false) {
    setMenuOpen(false); setShowArchive(false); setRenaming('');
    if (restoreFocus) requestAnimationFrame(() => menuButtonRef.current?.focus());
  }
  useEffect(() => {
    if (!props.open || !menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) closeMenu(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [menuOpen, props.open]);
  useEffect(() => { if (!props.open) closeMenu(); }, [props.open]);
  const contexts = useRef<ReturnType<typeof createConversationContexts>>(undefined);
  const callbacks = useRef(new Map<string, { busy: (value: boolean) => void; state: (value: State) => void; handoff: (value: AgentWorkflowHandoff | null) => void }>());
  const externalOwner = useRef(new Map<string, string>());
  const previousHandoff = useRef(props.workflowHandoff);
  const snapshot = () => structuredClone(live.current.ctx.getWorkspaceSnapshot?.() || {
    revision: 0, view: 'home' as const, ...(live.current.ctx.getActiveNote?.() ? {
      focusedNoteId: live.current.ctx.getActiveNote!()!.id, focusedNoteTitle: live.current.ctx.getActiveNote!()!.title,
      focusedNoteType: live.current.ctx.getActiveNote!()!.noteType,
    } : {}),
  });
  function update(next: AgentConversationLayout) {
    layoutRef.current = next; setLayout(next);
    void saveAgentConversations(next).then(() => setError(''), cause => setError(`标签状态未保存：${cause instanceof Error ? cause.message : String(cause)}`));
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const scope = await agentTaskScope();
      const restored = await loadAgentConversations();
      if (cancelled) return;
      const initial = restored || { version: 1 as const, activeId: props.role.id,
        tabs: [{ id: props.role.id, title: '当前对话', workspace: snapshot() }] };
      contexts.current = createConversationContexts(initial.tabs[0].id, () => live.current.ctx, async () => {
        if (scope !== await agentTaskScope()) throw new Error('资料库已切换，旧标签未执行操作；请重新打开应用后核对工作对象');
      }, initial.draftOwners, () => layoutRef.current?.activeId || initial.tabs[0].id);
      for (const tab of initial.tabs) contexts.current.get(tab.id, tab.workspace);
      if (!restored) await saveAgentConversations(initial);
      if (props.workflowHandoff) setHandoffs(current => ({ ...current, [initial.tabs[0].id]: props.workflowHandoff }));
      if (!cancelled) { layoutRef.current = initial; setLayout(initial); }
    })().catch(cause => { if (!cancelled) setError(`对话标签读取失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; };
    // Context ports change on App renders; the registry reads the latest ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.role.id]);
  useEffect(() => rendererExitPreparation.register({ name: '对话标签保存', stop: async () => {
    if (layoutRef.current) await saveAgentConversations(layoutRef.current);
  } }), []);
  useEffect(() => {
    props.onBusyChange(Object.values(states).some(state => state.busy));
  }, [states, props.onBusyChange]);
  useEffect(() => {
    if (props.workflowHandoff === previousHandoff.current) return;
    previousHandoff.current = props.workflowHandoff;
    const id = layoutRef.current?.activeId;
    if (id && props.workflowHandoff) setHandoffs(current => ({ ...current, [id]: props.workflowHandoff }));
  }, [props.workflowHandoff]);
  useEffect(() => {
    const current = layoutRef.current;
    if (!current || !contexts.current) return;
    const draftOwners = contexts.current.owners();
    const tabs = current.tabs.map(tab => ({ ...tab, workspace: contexts.current!.workspace(tab.id) }));
    if (JSON.stringify(current.draftOwners || {}) !== JSON.stringify(draftOwners) || JSON.stringify(tabs) !== JSON.stringify(current.tabs))
      update({ ...current, tabs, draftOwners });
  }, [states, props.planDraftSession, props.resourceDraftSession, layout]);
  const status = (id: string) => states[id]?.queued ? '排队中' : states[id]?.busy ? '运行中' : states[id]?.pending ? '待确认' : '';
  function select(id: string) {
    const current = layoutRef.current;
    if (!current || !allowCognitionLeave()) return;
    update({ ...current, activeId: id }); closeMenu();
  }
  function create() {
    const current = layoutRef.current;
    if (!current || !allowCognitionLeave() || rendererExitPreparation.isStopping()) return;
    if (current.tabs.filter(tab => !tab.archived).length >= MAX_AGENT_CONVERSATIONS || current.tabs.length >= 32) {
      setError('最多同时打开8个标签、保留32个标签记录；可继续使用已有标签。'); return;
    }
    const tab = { id: `chat-${crypto.randomUUID()}`, title: '新对话', workspace: snapshot() };
    contexts.current!.get(tab.id, tab.workspace);
    update({ ...current, activeId: tab.id, tabs: [...current.tabs, tab] }); closeMenu();
  }
  function bindCurrent() {
    const current = layoutRef.current;
    if (!current || states[current.activeId]?.busy || states[current.activeId]?.pending || !allowCognitionLeave()) return;
    const workspace = snapshot(); workspace.revision = (contexts.current!.workspace(current.activeId).revision || 0) + 1;
    contexts.current!.bind(current.activeId, workspace);
    update({ ...current, tabs: current.tabs.map(tab => tab.id === current.activeId ? { ...tab, workspace } : tab) });
  }
  function archive(id: string) {
    const current = layoutRef.current;
    if (!current || states[id]?.busy || states[id]?.pending || states[id]?.sequenceActive || !allowCognitionLeave()) return;
    if (contexts.current?.owns(id, 'plan') || contexts.current?.owns(id, 'resource')) { setError('请先在原标签处理未提交草稿，再收起标签。'); return; }
    const remaining = current.tabs.filter(tab => !tab.archived && tab.id !== id);
    if (!remaining.length) { setError('至少保留一个打开的对话标签。'); return; }
    update({ ...current, activeId: current.activeId === id ? remaining[0].id : current.activeId,
      tabs: current.tabs.map(tab => tab.id === id ? { ...tab, archived: true } : tab) });
    closeMenu();
    requestAnimationFrame(() => document.getElementById(`agent-tab-${layoutRef.current?.activeId}`)?.focus());
  }
  if (!layout) return props.open ? <aside className="agent-panel" aria-label="学习助手"><p role={error ? 'alert' : 'status'}>{error || '正在恢复对话标签…'}</p><button onClick={props.onClose}>关闭</button></aside> : null;
  const visible = layout.tabs.filter(tab => !tab.archived);
  const active = layout.tabs.find(tab => tab.id === layout.activeId)!;
  if (props.externalRequest && !externalOwner.current.has(props.externalRequest.id)) externalOwner.current.set(props.externalRequest.id, layout.activeId);
  const chrome = <section className="agent-conversations" aria-label="对话标签管理">
    <div className="agent-conversation-strip">
    <div className="agent-conversation-scroll">
    <div className="agent-conversation-tabs" role="tablist" aria-label="助手对话标签" onKeyDown={event => {
      if ((event.target as HTMLElement).getAttribute('role') !== 'tab') return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const index = visible.findIndex(tab => tab.id === layout.activeId);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
      event.preventDefault(); select(visible[next].id);
      requestAnimationFrame(() => { const target = document.getElementById(`agent-tab-${visible[next].id}`); target?.focus(); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    }}>
      {visible.map(tab => <div className={`agent-conversation-tab${tab.id === layout.activeId ? ' is-active' : ''}`} role="presentation" key={tab.id}>
      <button type="button" role="tab" id={`agent-tab-${tab.id}`} aria-controls={`agent-conversation-${tab.id}`}
        aria-selected={tab.id === layout.activeId} tabIndex={tab.id === layout.activeId ? 0 : -1} onClick={() => select(tab.id)}
        onDoubleClick={() => { setMenuOpen(true); setShowArchive(false); setRenaming(tab.id); setNewTitle(tab.title); }} title={`${tab.title}${status(tab.id) ? ` · ${status(tab.id)}` : ''}`}>
        <span>{tab.title}</span>{status(tab.id) && <small>{status(tab.id)}</small>}
      </button>
      <button type="button" className="agent-conversation-tab-close" onClick={() => archive(tab.id)}
        disabled={!!states[tab.id]?.busy || !!states[tab.id]?.pending || !!states[tab.id]?.sequenceActive}
        aria-label={`收起对话：${tab.title}`} title="收起并保留记录，不删除聊天"><X aria-hidden="true" /></button>
      </div>)}
    </div>
      <button type="button" className="agent-conversation-new" onClick={create} aria-label="新建对话标签" title="新标签独立上下文，现有任务继续运行"><Plus aria-hidden="true" /></button>
    </div>
    <div className="agent-conversation-more" ref={menuRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) closeMenu(); }}>
      <button type="button" ref={menuButtonRef} onClick={() => { if (menuOpen) closeMenu(); else setMenuOpen(true); }}
        aria-expanded={menuOpen} aria-controls="agent-conversation-options" aria-label="对话更多操作" title="对话更多操作"><MoreHorizontal aria-hidden="true" /></button>
    {menuOpen && <div className="agent-conversation-popover" id="agent-conversation-options" role="group" aria-label="对话操作">
    {!renaming && !showArchive && <>
      <button type="button" onClick={() => { setRenaming(active.id); setNewTitle(active.title); }}><Pencil aria-hidden="true" />重命名</button>
      <button type="button" onClick={() => archive(active.id)} disabled={!!states[active.id]?.busy || !!states[active.id]?.pending || !!states[active.id]?.sequenceActive}
        aria-label="收起当前标签并保留记录"><X aria-hidden="true" />收起当前对话</button>
      <button type="button" onClick={() => setShowArchive(true)} aria-label="查看收起的对话"><Archive aria-hidden="true" />已收起的对话</button>
    </>}
    {renaming && <form className="agent-conversation-rename" onSubmit={event => { event.preventDefault(); if (!newTitle.trim()) return;
      update({ ...layout, tabs: layout.tabs.map(tab => tab.id === renaming ? { ...tab, title: newTitle.trim().slice(0, 80) } : tab) }); closeMenu(true); }}>
      <label>标签名称<input autoFocus value={newTitle} maxLength={80} onChange={event => setNewTitle(event.target.value)} /></label>
      <button type="submit">保存</button><button type="button" onClick={() => closeMenu(true)}>取消</button>
    </form>}
    {showArchive && <div className="agent-conversation-archives">{layout.tabs.filter(tab => tab.archived).map(tab => <button type="button" key={tab.id} onClick={() => {
      if (visible.length >= MAX_AGENT_CONVERSATIONS) { setError('请先收起一个标签再恢复。'); return; }
      if (!allowCognitionLeave()) return;
      update({ ...layout, activeId: tab.id, tabs: layout.tabs.map(item => item.id === tab.id ? { ...item, archived: undefined } : item) }); closeMenu();
    }}>恢复：{tab.title}</button>)}{!layout.tabs.some(tab => tab.archived) && <small>没有收起的对话</small>}</div>}
    </div>}
    </div>
    </div>
    {error && <p role="alert">{error}<button type="button" onClick={() => update(layout)}>重试保存</button></p>}
  </section>;
  return <>{layout.tabs.map(tab => {
    const ctx = contexts.current!.get(tab.id, tab.workspace);
    if (!callbacks.current.has(tab.id)) callbacks.current.set(tab.id, {
      busy: () => {},
      state: value => setStates(current => JSON.stringify(current[tab.id]) === JSON.stringify(value) ? current : { ...current, [tab.id]: value }),
      handoff: value => setHandoffs(current => ({ ...current, [tab.id]: value })),
    });
    const handler = callbacks.current.get(tab.id)!;
    const ownedResource = contexts.current!.owns(tab.id, 'resource');
    return <AgentPanel {...props} key={tab.id} open={props.open && layout.activeId === tab.id && !tab.archived}
      role={roleForConversation(props.role, tab.id)} ctx={ctx} conversationChrome={chrome} onConversationState={handler.state} onBusyChange={handler.busy}
      conversationScopeAction={<button type="button" className="agent-conversation-scope-action" onClick={bindCurrent}
        disabled={!!states[active.id]?.busy || !!states[active.id]?.pending} title="将本标签的工作对象切换为当前页面；不影响其他标签"><RefreshCw aria-hidden="true" />使用当前页面</button>}
      selectedProjectTitle={ctx.getActiveNote?.()?.title}
      planDraftSession={ctx.getPlanDraftSession()} resourceDraftSession={ctx.getResourceDraftSession()} resourceActivity={ownedResource ? props.resourceActivity : null}
      onDiscardPlanDraft={() => { try { ctx.discardPlanDraftSession(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}
      onDiscardResourceDraft={() => { try { ctx.discardResourceDraftSession(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}
      onDownloadResource={resource => { if (!contexts.current!.owns(tab.id, 'resource')) throw new Error('资料草稿不属于当前标签'); return props.onDownloadResource(resource); }}
      onScanResourcePage={resource => { if (!contexts.current!.owns(tab.id, 'resource')) throw new Error('资料草稿不属于当前标签'); return props.onScanResourcePage(resource); }}
      onAuthorizeResource={resource => { if (!contexts.current!.owns(tab.id, 'resource')) throw new Error('资料草稿不属于当前标签'); return props.onAuthorizeResource(resource); }}
      onSetResourceCandidateDecision={(resource, decision) => { if (!contexts.current!.owns(tab.id, 'resource')) throw new Error('资料草稿不属于当前标签'); return props.onSetResourceCandidateDecision(resource, decision); }}
      workflowHandoff={handoffs[tab.id] || null} onWorkflowHandoffChange={handler.handoff}
      externalRequest={props.externalRequest && externalOwner.current.get(props.externalRequest.id) === tab.id ? props.externalRequest : null} />;
  })}</>;
}
