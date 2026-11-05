import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Eye, Link2, Loader2, Search, Unlink } from 'lucide-react';
import type { ArgumentEvidenceCandidate, ArgumentEvidencePreview } from '../services/argumentDoc/evidenceSources';
import type { ArgDoc, ArgumentSourceRef } from '../services/argumentDoc/types';
import { ArgumentEvidenceRequestScope, argumentEvidenceScopeKey, isCurrentArgumentEvidenceCandidate } from '../services/ui/argumentEvidenceRequestScope';

interface ArgumentEvidenceSourcesProps {
  doc: ArgDoc;
  onSearch: (nodeId: string) => Promise<ArgumentEvidenceCandidate[]>;
  onBind: (nodeId: string, candidate: ArgumentEvidenceCandidate) => Promise<void>;
  onRemove: (nodeId: string, source: ArgumentSourceRef) => void;
  onPreview: (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => Promise<ArgumentEvidencePreview>;
  onOpenOriginal: (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => Promise<void>;
}

function sourceKey(source: ArgumentSourceRef | ArgumentEvidenceCandidate): string {
  return `${source.type}:${source.entityId}:${source.chunkId || ''}`;
}

export const ArgumentEvidenceSources: React.FC<ArgumentEvidenceSourcesProps> = ({
  doc,
  onSearch,
  onBind,
  onRemove,
  onPreview,
  onOpenOriginal,
}) => {
  const preferredNodeId = useMemo(
    () => doc.nodes.find((node) => node.mainType === '事实陈述')?.id || doc.nodes[0]?.id || '',
    [doc.nodes],
  );
  const [nodeId, setNodeId] = useState(preferredNodeId);
  const [candidates, setCandidates] = useState<ArgumentEvidenceCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [bindingId, setBindingId] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ArgumentEvidencePreview | null>(null);
  const [previewingId, setPreviewingId] = useState('');
  const [candidateScope, setCandidateScope] = useState('');
  const mounted = useRef(true);
  const requestScope = useRef(new ArgumentEvidenceRequestScope());

  useEffect(() => {
    if (!doc.nodes.some((node) => node.id === nodeId)) setNodeId(preferredNodeId);
  }, [doc.nodes, nodeId, preferredNodeId]);

  const node = doc.nodes.find((item) => item.id === nodeId);
  const currentScope = argumentEvidenceScopeKey(doc, nodeId);
  requestScope.current.setScope(currentScope);
  const sources = node?.sources || [];
  const boundKeys = new Set(sources.map(sourceKey));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestScope.current.invalidate();
    };
  }, []);

  useEffect(() => {
    setCandidates([]);
    setCandidateScope('');
    setPreview(null);
    setSearching(false);
    setBindingId('');
    setPreviewingId('');
    setError('');
  }, [currentScope]);

  const handleSearch = async () => {
    if (!nodeId) return;
    const requestedNodeId = nodeId;
    const ticket = requestScope.current.begin('search');
    setSearching(true);
    setError('');
    setCandidates([]);
    setCandidateScope('');
    try {
      const next = await onSearch(requestedNodeId);
      if (!mounted.current || !requestScope.current.owns(ticket)) return;
      setCandidates(next);
      setCandidateScope(ticket.scope);
    } catch (searchError) {
      if (!mounted.current || !requestScope.current.owns(ticket)) return;
      setError(searchError instanceof Error ? searchError.message : '检索证据失败');
    } finally {
      if (mounted.current && requestScope.current.owns(ticket)) setSearching(false);
    }
  };

  const handleBind = async (candidate: ArgumentEvidenceCandidate) => {
    if (!isCurrentArgumentEvidenceCandidate(candidateScope, currentScope, candidate.id, candidates.map((item) => item.id))) {
      setError('候选来源已失效，请重新检索当前主张');
      return;
    }
    const requestedNodeId = nodeId;
    setBindingId(candidate.id);
    setError('');
    try {
      await onBind(requestedNodeId, candidate);
    } catch (bindError) {
      setError(bindError instanceof Error ? bindError.message : '绑定证据失败');
    } finally {
      setBindingId('');
    }
  };

  const handlePreview = async (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => {
    const key = sourceKey(source);
    if ('id' in source && !isCurrentArgumentEvidenceCandidate(candidateScope, currentScope, source.id, candidates.map((item) => item.id))) {
      setError('候选来源已失效，请重新检索当前主张');
      return;
    }
    const ticket = requestScope.current.begin('preview');
    setPreviewingId(key);
    setError('');
    try {
      const next = await onPreview(source);
      if (!mounted.current || !requestScope.current.owns(ticket)) return;
      setPreview(next);
    } catch (previewError) {
      if (!mounted.current || !requestScope.current.owns(ticket)) return;
      setError(previewError instanceof Error ? previewError.message : '读取来源失败');
    } finally {
      if (mounted.current && requestScope.current.owns(ticket)) setPreviewingId('');
    }
  };

  const handleOpen = async (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => {
    setError('');
    try {
      await onOpenOriginal(source);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : '打开来源失败');
    }
  };

  return (
    <section className="argument-evidence-ui" aria-labelledby="argument-evidence-heading" aria-busy={searching || Boolean(bindingId || previewingId)}>
      <h3 id="argument-evidence-heading" className="argument-evidence-title">可核验证据</h3>
      <p className="argument-evidence-description">
        选择主张后检索本地笔记和上传资料。只有点击“绑定”才会成为该节点的来源。
      </p>
      <label className="argument-evidence-label" htmlFor="argument-evidence-node">目标节点</label>
      <select
        id="argument-evidence-node"
        value={nodeId}
        onChange={(event) => {
          setNodeId(event.target.value);
          setCandidates([]);
          setPreview(null);
        }}
        className="argument-evidence-select"
      >
        {doc.nodes.map((item) => (
          <option key={item.id} value={item.id}>{item.id} · {item.mainType} · {item.text.slice(0, 24)}</option>
        ))}
      </select>

      <button
        type="button"
        onClick={handleSearch}
        disabled={!nodeId || searching}
        className="argument-evidence-search"
      >
        {searching ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Search aria-hidden="true" />}
        {searching ? '正在检索…' : '检索该主张的证据'}
      </button>

      {error && <div className="argument-evidence-error" role="alert">{error}</div>}

      {sources.length > 0 && (
        <div className="argument-evidence-group">
          <div className="argument-evidence-group-title">已绑定（{sources.length}）</div>
          {sources.map((source) => {
            const key = sourceKey(source);
            return (
              <article key={key} className="argument-evidence-card is-bound">
                <div className="argument-evidence-card-title">{source.type === 'document' ? '资料' : '笔记'} · {source.title || source.entityId}</div>
                <div className="argument-evidence-quote">{source.quote}</div>
                <div className="argument-evidence-actions">
                  <button type="button" onClick={() => handlePreview(source)} disabled={previewingId === key} className="argument-evidence-action">
                    {previewingId === key ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Eye aria-hidden="true" />}预览
                  </button>
                  <button type="button" onClick={() => void handleOpen(source)} className="argument-evidence-action">
                    <ExternalLink aria-hidden="true" />打开原文
                  </button>
                  <button type="button" onClick={() => onRemove(nodeId, source)} className="argument-evidence-action is-danger">
                    <Unlink aria-hidden="true" />解除绑定
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="argument-evidence-group">
          <div className="argument-evidence-group-title">候选来源</div>
          {candidates.map((candidate) => {
            const key = sourceKey(candidate);
            const bound = boundKeys.has(key);
            return (
              <article key={candidate.id} className="argument-evidence-card">
                <div className="argument-evidence-card-head">
                  <div className="argument-evidence-card-title">{candidate.type === 'document' ? '资料' : '笔记'} · {candidate.title}</div>
                  <span className="argument-evidence-score">相关度 {Math.round(candidate.score * 100)}%</span>
                </div>
                {candidate.sectionPath?.length ? <div className="argument-evidence-path">{candidate.sectionPath.join(' › ')}</div> : null}
                <div className="argument-evidence-quote is-candidate">{candidate.quote}</div>
                <div className="argument-evidence-actions">
                  <button type="button" onClick={() => handlePreview(candidate)} disabled={previewingId === key} className="argument-evidence-action">
                    {previewingId === key ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Eye aria-hidden="true" />}预览
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBind(candidate)}
                    disabled={bound || bindingId === candidate.id}
                    className="argument-evidence-action is-primary"
                  >
                    {bindingId === candidate.id ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                    {bound ? '已绑定' : '绑定'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {preview && (
        <aside className="argument-evidence-preview" aria-label="证据预览">
          <div className="argument-evidence-card-head">
            <div>
              <div className="argument-evidence-card-title">{preview.title}</div>
              <div className="argument-evidence-preview-subtitle">{preview.subtitle}</div>
            </div>
            <button type="button" onClick={() => setPreview(null)} className="argument-evidence-preview-close" aria-label="关闭证据预览">×</button>
          </div>
          <div className="argument-evidence-preview-content">{preview.content}</div>
        </aside>
      )}
    </section>
  );
};
