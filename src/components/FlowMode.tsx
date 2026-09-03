import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { NoteItem, FlowSession, FlowSpeakingNote, WhiteNoiseType, FlowSettings, StudyQuestionCard, ResourceItem } from '../types';
import { Mic, MicOff, SkipForward, X, Pause, Play, Volume2, Plus, Trash2, Sparkles, ChevronDown, ChevronUp, ExternalLink, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { callLLM } from '../services/llmService';
import { startStt, stopStt, warmupStt } from '../services/sttClient';

/* === White Noise Generator (inlined) === */
function makeNoise(ctx: AudioContext, type: WhiteNoiseType): AudioNode {
  const out = ctx.createGain();
  out.gain.value = 0.4;
  const bs = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, bs, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bs; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(out);
  src.start();
  if (type === 'rain' || type === 'cafe' || type === 'stream' || type === 'campfire') {
    const f = ctx.createBiquadFilter();
    f.type = type === 'rain' ? 'highpass' : 'lowpass';
    f.frequency.value = type === 'rain' ? 2000 : type === 'stream' ? 800 : type === 'campfire' ? 600 : 400;
    out.disconnect();
    src.disconnect();
    src.connect(f);
    f.connect(out);
  }
  return out;
}

interface FlowModeProps {
  note: NoteItem;
  allNotes: NoteItem[];
  reviewIntervalMinutes: number;
  flowSettings: FlowSettings;
  onExit: (session: FlowSession) => void;
  /** 直接写入笔记内容（语音复盘去弹窗化） */
  onUpdateNote?: (updated: NoteItem) => void;
}

const NOISE_LABELS: Record<WhiteNoiseType, string> = {
  rain: '🌧️ 雨声',
  stream: '💧 溪流',
  'white-noise': '🌫️ 白噪音',
  campfire: '🔥 篝火',
  cafe: '☕ 咖啡馆',
  none: '🔇 无',
};

const NOISE_ICONS: Record<WhiteNoiseType, string> = {
  rain: '🌧️',
  stream: '💧',
  'white-noise': '🌫️',
  campfire: '🔥',
  cafe: '☕',
  none: '🔇',
};

export const FlowMode: React.FC<FlowModeProps> = ({ note, allNotes, reviewIntervalMinutes, flowSettings, onExit, onUpdateNote }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [speakingNotes, setSpeakingNotes] = useState<FlowSpeakingNote[]>([]);
  const [noiseType, setNoiseType] = useState<WhiteNoiseType>(flowSettings.whiteNoiseType);
  const [noiseVolume, setNoiseVolume] = useState(flowSettings.whiteNoiseVolume);

  // Review state — simplified: isReviewing only used for timer popup
  const [isReviewing, setIsReviewing] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<'idle' | 'listening' | 'detected' | 'converting'>('idle');
  /** 复述区可编辑正文（流式输出 + 就地编辑） */
  const [restateText, setRestateText] = useState(note.content || '');
  /** 退出时是否触发 AI 分析（默认开） */
  const [analyzeOnExit, setAnalyzeOnExit] = useState(true);

  /** Voice output target: restate (复述区) or summary (总结区) */
  const [activeVoiceTarget, setActiveVoiceTarget] = useState<'restate' | 'summary'>('restate');
  /** 总结区文本 */
  const [summary, setSummary] = useState(note.flowSummary || '');
  /** 提问区问题卡片 */
  const [questions, setQuestions] = useState<StudyQuestionCard[]>(note.questions || []);
  /** 新增问题输入 */
  const [newQuestion, setNewQuestion] = useState('');
  /** 展开答案的卡片 id 集合 */
  const [expandedAnswers, setExpandedAnswers] = useState<Set<string>>(new Set());
  /** 正在 AI 解答的卡片 id */
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  /** 打字输入草稿：总结区 */
  const [summaryDraft, setSummaryDraft] = useState('');
  /** 当前选中的资源（展开 webview 内嵌学习） */
  const [activeResource, setActiveResource] = useState<ResourceItem | null>(null);
  /** webview 区域高度（px），可拖拽调整 */
  const [webviewHeight, setWebviewHeight] = useState(480);
  /** 是否正在拖拽调整 webview 高度（用于覆盖遮罩拦截 webview 鼠标事件） */
  const [isResizing, setIsResizing] = useState(false);
  /** 是否折叠 webview 区域（折叠后复述区占满，展开恢复原高度） */
  const [isWebviewCollapsed, setIsWebviewCollapsed] = useState(false);

  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reviewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioNodeRef = useRef<AudioNode | null>(null);
  const reviewCountRef = useRef(0);
  /** 本轮语音累计全文（逐句追加，stop 后重置，供复盘记录） */
  const currentRoundTextRef = useRef('');
  const noteRef = useRef(note);
  /** 复述区实时文本（退出/流式时避免 stale 闭包） */
  const restateTextRef = useRef(note.content || '');
  /** 进入心流时的复述区原文快照（退出时剥离旧文本，仅分析本次新增内容） */
  const restateOriginalRef = useRef(note.content || '');
  /** 最新累积的复盘记录（含语音），退出时用于触发 AI 分析 */
  const speakingNotesRef = useRef<FlowSpeakingNote[]>([]);
  const restateTextareaRef = useRef<HTMLTextAreaElement>(null);
  /** 本轮语音时间戳前缀（点击语音复盘时插入，partial 流式追加其后） */
  const restateFlowBaseRef = useRef('');
  /** 用户手动编辑时的光标位置（受控恢复，保证就地 backspace 编辑） */
  const restateCaretRef = useRef<number | null>(null);

  const updateRestateText = (v: string) => {
    restateTextRef.current = v;
    setRestateText(v);
  };

  useEffect(() => {
    noteRef.current = note;
    restateTextRef.current = note.content || '';
    restateOriginalRef.current = note.content || '';
    setRestateText(note.content || '');
  }, [note]);

  /** Ref-based flag — avoids React closure staleness in recognition callbacks */
  const isListeningRef = useRef(false);
  /** Ref-based voice target — avoids React closure staleness */
  const activeVoiceTargetRef = useRef<'restate' | 'summary'>('restate');

  // 复述区光标维护：语音流式期间强制置末尾；用户编辑时恢复光标位置
  useLayoutEffect(() => {
    const el = restateTextareaRef.current;
    if (!el) return;
    if (isListeningRef.current && activeVoiceTargetRef.current === 'restate') {
      const len = el.value.length;
      el.scrollTop = el.scrollHeight;
      el.setSelectionRange(len, len);
    } else if (restateCaretRef.current !== null) {
      const pos = Math.min(restateCaretRef.current, el.value.length);
      el.setSelectionRange(pos, pos);
      restateCaretRef.current = null;
    }
  }, [restateText]);

  // Track elapsed time
  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (!isPaused) {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isPaused]);

  // Review interval timer
  useEffect(() => {
    reviewIntervalRef.current = setInterval(() => {
      if (!isPaused && !isReviewing) {
        setIsReviewing(true);
      }
    }, reviewIntervalMinutes * 60 * 1000);
    return () => { if (reviewIntervalRef.current) clearInterval(reviewIntervalRef.current); };
  }, [reviewIntervalMinutes, isPaused, isReviewing]);

  // ESC handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isReviewing) setIsReviewing(false);
        else handleExit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isReviewing, speakingNotes, reviewCountRef]);

  // Request fullscreen on mount
  useEffect(() => {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
    return () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  // 进入心流即预加载语音模型（后台静默，约 18s，期间用户正常学习）
  useEffect(() => {
    warmupStt().catch(() => {});
  }, []);

  // White noise management
  useEffect(() => {
    if (noiseType === 'none') {
      stopWhiteNoise();
      return;
    }
    startWhiteNoise(noiseType, noiseVolume);
    return () => stopWhiteNoise();
  }, [noiseType, noiseVolume]);

  const startWhiteNoise = (type: WhiteNoiseType, vol: number) => {
    stopWhiteNoise();
    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const node = makeNoise(ctx, type);
      const gain = ctx.createGain();
      gain.gain.value = vol;
      node.connect(gain);
      gain.connect(ctx.destination);
      audioNodeRef.current = gain;
    } catch (e) {
      console.warn('White noise failed:', e);
    }
  };

  const stopWhiteNoise = () => {
    if (audioNodeRef.current) {
      try { (audioNodeRef.current as any).disconnect?.(); } catch {}
      audioNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  // ==================================================
  //  Voice recognition — restate 流式输出；summary 累积
  // ==================================================

  /** 开始语音：restate 目标点击时插入时间戳，其后内容流式输出到可编辑复述区 */
  const startListeningSession = (target: 'restate' | 'summary') => {
    activeVoiceTargetRef.current = target;
    setActiveVoiceTarget(target);
    currentRoundTextRef.current = '';
    isListeningRef.current = true;
    setIsListening(true);
    setSpeechStatus('listening');

    if (target === 'restate') {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const stamp = `\n\n## 复盘 · ${dateStr} ${timeStr}\n\n`;
      restateFlowBaseRef.current = restateTextRef.current + stamp;
      updateRestateText(restateFlowBaseRef.current);
    }

    startStt(
      (text) => {
        // onPartial：每停顿一句推送一句增量，立即追加写入
        if (activeVoiceTargetRef.current === 'restate') {
          currentRoundTextRef.current += text;
          updateRestateText(restateTextRef.current + text);
        } else {
          setSummary(prev => prev + text);
        }
      },
      () => {
        // onFinal：持续监听期间不触发；这里仅作为兜底（正常情况下 stop 时才拿成品）
        setSpeechStatus('detected');
      },
      (message) => {
        console.warn('语音识别错误:', message);
        isListeningRef.current = false;
        setIsListening(false);
        setSpeechStatus('idle');
      },
    ).catch((e: Error) => {
      console.warn('启动语音识别失败:', e?.message);
      isListeningRef.current = false;
      setIsListening(false);
      setSpeechStatus('idle');
    });
  };

  /** 停止语音：restate 目标确认最终文本（保留时间戳前缀）；summary 累积到总结区 */
  const stopListeningAndSave = async () => {
    isListeningRef.current = false;
    setIsListening(false);
    setSpeechStatus('idle');

    try {
      // final 现为空信号，正文已由 partial 逐句写入，无需再取返回值
      await stopStt();
    } catch (e: any) {
      console.warn('停止语音识别失败:', e?.message);
    }

    const target = activeVoiceTargetRef.current;
    if (target === 'restate') {
      const finalText = currentRoundTextRef.current.trim();
      if (finalText) {
        // 记录本轮复盘（文本已实时写在复述区），供退出后 AI 分析
        reviewCountRef.current += 1;
        const sn: FlowSpeakingNote = {
          id: `speak-${Date.now()}-${reviewCountRef.current}`,
          noteId: noteRef.current.id,
          text: finalText,
          createdAt: new Date().toISOString(),
          roundIndex: reviewCountRef.current,
        };
        speakingNotesRef.current = [...speakingNotesRef.current, sn];
        setSpeakingNotes(speakingNotesRef.current);
      }
      restateFlowBaseRef.current = '';
    }
    // summary 目标：文本已由 partial 逐句追加到 setSummary，stop 无需额外处理

    currentRoundTextRef.current = '';
  };

  // ==================================================
  //  Question card helpers
  // ==================================================

  const addQuestion = () => {
    const q = newQuestion.trim();
    if (!q) return;
    const card: StudyQuestionCard = {
      id: `q-${Date.now()}`,
      question: q,
      noteId: noteRef.current.id,
      createdAt: new Date().toISOString(),
    };
    setQuestions(prev => [...prev, card]);
    setNewQuestion('');
  };

  const deleteQuestion = (id: string) => {
    setQuestions(prev => prev.filter(q => q.id !== id));
    setExpandedAnswers(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleAnswer = (id: string) => {
    setExpandedAnswers(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const answerQuestion = async (id: string) => {
    const card = questions.find(q => q.id === id);
    if (!card || card.answer || answeringId) return;
    setAnsweringId(id);
    try {
      const resp = await callLLM({
        providerId: '',
        model: '',
        workflow: 'question-answer',
        userInput: card.question,
      });
      const answer = (resp.content || '').trim();
      setQuestions(prev => prev.map(q =>
        q.id === id ? { ...q, answer, answeredAt: new Date().toISOString() } : q
      ));
      setExpandedAnswers(prev => new Set(prev).add(id));
    } catch (e: any) {
      console.warn('AI 解答失败:', e?.message);
    } finally {
      setAnsweringId(null);
    }
  };

  /** 打字追加到总结区 */
  const appendTypedSummary = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setSummary(prev => (prev ? prev + '\n\n' + t : t));
  };

  // ==================================================
  //  资源展示区 + 嵌入式 webview
  // ==================================================

  const resources = noteRef.current.resources || note.resources || [];

  /** 点击资源卡片：展开/折叠内嵌 webview */
  const handleSelectResource = (r: ResourceItem) => {
    setActiveResource(prev => (prev && prev.url === r.url ? null : r));
  };

  /** 关闭 webview */
  const handleCloseWebview = () => {
    setActiveResource(null);
  };

  /** 在系统浏览器/新窗口打开资源 */
  const handleOpenResourceExternal = (r: ResourceItem) => {
    const openExternal = (window as any).electronAPI?.openExternal;
    if (openExternal) {
      openExternal(r.url).catch(() => window.open(r.url, '_blank', 'noopener,noreferrer'));
    } else {
      window.open(r.url, '_blank', 'noopener,noreferrer');
    }
  };

  /** 折叠/展开 webview 区域 */
  const toggleWebviewCollapse = () => {
    setIsWebviewCollapsed(v => !v);
  };

  /** 拖拽调整 webview 区域高度（200px ~ 800px） */
  const startWebviewResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = webviewHeight;
    setIsResizing(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(200, Math.min(800, startH + (ev.clientY - startY)));
      setWebviewHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Exit: save session and persist questions/summary
  const handleExit = async () => {
    if (isListeningRef.current) {
      await stopListeningAndSave();
    }
    stopWhiteNoise();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    // 复述区正文写入 note.content 供持久化；分析用增量文本单独传递
    const finalRestate = restateTextRef.current;

    // 仅分析本次学习新增文本：剥离进入心流前的原文前缀
    const originalRestate = restateOriginalRef.current;
    let incrementalText = finalRestate;
    if (originalRestate && finalRestate.startsWith(originalRestate)) {
      incrementalText = finalRestate.slice(originalRestate.length);
    }
    incrementalText = incrementalText.trim();

    // Persist questions + summary + 复述正文
    if (onUpdateNote) {
      onUpdateNote({
        ...noteRef.current,
        content: finalRestate,
        questions,
        flowSummary: summary,
        updatedAt: new Date().toISOString(),
      });
    }

    const session: FlowSession = {
      id: `flow-${Date.now()}`,
      noteId: note.id,
      noteTitle: note.title,
      startedAt: new Date(startTimeRef.current).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: elapsedSeconds,
      reviewCount: reviewCountRef.current,
      speakingNotes: speakingNotesRef.current,
      reviewIntervalMinutes,
      summary,
      restateText: finalRestate,
      incrementalText,
      analyze: analyzeOnExit,
    };
    onExit(session);
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  };

  // SVG ring progress (1 cycle = 60 min)
  const cycleSeconds = elapsedSeconds % 3600;
  const ringProgress = (cycleSeconds / 3600) * 100;
  const circumference = 2 * Math.PI * 50;
  const dashOffset = circumference - (ringProgress / 100) * circumference;

  return (
    <div className="flow-mode-container">
      {/* 顶部工具栏 */}
      <div className="flow-cornell-toolbar">
        <div className="flow-timer-section">
          <div className="flow-timer-ring">
            <svg viewBox="0 0 120 120" width="72" height="72">
              <defs>
                <linearGradient id="flow-timer-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="100%" stopColor="#a78bfa" />
                </linearGradient>
              </defs>
              <circle className="flow-timer-ring-bg" cx="60" cy="60" r="50" />
              <circle
                className="flow-timer-ring-progress"
                cx="60" cy="60" r="50"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <div className="flow-timer-text">
              <span style={{ fontSize: '1rem' }}>{formatTime(elapsedSeconds)}</span>
              <span className="flow-timer-label">已学习</span>
            </div>
          </div>
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="text-xs text-[#8b7d61] hover:text-[#3b3324] transition flex items-center gap-1"
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {isPaused ? '继续' : '暂停'}
          </button>
        </div>

        {/* 白噪音 */}
        <div className="flow-noise-panel">
          <span className="flow-noise-title">白噪音</span>
          <div className="flow-noise-options">
            {(Object.keys(NOISE_LABELS) as WhiteNoiseType[]).map(type => (
              <button
                key={type}
                className={`flow-noise-btn ${noiseType === type ? 'active' : ''}`}
                onClick={() => setNoiseType(type)}
              >
                <span className="flow-nois-btn-icon">{NOISE_ICONS[type]}</span>
                <span>{NOISE_LABELS[type].split(' ')[1]}</span>
              </button>
            ))}
          </div>
          {noiseType !== 'none' && (
            <div className="flow-noise-volume">
              <Volume2 className="w-3.5 h-3.5 text-[#8b7d61]" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={noiseVolume}
                onChange={e => setNoiseVolume(Number(e.target.value))}
              />
              <span>{Math.round(noiseVolume * 100)}%</span>
            </div>
          )}
        </div>

        <div className="flow-cornell-toolbar-right">
          <div className="text-xs text-[#8b7d61] text-right">
            <div>{note.title}</div>
            <div>已复盘 {speakingNotes.length} 次</div>
          </div>
          <button
            onClick={() => setAnalyzeOnExit(v => !v)}
            className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition ${analyzeOnExit ? 'border-indigo-400 bg-indigo-600 text-white' : 'border-[#e2d3ae] bg-transparent text-[#8b7d61]'}`}
            style={{ padding: '0.6rem 0.75rem' }}
            title={analyzeOnExit ? '退出后将自动分析复盘文本' : '退出后只保存文本，不进行分析'}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>分析</span>
            <span className={`relative inline-block w-7 h-4 rounded-full ${analyzeOnExit ? 'bg-white/40' : 'bg-slate-300'}`}>
              <span className={`absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${analyzeOnExit ? 'translate-x-3' : 'translate-x-0'}`} />
            </span>
          </button>
          <button className="flow-btn-exit" onClick={handleExit}>
            <X className="w-4 h-4" /> 保存并退出 (ESC)
          </button>
        </div>
      </div>

      {/* 中间：提问区 + 复述区 + 资源区 */}
      <div className="flow-cornell-middle">
        {/* 提问区（左） */}
        <div className="flow-question-panel">
          <div className="flow-panel-header">
            <span className="flow-panel-title">❓ 提问区</span>
            <span className="text-[10px] text-[#8b7d61]">{questions.length} 个问题</span>
          </div>
          <div className="flow-question-list">
            {questions.length === 0 && (
              <div className="text-center text-xs text-[#8b7d61] py-6">暂无问题，在下方添加</div>
            )}
            {questions.map(card => {
              const isExpanded = expandedAnswers.has(card.id);
              return (
                <div key={card.id} className="flow-question-card">
                  <div className="flow-question-card-question">
                    <p className="text-sm text-[#3b3324] leading-snug">{card.question}</p>
                    <div className="flex items-center gap-1.5 mt-2">
                      {!card.answer ? (
                        <button
                          className="flow-card-btn flow-card-btn-primary"
                          onClick={() => answerQuestion(card.id)}
                          disabled={answeringId === card.id}
                        >
                          <Sparkles className="w-3 h-3" />
                          {answeringId === card.id ? '解答中...' : 'AI 解答'}
                        </button>
                      ) : (
                        <button
                          className="flow-card-btn flow-card-btn-ghost"
                          onClick={() => toggleAnswer(card.id)}
                        >
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {isExpanded ? '隐藏答案' : '显示答案'}
                        </button>
                      )}
                      <button
                        className="flow-card-btn flow-card-btn-danger"
                        onClick={() => deleteQuestion(card.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {card.answer && isExpanded && (
                    <div className="flow-question-card-answer">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }) => (
                            <div className="flow-md-table-wrap">
                              <table>{children}</table>
                            </div>
                          ),
                        }}
                      >
                        {card.answer}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flow-question-input">
            <textarea
              className="flow-question-textarea"
              placeholder="输入你的疑问，回车添加"
              value={newQuestion}
              onChange={e => setNewQuestion(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  addQuestion();
                }
              }}
              rows={2}
            />
            <button className="flow-card-btn flow-card-btn-primary" onClick={addQuestion}>
              <Plus className="w-3 h-3" /> 添加
            </button>
          </div>
        </div>

        {/* 复述列：上方为 webview 独立区域（可调高），下方为复述区（随之上缩） */}
        <div className="flow-restate-column">
          {activeResource && (
            <div className={`flow-webview-zone ${isWebviewCollapsed ? 'flow-webview-zone--collapsed' : ''}`} style={{ height: webviewHeight }}>
              <div className="flow-webview-wrap">
                <div className="flow-webview-toolbar">
                  <span className="flow-webview-toolbar-title" title={activeResource.url}>{activeResource.title || activeResource.url}</span>
                  <button
                    className="flow-webview-toolbar-btn"
                    title={isWebviewCollapsed ? '展开' : '折叠'}
                    onClick={toggleWebviewCollapse}
                  >
                    {isWebviewCollapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  <button className="flow-webview-toolbar-btn" title="在浏览器打开" onClick={() => handleOpenResourceExternal(activeResource)}>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <button className="flow-webview-toolbar-btn" title="关闭" onClick={handleCloseWebview}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {React.createElement('webview' as any, {
                  src: activeResource.url,
                  className: 'flow-webview',
                  partition: 'persist:flow-resource',
                  ...(activeResource.kind === 'local' && activeResource.fileType === 'pdf'
                    ? { webpreferences: 'plugins=yes' }
                    : {}),
                })}
              </div>
              <div className="flow-webview-resizer" onMouseDown={startWebviewResize} />
              {isResizing && <div className="flow-webview-resize-overlay" />}
            </div>
          )}

          {/* 复述区（右） */}
          <div className="flow-restate-panel">
            <div className="flow-panel-header">
              <span className="flow-panel-title">✍️ 复述区（快速笔记）</span>
              <button
                className={`flow-voice-btn ${activeVoiceTarget === 'restate' && isListening ? 'flow-voice-btn-active-rec' : ''}`}
                onClick={() => isListening ? stopListeningAndSave() : startListeningSession('restate')}
              >
                {isListening && activeVoiceTarget === 'restate' ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {isListening && activeVoiceTarget === 'restate' ? '停止' : '语音复盘'}
              </button>
            </div>
            {isListening && activeVoiceTarget === 'restate' && (
              <div className="flow-speaking-indicator">
                <div className="flow-speaking-bars">
                  <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
                  <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
                  <div className="flow-speaking-bar" />
                </div>
                <span className="flow-speaking-text">正在聆听... 语音实时转写中，可随时点击「停止」</span>
              </div>
            )}

            <textarea
              ref={restateTextareaRef}
              className="flow-restate-textarea"
              placeholder="点击「语音复盘」用费曼学习法复述，或在原文后追加笔记；修改原文请退出到笔记编辑页..."
              value={restateText}
              onChange={(e) => {
                const el = e.target;
                const next = el.value;
                // 原文只读防护：进入心流前的原文本不可编辑，仅允许在其之后追加新增内容。
                // 若本次编辑破坏了原文前缀，则丢弃编辑（保持原值），光标锚定回原文末尾。
                const original = restateOriginalRef.current;
                if (original && !next.startsWith(original)) {
                  // 回退到上一次合法值（原文 + 已接受的新增），仅丢弃本次破坏原文的编辑
                  const prev = restateTextRef.current;
                  restateCaretRef.current = prev.length;
                  updateRestateText(prev);
                  return;
                }
                restateCaretRef.current = el.selectionStart ?? el.value.length;
                updateRestateText(next);
              }}
            />
          </div>
        </div>

        {/* 资源区（右竖栏） */}
        <div className="flow-resource-panel">
          <div className="flow-resource-header">
            <span className="flow-resource-title"><BookOpen className="w-3.5 h-3.5" /> 资源</span>
            <span className="flow-resource-count">{resources.length} 个</span>
          </div>
          {resources.length === 0 ? (
            <div className="flow-resource-empty">暂无资源，请先在笔记编辑页生成资源推荐</div>
          ) : (
            <div className="flow-resource-cards">
              {resources.map((r) => {
                const active = activeResource?.url === r.url;
                return (
                  <div key={r.url} className={`flow-resource-card ${active ? 'flow-resource-card--active' : ''}`} onClick={() => handleSelectResource(r)}>
                    <div className="flow-resource-card-body">
                      <span className="flow-resource-card-title">{r.title || r.url}</span>
                      <span className="flow-resource-card-meta">
                        {r.kind === 'local'
                          ? `本地${r.fileType ? ` · ${r.fileType}` : ''}`
                          : (r.platform || r.url)}
                      </span>
                    </div>
                    <button
                      className="flow-resource-open"
                      title="在浏览器打开"
                      onClick={(e) => { e.stopPropagation(); handleOpenResourceExternal(r); }}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 底部：总结区 */}
      <div className="flow-summary-panel">
        <div className="flow-panel-header">
          <span className="flow-panel-title">总结区</span>
          <button
            className={`flow-voice-btn ${activeVoiceTarget === 'summary' && isListening ? 'flow-voice-btn-active-sum' : ''}`}
            onClick={() => isListening ? stopListeningAndSave() : startListeningSession('summary')}
          >
            {isListening && activeVoiceTarget === 'summary' ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            {isListening && activeVoiceTarget === 'summary' ? '停止' : '语音总结'}
          </button>
        </div>
        {isListening && activeVoiceTarget === 'summary' && (
          <div className="flow-speaking-indicator">
            <div className="flow-speaking-bars">
              <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
              <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
              <div className="flow-speaking-bar" />
            </div>
            <span className="flow-speaking-text">正在聆听... 再次点击「停止」保存总结</span>
          </div>
        )}
        <textarea
          className="flow-summary-textarea"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="点击「语音总结」总结本次学习要点，或直接在此编辑…"
        />
        {/* 打字输入：不方便语音时快速补充总结 */}
        <div className="flex items-end gap-2 px-4 pb-3 pt-2 border-t border-[#e5d8b8]">
          <textarea
            className="flex-1 min-h-[36px] max-h-28 resize-none text-xs text-[#3b3324] bg-[#fdfaf3] border border-[#e2d3ae] rounded-lg px-3 py-2 placeholder-[#8b7d61] focus:outline-none focus:border-indigo-500"
            placeholder="不方便语音？打字补充总结..."
            value={summaryDraft}
            onChange={e => setSummaryDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                appendTypedSummary(summaryDraft);
                setSummaryDraft('');
              }
            }}
            rows={2}
          />
          <button
            className="shrink-0 px-3 py-2 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-40"
            onClick={() => { appendTypedSummary(summaryDraft); setSummaryDraft(''); }}
            disabled={!summaryDraft.trim()}
          >
            <Plus className="w-3.5 h-3.5" /> 添加
          </button>
        </div>
      </div>

      {/* Timer Reminder Popup (text only, no input) */}
      {isReviewing && (
        <div className="flow-review-overlay" onClick={() => setIsReviewing(false)}>
          <div className="flow-review-prompt" onClick={e => e.stopPropagation()}>
            <div className="flow-review-title">学习复盘提醒</div>
            <div className="flow-review-subtitle">
              你已经学习了 {formatTime(elapsedSeconds)}，建议点击复述区「语音复盘」按钮用费曼学习法复述已学内容。
            </div>
            <div className="flow-review-actions" style={{ justifyContent: 'center' }}>
              <button className="flow-review-record" onClick={() => setIsReviewing(false)}>好的</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};