import React, { useState, useRef, useEffect, useMemo } from 'react';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { NoteItem, ChatMessage, ReviewMessage, ReviewAnalysis, KnowledgePointMasteryResult, ResourceItem, type LlmResponseDiagnostics } from '../types';
import { callLLMStream } from '../services/llmStreamService';
import { useSpeechRecognition } from '../services/speechRecognition';
import { parseJsonLenient, ReviewSegment, scoreReviewSegmentsInParallel, mergeSegmentResults } from '../services/reviewSegmentScoring';
import { scoreConceptEvidence, scoreJudgmentEvidence, scoreReasoningEvidence, determineMasteryLevel, computeLayeredMastery } from '../services/profile/scoring/threeLayer';
import { recordReviewActivity } from '../services/learningAbility/timelineStore';
import { collectKnowledgeHotwords } from '../services/sttHotwords';
import type { ReviewAnswerEvidence, ReviewDraftAnswer, ReviewEpisodeCapture } from '../services/memory/types';
import { clearReviewDraftsForNote, loadLearningEpisodes } from '../services/memory/episodeStore';
import { getReviewDraftForNote } from '../services/ui/reviewExitWrite';
import { buildReviewDraft, displayReviewDraftQuestion, readReviewDraftContext, reviewDraftQuestionKey, reviewDraftTutorPrompt } from '../services/reviewDraft';
import './ReviewRecovery.css';
import { captureReviewCognition } from '../services/cognition/store';
import { searchCurrentPersonalCognition } from '../services/cognition/store';
import {
  cognitionIntentCandidates,
  inheritReviewQuestionIntent,
  parseReviewTutorIntent,
  stripReviewIntentMarkers,
  type ReviewQuestionIntent,
} from '../services/reviewIntent';
import { buildProjectReviewKnowledgeContext, collectProjectKnowledgeNotes } from '../services/knowledgePointSelector';
import { buildReviewReferenceCatalog, recheckQuestionReferenceRubric } from '../services/reviewReferenceRubric';
import { buildReviewTutorContext } from '../services/reviewTutorContext';
import { resolveNoteByTitleOrAlias } from '../services/noteResolver';
import {
  calibrateProjectMasteryByHints,
  normalizeReviewAnalysis,
  reviewEvidenceRequirement,
  summarizeReviewEvidence,
} from '../services/reviewEvidence';
import { useResourceOpen } from './useResourceOpen';
import { ResourceOpenFeedback } from './ResourceOpenFeedback';
import { prepareReviewComparisonSession, recheckReviewComparisonSession } from '../services/reviewComparison/session';
import { reviewComparisonDependencies } from '../services/reviewComparison/client';
import { createReviewArgumentQuestionClient } from '../services/argumentContext/questionBindingClient';
import type { ReviewComparisonSession } from '../services/reviewComparison/types';
import { masteryReadMode, readKnowledgeMastery } from '../services/masteryReadModel';
import { planReviewMastery, applyReviewMasteryBatch, recheckReviewMasteryReferences, withReviewMasteryDisplayStates, type ReviewMasteryBatch } from '../services/masteryShadow/review';
import { evaluateReviewMasteryWithModel, evaluateReviewFeedbackWithModel } from '../services/masteryShadow/reviewClient';
import { reviewFeedbackFromCriteria, type ReviewSessionFeedback } from '../services/masteryShadow/reviewFeedback';
import { ReviewMasteryResults } from './ReviewMasteryResults';
import { ReviewPerformanceSummary } from './ReviewPerformanceSummary';
import { ReviewFeedbackSummary } from './ReviewFeedbackSummary';
import { ReviewResultHeading } from './ReviewResultHeading';
import { LogiNoteLogoMark } from './LogiNoteLogo';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  FolderOpen,
  HelpCircle,
  Lightbulb,
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Square,
  UserRound,
} from 'lucide-react';

interface ReviewChatProps {
  noteId: string;
  noteTitle: string;
  questionText: string;
  knowledgeContext: string;
  allNotes: NoteItem[];
  onReviewComplete: (analysis: ReviewAnalysis | null, segmentMastery?: KnowledgePointMasteryResult[], episode?: ReviewEpisodeCapture) => void | Promise<void>;
  onQuickCheckAfterSave?: (noteId: string) => void;
  previewMessages?: ReviewMessage[];
  previewEvidence?: ReviewAnswerEvidence[];
  previewElapsedSeconds?: number;
  previewSavedDraft?: ReviewDraftAnswer;
  /** An isolated UI fixture: editing/recovery and the supplied mock exit callback only. */
  previewOnly?: boolean;
  onExitSaveStateChange?: (state: 'saving' | 'failed' | 'idle', sessionId: string) => void;
}

interface ReviewTraceStep {
  id: string;
  round: number;
  title: string;
  description: string;
  target: string;
  hintLevel: number;
  consultedMaterialCount: number;
  status: 'complete' | 'active';
}

type ReviewMaterial =
  | { id: string; kind: 'note'; title: string; description: string; sourceTitle: string }
  | { id: string; kind: 'resource'; title: string; description: string; sourceTitle: string; resource: ResourceItem };

const REVIEW_PACING_ROUNDS = 7;

function compactPlainText(value: string, max = 110): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function inferThinkingStage(question: string, round: number): string {
  if (/(?:条件|前提|假设|成立|范围)/u.test(question)) return '识别条件';
  if (/(?:区别|比较|联系|关系|相同|不同)/u.test(question)) return '建立关联';
  if (/(?:为什么|理由|依据|导致|因果)/u.test(question)) return '解释推理';
  if (/(?:结论|判断|合理|反例|例外)/u.test(question)) return '检验结论';
  if (/(?:应用|情境|案例|迁移|如果|变化)/u.test(question)) return '迁移应用';
  return round === 1 ? '自由回忆' : '深化理解';
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function describeEmptyTutorResponse(diagnostics?: LlmResponseDiagnostics): string {
  const reason = diagnostics?.finishReason;
  if (reason === 'length' || (diagnostics?.reasoningTokens || 0) > 0 || diagnostics?.hadReasoningContent) {
    return `导师模型在思考阶段耗尽了输出额度，连续两次没有生成可显示的问题${diagnostics?.reasoningTokens ? `（推理 ${diagnostics.reasoningTokens} tokens）` : ''}。请再次发送，或在模型设置中换用非思考模型。`;
  }
  if (reason === 'content_filter' || reason === 'SAFETY') return '导师回复被模型供应商拦截，自动重试后仍没有可显示内容。请调整回答措辞后重试。';
  return `导师模型连续两次返回空正文${reason ? `（结束原因：${reason}）` : ''}。本轮没有保存空提问，请再次发送。`;
}

const MASTERY_LEVEL_LABEL: Record<string, string> = {
  none: '未形成有效证据',
  concept: '概念层',
  judgment: '判断层',
  reasoning: '推理层',
};

export const ReviewChat: React.FC<ReviewChatProps> = ({
  noteId,
  noteTitle,
  questionText,
  knowledgeContext: initialKnowledgeContext,
  allNotes,
  onReviewComplete,
  previewMessages = [],
  previewEvidence = [],
  previewElapsedSeconds = 0,
  previewSavedDraft,
  previewOnly = false,
  onExitSaveStateChange,
  onQuickCheckAfterSave,
}) => {
  const [messages, setMessages] = useState<ReviewMessage[]>(() => [...previewMessages]);
  const [knowledgeContext, setKnowledgeContext] = useState(initialKnowledgeContext);
  const [userInput, setUserInput] = useState('');
  const userInputRef = useRef('');
  const draftAnswerRef = useRef<ReviewDraftAnswer | undefined>(undefined);
  const consumedDraftIdsRef = useRef(new Set<string>());
  const [isTutorResponding, setIsTutorResponding] = useState(false);
  const [isScoring, setIsScoring] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [isSavingCognition, setIsSavingCognition] = useState(false);
  const [cognitionError, setCognitionError] = useState('');
  const [exitSaveError, setExitSaveError] = useState('');
  const [recoverableDraft, setRecoverableDraft] = useState<ReviewDraftAnswer | null>(previewSavedDraft || null);
  const [draftLoadError, setDraftLoadError] = useState('');
  const [draftReadVersion, setDraftReadVersion] = useState(0);
  const [isDiscardingDraft, setIsDiscardingDraft] = useState(false);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  const answerInputRef = useRef<HTMLTextAreaElement>(null);
  const exitErrorRef = useRef<HTMLDivElement>(null);
  const finishEndedAtRef = useRef<string | undefined>(undefined);
  const finishLock = useRef(false);
  const finishedRef = useRef(false);
  const tutorOperationRef = useRef(false);
  const reviewComparisonRef = useRef<ReviewComparisonSession | undefined>(undefined);
  const reviewMasteryRef = useRef<ReviewMasteryBatch | undefined>(undefined);
  const sessionIdRef = useRef(`review-${crypto.randomUUID()}`);
  const argumentQuestionClient = useMemo(() => createReviewArgumentQuestionClient(noteId, sessionIdRef.current,
    previewOnly ? () => undefined : undefined), [noteId, previewOnly]);
  useEffect(() => {
    if (previewOnly || previewMessages.length > 0 || previewSavedDraft) return;
    let cancelled = false;
    setDraftLoadError('');
    void loadLearningEpisodes().then((episodes) => {
      if (!cancelled) setRecoverableDraft(getReviewDraftForNote(episodes, noteId)?.draft || null);
    }).catch(() => {
      if (!cancelled) setDraftLoadError('未能读取上次未发送的回答，可以重试；当前回答不受影响。');
    });
    return () => { cancelled = true; };
  }, [noteId, draftReadVersion, previewMessages.length, previewSavedDraft, previewOnly]);
  useEffect(() => { if (exitSaveError) exitErrorRef.current?.focus({ preventScroll: true }); }, [exitSaveError]);
  const updateUserInput = (text: string) => {
    userInputRef.current = text;
    setUserInput(text);
  };
  const [finalAnalysis, setFinalAnalysis] = useState<ReviewAnalysis | null>(null);
  const [sessionFeedback, setSessionFeedback] = useState<ReviewSessionFeedback | undefined>();
  const reviewFeedbackRef = useRef<ReviewSessionFeedback | undefined>(undefined);
  const [segmentMasteryResults, setSegmentMasteryResults] = useState<KnowledgePointMasteryResult[]>([]);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(previewElapsedSeconds);
  const [expandedMaterialId, setExpandedMaterialId] = useState<string | null>(null);
  const [consultedMaterialIds, setConsultedMaterialIds] = useState<string[]>([]);
  const materialOpen = useResourceOpen(`${noteId}:${[...messages].reverse().find(message => message.role === 'tutor')?.id || 'initial'}`);
  const { isListening, modelReady, warmup, startListening, stopListening } = useSpeechRecognition();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionStartedAtRef = useRef(new Date().toISOString());
  const isProjectReview = useMemo(() => allNotes.some(n => n.id === noteId && n.noteType === 'project'), [allNotes, noteId]);
  const projectKnowledgeNotes = useMemo(
    () => isProjectReview ? collectProjectKnowledgeNotes(noteId, allNotes) : [],
    [allNotes, isProjectReview, noteId],
  );
  const openingQuestion = useMemo(() => parseReviewTutorIntent(questionText, {
    questionMessageId: 'tutor-0',
    allowedKnowledgeTargets: isProjectReview ? projectKnowledgeNotes.map((note) => note.title) : [noteTitle],
    fallbackKnowledgeTargets: isProjectReview ? [] : [noteTitle],
  }), [isProjectReview, noteTitle, projectKnowledgeNotes, questionText]);
  const reviewNote = useMemo(() => allNotes.find((note) => note.id === noteId) || null, [allNotes, noteId]);
  const recoverableContext = useMemo(() => recoverableDraft ? readReviewDraftContext(recoverableDraft) : undefined, [recoverableDraft]);
  const reviewMaterials = useMemo<ReviewMaterial[]>(() => {
    if (!reviewNote) return [];
    const ownerNotes = [reviewNote, ...(isProjectReview ? projectKnowledgeNotes : [])];
    const noteMaterials = ownerNotes.slice(0, isProjectReview ? 4 : 1).map((note) => ({
      id: `note:${note.id}`,
      kind: 'note' as const,
      title: note.title,
      description: compactPlainText(note.content, 600) || '这篇笔记暂时没有正文摘要。',
      sourceTitle: note.id === reviewNote.id ? '当前复习笔记' : '关联知识点',
    }));
    const seen = new Set<string>();
    const resourceMaterials: ReviewMaterial[] = [];
    ownerNotes.forEach((owner) => {
      (owner.resources || []).forEach((resource) => {
        const key = resource.documentId || resource.url;
        if (!key || seen.has(key)) return;
        seen.add(key);
        resourceMaterials.push({
          id: `resource:${key}`,
          kind: 'resource',
          title: resource.title || resource.url,
          description: resource.reason || resource.description || resource.platform || (resource.kind === 'local' ? '本地资料' : '在线资料'),
          sourceTitle: owner.title,
          resource,
        });
      });
    });
    return [...noteMaterials, ...resourceMaterials].slice(0, 8);
  }, [isProjectReview, projectKnowledgeNotes, reviewNote]);
  // 片段列表：按「提问意图」切段，每个片段记录目标知识点 + 学生回答原文
  const segmentsRef = useRef<ReviewSegment[]>([]);
  // 上一个提问的意图（初始化提问无意图，初值 []）
  const lastIntentRef = useRef<string[]>([...(previewEvidence.at(-1)?.targetKnowledgeNames || [])]);
  const lastQuestionIntentRef = useRef<ReviewQuestionIntent>(previewEvidence.at(-1)?.questionIntent || openingQuestion.intent);
  const currentQuestionTextRef = useRef(openingQuestion.cleanText);
  const answerEvidenceRef = useRef<ReviewAnswerEvidence[]>([...previewEvidence]);
  const draftMatchesQuestion = Boolean(recoverableContext
    && reviewDraftQuestionKey(recoverableContext.questionText) === reviewDraftQuestionKey(currentQuestionTextRef.current));
  const canResumeOriginalQuestion = Boolean(recoverableContext && !messages.some(message => message.role === 'user'));

  const handleRestoreDraft = async () => {
    if (!recoverableDraft || !recoverableContext || userInputRef.current.trim() || isDiscardingDraft
      || tutorOperationRef.current || isTutorResponding || isScoring || isSavingCognition || exitSaveError
      || (!draftMatchesQuestion && !canResumeOriginalQuestion)) return;
    const draft = recoverableDraft;
    const context = recoverableContext;
    const allowed = new Set(isProjectReview ? projectKnowledgeNotes.map(note => note.title) : [noteTitle]);
    if (context.questionIntent.knowledgeTargets.some(target => !allowed.has(target))) {
      setDraftLoadError('原题关联的知识点已变更，请先查看原题回答；原文仍保留。');
      setDraftPreviewOpen(true);
      return;
    }
    const restoredIntent = structuredClone(context.questionIntent);
    restoredIntent.questionMessageId = lastQuestionIntentRef.current.questionMessageId;
    if (!draftMatchesQuestion || (context.tutorPrompt && !messages.some(message => message.role === 'user'))) {
      // Resume the original question explicitly; never apply its answer to the newly selected card.
      const id = `tutor-draft-${crypto.randomUUID()}`;
      restoredIntent.questionMessageId = id;
      const content = displayReviewDraftQuestion(context);
      setMessages([{ id, role: 'tutor', content, timestamp: new Date().toISOString() }]);
      setKnowledgeContext(isProjectReview && reviewNote
        ? `${buildProjectReviewKnowledgeContext(reviewNote, allNotes)}\n\n本次继续此前保存的原题：\n${context.questionText}`
        : initialKnowledgeContext);
    }
    currentQuestionTextRef.current = context.questionText;
    lastQuestionIntentRef.current = restoredIntent;
    lastIntentRef.current = [...restoredIntent.knowledgeTargets];
    draftAnswerRef.current = buildReviewDraft({ id: `draft-${sessionIdRef.current}`, content: draft.content,
      context: { ...context, questionIntent: restoredIntent } });
    consumedDraftIdsRef.current.add(draft.id);
    updateUserInput(draft.content);
    setHintLevel(current => Math.max(current, context.hintLevel) as 0 | 1 | 2 | 3 | 4);
    setConsultedMaterialIds(current => [...new Set([...current, ...context.consultedMaterialIds])]);
    setRecoverableDraft(null);
    setDraftPreviewOpen(false);
    answerInputRef.current?.focus();
  };

  const handleDiscardDraft = async () => {
    if (!recoverableDraft || isDiscardingDraft || isSavingCognition || isTutorResponding || isScoring || finishLock.current) return;
    const draft = recoverableDraft;
    setIsDiscardingDraft(true);
    setDraftLoadError('');
    try {
      if (!previewOnly) await clearReviewDraftsForNote(noteId, [draft.id]);
      setRecoverableDraft(current => current?.id === draft.id ? null : current);
      setDraftPreviewOpen(false);
    } catch {
      setDraftLoadError('草稿未能丢弃，原文仍保留，请重试。');
    } finally { setIsDiscardingDraft(false); }
  };

  const sameIntentSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((t) => b.includes(t));

  /** 把学生回答并入「目标知识点集合」对应的片段；不存在则新建 */
  const appendToSegment = (targets: string[], answer: string, answerHintLevel: number) => {
    const list = segmentsRef.current;
    const scoredText = `[提示级别:${answerHintLevel}] ${answer}`;
    for (let i = list.length - 1; i >= 0; i--) {
      if (sameIntentSet(list[i].knowledgePointNames, targets)) {
        list[i] = { ...list[i], text: list[i].text ? `${list[i].text}\n${scoredText}` : scoredText };
        return;
      }
    }
    list.push({ knowledgePointNames: [...targets], text: scoredText });
  };

  const normalizeProjectTargets = (targets: string[]): string[] => [...new Set(targets.flatMap((target) => {
    const note = resolveNoteByTitleOrAlias(target, projectKnowledgeNotes);
    return note ? [note.title] : [];
  }))];

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Start session on mount — send initial Socratic opening
  useEffect(() => {
    if (previewOnly || previewMessages.length > 0) return;

    let cancelled = false;
    tutorOperationRef.current = true;
    setIsTutorResponding(true);
    const installOpening = async () => {
      const scopeNotes = isProjectReview ? projectKnowledgeNotes : allNotes.filter((note) => note.id === noteId && note.noteType === 'knowledge');
      const notes = await reviewComparisonDependencies.readNotes().catch(() => []);
      const catalog = await buildReviewReferenceCatalog(notes, openingQuestion.intent.knowledgeTargets, scopeNotes.map((note) => note.id));
      const parsed = parseReviewTutorIntent(questionText, { questionMessageId: 'tutor-0',
        allowedKnowledgeTargets: isProjectReview ? projectKnowledgeNotes.map((note) => note.title) : [noteTitle],
        fallbackKnowledgeTargets: isProjectReview ? [] : [noteTitle], referenceCatalog: catalog });
      if (parsed.intent.referenceRubric) parsed.intent.referenceRubric = await recheckQuestionReferenceRubric(parsed.intent.referenceRubric, reviewComparisonDependencies.readNotes);
      parsed.intent.referenceStructure = await argumentQuestionClient.freeze(parsed.intent);
      if (cancelled) return;
      // A generic program opening has no semantic reference selection: do not invent it from headings or the later answer.
      lastQuestionIntentRef.current = structuredClone(parsed.intent);
      lastIntentRef.current = [...parsed.intent.knowledgeTargets];
      setMessages([{ id: 'tutor-0', role: 'tutor', content: parsed.cleanText, timestamp: new Date().toISOString() }]);
    };
    void installOpening().catch(() => {
      if (cancelled) return;
      // Optional reference preparation must not leave an empty tutor or block the learning activity.
      // Drop the task marker rather than falling back to a supposedly fixed reference-free standard.
      const fallback = parseReviewTutorIntent(openingQuestion.cleanText, { questionMessageId: 'tutor-0',
        allowedKnowledgeTargets: isProjectReview ? projectKnowledgeNotes.map((note) => note.title) : [noteTitle],
        fallbackKnowledgeTargets: isProjectReview ? [] : [noteTitle] });
      lastQuestionIntentRef.current = fallback.intent;
      lastIntentRef.current = [...fallback.intent.knowledgeTargets];
      setMessages([{ id: 'tutor-0', role: 'tutor', content: fallback.cleanText, timestamp: new Date().toISOString() }]);
      setError('本题参考依据暂未准备好，可继续复习；新评分核对暂缓，笔记和分数未改动。');
    }).finally(() => { if (!cancelled) { tutorOperationRef.current = false; setIsTutorResponding(false); } });
    return () => { cancelled = true; };
    // This is the initial session snapshot, not a background restart when notes update during its saved-source read.
  }, []);

  useEffect(() => {
    if (sessionEnded) return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [sessionEnded]);

  // 进入复习页面即预加载语音模型（后台静默，不阻塞打字）
  useEffect(() => {
    if (!previewOnly) warmup();
  }, [warmup, previewOnly]);

  const handleVoiceToggle = async () => {
    if (previewOnly || finishLock.current || exitSaveError) return;
    if (isListening) {
      // final 现为空信号，正文已由 partial 逐句写入，无需再取返回值
      await stopListening();
    } else if (modelReady) {
      // 每说一句（停顿）就把这句话追加到输入框
      startListening((text) => updateUserInput(userInputRef.current + text), collectKnowledgeHotwords(allNotes));
    }
  };

  const streamTutorResponse = async (prompt: string): Promise<{ tutorId: string; content: string }> => {
    if (previewOnly) throw new Error('交互预览不调用导师模型。');
    setIsTutorResponding(true);
    setError(null);
    const tutorId = `tutor-${Date.now()}`;
    setMessages((current) => [...current, {
      id: tutorId, role: 'tutor', content: '', timestamp: new Date().toISOString(), isStreaming: true,
    }]);
    try {
      let lastDiagnostics: LlmResponseDiagnostics | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        let content = '';
        lastDiagnostics = undefined;
        if (attempt > 0) setMessages((current) => current.map((message) => message.id === tutorId ? { ...message, content: '', isStreaming: true } : message));
        const stream = await callLLMStream({ providerId: '', model: '', workflow: 'review-tutor', userInput: prompt,
          skipMemoryInjection: true, skipProfileInjection: true, thinkingMode: 'disabled' });
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === 'diagnostics') { lastDiagnostics = value.diagnostics; continue; }
            content += value.text;
            setMessages((current) => current.map((message) => message.id === tutorId
              ? { ...message, content, isStreaming: true }
              : message));
          }
        } finally {
          reader.releaseLock();
        }
        const visibleContent = stripReviewIntentMarkers(content).trim();
        if (visibleContent) return { tutorId, content };
      }
      throw new Error(describeEmptyTutorResponse(lastDiagnostics));
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== tutorId));
      throw error;
    }
    // The caller keeps the operation locked while freezing the question baseline,
    // or inheriting the old one for a hint/rephrase. Do not unlock after streaming.
  };

  const handleSendMessage = async () => {
    if (previewOnly || materialOpen.isBusy() || tutorOperationRef.current || isTutorResponding || isScoring || sessionEnded || finishLock.current || exitSaveError) return;
    tutorOperationRef.current = true;
    setIsTutorResponding(true);
    if (isListening) await stopListening();
    const text = userInputRef.current.trim();
    if (!text || text.length > 800) {
      tutorOperationRef.current = false;
      setIsTutorResponding(false);
      if (text.length > 800) setError('回答超过 800 字，请分段发送；完整原文仍保留在输入框，退出时会保存为草稿。');
      return;
    }
    reviewComparisonRef.current = undefined;
    const userMsg: ReviewMessage = {
      id: `user-${crypto.randomUUID()}`, role: 'user', content: text, timestamp: new Date().toISOString(),
    };
    const targets = [...lastIntentRef.current];
    const effectiveHintLevel = Math.max(hintLevel, consultedMaterialIds.length > 0 ? 3 : 0) as 0 | 1 | 2 | 3 | 4;
    const evidence: ReviewAnswerEvidence = {
      messageId: userMsg.id,
      answer: text,
      hintLevel: effectiveHintLevel,
      targetKnowledgeNames: targets,
      questionIntent: {
        ...inheritReviewQuestionIntent(lastQuestionIntentRef.current, lastQuestionIntentRef.current.questionMessageId),
        knowledgeTargets: targets,
      },
      ...(consultedMaterialIds.length > 0 ? { consultedMaterialIds: [...consultedMaterialIds] } : {}),
    };
    answerEvidenceRef.current.push(evidence);
    if (isProjectReview && targets.length > 0) appendToSegment(targets, text, effectiveHintLevel);

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    updateUserInput('');
    draftAnswerRef.current = undefined;
    setConsultedMaterialIds([]);
    setExpandedMaterialId(null);

    try {
      const reanswerSameTarget = effectiveHintLevel >= 3;
      let intentCandidates = [] as ReturnType<typeof cognitionIntentCandidates>;
      try {
        if (!reanswerSameTarget) {
          const query = [...targets, noteTitle, text].filter(Boolean).join(' ').slice(0, 1000);
          intentCandidates = cognitionIntentCandidates(await searchCurrentPersonalCognition(query));
        }
      } catch {
        // Personal cognition is an optional review context. Failure must not block the learning activity.
      }
      const allowedKnowledgeTargets = isProjectReview ? projectKnowledgeNotes.map((note) => note.title) : [noteTitle];
      const referenceNotes = reanswerSameTarget ? [] : await reviewComparisonDependencies.readNotes().catch(() => []);
      const referenceCatalog = reanswerSameTarget ? undefined : await buildReviewReferenceCatalog(referenceNotes, allowedKnowledgeTargets,
        isProjectReview ? projectKnowledgeNotes.map((note) => note.id) : [noteId], targets.join(' '));
      const tutorContext = buildReviewTutorContext(reanswerSameTarget ? {
        mode: 'unaided-reanswer', noteTitle, knowledgeContext, messages: updatedMessages, currentIntent: evidence.questionIntent!,
        hintLevel: effectiveHintLevel as 3 | 4, consultedMaterialCount: evidence.consultedMaterialIds?.length,
      } : {
        mode: 'next-question', noteTitle, knowledgeContext, messages: updatedMessages, currentIntent: evidence.questionIntent!,
        isProjectReview, allowedKnowledgeTargets, cognitionCandidates: intentCandidates, referenceCatalog,
        criterionFocus: [...(isProjectReview ? projectKnowledgeNotes : allNotes.filter(note => note.id === noteId))]
          .sort((a, b) => Number(targets.includes(b.title)) - Number(targets.includes(a.title)))
          .slice(0, 2).map(note => ({ knowledgeTarget: note.title,
            pendingIds: Object.values(readKnowledgeMastery(note).criterionProgress || {}).flatMap(progress => progress.pendingIds) })),
        hintLevel: effectiveHintLevel as 0 | 1 | 2, consultedMaterialCount: evidence.consultedMaterialIds?.length,
      });
      const { tutorId, content } = await streamTutorResponse(tutorContext.userInput);
      const parsed = parseReviewTutorIntent(content, {
        questionMessageId: tutorId,
        allowedKnowledgeTargets,
        fallbackKnowledgeTargets: isProjectReview ? [] : [noteTitle],
        cognitionCandidates: intentCandidates,
        referenceCatalog,
      });
      const displayContent = parsed.cleanText;
      const nextIntent = reanswerSameTarget
        ? inheritReviewQuestionIntent(evidence.questionIntent!, tutorId)
        : parsed.intent;
      if (!reanswerSameTarget && nextIntent.referenceRubric) {
        nextIntent.referenceRubric = await recheckQuestionReferenceRubric(nextIntent.referenceRubric, reviewComparisonDependencies.readNotes);
      }
      const validTargets = isProjectReview ? normalizeProjectTargets(nextIntent.knowledgeTargets) : nextIntent.knowledgeTargets;
      nextIntent.knowledgeTargets = validTargets;
      if (!reanswerSameTarget) nextIntent.referenceStructure = await argumentQuestionClient.freeze(nextIntent);
      // 新问题没有合法目标时清空归属，避免把下一轮回答误记到上一知识点。
      lastIntentRef.current = validTargets;
      lastQuestionIntentRef.current = { ...nextIntent, knowledgeTargets: validTargets };
      if (!reanswerSameTarget) currentQuestionTextRef.current = displayContent;
      setHintLevel(0);
      setMessages((current) => current.map((message) => message.id === tutorId
        ? { ...message, content: displayContent, isStreaming: false }
        : message));
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(err?.message || '导师回复失败');
    } finally {
      tutorOperationRef.current = false;
      setIsTutorResponding(false);
    }
  };

  const requestTutorSupport = async (kind: 'rephrase' | 'hint' | 'unknown') => {
    if (previewOnly || materialOpen.isBusy() || tutorOperationRef.current || isTutorResponding || isScoring || sessionEnded || finishLock.current || exitSaveError) return;
    tutorOperationRef.current = true;
    setIsTutorResponding(true);
    const nextHint = kind === 'rephrase'
      ? hintLevel
      : Math.min(4, kind === 'unknown' ? Math.max(3, hintLevel) : hintLevel + 1) as 0 | 1 | 2 | 3 | 4;
    try {
      const tutorContext = buildReviewTutorContext({ mode: 'support', noteTitle, knowledgeContext, messages,
        currentIntent: lastQuestionIntentRef.current, kind, nextHintLevel: nextHint });
      const { tutorId, content } = await streamTutorResponse(tutorContext.userInput);
      const displayContent = stripReviewIntentMarkers(content);
      lastQuestionIntentRef.current = inheritReviewQuestionIntent(lastQuestionIntentRef.current, tutorId);
      setMessages((current) => current.map((message) => message.id === tutorId
        ? { ...message, content: displayContent, isStreaming: false }
        : message));
      setHintLevel(nextHint);
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(err?.message || '提示请求失败');
    } finally {
      tutorOperationRef.current = false;
      setIsTutorResponding(false);
    }
  };

  const handleEndSession = async () => {
    if (previewOnly || materialOpen.isBusy() || tutorOperationRef.current || isTutorResponding || isScoring || sessionEnded || messages.length < 2 || finishLock.current || exitSaveError) return;
    setIsScoring(true);
    setError(null);

    try {
      const evidenceSummary = summarizeReviewEvidence(answerEvidenceRef.current);
      if (masteryReadMode() === 'current' && !evidenceSummary.answerCount) {
        setError('请先提交一条回答，再生成本次反馈。');
        return;
      }
      if (masteryReadMode() === 'legacy' && !evidenceSummary.masteryEligible) {
        setError(`复习证据还不足：${reviewEvidenceRequirement(evidenceSummary)}`);
        return;
      }
      // Source preparation is shared; semantic mastery and personal cognition remain separate consumers.
      if (previewMessages.length === 0) {
        await argumentQuestionClient.verifyAnswers(answerEvidenceRef.current).catch(() => {
          console.warn('[Review] 可选结构核验暂不可用，继续本次语义反馈。');
        });
        try {
          reviewComparisonRef.current = await prepareReviewComparisonSession({
            id: sessionIdRef.current, startedAt: sessionStartedAtRef.current, endedAt: new Date().toISOString(),
            questionText: openingQuestion.cleanText, knowledgeContext,
            messages: messages.map((message) => ({ id: message.id, role: message.role === 'tutor' ? 'assistant' : 'user',
              content: message.content, timestamp: message.timestamp })),
            answerEvidence: answerEvidenceRef.current,
          }, reviewComparisonDependencies, {
            targetScopeNoteIds: isProjectReview ? projectKnowledgeNotes.map((note) => note.id) : [noteId],
          });
        } catch {
          reviewComparisonRef.current = { packets: [], summary: { version: 1, status: 'unavailable', preparedAnswers: 0,
            omittedAnswers: answerEvidenceRef.current.length, referencesAvailable: 0, cognitionTargetsResolved: 0,
            holdReasons: ['comparison_preparation_failed'], snapshots: [] } };
        }
      }
      if (masteryReadMode() === 'current') {
        const episode: ReviewEpisodeCapture = { id: sessionIdRef.current, startedAt: sessionStartedAtRef.current,
          endedAt: new Date().toISOString(), questionText: openingQuestion.cleanText, knowledgeContext,
          messages: messages.map(message => ({ id: message.id, role: message.role === 'tutor' ? 'assistant' : 'user',
            content: message.content, timestamp: message.timestamp })),
            answerEvidence: answerEvidenceRef.current, masteryEligible: evidenceSummary.masteryEligible };
        let feedback: ReviewSessionFeedback | undefined;
        try {
          const batch = planReviewMastery(allNotes, noteId, episode, reviewComparisonRef.current || { packets: [],
            summary: { version: 1, status: 'unavailable', preparedAnswers: 0, omittedAnswers: 0, referencesAvailable: 0,
              cognitionTargetsResolved: 0, holdReasons: [], snapshots: [] } });
          reviewMasteryRef.current = await evaluateReviewMasteryWithModel(batch);
          const projection = applyReviewMasteryBatch(allNotes, noteId, { ...episode, masteryAssessment: reviewMasteryRef.current });
          setSegmentMasteryResults(withReviewMasteryDisplayStates(projection.results, allNotes, noteId, episode));
          feedback = reviewFeedbackFromCriteria(reviewMasteryRef.current);
          // Reuse successful criterion feedback; only incomplete sessions need one bounded semantic fallback.
          if (!feedback || batch.warnings.length || reviewMasteryRef.current.items.some(item => item.error)) {
            const fallback = await evaluateReviewFeedbackWithModel(episode);
            if (fallback.status === 'available' || !feedback) feedback = fallback;
          }
        } catch {
          reviewMasteryRef.current = undefined;
          setSegmentMasteryResults(withReviewMasteryDisplayStates([], allNotes, noteId, episode));
          feedback = await evaluateReviewFeedbackWithModel(episode);
        }
        reviewFeedbackRef.current = feedback;
        setSessionFeedback(feedback);
        setFinalAnalysis(null); // Current mode must never synthesize or request the retired four scores.
        setSessionEnded(true);
        return;
      }

      // 历史回退模式：保留原整段与分段评分，新版不会进入此分支。
      if (isProjectReview && masteryReadMode() === 'legacy') {
        if (segmentsRef.current.length > 0) {
          try {
            const segResults = await scoreReviewSegmentsInParallel(segmentsRef.current);
            const merged = mergeSegmentResults(segResults);
            setSegmentMasteryResults(calibrateProjectMasteryByHints(merged, answerEvidenceRef.current));
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
      const evidenceText = answerEvidenceRef.current.map((item, index) => (
        `${index + 1}. 提示级别 ${item.hintLevel}/4；目标 ${item.targetKnowledgeNames.join('、') || '项目整体'}；回答 ${item.answer}`
      )).join('\n');

      const prompt = `知识点：${knowledgeContext}\n所属笔记：${noteTitle}\n\n完整对话历史：\n${historyText}\n\n作答证据与提示依赖：\n${evidenceText}\n\n请基于学生自己产生的证据评估掌握程度并输出 JSON。不要把导师在强提示中提供的内容当成学生的独立掌握证据。`;

      const stream = await callLLMStream({
        providerId: '',
        model: '',
        workflow: 'review-scoring',
        userInput: prompt,
        thinkingMode: 'disabled',
      });

      const reader = stream.getReader();
      let fullContent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          fullContent += value.text;
        }
      } finally {
        reader.releaseLock();
      }

      // Parse JSON from streamed response（容错解析 + 失败时暴露原始返回）
      try {
        const parsed = normalizeReviewAnalysis(parseJsonLenient(fullContent));
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

  const handleFinishReview = async (skipCognition = false) => {
    if (materialOpen.isBusy() || finishLock.current || finishedRef.current || isScoring || isTutorResponding || isDiscardingDraft) return;
    if (!allowCognitionLeave()) return;
    finishLock.current = true;
    setIsSavingCognition(true); setCognitionError(''); setExitSaveError('');
    try {
      onExitSaveStateChange?.('saving', sessionIdRef.current);
      // stopListening awaits the final partial callback; the ref includes text received during that await.
      if (!previewOnly && isListening) await stopListening();
      const rawDraft = userInputRef.current;
      const tutorPrompt = reviewDraftTutorPrompt([...messages].reverse().find(message => message.role === 'tutor')?.content, draftAnswerRef.current);
      draftAnswerRef.current = rawDraft.trim() ? buildReviewDraft({
        id: `draft-${sessionIdRef.current}`, content: rawDraft, previous: draftAnswerRef.current,
        context: { version: 1,
          questionText: currentQuestionTextRef.current,
          ...(tutorPrompt && reviewDraftQuestionKey(tutorPrompt) !== reviewDraftQuestionKey(currentQuestionTextRef.current) ? { tutorPrompt } : {}),
          questionIntent: lastQuestionIntentRef.current, hintLevel, consultedMaterialIds: [...consultedMaterialIds] },
      }) : undefined;
      const endedAt = finishEndedAtRef.current || new Date().toISOString();
      finishEndedAtRef.current = endedAt;
      if (!previewOnly && reviewComparisonRef.current) {
        try {
          reviewComparisonRef.current.summary = await recheckReviewComparisonSession(reviewComparisonRef.current, reviewComparisonDependencies);
        } catch {
          reviewComparisonRef.current.summary.status = 'partial';
          reviewComparisonRef.current.summary.holdReasons.push('snapshot_recheck_unavailable');
        }
      }
      if (!previewOnly && reviewMasteryRef.current) {
        reviewMasteryRef.current = await recheckReviewMasteryReferences(reviewMasteryRef.current, reviewComparisonDependencies);
      }
      const episode: ReviewEpisodeCapture = {
        id: sessionIdRef.current,
        startedAt: sessionStartedAtRef.current,
        endedAt,
        questionText: messages.find(message => message.role === 'tutor')?.content || openingQuestion.cleanText,
        knowledgeContext,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role === 'tutor' ? 'assistant' : 'user',
          content: message.content,
          timestamp: message.timestamp,
        })),
        answerEvidence: answerEvidenceRef.current,
        masteryEligible: !previewOnly && summarizeReviewEvidence(answerEvidenceRef.current).masteryEligible,
        ...(reviewMasteryRef.current ? { masteryAssessment: reviewMasteryRef.current } : {}),
        ...(reviewFeedbackRef.current ? { reviewFeedback: reviewFeedbackRef.current } : {}),
        ...(reviewComparisonRef.current ? { comparisonSummary: reviewComparisonRef.current.summary } : {}),
        ...(draftAnswerRef.current ? { draftAnswer: draftAnswerRef.current } : {}),
        ...(consumedDraftIdsRef.current.size ? { consumedDraftIds: [...consumedDraftIdsRef.current] } : {}),
      };

      try {
        // Do not even enter the real cognition service from an isolated preview.
        if (!previewOnly) await captureReviewCognition(episode, { id: noteId, title: noteTitle }, !skipCognition && previewMessages.length === 0);
      } catch (e) {
        setCognitionError(`个人认知保存失败：${(e as Error).message}。回答仍在本页，可以重试或仅保存复习后退出。`);
        onExitSaveStateChange?.('failed', sessionIdRef.current);
        return;
      }
      // In previewOnly mode, this is the fixture's in-memory callback, not an App writer.
      // Do not duplicate mastery/activity effects on double click or candidate-save retry.
      if (isProjectReview) await onReviewComplete(finalAnalysis, segmentMasteryResults, episode);
      else await onReviewComplete(finalAnalysis, undefined, episode);
      finishedRef.current = true;
      onExitSaveStateChange?.('idle', sessionIdRef.current);
      if (!previewOnly && summarizeReviewEvidence(answerEvidenceRef.current).masteryEligible) void recordReviewActivity().catch(() => {});
    } catch (cause) {
      setExitSaveError(`本次复习未能完整保存，回答和评分仍保留在本页。${cause instanceof Error ? cause.message : '请重试保存。'}`);
      onExitSaveStateChange?.('failed', sessionIdRef.current);
    } finally {
      finishLock.current = false;
      setIsSavingCognition(false);
    }
  };

  const handleExitAndSave = async () => {
    if (isScoring || isTutorResponding || finishLock.current) return;
    await handleFinishReview();
  };

  const handleOpenMaterial = (material: ReviewMaterial) => {
    if (previewOnly && material.kind === 'resource') return;
    if (materialOpen.isBusy() || tutorOperationRef.current || finishLock.current || isScoring || sessionEnded) return;
    const markConsulted = () => setConsultedMaterialIds((current) => current.includes(material.id) ? current : [...current, material.id]);
    if (material.kind === 'note') {
      if (expandedMaterialId !== material.id) markConsulted();
      setExpandedMaterialId((current) => current === material.id ? null : material.id);
      return;
    }
    void materialOpen.start(material.resource, () => {
      markConsulted();
      setExpandedMaterialId(material.id);
    });
  };

  const handleRetryMaterial = (resource: ResourceItem) => {
    const material = reviewMaterials.find(item => item.kind === 'resource' && (resource.documentId
      ? item.resource.documentId === resource.documentId : item.resource.url === resource.url));
    if (material) handleOpenMaterial(material);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const evidenceSummary = summarizeReviewEvidence(answerEvidenceRef.current);
  const evidenceRequirement = reviewEvidenceRequirement(evidenceSummary);
  const canEnd = (masteryReadMode() === 'current' ? evidenceSummary.answerCount > 0 : evidenceSummary.masteryEligible)
    && !sessionEnded && !isTutorResponding;

  // 气泡复习：由 finalAnalysis.masteryEvidence 折算出三层掌握度（仅展示，不展示更新后的 conceptMastery）
  const bubbleMastery = masteryReadMode() === 'legacy' ? finalAnalysis?.masteryEvidence : undefined;
  const bubbleConceptDelta = scoreConceptEvidence(bubbleMastery?.conceptEvidence);
  const bubbleJudgmentDelta = scoreJudgmentEvidence(bubbleMastery?.judgmentEvidence);
  const bubbleReasoningDelta = scoreReasoningEvidence(bubbleMastery?.reasoningEvidence);
  const bubbleLevel = determineMasteryLevel(bubbleReasoningDelta, bubbleJudgmentDelta, bubbleConceptDelta);
  const currentMastery = allNotes.find((note) => note.id === noteId)?.dsrState?.conceptMastery ?? 0;
  const bubbleLayered = computeLayeredMastery(bubbleConceptDelta, bubbleJudgmentDelta, bubbleReasoningDelta, currentMastery);
  const tutorRoundById = useMemo(() => {
    let round = 0;
    return new Map(messages.filter((message) => message.role === 'tutor').map((message) => {
      round += 1;
      return [message.id, round] as const;
    }));
  }, [messages]);
  const thinkingTrace = useMemo<ReviewTraceStep[]>(() => {
    const result: ReviewTraceStep[] = [];
    let latestTutor: ReviewMessage | null = null;
    let answerIndex = 0;
    messages.forEach((message) => {
      if (message.role === 'tutor') {
        latestTutor = message;
        return;
      }
      const evidence = answerEvidenceRef.current[answerIndex];
      const question = latestTutor?.content || questionText;
      result.push({
        id: message.id,
        round: answerIndex + 1,
        title: inferThinkingStage(question, answerIndex + 1),
        description: compactPlainText(message.content, 90) || '本轮未形成可展示的回答摘要。',
        target: evidence?.targetKnowledgeNames.join('、') || noteTitle,
        hintLevel: evidence?.hintLevel || 0,
        consultedMaterialCount: evidence?.consultedMaterialIds?.length || 0,
        status: 'complete',
      });
      answerIndex += 1;
      latestTutor = null;
    });
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'tutor') {
      result.push({
        id: `active:${lastMessage.id}`,
        round: answerIndex + 1,
        title: inferThinkingStage(lastMessage.content, answerIndex + 1),
        description: compactPlainText(lastMessage.content, 90) || '导师正在组织下一步追问…',
        target: isProjectReview ? (lastIntentRef.current.join('、') || '项目整体') : noteTitle,
        hintLevel,
        consultedMaterialCount: consultedMaterialIds.length,
        status: 'active',
      });
    }
    return result.slice(-7);
  }, [consultedMaterialIds.length, hintLevel, isProjectReview, messages, noteTitle, questionText]);
  const currentRound = Math.max(1, evidenceSummary.answerCount + (sessionEnded ? 0 : 1));

  return (
    <div className="review-session-page">
      <header className="review-session-header">
        <div className="review-session-brand">
          <span className="review-session-brand-mark"><LogiNoteLogoMark /></span>
          <strong>LogiNote</strong>
          <i aria-hidden="true" />
          <button type="button" onClick={() => void handleExitAndSave()} disabled={materialOpen.pending || isScoring || isTutorResponding || isSavingCognition}
            aria-label={isSavingCognition ? '正在保存复习' : exitSaveError ? '重试保存并退出复习' : '退出复习并保存'}
            title={isSavingCognition ? '正在保存复习' : exitSaveError ? '重试保存并退出复习' : '退出复习并保存'}>
            <ArrowLeft aria-hidden="true" />
            <span>苏格拉底式复习</span>
          </button>
        </div>
        <div className="review-session-topic"><BrainCircuit aria-hidden="true" /><span>主题：<strong>{noteTitle}</strong></span></div>
        <div className="review-session-status">
          <div className="review-session-progress" aria-label={`当前第 ${currentRound} 轮`}>
            {Array.from({ length: REVIEW_PACING_ROUNDS }, (_, index) => (
              <i key={index} className={index < Math.min(currentRound, REVIEW_PACING_ROUNDS) ? 'is-filled' : ''} />
            ))}
            <span>{currentRound <= REVIEW_PACING_ROUNDS ? `${currentRound} / ${REVIEW_PACING_ROUNDS}` : `第 ${currentRound} 轮`}</span>
          </div>
          <span className="review-session-time"><Clock3 aria-hidden="true" />已用时 {formatElapsed(elapsedSeconds)}</span>
          <button className="review-session-exit" type="button" onClick={() => void handleExitAndSave()} disabled={materialOpen.pending || isScoring || isTutorResponding || isSavingCognition}>
            {isSavingCognition ? <Loader2 className="is-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}{isSavingCognition ? '正在保存…' : exitSaveError ? '重试保存' : '退出并保存'}
          </button>
        </div>
      </header>

      <div className="review-session-workspace">
        <main className="review-session-main">
          <section className="review-session-intro">
            <span>SOCRATIC REVIEW</span>
            <h1>{noteTitle}</h1>
            <p>{isProjectReview ? '先自由复述项目全貌，再通过追问检验知识之间的依赖、判断与迁移。' : '通过提问与推理，逐步澄清概念、建立联系，并形成自己的答案。'}</p>
          </section>

          <div className="review-session-dialogue">
            {messages.map((message) => {
              const tutorRound = tutorRoundById.get(message.id);
              return (
                <article
                  key={message.id}
                  className={`review-dialogue-message is-${message.role}`}
                  data-selection-surface={!previewOnly && message.role === 'tutor' ? 'review' : undefined}
                  data-selection-source-id={message.role === 'tutor' ? message.id : undefined}
                  data-selection-context-id={message.role === 'tutor' ? noteId : undefined}
                  data-selection-source-title={message.role === 'tutor' ? noteTitle : undefined}
                  data-selection-note-id={message.role === 'tutor' ? noteId : undefined}
                >
                  <span className="review-dialogue-avatar">
                    {message.role === 'tutor' ? <BrainCircuit aria-hidden="true" /> : <UserRound aria-hidden="true" />}
                  </span>
                  <div>
                    <header>
                      <strong>{message.role === 'tutor' ? '导师 · 提问' : '我的思考'}</strong>
                      {message.role === 'tutor' && tutorRound && <span>第 {tutorRound} 问</span>}
                      {message.isStreaming && <em><i /><i /><i />正在思考</em>}
                    </header>
                    <p className={message.isStreaming ? 'is-streaming' : ''}>{message.content || (message.isStreaming ? '正在组织下一步追问…' : '')}</p>
                  </div>
                </article>
              );
            })}

            {isScoring && <div className="review-session-notice"><Loader2 className="is-spinning" aria-hidden="true" />正在分析本次复习证据…</div>}
            {error && <div className="review-session-notice is-error"><AlertTriangle aria-hidden="true" />{error}</div>}
            {cognitionError && <div role="alert" className="review-session-notice is-error"><div>{cognitionError}<button type="button" className="mt-2 block underline" disabled={isSavingCognition} onClick={() => void handleFinishReview(true)}>暂不入认知库，仅保存复习后退出</button></div></div>}
            {exitSaveError && <div role="alert" tabIndex={-1} ref={exitErrorRef} className="review-session-notice is-error review-exit-save-error"><AlertTriangle aria-hidden="true" /><span>{exitSaveError}</span><button type="button" disabled={isSavingCognition} onClick={() => void handleFinishReview()}>重试保存</button></div>}
            {isSavingCognition && <p role="status">正在保存本次复习…</p>}

            {sessionEnded && (masteryReadMode() === 'current' || finalAnalysis) && (
              <section className={masteryReadMode() === 'current' ? 'review-session-result is-current-review' : 'review-session-result'}>
                {masteryReadMode() === 'current' ? <ReviewResultHeading available={sessionFeedback?.status === 'available'} />
                  : <header><CheckCircle2 aria-hidden="true" /><div><strong>复习评估完成</strong><span>评分只依据本次对话中独立表达的内容</span></div></header>}
                {masteryReadMode() === 'current' && <ReviewMasteryResults results={segmentMasteryResults}
                  feedbackAvailable={sessionFeedback?.status === 'available'}
                  quickCheckDisabled={isSavingCognition || isScoring || isTutorResponding}
                  onQuickCheck={!previewOnly && onQuickCheckAfterSave ? (result) => {
                    const names = new Set([result.name, result.existingNoteTitle].filter(Boolean));
                    const targets = allNotes.filter(note => note.noteType === 'knowledge'
                      && (names.has(note.title) || note.aliases?.some(alias => names.has(alias))));
                    if (targets.length !== 1) { setError('未能唯一确定该知识点，请保存后从知识点笔记打开简测。'); return; }
                    void handleFinishReview().then(() => {
                      if (finishedRef.current) onQuickCheckAfterSave(targets[0].id);
                    });
                  } : undefined}
                  warnings={[...(reviewMasteryRef.current?.warnings || []), ...(reviewMasteryRef.current?.items
                    .filter(item => item.error).map(item => `${item.name}：${item.error}`) || [])]} />}
                {masteryReadMode() === 'current' && <ReviewFeedbackSummary feedback={sessionFeedback} />}
                {masteryReadMode() === 'legacy' && isProjectReview && segmentMasteryResults.length > 0 && (
                  <div className="review-session-segments">
                    {segmentMasteryResults.map((result) => (
                      <article key={`${result.name}-${result.level}`}>
                        <div><strong>{result.name}</strong><span>{MASTERY_LEVEL_LABEL[result.level] || result.level}</span></div>
                        <p>概念 {result.conceptDelta} · 判断 {result.judgmentDelta} · 推理 {result.reasoningDelta}</p>
                        {result.comment && <small>{result.comment}</small>}
                      </article>
                    ))}
                  </div>
                )}
                {masteryReadMode() === 'legacy' && finalAnalysis && <>
                <ReviewPerformanceSummary analysis={finalAnalysis} />
                <div className="review-session-result-copy"><strong>反馈</strong><p>{finalAnalysis.feedback || '本次未返回文字反馈。'}</p></div>
                <div className="review-session-result-copy is-accent"><strong>下一步建议</strong><p>{finalAnalysis.suggestion || '稍后再次无提示复述本知识点。'}</p></div>
                {finalAnalysis.missingKnowledge.length > 0 && <div className="review-session-missing"><strong>尚未体现</strong><div>{finalAnalysis.missingKnowledge.map((item) => <span key={item}>{item}</span>)}</div></div>}
                </>}
                {masteryReadMode() === 'legacy' && !isProjectReview && bubbleMastery && (
                  <div className="review-session-layered">
                    <div><strong>三层掌握度</strong><span>触及层级：{MASTERY_LEVEL_LABEL[bubbleLevel]}</span></div>
                    <p>预计掌握度 {Math.round(currentMastery)} → {Math.round(bubbleLayered.mastery)}</p>
                    <div><span>概念 {bubbleLayered.conceptFinal}</span><span>判断 {bubbleLayered.judgmentFinal}</span><span>推理 {bubbleLayered.reasoningFinal}</span></div>
                  </div>
                )}
                <button type="button" disabled={materialOpen.pending || isSavingCognition} onClick={() => void handleFinishReview()}><Check aria-hidden="true" />保存本次复习并返回</button>
              </section>
            )}
            <div ref={messagesEndRef} />
          </div>

          {!sessionEnded && (
            <section className="review-session-composer">
              {recoverableDraft && <div className="review-draft-recovery"><FileText aria-hidden="true" /><span>
                {recoverableContext ? <>
                  {draftMatchesQuestion ? '本题还有未发送的回答，可恢复继续编辑。' : '上次的回答属于另一道题，不会填入当前题。'}
                  <strong className="review-draft-question">原题：{recoverableContext.questionText}</strong>
                  {(recoverableContext.hintLevel > 0 || recoverableContext.consultedMaterialIds.length > 0) && '恢复时会保留已使用提示、查阅资料的记录。'}
                </> : '这份旧草稿未记录原题和查阅状态，可查看原文，不会自动填入当前题。'}
                {userInput.trim() ? ' 当前输入会保留，请先处理当前回答。' : ''}
              </span>
                <button type="button" aria-expanded={draftPreviewOpen} onClick={() => setDraftPreviewOpen(current => !current)}>{draftPreviewOpen ? '收起原文' : '查看原题回答'}</button>
                {recoverableContext && (draftMatchesQuestion || canResumeOriginalQuestion) && <button type="button"
                  disabled={Boolean(userInput.trim()) || isDiscardingDraft || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError)}
                  onClick={() => void handleRestoreDraft()}>{draftMatchesQuestion ? '恢复未发送回答' : '继续原题'}</button>}
                <button type="button" disabled={isDiscardingDraft || isTutorResponding || isScoring || isSavingCognition}
                  onClick={() => void handleDiscardDraft()}>{isDiscardingDraft ? '正在丢弃…' : '丢弃草稿'}</button>
                {draftPreviewOpen && <pre className="review-draft-original" aria-label="原题未发送回答">{recoverableDraft.content}</pre>}
              </div>}
              {draftLoadError && <div role="status" className="review-draft-recovery"><span>{draftLoadError}</span><button type="button" onClick={() => setDraftReadVersion((version) => version + 1)}>重试读取</button></div>}
              <textarea
                ref={answerInputRef}
                aria-label="本轮复习回答"
                placeholder={isTutorResponding ? '导师正在思考…' : '用自己的话继续推理…'}
                value={userInput}
                onChange={(event) => updateUserInput(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError)}
                rows={3}
              />
              <div className="review-session-composer-tools">
                <button
                  type="button"
                  className={isListening ? 'is-listening' : ''}
                  onClick={handleVoiceToggle}
                  disabled={previewOnly || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError) || !modelReady}
                  title={previewOnly ? '交互预览不启用语音' : modelReady ? '语音回答' : '语音模型正在加载'}
                >
                  {isListening ? <MicOff aria-hidden="true" /> : previewOnly || modelReady ? <Mic aria-hidden="true" /> : <Loader2 className="is-spinning" aria-hidden="true" />}
                  <span>{isListening ? '停止录音' : '语音回答'}</span>
                </button>
                <button type="button" onClick={() => void requestTutorSupport('rephrase')} disabled={previewOnly || materialOpen.pending || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError)} title={previewOnly ? '交互预览不调用导师模型' : undefined}><RefreshCw aria-hidden="true" />换个问法</button>
                <button type="button" onClick={() => void requestTutorSupport('hint')} disabled={previewOnly || materialOpen.pending || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError) || hintLevel >= 4} title={previewOnly ? '交互预览不调用导师模型' : undefined}><Lightbulb aria-hidden="true" />给我一个提示</button>
                <button type="button" onClick={() => void requestTutorSupport('unknown')} disabled={previewOnly || materialOpen.pending || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError)} title={previewOnly ? '交互预览不调用导师模型' : undefined}><HelpCircle aria-hidden="true" />我不知道</button>
                <span>{userInput.length} / 800</span>
                <button type="button" className="review-session-score" onClick={handleEndSession} disabled={previewOnly || materialOpen.pending || !canEnd || isSavingCognition || Boolean(exitSaveError)} title={previewOnly ? '交互预览不调用评分模型' : !canEnd ? evidenceRequirement : '结束本次对话并分析掌握证据'}>
                  <Square aria-hidden="true" />{isScoring ? '评分中' : '完成复习'}
                </button>
                <button type="button" className="review-session-send" onClick={handleSendMessage} disabled={previewOnly || materialOpen.pending || !userInput.trim() || userInput.trim().length > 800 || isTutorResponding || isScoring || isSavingCognition || Boolean(exitSaveError)} title={previewOnly ? '交互预览只编辑草稿，不发送回答' : undefined}>
                  {isTutorResponding ? <Loader2 className="is-spinning" aria-hidden="true" /> : <Send aria-hidden="true" />}发送
                </button>
              </div>
              {userInput.trim().length > 800 && <small role="status">回答超过 800 字，请分段发送；完整原文会随退出保存为草稿。</small>}
              {consultedMaterialIds.length > 0
                ? <small className="is-assisted">本轮已查阅 {consultedMaterialIds.length} 项资料，将按强辅助作答记录；下一轮可无提示重答。</small>
                : !canEnd && !isTutorResponding && evidenceRequirement && <small>形成可回写的复习证据还需：{evidenceRequirement}</small>}
            </section>
          )}
        </main>

        <aside className="review-session-side">
          <section className="rounded-xl border border-slate-200 p-4 text-xs leading-relaxed dark:border-slate-700" aria-label="个人认知自动记录">
            <p>回答将在保存复习时直接进入个人认知库，无需再次确认。</p>
            {(previewOnly || previewMessages.length > 0) && <p className="mt-2">演示会话不写入认知库。</p>}
          </section>
          <section className="review-thinking-panel">
            <header><BrainCircuit aria-hidden="true" /><div><strong>思考轨迹</strong><span>随每轮回答更新，不参与最终评分</span></div></header>
            <div className="review-thinking-list">
              {thinkingTrace.length === 0 ? <p className="review-side-empty">回答第一轮问题后，这里会形成你的回合轨迹。</p> : thinkingTrace.map((step) => (
                <article key={step.id} className={`is-${step.status}`}>
                  <span>{step.status === 'complete' ? <Check aria-hidden="true" /> : step.round}</span>
                  <div>
                    <strong>{step.round} · {step.title}</strong>
                    <p>{step.description}</p>
                    <small>
                      {step.target}
                      {step.status === 'active'
                        ? step.consultedMaterialCount > 0 ? ` · 已查阅 ${step.consultedMaterialCount} 项资料，等待作答` : ' · 等待作答'
                        : step.consultedMaterialCount > 0
                        ? ` · 查阅 ${step.consultedMaterialCount} 项资料`
                        : step.hintLevel > 0 ? ` · 使用 ${step.hintLevel} 级提示` : ' · 独立作答'}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="review-material-panel">
            <header><BookOpen aria-hidden="true" /><div><strong>可用资料</strong><span>{reviewMaterials.length} 项 · 需要时再查看</span></div></header>
            <ResourceOpenFeedback feedback={materialOpen.feedback} onRetry={handleRetryMaterial} />
            <div className="review-material-list">
              {reviewMaterials.length === 0 ? <p className="review-side-empty">当前复习对象暂未关联笔记或学习资源。</p> : reviewMaterials.map((material) => (
                <button
                  type="button"
                  key={material.id}
                  className={expandedMaterialId === material.id ? 'is-expanded' : ''}
                  aria-expanded={material.kind === 'note' ? expandedMaterialId === material.id : undefined}
                  onClick={() => handleOpenMaterial(material)}
                  disabled={(previewOnly && material.kind === 'resource') || materialOpen.pending || isTutorResponding || isScoring || isSavingCognition || sessionEnded}
                  title={previewOnly && material.kind === 'resource' ? '交互预览不打开真实资料' : undefined}
                >
                  <span className="review-material-icon">{material.kind === 'note' ? <FileText aria-hidden="true" /> : material.resource.kind === 'local' || material.resource.documentId ? <FolderOpen aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}</span>
                  <span>
                    <small>{material.kind === 'note' ? '笔记' : material.resource.resourceType || (material.resource.kind === 'local' ? '本地资料' : '在线资源')}</small>
                    <strong>{material.title}</strong>
                    {expandedMaterialId === material.id && <p>{material.description}</p>}
                    <em>来源：{material.sourceTitle}</em>
                  </span>
                  {material.kind === 'resource' && <ExternalLink aria-hidden="true" />}
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
};
