import React, { useState, useEffect } from 'react';
import { NoteItem, StudyQuestionCard, KnowledgePointMasteryResult, LayeredScoreResult, Vulnerability } from '../types';
import { runFlowAnalysis, FlowAnalysisProgressStage } from '../services/flowAnalysis/orchestrator';
import { FlowAnalysisReport, FlowAnalysisSection } from '../services/flowAnalysis/types';
import type { ArgDoc } from '../services/argumentDoc/types';
import { ArgumentQualitySectionItem } from '../services/flowAnalysis/reportAssembler';
import { Sparkles, X, Loader2, AlertTriangle, BookOpen, TrendingUp, Brain, Link2, MessageCircle, Download, Check } from 'lucide-react';

interface FlowAnalysisPanelProps {
  speakingContent: string;
  noteTitle: string;
  /** 分析结果所属笔记 id（用于把论证结构写回该笔记） */
  noteId?: string | null;
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
  /** 分析结束回调（成功或失败都会触发，用于关闭等待弹窗） */
  onDone?: () => void;
  /** 受控模式：为 false 时不自动触发分析，直接展示 initialReport */
  autoRun?: boolean;
  /** 受控模式下直接展示的初始报告 */
  initialReport?: FlowAnalysisReport | null;
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
          lines.push(`- 概念：${q.layeredScores.final.concept}（${q.layeredScores.grade.concept}）`);
          lines.push(`- 判断：${q.layeredScores.final.judgment}（${q.layeredScores.grade.judgment}）`);
          lines.push(`- 推理：${q.layeredScores.final.logic}（${q.layeredScores.grade.logic}）`);
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
        lines.push(`- **${r.name}**（${level}）：概念 ${r.conceptDelta >= 0 ? '+' : ''}${r.conceptDelta} · 判断 ${r.judgmentDelta >= 0 ? '+' : ''}${r.judgmentDelta} · 推理 ${r.reasoningDelta >= 0 ? '+' : ''}${r.reasoningDelta}${r.comment ? ` —— ${r.comment}` : ''}`);
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
}) => {
  const [report, setReport] = useState<FlowAnalysisReport | null>(initialReport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [exportMsg, setExportMsg] = useState<string>('');

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
    try {
      const result = await runFlowAnalysis(
        {
          speakingContent,
          noteTitle,
          allNotes,
          summaryText,
          questions,
        },
        masteryResults || [],
        onProgress,
      );
      setReport(result.report);
      setServiceError(result.serviceError || null);

      // 上抛给外层进入全屏论证编辑（不再直接写笔记，由编辑视图退出时统一落盘）
      onArgumentReady?.(result.argumentDoc, result.report);
    } catch (err: any) {
      setError(err.message || 'AI 分析失败');
    } finally {
      setLoading(false);
      onDone?.();
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

  const getScoreColor = (s: number) => (s >= 80 ? '#10B981' : s >= 60 ? '#F59E0B' : '#EF4444');
  const score = report?.clarityScore ?? 0;
  const circ = 2 * Math.PI * 22;
  const dash = circ - (score / 100) * circ;

  return (
    <div className="flow-analysis-panel">
      <div className="flow-analysis-header">
        <div className="flow-analysis-title"><Sparkles className="w-4 h-4 text-indigo-500" /> 口语复盘分析</div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleExport}
            disabled={!report || exportState === 'exporting'}
            className="flow-analysis-export"
            title="导出 Markdown"
          >
            {exportState === 'exporting' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : exportState === 'done' ? (
              <Check className="w-4 h-4 text-emerald-500" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
          {onClose && <button onClick={onClose} className="flow-analysis-close"><X className="w-4 h-4" /></button>}
        </div>
      </div>
      <div className="text-[0.7rem] text-slate-500">口语 {speakingContent.length} 字 · {noteTitle}</div>

      {exportState === 'done' && exportMsg && (
        <div className="p-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs text-emerald-700 dark:text-emerald-300">
          <Check className="w-3.5 h-3.5 inline-block" /> {exportMsg}
        </div>
      )}
      {exportState === 'error' && exportMsg && (
        <div className="p-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
          {exportMsg}
        </div>
      )}

      {serviceError && !loading && (
        <div className="p-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-lg text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 inline-block" /> {serviceError}
        </div>
      )}

      {loading && <div className="flow-analysis-loading"><Loader2 className="w-4 h-4 animate-spin" /> 分析中...</div>}
      {error && !loading && (
        <div className="p-2.5 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
          {error}
          <button onClick={requestAnalysis} className="ml-2 underline">重试</button>
        </div>
      )}
      {!report && !loading && !error && (
        <div className="flow-analysis-empty"><BookOpen className="w-6 h-6 opacity-30" /><span>暂无足够复盘文本</span></div>
      )}

      {report && !loading && (
        <>
          {/* 清晰度分数环 + 简短评论 */}
          <div className="flow-analysis-score">
            <div className="flow-analysis-score-ring">
              <svg viewBox="0 0 54 54" width="54" height="54">
                <defs>
                  <linearGradient id="flow-score-gradient">
                    <stop offset="0%" stopColor={getScoreColor(score)} />
                    <stop offset="100%" stopColor="#6366f1" />
                  </linearGradient>
                </defs>
                <circle className="flow-analysis-score-bg" cx="27" cy="27" r="22" />
                <circle className="flow-analysis-score-fill" cx="27" cy="27" r="22" strokeDasharray={circ} strokeDashoffset={dash} />
              </svg>
              <div className="flow-analysis-score-value">{score}</div>
            </div>
            <div className="flow-analysis-score-label">
              <span className="font-bold">表达清晰度</span><br />
              <span className="text-[0.7rem]">{report.clarityComment || (score >= 80 ? '表达流畅清晰' : score >= 60 ? '整体尚可' : '需加强表达')}</span>
            </div>
          </div>

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
            <SectionRenderer key={sec.kind} section={sec} onSelectNoteByTitle={onSelectNoteByTitle} />
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
  onSelectNoteByTitle?: (title: string) => void;
}> = ({ section, onSelectNoteByTitle }) => {
  const renderByKind = () => {
    switch (section.kind) {
      case 'argumentQuality':
        return (section.items as ArgumentQualitySectionItem[]).map((q, i) => (
          <div key={i} className="flow-analysis-card">
            {q.layeredScores && (
              <div className="flow-analysis-card-suggestion">
                {(['concept', 'judgment', 'logic'] as const).map((k) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-slate-500 dark:text-slate-400">{LAYER_LABELS[k]}</span>
                    <span className="font-bold text-emerald-700 dark:text-emerald-400">
                      {q.layeredScores!.final[k]} <span className="text-[0.7rem] font-normal text-slate-400">（{q.layeredScores!.grade[k]}）</span>
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
            <div
              className="flow-analysis-card-desc cursor-pointer hover:text-indigo-500"
              onClick={() => { if (k.suggestedWikiLink && onSelectNoteByTitle) onSelectNoteByTitle(k.suggestedWikiLink); }}
            >
              {k.term} — {k.relation}
            </div>
            {k.suggestedWikiLink && <div className="flow-analysis-card-suggestion">→ [[{k.suggestedWikiLink}]]</div>}
          </div>
        ));

      case 'cognitiveInterpretation':
      case 'expressionStyle':
        return (section.items as string[]).map((text, i) => (
          <div key={i} className="flow-analysis-card"><div className="flow-analysis-card-desc">{text}</div></div>
        ));

      case 'mastery':
        return (section.items as Array<KnowledgePointMasteryResult>).map((r, i) => (
          <div key={i} className="flow-analysis-card">
            <div className="flow-analysis-card-desc">
              <span className="font-bold">{r.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 ml-1">
                {r.level === 'reasoning' ? '推理层' : r.level === 'judgment' ? '判断层' : '概念层'}
              </span>
            </div>
            <div className="flow-analysis-card-suggestion">
              概念{r.conceptDelta >= 0 ? '+' : ''}{r.conceptDelta} · 判断{r.judgmentDelta >= 0 ? '+' : ''}{r.judgmentDelta} · 推理{r.reasoningDelta >= 0 ? '+' : ''}{r.reasoningDelta}
            </div>
            {r.comment && <div className="flow-analysis-card-suggestion"><MessageCircle className="w-3.5 h-3.5 inline-block" /> {r.comment}</div>}
          </div>
        ));

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