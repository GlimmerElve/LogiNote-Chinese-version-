import React, { useState } from "react";
import { NoteItem, AiSegmentResponse, LogicSegment } from "../types";
import { requestAiLogicSegmentation } from "../services/aiService";
import { callLLM } from "../services/llmService";
import { resolveNoteByTitleOrAlias } from "../services/noteResolver";
import {
  Sparkles,
  X,
  CheckCircle,
  Link2,
  Calendar,
  Layers,
  ArrowRight,
  Loader2,
  Clock,
  BookOpen,
  ToggleLeft,
  ToggleRight,
  Mic,
  CheckSquare,
  Square,
  ListChecks,
} from "lucide-react";

interface AiSegmentModalProps {
  note: NoteItem | null;
  allNotes: NoteItem[];
  isOpen: boolean;
  onClose: () => void;
  onApplySegmentation: (
    updatedNote: NoteItem,
    extractedTasks: Array<{ taskText: string; dueDate: string; priority: "high" | "medium" | "low" }>
  ) => void;
  /** 更新目标笔记（把原文术语写入其 aliases） */
  onUpdateNote?: (updated: NoteItem) => void;
}

export const AiSegmentModal: React.FC<AiSegmentModalProps> = ({
  note,
  allNotes,
  isOpen,
  onClose,
  onApplySegmentation,
  onUpdateNote,
}) => {
  if (!isOpen || !note) return null;

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiSegmentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usePolished, setUsePolished] = useState(true);
  const [selectedWikiLinks, setSelectedWikiLinks] = useState<Set<number>>(new Set());
  const [selectedExtensions, setSelectedExtensions] = useState<Set<number>>(new Set());
  const [selectedStudyPlans, setSelectedStudyPlans] = useState<Set<number>>(new Set());

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<number>>>, idx: number) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const selectAll = (setter: React.Dispatch<React.SetStateAction<Set<number>>>, count: number) => {
    setter(new Set(Array.from({ length: count }, (_, i) => i)));
  };

  const clearAll = (setter: React.Dispatch<React.SetStateAction<Set<number>>>) => {
    setter(new Set());
  };

  const handleRunAiSegment = async () => {
    setLoading(true);
    setError(null);
    try {
      const existingTitles = allNotes
        .filter((n) => n.noteType === 'knowledge')
        .map((n) => n.title);

      // 剥离开头任务块，只把正文喂给 AI，避免 polishedText 里混入任务列表造成重复
      const { body } = splitLeadingTaskBlock(note.content);
      const segmentText = body || note.content;

      // First try callLLM() with the text-segmentation workflow
      let res: AiSegmentResponse | null = null;
      try {
        const response = await callLLM({
          providerId: '',
          model: '',
          workflow: 'text-segmentation',
          userInput: segmentText,
          context: {
            noteTitle: note.title,
            existingNotes: existingTitles.join(', '),
          },
        });

        const parsed = response.parsedJson;
        if (parsed && typeof parsed === 'object') {
          // Transform parsed JSON to AiSegmentResponse format
          res = {
            summary: parsed.summary || '',
            overallStructure: parsed.overallStructure || '',
            segments: Array.isArray(parsed.segments)
              ? parsed.segments.map((seg: any, idx: number) => ({
                  id: seg.id || `seg-${idx}`,
                  type: seg.type || 'concept',
                  title: seg.title || '',
                  content: seg.content || '',
                  confidence: typeof seg.confidence === 'number' ? seg.confidence : 0.8,
                  suggestedWikiLink: seg.suggestedWikiLink,
                  extractedDate: seg.extractedDate,
                }))
              : [],
            suggestedWikiLinks: Array.isArray(parsed.suggestedWikiLinks) ? parsed.suggestedWikiLinks : [],
            extractedStudyPlans: Array.isArray(parsed.extractedStudyPlans) ? parsed.extractedStudyPlans : [],
            polishedText: parsed.polishedText || '',
            extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [],
          };
          // Auto-detect if polished text exists and enable toggle
          if (parsed.polishedText && parsed.polishedText.trim()) {
            setUsePolished(true);
          }
        }
      } catch (llmError: any) {
        console.warn('callLLM failed for text-segmentation, falling back to server endpoint:', llmError.message);
      }

      // Fallback: use server-side /api/ai/segment if callLLM didn't produce valid result
      if (!res) {
        res = await requestAiLogicSegmentation(segmentText, note.title, existingTitles);
      }

      setResult(res);
    } catch (err: any) {
      setError(err.message || "逻辑分词请求失败");
    } finally {
      setLoading(false);
    }
  };

  /** 从文本开头读取连续的任务列表块（受保护区域，禁止被替换/重构） */
  const splitLeadingTaskBlock = (content: string): { block: string; body: string } => {
    const lines = content.split("\n");
    let lastIdx = -1;
    let sawTask = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^[-*]\s*\[[ xX]\]\s*/.test(t)) {
        lastIdx = i;
        sawTask = true;
      } else if (t === "") {
        // 空行容忍，继续
        continue;
      } else {
        break;
      }
    }
    if (!sawTask) return { block: "", body: content };
    const blockLines = lines.slice(0, lastIdx + 1);
    const bodyLines = lines.slice(lastIdx + 1);
    return { block: blockLines.join("\n"), body: bodyLines.join("\n") };
  };

  /** 把原文术语写入目标笔记的 aliases（以「；」分隔） */
  const addAliasToNote = (target: NoteItem, alias: string) => {
    if (!onUpdateNote) return;
    const existing = target.aliases || [];
    if (existing.includes(alias)) return;
    onUpdateNote({
      ...target,
      aliases: [...existing, alias],
      updatedAt: new Date().toISOString(),
    });
  };

  const handleApplyToNote = () => {
    if (!result) return;

    // 1) 保护开头任务块：只在 body 上做改写
    const originalText = note.content;
    const { block, body } = splitLeadingTaskBlock(originalText);

    // 2) 决定 body 基底：是否使用 polished（polished 不含任务块，只在 body 上用）
    let finalBody = usePolished && result.polishedText ? result.polishedText : body;

    // 3) 应用用户勾选的 wiki 关联：把原文术语回写为 [[原文术语]]，并把术语补进目标笔记别名
    if (result.suggestedWikiLinks && result.suggestedWikiLinks.length > 0) {
      result.suggestedWikiLinks.forEach((link, idx) => {
        if (!selectedWikiLinks.has(idx)) return;
        const existing = resolveNoteByTitleOrAlias(link.linkedTitle, allNotes);
        if (existing) {
          addAliasToNote(existing, link.originalTerm);
        }
        const regex = new RegExp(`(?<!\\[\\[)${link.originalTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\]\\])`, "g");
        finalBody = finalBody.replace(regex, `[[${link.originalTerm}]]`);
      });
    }

    // 4) 追加勾选的逻辑扩展
    const checkedExtensions = (result.extensions || []).filter((_, idx) => selectedExtensions.has(idx));
    if (checkedExtensions.length > 0) {
      finalBody += `\n\n---\n## AI 逻辑扩展建议\n\n`;
      checkedExtensions.forEach((ext) => {
        const labelMap: Record<string, string> = {
          concept: '概念',
          definition: '定义',
          logic_flow: '逻辑推导',
          example: '例证',
          supplement: '补充',
        };
        const label = labelMap[ext.type] || ext.type;
        finalBody += `### [${label}] ${ext.title}\n${ext.content}\n\n`;
      });
    }

    // 5) 追加总结
    if (result.summary) {
      finalBody += `\n\n---\n## AI 智能逻辑总结\n> ${result.summary}\n\n`;
    }

    // 6) 勾选的时序计划追加到受保护任务块（格式 - [ ] 任务，无时间不补充）
    const checkedPlans = (result.extractedStudyPlans || []).filter((_, idx) => selectedStudyPlans.has(idx));
    let finalBlock = block;
    if (checkedPlans.length > 0) {
      const planLines = checkedPlans.map((p) => `- [ ] ${p.taskText.trim()}`).join("\n");
      finalBlock = finalBlock ? `${finalBlock}\n${planLines}` : planLines;
    }

    const finalContent = finalBlock
      ? `${finalBlock}\n\n${finalBody}`
      : finalBody;

    const updatedNote: NoteItem = {
      ...note,
      content: finalContent,
      aiAnalyzedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    onApplySegmentation(updatedNote, result.extractedStudyPlans || []);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/50">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-indigo-600 text-white">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                智能长文本逻辑分词与划词建链
              </h2>
              <p className="text-[11px] text-slate-500">
                语音文本三段论重构 · 逻辑扩展建议 · 可选建链 · 时序学习计划
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4 text-xs">
          {!result && !loading && (
            <div className="text-center py-10 space-y-3">
              <BookOpen className="w-12 h-12 text-blue-500 mx-auto opacity-30" />
              <p className="text-slate-600 dark:text-slate-300 font-medium">
                即将对笔记 《{note.title}》 进行长文本逻辑结构切片与建链推荐
              </p>
              <p className="text-[11px] text-slate-400">若检测到语音转文字的重复/口语化文本，AI 将自动整理为结构化笔记</p>
              <button
                onClick={handleRunAiSegment}
                className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white font-semibold text-xs hover:bg-indigo-700 transition flex items-center gap-2 mx-auto"
              >
                <Sparkles className="w-4 h-4" />
                <span>开始 AI 逻辑分词</span>
              </button>
            </div>
          )}

          {loading && (
            <div className="text-center py-12 space-y-3">
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto" />
              <p className="text-slate-600 dark:text-slate-300 font-medium">
                正在深度拆解语法句法、构建概念逻辑链条...
              </p>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-xl text-red-600 text-xs">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-4">
              {/* Polished Text (voice-to-text cleanup result) */}
              {result.polishedText && (
                <div className="p-3.5 bg-emerald-50/80 dark:bg-emerald-950/30 rounded-xl border border-emerald-200/60 dark:border-emerald-800/60">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                      <Mic className="w-3.5 h-3.5 text-emerald-600" />
                      AI 已整理语音文本
                    </h3>
                    <button
                      onClick={() => setUsePolished(!usePolished)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition ${
                        usePolished
                          ? 'bg-emerald-200 dark:bg-emerald-800 text-emerald-800 dark:text-emerald-200'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-500'
                      }`}
                    >
                      {usePolished ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                      使用整理文本
                    </button>
                  </div>
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mb-2">
                    检测到语音转文字特征（口语填充词/重复表述），AI 已重构为结构化笔记。{usePolished ? '将替换原文。' : '可切换为保留原文。'}
                  </p>
                  {usePolished && (
                    <div className="p-3 bg-white dark:bg-slate-800 rounded-xl border border-emerald-100 dark:border-emerald-700 max-h-48 overflow-y-auto">
                      <div className="prose prose-slate dark:prose-invert prose-sm max-w-none text-[11px] leading-relaxed whitespace-pre-wrap">
                        {result.polishedText}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Summary Card */}
              <div className="p-3.5 bg-blue-50/80 dark:bg-blue-950/40 rounded-xl border border-blue-200/60 dark:border-blue-800/60">
                <h3 className="font-bold text-blue-900 dark:text-blue-300 mb-1 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-blue-600" />
                  长文本逻辑结构简述
                </h3>
                <p className="text-slate-700 dark:text-slate-300 leading-relaxed">{result.summary}</p>
                <div className="mt-2 text-[10px] text-blue-600 dark:text-blue-400 font-medium">
                  {result.overallStructure}
                </div>
              </div>

              {/* Extracted Wiki Links (selectable) */}
              {result.suggestedWikiLinks && result.suggestedWikiLinks.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5 text-indigo-500" />
                      建议建立的双向链接 ([[WikiLinks]])
                    </h4>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => selectAll(setSelectedWikiLinks, result.suggestedWikiLinks!.length)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition"
                      >
                        全选
                      </button>
                      <button
                        onClick={() => clearAll(setSelectedWikiLinks)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {result.suggestedWikiLinks.map((link, idx) => {
                      const checked = selectedWikiLinks.has(idx);
                      return (
                        <button
                          key={idx}
                          onClick={() => toggleSet(setSelectedWikiLinks, idx)}
                          className={`text-left p-2 rounded-xl border transition ${
                            checked
                              ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-700'
                              : 'bg-slate-50 dark:bg-slate-800/80 border-slate-200/60 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {checked ? (
                              <CheckSquare className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                            )}
                            <div className="font-bold text-indigo-600 dark:text-indigo-400">
                              {link.originalTerm} → [[{link.linkedTitle}]]
                            </div>
                          </div>
                          <p className="text-[10px] text-slate-500 mt-1 ml-6">{link.reason}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Logic Extensions (selectable) */}
              {result.extensions && result.extensions.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <ListChecks className="w-3.5 h-3.5 text-emerald-500" />
                      逻辑扩展建议
                    </h4>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => selectAll(setSelectedExtensions, result.extensions!.length)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition"
                      >
                        全选
                      </button>
                      <button
                        onClick={() => clearAll(setSelectedExtensions)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {result.extensions.map((ext, idx) => {
                      const checked = selectedExtensions.has(idx);
                      const labelMap: Record<string, string> = {
                        concept: '概念',
                        definition: '定义',
                        logic_flow: '逻辑推导',
                        example: '例证',
                        supplement: '补充',
                      };
                      return (
                        <button
                          key={idx}
                          onClick={() => toggleSet(setSelectedExtensions, idx)}
                          className={`w-full text-left p-2.5 rounded-xl border transition ${
                            checked
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700'
                              : 'bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {checked ? (
                              <CheckSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                            )}
                            <div className="flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">
                                  {labelMap[ext.type] || ext.type}
                                </span>
                                <span className="font-bold text-slate-900 dark:text-slate-100">{ext.title}</span>
                              </div>
                              <p className="text-slate-600 dark:text-slate-300 leading-relaxed mt-1">{ext.content}</p>
                              {ext.reason && <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1">{ext.reason}</p>}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Extracted Study Plans (selectable) */}
              {result.extractedStudyPlans && result.extractedStudyPlans.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-amber-500" />
                      提取的时序学习计划
                    </h4>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => selectAll(setSelectedStudyPlans, result.extractedStudyPlans!.length)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition"
                      >
                        全选
                      </button>
                      <button
                        onClick={() => clearAll(setSelectedStudyPlans)}
                        className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {result.extractedStudyPlans.map((plan, idx) => {
                      const checked = selectedStudyPlans.has(idx);
                      return (
                        <button
                          key={idx}
                          onClick={() => toggleSet(setSelectedStudyPlans, idx)}
                          className={`w-full p-2 rounded-xl border flex items-center justify-between text-left transition ${
                            checked
                              ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700'
                              : 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200/40 dark:border-amber-800/30 hover:bg-amber-100/60 dark:hover:bg-amber-900/40'
                          }`}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {checked ? (
                              <CheckSquare className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-400 shrink-0" />
                            )}
                            <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{plan.taskText}</span>
                          </span>
                          {plan.dueDate && (
                            <span className="px-2 py-0.5 rounded bg-amber-200/80 dark:bg-amber-900 text-amber-800 dark:text-amber-200 font-mono text-[10px] shrink-0 ml-2">
                              @due({plan.dueDate})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {result && (
          <div className="p-3 border-t border-slate-200/80 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition"
            >
              取消
            </button>
            <button
              onClick={handleApplyToNote}
              className="px-4 py-1.5 text-xs font-semibold rounded-xl bg-blue-600 text-white shadow-md hover:bg-blue-700 transition flex items-center gap-1.5"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              应用所选内容到笔记
            </button>
          </div>
        )}
      </div>
    </div>
  );
};