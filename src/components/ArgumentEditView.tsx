/**
 * 全屏论证编辑视图（完整迁移编辑器全部功能）
 *
 * 布局：顶部 Toolbar（新建节点/一键整理/导出）+ 左画布 + 右结果面板（可折叠）+ 底部状态栏
 * - 结果面板默认展示，可一键收起/展开，收起后画布占满全宽
 * - 根节点挂 argument-canvas-scope，让画布设计 token 对 Toolbar 生效
 * 悬浮：删除此图 / 再次提交分析 / 保存退出
 */

import React, { useRef, useCallback, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ArgumentCanvas } from '../modules/argumentCanvas/ArgumentCanvas';
import { Toolbar } from '../modules/argumentCanvas/components/Toolbar';
import { FlowAnalysisPanel } from './FlowAnalysisPanel';
import { useCanvasStore } from '../modules/argumentCanvas/store/canvasStore';
import type { ArgDoc } from '../services/argumentDoc/types';
import type { ArgumentFunctionType } from '../types';
import { layoutDoc } from '../services/argumentDoc/layout';
import type { FlowAnalysisReport } from '../services/flowAnalysis/types';
import { exportMarkdown } from '../modules/argumentCanvas/export/markdown';
import { exportJSON } from '../modules/argumentCanvas/export/json';
import { exportPDF } from '../modules/argumentCanvas/export/pdf';
import { exportPNG } from '../modules/argumentCanvas/export/png';
import { RefreshCw, Check, PanelRightClose, PanelRightOpen, Trash2 } from 'lucide-react';

interface ArgumentEditViewProps {
  doc: ArgDoc;
  report?: FlowAnalysisReport | null;
  onChange: (doc: ArgDoc) => void;
  onResubmit: () => void;
  onSubmit: () => void;
  onDelete?: () => void;
  submitting?: boolean;
  /** 独立窗口模式：不渲染右结果报告面板与切换按钮 */
  hideResultPanel?: boolean;
}

/** 浏览器下载文本文件 */
function downloadText(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.download = fileName;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}

export const ArgumentEditView: React.FC<ArgumentEditViewProps> = ({
  doc,
  report,
  onChange,
  onResubmit,
  onSubmit,
  onDelete,
  submitting,
  hideResultPanel,
}) => {
  // 画布容器 DOM 引用（导出 PDF/PNG 截图用）
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // 结果面板展示开关（默认展示，可收起）
  const [showPanel, setShowPanel] = useState(true);

  const title = doc.title || '未命名论证';
  const nodeCount = doc.nodes.length;
  const edgeCount = doc.edges.length;

  const currentDoc = useCanvasStore((s) => s.doc);
  const safeDoc: ArgDoc = currentDoc.doc_id === 'empty' ? doc : currentDoc;

  const handleAddNode = useCallback((type: ArgumentFunctionType) => {
    useCanvasStore.getState().addNode(type, {
      text: '',
      position: { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 },
      status: 'isolated',
    });
  }, []);

  const handleAutoLayout = useCallback(() => {
    const state = useCanvasStore.getState();
    const positions = layoutDoc(state.doc.nodes, state.doc.edges);
    state.applyLayout(positions);
  }, []);

  const handleExportMarkdown = useCallback(() => {
    downloadText(`${title}.md`, exportMarkdown(safeDoc));
  }, [title, safeDoc]);

  const handleExportJSON = useCallback(() => {
    downloadText(`${title}.json`, exportJSON(safeDoc));
  }, [title, safeDoc]);

  const handleExportPDF = useCallback(async () => {
    if (canvasWrapRef.current) await exportPDF(canvasWrapRef.current, title);
  }, [title]);

  const handleExportPNG = useCallback(async () => {
    if (canvasWrapRef.current) await exportPNG(canvasWrapRef.current, title);
  }, [title]);

  return (
    <div className="argument-canvas-scope h-full w-full flex flex-col bg-[#FEF9F3] dark:bg-slate-950 overflow-hidden">
      {/* 顶部工具栏（含结果面板切换） */}
      <div className="flex items-stretch border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="flex-1 min-w-0">
          <Toolbar
            onAddNode={handleAddNode}
            onAutoLayout={handleAutoLayout}
            onExportMarkdown={handleExportMarkdown}
            onExportJSON={handleExportJSON}
            onExportPDF={handleExportPDF}
            onExportPNG={handleExportPNG}
          />
        </div>
        {/* 结果面板收起/展开切换按钮（独立窗口模式隐藏） */}
        {!hideResultPanel && (
        <button
          onClick={() => setShowPanel((v) => !v)}
          className="shrink-0 px-3 my-2 mr-2 flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition text-xs font-medium"
          title={showPanel ? '收起结果面板' : '展开结果面板'}
        >
          {showPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          {showPanel ? '收起结果' : '展开结果'}
        </button>
        )}
      </div>

      {/* 主体：左画布 + 右结果面板（可折叠） */}
      <div className="flex-1 flex min-h-0 relative">
        <div ref={canvasWrapRef} className="flex-1 min-w-0 h-full relative">
          <ReactFlowProvider>
            <ArgumentCanvas doc={doc} onChange={onChange} />
          </ReactFlowProvider>
        </div>

        {/* 右结果面板：完整复用 FlowAnalysisPanel，可收起（独立窗口模式不渲染） */}
        {showPanel && !hideResultPanel && (
          <div className="w-[360px] shrink-0 h-full overflow-y-auto border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 relative">
            <button
              onClick={() => setShowPanel(false)}
              className="absolute top-2 right-2 z-20 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              title="关闭结果面板"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
            <FlowAnalysisPanel
              autoRun={false}
              initialReport={report}
              speakingContent=""
              noteTitle={title}
              allNotes={[]}
            />
          </div>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center gap-4 px-4 py-1.5 text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <span>节点数：{nodeCount}</span>
        <span>连线数：{edgeCount}</span>
        <span className="ml-auto text-slate-400">Tab 支撑 · Shift+Tab 反对 · Ctrl+Enter 孤立 · Delete 删除 · Ctrl+Z 撤销 · Ctrl+C/V 复制粘贴</span>
      </div>

      {/* 悬浮操作按钮 */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-2 z-10">
        {onDelete && (
          <button
            onClick={onDelete}
            disabled={submitting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white dark:bg-slate-800 border border-red-300 dark:border-red-700 text-xs font-semibold text-red-600 dark:text-red-400 shadow-lg hover:bg-red-50 dark:hover:bg-red-950/40 transition disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除此图
          </button>
        )}
        <button
          onClick={onResubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 shadow-lg hover:border-indigo-400 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${submitting ? 'animate-spin' : ''}`} />
          再次提交分析
        </button>
        <button
          onClick={onSubmit}
          disabled={submitting}
          className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold shadow-lg hover:bg-indigo-700 transition disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
          保存并退出
        </button>
      </div>
    </div>
  );
};