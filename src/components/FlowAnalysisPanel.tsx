import React, { useState, useEffect } from 'react';
import { NoteItem, StudyQuestionCard, KnowledgePointMasteryResult, ArgumentAnalysis, LayerIssue } from '../types';
import { runFlowAnalysis, FlowAnalysisProgressStage } from '../services/flowAnalysis/orchestrator';
import { FlowAnalysisReport, FlowAnalysisSection, DiagnosisItem } from '../services/flowAnalysis/types';
import { Sparkles, X, Loader2, AlertTriangle, Zap, BookOpen, TrendingUp, Brain, Link2, MessageCircle, Download, Check } from 'lucide-react';

interface FlowAnalysisPanelProps {
  speakingContent: string;
  noteTitle: string;
  allNotes: NoteItem[];
  summaryText?: string;
  questions?: StudyQuestionCard[];
  onClose?: () => void;
  onSelectNoteByTitle?: (title: string) => void;
  /** 直接写入笔记内容（用于来源一更新已有知识点的概念掌握度） */
  onUpdateNote?: (updated: NoteItem) => void;
  /** 并行评分后的知识点掌握度结果 */
  masteryResults?: KnowledgePointMasteryResult[];
  /** 分析进度回调（供外层等待弹窗展示当前阶段） */
  onProgress?: (stage: FlowAnalysisProgressStage) => void;
  /** 分析结束回调（成功或失败都会触发，用于关闭等待弹窗） */
  onDone?: () => void;
}

/** 生成时间戳文件名后缀 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 布尔锚点的字段名联合类型 */
type BooleanAnchorKey =
  | 'redefinesInOwnWords'
  | 'distinguishesSimilarConcepts'
  | 'givesCounterExamples'
  | 'considersConditions'
  | 'distinguishesFactOpinion'
  | 'usesQualifiers'
  | 'hasPremise'
  | 'completeChain'
  | 'identifiesAssumption'
  | 'distinguishesDeductiveInductive'
  | 'considersCounterfactual';

/** 单个锚点：字段名 + 中文标签 */
interface AnchorSpec {
  key: BooleanAnchorKey;
  label: string;
}

/** 概念层锚点（3） */
const CONCEPT_ANCHORS: AnchorSpec[] = [
  { key: 'redefinesInOwnWords', label: '用自己的话重述' },
  { key: 'distinguishesSimilarConcepts', label: '区分相近概念' },
  { key: 'givesCounterExamples', label: '举例/反例' },
];

/** 判断层锚点（3） */
const JUDGMENT_ANCHORS: AnchorSpec[] = [
  { key: 'considersConditions', label: '条件范围' },
  { key: 'distinguishesFactOpinion', label: '事实vs观点' },
  { key: 'usesQualifiers', label: '量化用语' },
];

/** 推理层锚点（5） */
const REASONING_ANCHORS: AnchorSpec[] = [
  { key: 'hasPremise', label: '前提' },
  { key: 'completeChain', label: '逻辑链健全' },
  { key: 'identifiesAssumption', label: '识别假设' },
  { key: 'distinguishesDeductiveInductive', label: '演绎归纳' },
  { key: 'considersCounterfactual', label: '反事实' },
];

/** 把一层的锚点拼成 Markdown 文本（✓有 / ○无） */
function anchorLine(arg: ArgumentAnalysis, specs: AnchorSpec[]): string {
  return specs.map((s) => `${arg[s.key] ? '✓' : '○'}${s.label}`).join(' · ');
}

/** 渲染一层的锚点为带色 span（✓绿 / ○灰） */
function renderAnchors(arg: ArgumentAnalysis, specs: AnchorSpec[]): React.ReactNode[] {
  return specs.flatMap((s, idx) => {
    const node = (
      <span key={s.key} className={arg[s.key] ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}>
        {arg[s.key] ? '✓' : '○'} {s.label}
      </span>
    );
    if (idx === 0) return [node];
    return [<span key={`sep-${s.key}`} className="mx-1.5 text-slate-300">·</span>, node];
  });
}

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

  if (report.conceptSummary || report.judgmentSummary || report.reasoningSummary) {
    lines.push(`## 分层综合评价`);
    lines.push(``);
    if (report.conceptSummary) lines.push(`- 概念层：${report.conceptSummary}`);
    if (report.judgmentSummary) lines.push(`- 判断层：${report.judgmentSummary}`);
    if (report.reasoningSummary) lines.push(`- 推理层：${report.reasoningSummary}`);
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
      if (sec.kind === 'conceptDiagnosis' || sec.kind === 'judgmentDiagnosis' || sec.kind === 'logicDiagnosis') {
        const d = it as DiagnosisItem;
        lines.push(`- 原文：${d.quote}`);
        lines.push(`  - 问题：${d.issue}`);
        lines.push(`  - 建议：${d.correction}`);
      } else if (sec.kind === 'relatedKnowledge') {
        const k = it as { term: string; relation: string; suggestedWikiLink?: string };
        lines.push(`- ${k.term} —— ${k.relation}${k.suggestedWikiLink ? `（→ [[${k.suggestedWikiLink}]]）` : ''}`);
      } else if (sec.kind === 'reasoningArguments') {
        const arg = it as ArgumentAnalysis;
        const fallacyKinds = (arg.issues || []).filter(i => i.layer === 'reasoning' && i.fallacyKind).map(i => i.fallacyKind);
        lines.push(`- **${arg.claim}**`);
        lines.push(`  - 概念：${anchorLine(arg, CONCEPT_ANCHORS)}`);
        lines.push(`  - 判断：${anchorLine(arg, JUDGMENT_ANCHORS)}`);
        lines.push(`  - 推理：${anchorLine(arg, REASONING_ANCHORS)}${fallacyKinds.length ? ` · ⚠${fallacyKinds.join('、')}` : ''}`);
      } else if (sec.kind === 'keyIssues') {
        const iss = it as LayerIssue;
        const layerLabel = iss.layer === 'concept' ? '概念' : iss.layer === 'judgment' ? '判断' : '推理';
        lines.push(`- [${layerLabel}] ${iss.quote}`);
        lines.push(`  - 问题：${iss.issue}`);
        lines.push(`  - 建议：${iss.correction}`);
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
  allNotes,
  summaryText,
  questions,
  onClose,
  onSelectNoteByTitle,
  onUpdateNote,
  masteryResults,
  onProgress,
  onDone,
}) => {
  const [report, setReport] = useState<FlowAnalysisReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [exportMsg, setExportMsg] = useState<string>('');

  useEffect(() => {
    if (!speakingContent || speakingContent.trim().length < 10) return;
    requestAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakingContent]);

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

          {/* 分层综合评价 */}
          {(report.conceptSummary || report.judgmentSummary || report.reasoningSummary) && (
            <div className="flow-analysis-section">
              <div className="flow-analysis-section-title"><Brain className="w-3.5 h-3.5 inline mr-1" />分层综合评价</div>
              {report.conceptSummary && (
                <div className="flow-analysis-card"><div className="flow-analysis-card-desc"><span className="font-bold text-indigo-600 dark:text-indigo-400">概念层：</span>{report.conceptSummary}</div></div>
              )}
              {report.judgmentSummary && (
                <div className="flow-analysis-card"><div className="flow-analysis-card-desc"><span className="font-bold text-amber-600 dark:text-amber-400">判断层：</span>{report.judgmentSummary}</div></div>
              )}
              {report.reasoningSummary && (
                <div className="flow-analysis-card"><div className="flow-analysis-card-desc"><span className="font-bold text-emerald-600 dark:text-emerald-400">推理层：</span>{report.reasoningSummary}</div></div>
              )}
            </div>
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
      case 'reasoningArguments':
        return (section.items as ArgumentAnalysis[]).map((arg, i) => {
          const fallacyKinds = (arg.issues || []).filter(iss => iss.layer === 'reasoning' && iss.fallacyKind).map(iss => iss.fallacyKind);
          return (
            <div key={i} className="flow-analysis-card">
              <div className="flow-analysis-card-desc font-bold">{arg.claim}</div>
              <div className="flow-analysis-card-suggestion flex flex-col gap-1">
                <div className="flex items-center flex-wrap">
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded mr-1 bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400">概念</span>
                  {renderAnchors(arg, CONCEPT_ANCHORS)}
                </div>
                <div className="flex items-center flex-wrap">
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded mr-1 bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">判断</span>
                  {renderAnchors(arg, JUDGMENT_ANCHORS)}
                </div>
                <div className="flex items-center flex-wrap">
                  <span className="text-[0.65rem] px-1.5 py-0.5 rounded mr-1 bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">推理</span>
                  {renderAnchors(arg, REASONING_ANCHORS)}
                  {fallacyKinds.length > 0 && (
                    <span className="ml-1.5 text-red-500 dark:text-red-400 font-semibold">⚠ {fallacyKinds.join('、')}</span>
                  )}
                </div>
              </div>
            </div>
          );
        });

      case 'keyIssues':
        return (section.items as LayerIssue[]).map((iss, i) => (
          <div key={i} className="flow-analysis-card">
            <div className="flow-analysis-card-desc">
              <span className={`text-[0.65rem] px-1.5 py-0.5 rounded mr-1 ${iss.layer === 'concept' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400' : iss.layer === 'judgment' ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400' : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400'}`}>
                {iss.layer === 'concept' ? '概念' : iss.layer === 'judgment' ? '判断' : '推理'}
              </span>
              {iss.quote}
            </div>
            <div className="flow-analysis-card-desc mt-1 text-amber-600 dark:text-amber-400">{iss.issue}</div>
            <div className="flow-analysis-card-suggestion"><Check className="w-3.5 h-3.5 inline-block" /> {iss.correction}</div>
          </div>
        ));

      case 'conceptDiagnosis':
      case 'judgmentDiagnosis':
      case 'logicDiagnosis':
        return (section.items as DiagnosisItem[]).map((d, i) => (
          <div key={i} className="flow-analysis-card">
            <div className="flow-analysis-card-desc">
              <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 mr-1">原文</span>
              {d.quote}
            </div>
            <div className="flow-analysis-card-desc mt-1 text-amber-600 dark:text-amber-400">{d.issue}</div>
<div className="flow-analysis-card-suggestion"><Check className="w-3.5 h-3.5 inline-block" /> {d.correction}</div>
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
    conceptDiagnosis: <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />,
    judgmentDiagnosis: <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />,
    logicDiagnosis: <Zap className="w-3.5 h-3.5 inline mr-1" />,
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