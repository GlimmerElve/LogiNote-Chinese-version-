import React, { useState, useEffect, useRef } from 'react';
import { NoteItem, ReviewBubbleCard } from '../types';
import { buildReviewQueue } from '../services/reviewScheduler';
import { callLLM } from '../services/llmService';
import { Sparkles, Loader2 } from 'lucide-react';

interface ReviewBubbleWallProps {
  allNotes: NoteItem[];
  onBubbleClick: (noteId: string, noteTitle: string, questionText: string, knowledgeContext: string) => void;
}

export const ReviewBubbleWall: React.FC<ReviewBubbleWallProps> = ({ allNotes, onBubbleClick }) => {
  const [bubbles, setBubbles] = useState<ReviewBubbleCard[]>([]);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const debounceRef = useRef(false);

  const refreshQueue = async () => {
    if (debounceRef.current) return;
    debounceRef.current = true;

    // 1. 立即生成卡片并渲染（用默认问题兜底，不阻塞 UI）
    const queue = buildReviewQueue(allNotes);
    queue.forEach(c => {
      if (!c.questionText) c.questionText = `请描述你对"${c.noteTitle}"的理解`;
    });
    setBubbles(queue);

    // 2. 后台异步请求 AI 增强问题（失败则保持默认问题不变）
    if (queue.length > 0) {
      setIsEnhancing(true);
      try {
        const titles = queue.map(c => c.noteTitle).join('\n- ');
        const prompt = `以下是我需要复习的知识点列表：\n- ${titles}\n\n请为每个知识点生成一个苏格拉底式开场问题。要求：\n1. 问题应引导主动思考和深层理解，而非简单回忆\n2. 不直接暴露知识点头衔\n3. 保持开放性和探索性\n\n用数组格式输出 JSON：\n[{ "question": "...", "knowledgeContext": "知识点标题" }, ...]，顺序与输入一致。`;
        const resp = await callLLM({
          providerId: '', model: '',
          workflow: 'review-bubble',
          userInput: prompt,
        });
        const parsed = resp.parsedJson || JSON.parse(resp.content);
        if (Array.isArray(parsed)) {
          setBubbles(prev => prev.map((b, i) => {
            if (i < parsed.length && parsed[i]?.question) {
              return {
                ...b,
                questionText: parsed[i].question,
                knowledgeContext: parsed[i].knowledgeContext || b.noteTitle,
              };
            }
            return b;
          }));
        }
      } catch {
        // AI 不可用或失败时保持默认问题，静默处理
      } finally {
        setIsEnhancing(false);
        setTimeout(() => { debounceRef.current = false; }, 15000);
      }
    } else {
      setTimeout(() => { debounceRef.current = false; }, 15000);
    }
  };

  useEffect(() => {
    refreshQueue();
    const timer = setInterval(refreshQueue, 30000);
    return () => clearInterval(timer);
  }, [allNotes]);

  const getForgetEmoji = (score: number) => {
    if (score > 0.7) return '#ef4444';
    if (score > 0.4) return '#f97316';
    return '#22c55e';
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-500" />
          灵光乍现 · 知识气泡
        </h3>
        {isEnhancing && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
      </div>
      <p className="text-xs text-slate-500 mb-4">以下知识点可能已被遗忘，点击气泡开始复习</p>
      <div className="grid grid-cols-3 gap-3">
        {bubbles.map(bubble => (
          <button
            key={bubble.noteId}
            onClick={() => onBubbleClick(bubble.noteId, bubble.noteTitle, bubble.questionText || `请描述你对"${bubble.noteTitle}"的理解`, bubble.knowledgeContext || bubble.noteTitle)}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-4 text-left hover:border-indigo-400 dark:hover:border-indigo-600 hover:shadow-lg transition-all cursor-pointer"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-lg">{getForgetEmoji(bubble.forgetScore)}</span>
              <span className="text-[10px] text-slate-400">遗忘分 {Math.round(bubble.forgetScore * 100)}%</span>
            </div>
            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-3">
              {bubble.questionText || `请描述你对"${bubble.noteTitle}"的理解`}
            </p>
          </button>
        ))}
      </div>
      {bubbles.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <p className="text-sm">暂无需要复习的知识点</p>
        </div>
      )}
    </div>
  );
};