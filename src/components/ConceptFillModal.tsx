import React, { useState } from 'react';
import { Globe2, FolderSearch, Loader2, Sparkles, X } from 'lucide-react';
import type { NoteItem, ConceptDraft, ConceptSource } from '../types';
import { generateConcept } from '../services/conceptFillService';

interface ConceptFillModalProps {
  note: NoteItem;
  onClose: () => void;
  onConfirm: (content: string) => void;
}

export const ConceptFillModal: React.FC<ConceptFillModalProps> = ({ note, onClose, onConfirm }) => {
  const [source, setSource] = useState<ConceptSource>('web');
  const [draft, setDraft] = useState<ConceptDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setDraft(null);
    try {
      const result = await generateConcept(note, source);
      setDraft(result);
    } catch (e: any) {
      setError(e?.message || '补全失败');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    if (draft?.content) onConfirm(draft.content);
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">补全概念「{note.title}」</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 来源切换 + 生成按钮 */}
        <div className="px-5 py-3 flex items-center gap-2 border-b border-slate-200 dark:border-slate-800">
          <button
            onClick={() => { setSource('web'); setDraft(null); setError(null); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              source === 'web'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <Globe2 className="w-3.5 h-3.5" /> 联网查询
          </button>
          <button
            onClick={() => { setSource('rag'); setDraft(null); setError(null); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
              source === 'rag'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
            }`}
          >
            <FolderSearch className="w-3.5 h-3.5" /> 本地资料
          </button>
          <div className="flex-1" />
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {loading ? '生成中…' : '生成'}
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-[200px]">
          {error && (
            <div className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {!error && !draft && (
            <div className="py-10 text-center text-slate-400 text-sm">
              选择来源后点击「生成」，获取概念草稿
            </div>
          )}
          {draft && (
            <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
              {draft.content}
            </pre>
          )}
        </div>

        {/* 底部操作 */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!draft?.content}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition disabled:opacity-40"
          >
            确认写入笔记
          </button>
        </div>
      </div>
    </div>
  );
};