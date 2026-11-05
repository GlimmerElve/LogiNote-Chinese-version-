import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  FileText,
  GitBranch,
  Lightbulb,
  Maximize2,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';
import { ArgumentCanvas } from '../modules/argumentCanvas/ArgumentCanvas';
import { Toolbar } from '../modules/argumentCanvas/components/Toolbar';
import { useCanvasStore } from '../modules/argumentCanvas/store/canvasStore';
import { exportMarkdown } from '../modules/argumentCanvas/export/markdown';
import { exportJSON } from '../modules/argumentCanvas/export/json';
import { exportPDF } from '../modules/argumentCanvas/export/pdf';
import { exportPNG } from '../modules/argumentCanvas/export/png';
import { layoutDoc } from '../services/argumentDoc/layout';
import type { ArgDoc } from '../services/argumentDoc/types';
import type { ArgumentRole, StructureReviewMode } from '../services/argumentDoc/types';
import { LEGACY_TYPE_FOR_ROLE } from '../services/argumentDoc/editorModel';
import { StructureReviewPanel } from './StructureReviewPanel';
import type { ArgumentFunctionType, KnowledgePointMasteryResult, Vulnerability } from '../types';
import type { FlowAnalysisReport, FlowAnalysisSection } from '../services/flowAnalysis/types';
import type { ArgumentQualitySectionItem } from '../services/flowAnalysis/types';
import type { FlowResultOperation } from '../services/ui/flowResultWrite';
import { prepareArgumentPublication, type ArgumentPublicationChoice } from '../services/ui/argumentPublication';
import { ArgumentPublicationDialog, type ArgumentPublicationRequest } from './ArgumentPublicationDialog';
import { PersonalCognitionPanel } from './PersonalCognitionPanel';
import { FlowResultStyleCards } from './FlowResultStyleCards';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { useDialog } from './useDialog';
import { KnowledgeMasteryDetails, KnowledgeMasteryStateGuide } from './KnowledgeMasteryDetails';

export interface FlowResultData {
  doc: ArgDoc;
  report: FlowAnalysisReport;
  noteId: string | null;
  noteTitle: string;
  speakingContent: string;
  createdAt: string;
  entryMode: 'new' | 'edit';
  reviewSessionId?: string;
  isMock?: boolean;
}

interface FlowResultViewProps {
  data: FlowResultData;
  onChange: (doc: ArgDoc) => void;
  onBack: () => void;
  onSave: (publication: ArgumentPublicationChoice) => void;
  onResubmit: (mode?: StructureReviewMode) => void;
  submitting?: boolean;
  operation?: FlowResultOperation | null;
  notice?: string;
  completionContent?: React.ReactNode;
  recoveryContent?: React.ReactNode;
  settingsRecoveryContent?: React.ReactNode;
  renderQuickCheckEntry?: (knowledgeTitle: string) => React.ReactNode;
}

function downloadText(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download = fileName;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getSection<T>(report: FlowAnalysisReport, kind: FlowAnalysisSection['kind']): T[] {
  return (report.sections.find((section) => section.kind === kind)?.items || []) as T[];
}

function scoreTone(score: number): 'good' | 'medium' | 'weak' {
  if (score >= 78) return 'good';
  if (score >= 62) return 'medium';
  return 'weak';
}

function formatResultTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const FlowResultView: React.FC<FlowResultViewProps> = ({
  data,
  onChange,
  onBack,
  onSave,
  onResubmit,
  submitting = false,
  operation = null,
  notice = '',
  completionContent,
  recoveryContent,
  settingsRecoveryContent,
  renderQuickCheckEntry,
}) => {
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const reportRef = useRef<HTMLElement>(null);
  const styleSectionRef = useRef<HTMLDivElement>(null);
  const masterySectionRef = useRef<HTMLElement>(null);
  const cognitionDialogRef = useRef<HTMLDivElement>(null);
  const [cognitionOpen, setCognitionOpen] = useState(false);
  const [focusCanvas, setFocusCanvas] = useState(false);
  const [confirmBack, setConfirmBack] = useState(false);
  const [publicationRequest, setPublicationRequest] = useState<ArgumentPublicationRequest | null>(null);
  const backDialogRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const reassessButtonRef = useRef<HTMLButtonElement>(null);
  const previousOperation = useRef(operation);
  const busy = submitting || operation !== null;
  useDialog(confirmBack, backDialogRef, () => setConfirmBack(false));
  useDialog(cognitionOpen, cognitionDialogRef, () => {
    if (allowCognitionLeave(cognitionDialogRef.current)) setCognitionOpen(false);
  });
  const currentDoc = useCanvasStore((state) => state.doc);
  const safeDoc = currentDoc.doc_id === data.doc.doc_id ? currentDoc : data.doc;

  const quality = useMemo(
    () => getSection<ArgumentQualitySectionItem>(data.report, 'argumentQuality')[0],
    [data.report],
  );
  const vulnerabilities = quality?.vulnerabilities || [];
  const scores = quality?.layeredScores?.final;
  const mastery = getSection<KnowledgePointMasteryResult>(data.report, 'mastery');
  const related = getSection<{ term: string; relation: string; suggestedWikiLink?: string }>(data.report, 'relatedKnowledge');
  const cognitive = getSection<string>(data.report, 'cognitiveInterpretation');
  const expression = getSection<string>(data.report, 'expressionStyle');

  const suggestions = useMemo(() => {
    const items = [
      data.report.recommendation,
      ...vulnerabilities.map((item) => item.suggestion),
    ].filter((item): item is string => Boolean(item?.trim()));
    return Array.from(new Set(items)).slice(0, 3);
  }, [data.report.recommendation, vulnerabilities]);

  const handleAddNode = useCallback((type: ArgumentFunctionType) => {
    if (busy) return;
    useCanvasStore.getState().addNode(type, {
      text: '',
      position: { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 },
      status: 'isolated',
    });
  }, [busy]);

  const handleAutoLayout = useCallback(() => {
    if (busy) return;
    const state = useCanvasStore.getState();
    state.applyLayout(layoutDoc(state.doc.nodes, state.doc.edges));
  }, [busy]);
  const handleAddRole = useCallback((role: ArgumentRole) => {
    if (busy) return;
    useCanvasStore.getState().addNode(LEGACY_TYPE_FOR_ROLE[role], {
      role, text: '', position: { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 }, status: 'edited', user_edited: true,
    });
  }, [busy]);

  const title = data.doc.title || data.noteTitle || '复盘论证结构';

  useEffect(() => {
    reportRef.current?.scrollTo({ top: 0 });
  }, [data.createdAt]);
  useEffect(() => {
    const previous = previousOperation.current;
    previousOperation.current = operation;
    if (!previous || busy || confirmBack || document.activeElement !== document.body) return;
    (previous === 'save' ? saveButtonRef : reassessButtonRef).current?.focus({ preventScroll: true });
  }, [operation, busy, confirmBack]);

  return (
    <div className="flow-result-workspace argument-canvas-scope">
      <header className="flow-result-topbar" inert={confirmBack || publicationRequest || cognitionOpen ? true : undefined}>
        <div className="flow-result-brand">LogiNote</div>
        <div className="flow-result-breadcrumb">
          <span>学习</span><ChevronRight aria-hidden="true" /><strong>{focusCanvas ? '论证编辑器' : '复盘结果'}</strong>
        </div>
        <div className="flow-result-top-actions">
          {data.isMock && <span className="flow-result-mock-badge">模拟数据</span>}
          <button disabled={busy} onClick={() => setConfirmBack(true)}><ArrowLeft aria-hidden="true" />返回笔记</button>
          <button disabled={busy} onClick={() => setFocusCanvas((value) => !value)}>
            <GitBranch aria-hidden="true" />{focusCanvas ? '完成编辑，返回结果' : '打开论证编辑器'}
          </button>
          <button ref={saveButtonRef} className="is-primary" disabled={busy} onClick={() => {
            if (!busy) setPublicationRequest({ title, preview: prepareArgumentPublication(safeDoc) });
          }}>
            {operation === 'save' ? <RefreshCw className="is-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}
            {operation === 'save' ? '正在保存结果…' : '保存结果'}
          </button>
        </div>
      </header>

      {recoveryContent}
      {settingsRecoveryContent}
      {(busy || notice) && <div className="flow-result-write-status" role="status" aria-live="polite">
        {busy ? <RefreshCw className="is-spinning" aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <span>{busy ? operation === 'save' ? '正在保存结果，请稍候。' : '正在重新评价结构，请稍候。' : notice}</span>
      </div>}

      {!focusCanvas && <section className="flow-result-heading" inert={cognitionOpen || undefined}>
        <div>
          <span>复盘完成 · {formatResultTime(data.createdAt)}</span>
          <h1>复盘结果 · {data.noteTitle}</h1>
          <p>基于本次口语复述生成论证结构，并识别关键结论、证据与待完善点。</p>
        </div>
        <div className="flow-result-clarity">
          <span>表达清晰度</span>
          <strong>{data.report.clarityScore ?? '—'}</strong>
          <small>{data.report.clarityComment || '本次未返回清晰度评价'}</small>
        </div>
      </section>}

      <main inert={confirmBack || publicationRequest || cognitionOpen ? true : undefined} className={`flow-result-main ${focusCanvas ? 'is-canvas-focused is-editor-workspace' : ''} ${completionContent && !focusCanvas ? 'has-learning-completion' : ''}`}>
        <section className="flow-result-canvas-panel" aria-busy={busy}>
          {focusCanvas ? <div className="flow-result-canvas-toolbar" inert={busy || undefined}>
            <Toolbar
              onAddNode={handleAddNode}
              onAddRole={handleAddRole}
              onAutoLayout={handleAutoLayout}
              onExportMarkdown={() => downloadText(`${title}.md`, exportMarkdown(safeDoc))}
              onExportJSON={() => downloadText(`${title}.json`, exportJSON(safeDoc))}
              onExportPDF={async () => { if (canvasWrapRef.current) await exportPDF(canvasWrapRef.current, title); }}
              onExportPNG={async () => { if (canvasWrapRef.current) await exportPNG(canvasWrapRef.current, title); }}
            />
          </div> : <div className="flow-result-preview-hint">论证图预览 · 点击右上角“打开论证编辑器”增删块、修改角色和关系。</div>}
          <div ref={canvasWrapRef} className="flow-result-canvas" inert={busy || undefined}>
            <ReactFlowProvider>
              <ArgumentCanvas doc={data.doc} onChange={onChange} readOnly={!focusCanvas || busy} />
            </ReactFlowProvider>
          </div>
          <footer className="flow-result-canvas-footer">
            <div>
              <span>{safeDoc.nodes.length} 个节点</span>
              <span>{safeDoc.edges.length} 条关系</span>
              <span>{focusCanvas ? '双击编辑 · 拖线后确认关系 · 点击边可改类型/方向 · Ctrl/Cmd+Z 撤销' : '缩放查看结构；问题标记可点击查看'}</span>
            </div>
            <button ref={reassessButtonRef} onClick={() => onResubmit('changes')} disabled={busy} title="只检查修改、受影响主张及未解决问题；无目标不发送请求">
              <RefreshCw className={operation === 'reassess' ? 'is-spinning' : ''} aria-hidden="true" />
              {operation === 'reassess' ? '正在重评结构…' : '再次提交结构评价'}
            </button>
            <button onClick={() => onResubmit('full')} disabled={busy} title="主动检查全部节点和关系，不更改原始评分">检查整张图</button>
          </footer>
          <div className="flow-result-score-lock">
            <CheckCircle2 aria-hidden="true" />
            <span>默认按修改及影响范围重评，不自动补链；原始口语评分和画像不变。</span>
          </div>
        </section>
        {focusCanvas && <aside className="flow-result-editor-inspector" aria-label="编辑器结构诊断">
          <h2>论证编辑</h2><p>这里只编辑当前草稿。返回结果页不会重新抽取；保存结果后才写入笔记。</p>
          <StructureReviewPanel doc={safeDoc} />
        </aside>}

        {!focusCanvas && (
          <aside ref={reportRef} className="flow-result-report" aria-label="本次复盘分析结果">
            <nav className="flow-result-report-nav" aria-label="复盘结果分区">
              <button type="button" onClick={() => reportRef.current?.scrollTo({ top: 0, behavior: 'auto' })}>复盘评价</button>
              <button type="button" onClick={() => styleSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })}>表达与认知</button>
              <button type="button" onClick={() => masterySectionRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' })}>知识点掌握度</button>
            </nav>
            <section className="flow-result-report-card flow-result-score-card">
              <div className="flow-result-card-heading">
                <div><Sparkles aria-hidden="true" /><strong>本次复盘</strong></div>
                <time>{formatResultTime(data.createdAt)}</time>
              </div>
              <p>{data.report.summary || quality?.summary || '本次分析已完成。'}</p>
              <div className="flow-result-layer-scores">
                {([
                  ['概念', data.report.unscoredLayers?.includes('concept') ? undefined : scores?.concept, data.report.conceptSummary],
                  ['判断', data.report.unscoredLayers?.includes('judgment') ? undefined : scores?.judgment, data.report.judgmentSummary],
                  ['推理', data.report.unscoredLayers?.includes('reasoning') ? undefined : scores?.logic, data.report.reasoningSummary],
                ] as const).map(([label, score, summary]) => {
                  const numeric = typeof score === 'number' ? score : 0;
                  return (
                    <div key={label}>
                      <div
                        className={`flow-result-score-ring is-${scoreTone(numeric)}`}
                        style={{ '--result-score': `${Math.max(0, Math.min(100, numeric)) * 3.6}deg` } as React.CSSProperties}
                      >
                        <span>{typeof score === 'number' ? Math.round(score) : '—'}</span>
                      </div>
                      <strong>{label}</strong>
                      <small>{typeof score !== 'number' ? `暂不可评${summary ? `：${summary}` : ''}` : summary || '暂无分层评价'}</small>
                    </div>
                  );
                })}
              </div>
              {data.report.overallComment && <div className="flow-result-overall-comment">{data.report.overallComment}</div>}
            </section>

            <StructureReviewPanel doc={safeDoc} />
            <section className="flow-result-report-card">
              <div className="flow-result-card-heading">
                <div className="is-warning"><AlertTriangle aria-hidden="true" /><strong>原始复盘遗漏点</strong></div>
                <span>{vulnerabilities.length}</span>
              </div>
              <p>以下内容在本次复述中尚未充分涉及，建议继续探索。</p>
              <div className="flow-result-item-list">
                {vulnerabilities.length === 0 ? (
                  <div className="flow-result-empty-item"><CheckCircle2 aria-hidden="true" />未识别到明显结构漏洞</div>
                ) : vulnerabilities.map((item: Vulnerability, index) => (
                  <article key={`${item.nodeId || 'item'}-${index}`}>
                    <span>{index + 1}</span>
                    <div><strong>{item.type}</strong><p>{item.evidence}</p><small>{item.suggestion}</small></div>
                    <ChevronRight aria-hidden="true" />
                  </article>
                ))}
              </div>
            </section>

            <section className="flow-result-report-card">
              <div className="flow-result-card-heading">
                <div className="is-advice"><Lightbulb aria-hidden="true" /><strong>下一步建议</strong></div>
                <span>{suggestions.length}</span>
              </div>
              <p>基于本次复盘结果，为你推荐以下学习方向。</p>
              <div className="flow-result-item-list is-compact">
                {suggestions.map((item, index) => (
                  <article key={`${item}-${index}`}><span>{index + 1}</span><div><p>{item}</p></div><ChevronRight aria-hidden="true" /></article>
                ))}
              </div>
            </section>

            <div ref={styleSectionRef} className="flow-result-style-section">
              <FlowResultStyleCards presentation={data.report.stylePresentation} cognitive={cognitive} expression={expression} />
            </div>

            <section ref={masterySectionRef} className="flow-result-report-card flow-result-mastery" aria-label="知识点掌握度分析结果">
              <div className="flow-result-card-heading"><div><BookOpen aria-hidden="true" /><strong>知识点掌握度分析结果</strong></div><span>{mastery.length} 个知识点</span></div>
              <p>{mastery.some(item => item.shadow)
                ? '按参考资料核对本次实际展示的理解。未展开的层次不降低已有掌握状态。'
                : '独立知识点评估 · 展示本次三层净得分，正负表示本次表现，不是累计掌握度百分比。'}</p>
              {mastery.some(item => item.shadow) && <KnowledgeMasteryStateGuide />}
              {mastery.length === 0 ? <p>本次尚无知识点掌握度分析结果。</p> : mastery.map((item, index) => <article key={`${item.name}-${index}`}>
                <header><strong>{item.name}</strong><span>{item.level === 'reasoning' ? '触及推理层' : item.level === 'judgment' ? '触及判断层' : item.level === 'concept' ? '触及概念层' : '本次未触及'}</span></header>
                {item.shadow ? <KnowledgeMasteryDetails result={item.shadow} /> : <div className="flow-result-mastery-values">
                  {([
                    ['概念', item.conceptFinal, item.conceptDelta],
                    ['判断', item.judgmentFinal, item.judgmentDelta],
                    ['推理', item.reasoningFinal, item.reasoningDelta],
                  ] as const).map(([label, final, delta]) => <div key={label}>
                    <span>{label} · 联动净分</span><strong>{typeof final === 'number' ? `${final > 0 ? '+' : ''}${Math.round(final * 10) / 10}` : '—'}</strong>
                    <small>原始净分 {delta > 0 ? '+' : ''}{delta}</small>
                  </div>)}
                </div>}
                {item.comment && <p>{item.comment}</p>}
                {item.existingNoteTitle && <p>关联知识点：{item.existingNoteTitle}</p>}
                {item.shadow && !data.isMock && renderQuickCheckEntry?.(item.existingNoteTitle || item.name)}
              </article>)}
            </section>

            {related.length > 0 && (
              <details className="flow-result-more-card">
                <summary><BookOpen aria-hidden="true" />关联知识</summary>
                {related.length > 0 && <div><strong>关联知识</strong>{related.map((item) => <span key={item.term}>{item.term}</span>)}</div>}
              </details>
            )}

            <section className="flow-result-report-card">
              <div className="flow-result-card-heading"><div><GitBranch aria-hidden="true" /><strong>写入个人认知 RAG</strong></div></div>
              <p>模型生成的图只是草稿。核对并明确确认后，才会作为“我的理解”保存；保存复盘块不会自动写入。</p>
              <button type="button" className="flow-result-cognition-action" disabled={busy} onClick={() => setCognitionOpen(true)}>整理并确认我的理解</button>
            </section>

            <section className="flow-result-transcript-card">
              <div><FileText aria-hidden="true" /><strong>本次口语原文</strong><span>{data.speakingContent.length} 字</span></div>
              <p>{data.speakingContent || '未保留口语复述文本。'}</p>
            </section>
          </aside>
        )}
        {completionContent && !focusCanvas && <div className="flow-result-completion-slot" inert={busy || undefined}>{completionContent}</div>}
      </main>
      {cognitionOpen && <div className="flow-result-back-overlay">
        <div ref={cognitionDialogRef} className="flow-result-cognition-dialog" role="dialog" aria-modal="true" aria-labelledby="flow-result-cognition-title" tabIndex={-1}>
          <header><h2 id="flow-result-cognition-title">确认写入个人认知</h2><button type="button" onClick={() => {
            if (allowCognitionLeave(cognitionDialogRef.current)) setCognitionOpen(false);
          }}>关闭</button></header>
          <PersonalCognitionPanel doc={safeDoc} noteId={data.noteId} />
        </div>
      </div>}
      {confirmBack && <div className="flow-result-back-overlay">
        <div ref={backDialogRef} className="flow-result-back-dialog" role="dialog" aria-modal="true"
          aria-labelledby="flow-result-back-title" aria-describedby="flow-result-back-description" tabIndex={-1}>
          <h2 id="flow-result-back-title">返回笔记？</h2>
          <p id="flow-result-back-description">当前论证结构尚未保存。返回会放弃本页的结构及修改；如需保留，请先保存结果。</p>
          <div>
            <button type="button" onClick={() => setConfirmBack(false)}>继续编辑</button>
            <button type="button" disabled={busy} onClick={() => { if (!busy) onBack(); }}>放弃并返回</button>
          </div>
        </div>
      </div>}
      <ArgumentPublicationDialog request={publicationRequest} onCancel={() => setPublicationRequest(null)} onChoose={(choice) => {
        setPublicationRequest(null); onSave(choice);
      }} />
    </div>
  );
};
