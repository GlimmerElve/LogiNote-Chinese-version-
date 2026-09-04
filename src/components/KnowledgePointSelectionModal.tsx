import React, { useEffect, useMemo, useState } from 'react';
import { Check, UserCheck2, Lightbulb, Loader2, X, Plus } from 'lucide-react';
import type { NoteItem, KnowledgePointCandidate, KnowledgePointCategory } from '../types';

interface KnowledgePointSelectionModalProps {
  candidates: KnowledgePointCandidate[];
  /** 可归并的目标知识点笔记（仅 knowledge 类型） */
  knowledgeNotes: NoteItem[];
  loading?: boolean;
  onClose: () => void;
  onConfirm: (selected: KnowledgePointCandidate[]) => void;
}

const CATEGORY_META: Record<KnowledgePointCategory, { label: string; icon: React.ReactNode; desc: string }> = {
  known: { label: '已知知识点', icon: <UserCheck2 className="w-3.5 h-3.5 text-indigo-500" />, desc: '提到具体名词且有笔记' },
  potential: { label: '潜在知识点', icon: <Lightbulb className="w-3.5 h-3.5 text-amber-500" />, desc: '新概念或语义相关的潜在概念' },
};

/** 单个潜在知识点的「归并到已有笔记 / 新建笔记」选择控件 */
const MergeField: React.FC<{
  knowledgeNotes: NoteItem[];
  value: string;
  onChange: (v: string) => void;
}> = ({ knowledgeNotes, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const q = (value || '').trim().toLowerCase();

  const matches = useMemo(() => {
    const list = q
      ? knowledgeNotes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            (n.aliases || []).some((a) => a.toLowerCase().includes(q)),
        )
      : knowledgeNotes;
    return list.slice(0, 8);
  }, [q, knowledgeNotes]);

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="新建笔记"
          className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 outline-none focus:border-indigo-400"
        />
        {value && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange('');
              setOpen(true);
            }}
            className="text-[10px] px-1.5 py-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            清除
          </button>
        )}
      </div>
      {open && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg">
          <li>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange('');
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Plus className="w-3.5 h-3.5" /> 新建笔记
            </button>
          </li>
          {matches.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(n.title);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
              >
                {n.title}
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-slate-400">无匹配笔记</li>
          )}
        </ul>
      )}
    </div>
  );
};

export const KnowledgePointSelectionModal: React.FC<KnowledgePointSelectionModalProps> = ({
  candidates,
  knowledgeNotes,
  loading = false,
  onClose,
  onConfirm,
}) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // 每个 potential 候选的归并目标标题；空字符串 = 新建笔记
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});

  // candidates 异步到达或自动预填时，同步每个 potential 的归并目标初始值
  useEffect(() => {
    setMergeTargets((prev) => {
      const next = { ...prev };
      for (const c of candidates) {
        if (c.category === 'potential' && !(c.id in next)) {
          next[c.id] = c.existingNoteTitle || '';
        }
      }
      return next;
    });
  }, [candidates]);

  const groups = useMemo(() => {
    const g: Record<KnowledgePointCategory, KnowledgePointCandidate[]> = { known: [], potential: [] };
    for (const c of candidates) {
      g[c.category].push(c);
    }
    return g;
  }, [candidates]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allIds = useMemo(() => candidates.map((c) => c.id), [candidates]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const handleConfirm = () => {
    const picked = candidates
      .filter((c) => selected.has(c.id))
      .map((c) => {
        if (c.category === 'potential') {
          const target = (mergeTargets[c.id] || '').trim();
          return { ...c, existingNoteTitle: target || undefined };
        }
        return c;
      });
    onConfirm(picked);
  };

  const renderKnown = () => {
    const list = groups.known;
    if (list.length === 0) return null;
    const meta = CATEGORY_META.known;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 pt-2">
          {meta.icon}
          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{meta.label}</span>
          <span className="text-[10px] text-slate-400">{meta.desc}</span>
          <span className="text-[10px] text-slate-400">({list.length})</span>
        </div>
        {list.map((c) => {
          const checked = selected.has(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggle(c.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition ${
                checked
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60'
              }`}
            >
              <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${
                checked ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'
              }`}>
                {checked && <Check className="w-3 h-3 text-white" />}
              </span>
              <span className="text-xs text-slate-700 dark:text-slate-200 flex-1 truncate">{c.name}</span>
              {c.existingNoteTitle && (
                <span className="text-[10px] text-slate-400 truncate max-w-[40%]">→ 归并到 {c.existingNoteTitle}</span>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  const renderPotential = () => {
    const list = groups.potential;
    if (list.length === 0) return null;
    const meta = CATEGORY_META.potential;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 pt-2">
          {meta.icon}
          <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{meta.label}</span>
          <span className="text-[10px] text-slate-400">{meta.desc}</span>
          <span className="text-[10px] text-slate-400">({list.length})</span>
        </div>
        {list.map((c) => {
          const checked = selected.has(c.id);
          const target = mergeTargets[c.id] || '';
          return (
            <div
              key={c.id}
              className={`rounded-lg border ${
                checked ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40' : 'border-slate-200 dark:border-slate-700'
              }`}
            >
              <button
                onClick={() => toggle(c.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
              >
                <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center ${
                  checked ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'
                }`}>
                  {checked && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="text-xs text-slate-700 dark:text-slate-200 flex-1 truncate">{c.name}</span>
              </button>
              <div className="px-3 pb-2 pl-9">
                <MergeField
                  knowledgeNotes={knowledgeNotes}
                  value={target}
                  onChange={(v) => setMergeTargets((prev) => ({ ...prev, [c.id]: v }))}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-md max-h-[85vh] flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">选择要分析的知识点</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="py-10 flex flex-col items-center gap-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              <span className="text-sm">正在识别知识点…</span>
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">未识别到知识点，可取消跳过分析</div>
          ) : (
            <>
              <button
                onClick={toggleAll}
                className="mb-1 flex items-center gap-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center ${
                  allSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'
                }`}>
                  {allSelected && <Check className="w-3 h-3 text-white" />}
                </span>
                {allSelected ? '取消全选' : '全选'}
              </button>
              {renderKnown()}
              {renderPotential()}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={selected.size === 0 || loading}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition disabled:opacity-40"
          >
            开始复盘分析（{selected.size}）
          </button>
        </div>
      </div>
    </div>
  );
};