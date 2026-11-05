import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, GitBranch, Loader2, X } from 'lucide-react';
import type { NoteItem } from '../types';
import type { ArgumentReferenceSourceRef, ArgumentReferenceBuildStatusReply } from '../services/argumentContext/referenceBuildTypes';
import { argumentReferenceBuildClient, argumentReferenceBuildReasonLabel, expectedNoteArgumentReference,
  getArgumentReferenceBuildApi, type PreparedReferenceBuild } from '../services/argumentContext/referenceBuildClient';
import type { ArgumentReferenceRagBuildStatusReply } from '../services/argumentContext/referenceRagBuildTypes';
import { argumentReferenceRagBuildClient, argumentReferenceRagBuildReasonLabel, getArgumentReferenceRagBuildApi,
  type PreparedReferenceRagBuild } from '../services/argumentContext/referenceRagBuildClient';
import { useDialog } from './useDialog';

const buttonStyle = 'reference-argument-action';
type ReferenceTicket = PreparedReferenceBuild | PreparedReferenceRagBuild;
type ReferenceStatus = ArgumentReferenceBuildStatusReply | ArgumentReferenceRagBuildStatusReply;
const ragTicket = (ticket: ReferenceTicket): ticket is PreparedReferenceRagBuild => 'stage' in ticket.summary;
const cancelTicket = (ticket: ReferenceTicket) => ragTicket(ticket)
  ? argumentReferenceRagBuildClient.cancel(ticket) : argumentReferenceBuildClient.cancel(ticket);

function ReferenceProcessingConfirmation({ ticket, onConfirm, onClose }: {
  ticket: ReferenceTicket; onConfirm: () => void; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null), id = useId();
  const combined = ragTicket(ticket), propositionsOnly = combined && ticket.summary.stage === 'propositions';
  useDialog(true, dialogRef, onClose, 95);
  return createPortal(<div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4"
    onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`} className="w-full max-w-md rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-5 text-[var(--ln-text-primary)] shadow-2xl">
      <div className="flex items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="text-base font-semibold">{propositionsOnly ? '完善参考论证' : '建立参考论证'}</h3>
        <button type="button" onClick={onClose} className={`${buttonStyle} is-icon`} aria-label="取消建立参考论证"><X aria-hidden="true" /></button>
      </div>
      <div id={`${id}-description`} className="mt-3 space-y-2 text-sm leading-6 text-[var(--ln-text-secondary)]">
        <p>仅处理这份已保存的正文（{ticket.summary.characters.toLocaleString()} 字符），将其选作可质疑的参考候选，不表示你已掌握。</p>
        <p>使用 {ticket.summary.providerLabel} · {ticket.summary.modelName}，{ticket.summary.isRemote ? '发送到该模型服务' : '发送到本机模型服务'}的内容为本份正文、引用和出处{combined ? '及其参考论证结构' : ''}。最多 {ticket.summary.maximumModelRequests} 次请求，无自动重试。</p>
        {combined && <p>{propositionsOnly ? '复用已审核的论证结构，只提取并独立审核关键命题。' : '依次审核来源、抽取并复核论证结构，再提取并独立审核关键命题。'}</p>}
        <p>来源审核不通过则不发布；结构按任务范围审核，必要条件或前提有缺口的部分不可用，无关例子的缺口不影响其他完整范围。{combined ? '必需命题未通过时保留已保存结构，但不标为可用。' : ''}不修改原文、个人认知或掌握度分数。候选过大也会暂停处理，不截断冒充完整结构。</p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={buttonStyle} onClick={onClose}>取消</button>
        <button type="button" className={`${buttonStyle} is-primary`} onClick={onConfirm}>确认处理</button>
      </div>
    </div>
  </div>, document.body);
}

/** No model calls on mount/save. One source selection, one consent, one quiet outcome. */
export function ReferenceArgumentStatus({ source, note, disabled = false, disabledBehavior = 'invalidate', refreshKey = '' }: {
  source: ArgumentReferenceSourceRef; note?: NoteItem; disabled?: boolean; disabledBehavior?: 'invalidate' | 'hold'; refreshKey?: string;
}) {
  const [status, setStatus] = useState<ReferenceStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ key: string; ticket: ReferenceTicket } | null>(null);
  const [refresh, setRefresh] = useState(0);
  // NoteEditor's saveState is workspace-wide. Its temporary saving flag is not
  // evidence that THIS source changed; exact source fields below remain the key.
  const ragAvailable = Boolean(getArgumentReferenceRagBuildApi());
  const key = JSON.stringify([source.kind, source.entityId, ragAvailable, disabledBehavior, disabledBehavior === 'invalidate' ? disabled : null, refreshKey,
    note && [note.title, note.content, note.noteType, note.createdAt, note.referenceSources]]);
  const liveKey = useRef(key); liveKey.current = key;
  const job = useRef<ReferenceTicket | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const available = ragAvailable || Boolean(getArgumentReferenceBuildApi());
  const buildClient = ragAvailable ? argumentReferenceRagBuildClient : argumentReferenceBuildClient;
  const reasonLabel = ragAvailable ? argumentReferenceRagBuildReasonLabel : argumentReferenceBuildReasonLabel;
  const current = (captured: string, epoch?: number) => mounted.current && liveKey.current === captured
    && (epoch === undefined || generation.current === epoch);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (job.current) void cancelTicket(job.current); };
  }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    if (job.current) void cancelTicket(job.current);
    job.current = null; operation.current = false;
    setBusy(false); setConfirmation(null); setStatus(null); setNotice('');
    if (!available || disabled && disabledBehavior === 'invalidate') return;
    let cancelled = false;
    const capturedNote = note && structuredClone(note), capturedSource = structuredClone(source);
    void (async () => {
      const result = await buildClient.status(capturedSource);
      const expected = capturedNote && await expectedNoteArgumentReference(capturedNote);
      if (cancelled || !current(key, epoch)) return;
      if ('source' in result && expected && (result.source.version !== expected.version || result.source.contentHash !== expected.contentHash)) {
        setNotice('参考论证等待当前正文保存'); return;
      }
      setStatus(result);
    })().catch(() => { if (!cancelled && current(key, epoch)) setNotice('参考论证状态读取失败'); });
    return () => { cancelled = true; };
  }, [key, refresh, available]);
  useEffect(() => {
    // A save acknowledgement may make a formerly pending source readable. Refresh
    // only idle summaries; never cancel/restart a prepared or consented model run.
    if (disabledBehavior === 'hold' && !disabled && !operation.current && !job.current) setRefresh(value => value + 1);
  }, [disabled, disabledBehavior]);
  useEffect(() => (ragAvailable ? getArgumentReferenceRagBuildApi() : getArgumentReferenceBuildApi())?.onChanged?.(() => {
    if (!operation.current && !job.current) setRefresh(value => value + 1);
  }), [ragAvailable]);
  useEffect(() => (ragAvailable ? getArgumentReferenceRagBuildApi() : getArgumentReferenceBuildApi())?.onInvalidated?.(() => {
    generation.current++;
    buildClient.invalidate();
    if (job.current) void cancelTicket(job.current);
    job.current = null; operation.current = false;
    setBusy(false); setConfirmation(null); setStatus(null); setRefresh(value => value + 1);
  }), [ragAvailable]);

  async function prepare() {
    if (operation.current || disabled || !available) return;
    operation.current = true; setBusy(true); setNotice('');
    const captured = key, epoch = generation.current, capturedNote = note && structuredClone(note), capturedSource = structuredClone(source);
    try {
      const result = await buildClient.prepare(capturedSource);
      const expected = capturedNote && await expectedNoteArgumentReference(capturedNote);
      if (!current(captured, epoch)) { if (result.status === 'prepared') void cancelTicket(result); return; }
      const identity = result.status === 'prepared' ? { version: result.summary.sourceVersion, contentHash: result.summary.contentHash }
        : result.status === 'available' ? result.source : undefined;
      if (identity && expected && (identity.version !== expected.version || identity.contentHash !== expected.contentHash)) {
        if (result.status === 'prepared') void cancelTicket(result);
        setNotice('当前显示内容尚未保存，请保存后再处理'); return;
      }
      if (result.status === 'prepared') { job.current = result; setConfirmation({ key: captured, ticket: result }); }
      else if (result.status === 'available') { setStatus(result); setNotice('当前版本已有审核通过的参考论证，无需重复请求'); }
      else setNotice(reasonLabel(result.reasonCode));
    } catch { if (current(captured, epoch)) setNotice('无法准备参考处理，请稍后重试'); }
    finally { if (current(captured, epoch)) { operation.current = false; setBusy(false); } }
  }
  function dismiss() {
    if (job.current) void cancelTicket(job.current);
    job.current = null; setConfirmation(null);
  }
  async function run() {
    if (!confirmation || confirmation.key !== key || disabled && disabledBehavior === 'invalidate' || operation.current) return;
    const captured = key, epoch = generation.current, ticket = confirmation.ticket;
    operation.current = true; job.current = ticket; setConfirmation(null); setBusy(true);
    setNotice(ragTicket(ticket) ? ticket.summary.stage === 'propositions' ? '正在提取并独立审核关键命题…'
      : '正在审核来源、论证结构与关键命题…' : '正在审核来源、抽取并复核论证结构…');
    try {
      const result = ragTicket(ticket) ? await argumentReferenceRagBuildClient.run(ticket) : await argumentReferenceBuildClient.run(ticket);
      if (!current(captured, epoch)) return;
      if (result.status === 'published') setStatus({ status: 'available', sourceQualification: 'eligible', counts: result.counts,
        ...('propositionCount' in result ? { propositionCount: result.propositionCount } : {}),
        source: { kind: ticket.summary.sourceKind, entityId: ticket.summary.entityId, version: ticket.summary.sourceVersion, contentHash: ticket.summary.contentHash } });
      else if ('structureStatus' in result && result.structureStatus === 'published') setStatus({ status: 'missing',
        sourceQualification: 'eligible', reasonCode: 'propositions_missing', counts: result.counts,
        source: { kind: ticket.summary.sourceKind, entityId: ticket.summary.entityId, version: ticket.summary.sourceVersion, contentHash: ticket.summary.contentHash } });
      setNotice(result.status === 'published' ? `参考论证已发布（仅完整任务范围可用）· ${result.counts.nodes} 个节点 · ${result.counts.relations} 条关系${'propositionCount' in result ? ` · ${result.propositionCount} 个关键命题` : ''}`
        : 'structureStatus' in result && result.structureStatus === 'published' ? `论证结构已保存，关键命题尚待审核 · ${argumentReferenceRagBuildReasonLabel(result.reasonCode)}`
          : reasonLabel(result.reasonCode));
    } finally {
      if (job.current?.ticketId === ticket.ticketId) job.current = null;
      if (current(captured, epoch)) { operation.current = false; setBusy(false); }
    }
  }
  const label = !available ? '参考论证需桌面版支持'
    : disabled && !busy && !confirmation && (disabledBehavior === 'invalidate' || status?.status !== 'available') ? '参考论证等待正文保存或解析'
    : notice || (status?.status === 'available' ? `参考论证已就绪（按完整任务范围）· ${status.counts.nodes} 个节点 · ${status.counts.relations} 条关系${'propositionCount' in status ? ` · ${status.propositionCount} 个关键命题` : ''}`
      : status?.status === 'held' ? reasonLabel(status.reasonCode)
        : status?.status === 'missing' && status.reasonCode === 'propositions_missing' ? '论证结构已保存，关键命题尚待审核'
        : status?.status === 'missing' && status.sourceQualification === 'review_only' ? '参考来源暂仅供查阅'
          : '参考论证尚未建立');
  return <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ln-text-secondary)]" aria-busy={busy}>
    <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex items-center gap-1.5">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : status?.status === 'available' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </span>
    {available && !disabled && !busy && status?.status !== 'available' && <button type="button" className={buttonStyle} onClick={() => void prepare()}>{ragAvailable && status?.status === 'missing' && status.reasonCode === 'propositions_missing' ? '完善参考论证' : '建立参考论证'}</button>}
    {busy && job.current && <button type="button" className={buttonStyle} onClick={() => {
      if (job.current) void cancelTicket(job.current);
      setNotice('正在停止处理…');
    }}>停止处理</button>}
    {confirmation && confirmation.key === key && (!disabled || disabledBehavior === 'hold') && <ReferenceProcessingConfirmation ticket={confirmation.ticket} onClose={dismiss} onConfirm={() => void run()} />}
  </div>;
}
