import React, { useEffect, useRef, useState } from 'react';
import type { CognitionReference } from '../services/cognition/retrieval';
import type { CognitionFile } from '../services/cognition/types';
import { cognitionNodeOrigin, latestCognition } from '../services/cognition/core';
import { loadPersonalCognition, subscribePersonalCognition } from '../services/cognition/store';
import { CognitionEditForm } from './CognitionEditForm';
import './PersonalCognition.css';

function CurrentReferences({ references }: { references: CognitionReference[] }) {
  const [file, setFile] = useState<CognitionFile | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ key: string; reference: CognitionReference } | null>(null);
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const writeLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function reportBusy(value: boolean) { if (mounted.current) setBusy(value); }
  function acceptSaved(next: CognitionFile) {
    request.current++;
    setFile(next); setError(''); setLoading(false); setEditing(null);
    setMessage('已保存你确认的更新，旧版本保留。');
  }
  useEffect(() => {
    let active = true;
    const reload = () => {
      const token = ++request.current;
      setLoading(true);
      void loadPersonalCognition().then((next) => { if (active && token === request.current) { setFile(next); setError(''); } })
        .catch(() => { if (active && token === request.current) setError('个人认知读取未成功，已显示的内容与编辑草稿仍保留。请重试后重新核对。'); })
        .finally(() => { if (active && token === request.current) setLoading(false); });
    };
    reload();
    const off = subscribePersonalCognition(reload);
    return () => { active = false; off(); };
  }, [refresh]);
  const shown = editing && !references.some((ref) => JSON.stringify([ref.recordId, ref.branchId, ref.nodeId]) === editing.key)
    ? [...references, editing.reference] : references;
  return <div className="cognition-ui mt-3 space-y-3" aria-busy={busy || loading}>
    <p className="text-xs">这里展示当前版本。相关不等于冲突；AI 的建议不会自动写入你的认知。</p>
    {!file && !error && <p role="status">正在读取当前理解…</p>}
    {error && <div className="cognition-notice" role="alert">{error}<div className="cognition-actions"><button type="button" className="cognition-action" disabled={busy || loading} onClick={() => { if (!writeLock.current) setRefresh((n) => n + 1); }}>{loading ? '正在读取…' : '重试读取'}</button></div></div>}
    {editing && <p className="cognition-muted">请先保存或取消当前编辑，再更新其他理解。</p>}
    {file && shown.map((ref) => {
      const key = JSON.stringify([ref.recordId, ref.branchId, ref.nodeId]);
      const record = file.records.find((r) => r.id === ref.recordId);
      const revision = record && latestCognition(record);
      const branch = revision?.branches.find((b) => b.id === ref.branchId);
      const node = branch?.graph.nodes.find((n) => n.id === ref.nodeId);
      const available = !!(record && !record.withdrawn && revision && branch && node);
      const editForm = editing?.key === key ? <div key="editor" className="mt-3"><CognitionEditForm file={file} recordId={ref.recordId}
        initialTarget={{ branchId: ref.branchId, nodeId: ref.nodeId }} assistedContext
        disabled={busy || loading} writeLock={writeLock} onBusyChange={reportBusy}
        onCancel={() => { if (!writeLock.current) setEditing(null); }} onSaved={acceptSaved} /></div> : null;
      if (!available) return <section key={key} className="cognition-card p-3"><p className="cognition-muted">该认知已移除或不再属于当前版本，无法从此处更新。{editForm && '未保存草稿仍保留，请重新核对目标。'}</p>{editForm}</section>;
      const origin = cognitionNodeOrigin(record, branch.id, node.id);
      return <section key={key} className="cognition-card p-3">
        <h4 className="font-medium">{branch.graph.title || '我的理解'} · {branch.kind === 'alternative' ? '未决分歧' : branch.kind === 'contextual' ? '不同情境' : '主要理解'}</h4>
        <p className="mt-1 text-xs">{(node.stance || branch.stance) === 'endorsed' ? '当前认同' : '暂定／待验证'} · 记录于 {new Date(origin.at).toLocaleString('zh-CN')} · {origin.source.kind === 'review_answer' ? '复习回答' : origin.source.kind === 'restatement' ? '学习复述' : origin.source.kind === 'argument_editor' ? '论证编辑器' : '手动更新'}</p>
        <p className="my-2 whitespace-pre-wrap break-words">{node.text}</p>
        {branch.context && <p className="text-xs">情境／说明：{branch.context}</p>}
        {branch.reviewNeededNodeIds?.includes(node.id) && <p className="cognition-notice">关联主张已变化，待复核，不代表错误。</p>}
        {ref.revisionId !== revision.id && <p className="cognition-notice my-2">已不同于回答当时引用的版本。请基于当前原文重新核对，不能直接照搬旧建议。</p>}
        {editForm || <div className="cognition-actions"><button type="button" className="cognition-action" disabled={busy || loading || !!editing}
          onClick={() => { if (writeLock.current) return; setEditing({ key, reference: ref }); setMessage(''); }}>更新这条理解</button></div>}
      </section>;
    })}
    <p role="status" className="text-xs">{message}</p>
  </div>;
}

export function AgentCognitionReferences({ references }: { references: CognitionReference[] }) {
  const [opened, setOpened] = useState(false);
  const safe = references.filter((r) => r && [r.recordId, r.revisionId, r.branchId, r.nodeId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 300))
    .filter((r, index, items) => items.findIndex((v) => v.recordId === r.recordId && v.branchId === r.branchId && v.nodeId === r.nodeId) === index).slice(0, 32);
  // Once opened, keep the editor subtree mounted even if message metadata changes.
  // CurrentReferences owns any retained draft; an empty pointer list is not a save.
  if (!safe.length && !opened) return null;
  return <details className="cognition-ui cognition-card mt-3 p-3"
    onToggle={(e) => { if (e.target === e.currentTarget && e.currentTarget.open) setOpened(true); }}>
    <summary className="cursor-pointer font-medium">{safe.length ? `查看相关个人认知（${safe.length}）` : '相关个人认知 · 引用已变化'}</summary>
    {!safe.length && <p className="cognition-notice mt-3">当前消息的引用列表已变化。未保存的编辑仍保留，保存前请重新核对。</p>}
    {opened && <CurrentReferences key="current-references" references={safe} />}
  </details>;
}
