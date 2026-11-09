import React, { useCallback, useState, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { hasActiveDialog, useDialog } from './useDialog';
import { NoteItem, FlowSession, FlowSpeakingNote, WhiteNoiseType, FlowSettings, StudyQuestionCard, ResourceItem } from '../types';
import { ArrowLeft, BookOpen, ChevronDown, ChevronUp, CloudRain, ExternalLink, FileText, Flame, Globe, HelpCircle, Mic, MicOff, Pause, PenLine, Play, Plus, ShieldCheck, Sparkles, Trash2, Volume2, VolumeX, Waves, Wind, X } from 'lucide-react';
import { FlowQuestionAnswer } from './FlowQuestionAnswer';
import { callLLM } from '../services/llmService';
import { startStt, stopStt, warmupStt } from '../services/sttClient';
import { collectKnowledgeHotwords } from '../services/sttHotwords';
import { saveLearningEpisode } from '../services/memory/episodeStore';
import { extractQaEvidence } from '../services/memory/evidenceExtractor';
import {
  getResourceStateSnapshot,
  loadResourceState,
  makeResourceFeedbackKey,
  setResourceFeedback,
  type ResourceFeedbackRating,
  type ResourceStateFile,
} from '../services/resourceState';
import { useResourceOpen } from './useResourceOpen';
import { ResourceOpenFeedback } from './ResourceOpenFeedback';
import { flowResourceKey as resourceKey, flowResourceShelf } from '../services/flowResourceScope';
import { TextbookReader } from './textbook/TextbookReader';
import { readTextbookBody } from '../services/textbook/noteContent';
import { InteractiveFigureContext } from './textbook/InteractiveFigureContext';
import { InteractiveFigurePane } from './textbook/InteractiveFigurePane';
import { QuickCheckText } from './quickCheck/QuickCheckText';
import { findInteractiveFigure, interactiveFigureIsPending, interactiveFigureKey, prepareInteractiveFigure, withInteractiveFigureCleanup } from '../services/textbook/interactiveFigure';
import { interactiveFigureTitle } from '../services/textbook/interactiveFigureTitle';
import { PlainNoteReading } from './textbook/PlainNoteReading';
import { generatedMathCitationIds } from '../services/textbook/generatedMathCitations';
import { ProgressiveLessonPanel } from './progressive/ProgressiveCourseReader';
import { getProgressiveController } from '../services/progressiveLearning/runtime';
import { isLeafProjectNote } from '../services/knowledgePointSelector';
import { registerPendingCapture } from '../services/agent/dataFreshness';
import { rendererExitPreparation } from '../services/ui/applicationExit';
import { hasCompleteLegacyTextbook } from '../services/progressiveLearning/eligibility';
import { LocalDocumentReader } from './LocalDocumentReader';
import { parseWikiLink, resolveNoteByTitleOrAlias } from '../services/noteResolver';
import type { NoteHeadingRequest } from '../services/ui/noteHeadingNavigation';
import type { TextbookReadingPosition, TextbookReadingGetter } from '../services/textbook/readingState';
import rainAudio from '../../backgroundnoise/雨声.mp3';
import campfireAudio from '../../backgroundnoise/篝火.mp3';
import windAudio from '../../backgroundnoise/风.mp3';
import waveAudio from '../../backgroundnoise/海浪.mp3';

/** 各白噪音类型对应的真实音频资源 */
const NOISE_AUDIO_SRC: Partial<Record<WhiteNoiseType, string>> = {
  rain: rainAudio,
  campfire: campfireAudio,
  wind: windAudio,
  wave: waveAudio,
};

const RESOURCE_TYPE_LABELS: Record<NonNullable<ResourceItem['resourceType']>, string> = {
  webpage: '网页', article: '文章', video: '视频', audio: '音频', pdf: 'PDF',
  presentation: '演示文稿', document: '文档', image: '图片', archive: '压缩包', other: '其他',
};

function onlineResourceMeta(resource: ResourceItem): string {
  return `${RESOURCE_TYPE_LABELS[resource.resourceType || 'webpage']} · ${resource.platform || resource.url}`;
}

interface FlowModeProps {
  note: NoteItem;
  /** Retained source pages do not own global shortcuts while a reference/panel is active. */
  isActive?: boolean;
  isVisible?: boolean;
  allNotes: NoteItem[];
  reviewIntervalMinutes: number;
  flowSettings: FlowSettings;
  /** Agent 搜索候选可直接作为本次心流会话的临时资源，不写入项目笔记。 */
  initialResource?: ResourceItem;
  onExit: (session: FlowSession) => void | Promise<void>;
  /** 直接写入笔记内容（语音复盘去弹窗化） */
  onUpdateNote?: (updated: NoteItem) => void;
  onTextbookReadingPosition?: (noteId: string, revisionId: string, position: TextbookReadingPosition) => void;
  getTextbookReadingPosition?: TextbookReadingGetter;
  onOpenKnowledge?: (noteId: string, projectContextId?: string, heading?: string) => void;
}

const NOISE_LABELS: Record<WhiteNoiseType, string> = {
  rain: '雨声',
  campfire: '篝火',
  wind: '风声',
  wave: '海浪',
  none: '无',
};

const NOISE_ICONS: Record<WhiteNoiseType, React.ReactNode> = {
  rain: <CloudRain className="w-4 h-4" />,
  campfire: <Flame className="w-4 h-4" />,
  wind: <Wind className="w-4 h-4" />,
  wave: <Waves className="w-4 h-4" />,
  none: <VolumeX className="w-4 h-4" />,
};

export const FlowMode: React.FC<FlowModeProps> = ({ note, isActive = true, isVisible = isActive, allNotes, reviewIntervalMinutes, flowSettings, initialResource, onExit, onUpdateNote, onTextbookReadingPosition, getTextbookReadingPosition, onOpenKnowledge }) => {
  const citationIds = useMemo(() => generatedMathCitationIds(note.referenceSources, note.textbook?.sources), [note.referenceSources, note.textbook?.sources]);
  const legacyTextbookComplete = useMemo(() => hasCompleteLegacyTextbook(note),
    [note.id, note.content, note.textbook?.revisionId, note.textbook?.regionId]);
  const progressiveEligible = !legacyTextbookComplete && isLeafProjectNote(note.id, allNotes);
  const progressiveController = useMemo(() => progressiveEligible ? getProgressiveController({ note, allNotes }) : null,
    [note.id, progressiveEligible]);
  const subscribeProgressive = useCallback((listener: () => void) => progressiveController?.subscribe(listener) || (() => {}), [progressiveController]);
  const getProgressiveIdentity = useCallback(() => { const course=progressiveController?.getSnapshot().course;return course?`${course.id}:${course.lastSuccessfulReview?.reviewId||''}`:null; }, [progressiveController]);
  const progressiveCourseId = useSyncExternalStore(subscribeProgressive, getProgressiveIdentity, getProgressiveIdentity);
  const progressiveHydrated = useRef<string | null>(null);
  useEffect(() => { progressiveController?.updateContext?.({ note, allNotes }); }, [progressiveController, note, allNotes]);
  const progressiveInputReady = !progressiveController || Boolean(progressiveCourseId);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [speakingNotes, setSpeakingNotes] = useState<FlowSpeakingNote[]>([]);
  const [noiseType, setNoiseType] = useState<WhiteNoiseType>(flowSettings.whiteNoiseType);
  const [noiseVolume, setNoiseVolume] = useState(flowSettings.whiteNoiseVolume);

  // Review state — simplified: isReviewing only used for timer popup
  const [isReviewing, setIsReviewing] = useState(false);
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  const reviewTitleId = useId();
  const reviewDescriptionId = useId();
  useDialog(isReviewing, reviewDialogRef, () => setIsReviewing(false), 210);
  const [isListening, setIsListening] = useState(false);
  const [speechStatus, setSpeechStatus] = useState<'idle' | 'listening' | 'detected' | 'converting'>('idle');
  /** 复述区可编辑正文（流式输出 + 就地编辑） */
  const [restateText, setRestateText] = useState('');
  /** 退出时是否触发 AI 分析（默认开） */
  const [analyzeOnExit, setAnalyzeOnExit] = useState(true);

  /** Voice output target: restate (复述区) or summary (总结区) */
  const [activeVoiceTarget, setActiveVoiceTarget] = useState<'restate' | 'summary'>('restate');
  /** 总结区文本 */
  const [summary, setSummary] = useState('');
  const summaryRef = useRef('');
  /** 提问区问题卡片 */
  const [questions, setQuestions] = useState<StudyQuestionCard[]>(note.questions || []);
  const questionsRef = useRef(questions);
  /** 新增问题输入 */
  const [newQuestion, setNewQuestion] = useState('');
  const questionDraftRef = useRef('');
  /** 展开答案的卡片 id 集合 */
  const [expandedAnswers, setExpandedAnswers] = useState<Set<string>>(new Set());
  /** 正在 AI 解答的卡片 id */
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const questionAbortRef = useRef<AbortController | null>(null);
  /** 当前选中的资源；null 表示中间显示当前笔记。 */
  const [activeResource, setActiveResource] = useState<ResourceItem | null>(initialResource || null);
  const [figureActive, setFigureActive] = useState(false);
  const [figureTab, setFigureTab] = useState(false);
  const [progressiveFigureBody, setProgressiveFigureBody] = useState<string | null>(null);
  const [figureState, setFigureState] = useState<{ brief: string; html?: string; error?: string; busy?: boolean; hasPrevious?: boolean; indexFailure?: boolean; design?: import('../services/textbook/interactiveFigureDesign').FigureDesign; repairStatus?: import('../services/textbook/figureRepairReceipt').FigureRepairReceipt['status'] } | null>(null);
  const figureStateRef = useRef(figureState); figureStateRef.current = figureState;
  const [manualFigures, setManualFigures] = useState<import('../electron/interactiveFigureStore').ManualFigure[]>([]);
  const [figureSummaries, setFigureSummaries] = useState<Record<string, import('../electron/interactiveFigureStore').FigureSummary & { running?: boolean }>>({});
  const figureSummaryRevisions = useRef<Record<string, number>>({});
  const [clearingFigure, setClearingFigure] = useState<string | null>(null);
  const clearingFigureRef = useRef<string | null>(null);
  const [figureManagementError, setFigureManagementError] = useState('');
  const manualFiguresRef = useRef(manualFigures); manualFiguresRef.current = manualFigures;
  const manualFigureRevision = useRef(0);
  const [figureReview, setFigureReview] = useState<{ busy?: boolean; message?: string; findings?: Array<{ message: string; quote: string }> } | null>(null);
  const [figureShare, setFigureShare] = useState<{ busy?: boolean; message?: string } | null>(null);
  const figureSequence = useRef(0);
  const legacyFigureBody = useMemo(() => note.textbook ? readTextbookBody(note.content, note.textbook) : null, [note.content, note.textbook]);
  const figureBody = progressiveController ? progressiveFigureBody : legacyFigureBody;
  const plannedFigure = useMemo(() => figureBody ? findInteractiveFigure(figureBody) : null, [figureBody]);
  const figureEntries = useMemo(() => [
    ...(plannedFigure ? [{ brief: plannedFigure }] : []),
    ...manualFigures.filter(item => item.brief !== plannedFigure).map(item => ({ brief: item.brief })),
  ], [plannedFigure, manualFigures]);
  const figureOptions = useMemo(() => {
    const counts = new Map<string, number>();
    return figureEntries.filter(item => figureSummaries[item.brief]?.status === 'ready').map(item => {
      const base = interactiveFigureTitle(figureSummaries[item.brief]?.goal, item.brief, note.title), count = (counts.get(base) || 0) + 1;
      counts.set(base, count); return { ...item, title: count > 1 ? `${base}（${count}）` : base };
    });
  }, [figureEntries, figureSummaries, note.title]);
  const unfinishedFigures = useMemo(() => figureEntries.filter(item => {
    const status = figureSummaries[item.brief];
    return status && (status.status === 'failed' || status.status === 'missing' || (status.status === 'pending' && !status.running));
  }).map(item => ({ ...item, title: interactiveFigureTitle(figureSummaries[item.brief]?.goal, item.brief, note.title), hasPrevious: figureSummaries[item.brief]?.hasPrevious })), [figureEntries, figureSummaries, note.title]);
  const currentFigureTitle = figureState ? figureOptions.find(item => item.brief === figureState.brief)?.title
    || interactiveFigureTitle(figureState.design?.goal || figureSummaries[figureState.brief]?.goal, figureState.brief, note.title) : '交互图';
  const figureDocument = useRef({ noteId: note.id, body: figureBody, legacy: Boolean(!progressiveController && note.textbook), jobId: note.textbook?.generationJobId, manifest: progressiveController ? undefined : note.textbook });
  figureDocument.current = { noteId: note.id, body: figureBody, legacy: Boolean(!progressiveController && note.textbook), jobId: note.textbook?.generationJobId, manifest: progressiveController ? undefined : note.textbook };
  const updateFigureSummary = useCallback((brief: string, summary: import('../electron/interactiveFigureStore').FigureSummary & { running?: boolean }) => {
    figureSummaryRevisions.current[brief] = (figureSummaryRevisions.current[brief] || 0) + 1;
    setFigureSummaries(previous => ({ ...previous, [brief]: summary }));
  }, []);
  const prepareFigure = useCallback((brief: string, retry = false) => {
    const current = figureDocument.current; if (!current.body || !brief.trim()) return;
    const sequence = ++figureSequence.current;
    setFigureReview(null);
    setFigureState({ brief, busy: true });
    updateFigureSummary(brief, { status: 'pending', running: true });
    void (async () => {
      let key = '';
      try {
        key = await interactiveFigureKey(current.noteId, current.body!, brief);
        const selected = manualFiguresRef.current.find(item => item.brief === brief);
        const html = await prepareInteractiveFigure(key, current.body!, brief, retry, undefined,
          { projectId: current.noteId, legacy: current.legacy, jobId: current.jobId, teachingPolicy: 2 }, selected);
        const saved = await window.electronAPI?.interactiveFigure?.read(key).catch(() => null);
        if (figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) {
          updateFigureSummary(brief, { status: 'ready', ...(saved?.status === 'ready' && saved.design?.goal ? { goal: saved.design.goal } : {}) });
          if (figureSequence.current === sequence) setFigureState({ brief, html, design: saved?.status === 'ready' ? saved.design : undefined, repairStatus:saved?.status==='ready'?saved.repairReceipt?.status:undefined });
        }
      } catch (error) {
        const saved = key ? await window.electronAPI?.interactiveFigure?.read(key).catch(() => null) : null;
        if (figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) {
          updateFigureSummary(brief, { status: saved?.status === 'dismissed' ? 'dismissed' : saved?.status === 'ready' ? 'ready' : 'failed', ...(saved && saved.status !== 'ready' && saved.previousDesign?.goal ? { goal: saved.previousDesign.goal } : {}), ...(saved && saved.status !== 'ready' && saved.previousHtml ? { hasPrevious: true } : {}) });
          if (figureSequence.current === sequence) setFigureState({ brief, error: error instanceof Error ? error.message : '交互图生成失败', hasPrevious: Boolean(saved && saved.status !== 'ready' && saved.previousHtml) });
        }
      }
    })();
  }, [updateFigureSummary]);
  const openSavedFigure = useCallback((brief: string) => {
    const current = figureDocument.current; if (!current.body) return;
    const sequence = ++figureSequence.current;
    setFigureReview(null); setFigureState({ brief, busy: true });
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure; if (!api) throw Error('当前环境不支持交互图');
        const key = await interactiveFigureKey(current.noteId, current.body!, brief);
        let saved = await api.read(key);
        let displayHtml: string | undefined;
        if (saved?.status === 'ready') {
          const selected = manualFiguresRef.current.find(item => item.brief === brief);
          displayHtml=await prepareInteractiveFigure(key, current.body!, brief, false, undefined,
            { projectId: current.noteId, legacy: current.legacy, jobId: current.jobId }, selected);
          saved = await api.read(key);
        }
        if (sequence !== figureSequence.current || figureDocument.current.body !== current.body || figureDocument.current.noteId !== current.noteId) return;
        if (saved?.status === 'ready') { updateFigureSummary(brief, { status: 'ready', ...(saved.design?.goal ? { goal: saved.design.goal } : {}) }); setFigureState({ brief, html: displayHtml || saved.html, design: saved.design, repairStatus:saved.repairReceipt?.status }); }
        else { updateFigureSummary(brief, { status: saved?.status || 'missing', ...(saved?.previousDesign?.goal ? { goal: saved.previousDesign.goal } : {}), ...(saved?.previousHtml ? { hasPrevious: true } : {}) }); setFigureState({ brief, error: saved?.error || '交互图尚未生成，可单独重试。', hasPrevious: Boolean(saved?.previousHtml) }); }
      } catch (error) { if (sequence === figureSequence.current) setFigureState({ brief, error: error instanceof Error ? error.message : '交互图读取失败' }); }
    })();
  }, [updateFigureSummary]);
  const requestManualFigure = useCallback((scope: import('../services/progressiveLearning/types').ProgressiveSupplementScope) => {
    const current = figureDocument.current; const wholePage = !scope.text.trim();
    if (progressiveController) {
      const snapshot = progressiveController.getSnapshot();
      const descriptor = snapshot.course?.pages?.find(page => page.id === snapshot.page?.id);
      const publishedBody = snapshot.page?.body || snapshot.course?.page?.body || snapshot.course?.firstPage?.body;
      if (snapshot.phase !== 'ready' || snapshot.course?.projectNoteId !== current.noteId || publishedBody !== current.body
        || !descriptor || scope.pageHash !== descriptor.contentHash) return;
    }
    const brief = wholePage ? '根据本页教材的核心内容生成交互图。' : scope.text.trim();
    if (!current.body || brief.length > 1200) return;
    const revision = ++manualFigureRevision.current;
    setActiveResource(null); setFigureTab(true); setFigureActive(true); setFigureReview(null);
    const sequence = ++figureSequence.current;
    setFigureState({ brief, busy: true });
    void (async () => {
      let indexKey = '';
      try {
        const api = window.electronAPI?.interactiveFigure;
        if (!api?.addManual) throw Error('当前应用版本不支持保存手动交互图，请重启应用。');
        indexKey = await interactiveFigureKey(current.noteId, current.body!, 'manual-figure-index-v1');
        const items = await api.addManual(indexKey, { brief, before: (scope.before || '').slice(-500), after: (scope.after || '').slice(0, 500), ...(wholePage ? { wholePage: true } : {}) });
        if (sequence !== figureSequence.current || figureDocument.current.body !== current.body || figureDocument.current.noteId !== current.noteId) return;
        manualFiguresRef.current = items; setManualFigures(items);
        prepareFigure(brief);
      } catch (error) {
        if (sequence === figureSequence.current) setFigureState({ brief, indexFailure: true, error: error instanceof Error ? error.message : '交互图准备失败' });
        if (indexKey && manualFigureRevision.current === revision && figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) {
          const items = await window.electronAPI?.interactiveFigure?.listManual?.(indexKey).catch(() => null);
          if (items && manualFigureRevision.current === revision && figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) { manualFiguresRef.current = items; setManualFigures(items); }
        }
      }
    })();
  }, [prepareFigure, progressiveController]);
  const restoreFigure = useCallback((brief: string) => {
    const current = figureDocument.current; if (!current.body) return;
    const sequence = ++figureSequence.current;
    setFigureReview(null);
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure; if (!api) throw Error('当前环境不支持交互图');
        const key = await interactiveFigureKey(current.noteId, current.body!, brief), saved = await api.read(key);
        if (!saved || saved.status === 'ready' || !saved.previousHtml) throw Error('没有可恢复的上一版交互图');
        await api.write(key, { status: 'ready', html: saved.previousHtml, ...(saved.previousDesign ? { design: saved.previousDesign } : {}) });
        if (sequence === figureSequence.current && figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) { updateFigureSummary(brief, { status: 'ready', ...(saved.previousDesign?.goal ? { goal: saved.previousDesign.goal } : {}) }); setFigureState({ brief, html: saved.previousHtml, design: saved.previousDesign }); }
      } catch (error) { if (sequence === figureSequence.current) setFigureState({ brief, error: error instanceof Error ? error.message : '恢复失败', hasPrevious: true }); }
    })();
  }, [updateFigureSummary]);
  const clearUnfinishedFigure = useCallback((brief: string) => {
    const current = figureDocument.current; if (!current.body || clearingFigureRef.current) return;
    const selected = manualFiguresRef.current.some(item => item.brief === brief);
    const isPlanned = findInteractiveFigure(current.body) === brief;
    if (selected) manualFigureRevision.current++;
    clearingFigureRef.current = brief; setClearingFigure(brief); setFigureManagementError('');
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure;
        if (!api?.clearUnfinished) throw Error('当前版本无法清理交互图，请重启应用。');
        const key = await interactiveFigureKey(current.noteId, current.body!, brief);
        if (interactiveFigureIsPending(key)) throw Error('交互图仍在生成，请稍后再清理。');
        const indexKey = selected ? await interactiveFigureKey(current.noteId, current.body!, 'manual-figure-index-v1') : '';
        if (interactiveFigureIsPending(key)) throw Error('交互图仍在生成，请稍后再清理。');
        const result = await withInteractiveFigureCleanup<{ restored: boolean; items?: import('../electron/interactiveFigureStore').ManualFigure[] }>(key, () => api.clearUnfinished!(key, selected ? { indexKey, brief, ...(isPlanned ? { keepTombstone: true } : {}) } : undefined));
        if (figureDocument.current.body !== current.body || figureDocument.current.noteId !== current.noteId) return;
        if (result.items) { manualFiguresRef.current = result.items; setManualFigures(result.items); }
        if (result.restored) {
          const summary = api.describe ? await api.describe(key).catch(() => ({ status: 'ready' as const })) : { status: 'ready' as const };
          if (figureDocument.current.body !== current.body || figureDocument.current.noteId !== current.noteId) return;
          updateFigureSummary(brief, summary);
          if (figureStateRef.current?.brief === brief) openSavedFigure(brief);
        } else {
          updateFigureSummary(brief, { status: 'dismissed' });
          if (figureStateRef.current?.brief === brief) { figureSequence.current++; setFigureState(null); setFigureTab(false); setFigureActive(false); setFigureReview(null); }
        }
      } catch (error) { if (figureDocument.current.body === current.body && figureDocument.current.noteId === current.noteId) setFigureManagementError(error instanceof Error ? error.message : '清理失败，请重试。'); }
      finally { clearingFigureRef.current = null; setClearingFigure(null); }
    })();
  }, [openSavedFigure, updateFigureSummary]);
  const reviewFigure = useCallback(() => {
    const current = figureDocument.current, shown = figureState;
    if (!current.body || !shown?.html) return;
    const sequence = figureSequence.current;
    setFigureReview({ busy: true });
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure; if (!api) throw Error('当前环境不支持交互图复核');
        const key = await interactiveFigureKey(current.noteId, current.body!, shown.brief), saved = await api.read(key);
        if (!saved || saved.status !== 'ready' || saved.html !== shown.html) throw Error('交互图已变化，请重新打开后复核');
        const { reviewInteractiveFigure } = await import('../services/textbook/interactiveFigureReview');
        const result = await reviewInteractiveFigure({ body: current.body!, brief: shown.brief, html: saved.html, design: saved.design,
          authorization: { projectId: current.noteId, legacy: current.legacy, jobId: current.jobId } });
        if (sequence !== figureSequence.current || figureDocument.current.body !== current.body) return;
        setFigureReview({ message: result.assessment === 'issues' ? '模型发现需要检查的问题：' : result.assessment === 'uncertain' ? '材料不足，模型无法确定；请自行核对。' : '模型未发现明确冲突；这不等于知识或图示已验证。', findings: result.findings });
      } catch (error) { if (sequence === figureSequence.current) setFigureReview({ message: error instanceof Error ? error.message : '教学复核未完成' }); }
    })();
  }, [figureState]);
  const exportTeaching = useCallback(() => {
    const current = figureDocument.current; if (!current.body) return;
    setFigureShare({ busy: true });
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure;
        if (!api?.portable) throw Error('当前环境不支持导出交互图附件');
        const { buildInteractiveFigureShare, downloadInteractiveFigureShare } = await import('../services/textbook/interactiveFigureShare');
        const result = await buildInteractiveFigureShare({ noteId: current.noteId, title: note.title, body: current.body!, manifest: current.manifest, manualFigures: manualFiguresRef.current }, { read: api.read, portable: api.portable });
        downloadInteractiveFigureShare(result.bytes, result.name);
        if (figureDocument.current.noteId === current.noteId) setFigureShare({ message: `已导出 Markdown${result.htmlError ? `；HTML 未生成：${result.htmlError}` : ' 和排版 HTML'}，交互图 ${result.included} 张${result.missing ? `，${result.missing} 张尚未生成` : ''}${result.missingImages || result.missingVisuals ? `；${result.missingImages} 张原图、${result.missingVisuals} 张图示未能导出` : ''}${result.assetError ? `；${result.assetError}` : ''}。` });
      } catch (error) { if (figureDocument.current.noteId === current.noteId) setFigureShare({ message: error instanceof Error ? error.message : '教材导出失败' }); }
    })();
  }, [note.title]);
  useEffect(() => {
    figureSequence.current++; manualFigureRevision.current++; figureSummaryRevisions.current = {}; setFigureSummaries({}); setFigureManagementError(''); setFigureTab(false); setFigureActive(false); setFigureState(null); setFigureReview(null); manualFiguresRef.current = []; setManualFigures([]);
    if (!figureBody) return;
    // One optional job after publication; the saved prose stays immediately readable.
    if (plannedFigure) prepareFigure(plannedFigure);
    const body = figureBody, noteId = note.id, loadRevision = manualFigureRevision.current; let cancelled = false;
    void (async () => {
      try {
        const api = window.electronAPI?.interactiveFigure; if (!api?.listManual) return;
        const indexKey = await interactiveFigureKey(noteId, body, 'manual-figure-index-v1');
        const items = await api.listManual(indexKey);
        if (cancelled || manualFigureRevision.current !== loadRevision || figureDocument.current.noteId !== noteId || figureDocument.current.body !== body) return;
        manualFiguresRef.current = items; setManualFigures(items);
      } catch { /* A damaged index does not block the lesson. */ }
    })();
    return () => { cancelled = true; };
  }, [note.id, figureBody, plannedFigure, note.textbook?.generationJobId, prepareFigure, openSavedFigure]);
  useEffect(() => {
    const body = figureBody, noteId = note.id, api = window.electronAPI?.interactiveFigure;
    if (!body || !api || !figureEntries.length) return;
    let cancelled = false;
    const revisions = Object.fromEntries(figureEntries.map(item => [item.brief, figureSummaryRevisions.current[item.brief] || 0]));
    void Promise.all(figureEntries.map(async ({ brief }) => {
      try {
        const key = await interactiveFigureKey(noteId, body, brief);
        const saved = api.describe ? await api.describe(key) : await api.read(key).then(artifact => artifact?.status === 'ready'
          ? { status: 'ready' as const, ...(artifact.design?.goal ? { goal: artifact.design.goal } : {}) }
          : artifact ? { status: artifact.status, ...(artifact.previousDesign?.goal ? { goal: artifact.previousDesign.goal } : {}), ...(artifact.previousHtml ? { hasPrevious: true } : {}) } : { status: 'missing' as const });
        return { brief, summary: { ...saved, ...(saved.status === 'pending' && interactiveFigureIsPending(key) ? { running: true } : {}) } };
      } catch { return { brief, summary: { status: 'failed' as const } }; }
    })).then(items => {
      if (cancelled || figureDocument.current.body !== body || figureDocument.current.noteId !== noteId) return;
      setFigureSummaries(previous => {
        const next = { ...previous };
        for (const item of items) if ((figureSummaryRevisions.current[item.brief] || 0) === revisions[item.brief]) next[item.brief] = item.summary;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [note.id, figureBody, figureEntries]);
  useEffect(() => () => { figureSequence.current++; }, []);
  const figureContext = useMemo(() => ({ open: (brief: string) => {
    setActiveResource(null); setFigureTab(true); setFigureActive(true);
    if (figureState?.brief !== brief || figureState.error) prepareFigure(brief, Boolean(figureState?.error));
  } }), [figureState, prepareFigure]);
  const [readingHeading, setReadingHeading] = useState<NoteHeadingRequest>();
  const [readingNotice, setReadingNotice] = useState('');
  const openReadingWiki = useCallback((raw: string) => {
    const destination = parseWikiLink(raw, allNotes);
    const target = destination.noteTitle ? resolveNoteByTitleOrAlias(destination.noteTitle, allNotes) : destination.heading ? note : undefined;
    if (destination.heading !== undefined && !destination.heading) { setReadingNotice('章节引用缺少章节名称。'); return; }
    if (!target) { setReadingNotice('未找到关联笔记，请检查笔记名称。'); return; }
    setReadingNotice('');
    if (target.id === note.id && destination.heading) setReadingHeading({ heading: destination.heading, key: crypto.randomUUID() });
    else onOpenKnowledge?.(target.id, undefined, destination.heading);
  }, [note, allNotes, onOpenKnowledge]);
  /** 只有从底部资源栏点开的资源才会进入中间标签栏。 */
  const [openResourceKeys, setOpenResourceKeys] = useState<string[]>(
    initialResource ? [resourceKey(initialResource)] : [],
  );
  const [referenceResources, setReferenceResources] = useState<ResourceItem[]>([]);
  useEffect(() => setReferenceResources([]), [note.id]);
  const [isResourceShelfCollapsed, setIsResourceShelfCollapsed] = useState(false);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [exitError, setExitError] = useState('');
  const exitGuardRef = useRef(false);
  const sessionIdRef = useRef(`flow-${crypto.randomUUID()}`);
  const [resourcePanelHeight, setResourcePanelHeight] = useState(176);
  /** 按资源 URL 在主进程解析出的本地登录分区；解析完成前不创建 webview，避免先发出未登录请求。 */
  const [activeResourcePartition, setActiveResourcePartition] = useState<string | null>(null);
  const [isResourcePartitionReady, setIsResourcePartitionReady] = useState(false);
  const [resourceState, setResourceState] = useState<ResourceStateFile>(getResourceStateSnapshot);
  const resourceOpen = useResourceOpen(note.id);

  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reviewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const reviewCountRef = useRef(0);
  /** 本轮语音累计全文（逐句追加，stop 后重置，供复盘记录） */
  const currentRoundTextRef = useRef('');
  const noteRef = useRef(note);
  /** 复述区实时文本（退出/流式时避免 stale 闭包） */
  const restateTextRef = useRef('');
  /** 最新累积的复盘记录（含语音），退出时用于触发 AI 分析 */
  const speakingNotesRef = useRef<FlowSpeakingNote[]>([]);
  const restateTextareaRef = useRef<HTMLTextAreaElement>(null);
  const notesPanelRef = useRef<HTMLElement>(null);
  /** 本轮语音时间戳前缀（点击语音复盘时插入，partial 流式追加其后） */
  const restateFlowBaseRef = useRef('');
  const progressiveVoicePageRef = useRef<string | null>(null);
  /** 用户手动编辑时的光标位置（受控恢复，保证就地 backspace 编辑） */
  const restateCaretRef = useRef<number | null>(null);

  const updateRestateText = (v: string, pageId?: string | null) => {
    restateTextRef.current = v;
    setRestateText(v);
    if (progressiveHydrated.current) {
      if (progressiveController?.recordRestatement) progressiveController.recordRestatement(v, pageId);
      else progressiveController?.saveProgress({ restatementDraft: v });
    }
  };

  useEffect(() => {
    if (!progressiveController) return;
    void progressiveController.start().catch(() => {});
    return () => { questionAbortRef.current?.abort(); progressiveController.dispose(); };
  }, [progressiveController]);
  useEffect(() => {
    const course = progressiveController?.getSnapshot().course;
    const key=course?`${course.id}:${course.lastSuccessfulReview?.reviewId||''}`:null;
    if (!course || progressiveHydrated.current === key) return;
    progressiveHydrated.current = key;
    updateRestateText(course.progress.restatementDraft);
    summaryRef.current = course.progress.summaryDraft;
    setSummary(course.progress.summaryDraft);
    questionsRef.current = course.progress.questions ?? note.questions ?? [];
    setQuestions(questionsRef.current);
    questionDraftRef.current = course.progress.questionDraft || '';
    setNewQuestion(questionDraftRef.current);
  }, [progressiveCourseId]);
  useEffect(() => {
    if (!progressiveController) return;
    return registerPendingCapture(() => {
      if (progressiveHydrated.current) progressiveController.saveProgress({
        restatementDraft: restateTextRef.current, summaryDraft: summaryRef.current,
        questions: questionsRef.current, questionDraft: questionDraftRef.current,
      });
    });
  }, [progressiveController]);

  useEffect(() => {
    noteRef.current = note;
  }, [note]);
  useEffect(() => {
    // Reading progress updates the note object, not this session's unsaved question cards.
    if (!progressiveController) { questionsRef.current = note.questions || []; setQuestions(questionsRef.current); }
    setActiveResource(initialResource || null);
    setOpenResourceKeys(initialResource ? [resourceKey(initialResource)] : []);
  }, [note.id]);

  useEffect(() => { loadResourceState().then(setResourceState).catch(() => {}); }, []);

  useEffect(() => {
    let canceled = false;
    if (!activeResource) {
      setActiveResourcePartition(null);
      setIsResourcePartitionReady(false);
      return () => { canceled = true; };
    }
    const fallbackPartition = activeResource.browserPartition
      || (activeResource.browserSessionId ? `resource-search-temp-${activeResource.browserSessionId}` : 'persist:flow-resource');
    if (activeResource.kind === 'local' || activeResource.documentId) {
      setActiveResourcePartition(fallbackPartition);
      setIsResourcePartitionReady(true);
      return () => { canceled = true; };
    }
    setIsResourcePartitionReady(false);
    const resolver = (window as any).electronAPI?.resourceBrowser?.resolveAuthSession;
    if (!resolver) {
      setActiveResourcePartition(fallbackPartition);
      setIsResourcePartitionReady(true);
      return () => { canceled = true; };
    }
    Promise.resolve(resolver(activeResource.url))
      .then((resolved: { partition?: string } | null) => {
        if (canceled) return;
        setActiveResourcePartition(resolved?.partition || fallbackPartition);
        setIsResourcePartitionReady(true);
      })
      .catch(() => {
        if (canceled) return;
        setActiveResourcePartition(fallbackPartition);
        setIsResourcePartitionReady(true);
      });
    return () => { canceled = true; };
  }, [activeResource]);

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
    const src = NOISE_AUDIO_SRC[type];
    if (!src) return;
    try {
      const audio = new Audio(src);
      audio.loop = true;
      audio.volume = vol;
      audio.play().catch((e) => console.warn('White noise play failed:', e));
      audioElementRef.current = audio;
    } catch (e) {
      console.warn('White noise failed:', e);
    }
  };

  const stopWhiteNoise = () => {
    if (audioElementRef.current) {
      try {
        audioElementRef.current.pause();
        audioElementRef.current.src = '';
      } catch {}
      audioElementRef.current = null;
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
      progressiveVoicePageRef.current = progressiveController?.readingPageId?.() || null;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const stamp = `\n\n## 复盘 · ${dateStr} ${timeStr}\n\n`;
      restateFlowBaseRef.current = restateTextRef.current + stamp;
      updateRestateText(restateFlowBaseRef.current, progressiveVoicePageRef.current);
    }

    startStt(
      (text) => {
        // onPartial：每停顿一句推送一句增量，立即追加写入
        if (activeVoiceTargetRef.current === 'restate') {
          currentRoundTextRef.current += text;
          updateRestateText(restateTextRef.current + text, progressiveVoicePageRef.current);
        } else {
          const nextSummary = summaryRef.current + text;
          summaryRef.current = nextSummary;
          setSummary(nextSummary);
          progressiveController?.saveProgress({ summaryDraft: nextSummary });
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
      collectKnowledgeHotwords(allNotes),
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

  useEffect(() => {
    if (!progressiveController) return;
    return rendererExitPreparation.register({ name: '渐进学习保存', stop: async () => {
      questionAbortRef.current?.abort();
      if (isListeningRef.current) await stopListeningAndSave();
      if (progressiveHydrated.current) progressiveController.saveProgress({
        restatementDraft: restateTextRef.current, summaryDraft: summaryRef.current,
        questions: questionsRef.current, questionDraft: questionDraftRef.current,
      });
      await progressiveController.stop();
      await progressiveController.flush();
    } });
  }, [progressiveController]);

  // ==================================================
  //  Question card helpers
  // ==================================================

  const updateQuestions = (change: StudyQuestionCard[] | ((previous: StudyQuestionCard[]) => StudyQuestionCard[])) => {
    const next = typeof change === 'function' ? change(questionsRef.current) : change;
    questionsRef.current = next;
    setQuestions(next);
    if (progressiveHydrated.current) progressiveController?.saveProgress({ questions: next });
  };
  const addQuestion = () => {
    const q = newQuestion.trim();
    if (!q) return;
    const card: StudyQuestionCard = {
      id: `q-${Date.now()}`,
      question: q,
      noteId: noteRef.current.id,
      createdAt: new Date().toISOString(),
    };
    updateQuestions(prev => [...prev, card]);
    questionDraftRef.current = '';
    setNewQuestion('');
    progressiveController?.saveProgress({ questionDraft: '' });
  };

  const deleteQuestion = (id: string) => {
    updateQuestions(prev => prev.filter(q => q.id !== id));
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
    const startedAt = new Date().toISOString();
    const questionAbort = progressiveController ? new AbortController() : null;
    questionAbortRef.current = questionAbort;
    setAnsweringId(id);
    try {
      const resp = await callLLM({
        providerId: '',
        model: '',
        workflow: 'question-answer',
        userInput: card.question,
      }, questionAbort ? { signal: questionAbort.signal } : undefined);
      const answer = (resp.content || '').trim();
      if (!answer) return;
      const endedAt = new Date().toISOString();
      updateQuestions(prev => prev.map(q =>
        q.id === id ? { ...q, answer, answeredAt: endedAt } : q
      ));
      setExpandedAnswers(prev => new Set(prev).add(id));
      const episodeId = `qa-${card.id}`;
      const evidence = extractQaEvidence({ episodeId, observedAt: endedAt, question: card.question });
      const compactAnswer = answer.replace(/\s+/g, ' ').trim();
      saveLearningEpisode({
        id: episodeId,
        type: 'qa',
        status: 'completed',
        title: `答疑：${card.question.slice(0, 60)}`,
        noteId: noteRef.current.id,
        startedAt,
        endedAt,
        goal: card.question,
        summary: compactAnswer.length > 500 ? `${compactAnswer.slice(0, 500)}…` : compactAnswer,
        knowledgePoints: [noteRef.current.title],
        evidenceSnippets: evidence.evidenceSnippets,
        profileSignals: evidence.profileSignals,
        createdAt: endedAt,
        updatedAt: endedAt,
      }).catch(() => {});
    } catch (e: any) {
      console.warn('AI 解答失败:', e?.message);
    } finally {
      if (questionAbortRef.current === questionAbort) questionAbortRef.current = null;
      setAnsweringId(null);
    }
  };

  // ==================================================
  //  资源栏 + 中间标签页
  // ==================================================

  const resourceShelf = useMemo(() => {
    const shelf = flowResourceShelf(note, allNotes, initialResource);
    for (const resource of referenceResources) {
      if (!note.textbook?.sources?.some(source => source.kind === 'document' && source.id === resource.documentId)
        || shelf.entries.some(entry => resourceKey(entry.resource) === resourceKey(resource))) continue;
      shelf.entries.push({ resource, ownerTitle: '教材引用资料', inherited: false, temporary: true });
    }
    return shelf;
  }, [note, allNotes, initialResource, referenceResources]);
  const resources = useMemo(() => resourceShelf.entries.map(entry => entry.resource), [resourceShelf]);
  const resourceShelfId = useId();

  useEffect(() => {
    // React to ancestor unbinding/reparenting as well as direct edits. A stale
    // tab must not keep displaying a resource that is no longer in this scope.
    const available = new Set(resources.map(resourceKey));
    setOpenResourceKeys(previous => previous.every(key => available.has(key)) ? previous : previous.filter(key => available.has(key)));
    setActiveResource(previous => previous ? resources.find(resource => resourceKey(resource) === resourceKey(previous)) || null : null);
  }, [resources]);

  const openResources = resources.filter(resource => openResourceKeys.includes(resourceKey(resource)));

  /** 底部资源栏只负责打开资源；中间标签栏负责切换和关闭。 */
  const handleSelectResource = (r: ResourceItem) => {
    const key = resourceKey(r);
    setOpenResourceKeys(prev => prev.includes(key) ? prev : [...prev, key]);
    setActiveResource(r);
    setFigureActive(false);
  };

  const handleCloseResourceTab = (resource: ResourceItem) => {
    const key = resourceKey(resource);
    const nextKeys = openResourceKeys.filter(item => item !== key);
    setOpenResourceKeys(nextKeys);
    if (activeResource && resourceKey(activeResource) === key) {
      const nextResource = resources.find(item => nextKeys.includes(resourceKey(item)));
      setActiveResource(nextResource || null);
    }
  };

  /** 在系统浏览器/新窗口打开资源 */
  const handleOpenResourceExternal = (r: ResourceItem) => {
    void resourceOpen.start(r);
  };

  const handleResourceFeedback = async (resource: ResourceItem, rating: ResourceFeedbackRating) => {
    const next = await setResourceFeedback(note.id, resource, rating);
    setResourceState(next);
  };

  const clampResourcePanelHeight = (height: number, panelHeight?: number) => {
    const availableHeight = panelHeight ?? notesPanelRef.current?.getBoundingClientRect().height ?? 720;
    return Math.max(96, Math.min(height, Math.max(96, availableHeight - 300)));
  };

  const handleResourcePanelResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = resourcePanelHeight;
    const panelHeight = notesPanelRef.current?.getBoundingClientRect().height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setResourcePanelHeight(clampResourcePanelHeight(startHeight + startY - moveEvent.clientY, panelHeight));
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Exit: save session and persist questions/summary
  const handleExit = async () => {
    if (exitGuardRef.current) return;
    exitGuardRef.current = true;
    setIsExiting(true);
    setExitError('');
    questionAbortRef.current?.abort();
    if (isListeningRef.current) {
      await stopListeningAndSave();
    }
    stopWhiteNoise();

    // 会话输入独立于教材/旧复述；保存由 App 从最新笔记合并并等待持久化回执。
    const finalRestate = restateTextRef.current;

    const session: FlowSession = {
      id: sessionIdRef.current,
      noteId: note.id,
      noteTitle: note.title,
      startedAt: new Date(startTimeRef.current).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: elapsedSeconds,
      reviewIntervalMinutes,
      summary,
      restateText: finalRestate,
      incrementalText: finalRestate.trim(),
      questions: questionsRef.current,
      textbookRevisionId: note.textbook?.revisionId,
      analyze: analyzeOnExit,
      ...(progressiveController ? { learningMode: 'progressive' as const,
        progressiveCourseId: progressiveController.getSnapshot().course?.id } : {}),
    };
    try {
      if (progressiveController) {
        if (progressiveHydrated.current) progressiveController.saveProgress({
          restatementDraft: finalRestate, summaryDraft: summaryRef.current,
          questions: questionsRef.current, questionDraft: questionDraftRef.current,
        });
        await progressiveController.stop();
        await progressiveController.flush();
      }
      await onExit(session);
      // Save/capture the reading paragraph before fullscreen changes its width.
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
    catch (error) {
      setExitError(error instanceof Error ? error.message : '学习记录保存失败，请重试');
      exitGuardRef.current = false;
      setIsExiting(false);
    }
  };

  // 同时门控可见性并使用最新退出闭包，Esc 不丢失新总结、问题、时长或分析开关。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isActive || e.defaultPrevented) return;
      if (hasActiveDialog()) return;
      if (e.key === 'Escape') {
        if (isReviewing) setIsReviewing(false);
        else void handleExit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isReviewing, handleExit]);

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  };

  const sessionRestateText = restateText;

  return (
    <>
    <div className="flow-mode-container flow-focus-workspace" inert={isReviewing || undefined}>
      {exitError && <div role="alert" className="learning-review-error">{exitError}，复述仍保留在本页。</div>}
      <header className="focus-flow-topbar">
        <button className="focus-flow-leave" onClick={handleExit} disabled={isExiting}>
          <ArrowLeft aria-hidden="true" />
          <span>退出心流</span>
        </button>
        <div className="focus-flow-session">
          <strong>{note.title}</strong>
          <span className="focus-flow-session-divider" aria-hidden="true" />
          <span className="focus-flow-timer" aria-label={`已学习 ${formatTime(elapsedSeconds)}`}>
            {formatTime(elapsedSeconds)}
          </span>
          <button
            className="focus-flow-pause"
            onClick={() => setIsPaused(!isPaused)}
            title={isPaused ? '继续计时' : '暂停计时'}
          >
            {isPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
        </div>
        <div className="focus-flow-local-status">
          <ShieldCheck aria-hidden="true" />
          <span>所有记录均保存在本地</span>
        </div>
      </header>

      <main className="focus-flow-main">
        <aside className="flow-question-panel focus-flow-questions">
          <div className="focus-flow-panel-heading">
            <div>
              <span className="focus-flow-eyebrow"><HelpCircle aria-hidden="true" /> 问题线索</span>
              <p>带着问题阅读，让思考更深入。</p>
            </div>
          </div>
          <div className="flow-question-list">
            {questions.length === 0 && (
              <div className="focus-flow-empty">暂无线索，可以先写下阅读时最想弄明白的问题。</div>
            )}
            {questions.map((card, index) => {
              const isExpanded = expandedAnswers.has(card.id);
              return (
                <div key={card.id} className="flow-question-card">
                  <div className="flow-question-card-question">
                    <span className="focus-flow-question-number">{index + 1}</span>
                    <div className="focus-flow-question-copy">
                      <p>{card.question}</p>
                      <span>{card.answer ? '已有答疑，可展开查看。' : '结合正在阅读的材料寻找依据。'}</span>
                    </div>
                    <div className="focus-flow-question-actions">
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
                        title="删除问题"
                        onClick={() => deleteQuestion(card.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {card.answer && isExpanded && (
                    <div
                      className="flow-question-card-answer"
                      data-selection-surface="flow"
                      data-selection-source-id={card.id}
                      data-selection-context-id={note.id}
                      data-selection-source-title={note.title}
                      data-selection-note-id={note.id}
                    >
                      <FlowQuestionAnswer content={card.answer} />
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
              disabled={!progressiveInputReady}
              onChange={e => { questionDraftRef.current = e.target.value; setNewQuestion(e.target.value);
                progressiveController?.saveProgress({ questionDraft: e.target.value }); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
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
        </aside>

        <section className="focus-flow-resource-stage">
          <div className="focus-flow-resource-heading">
            <span className="focus-flow-eyebrow"><BookOpen aria-hidden="true" /> 学习资源</span>
            {figureBody && <button type="button" disabled={figureShare?.busy} onClick={exportTeaching} title="导出包含排版 HTML、Markdown 与已生成交互图的 ZIP；分享前请核对内容">{figureShare?.busy ? '正在导出…' : progressiveController ? '导出当前教材页' : '导出教材'}</button>}
            {figureShare?.message && <span role="status">{figureShare.message}</span>}
            <button onClick={() => setIsResourceShelfCollapsed(value => !value)}>
              {isResourceShelfCollapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              {isResourceShelfCollapsed ? '展开资源栏' : '收起资源栏'}
            </button>
          </div>
          <div className="focus-flow-tabs" role="tablist" aria-label="已打开的学习资源">
            <button
              className={!activeResource && !figureActive ? 'is-active' : ''}
              role="tab"
              aria-selected={!activeResource && !figureActive}
              onClick={() => { setActiveResource(null); setFigureActive(false); }}
            >
              <FileText aria-hidden="true" />
              <span>当前笔记</span>
            </button>
            {figureTab && <div className={`focus-flow-resource-tab ${figureActive ? 'is-active' : ''}`}>
              <button role="tab" aria-label={`交互探索：${currentFigureTitle}`} aria-selected={figureActive} title={currentFigureTitle} onClick={() => { setActiveResource(null); setFigureActive(true); }}><Sparkles aria-hidden="true" /><span>{currentFigureTitle}</span><small aria-hidden="true">{figureState?.error ? '需重试' : figureState?.html ? '已就绪' : '生成中'}</small></button>
              <button className="focus-flow-tab-close" title="关闭交互探索" onClick={() => { setFigureTab(false); setFigureActive(false); }}><X aria-hidden="true" /></button>
            </div>}
            {openResources.map(resource => {
              const active = activeResource ? resourceKey(activeResource) === resourceKey(resource) : false;
              return (
                <div className={`focus-flow-resource-tab ${active ? 'is-active' : ''}`} key={resourceKey(resource)}>
                  <button
                    role="tab"
                    aria-selected={active}
                    onClick={() => { setActiveResource(resource); setFigureActive(false); }}
                    title={resource.title || resource.url}
                  >
                    {resource.kind === 'local' || resource.documentId ? <FileText aria-hidden="true" /> : <Globe aria-hidden="true" />}
                    <span>{resource.title || resource.url}</span>
                  </button>
                  <button
                    className="focus-flow-tab-close"
                    title="关闭标签"
                    onClick={() => handleCloseResourceTab(resource)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="focus-flow-resource-viewer">
            {readingNotice && <p role="status">{readingNotice}<button type="button" onClick={() => setReadingNotice('')}>关闭提示</button></p>}
            {(!activeResource || figureTab) && <div className="focus-flow-reading-host" style={activeResource || figureActive ? { display: 'none' } : undefined}>
              <InteractiveFigureContext.Provider value={figureContext}>
              {progressiveController ? <ProgressiveLessonPanel controller={progressiveController} active={isActive && !activeResource && !figureActive} onFigureBody={setProgressiveFigureBody} onFigure={requestManualFigure}
              /> : note.textbook ? <TextbookReader
                active={isVisible && !activeResource && !figureActive}
                interactive={isActive && !activeResource && !figureActive}
                key={`${note.id}:${note.textbook.revisionId}`}
                note={note}
                allNotes={allNotes}
                selectionSurface="flow"
                className="focus-flow-note-preview"
                onOpenKnowledge={onOpenKnowledge}
                onOpenDocument={(docId) => {
                  const existing = resources.find(resource => resource.documentId === docId);
                  const resource: ResourceItem = existing || { documentId: docId,
                    title: note.textbook?.sources?.find(source => source.kind === 'document' && source.id === docId)?.title || '教材引用资料', url: '', kind: 'local' };
                  if (!existing) setReferenceResources(previous => previous.some(item => item.documentId === docId) ? previous : [...previous, resource]);
                  handleSelectResource(resource);
                }}
                readingPosition={note.textbookReadingState?.revisionId === note.textbook.revisionId ? note.textbookReadingState : undefined}
                getReadingPosition={getTextbookReadingPosition}
                onReadingPosition={(position) => onTextbookReadingPosition?.(note.id, note.textbook!.revisionId, position)}
              /> : <PlainNoteReading noteId={note.id} title={note.title} content={note.content} citationIds={citationIds} active={isVisible && !activeResource && !figureActive} interactive={isActive && !activeResource && !figureActive}
                onWikiLink={openReadingWiki} headingRequest={readingHeading} onHeadingResolved={found => {
                  if (!found) setReadingNotice(`未找到章节「${readingHeading?.heading || ''}」，可继续阅读笔记。`);
                }} />}
              </InteractiveFigureContext.Provider>
            </div>}
            {figureTab && <div className="focus-flow-figure-host" style={!figureActive ? { display: 'none' } : undefined}>
              {figureState?.html && figureOptions.length > 1 && <div className="focus-flow-figure-caption"><label>选择交互图 <select aria-label="选择交互图" value={figureState.brief} onChange={event => openSavedFigure(event.target.value)}>
                {figureOptions.map(item => <option key={item.brief} value={item.brief}>{item.title}</option>)}
              </select></label></div>}
              {figureState?.html ? <><div className="focus-flow-figure-caption"><span>交互内容由模型生成，尚未自动验算；请结合教材核对结论。</span><button type="button" disabled={figureReview?.busy} onClick={reviewFigure} title="发送相邻教材及交互图进行一次额外模型请求">{figureReview?.busy ? '复核中…' : '模型复核（额外请求）'}</button><button type="button" onClick={() => prepareFigure(figureState.brief, true)}>{figureState.repairStatus === 'unresolved' ? '修复交互图' : '重新生成'}</button>{figureState.design && <details className="focus-flow-figure-teaching"><summary>教学目标与使用方法</summary><p><strong>目标：</strong><QuickCheckText text={figureState.design.goal} recoverPlainMath /></p><p><strong>操作：</strong><QuickCheckText text={figureState.design.action} recoverPlainMath />；<strong>观察：</strong><QuickCheckText text={figureState.design.observation} recoverPlainMath /></p><p><strong>依据与边界：</strong><QuickCheckText text={figureState.design.caveat} recoverPlainMath /></p></details>}{figureReview?.message && <div role="status"><span>{figureReview.message}</span>{figureReview.findings?.map((finding, index) => <p key={index}>{finding.message}（依据：{finding.quote}）</p>)}</div>}</div><InteractiveFigurePane html={figureState.html} active={isActive && figureActive} onRetry={() => prepareFigure(figureState.brief, true)} /></>
                : <div className="focus-flow-figure-status" role="status"><p>{figureState?.error || '正在准备交互探索，教材正文已保存，可随时返回阅读。'}</p>
                  {figureState?.error && !figureState.indexFailure && <button type="button" disabled={clearingFigure !== null} onClick={() => prepareFigure(figureState.brief, true)}>单独重试交互图</button>}
                  {figureState?.hasPrevious && <button type="button" disabled={clearingFigure !== null} onClick={() => restoreFigure(figureState.brief)}>恢复上一版</button>}
                  {figureState?.error && !figureState.indexFailure && <button type="button" disabled={clearingFigure !== null} onClick={() => clearUnfinishedFigure(figureState.brief)}>{figureState.hasPrevious ? '清理失败记录并恢复上一版' : '清理失败记录'}</button>}
                  {figureManagementError && <p role="alert">{figureManagementError}</p>}</div>}
            </div>}
            {!figureActive && activeResource && (activeResource.documentId ? (
              <LocalDocumentReader key={activeResource.documentId} documentId={activeResource.documentId}
                title={activeResource.title || '本地学习资料'} active={isActive} />
            ) : (
              <div className="focus-flow-webview-frame">
                <div className="focus-flow-webview-meta">
                  <span>{onlineResourceMeta(activeResource)}</span>
                  <button disabled={resourceOpen.pending} onClick={() => handleOpenResourceExternal(activeResource)}>
                    <ExternalLink aria-hidden="true" /> 在外部打开
                  </button>
                </div>
                {isResourcePartitionReady && activeResourcePartition
                  ? React.createElement('webview' as any, {
                    key: `${activeResource.url}:${activeResourcePartition}`,
                    src: activeResource.url,
                    className: 'flow-webview',
                    partition: activeResourcePartition,
                    ...(activeResource.kind === 'local' && activeResource.fileType === 'pdf'
                      ? { webpreferences: 'plugins=yes' }
                      : {}),
                  })
                  : <div className="flow-webview-loading">正在载入本地登录状态…</div>}
              </div>
            ))}
          </div>
        </section>

        <aside
          ref={notesPanelRef}
          className="focus-flow-notes"
          style={{ '--flow-resource-height': `${resourcePanelHeight}px` } as React.CSSProperties}
        >
          <div className="focus-flow-panel-heading">
            <div>
              <span className="focus-flow-eyebrow"><PenLine aria-hidden="true" /> 复述与笔记</span>
              <p>用自己的话复述，并梳理推理过程。</p>
            </div>
            <span className={`focus-flow-transcript-state is-${speechStatus}`}>
              {isListening ? '正在转写' : `已复述 ${speakingNotes.length} 次`}
            </span>
          </div>
          <section className="focus-flow-restate-card">
            <div className="focus-flow-note-card-title">
              <strong>我的复述</strong>
              <span>{sessionRestateText.trim().length} 字新增</span>
            </div>
            {isListening && activeVoiceTarget === 'restate' && (
              <div className="flow-speaking-indicator">
                <div className="flow-speaking-bars">
                  <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
                  <div className="flow-speaking-bar" /><div className="flow-speaking-bar" />
                  <div className="flow-speaking-bar" />
                </div>
                <span className="flow-speaking-text">正在聆听并实时转写</span>
              </div>
            )}
            <textarea
              ref={restateTextareaRef}
              className="flow-restate-textarea"
              disabled={!progressiveInputReady}
              placeholder="点击底部「开始语音复述」，也可以直接在此补充文字…"
              value={sessionRestateText}
              onChange={(event) => {
                const element = event.target;
                const next = element.value;
                restateCaretRef.current = element.selectionStart ?? element.value.length;
                updateRestateText(next);
              }}
            />
          </section>
          <section className={`focus-flow-summary-card ${isSummaryExpanded ? 'is-expanded' : ''}`}>
            <div className="focus-flow-summary-heading">
              <button onClick={() => setIsSummaryExpanded(value => !value)}>
                <span>本次总结</span>
                {isSummaryExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
              </button>
              <button
                className={`focus-flow-summary-voice ${isListening ? 'is-active' : ''}`}
                onClick={() => {
                  setIsSummaryExpanded(true);
                  if (isListening) void stopListeningAndSave();
                  else startListeningSession('summary');
                }}
              >
                {isListening ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
                {isListening ? (activeVoiceTarget === 'summary' ? '停止语音总结' : '停止语音复述') : '语音总结'}
              </button>
            </div>
            {isSummaryExpanded ? (
              <textarea
                className="flow-summary-textarea"
                value={summary}
                disabled={!progressiveInputReady}
                onChange={(event) => { summaryRef.current = event.target.value; setSummary(event.target.value);
                  progressiveController?.saveProgress({ summaryDraft: event.target.value }); }}
                placeholder="写下本次学习最重要的结论…"
              />
            ) : (
              <p>{summary || '结束前可在这里补充本次学习总结。'}</p>
            )}
          </section>
          <div
            className="focus-flow-side-resize-handle"
            role="separator"
            aria-label="调整复述区与资源区高度"
            aria-orientation="horizontal"
            aria-valuemin={96}
            aria-valuemax={420}
            aria-valuenow={Math.round(resourcePanelHeight)}
            tabIndex={0}
            title="上下拖动调整复述区与资源区高度，双击恢复默认"
            onMouseDown={handleResourcePanelResizeStart}
            onDoubleClick={() => setResourcePanelHeight(176)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              const delta = event.key === 'ArrowUp' ? 16 : -16;
              setResourcePanelHeight(height => clampResourcePanelHeight(height + delta));
            }}
          >
            <span aria-hidden="true" />
          </div>
          <section className={`focus-flow-side-resources ${isResourceShelfCollapsed ? 'is-collapsed' : ''}`}>
            <div className="focus-flow-side-resource-heading">
              <button aria-expanded={!isResourceShelfCollapsed} aria-controls={resourceShelfId} onClick={() => setIsResourceShelfCollapsed(value => !value)}>
                <BookOpen aria-hidden="true" />
                <span>学习资源</span>
                <em>{resources.length + figureOptions.length}</em>
                {isResourceShelfCollapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
              <small>点击后在中间打开标签</small>
            </div>
            <ResourceOpenFeedback feedback={resourceOpen.feedback} onRetry={handleOpenResourceExternal} />
            {resourceShelf.warning && <p role="status" className="focus-flow-side-resource-empty">{resourceShelf.warning}</p>}
            {!isResourceShelfCollapsed && (
                <div id={resourceShelfId} className="focus-flow-side-resource-list">
                  {resources.length === 0 && figureOptions.length === 0 && unfinishedFigures.length === 0 && <div className="focus-flow-side-resource-empty">当前项目及父级项目暂无资源，请先在笔记页添加。</div>}
                  {figureOptions.map(option => <article key={`figure:${option.brief}`} className={figureActive && figureState?.brief === option.brief ? 'is-active' : ''}>
                    <button className="focus-flow-side-resource-open" aria-label={`打开交互探索 ${option.title}`} title={option.title} onClick={() => {
                      setActiveResource(null); setFigureTab(true); setFigureActive(true);
                      if (figureState?.brief !== option.brief) openSavedFigure(option.brief);
                    }}>
                      <span><Sparkles aria-hidden="true" /></span>
                      <span><strong>{option.title}</strong><small>{figureState?.brief === option.brief && figureState.busy ? '生成中' : figureState?.brief === option.brief && figureState.error ? '需要重试' : figureTab && figureState?.brief === option.brief ? '已在中间打开' : '当前教材页 · 交互图'}</small></span>
                    </button>
                  </article>)}
                  {resourceShelf.entries.map(({ resource, ownerTitle, inherited, temporary }) => {
                    const key = resourceKey(resource);
                    const active = activeResource ? resourceKey(activeResource) === key : false;
                    const isOpen = openResourceKeys.includes(key);
                    const feedback = resourceState.feedback[makeResourceFeedbackKey(note.id, resource)]?.rating;
                    return (
                      <article key={key} className={active ? 'is-active' : ''}>
                        <button className="focus-flow-side-resource-open" title={`${resource.title || resource.url}；来源：${ownerTitle}`} onClick={() => handleSelectResource(resource)}>
                          <span>{resource.kind === 'local' || resource.documentId ? <FileText aria-hidden="true" /> : <Globe aria-hidden="true" />}</span>
                          <span>
                            <strong>{resource.title || resource.url}</strong>
                            <small>{isOpen ? '已在中间打开' : resource.kind === 'local' || resource.documentId ? '本地资料' : onlineResourceMeta(resource)}</small>
                            <small>{temporary ? '本次临时资源' : inherited ? `继承自：${ownerTitle}` : '当前项目'}</small>
                          </span>
                        </button>
                        <div className="focus-flow-side-resource-actions">
                          {([
                            ['helpful', '有帮助'],
                            ['completed', '已学完'],
                          ] as const).map(([rating, label]) => (
                            <button
                              key={rating}
                              aria-pressed={feedback === rating}
                              className={feedback === rating ? 'is-selected' : ''}
                              onClick={() => void handleResourceFeedback(resource, rating)}
                            >
                              {label}
                            </button>
                          ))}
                          <button title="在外部打开" disabled={resourceOpen.pending} onClick={() => handleOpenResourceExternal(resource)}><ExternalLink aria-hidden="true" /></button>
                        </div>
                      </article>
                    );
                  })}
                  {unfinishedFigures.length > 0 && <details className="focus-flow-unfinished-figures">
                    <summary>未完成交互图 · {unfinishedFigures.length}</summary>
                    {unfinishedFigures.map(item => <div className="focus-flow-unfinished-figure" key={item.brief}>
                      <span title={item.title}>{item.title}</span>
                      <button type="button" disabled={clearingFigure !== null} aria-label={`查看未完成交互图 ${item.title}`} onClick={() => { setActiveResource(null); setFigureTab(true); setFigureActive(true); if (figureState?.brief !== item.brief) openSavedFigure(item.brief); }}>查看</button>
                      <button type="button" disabled={clearingFigure !== null} aria-label={`${item.hasPrevious ? '清理并恢复上一版' : '清理失败记录'} ${item.title}`} onClick={() => clearUnfinishedFigure(item.brief)}>{clearingFigure === item.brief ? '清理中…' : item.hasPrevious ? '恢复上一版' : '清理'}</button>
                    </div>)}
                  </details>}
                  {figureManagementError && <p className="focus-flow-side-resource-empty" role="alert">{figureManagementError}</p>}
                </div>
            )}
          </section>
        </aside>
      </main>

      <footer className="focus-flow-controls">
        <button
          className={`focus-flow-record ${isListening ? 'is-recording' : ''}`}
          onClick={() => isListening ? void stopListeningAndSave() : startListeningSession('restate')}
          disabled={!progressiveInputReady}
        >
          {isListening ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
          <span>{isListening ? (activeVoiceTarget === 'summary' ? '停止语音总结' : '停止语音复述') : '开始语音复述'}</span>
        </button>
        <div className="focus-flow-wave" aria-label={isListening ? '正在录音' : '尚未开始录音'}>
          <span className="focus-flow-wave-bars" aria-hidden="true">
            {Array.from({ length: 14 }).map((_, index) => <i key={index} />)}
          </span>
          <span>{isListening ? '实时转写中' : '00:00'} / {formatTime(elapsedSeconds)}</span>
        </div>
        <div className="focus-flow-noise-control">
          <span>{NOISE_ICONS[noiseType]}</span>
          <label htmlFor="flow-noise-select">白噪音</label>
          <select id="flow-noise-select" value={noiseType} onChange={event => setNoiseType(event.target.value as WhiteNoiseType)}>
            {(Object.keys(NOISE_LABELS) as WhiteNoiseType[]).map(type => (
              <option key={type} value={type}>{NOISE_LABELS[type]}</option>
            ))}
          </select>
          {noiseType !== 'none' && (
            <label className="focus-flow-volume" title={`音量 ${Math.round(noiseVolume * 100)}%`}>
              <Volume2 aria-hidden="true" />
              <input
                aria-label="白噪音音量"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={noiseVolume}
                onChange={event => setNoiseVolume(Number(event.target.value))}
              />
            </label>
          )}
        </div>
        <div className="focus-flow-analysis-control">
          <div>
            <strong>复盘分析</strong>
            <span>{analyzeOnExit ? '退出保存后，选择知识点并查看分析结果' : '关闭后，仅保存本次记录'}</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={analyzeOnExit}
            className={analyzeOnExit ? 'is-on' : ''}
            onClick={() => setAnalyzeOnExit(value => !value)}
            title={analyzeOnExit ? '退出保存后选择知识点，再开始复盘分析' : '退出后只保存文本，不进行分析'}
          >
            <span />
          </button>
        </div>
        <button className="focus-flow-save-exit" onClick={handleExit} disabled={isExiting}>
          <ExternalLink aria-hidden="true" />
          <span>{isExiting ? '正在保存…' : '退出并保存'}</span>
        </button>
      </footer>

      {/* Timer Reminder Popup (text only, no input) */}
    </div>
    {isReviewing && createPortal(
      <div className="flow-review-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) setIsReviewing(false); }}>
        <div ref={reviewDialogRef} className="flow-review-prompt" role="dialog" aria-modal="true"
          aria-labelledby={reviewTitleId} aria-describedby={reviewDescriptionId} tabIndex={-1}>
          <div id={reviewTitleId} className="flow-review-title">学习复盘提醒</div>
          <div id={reviewDescriptionId} className="flow-review-subtitle">
            你已经学习了 {formatTime(elapsedSeconds)}，建议点击复述区「语音复盘」按钮用费曼学习法复述已学内容。
          </div>
          <div className="flow-review-actions" style={{ justifyContent: 'center' }}>
            <button type="button" className="flow-review-record" onClick={() => setIsReviewing(false)}>好的</button>
          </div>
        </div>
      </div>, document.body,
    )}
    </>
  );
};
