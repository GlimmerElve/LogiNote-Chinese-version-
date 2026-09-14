/**
 * 顶部工具栏（高对比按钮样式，不依赖画布 CSS 变量）
 *
 * 提供：新建节点（9 类下拉）、一键整理（三层布局）、导出（Markdown / JSON / PDF / PNG）。
 */

import { useState } from 'react';
import { Plus, LayoutGrid, Download } from 'lucide-react';
import type { ArgumentFunctionType } from '../../../types';
import { ALL_ARGUMENT_TYPES } from '../../../services/argumentDoc/types';

interface ToolbarProps {
  onAddNode: (type: ArgumentFunctionType) => void;
  onAutoLayout: () => void;
  onExportMarkdown: () => void;
  onExportJSON: () => void;
  onExportPDF: () => void;
  onExportPNG: () => void;
}

export function Toolbar({
  onAddNode,
  onAutoLayout,
  onExportMarkdown,
  onExportJSON,
  onExportPDF,
  onExportPNG,
}: ToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 relative flex-wrap">
      <span className="font-bold text-base text-slate-800 dark:text-slate-100" style={{ fontFamily: 'var(--font-display)' }}>
        论证结构编辑器
      </span>

      {/* 新建节点下拉 */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-orange-500 text-white text-[13px] font-semibold shadow-sm hover:bg-orange-600 active:bg-orange-700 transition border border-orange-600"
        >
          <Plus className="w-4 h-4" />
          新建节点
        </button>
        {menuOpen && (
          <div className="absolute top-full left-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-lg z-[100] min-w-[160px] max-h-[320px] overflow-y-auto py-1">
            {ALL_ARGUMENT_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => {
                  onAddNode(t);
                  setMenuOpen(false);
                }}
                className="block w-full text-left px-3.5 py-2 text-[13px] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 一键整理 */}
      <button
        onClick={onAutoLayout}
        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-[13px] font-medium border border-slate-300 dark:border-slate-600 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition"
      >
        <LayoutGrid className="w-4 h-4" />
        一键整理
      </button>

      {/* 导出下拉 */}
      <div className="relative ml-auto">
        <button
          onClick={() => setExportOpen((v) => !v)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-[13px] font-medium border border-slate-300 dark:border-slate-600 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition"
        >
          <Download className="w-4 h-4" />
          导出
        </button>
        {exportOpen && (
          <div className="absolute top-full right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-lg z-[100] min-w-[150px] py-1">
            {[
              { label: '导出 Markdown', fn: onExportMarkdown },
              { label: '导出 JSON', fn: onExportJSON },
              { label: '导出 PDF', fn: onExportPDF },
              { label: '导出 PNG', fn: onExportPNG },
            ].map((item) => (
              <button
                key={item.label}
                onClick={() => {
                  item.fn();
                  setExportOpen(false);
                }}
                className="block w-full text-left px-3.5 py-2 text-[13px] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}