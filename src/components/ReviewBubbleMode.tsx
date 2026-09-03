import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NoteItem, ReviewBubbleCard } from '../types';
import { buildReviewQueue, computeReviewWeight, weightedPick } from '../services/reviewScheduler';
import { ChevronLeft, Sparkles, Dices, Play } from 'lucide-react';
import FloatingLines from './FloatingLines';

interface ReviewBubbleModeProps {
  allNotes: NoteItem[];
  onBubbleClick: (noteId: string, noteTitle: string, questionText: string, knowledgeContext: string) => void;
  onExit: () => void;
}

type RollPhase = 'idle' | 'rolling' | 'settled';

const DEFAULT_EMOJI = '';

// 背景波浪线参数抽成模块级常量，保证每次渲染引用不变，
// 避免 FloatingLines 因数组引用变化而反复销毁重建 WebGL 画布（导致闪烁）
const BUBBLE_WAVES: Array<'top' | 'middle' | 'bottom'> = ['middle', 'bottom', 'top'];
const BUBBLE_LINE_COUNT = [5, 4, 3];
const BUBBLE_LINE_DISTANCE = [8, 6, 4];
const BUBBLE_LINE_GRADIENT = ['#8cd0b9'];

// 背景动画独立成岛：用 React.memo 隔离，props 全部是模块级常量，
// 前景每次换词重渲染时 React 直接跳过此组件，WebGL 画布保持连续、不被重建
const BubbleBackground = React.memo(() => (
  <FloatingLines
    enabledWaves={BUBBLE_WAVES}
    lineCount={BUBBLE_LINE_COUNT}
    lineDistance={BUBBLE_LINE_DISTANCE}
    bendRadius={5.0}
    bendStrength={-0.5}
    interactive={false}
    parallax={true}
    parallaxStrength={0.2}
    linesGradient={BUBBLE_LINE_GRADIENT}
    mixBlendMode="screen"
  />
));
BubbleBackground.displayName = 'BubbleBackground';

export const ReviewBubbleMode: React.FC<ReviewBubbleModeProps> = ({ allNotes, onBubbleClick, onExit }) => {
  const [cards, setCards] = useState<ReviewBubbleCard[]>([]);
  const [current, setCurrent] = useState<ReviewBubbleCard | null>(null);
  const [displayCard, setDisplayCard] = useState<ReviewBubbleCard | null>(null);
  const [phase, setPhase] = useState<RollPhase>('idle');
  const [isEmpty, setIsEmpty] = useState(false);

  const rollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBubbleClickRef = useRef(onBubbleClick);
  const cardsRef = useRef<ReviewBubbleCard[]>([]);

  useEffect(() => {
    onBubbleClickRef.current = onBubbleClick;
  }, [onBubbleClick]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  // 初始化：纯同步构建队列，仅 setCards 一次（不调 AI 批量生成问题）
  useEffect(() => {
    const built = buildReviewQueue(allNotes);
    cardsRef.current = built;
    setCards(built);
    setCurrent(null);
    setDisplayCard(null);
    setPhase('idle');
    setIsEmpty(built.length === 0);
  }, [allNotes]);

  useEffect(() => {
    return () => {
      if (rollTimerRef.current) clearTimeout(rollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onExit]);

  /** 加权随机抽选最终卡片：掌握度越低、遗忘分越高，越容易被抽中 */
  const pickCurrent = useCallback((): ReviewBubbleCard | null => {
    const pool = cardsRef.current;
    if (pool.length === 0) return null;
    const weights = pool.map(c => computeReviewWeight(c.forgetScore, c.conceptMastery));
    return weightedPick(pool, weights);
  }, []);

  const stopRoll = useCallback((finalCard: ReviewBubbleCard | null) => {
    setPhase('settled');
    setCurrent(finalCard);
    setDisplayCard(finalCard);
  }, []);

  const startRoll = useCallback(() => {
    const pool = cardsRef.current;
    if (pool.length === 0 || phase === 'rolling') return;

    const finalCard = pickCurrent();
    if (!finalCard) return;

    setPhase('rolling');
    setCurrent(null);

    if (rollTimerRef.current) clearTimeout(rollTimerRef.current);

    const MAX_ROUNDS = 24;
    let round = 0;
    let delay = 55;

    const tick = () => {
      const candidate = pool[Math.floor(Math.random() * pool.length)];
      setDisplayCard(candidate);
      round++;

      if (round >= MAX_ROUNDS) {
        // 定格到加权结果
        stopRoll(finalCard);
        return;
      }

      // 减速曲线：越往后间隔越长
      if (round > 8) delay = 90;
      if (round > 13) delay = 150;
      if (round > 18) delay = 240;
      if (round > 21) delay = 380;

      rollTimerRef.current = setTimeout(tick, delay);
    };

    rollTimerRef.current = setTimeout(tick, delay);
  }, [phase, pickCurrent, stopRoll]);

  const handleStartReview = () => {
    if (!current) return;
    onBubbleClickRef.current(
      current.noteId,
      current.noteTitle,
      `请描述你对"${current.noteTitle}"的理解`,
      current.noteTitle,
    );
  };

  const activeTitle = displayCard?.noteTitle || '';

  return (
    <div className="fixed inset-0 z-[200] bubble-mode-bg flex flex-col">
      {/* 背景波浪线：独立合成层，与前景 UI 互不干扰 */}
      <div className="absolute inset-0 z-0" style={{ willChange: 'transform', transform: 'translateZ(0)' }}>
        <BubbleBackground />
      </div>

      {/* 顶部栏 */}
      <div className="relative z-10 flex items-center gap-3 px-6 py-4 shrink-0">
        <button
          onClick={onExit}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-white/10 transition text-sm font-semibold"
        >
          <ChevronLeft className="w-4 h-4" /> 返回
        </button>
        <div className="flex items-center gap-2 text-white">
          <Sparkles className="w-4 h-4 text-amber-300" />
          <span className="text-sm font-bold">随题 · 复习抽取</span>
        </div>
      </div>

      {/* 中部毛玻璃卡片 */}
      <div className="relative z-10 flex-1 overflow-hidden flex items-center justify-center p-4">
        <div className="suiti-glass-card relative w-full max-w-xl text-center">
          <div className="text-[clamp(3rem,12vw,5rem)] leading-none mb-2 select-none">
            {DEFAULT_EMOJI}
          </div>

          <div className="suiti-topic-area">
            <h1 className="suiti-topic-title">
              {activeTitle || '等待抽取'}
            </h1>
          </div>

          {/* 底部操作区：抽取 + 开始复习 两个按钮 */}
          <div className="mt-8 flex flex-col items-center gap-3">
            <button
              onClick={startRoll}
              disabled={phase === 'rolling' || isEmpty}
              className="suiti-btn-primary flex items-center gap-2"
              style={{ background: 'linear-gradient(145deg, #00f0ff, #0098db)', color: '#0a1a2a' }}
            >
              <Dices className="w-5 h-5" />
              {phase === 'rolling' ? '抽取中…' : '随机抽取'}
            </button>

            <button
              onClick={handleStartReview}
              disabled={!current || phase === 'rolling'}
              className="suiti-btn-secondary flex items-center gap-2"
            >
              <Play className="w-5 h-5" />
              开始复习
            </button>
          </div>
        </div>

        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300">
            <p className="text-sm">暂无需要复习的知识点</p>
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="relative z-10 pb-5 text-center text-xs text-slate-400 shrink-0">
        掌握度越低、越久未复习的知识点，被抽中的概率越高
      </div>
    </div>
  );
};