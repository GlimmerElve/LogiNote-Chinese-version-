import React, { useRef, useState } from 'react';
import type { CognitionCandidate, CognitionFile } from '../services/cognition/types';
import { CognitionEditForm } from './CognitionEditForm';
import { useCognitionWrite } from './useCognitionWrite';

type Pending = Extract<CognitionCandidate, { status: 'pending' }>;
type WriteOptions = { disabled?: boolean; writeLock?: { current: boolean }; onBusyChange?: (busy: boolean) => void };
function CandidateCard({ candidate, file, onSaved, disabled = false, writeLock, onBusyChange }: { candidate: Pending; file: CognitionFile; onSaved: (file: CognitionFile) => void } & WriteOptions) {
  const o = candidate.observation;
  const [discardRevision, setDiscardRevision] = useState<number | null>(null);
  const discard = discardRevision !== null;
  const [editing, setEditing] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const { busy, error, write, clearError } = useCognitionWrite(onSaved, { lock: writeLock, onBusyChange });
  async function dismiss() {
    if (disabled || editingBusy || discardRevision === null || discardRevision !== file.revision) return;
    await write({ kind: 'dismiss_candidate', candidateId: candidate.id, expectedRevision: discardRevision, confirmed: true });
  }
  return <details className="cognition-card" aria-busy={busy || editingBusy} onToggle={(e) => { if (e.target === e.currentTarget && e.currentTarget.open) setEditing(true); }}>
    <summary className="cursor-pointer font-medium">{o.noteTitle || '复习回答'} · 待确认 · {new Date(o.observedAt).toLocaleString('zh-CN')}</summary>
    <div className="mt-3 space-y-3 text-xs leading-relaxed">
      <p>这是待确认的个人理解，不代表已经学会。请删去引用、提问等不代表自己观点的部分。</p>
      <details><summary className="cursor-pointer">回答原文与学习上下文</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">提问（不是你的观点）：{o.question || '未记录'}</p>
        <blockquote className="my-2 whitespace-pre-wrap break-words">{o.answer}</blockquote>
        <p>复习：{o.activityId} · 回答：{o.messageId} · 提示程度：{o.hintLevel ?? '未知'}/4 · 查阅资料 {o.consultedMaterialIds.length} 项</p>
        <p>整理确认稿不改写原回答；原文随版本保留。</p>
      </details>
      {editing ? <div hidden={discard}><CognitionEditForm file={file} candidate={candidate} onSaved={onSaved} onCancel={() => setEditing(false)} onLeaveBlocked={() => setDiscardRevision(null)} disabled={disabled || discard} writeLock={writeLock} onBusyChange={(value) => { setEditingBusy(value); onBusyChange?.(value); }} /></div>
        : <button type="button" className="cognition-action" disabled={busy || disabled} onClick={() => setEditing(true)}>整理这份回答</button>}
      {!discard ? <button type="button" className="cognition-action" disabled={busy || editingBusy || disabled} onClick={() => { if (writeLock?.current) return; clearError(); setDiscardRevision(file.revision); }}>忽略候选…</button> : <div className="cognition-notice space-y-2">
        <p>忽略会移除此候选的原文与上下文，不会删除已确认认知或原学习记录。</p>
        {discardRevision !== file.revision && <p role="alert">认知库已变化，请取消并重新核对，再决定是否忽略。</p>}
        <div className="cognition-actions"><button type="button" className="cognition-action is-danger" disabled={busy || disabled || discardRevision !== file.revision} onClick={() => void dismiss()}>{busy ? '正在忽略…' : '确认忽略'}</button>
          <button type="button" className="cognition-action" disabled={busy || disabled} onClick={() => { setDiscardRevision(null); clearError(); }}>取消</button></div>
      </div>}
      {error && <p role="alert" className="cognition-error">忽略未成功，候选与确认区域均已保留。{error}</p>}
    </div>
  </details>;
}

export function CognitionCandidateInbox({ file, onSaved, disabled = false, writeLock, onBusyChange }: { file: CognitionFile; onSaved: (file: CognitionFile) => void } & WriteOptions) {
  const ownLock = useRef(false);
  const lock = writeLock || ownLock;
  const pending = (file.candidates || []).filter((c): c is Pending => c.status === 'pending');
  const [message, setMessage] = useState('');
  return <section className="cognition-ui my-3 space-y-3" aria-label="待确认回答">
    <h4 className="font-medium">待确认回答（{pending.length}）</h4>
    <p className="text-xs">复习时开启回答收集，结束后在这里确认。可新增理解，也可补充或修订已有理解。</p>
    {pending.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} file={file} disabled={disabled} writeLock={lock} onBusyChange={onBusyChange} onSaved={(next) => {
      onSaved(next); setMessage(next.candidates?.find((item) => item.id === candidate.id)?.status === 'dismissed'
        ? '候选已忽略，未新增或修改你的理解。' : '理解已确认保存，可在下方查看。');
    }} />)}
    {!pending.length && <p className="text-xs">暂无待确认的学习回答。</p>}
    <p role="status" className="text-xs">{message}</p>
  </section>;
}
