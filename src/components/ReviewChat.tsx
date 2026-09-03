import React, { useState, useRef, useEffect, useMemo } from 'react';
import { NoteItem, ChatMessage, ReviewMessage, ReviewAnalysis, KnowledgePointMasteryResult } from '../types';
import { callLLMStream } from '../services/llmStreamService';
import { useSpeechRecognition } from '../services/speechRecognition';
import { parseIntentMarker, parseJsonLenient, ReviewSegment, scoreReviewSegmentsInParallel, mergeSegmentResults } from '../services/reviewSegmentScoring';
import { scoreConceptEvidence, scoreJudgmentEvidence, scoreReasoningEvidence, determineMasteryLevel, computeLayeredMastery } from '../services/profile/scoring/threeLayer';
import { recordReviewActivity } from '../services/learningAbility/timelineStore';
import { Sparkles, Loader2, Send, AlertTriangle, Check, X, Mic, MicOff, Brain, ChevronDown, ChevronUp, Square, MessageCircle } from 'lucide-react';

interface ReviewChatProps {
  noteId: string;
  noteTitle: string;
  questionText: string;
  knowledgeContext: string;
  allNotes: NoteItem[];
  onReviewComplete: (analysis: ReviewAnalysis | null, segmentMastery?: KnowledgePointMasteryResult[]) => void;
}

const MASTERY_LEVEL_LABEL: Record<string, string> = {
  concept: '概念层',
  judgment: '判断层',
  reasoning: '推理层',
};

export const ReviewChat: React.FC<ReviewChatProps> = ({ noteId, noteTitle, questionText, knowledgeContext, allNotes, onReviewComplete }) => {
  const [messages, setMessages] = useState<ReviewMessage[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isTutorResponding, setIsTutorResponding] = useState(false);
  const [isScoring, setIsScoring] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [finalAnalysis, setFinalAnalysis] = useState<ReviewAnalysis | null>(null);
  const [segmentMasteryResults, setSegmentMasteryResults] = useState<KnowledgePointMasteryResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showReasoning, setShowReasoning] = useState(true);
  const [reasoningContent, setReasoningContent] = useState('');
  const { isListening, modelReady, warmup, startListening, stopListening } = useSpeechRecognition();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const didInitRef = useRef(false);
  const isProjectReview = useMemo(() => allNotes.some(n => n.id === noteId && n.noteType === 'project'), [allNotes, noteId]);
  // 片段列表：按「提问意图」切段，每个片段记录目标知识点 + 学生回答原文
  const segmentsRef = useRef<ReviewSegment[]>([]);
  // 上一个提问的意图（初始化提问无意图，初值 []）
  const lastIntentRef = useRef<string[]>([]);
  // 暂存「无意图归属」的第一轮回答（初始化提问后的首答）
  const pendingAnswerRef = useRef('');

  const sameIntentSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((t) => b.includes(t));

  /** 把学生回答并入「目标知识点集合」对应的片段；不存在则新建 */
  const appendToSegment = (targets: string[], answer: string) => {
    const list = segmentsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      if (sameIntentSet(list[i].knowledgePointNames, targets)) {
        list[i] = { ...list[i], text: list[i].text ? `${list[i].text}\n${answer}` : answer };
        return;
      }
    }
    list.push({ knowledgePointNames: [...targets], text: answer });
  };

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Start session on mount — send initial Socratic opening
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    const opener: ReviewMessage = {
      id: 'tutor-0',
      role: 'tutor',
      content: questionText,
      timestamp: new Date().toISOString(),
    };
    setMessages([opener]);
  }, [questionText]);

  // 进入复习页面即预加载语音模型（后台静默，不阻塞打字）
  useEffect(() => {
    warmup();
  }, [warmup]);

  const handleVoiceToggle = async () => {
    if (isListening) {
      // final 现为空信号，正文已由 partial 逐句写入，无需再取返回值
      await stopListening();
    } else if (modelReady) {
      // 每说一句（停顿）就把这句话追加到输入框
      startListening((text) => setUserInput(p => p + text));
    }
  };

  const handleSendMessage = async () => {
    const text = userInput.trim();
    if (!text || isTutorResponding || isScoring || sessionEnded) return;

    // Add user message
    const userMsg: ReviewMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setUserInput('');
    setIsTutorResponding(true);
    setError(null);
    setReasoningContent('');

    try {
      // Build prompt: knowledge context + full dialogue history
      const historyText = updatedMessages.map(m =>
        `${m.role === 'tutor' ? '导师' : '学生'}: ${m.content}`
      ).join('\n');

      const prompt = `知识点：${knowledgeContext}（所属笔记：${noteTitle}）\n\n对话历史：\n${historyText}\n\n请根据学生的最新回答，提出下一个苏格拉底式追问。`;

      const stream = await callLLMStream({
        providerId: '',
        model: '',
        workflow: 'review-tutor',
        userInput: prompt,
      });

      const reader = stream.getReader();
      let fullContent = '';
      let fullReasoning = '';

      // Create placeholder for streaming tutor response
      const tutorId = `tutor-${Date.now()}`;
      const placeholder: ReviewMessage = {
        id: tutorId,
        role: 'tutor',
        content: '',
        timestamp: new Date().toISOString(),
        isStreaming: true,
      };

      setMessages(prev => [...prev, placeholder]);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === 'reasoning') {
            fullReasoning += value.text;
            setReasoningContent(fullReasoning);
          } else {
            fullContent += value.text;
            // Update the streaming message in-place
            setMessages(prev => prev.map(m =>
              m.id === tutorId
                ? { ...m, content: fullContent, isStreaming: true }
                : m
            ));
          }
        }
      } finally {
        reader.releaseLock();
      }

      // 项目复习：解析并剥离意图标记，更新片段缓冲
      let displayContent = fullContent;
      if (isProjectReview) {
        const { targets, cleanText } = parseIntentMarker(fullContent);
        displayContent = cleanText;

        const studentAnswer = text;

        // 先把「本轮回答」按「上一个提问的意图」归段；
        // 若上一个是初始化提问（无意图），暂存到 pendingAnswerRef，待本轮 tutor 意图出来后一并归入。
        if (lastIntentRef.current.length > 0) {
          appendToSegment(lastIntentRef.current, studentAnswer);
        } else {
          pendingAnswerRef.current = pendingAnswerRef.current
            ? `${pendingAnswerRef.current}\n${studentAnswer}`
            : studentAnswer;
        }

        // tutor 本轮追问的意图出来后：
        // 1) 若上一提问无意图（第一轮），把暂存的首答并入本轮意图，实现「首答与次答共用意图」；
        // 2) 更新 lastIntentRef 供下一轮使用。
        if (targets.length > 0) {
          if (pendingAnswerRef.current) {
            appendToSegment(targets, pendingAnswerRef.current);
            pendingAnswerRef.current = '';
          }
          lastIntentRef.current = targets;
        }
        // targets 为空（纯澄清/未标记）时保持 lastIntentRef 不变，下一轮回答仍归上一有效意图。
      }

      // Mark as no longer streaming
      setMessages(prev => prev.map(m =>
        m.id === tutorId
          ? { ...m, content: displayContent, isStreaming: false }
          : m
      ));
      setReasoningContent('');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err?.message || '导师回复失败');
    } finally {
      setIsTutorResponding(false);
    }
  };

  const handleEndSession = async () => {
    if (isScoring || sessionEnded || messages.length < 2) return;
    setIsScoring(true);
    setError(null);
    setReasoningContent('');

    try {
      // 项目复习：先收尾遗留的暂存回答（若有），再做分段评分（各知识点掌握度）
      if (isProjectReview) {
        if (pendingAnswerRef.current && lastIntentRef.current.length > 0) {
          appendToSegment(lastIntentRef.current, pendingAnswerRef.current);
          pendingAnswerRef.current = '';
        }
        if (segmentsRef.current.length > 0) {
          try {
            const segResults = await scoreReviewSegmentsInParallel(segmentsRef.current);
            setSegmentMasteryResults(mergeSegmentResults(segResults));
          } catch (e) {
            console.warn('[Review] 分段评分失败:', e);
            setSegmentMasteryResults([]);
          }
        }
      }

      // 整段评分（review-scoring）：四维分 + 评级
      const historyText = messages.map(m =>
        `${m.role === 'tutor' ? '导师' : '学生'}: ${m.content}`
      ).join('\n');

      const prompt = `知识点：${knowledgeContext}\n所属笔记：${noteTitle}\n\n完整对话历史：\n${historyText}\n\n请基于以上完整对话，评估学生的掌握程度并输出 JSON 评分。`;

      const stream = await callLLMStream({
        providerId: '',
        model: '',
        workflow: 'review-scoring',
        userInput: prompt,
      });

      const reader = stream.getReader();
      let fullContent = '';
      let fullReasoning = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value.type === 'reasoning') {
            fullReasoning += value.text;
            setReasoningContent(fullReasoning);
          } else {
            fullContent += value.text;
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Parse JSON from streamed response（容错解析 + 失败时暴露原始返回）
      try {
        const parsed: ReviewAnalysis = parseJsonLenient(fullContent) as ReviewAnalysis;
        setFinalAnalysis(parsed);
        setSessionEnded(true);
      } catch {
        console.warn('[Review] 评分解析失败，原始返回:', fullContent);
        setError('评分结果解析失败，请重试');
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err?.message || '评分请求失败');
    } finally {
      setIsScoring(false);
    }
  };

  const handleFinishReview = () => {
    // 复习达标判定：回答次数 ≥5 轮 或 回答字数 ≥150 字，则记一次有效复习（计入当天学习日）
    const userMessages = messages.filter((m) => m.role === 'user');
    const answerCount = userMessages.length;
    const answerChars = userMessages.reduce((sum, m) => sum + m.content.length, 0);
    if (answerCount >= 5 || answerChars >= 150) {
      recordReviewActivity().catch(() => {});
    }

    if (isProjectReview) {
      onReviewComplete(finalAnalysis, segmentMasteryResults);
    } else {
      onReviewComplete(finalAnalysis);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const canEnd = messages.filter(m => m.role === 'user').length >= 1 && !sessionEnded && !isTutorResponding;

  // 气泡复习：由 finalAnalysis.masteryEvidence 折算出三层掌握度（仅展示，不展示更新后的 conceptMastery）
  const bubbleMastery = finalAnalysis?.masteryEvidence;
  const bubbleConceptDelta = scoreConceptEvidence(bubbleMastery?.conceptEvidence);
  const bubbleJudgmentDelta = scoreJudgmentEvidence(bubbleMastery?.judgmentEvidence);
  const bubbleReasoningDelta = scoreReasoningEvidence(bubbleMastery?.reasoningEvidence);
  const bubbleLevel = determineMasteryLevel(bubbleReasoningDelta, bubbleJudgmentDelta);
  const bubbleLayered = computeLayeredMastery(bubbleConceptDelta, bubbleJudgmentDelta, bubbleReasoningDelta, 50);

  return (
    <div className="flex flex-col h-full bg-[#0f172a]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-bold text-slate-100">苏格拉底式复习对话</h3>
          <span className="text-[10px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded">
            {messages.filter(m => m.role === 'user').length} 轮对话
          </span>
        </div>
        <button
          onClick={() => (isProjectReview ? onReviewComplete(null, []) : onReviewComplete(null))}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          title="退出复习"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Chat messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-md'
                  : 'bg-slate-800 border border-slate-700 text-slate-200 rounded-bl-md'
              }`}
            >
              {msg.role === 'tutor' && (
                <div className="flex items-center gap-1.5 mb-1">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span className="text-[10px] font-bold text-amber-400">苏格拉底导师</span>
                  {msg.isStreaming && (
                    <span className="flex gap-0.5 ml-1">
                      {[1, 2, 3].map(i => (
                        <span
                          key={i}
                          className="w-1 h-1 bg-amber-400 rounded-full animate-bounce"
                          style={{ animationDelay: `${i * 0.15}s` }}
                        />
                      ))}
                    </span>
                  )}
                </div>
              )}
              <p className={`text-sm leading-relaxed whitespace-pre-wrap ${msg.isStreaming ? 'opacity-70' : ''}`}>
                {msg.content || (msg.isStreaming ? '思考中...' : '')}
              </p>
            </div>
          </div>
        ))}

        {/* Reasoning display during streaming */}
        {isTutorResponding && reasoningContent && (
          <div className="flex justify-start">
            <div className="max-w-[80%] bg-amber-950/20 border border-amber-800/40 rounded-xl overflow-hidden">
              <button
                onClick={() => setShowReasoning(!showReasoning)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold text-amber-400 hover:bg-amber-950/30 transition"
              >
                <span className="flex items-center gap-1.5"><Brain className="w-3 h-3" />思考过程</span>
                {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {showReasoning && (
                <div className="px-3 pb-2 text-[10px] text-amber-300/70 leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
                  {reasoningContent}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Scoring indicator */}
        {isScoring && (
          <div className="flex justify-center">
            <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
              <span className="text-xs text-slate-400">正在评估对话...</span>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="flex justify-center">
            <div className="px-4 py-2 rounded-xl bg-red-950/30 border border-red-800 text-xs text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5" />{error}
            </div>
          </div>
        )}

        {/* Final analysis display */}
        {sessionEnded && (
          <div className="flex justify-center">
            <div className="w-full bg-slate-800/80 border border-indigo-800/50 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold text-slate-200">复习评估完成</span>
              </div>

              {/* 项目复习：多知识点列表 + 各知识点三层掌握度 */}
              {isProjectReview && segmentMasteryResults.length > 0 && (
                <div className="space-y-2">
                  <span className="text-[10px] font-bold text-slate-400">知识点掌握度分析</span>
                  {segmentMasteryResults.map(r => (
                    <div key={`${r.name}-${r.level}`} className="bg-slate-900/60 rounded-xl p-3 border border-slate-700">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200">{r.name}</span>
                        <span className="text-[10px] text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded">
                          {MASTERY_LEVEL_LABEL[r.level] || r.level}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{r.conceptFinal ?? r.conceptDelta}</div>
                          <div className="text-[9px] text-slate-500">概念</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{r.judgmentFinal ?? r.judgmentDelta}</div>
                          <div className="text-[9px] text-slate-500">判断</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{r.reasoningFinal ?? r.reasoningDelta}</div>
                          <div className="text-[9px] text-slate-500">推理</div>
                        </div>
                      </div>
                      {r.comment && <p className="text-[10px] text-slate-400 mt-1.5">{r.comment}</p>}
                    </div>
                  ))}
                </div>
              )}

              {/* 整段四维分 + 评级（项目复习与气泡复习都展示） */}
              {finalAnalysis && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { label: '准确度', score: finalAnalysis.accuracyScore },
                      { label: '完整性', score: finalAnalysis.completenessScore },
                      { label: '逻辑深度', score: finalAnalysis.logicScore },
                      { label: '关联性', score: finalAnalysis.relevanceScore },
                    ].map(item => (
                      <div key={item.label} className="bg-slate-900/60 rounded-xl p-3 text-center">
                        <div className="text-lg font-black text-indigo-400">{item.score}</div>
                        <div className="text-[10px] text-slate-500">{item.label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="px-3 py-2 rounded-xl bg-indigo-950/30 border border-indigo-800">
                    <span className="text-xs font-bold text-indigo-300">
                      综合评级：{
                        finalAnalysis.overallRating === 'again' ? '需要重学' :
                        finalAnalysis.overallRating === 'hard' ? '还需加强' :
                        finalAnalysis.overallRating === 'good' ? '掌握良好 ✅' :
                        '熟练掌握 ⭐'
                      }
                    </span>
                  </div>
                  {finalAnalysis.feedback && (
                    <div className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700">
                      <span className="text-[10px] font-bold text-slate-400">反馈</span>
                      <p className="text-xs text-slate-300 mt-1">{finalAnalysis.feedback}</p>
                    </div>
                  )}
                  {finalAnalysis.suggestion && (
                    <div className="px-3 py-2 rounded-xl bg-emerald-950/30 border border-emerald-800">
                      <span className="text-[10px] font-bold text-emerald-400">建议</span>
                      <p className="text-xs text-emerald-300 mt-1">{finalAnalysis.suggestion}</p>
                    </div>
                  )}
                  {finalAnalysis.missingKnowledge.length > 0 && (
                    <div className="px-3 py-2 rounded-xl bg-amber-950/20 border border-amber-800/40">
                      <span className="text-[10px] font-bold text-amber-400">遗漏的知识点</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {finalAnalysis.missingKnowledge.map((k, i) => (
                          <span key={i} className="text-[10px] text-amber-300/80 bg-amber-950/30 px-2 py-0.5 rounded">
                            {k}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 气泡复习：三层掌握度分析（由 masteryEvidence 折算，仅展示） */}
                  {!isProjectReview && bubbleMastery && (
                    <div className="px-3 py-2 rounded-xl bg-slate-900/60 border border-slate-700 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-400">三层掌握度分析</span>
                        <span className="text-[10px] text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded">
                          触及层级：{MASTERY_LEVEL_LABEL[bubbleLevel]}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{bubbleLayered.conceptFinal}</div>
                          <div className="text-[9px] text-slate-500">概念得分</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{bubbleLayered.judgmentFinal}</div>
                          <div className="text-[9px] text-slate-500">判断得分</div>
                        </div>
                        <div className="bg-slate-800/60 rounded-lg py-1.5">
                          <div className="text-sm font-bold text-slate-200">{bubbleLayered.reasoningFinal}</div>
                          <div className="text-[9px] text-slate-500">推理得分</div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              <button
                onClick={handleFinishReview}
                className="w-full px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 flex items-center justify-center gap-2 transition"
              >
                <Check className="w-4 h-4" />完成复习
              </button>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom input bar */}
      {!sessionEnded && (
        <div className="px-6 py-4 border-t border-slate-800 shrink-0 space-y-3">
          <div className="flex gap-2 items-end">
            <button
              onClick={handleVoiceToggle}
              className={`px-3 py-2.5 rounded-xl text-sm font-bold transition flex items-center gap-1.5 shrink-0 ${
                isListening
                  ? 'bg-red-600 text-white'
                  : !modelReady
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
              disabled={isTutorResponding || !modelReady}
            >
              {isListening ? (
                <><MicOff className="w-4 h-4" />停止</>
              ) : modelReady ? (
                <><Mic className="w-4 h-4" />语音</>
              ) : (
                <><Loader2 className="w-4 h-4 animate-spin" />正在加载模型…</>
              )}
            </button>
            {isListening && (
              <div className="flex items-center gap-1 shrink-0">
                {[1, 2, 3, 4, 5].map(i => (
                  <div
                    key={i}
                    className="w-1 bg-indigo-400 rounded-full animate-pulse"
                    style={{ height: 8 + i * 4, animationDelay: `${i * 0.1}s` }}
                  />
                ))}
              </div>
            )}
            <textarea
              className="flex-1 p-2.5 text-sm bg-slate-800 border border-slate-700 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/30 text-slate-200 placeholder-slate-500"
              placeholder={isTutorResponding ? '导师正在思考...' : '输入你的回答...'}
              value={userInput}
              onChange={e => setUserInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isTutorResponding || isScoring}
              rows={1}
            />
            <button
              onClick={handleSendMessage}
              disabled={!userInput.trim() || isTutorResponding || isScoring}
              className="px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5 shrink-0 transition"
            >
              {isTutorResponding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              发送
            </button>
          </div>
          <button
            onClick={handleEndSession}
            disabled={!canEnd}
            className={`w-full px-4 py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition ${
              canEnd
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-slate-800 text-slate-600 cursor-not-allowed'
            }`}
          >
            <Square className="w-4 h-4" />
            {isScoring ? '正在评分...' : '结束复习并评分'}
          </button>
        </div>
      )}
    </div>
  );
};