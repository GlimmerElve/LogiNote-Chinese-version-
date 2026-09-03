import React, { useState, useRef, useEffect, useCallback } from "react";
import { NoteItem } from "../types";
import { X, BookOpen, ExternalLink, Tag, Clock, GripVertical } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface KnowledgePreviewProps {
  note: NoteItem;
  onClose: () => void;
  onEdit: () => void;
  darkMode: boolean;
}

export const KnowledgePreview: React.FC<KnowledgePreviewProps> = ({
  note,
  onClose,
  onEdit,
  darkMode
}) => {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // Reset position when note changes
  useEffect(() => {
    setPos({ x: 0, y: 0 });
  }, [note.id]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // don't drag on buttons
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPos({ x: dragStart.current.posX + dx, y: dragStart.current.posY + dy });
    };
    const onUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div
      ref={cardRef}
      className="fixed z-50 w-96 max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden rounded-2xl comic-popup bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 fade-in duration-200 border border-slate-200/60 dark:border-slate-700/60"
      style={{ top: `calc(4.5rem + ${pos.y}px)`, right: `calc(1rem - ${pos.x}px)` }}
    >
      {/* Header (draggable area) */}
      <div
        className="p-4 playful-preview-header flex items-start justify-between gap-2 flex-shrink-0 rounded-t-2xl cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
              {note.title || "未命名笔记"}
            </h3>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
              知识点 · 只读预览
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 transition flex-shrink-0"
          title="关闭预览"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tags */}
      {note.tags.length > 0 && (
        <div className="px-4 py-2.5 flex flex-wrap gap-1.5 border-b border-slate-100/60 dark:border-slate-800/40">
          {note.tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-medium text-[10px] border border-indigo-200/50 dark:border-indigo-800/50"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        <div className="p-4 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/40 dark:border-slate-700/40">
          <div className="prose prose-slate dark:prose-invert prose-sm max-w-none text-xs leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {note.content || "暂无内容"}
            </ReactMarkdown>
          </div>
        </div>
      </div>

      {/* Meta Info */}
      <div className="px-4 py-2 border-t border-slate-100/60 dark:border-slate-800/40 flex items-center justify-between text-[10px] text-slate-400 dark:text-slate-500 flex-shrink-0">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {new Date(note.updatedAt).toLocaleDateString("zh-CN", {
            year: "numeric",
            month: "short",
            day: "numeric"
          })}
        </span>
        <span>
          {note.links.length > 0 ? `${note.links.length} 个关联` : "无关联"}
        </span>
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-slate-200/60 dark:border-slate-800/60 flex gap-2 flex-shrink-0">
        <button
          onClick={onClose}
          className="flex-1 px-3 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition flex items-center justify-center gap-1.5"
        >
          <X className="w-3.5 h-3.5" />
          关闭
        </button>
        <button
          onClick={onEdit}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition flex items-center justify-center gap-1.5"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          打开编辑
        </button>
      </div>
    </div>
  );
};