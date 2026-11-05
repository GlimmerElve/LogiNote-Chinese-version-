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
import { ArgumentEvidenceSources } from './ArgumentEvidenceSources';
import { ArgumentQualityIssues } from './ArgumentQualityIssues';
import { PersonalCognitionPanel } from './PersonalCognitionPanel';
import { ArgumentEditorFrame } from './ArgumentEditorFrame';
import { ArgumentEditorWriteFeedback } from './ArgumentEditorWriteFeedback';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { useCanvasStore } from '../modules/argumentCanvas/store/canvasStore';
import type { ArgDoc, ArgumentSemanticIssue, ArgumentSourceRef } from '../services/argumentDoc/types';
import type { ArgumentRole, StructureReviewMode } from '../services/argumentDoc/types';
import { LEGACY_TYPE_FOR_ROLE } from '../services/argumentDoc/editorModel';
import { StructureReviewPanel } from './StructureReviewPanel';
import type { ArgumentEvidenceCandidate, ArgumentEvidencePreview } from '../services/argumentDoc/evidenceSources';
import { computeArgumentRevisionHash, getEffectiveArgumentQuality } from '../services/argumentDoc/quality';
import type { ArgumentFunctionType } from '../types';
import { layoutDoc } from '../services/argumentDoc/layout';
import type { FlowAnalysisReport } from '../services/flowAnalysis/types';
import { exportMarkdown } from '../modules/argumentCanvas/export/markdown';
import { exportJSON } from '../modules/argumentCanvas/export/json';
import { exportPDF } from '../modules/argumentCanvas/export/pdf';
import { exportPNG } from '../modules/argumentCanvas/export/png';
import { RefreshCw, Check, PanelRightClose, PanelRightOpen, Trash2, ShieldCheck } from 'lucide-react';

interface ArgumentEditViewProps {
  doc: ArgDoc;
  noteId?: string | null;
  report?: FlowAnalysisReport | null;
  onChange: (doc: ArgDoc) => void;
  onResubmit: (mode?: StructureReviewMode) => void;
  onQualityReview?: () => void;
  onSearchEvidence?: (nodeId: string) => Promise<ArgumentEvidenceCandidate[]>;
  onBindEvidence?: (nodeId: string, candidate: ArgumentEvidenceCandidate) => Promise<void>;
  onRemoveEvidence?: (nodeId: string, source: ArgumentSourceRef) => void;
  onPreviewEvidence?: (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => Promise<ArgumentEvidencePreview>;
  onOpenEvidence?: (source: ArgumentSourceRef | ArgumentEvidenceCandidate) => Promise<void>;
  onLocateQualityIssue?: (issue: ArgumentSemanticIssue) => void;
  onIgnoreQualityIssue?: (issue: ArgumentSemanticIssue, reason: string) => void;
  onRestoreQualityIssue?: (issue: ArgumentSemanticIssue) => void;
  onApplyQualitySuggestion?: (issue: ArgumentSemanticIssue, text: string) => void;
  onSubmit: () => void;
  onDelete?: () => void;
  submitting?: boolean;
  qualityReviewing?: boolean;
  writing?: 'save' | 'delete' | null;
  writeError?: string;
  writeFinished?: boolean;
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
  noteId,
  report,
  onChange,
  onResubmit,
  onQualityReview,
  onSearchEvidence,
  onBindEvidence,
  onRemoveEvidence,
  onPreviewEvidence,
  onOpenEvidence,
  onLocateQualityIssue,
  onIgnoreQualityIssue,
  onRestoreQualityIssue,
  onApplyQualitySuggestion,
  onSubmit,
  onDelete,
  submitting,
  qualityReviewing,
  writing,
  writeError,
  writeFinished,
  hideResultPanel,
}) => {
  // 画布容器 DOM 引用（导出 PDF/PNG 截图用）
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  // 结果面板展示开关（默认展示，可收起）
  const [showPanel, setShowPanel] = useState(true);
  const [panelKind, setPanelKind] = useState<'cognition' | 'quality'>('cognition');

  const currentDoc = useCanvasStore((s) => s.doc);
  const safeDoc: ArgDoc = currentDoc.doc_id === doc.doc_id ? currentDoc : doc;
  const title = safeDoc.title || '未命名论证';
  const nodeCount = safeDoc.nodes.length;
  const edgeCount = safeDoc.edges.length;
  const revisionHash = computeArgumentRevisionHash(safeDoc);
  const semanticAssessment = safeDoc.rag?.semanticAssessment;
  const semanticFresh = semanticAssessment?.revisionHash === revisionHash;
  const effective = semanticFresh && safeDoc.rag?.draftAssessment
    ? getEffectiveArgumentQuality(safeDoc.rag.draftAssessment, semanticAssessment)
    : null;

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
  const handleAddRole = useCallback((role: ArgumentRole) => {
    useCanvasStore.getState().addNode(LEGACY_TYPE_FOR_ROLE[role], { role, text: '',
      position: { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 }, status: 'edited', user_edited: true });
  }, []);

  const handleExportMarkdown = useCallback(() => {
    downloadText(`${title}.md`, exportMarkdown(safeDoc));
  }, [title, safeDoc]);

  const handleExportJSON = useCallback(() => {
    downloadText(`${title}.json`, exportJSON(safeDoc));
  }, [title, safeDoc]);

  const handleExportPDF = useCallback(async () => {
    if (!canvasWrapRef.current) throw new Error('画布尚未准备好，请稍后重试。');
    await exportPDF(canvasWrapRef.current, title);
  }, [title]);

  const handleExportPNG = useCallback(async () => {
    if (!canvasWrapRef.current) throw new Error('画布尚未准备好，请稍后重试。');
    await exportPNG(canvasWrapRef.current, title);
  }, [title]);

  return (
    <ArgumentEditorFrame rootRef={workspaceRef} title={title} nodeCount={nodeCount} edgeCount={edgeCount}
      busy={Boolean(submitting || qualityReviewing || writing || writeFinished)}
      feedback={<ArgumentEditorWriteFeedback writing={writing} error={writeError} />}
      toolbar={<Toolbar
            onAddNode={handleAddNode}
            onAddRole={handleAddRole}
            onAutoLayout={handleAutoLayout}
            onExportMarkdown={handleExportMarkdown}
            onExportJSON={handleExportJSON}
            onExportPDF={handleExportPDF}
            onExportPNG={handleExportPNG}
          />}
      panelToggle={<button type="button"
          onClick={() => { if (!showPanel || allowCognitionLeave(workspaceRef.current)) setShowPanel((v) => !v); }}
          className="argument-editor-panel-toggle"
          title={showPanel ? '收起侧边面板' : '展开侧边面板'}
          aria-expanded={showPanel}
          aria-controls="argument-editor-sidebar"
        >
          {showPanel ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          {showPanel ? '收起面板' : (hideResultPanel ? '展开认知与质量' : '展开结果')}
        </button>}
      canvas={<div ref={canvasWrapRef} className="argument-editor-canvas">
          <ReactFlowProvider>
            <ArgumentCanvas doc={doc} onChange={onChange} readOnly={Boolean(submitting || qualityReviewing || writing || writeFinished)} />
          </ReactFlowProvider>
        </div>}
      sidebar={<>
        {showPanel && !hideResultPanel && (
          <aside id="argument-editor-sidebar" aria-label="分析结果" className="argument-editor-report">
            <StructureReviewPanel doc={safeDoc} />
            <button
              onClick={() => setShowPanel(false)}
              className="argument-editor-report-close"
              title="关闭结果面板"
              aria-label="关闭结果面板"
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
          </aside>
        )}

        {showPanel && hideResultPanel && (
          <aside id="argument-editor-sidebar" aria-label="认知与发布质量" className="argument-editor-report argument-editor-quality">
            <StructureReviewPanel doc={safeDoc} />
            <div className="argument-editor-panel-switch" role="group" aria-label="论证侧栏内容">
              <button type="button" aria-pressed={panelKind === 'cognition'} onClick={() => setPanelKind('cognition')}>我的理解</button>
              <button type="button" aria-pressed={panelKind === 'quality'} onClick={() => { if (allowCognitionLeave(workspaceRef.current)) setPanelKind('quality'); }}>发布质量复核</button>
            </div>
            {panelKind === 'cognition' ? <PersonalCognitionPanel key={safeDoc.doc_id} doc={safeDoc} noteId={noteId} /> : <>
            <div className="argument-editor-quality-heading">
              <h2>RAG 质量复核</h2>
              <p>供已发布论证检索使用；不限制你保存个人理解</p>
            </div>

            {!semanticAssessment ? (
              <div className="argument-editor-quality-notice is-warning" role="status">
                尚未进行语义质量复核。可以保存草稿，但不能发布到论证层 RAG。
              </div>
            ) : !semanticFresh ? (
              <div className="argument-editor-quality-notice is-stale" role="status">
                结构图在上次复核后已修改，报告整体已过期。仍可继续处理目标未变化的建议；发布前必须重新复核。
              </div>
            ) : (
              <>
                <div className="argument-editor-quality-metrics">
                  <div>
                    <span>有效质量分</span>
                    <strong>{effective?.score ?? semanticAssessment.score}</strong>
                  </div>
                  <div>
                    <span>证据等级</span>
                    <strong>{safeDoc.rag?.evidenceAssessment?.grade || 'C'}</strong>
                  </div>
                </div>
              </>
            )}

            {onLocateQualityIssue && onIgnoreQualityIssue && onRestoreQualityIssue && onApplyQualitySuggestion && (
              <ArgumentQualityIssues
                doc={safeDoc}
                semanticFresh={Boolean(semanticFresh)}
                effective={effective}
                onLocate={onLocateQualityIssue}
                onIgnore={onIgnoreQualityIssue}
                onRestore={onRestoreQualityIssue}
                onApplySuggestion={onApplyQualitySuggestion}
              />
            )}

            {onQualityReview && (
              <button
                onClick={onQualityReview}
                disabled={qualityReviewing || submitting}
                className="argument-editor-quality-run"
              >
                {qualityReviewing ? '正在复核…' : semanticAssessment ? '重新运行质量复核' : '运行质量复核'}
              </button>
            )}

            {onSearchEvidence && onBindEvidence && onRemoveEvidence && onPreviewEvidence && onOpenEvidence && (
              <ArgumentEvidenceSources
                doc={safeDoc}
                onSearch={onSearchEvidence}
                onBind={onBindEvidence}
                onRemove={onRemoveEvidence}
                onPreview={onPreviewEvidence}
                onOpenOriginal={onOpenEvidence}
              />
            )}
            </>}
          </aside>
        )}
      </>}
      actions={<>
        {onDelete && (
          <button
            onClick={() => { if (allowCognitionLeave(workspaceRef.current)) onDelete(); }}
            disabled={submitting || qualityReviewing || Boolean(writing || writeFinished)}
            className="is-danger"
          >
            <Trash2 className="w-3.5 h-3.5" />
            删除此图
          </button>
        )}
        <button
          onClick={() => onResubmit('changes')}
          disabled={submitting || qualityReviewing || Boolean(writing || writeFinished)}
          className="is-secondary"
        >
          <RefreshCw className={submitting ? 'is-spinning' : ''} />
          {submitting ? '正在重评结构…' : '再次提交结构评价'}
        </button>
        <button onClick={() => onResubmit('full')}
          disabled={submitting || qualityReviewing || Boolean(writing || writeFinished)} className="is-secondary">检查整张图</button>
        {onQualityReview && (
          <button
            onClick={() => { if (!allowCognitionLeave(workspaceRef.current)) return; setShowPanel(true); setPanelKind('quality'); onQualityReview(); }}
            disabled={submitting || qualityReviewing || Boolean(writing || writeFinished)}
            className="is-secondary"
          >
            <ShieldCheck className={qualityReviewing ? 'is-spinning' : ''} />
            {qualityReviewing ? '正在复核…' : 'RAG 质量复核'}
          </button>
        )}
        <button
          onClick={() => { if (allowCognitionLeave(workspaceRef.current)) onSubmit(); }}
          disabled={submitting || qualityReviewing || Boolean(writing || writeFinished)}
          className="is-primary"
        >
          <Check className="w-3.5 h-3.5" />
          {writing === 'save' ? '正在保存…' : '保存并退出'}
        </button>
      </>}
    />
  );
};
