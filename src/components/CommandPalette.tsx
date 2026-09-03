import React, { useState, useEffect } from "react";
import { NoteItem, ViewMode } from "../types";
import { Search, FileText, Plus, Network, Calendar, X } from "lucide-react";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  notes: NoteItem[];
  onSelectNote: (id: string) => void;
  onNewNote: () => void;
  onSelectView: (view: ViewMode) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  notes,
  onSelectNote,
  onNewNote,
  onSelectView
}) => {
  if (!isOpen) return null;

  const [query, setQuery] = useState("");

  const filtered = notes.filter((n) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      (n.aliases || []).some((a) => a.toLowerCase().includes(q))
    );
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-20 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl comic-popup w-full max-w-xl overflow-hidden flex flex-col">
        {/* Search Input */}
        <div className="p-3.5 border-b border-slate-200/80 dark:border-slate-800 flex items-center gap-2.5 playful-search-bar rounded-t-2xl">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            type="text"
            autoFocus
            placeholder="搜索笔记标题、内容或控制指令 (Esc 关闭)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-sm focus:outline-none text-slate-900 dark:text-slate-100 placeholder-slate-400"
          />
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 transition"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Commands */}
        <div className="p-2 border-b border-slate-100 dark:border-slate-800/60 bg-slate-50/50 dark:bg-slate-950/50 flex items-center gap-2 text-xs">
          <button
            onClick={() => {
              onNewNote();
              onClose();
            }}
            className="px-2.5 py-1 rounded-lg playful-filter-primary font-medium hover:opacity-80 transition flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            新建笔记
          </button>
          <button
            onClick={() => {
              onSelectView("graph");
              onClose();
            }}
            className="px-2.5 py-1 rounded-lg playful-filter-secondary font-medium hover:opacity-80 transition flex items-center gap-1"
          >
            <Network className="w-3.5 h-3.5" />
            跳转知识图谱
          </button>
          <button
            onClick={() => {
              onSelectView("timeline");
              onClose();
            }}
            className="px-2.5 py-1 rounded-lg playful-filter-accent font-medium hover:opacity-80 transition flex items-center gap-1"
          >
            <Calendar className="w-3.5 h-3.5" />
            跳转时序计划
          </button>
        </div>

        {/* Note Search Results */}
        <div className="max-h-72 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400">未找到匹配的笔记</div>
          ) : (
            filtered.map((note) => (
              <div
                key={note.id}
                onClick={() => {
                  onSelectNote(note.id);
                  onClose();
                }}
                className="p-2.5 rounded-xl hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2.5 overflow-hidden">
                  <FileText className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <div className="truncate">
                    <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {note.title}
                    </h4>
                    <p className="text-[10px] text-slate-500 truncate">
                      {note.content.replace(/#+\s/g, "").slice(0, 60)}
                    </p>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 font-medium">
                  打开
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
