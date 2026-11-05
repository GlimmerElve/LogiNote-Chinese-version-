import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, UserCheck2, Lightbulb, Loader2, X, RefreshCw, AlertCircle } from 'lucide-react';
import { useDialog } from './useDialog';
import type { NoteItem, KnowledgePointCandidate } from '../types';
import './LearningAnalysisDialogs.css';

interface KnowledgePointSelectionModalProps {
  candidates: KnowledgePointCandidate[];
  knowledgeNotes: NoteItem[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onClose: () => void;
  onConfirm: (selected: KnowledgePointCandidate[]) => void;
}

function resolveMergeTarget(value: string, notes: NoteItem[]) {
  const q = value.trim().toLowerCase();
  return notes.find((note) => [note.title, ...(note.aliases || [])].some((name) => name.trim().toLowerCase() === q));
}

/** Blank retains the existing new-note rule; mouse and keyboard share one selection path. */
const MergeField: React.FC<{
  knowledgeNotes: NoteItem[]; value: string; name: string; open: boolean;
  onOpenChange: (open: boolean) => void; onChange: (value: string) => void;
}> = ({ knowledgeNotes, value, name, open, onOpenChange, onChange }) => {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => knowledgeNotes.filter((note) => !q || note.title.toLowerCase().includes(q)
    || (note.aliases || []).some((alias) => alias.toLowerCase().includes(q))).slice(0, 8), [q, knowledgeNotes]);
  const activeIndex = matches.findIndex((note) => note.id === activeId);
  const invalidTarget = Boolean(q && !resolveMergeTarget(value, knowledgeNotes));
  useLayoutEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);
  const choose = (title: string) => { onChange(title); onOpenChange(false); setActiveId(null); inputRef.current?.focus(); };
  return (
    <div className="learning-merge" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false);
    }}>
      <label htmlFor={id}>归并目标<span>留空则新建笔记</span></label>
      <div className="learning-merge-input">
        <input ref={inputRef} id={id} role="combobox" aria-label={`归并目标：${name}`}
          aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
          aria-invalid={invalidTarget} aria-describedby={invalidTarget ? `${id}-hint` : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          value={value} placeholder="搜索已有知识点笔记" onFocus={() => onOpenChange(true)}
          onChange={(event) => { onChange(event.target.value); setActiveId(null); onOpenChange(true); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); onOpenChange(true);
              if (matches.length) {
                const next = activeIndex < 0 ? (event.key === 'ArrowDown' ? 0 : matches.length - 1)
                  : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
                setActiveId(matches[next].id);
              }
            } else if (event.key === 'Enter' && open && activeIndex >= 0) {
              event.preventDefault(); if (!event.repeat) choose(matches[activeIndex].title);
            }
          }} />
        {value && <button type="button" aria-label={`清除${name}的归并目标`}
          onClick={() => choose('')}><X aria-hidden="true" /></button>}
      </div>
      {invalidTarget && <p id={`${id}-hint`} className="learning-merge-hint">请选择已有笔记，或清除输入以新建笔记。</p>}
      {open && <div className="learning-merge-options" id={`${id}-list`} role="listbox" aria-label="已有知识点笔记">
        {matches.map((note, index) => <button key={note.id} id={`${id}-option-${index}`} type="button"
          role="option" aria-selected={activeIndex === index} tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(note.title)}>{note.title}</button>)}
        {!matches.length && <p>无匹配笔记；清除目标可新建笔记。</p>}
      </div>}
    </div>
  );
};

export const KnowledgePointSelectionModal: React.FC<KnowledgePointSelectionModalProps> = ({
  candidates, knowledgeNotes, loading = false, error = '', onRetry, onClose, onConfirm,
}) => {
  const titleId = useId(), descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null), retryRef = useRef<HTMLButtonElement>(null), selectAllRef = useRef<HTMLButtonElement>(null);
  const retryFocus = useRef(false), completed = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [activeMergeId, setActiveMergeId] = useState<string | null>(null);
  const close = () => { if (!completed.current) { completed.current = true; onClose(); } };
  useDialog(true, dialogRef, () => { if (activeMergeId) setActiveMergeId(null); else close(); }, 300);
  useEffect(() => {
    const ids = new Set(candidates.map((candidate) => candidate.id));
    setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
    setMergeTargets((previous) => Object.fromEntries(candidates.filter((candidate) => candidate.category === 'potential')
      .map((candidate) => [candidate.id, previous[candidate.id] ?? candidate.existingNoteTitle ?? ''])));
  }, [candidates]);
  useLayoutEffect(() => {
    if (loading || !retryFocus.current) return;
    retryFocus.current = false;
    if (document.activeElement === document.body || document.activeElement === dialogRef.current) {
      (error ? retryRef.current : selectAllRef.current)?.focus();
    }
  }, [loading, error]);
  const picked = candidates.filter((candidate) => selected.has(candidate.id));
  const hasInvalidTarget = picked.some((candidate) => candidate.category === 'potential'
    && Boolean(mergeTargets[candidate.id]?.trim()) && !resolveMergeTarget(mergeTargets[candidate.id], knowledgeNotes));
  const allSelected = candidates.length > 0 && picked.length === candidates.length;
  const toggle = (id: string) => setSelected((previous) => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const confirm = () => {
    if (loading || hasInvalidTarget || !picked.length || completed.current) return;
    completed.current = true;
    onConfirm(picked.map((candidate) => candidate.category === 'potential'
      ? { ...candidate, existingNoteTitle: mergeTargets[candidate.id]?.trim()
        ? resolveMergeTarget(mergeTargets[candidate.id], knowledgeNotes)?.title : undefined } : candidate));
  };
  return (
    <div className="learning-analysis-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="learning-analysis-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId}>
        <header>
          <div><span className="learning-analysis-eyebrow">LEARNING REVIEW</span><h2 id={titleId}>选择要分析的知识点</h2>
            <p id={descriptionId}>确认本次学习涉及的知识点，再开始复盘分析。</p></div>
          <button type="button" className="learning-analysis-icon" aria-label="关闭知识点选择" onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="learning-analysis-body" aria-busy={loading}>
          {loading && <div className="learning-analysis-state" role="status"><Loader2 className="is-spinning" aria-hidden="true" />正在识别知识点…</div>}
          {error && <div className="learning-analysis-error" role="alert"><AlertCircle aria-hidden="true" /><p>{error}</p>
            {onRetry && <button type="button" ref={retryRef} disabled={loading} onClick={() => {
              retryFocus.current = true; onRetry();
            }}><RefreshCw aria-hidden="true" />{loading ? '正在重新识别' : '重新识别'}</button>}</div>}
          {!loading && !error && !candidates.length && <div className="learning-analysis-state">未识别到知识点，可返回笔记保留本次学习内容。</div>}
          {!loading && candidates.length > 0 && <>
            <button type="button" ref={selectAllRef} className="learning-analysis-select-all" aria-pressed={allSelected}
              onClick={() => setSelected(allSelected ? new Set() : new Set(candidates.map((candidate) => candidate.id)))}>
              <Check aria-hidden="true" />{allSelected ? '取消全选' : '全选'}<span>已选 {picked.length} / {candidates.length}</span>
            </button>
            {(['known', 'potential'] as const).map((category) => {
              const list = candidates.filter((candidate) => candidate.category === category);
              if (!list.length) return null;
              const Icon = category === 'known' ? UserCheck2 : Lightbulb;
              return <section className="learning-analysis-group" key={category} aria-label={category === 'known' ? '已知知识点' : '潜在知识点'}>
                <h3><Icon aria-hidden="true" />{category === 'known' ? '已知知识点' : '潜在知识点'}<span>{list.length}</span></h3>
                {list.map((candidate) => <div key={candidate.id} className={`learning-analysis-candidate${selected.has(candidate.id) ? ' is-selected' : ''}`}>
                  <button type="button" className="learning-analysis-choice" aria-pressed={selected.has(candidate.id)} onClick={() => toggle(candidate.id)}>
                    <span className="learning-analysis-check" aria-hidden="true">{selected.has(candidate.id) && <Check />}</span>
                    <span><strong>{candidate.name}</strong>
                      {category === 'known' && candidate.existingNoteTitle && <small>归并到 {candidate.existingNoteTitle}</small>}
                      {candidate.discoverySource && <small>{candidate.discoverySource === 'explicit' ? '原文明确' : `谨慎推断${Number.isFinite(candidate.confidence) ? ` ${Math.round(candidate.confidence! * 100)}%` : ''}`}</small>}
                      {candidate.evidence && <small>依据：{candidate.evidence}</small>}</span>
                  </button>
                  {category === 'potential' && <MergeField knowledgeNotes={knowledgeNotes} name={candidate.name}
                    value={mergeTargets[candidate.id] || ''} open={activeMergeId === candidate.id}
                    onOpenChange={(open) => setActiveMergeId(open ? candidate.id : null)}
                    onChange={(value) => setMergeTargets((previous) => ({ ...previous, [candidate.id]: value }))} />}
                </div>)}
              </section>;
            })}
          </>}
        </div>
        <footer><button type="button" onClick={close}>返回笔记</button>
          <button type="button" className="is-primary" disabled={!picked.length || loading || hasInvalidTarget} onClick={confirm}>开始复盘分析（{picked.length}）</button></footer>
      </section>
    </div>
  );
};
