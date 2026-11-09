import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ArgDoc } from '../services/argumentDoc/types';
import { applyCognitionMutation, latestCognition } from '../services/cognition/core';
import { loadPersonalCognition, savePersonalCognition, subscribePersonalCognition } from '../services/cognition/store';
import { COGNITION_OPERATION_LABELS, COGNITION_RELATION_LABELS as RELATION_LABELS } from '../services/cognition/types';
import type { CognitionFile, CognitionMutation, CognitionOperation, CognitionRevision } from '../services/cognition/types';
import './PersonalCognition.css';
import { useCognitionLeaveProtection } from './useCognitionLeaveProtection';
import { cognitionRoleLabel } from '../services/cognition/roles';
import { CognitionFlowStructureDetails } from './CognitionFlowStructureDetails';

const field = 'cognition-field';
const button = 'cognition-action';

export function CognitionRevisionContent({ revision }: { revision: CognitionRevision }) {
  return <div className="cognition-ui cognition-content space-y-3">
    <p>个人认知 · 非事实依据 · 尚未据此评定掌握</p>
    {revision.meaning && <details><summary>本次变更的语义说明</summary><p>{revision.meaning.interpretation}</p>{revision.meaning.preserved.map(fragment => <p key={fragment}>逐字保留：{fragment}</p>)}{revision.meaning.conditions?.changes.map((change, index) => <p key={index}>{change.kind === 'add' ? `新增条件：${change.after}` : change.kind === 'remove' ? `移除条件：${change.before}` : `替换条件：${change.before} → ${change.after}`}</p>)}</details>}
    {revision.branches.map((branch) => <section key={branch.id} className="cognition-card">
      <h4 className="font-semibold">{branch.graph.title || '未命名理解'} · {branch.kind === 'primary' ? '主要理解' : branch.kind === 'contextual' ? '不同情境' : '未决分歧'}</h4>
      {branch.context && <p>{branch.context}</p>}
      <ul className="mt-2 space-y-2">
        {branch.graph.nodes.map((n, index) => <li key={n.id} className="whitespace-pre-wrap break-words"><strong>节点 {index + 1} · {cognitionRoleLabel(n)}</strong> · {(n.stance || branch.stance) === 'endorsed' ? '当前认同' : '暂定／待验证'}<br />{n.text}
          <CognitionFlowStructureDetails graph={branch.graph} nodeId={n.id} />
          {n.conditions !== undefined && <details><summary>已记录条件（{n.conditions.length}）</summary>{n.conditions.length
            ? <ul>{n.conditions.map(condition => <li key={condition}>{condition}</li>)}</ul>
            : <p>尚无已标注条件，不代表这项观点客观上无条件成立。</p>}</details>}
          {branch.reviewNeededNodeIds?.includes(n.id) && <p className="mt-1 text-amber-800 dark:text-amber-200">关联主张或关系已变化，待复核（不代表错误）</p>}</li>)}
      </ul>
      {branch.graph.edges.length > 0 && <details className="mt-2"><summary className="cursor-pointer">论证关系（{branch.graph.edges.length}）</summary>
        <ul>{branch.graph.edges.map((e) => <li key={e.id}>节点 {branch.graph.nodes.findIndex((n) => n.id === e.source) + 1} → 节点 {branch.graph.nodes.findIndex((n) => n.id === e.target) + 1} · {RELATION_LABELS[e.relation]}
          {e.reason && <p className="whitespace-pre-wrap break-words">关系说明：{e.reason}</p>}</li>)}</ul>
      </details>}
    </section>)}
    <p>本次变更来源：{revision.authorship === 'own_expression' ? '用户自己的表述' : '有辅助或辅助情况未记录'} · {revision.source.kind === 'argument_editor' ? `来源图：${revision.source.docId}${revision.source.noteId ? ` · 笔记：${revision.source.noteId}` : ''}` : revision.source.kind === 'manual_revision' ? '认知库中手动更新' : revision.source.kind === 'restatement' ? `学习复述：${revision.source.sessionId} · 自动记录` : `复习回答：${revision.source.observation.activityId} · 提示程度：${revision.source.observation.hintLevel ?? '未知'}${revision.source.automatic ? ' · 自动记录' : ''}`}</p>
    {revision.source.kind === 'review_answer' && <details><summary className="cursor-pointer">回答原文与提问上下文</summary>
      <p className="mt-2 whitespace-pre-wrap">提问上下文（不是用户观点）：{revision.source.observation.question}</p>
      <p className="mt-2 whitespace-pre-wrap">回答原文：{revision.source.observation.answer}</p>
      <p className="mt-2">{new Date(revision.source.observation.observedAt).toLocaleString('zh-CN')} · 查阅资料 {revision.source.observation.consultedMaterialIds.length} 项 · 修改确认稿不改写原文</p>
    </details>}
  </div>;
}

export function CognitionHistory({ revisions }: { revisions: CognitionRevision[] }) {
  return <details className="mt-3 text-xs">
    <summary className="cursor-pointer">版本历史（{revisions.length}）</summary>
    <div className="mt-2 space-y-3">{[...revisions].reverse().map((v) => <details key={v.id} className="cognition-card">
      <summary className="cursor-pointer">v{v.number} · {COGNITION_OPERATION_LABELS[v.operation]} · {new Date(v.at).toLocaleString('zh-CN')}</summary>
      <p className="my-2">{v.reason || '首次保存个人理解'}</p>
      <CognitionRevisionContent revision={v} />
    </details>)}</div>
  </details>;
}

export function PersonalCognitionPanel({ doc, noteId }: { doc: ArgDoc; noteId?: string | null }) {
  const id = useId();
  const [file, setFile] = useState<CognitionFile | null>(null);
  const [operation, setOperation] = useState<CognitionOperation>('initial');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const leave = useCognitionLeaveProtection(busy, busyRef);
  const fileRef = useRef(file);
  const request = useRef(0);
  fileRef.current = file;
  const record = file?.records.find((r) => r.docId === doc.doc_id);
  const current = record && latestCognition(record);
  const parallel = operation === 'contextual' || operation === 'alternative';
  const stance = current?.branches.find(branch => branch.id === 'primary')?.stance || 'endorsed';
  // This entry may contain an assisted analysis graph. Keep that provenance
  // internally instead of asking the user to classify their expression again.
  const authorship = 'adopted_with_assistance' as const;

  async function reload() {
    if (busyRef.current) return;
    const token = ++request.current;
    setLoading(true); setError('');
    try {
      const next = await loadPersonalCognition();
      if (!mounted.current || token !== request.current) return;
      const existing = next.records.find((r) => r.docId === doc.doc_id);
      setFile(next); setStale(false);
      setOperation(existing ? 'supplement' : 'initial');
    } catch (e) { if (mounted.current && token === request.current) { setError((e as Error).message); setStale(true); } }
    finally { if (mounted.current && token === request.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    const off = subscribePersonalCognition(() => {
      if (busyRef.current) return;
      const token = ++request.current;
      void loadPersonalCognition().then((next) => {
        if (!mounted.current || token !== request.current) return;
        // Do not silently rebase a reviewed draft. Initial loading has no draft yet.
        if (!fileRef.current) {
          const existing = next.records.find((r) => r.docId === doc.doc_id);
          setFile(next); setOperation(existing ? 'supplement' : 'initial');
        } else if (next.revision !== fileRef.current.revision) { setStale(true); }
        setLoading(false);
      }).catch((e) => { if (mounted.current && token === request.current) { setError((e as Error).message); setStale(true); setLoading(false); } });
    });
    return () => { mounted.current = false; request.current++; off(); };
  }, []);

  const graphFingerprint = JSON.stringify([doc.doc_id, doc.title, doc.nodes.map((n) => [n.id, n.role, n.mainType, n.text]), doc.edges, doc.flowStructure]);
  const graphRef = useRef(graphFingerprint);
  graphRef.current = graphFingerprint;
  useEffect(() => { setMessage(''); }, [graphFingerprint]);
  const input: CognitionMutation = { kind: 'confirm', expectedRevision: file?.revision ?? 0, confirmed: true,
    operation, reason: reason.trim() || (parallel || operation === 'initial' ? '' : `用户确认${COGNITION_OPERATION_LABELS[operation]}`), stance, authorship, doc, ...(noteId ? { noteId } : {}) };
  const preview = useMemo(() => {
    if (!file) return { revision: null, error: '' };
    try {
      const next = applyCognitionMutation(file, input, { id: 'preview', at: new Date().toISOString() });
      return { revision: latestCognition(next.records.find((r) => r.docId === doc.doc_id)!), error: '' };
    } catch (e) { return { revision: null, error: (e as Error).message }; }
  }, [file, graphFingerprint, operation, reason, stance, authorship, noteId]);

  async function save() {
    if (!preview.revision || busyRef.current || stale || loading) return;
    const savedGraph = graphFingerprint;
    request.current++;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await savePersonalCognition(input);
      if (!mounted.current) return;
      request.current++; setFile(next); setStale(false);
      if (graphRef.current === savedGraph) {
        leave.setDirty(false);
        setReason(''); setOperation('supplement');
      } else leave.setDirty(true);
      setMessage(graphRef.current === savedGraph
        ? '已将刚才确认的理解快照保存到私人认知库。没有发布为事实依据，也没有提高掌握度。'
        : '已保存提交时确认的理解快照。画布随后有变化，请重新核对当前预览；后续变化尚未写入。');
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  return <div ref={leave.root} tabIndex={-1} className="cognition-ui space-y-4" aria-label="个人认知确认" aria-busy={busy || loading}>
    {leave.notice && <p role="status" className="cognition-notice">{leave.notice}</p>}
    <div><h3 className="font-semibold">确认我的理解</h3>
      <p className="mt-2 text-xs leading-relaxed">复盘生成的论证图先保留为草稿。请核对并修改节点和关系，再明确保存为自己的理解；仅保存复盘结果不会写入认知库。</p>
      <p className="mt-2 text-xs">私有存储，不随笔记分享。不等于客观事实，也不等于已经学会。</p>
    </div>
    {current && <details><summary className="cursor-pointer text-xs">已保存的当前理解 · v{current.number}</summary><CognitionRevisionContent revision={current} /></details>}
    {stale && <p role="alert" className="cognition-notice">认知库可能已变化，请重新加载并核对后再确认。</p>}
    <button type="button" className={button} disabled={busy || loading} onClick={() => void reload()}>{loading ? '正在读取…' : '重新加载认知记录'}</button>
    {!file && !error && <p role="status">正在读取个人认知…</p>}
    {file && <fieldset disabled={busy || stale || loading} className="space-y-3 disabled:opacity-60" onChange={() => leave.setDirty(true)}>
      <legend className="sr-only">确认当前论证为个人理解</legend>
      {record && <details><summary>其他保存方式 · {COGNITION_OPERATION_LABELS[operation]}</summary><label className="block" htmlFor={`${id}-operation`}>更新方式
        <select id={`${id}-operation`} className={field} value={operation} onChange={(e) => setOperation(e.target.value as CognitionOperation)}>
          {(['supplement', 'revise', 'contextual', 'alternative'] as const).map(op => <option key={op} value={op}>{COGNITION_OPERATION_LABELS[op]}</option>)}
        </select>
      </label></details>}
      <p className="text-xs leading-relaxed">{operation === 'supplement' ? '保留旧主张与旧连线，仅加入新节点／连线。例如新增 D 不会删除 C，也不会自动改写成“C 或 D”。' : ['revise', 'qualify', 'certainty'].includes(operation) ? '用当前画布替换主要理解，旧版本保留在历史中。其他情境和未决分支仍保留；系统不自动推断哪些结论已失效，请在预览中逐项核对。' : operation === 'contextual' || operation === 'alternative' ? '保留原有理解，将当前画布另存为并存分支，不自动判断哪一方正确。未决分歧始终标为待验证。' : '确认下方实际预览的节点和关系，而不是自动采信 AI 的诊断或总结。'}</p>
      {parallel ? <label className="block" htmlFor={`${id}-reason`}>{operation === 'contextual' ? '适用情境' : '保留分歧的说明'}
        <textarea id={`${id}-reason`} className={field} rows={2} maxLength={4000} required value={reason} onChange={event => setReason(event.target.value)} />
      </label> : <details><summary>添加更新说明（选填）</summary><label htmlFor={`${id}-reason`}>更新说明
        <textarea id={`${id}-reason`} className={field} rows={2} maxLength={4000} value={reason} onChange={event => setReason(event.target.value)} />
      </label></details>}
      {preview.error && <p role="status" className="text-xs text-amber-800 dark:text-amber-200">{preview.error}</p>}
      {preview.revision && <details open className="cognition-preview"><summary className="mb-2 cursor-pointer font-medium">本次保存后的完整理解</summary><CognitionRevisionContent revision={preview.revision} /></details>}
      <button type="button" disabled={!preview.revision || busy || stale || loading} onClick={() => void save()} className="cognition-action is-primary w-full">{busy ? '正在保存…' : '保存到个人认知库'}</button>
    </fieldset>}
      {leave.dirty && <button type="button" className="cognition-action" disabled={busy || loading} onClick={() => {
        if (busyRef.current) return;
        setReason(''); setOperation(current ? 'supplement' : 'initial');
        leave.setDirty(false); setError('');
      }}>取消本次认知整理</button>}
    {error && <p role="alert" className="cognition-error">{error}</p>}
    <p role="status" className="text-xs">{message}</p>
    {record && <CognitionHistory revisions={record.revisions} />}
  </div>;
}
