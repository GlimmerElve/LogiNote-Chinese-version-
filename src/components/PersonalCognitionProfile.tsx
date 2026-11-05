import React, { useEffect, useRef, useState } from 'react';
import { latestCognition } from '../services/cognition/core';
import { loadPersonalCognition, subscribePersonalCognition } from '../services/cognition/store';
import type { CognitionFile } from '../services/cognition/types';
import { CognitionHistory, CognitionRevisionContent } from './PersonalCognitionPanel';
import { CognitionCandidateInbox } from './CognitionCandidateInbox';
import { CognitionEditForm } from './CognitionEditForm';
import { useCognitionWrite } from './useCognitionWrite';
import './PersonalCognition.css';

/** Private understanding with explicit versioned updates; no ability-score mutation. */
export function PersonalCognitionProfile() {
  const [file, setFile] = useState<CognitionFile | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [forget, setForget] = useState<{ id: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const request = useRef(0);
  const writeLock = useRef(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function reportBusy(value: boolean) { if (mounted.current) setBusy(value); }
  function acceptSaved(next: CognitionFile) {
    request.current++; // A read started before this write must not overwrite its result.
    setFile(next); setError(''); setLoading(false); setBusy(false);
  }
  const removal = useCognitionWrite((next) => {
    acceptSaved(next); setForget(null); setMessage('这份私人认知记录已忘记。原笔记与论证图未删除。');
  }, { lock: writeLock, onBusyChange: reportBusy });
  useEffect(() => {
    let active = true;
    const reload = () => {
      const token = ++request.current;
      setLoading(true);
      void loadPersonalCognition().then((next) => { if (active && token === request.current) { setFile(next); setError(''); } })
        .catch((e) => { if (active && token === request.current) setError((e as Error).message); })
        .finally(() => { if (active && token === request.current) setLoading(false); });
    };
    reload();
    const off = subscribePersonalCognition(reload);
    return () => { active = false; off(); };
  }, [refresh]);
  async function remove() {
    if (!forget || forget.revision !== file?.revision || editing) return;
    await removal.write({ kind: 'forget', recordId: forget.id, expectedRevision: forget.revision, confirmed: true });
  }
  const activeRecords = file?.records.filter(record => !record.withdrawn) || [];
  const records = activeRecords.filter((r) => r.id === editing || r.id === forget?.id || latestCognition(r).branches.some((b) =>
    `${b.graph.title} ${b.graph.nodes.map((n) => n.text).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  return <section className="profile-evidence-group cognition-ui" aria-label="个人认知库" aria-busy={busy || loading}>
    <div className="profile-evidence-group-head"><span className="home-tick" /><h3>我的理解 · 个人认知库</h3><span>{activeRecords.length} 份认知记录</span></div>
    <p className="my-3 text-sm">这是用户画像中的知识理解部分。记录你认同什么、保留哪些疑问以及如何修订，不把记录数量换算成掌握度。</p>
    <div className="cognition-search"><label>查找当前理解<input value={query} onChange={(e) => setQuery(e.target.value)} className="cognition-field" placeholder="按标题或原话查找" /></label>
      <button type="button" className="cognition-action" disabled={busy || loading} onClick={() => { if (!writeLock.current) setRefresh((n) => n + 1); }}>{loading ? '正在读取…' : '重新加载'}</button></div>
    {editing && <p className="cognition-muted">正在编辑的理解会保留在列表中；请先保存或取消，再编辑其他记录。</p>}
    {error && <p role="alert" className="cognition-error">读取未成功，已显示的记录仍保留。{error}</p>}
    <p role="status" className="text-sm">{message}</p>
    {!file && !error && <p role="status">正在读取个人认知…</p>}
    {file && <CognitionCandidateInbox file={file} onSaved={acceptSaved} disabled={busy || !!editing || !!forget} writeLock={writeLock} onBusyChange={reportBusy} />}
    {file && !activeRecords.length && <p className="my-3 text-sm">保存复述或复习回答后会自动显示在这里，无需再次确认。上传资料和 AI 内容不自动入库。</p>}
    {!!file?.records.length && !records.length && <p>没有匹配的当前理解。</p>}
    <div className="space-y-3">{records.map((record) => {
      const latest = latestCognition(record);
      return <details className="cognition-card" key={record.id}>
        <summary className="cursor-pointer font-medium">{latest.branches[0].graph.title || '未命名理解'} · v{latest.number} · {new Date(latest.at).toLocaleString('zh-CN')}</summary>
        <div className="mt-3"><CognitionRevisionContent revision={latest} /><CognitionHistory revisions={record.revisions} /></div>
        <p className="mt-3 text-xs">修改只影响私人认知，不改写来源笔记、原论证图或已发布资料。</p>
        {editing === record.id ? <div className="mt-3"><CognitionEditForm key={record.id} file={file!} recordId={record.id} writeLock={writeLock} onBusyChange={reportBusy} onCancel={() => setEditing(null)} onSaved={(next) => { acceptSaved(next); setEditing(null); setMessage('理解已更新，旧版本保留在历史中。'); }} /></div>
          : <div className="cognition-actions"><button type="button" className="cognition-action" disabled={busy || !!editing || !!forget} onClick={() => { if (writeLock.current) return; setEditing(record.id); setMessage(''); }}>更新这份理解</button></div>}
        {forget?.id !== record.id ? <div className="cognition-actions"><button type="button" className="cognition-action is-danger" disabled={busy || !!editing || !!forget} onClick={() => { if (writeLock.current) return; removal.clearError(); setForget({ id: record.id, revision: file!.revision }); }}>忘记这份认知记录…</button></div> : <div className="cognition-notice mt-3 space-y-2">
          <p>将永久移除这份私人认知及全部版本历史。不会删除原论证图、笔记或已发布内容。此操作不能在应用中撤销。</p>
          {forget.revision !== file!.revision && <p role="alert">认知库已变化，请取消后重新核对这份记录，再决定是否忘记。</p>}
          <div className="cognition-actions"><button type="button" className="cognition-action is-danger" disabled={busy || forget.revision !== file!.revision} onClick={() => void remove()}>{removal.busy ? '正在移除…' : '确认忘记'}</button>
            <button type="button" className="cognition-action" disabled={busy} onClick={() => { setForget(null); removal.clearError(); }}>取消</button></div>
          {removal.error && <p role="alert" className="cognition-error">移除未成功，记录与确认区域均已保留。{removal.error}</p>}
        </div>}
      </details>;
    })}</div>
  </section>;
}
