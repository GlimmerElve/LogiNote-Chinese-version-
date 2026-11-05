import React, { useState, useEffect, useId } from 'react';
import { NoteItem, StudyQuestionCard, KnowledgePointMasteryResult, LayeredScoreResult, Vulnerability, ProfileInsight } from '../types';
import { runFlowAnalysis, FlowAnalysisProgressStage } from '../services/flowAnalysis/orchestrator';
import { FlowAnalysisReport, FlowAnalysisSection, type FlowAnalysisInput, type FlowReviewAnalysisResultV2 } from '../services/flowAnalysis/types';
import type { ArgDoc } from '../services/argumentDoc/types';
import type { ArgumentQualitySectionItem } from '../services/flowAnalysis/types';
import { KnowledgeMasteryDetails, KnowledgeMasteryStateGuide } from './KnowledgeMasteryDetails';
import { MASTERY_SHADOW_STATE_LABELS } from '../services/masteryShadow/types';
import { Sparkles, X, Loader2, AlertTriangle, BookOpen, TrendingUp, Brain, Link2, MessageCircle, Download, Check } from 'lucide-react';

interface FlowAnalysisPanelProps {
  speakingContent: string;
  noteTitle: string;
  /** 分析结果所属笔记 id（用于把论证结构写回该笔记） */
  noteId?: string | null;
  /** 复盘情景 ID，同时用作 V2 分析幂等身份。 */
  analysisRunId?: string;
  reviewTask?: FlowAnalysisInput['reviewTask'];
  allNotes: NoteItem[];
  summaryText?: string;
  questions?: StudyQuestionCard[];
  onClose?: () => void;
  onSelectNoteByTitle?: (title: string) => void;
  /** 直接写入笔记内容（用于来源一更新已有知识点的概念掌握度） */
  onUpdateNote?: (updated: NoteItem) => void;
  /** 分析完成后上抛论证结构文档与报告，由外层进入全屏论证编辑视图 */
  onArgumentReady?: (doc: ArgDoc | undefined, report: FlowAnalysisReport) => void;
  /** 并行评分后的知识点掌握度结果 */
  masteryResults?: KnowledgePointMasteryResult[];
  /** 分析进度回调（供外层等待弹窗展示当前阶段） */
  onProgress?: (stage: FlowAnalysisProgressStage) => void;
  /** 分析结束回调（成功或失败都会触发，用于关闭等待弹窗并补全情景记录） */
  onDone?: (result: { report?: FlowAnalysisReport; profileInsight?: ProfileInsight; analysisV2?: FlowReviewAnalysisResultV2;
    serviceError?: string; error?: string }) => void;
  /** 受控模式：为 false 时不自动触发分析，直接展示 initialReport */
  autoRun?: boolean;
  /** 受控模式下直接展示的初始报告 */
  initialReport?: FlowAnalysisReport | null;
  completionContent?: React.ReactNode;
}

/** 生成时间戳文件名后缀 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 三层标签映射 */
const LAYER_LABELS: Record<string, string> = {
  concept: '概念',
  judgment: '判断',
  logic: '推理',
};

/** 漏洞影响层面中文标签 */
const VULN_LAYER_LABELS: Record<string, string> = {
  '概念层': '概念',
  '判断层': '判断',
  '逻辑层': '逻辑',
  '多层': '多层',
  '无法判断': '待定',
};

/** 把分析报告组装为 Markdown 文本 */
function buildMarkdown(report: FlowAnalysisReport, noteTitle: string, speakingContent: string): string {
  const lines: string[] = [];
  lines.push(`# 心流复盘分析报告`);
  lines.push(``);
  lines.push(`- 笔记：${noteTitle || '（未命名）'}`);
  lines.push(`- 导出时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push(``);

  if (report.clarityScore !== undefined) {
    lines.push(`## 表达清晰度`);
    lines.push(``);
    lines.push(`**${report.clarityScore}** / 100${report.clarityComment ? ` —— ${report.clarityComment}` : ''}`);
    lines.push(``);
  }

  if (report.thinkingStyleBrief) {
    lines.push(`## 思维表达特点`);
    lines.push(``);
    lines.push(`${report.thinkingStyleBrief}`);
    lines.push(``);
  }

  if (report.summary) {
    lines.push(`## 综合归纳`);
    lines.push(``);
    lines.push(`${report.summary}`);
    lines.push(``);
  }

  if (report.recommendation) {
    lines.push(`## 综合建议`);
    lines.push(``);
    lines.push(`${report.recommendation}`);
    lines.push(``);
  }

  for (const sec of report.sections) {
    lines.push(`## ${sec.title}（${sec.items.length}）`);
    lines.push(``);
    for (const it of sec.items) {
      if (sec.kind === 'argumentQuality') {
        const q = it as ArgumentQualitySectionItem;
        if (q.layeredScores) {
          for (const [label, key, layer] of [['概念', 'concept', 'concept'], ['判断', 'judgment', 'judgment'], ['推理', 'logic', 'reasoning']] as const) {
            lines.push(`- ${label}：${report.unscoredLayers?.includes(layer) ? '暂不可评' : `${q.layeredScores.final[key]}（${q.layeredScores.grade[key]}）`}`);
          }
        }
        if (q.summary) {
          lines.push(``);
          lines.push(`${q.summary}`);
        }
        if (q.vulnerabilities.length > 0) {
          lines.push(``);
          lines.push(`**隐含漏洞与可强化点**`);
          for (const v of q.vulnerabilities) {
            lines.push(`- [${VULN_LAYER_LABELS[v.layer] ?? v.layer}] ${v.type}（严重度 ${v.severity}）：${v.evidence}`);
            lines.push(`  - 建议：${v.suggestion}`);
          }
        }
      } else if (sec.kind === 'relatedKnowledge') {
        const k = it as { term: string; relation: string; suggestedWikiLink?: string };
        lines.push(`- ${k.term} —— ${k.relation}${k.suggestedWikiLink ? `（→ [[${k.suggestedWikiLink}]]）` : ''}`);
      } else if (sec.kind === 'mastery') {
        const r = it as KnowledgePointMasteryResult;
        const level = r.level === 'reasoning' ? '推理层' : r.level === 'judgment' ? '判断层' : '概念层';
        lines.push(r.shadow
          ? `- **${r.name}**：概念 ${MASTERY_SHADOW_STATE_LABELS[r.shadow.layers.concept.state]} · 判断 ${MASTERY_SHADOW_STATE_LABELS[r.shadow.layers.judgment.state]} · 推理 ${MASTERY_SHADOW_STATE_LABELS[r.shadow.layers.reasoning.state]} —— ${r.comment}`
          : `- **${r.name}**（${level}）：概念 ${r.conceptDelta >= 0 ? '+' : ''}${r.conceptDelta} · 判断 ${r.judgmentDelta >= 0 ? '+' : ''}${r.judgmentDelta} · 推理 ${r.reasoningDelta >= 0 ? '+' : ''}${r.reasoningDelta}${r.comment ? ` —— ${r.comment}` : ''}`);
      } else {
        lines.push(`- ${String(it)}`);
      }
    }
    lines.push(``);
  }

  if (report.overallComment) {
    lines.push(`## 综合评价与突破口`);
    lines.push(``);
    lines.push(`${report.overallComment}`);
    lines.push(``);
  }

  lines.push(`## 口语复盘原文`);
  lines.push(``);
  lines.push(speakingContent);
  lines.push(``);

  return lines.join('\n');
}

export const FlowAnalysisPanel: React.FC<FlowAnalysisPanelProps> = ({
  speakingContent,
  noteTitle,
  noteId,
  analysisRunId,
  reviewTask,
  allNotes,
  summaryText,
  questions,
  onClose,
  onSelectNoteByTitle,
  onUpdateNote,
  onArgumentReady,
  masteryResults,
  onProgress,
  onDone,
  autoRun = true,
  initialReport = null,
  completionContent,
}) => {
  const [report, setReport] = useState<FlowAnalysisReport | null>(initialReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [exportMsg, setExportMsg] = useState<string>('');
  const scoreGradientId = useId();

  useEffect(() => {
    if (autoRun === false) return;
    if (!speakingContent || speakingContent.trim().length < 10) return;
    requestAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakingContent, autoRun]);

  useEffect(() => {
    if (autoRun === false) setReport(initialReport);
  }, [initialReport, autoRun]);

  const requestAnalysis = async () => {
    setLoading(true);
    setError(null);
    let completion: { report?: FlowAnalysisReport; profileInsight?: ProfileInsight; analysisV2?: FlowReviewAnalysisResultV2;
      serviceError?: string; error?: string } = {};
    try {
      const result = await runFlowAnalysis(
        {
          speakingContent,
          noteTitle,
          noteId: noteId || undefined,
          analysisRunId,
          reviewTask,
          allNotes,
          summaryText,
          questions,
        },
        masteryResults || [],
        onProgress,
      );
      setReport(result.report);
      setServiceError(result.serviceError || null);
      completion = { report: result.report, profileInsight: result.profileInsight, analysisV2: result.analysisV2,
        serviceError: result.serviceError };

      // Outer App persists this existing graph as a draft and syncs private cognition;
      // the result canvas remains editable and publication still requires its original choice.
      onArgumentReady?.(result.argumentDoc, result.report);
    } catch (err: any) {
      const message = err?.message || 'AI 分析失败';
      setError(message);
      completion = { error: message };
    } finally {
      setLoading(false);
      onDone?.(completion);
    }
  };

  const handleExport = async () => {
    if (!report) return;
    const api = (window as any).electronAPI?.analysis;
    if (!api) {
      setExportState('error');
      setExportMsg('当前环境不支持导出（仅桌面版可用）');
      return;
    }
    setExportState('exporting');
    setExportMsg('');
    try {
      const md = buildMarkdown(report, noteTitle, speakingContent);
      const fileName = `${noteTitle || '分析报告'}_${timestamp()}.md`;
      const res = await api.exportReport(md, fileName);
      if (res?.ok) {
        setExportState('done');
        setExportMsg(`已导出：${res.path}`);
      } else if (res?.error === '已取消') {
        setExportState('idle');
        setExportMsg('');
      } else {
        setExportState('error');
        setExportMsg(res?.error || '导出失败');
      }
    } catch (e: any) {
      setExportState('error');
      setExportMsg(e?.message || '导出失败');
    }
  };

  const getScoreColor = (s: number) => (s >= 80 ? 'var(--ln-accent)' : s >= 60 ? 'var(--ln-warning)' : 'var(--ln-danger)');
  const score = report?.clarityScore ?? 0;
  const circ = 2 * Math.PI * 22;
  const dash = circ - (score / 100) * circ;

  return (
    <div className="flow-analysis-panel" aria-label="口语复盘分析" aria-busy={loading}>
      <div className="flow-analysis-header">
        <div className="flow-analysis-title"><Sparkles className="w-4 h-4 text-[var(--ln-accent)]" aria-hidden="true" /> 口语复盘分析</div>
        <div className="flow-analysis-actions">
          <button
            type="button"
            onClick={handleExport}
            disabled={!report || exportState === 'exporting'}
            className="flow-analysis-export"
            title="导出 Markdown"
            aria-label={exportState === 'exporting' ? '正在导出复盘报告' : '导出复盘报告'}
          >
            {exportState === 'exporting' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : exportState === 'done' ? (
              <Check className="w-4 h-4 text-[var(--ln-accent)]" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
          {onClose && <button type="button" onClick={onClose} className="flow-analysis-close" aria-label="关闭复盘分析" title="关闭复盘分析"><X className="w-4 h-4" aria-hidden="true" /></button>}
        </div>
      </div>
      <div className="flow-analysis-meta">口语 {speakingContent.length} 字 · {noteTitle}</div>

      {exportState === 'done' && exportMsg && (
        <div className="flow-analysis-notice" role="status">
          <Check className="w-3.5 h-3.5 inline-block" /> {exportMsg}
        </div>
      )}
      {exportState === 'error' && exportMsg && (
        <div className="flow-analysis-notice is-error" role="alert">
          {exportMsg}
        </div>
      )}

      {serviceError && !loading && (
        <div className="flow-analysis-notice is-warning" role="status">
          <AlertTriangle className="w-3.5 h-3.5 inline-block" /> {serviceError}
        </div>
      )}

      {loading && <div className="flow-analysis-loading" role="status"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> 分析中...</div>}
      {error && !loading && (
        <div className="flow-analysis-notice is-error" role="alert">
          {error}
          <button type="button" onClick={requestAnalysis} className="flow-analysis-retry">重试分析</button>
        </div>
      )}
      {!loading && completionContent}
      {!report && !loading && !error && (
        <div className="flow-analysis-empty"><BookOpen className="w-6 h-6 opacity-30" /><span>暂无足够复盘文本</span></div>
      )}

      {report && !loading && (
        <>
          {/* V2 不在没有音频/时间证据时伪造“表达清晰度”分数。 */}
          {typeof report.clarityScore === 'number' && <div className="flow-analysis-score">
            <div className="flow-analysis-score-ring">
              <svg viewBox="0 0 54 54" width="54" height="54">
                <defs>
                  <linearGradient id={scoreGradientId}>
                    <stop offset="0%" stopColor={getScoreColor(score)} />
                    <stop offset="100%" stopColor="var(--ln-accent)" />
                  </linearGradient>
                </defs>
                <circle className="flow-analysis-score-bg" cx="27" cy="27" r="22" />
                <circle className="flow-analysis-score-fill" cx="27" cy="27" r="22" stroke={`url(#${scoreGradientId})`} strokeDasharray={circ} strokeDashoffset={dash} />
              </svg>
              <div className="flow-analysis-score-value">{score}</div>
            </div>
            <div className="flow-analysis-score-label">
              <span className="font-bold">表达清晰度</span><br />
              <span>{report.clarityComment || (score >= 80 ? '表达流畅清晰' : score >= 60 ? '整体尚可' : '需加强表达')}</span>
            </div>
          </div>}

          {/* 思维表达特点 */}
          {report.thinkingStyleBrief && (
            <div className="flow-analysis-summary"><Sparkles className="w-3.5 h-3.5 inline mr-1" />{report.thinkingStyleBrief}</div>
          )}

          {/* 综合归纳 */}
          {report.summary && (
            <div className="flow-analysis-summary"><TrendingUp className="w-3.5 h-3.5 inline mr-1" />{report.summary}</div>
          )}

          {/* 综合建议 */}
          {report.recommendation && (
            <div className="flow-analysis-section">
              <div className="flow-analysis-section-title"><Brain className="w-3.5 h-3.5 inline mr-1" />综合建议</div>
              <div className="flow-analysis-card"><div className="flow-analysis-card-desc">{report.recommendation}</div></div>
            </div>
          )}

          {/* 统一分类渲染 sections */}
          {report.sections.map((sec) => (
            <SectionRenderer key={sec.kind} section={sec} unscoredLayers={report.unscoredLayers} onSelectNoteByTitle={onSelectNoteByTitle} />
          ))}

          {/* 综合评价与突破口 */}
          {report.overallComment && (
            <div className="flow-analysis-section">
              <div className="flow-analysis-section-title"><MessageCircle className="w-3.5 h-3.5 inline mr-1" />综合评价与突破口</div>
              <div className="flow-analysis-card"><div className="flow-analysis-card-desc">{report.overallComment}</div></div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** 根据 section.kind 分类渲染（统一接口 + 分类渲染） */
const SectionRenderer: React.FC<{
  section: FlowAnalysisSection;
  unscoredLayers?: FlowAnalysisReport['unscoredLayers'];
  onSelectNoteByTitle?: (title: string) => void;
}> = ({ section, unscoredLayers, onSelectNoteByTitle }) => {
  const renderByKind = () => {
    switch (section.kind) {
      case 'argumentQuality':
        return (section.items as ArgumentQualitySectionItem[]).map((q, i) => (
          <div key={i} className="flow-analysis-card">
            {q.layeredScores && (
              <div className="flow-analysis-card-suggestion">
                {(['concept', 'judgment', 'logic'] as const).map((k) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-[var(--ln-text-secondary)]">{LAYER_LABELS[k]}</span>
                    <span className="font-bold text-[var(--ln-accent)]">
                      {unscoredLayers?.includes(k === 'logic' ? 'reasoning' : k) ? '暂不可评'
                        : <>{q.layeredScores!.final[k]} <span className="font-normal text-[var(--ln-text-muted)]">（{q.layeredScores!.grade[k]}）</span></>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {q.summary && (
              <div className="flow-analysis-card-desc mt-2 text-sm leading-relaxed">{q.summary}</div>
            )}
          </div>
        ));

      case 'relatedKnowledge':
        return (section.items as Array<{ term: string; relation: string; suggestedWikiLink?: string }>).map((k, i) => (
          <div key={i} className="flow-analysis-card">
            {k.suggestedWikiLink && onSelectNoteByTitle ? (
              <button type="button" className="flow-analysis-knowledge-link"
                onClick={() => onSelectNoteByTitle(k.suggestedWikiLink!)}>
                <span className="flow-analysis-card-desc">{k.term} — {k.relation}</span>
                <span className="flow-analysis-card-suggestion">→ [[{k.suggestedWikiLink}]]</span>
              </button>
            ) : (
              <>
                <div className="flow-analysis-card-desc">{k.term} — {k.relation}</div>
                {k.suggestedWikiLink && <div className="flow-analysis-card-suggestion">[[{k.suggestedWikiLink}]]</div>}
              </>
            )}
          </div>
        ));

      case 'cognitiveInterpretation':
      case 'expressionStyle':
        return (section.items as string[]).map((text, i) => (
          <div key={i} className="flow-analysis-card"><div className="flow-analysis-card-desc">{text}</div></div>
        ));

      case 'mastery':
        return <>
          {(section.items as KnowledgePointMasteryResult[]).some(item => item.shadow) && <KnowledgeMasteryStateGuide />}
          {(section.items as Array<KnowledgePointMasteryResult>).map((r, i) => (
          <div key={i} className="flow-analysis-card">
            <div className="flow-analysis-card-desc">
              <span className="font-bold">{r.name}</span>
              <span className="flow-analysis-layer-tag">
                {r.level === 'reasoning' ? '推理层' : r.level === 'judgment' ? '判断层' : r.level === 'concept' ? '概念层' : '本次未展开'}
              </span>
            </div>
            {r.shadow ? <KnowledgeMasteryDetails result={r.shadow} /> : <div className="flow-analysis-card-suggestion">
              概念{r.conceptDelta >= 0 ? '+' : ''}{r.conceptDelta} · 判断{r.judgmentDelta >= 0 ? '+' : ''}{r.judgmentDelta} · 推理{r.reasoningDelta >= 0 ? '+' : ''}{r.reasoningDelta}
            </div>}
            {r.comment && <div className="flow-analysis-card-suggestion"><MessageCircle className="w-3.5 h-3.5 inline-block" /> {r.comment}</div>}
          </div>
        ))}</>;

      default:
        return (section.items as unknown[]).map((it, i) => (
          <div key={i} className="flow-analysis-card">{String(it)}</div>
        ));
    }
  };

  const icons: Partial<Record<FlowAnalysisSection['kind'], React.ReactNode>> = {
    argumentQuality: <Brain className="w-3.5 h-3.5 inline mr-1" />,
    cognitiveInterpretation: <Brain className="w-3.5 h-3.5 inline mr-1" />,
    expressionStyle: <MessageCircle className="w-3.5 h-3.5 inline mr-1" />,
    relatedKnowledge: <Link2 className="w-3.5 h-3.5 inline mr-1" />,
  };

  return (
    <div className="flow-analysis-section">
      <div className="flow-analysis-section-title">
        {icons[section.kind] ?? null}
        {section.title} ({section.items.length})
      </div>
      {renderByKind()}
    </div>
  );
};
