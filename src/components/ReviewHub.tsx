import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteItem, StudyQuestionCard } from '../types';
import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock3,
  Dices,
  Folder,
  Info,
  Network,
  Play,
  Shuffle,
  Sparkles,
  Square,
  Target,
  X,
} from 'lucide-react';
import { buildProjectReviewKnowledgeContext, collectProjectKnowledgeNotes } from '../services/knowledgePointSelector';
import {
  buildKnowledgeReviewCandidates,
  buildReviewSchedule,
  summarizeKnowledgeReviewPool,
  summarizeKnowledgeReviewMemory,
  type KnowledgeReviewStrategy,
} from '../services/reviewScheduler';
import { resolveNoteByTitleOrAlias } from '../services/noteResolver';
import { buildReviewOpeningQuestion } from '../services/reviewAssessment';
import { knowledgeMasteryCaption, masteryReadMode, readKnowledgeMastery, summarizeKnowledgeMastery } from '../services/masteryReadModel';
import { KnowledgeMasteryStatus } from './KnowledgeMasteryStatus';
import { knowledgePracticeRecency } from '../services/knowledgePracticeTime';
import { QuickCheckButton } from './quickCheck';

interface ReviewHubProps {
  allNotes: NoteItem[];
  onEnterReview?: (noteId: string, noteTitle: string, question: string, context: string) => void;
  launchRequest?: {
    id: string;
    scope: ReviewScope;
    strategy: KnowledgeReviewStrategy;
    noteTitle?: string;
  } | null;
}

type ReviewScope = 'knowledge' | 'project';
type RandomRollPhase = 'idle' | 'rolling' | 'settled';
type CardMotion = 'next' | 'previous' | 'shuffle' | 'settle' | null;

interface ProjectTreeNode {
  note: NoteItem;
  children: ProjectTreeNode[];
}

interface RelatedReviewNode {
  id: string;
  title: string;
  kind: 'knowledge' | 'project';
}

const MAX_RELATED_GRAPH_NODES = 6;

function distributeRelatedGraphSide(x: number, count: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];
  if (count === 1) return [{ x, y: 50 }];
  const top = count === 2 ? 29 : 18;
  const bottom = count === 2 ? 71 : 82;
  return Array.from({ length: count }, (_, index) => ({
    x,
    y: top + ((bottom - top) * index) / (count - 1),
  }));
}

function buildRelatedGraphPositions(count: number): Array<{ x: number; y: number }> {
  if (count === 2) return [{ x: 17, y: 25 }, { x: 83, y: 75 }];
  const leftCount = Math.ceil(count / 2);
  const rightCount = Math.floor(count / 2);
  return [
    ...distributeRelatedGraphSide(17, leftCount),
    ...distributeRelatedGraphSide(83, rightCount),
  ];
}

function buildRelatedCurvePath(position: { x: number; y: number }): string {
  const isLeft = position.x < 50;
  const isHorizontal = Math.abs(position.y - 50) < 0.5;
  if (isHorizontal) return `M 50 50 L ${position.x} 50`;

  const bendX = isLeft ? 41 : 59;
  return `M 50 50 C ${bendX} 50, ${bendX} ${position.y}, ${position.x} ${position.y}`;
}

const STRATEGY_COPY: Record<KnowledgeReviewStrategy, { label: string; description: string }> = {
  smart: { label: '智能抽取', description: '综合遗忘曲线、掌握度与近期错误选择' },
  weak: { label: '薄弱优先', description: '只从待复核、待确认或需补强的知识点中选择' },
  random: { label: '完全随机', description: '从全库正文可用的知识点中等概率抽取，可重复抽中' },
};

function handleTabKey<T extends string>(event: React.KeyboardEvent<HTMLButtonElement>, values: readonly T[], current: T, select: (value: T) => void) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const index = values.indexOf(current);
  const nextIndex = event.key === 'ArrowRight' ? (index + 1) % values.length
    : event.key === 'ArrowLeft' ? (index - 1 + values.length) % values.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : -1;
  if (nextIndex < 0) return;
  event.preventDefault();
  select(values[nextIndex]);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
}

function buildProjectTreeStructure(notes: NoteItem[]): ProjectTreeNode[] {
  const roots = notes.filter((note) => note.noteType === 'project' && !note.parentId);
  const buildNode = (note: NoteItem): ProjectTreeNode => ({
    note,
    children: notes
      .filter((candidate) => candidate.parentId === note.id && candidate.noteType === 'project')
      .map(buildNode),
  });
  return roots.map(buildNode);
}

function plainText(content: string): string {
  return content
    .replace(/<ArgumentBlock[^>]*\/>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectProjectTreeNotes(root: NoteItem, notes: NoteItem[]): NoteItem[] {
  const result: NoteItem[] = [root];
  notes.filter((note) => note.parentId === root.id).forEach((child) => {
    result.push(...collectProjectTreeNotes(child, notes));
  });
  return result;
}

function collectProjectQuestions(project: NoteItem, notes: NoteItem[]): StudyQuestionCard[] {
  const scoped = [...collectProjectTreeNotes(project, notes), ...collectProjectKnowledgeNotes(project.id, notes)];
  const seen = new Set<string>();
  return scoped.flatMap((note) => (note.questions || []).filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  }));
}

const ProjectTree: React.FC<{
  nodes: ProjectTreeNode[];
  expandedIds: Set<string>;
  selectedId?: string;
  recommendedById: Map<string, number>;
  onToggle: (id: string) => void;
  onSelect: (note: NoteItem) => void;
}> = ({ nodes, expandedIds, selectedId, recommendedById, onToggle, onSelect }) => {
  const renderNode = (node: ProjectTreeNode, depth: number): React.ReactNode => {
    const expanded = expandedIds.has(node.note.id);
    const selected = selectedId === node.note.id;
    return (
      <div key={node.note.id}>
        <div
          className={`review-project-tree-row${selected ? ' is-selected' : ''}`}
          style={{ paddingLeft: `${0.65 + depth * 0.9}rem`, gridTemplateColumns: '1.5rem minmax(0, 1fr)' }}
        >
          {node.children.length > 0 ? (
            <button type="button" className="review-project-tree-toggle" aria-expanded={expanded}
              aria-label={`${expanded ? '收起' : '展开'}项目：${node.note.title || '未命名项目'}`}
              style={{ minHeight: '2.4rem', padding: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
              onClick={() => onToggle(node.note.id)}>
              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </button>
          ) : <span className="review-project-tree-toggle" aria-hidden="true"><i /></span>}
          <button type="button" aria-pressed={selected} onClick={() => onSelect(node.note)}
            style={{ minHeight: '2.4rem', display: 'grid', gridTemplateColumns: '0.85rem minmax(0, 1fr) auto', alignItems: 'center', gap: '0.4rem', padding: 0, border: 0, background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
            <Folder aria-hidden="true" style={{ width: '0.72rem', height: '0.72rem', color: 'var(--ln-accent)' }} />
            <span style={{ overflow: 'hidden', fontSize: '0.62rem', fontWeight: 650, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.note.title || '未命名项目'}</span>
            {recommendedById.has(node.note.id) && <em>待复习 {recommendedById.get(node.note.id)}</em>}
          </button>
        </div>
        {expanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };
  return <div className="review-project-tree">{nodes.map((node) => renderNode(node, 0))}</div>;
};

export const ReviewHub: React.FC<ReviewHubProps> = ({ allNotes, onEnterReview, launchRequest }) => {
  const [scope, setScope] = useState<ReviewScope>(() => (
    launchRequest?.scope || (new URLSearchParams(window.location.search).get('reviewScope') === 'project' ? 'project' : 'knowledge')
  ));
  const [strategy, setStrategy] = useState<KnowledgeReviewStrategy>(() => (
    launchRequest?.strategy || (new URLSearchParams(window.location.search).get('reviewMode') === 'random' ? 'random' : 'smart')
  ));
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [cardMotion, setCardMotion] = useState<CardMotion>(null);
  const [randomRollPhase, setRandomRollPhase] = useState<RandomRollPhase>('idle');
  const randomRollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardMotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const randomRollActiveRef = useRef(false);
  const randomRollGenerationRef = useRef(0);
  const enteringKnowledgeRef = useRef(false);
  const candidateIndexRef = useRef(candidateIndex);
  candidateIndexRef.current = candidateIndex;
  const consumedLaunchIdRef = useRef<string | null>(null);
  const previousRootIdsRef = useRef(new Set<string>());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState<NoteItem | null>(null);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());

  const knowledgeNotes = useMemo(() => allNotes.filter((note) => note.noteType === 'knowledge'), [allNotes]);
  const reviewPoolSummary = useMemo(() => summarizeKnowledgeReviewPool(allNotes), [allNotes]);
  const reviewMemorySummary = useMemo(() => summarizeKnowledgeReviewMemory(allNotes), [allNotes]);
  const projectTree = useMemo(() => buildProjectTreeStructure(allNotes), [allNotes]);
  const reviewSchedule = useMemo(() => buildReviewSchedule(allNotes), [allNotes]);
  const firstReviewDueCount = reviewSchedule.knowledge.filter(target => target.needsFirstReview).length;
  const recommendedById = useMemo(
    () => new Map(reviewSchedule.projects.map((item) => [item.noteId, item.dueKnowledgeCount])),
    [reviewSchedule],
  );
  const candidates = useMemo(
    () => buildKnowledgeReviewCandidates(allNotes, strategy),
    [allNotes, strategy],
  );
  const previousCandidatesRef = useRef(candidates);
  const previousStrategyRef = useRef(strategy);

  const cancelRandomRoll = useCallback(() => {
    randomRollGenerationRef.current += 1;
    randomRollActiveRef.current = false;
    if (randomRollTimerRef.current !== null) clearTimeout(randomRollTimerRef.current);
    if (cardMotionTimerRef.current !== null) clearTimeout(cardMotionTimerRef.current);
    randomRollTimerRef.current = null;
    cardMotionTimerRef.current = null;
    setRandomRollPhase('idle');
    setCardMotion(null);
  }, []);

  useEffect(() => {
    const selectedId = previousCandidatesRef.current[candidateIndexRef.current]?.noteId;
    const nextIndex = candidates.findIndex((candidate) => candidate.noteId === selectedId);
    const strategyChanged = previousStrategyRef.current !== strategy;
    if (strategyChanged || randomRollActiveRef.current || nextIndex < 0) cancelRandomRoll();
    setCandidateIndex(strategyChanged ? 0 : Math.max(0, nextIndex));
    previousCandidatesRef.current = candidates;
    previousStrategyRef.current = strategy;
  }, [strategy, candidates, cancelRandomRoll]);

  useEffect(() => { cancelRandomRoll(); }, [scope, cancelRandomRoll]);

  useEffect(() => {
    if (!launchRequest || consumedLaunchIdRef.current === launchRequest.id) return;
    setScope(launchRequest.scope);
    setStrategy(launchRequest.strategy);
    // Wait for the requested strategy's candidate list before locating its card.
    if (strategy !== launchRequest.strategy) return;
    const note = launchRequest.noteTitle ? resolveNoteByTitleOrAlias(launchRequest.noteTitle, allNotes) : null;
    if (launchRequest.noteTitle && !note && allNotes.length === 0) return;
    setSelectedQuestionIds(new Set());
    if (note?.noteType === 'project') setSelectedProject(note);
    if (launchRequest.scope === 'knowledge' && note?.noteType === 'knowledge') {
      const index = candidates.findIndex((candidate) => candidate.noteId === note.id);
      if (index >= 0) setCandidateIndex(index);
    }
    consumedLaunchIdRef.current = launchRequest.id;
  }, [allNotes, candidates, launchRequest, strategy]);

  useEffect(() => {
    const roots = new Set(projectTree.map((node) => node.note.id));
    const projectIds = new Set(allNotes.filter((note) => note.noteType === 'project').map((note) => note.id));
    const previousRoots = previousRootIdsRef.current;
    setExpandedIds((current) => {
      const next = new Set([...current].filter((id) => projectIds.has(id)));
      roots.forEach((id) => { if (!previousRoots.has(id)) next.add(id); });
      return next;
    });
    previousRootIdsRef.current = roots;
  }, [allNotes, projectTree]);

  useEffect(() => {
    setSelectedProject((current) => {
      const latest = current && allNotes.find((note) => note.id === current.id && note.noteType === 'project');
      if (latest) return latest;
      return projectTree[0]?.note || null;
    });
  }, [allNotes, projectTree]);

  useEffect(() => () => {
    randomRollGenerationRef.current += 1;
    randomRollActiveRef.current = false;
    if (randomRollTimerRef.current !== null) clearTimeout(randomRollTimerRef.current);
    if (cardMotionTimerRef.current !== null) clearTimeout(cardMotionTimerRef.current);
  }, []);

  const activeCandidate = candidates[candidateIndex] || null;
  const activeNote = activeCandidate
    ? allNotes.find((note) => note.id === activeCandidate.noteId) || null
    : null;
  const knowledgeSelectionReady = Boolean(
    activeNote
    && activeCandidate
    && (strategy !== 'random' || randomRollPhase === 'settled'),
  );
  useEffect(() => {
    enteringKnowledgeRef.current = false;
  }, [activeCandidate?.noteId, randomRollPhase, strategy]);
  const previousCandidate = candidates.length > 1
    ? candidates[(candidateIndex - 1 + candidates.length) % candidates.length]
    : null;
  const nextCandidate = candidates.length > 1
    ? candidates[(candidateIndex + 1) % candidates.length]
    : null;
  const weakCount = reviewPoolSummary.weakCount;
  const exploreCount = reviewPoolSummary.randomCount;
  const projectQuestions = useMemo(
    () => selectedProject ? collectProjectQuestions(selectedProject, allNotes) : [],
    [selectedProject, allNotes],
  );
  useEffect(() => {
    const available = new Set(projectQuestions.map((question) => question.id));
    setSelectedQuestionIds((current) => {
      if ([...current].every((id) => available.has(id))) return current;
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [projectQuestions]);

  const relatedReviewNodePool = useMemo<RelatedReviewNode[]>(() => {
    if (!activeNote) return [];
    const seen = new Set<string>([activeNote.id]);
    const relatedKnowledge = [...activeNote.links, ...activeNote.backlinks]
      .map((target) => resolveNoteByTitleOrAlias(target, knowledgeNotes))
      .filter((note): note is NoteItem => Boolean(note))
      .filter((note) => {
        if (seen.has(note.id)) return false;
        seen.add(note.id);
        return true;
      })
      .map((note) => ({ id: note.id, title: note.title, kind: 'knowledge' as const }));

    const relatedProjects = allNotes
      .filter((note) => note.noteType === 'project')
      .filter((project) => activeNote.parentId === project.id || project.links.some((target) => (
        resolveNoteByTitleOrAlias(target, knowledgeNotes)?.id === activeNote.id
      )))
      .filter((project) => {
        if (seen.has(project.id)) return false;
        seen.add(project.id);
        return true;
      })
      .map((project) => ({ id: project.id, title: project.title, kind: 'project' as const }));

    return [...relatedKnowledge, ...relatedProjects];
  }, [activeNote, allNotes, knowledgeNotes]);

  const relatedReviewNodes = useMemo<RelatedReviewNode[]>(() => {
    const relatedKnowledge = relatedReviewNodePool.filter((node) => node.kind === 'knowledge');
    const relatedProjects = relatedReviewNodePool.filter((node) => node.kind === 'project');
    const selectedKnowledge = relatedKnowledge.slice(0, Math.min(4, MAX_RELATED_GRAPH_NODES));
    const selectedProjects = relatedProjects.slice(0, MAX_RELATED_GRAPH_NODES - selectedKnowledge.length);
    const remainingSlots = MAX_RELATED_GRAPH_NODES - selectedKnowledge.length - selectedProjects.length;
    return [
      ...selectedKnowledge,
      ...selectedProjects,
      ...relatedKnowledge.slice(selectedKnowledge.length, selectedKnowledge.length + remainingSlots),
    ];
  }, [relatedReviewNodePool]);

  const relatedGraphPositions = useMemo(
    () => buildRelatedGraphPositions(relatedReviewNodes.length),
    [relatedReviewNodes.length],
  );

  const knowledgeCategory = useMemo(() => {
    const explicitTag = activeNote?.tags.find((tag) => tag.trim());
    if (explicitTag) return { text: explicitTag, source: '来自知识点笔记的 tags 字段' };
    const project = relatedReviewNodePool.find((node) => node.kind === 'project');
    if (project) return { text: project.title, source: '知识点未设标签，回退为直接关联项目' };
    return { text: '未分类知识点', source: '知识点未设置标签或项目关联' };
  }, [activeNote, relatedReviewNodePool]);

  const selectedProjectKnowledge = useMemo(
    () => selectedProject ? collectProjectKnowledgeNotes(selectedProject.id, allNotes) : [],
    [allNotes, selectedProject],
  );
  const projectMasterySummary = useMemo(() => {
    const assessed = selectedProjectKnowledge.filter((note) => note.dsrState?.conceptMastery != null);
    const average = assessed.length > 0
      ? Math.round(assessed.reduce((sum, note) => sum + (note.dsrState?.conceptMastery ?? 0), 0) / assessed.length)
      : null;
    return {
      average,
      current: summarizeKnowledgeMastery(selectedProjectKnowledge),
      weak: assessed.filter((note) => (note.dsrState?.conceptMastery ?? 0) < 60).length,
      unassessed: selectedProjectKnowledge.length - assessed.length,
      sorted: [...selectedProjectKnowledge].sort(
        (a, b) => masteryReadMode() === 'current'
          ? readKnowledgeMastery(b).reviewPriority - readKnowledgeMastery(a).reviewPriority
          : (a.dsrState?.conceptMastery ?? -1) - (b.dsrState?.conceptMastery ?? -1),
      ),
    };
  }, [selectedProjectKnowledge]);

  const selectStrategy = (next: KnowledgeReviewStrategy) => {
    cancelRandomRoll();
    setCardMotion('settle');
    setStrategy(next);
    if (cardMotionTimerRef.current) clearTimeout(cardMotionTimerRef.current);
    cardMotionTimerRef.current = setTimeout(() => setCardMotion(null), 520);
  };

  const moveCandidate = (offset: number) => {
    if (candidates.length === 0 || randomRollPhase === 'rolling') return;
    setCardMotion(offset > 0 ? 'next' : 'previous');
    setCandidateIndex((index) => (index + offset + candidates.length) % candidates.length);
    if (strategy === 'random') setRandomRollPhase('idle');
    if (cardMotionTimerRef.current) clearTimeout(cardMotionTimerRef.current);
    cardMotionTimerRef.current = setTimeout(() => setCardMotion(null), 460);
  };

  const startRandomRoll = useCallback(() => {
    if (candidates.length === 0 || randomRollActiveRef.current) return;
    randomRollActiveRef.current = true;
    const generation = ++randomRollGenerationRef.current;
    const finalIndex = Math.floor(Math.random() * candidates.length);
    let round = 0;
    const maxRounds = 22;
    setRandomRollPhase('rolling');

    const tick = () => {
      if (generation !== randomRollGenerationRef.current || !randomRollActiveRef.current) return;
      round += 1;
      if (round >= maxRounds) {
        setCardMotion('settle');
        setCandidateIndex(finalIndex);
        setRandomRollPhase('settled');
        randomRollActiveRef.current = false;
        randomRollTimerRef.current = null;
        if (cardMotionTimerRef.current) clearTimeout(cardMotionTimerRef.current);
        cardMotionTimerRef.current = setTimeout(() => setCardMotion(null), 560);
        return;
      }
      setCardMotion('shuffle');
      setCandidateIndex(Math.floor(Math.random() * candidates.length));
      const progress = round / maxRounds;
      const delay = 45 + Math.round(progress * progress * 250);
      randomRollTimerRef.current = setTimeout(tick, delay);
    };
    randomRollTimerRef.current = setTimeout(tick, 45);
  }, [candidates.length]);

  const enterActiveKnowledgeReview = () => {
    if (!knowledgeSelectionReady || !activeNote || !activeCandidate || !onEnterReview || enteringKnowledgeRef.current) return;
    enteringKnowledgeRef.current = true;
    const related = relatedReviewNodes.length > 0 ? `\n关联知识与项目：${relatedReviewNodes.map((node) => node.title).join('、')}` : '';
    onEnterReview(
      activeNote.id,
      activeNote.title,
      buildReviewOpeningQuestion(activeNote.title, false),
      `知识点：${activeNote.title}\n${activeNote.content}${related}`,
    );
  };

  const toggleProject = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const chooseProject = (project: NoteItem) => {
    setSelectedProject(project);
    setSelectedQuestionIds(new Set());
  };

  const toggleQuestion = (id: string) => {
    setSelectedQuestionIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const startProjectReview = () => {
    if (!selectedProject) return;
    const selectedQuestions = projectQuestions.filter((question) => selectedQuestionIds.has(question.id));
    const questionContext = selectedQuestions.length > 0
      ? `\n\n用户选中的问题卡（开场已提出第 1 题，后续围绕所选问题继续追问）：\n${selectedQuestions.map((question, index) => `${index + 1}. ${question.question}`).join('\n')}`
      : '';
    onEnterReview?.(
      selectedProject.id,
      selectedProject.title,
      buildReviewOpeningQuestion(selectedProject.title, true, selectedQuestions.map(question => question.question)),
      `${buildProjectReviewKnowledgeContext(selectedProject, allNotes)}${questionContext}`,
    );
  };

  return (
    <div className="review-picker-page">
      <header className="review-picker-heading">
        <div className="review-picker-title-mark" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <div>
          <span>REVIEW STUDIO</span>
          <h1>{scope === 'knowledge' ? '开始一次知识点复习' : '开始一次项目复习'}</h1>
          <p>{scope === 'knowledge' ? '从需要巩固的知识中抽取一个，先回忆，再验证。' : '先自由复述项目全貌，再由苏格拉底式追问逐轮深入。'}</p>
        </div>
        <div className="review-scope-switch" role="tablist" aria-label="复习入口类型">
          {(['knowledge', 'project'] as const).map((value) => <button key={value} type="button" role="tab" tabIndex={scope === value ? 0 : -1} aria-selected={scope === value} className={scope === value ? 'is-active' : ''} onClick={() => setScope(value)} onKeyDown={(event) => handleTabKey<ReviewScope>(event, ['knowledge', 'project'], value, setScope)}>{value === 'knowledge' ? <BrainCircuit aria-hidden="true" /> : <Folder aria-hidden="true" />}{value === 'knowledge' ? '知识点复习' : '项目复习'}</button>)}
        </div>
      </header>

      {scope === 'knowledge' ? (
        <>
          <section className="review-pool-stats" aria-label="今日复习池概览">
            {[
              { label: '今日复习池', value: reviewSchedule.knowledge.length, suffix: '个知识点', detail: `待首次复习 ${firstReviewDueCount} 个`, Icon: BookOpen, tone: 'green' },
              { label: '薄弱知识', value: weakCount, suffix: knowledgeNotes.length ? `${Math.round(weakCount / knowledgeNotes.length * 100)}%` : '0%', Icon: BarChart3, tone: 'mixed' },
              { label: '即将遗忘', value: reviewMemorySummary.imminentCount, suffix: reviewMemorySummary.imminentPercent === null ? '暂无复习记录' : `${reviewMemorySummary.imminentPercent}% · 已复习`, Icon: Clock3, tone: 'amber' },
              { label: '可随机抽取', value: exploreCount, suffix: '个知识点', Icon: Dices, tone: 'ink' },
            ].map(({ label, value, suffix, detail, Icon, tone }) => (
              <div key={label} className={`is-${tone}`}><Icon aria-hidden="true" /><span><small>{label}</small><strong>{value}</strong><em>{suffix}</em>{detail && <small>{detail}</small>}</span></div>
            ))}
          </section>

          <section className="review-strategy-row">
            <div className="review-strategy-tabs" role="tablist" aria-label="知识点抽取方式">
              {(['smart', 'weak', 'random'] as KnowledgeReviewStrategy[]).map((key) => {
                const Icon = key === 'smart' ? Sparkles : key === 'weak' ? BarChart3 : Shuffle;
                return <button key={key} type="button" role="tab" tabIndex={strategy === key ? 0 : -1} aria-selected={strategy === key} className={strategy === key ? 'is-active' : ''} onClick={() => selectStrategy(key)} onKeyDown={(event) => handleTabKey(event, ['smart', 'weak', 'random'], key, selectStrategy)}><Icon aria-hidden="true" />{STRATEGY_COPY[key].label}</button>;
              })}
            </div>
            <div className="review-strategy-explain"><Info aria-hidden="true" /><span>{STRATEGY_COPY[strategy].description}</span></div>
          </section>

          {strategy === 'random' && candidates.length > 0 && (
            <section className={`review-random-controller is-${randomRollPhase}`} aria-label="完全随机抽取控制">
              <div><Dices aria-hidden="true" /><span><strong>{randomRollPhase === 'rolling' ? '正在滚动知识卡带' : randomRollPhase === 'settled' ? `已抽中：${activeCandidate?.noteTitle || ''}` : '完全随机 · 每个知识点概率相同'}</strong><small>{randomRollPhase === 'settled' ? '可以直接开始复习，也可以重新抽取。' : '点击右侧按钮，卡片会快速滚动并逐步减速定格。'}</small></span></div>
              {randomRollPhase === 'rolling'
                ? <button type="button" onClick={cancelRandomRoll}><X aria-hidden="true" />取消抽取</button>
                : <button type="button" onClick={startRandomRoll}><Shuffle aria-hidden="true" />{randomRollPhase === 'settled' ? '重新抽取' : '开始随机抽取'}</button>}
            </section>
          )}

          <section className={`review-carousel${randomRollPhase === 'rolling' ? ' is-rolling' : ''}${cardMotion ? ` is-motion-${cardMotion}` : ''}`} aria-live="polite">
            {candidates.length === 0 || !activeNote || !activeCandidate ? (
              <div className="review-picker-empty"><BookOpen aria-hidden="true" /><h2>{strategy === 'weak' ? '暂无需要优先巩固的知识点' : '还没有可复习的知识点'}</h2><p>{strategy === 'weak' ? '暂无待复核、待确认或需补强的知识点，可切换智能抽取或完全随机。' : '知识点笔记正文可用后，会自动出现在这里。'}</p></div>
            ) : (
              <>
                {strategy !== 'random' && previousCandidate && <button type="button" className="review-preview-card is-previous" onClick={() => moveCandidate(-1)} aria-label={`切换到上一个知识点：${previousCandidate.noteTitle}`}><small>{previousCandidate.reason}</small><strong>{previousCandidate.noteTitle}</strong><span>{previousCandidate.mastery?.displayLabel || (previousCandidate.conceptMastery == null ? '未评估' : `历史评分 ${Math.round(previousCandidate.conceptMastery)}%`)}</span></button>}
                <article
                  key={activeCandidate.noteId}
                  className={`review-focus-card${cardMotion ? ` is-${cardMotion}` : ''}${knowledgeSelectionReady ? ' is-ready' : ''}`}
                  role={knowledgeSelectionReady ? 'button' : undefined}
                  tabIndex={knowledgeSelectionReady ? 0 : undefined}
                  aria-label={knowledgeSelectionReady ? `开始复习 ${activeCandidate.noteTitle}` : undefined}
                  title={knowledgeSelectionReady ? '单击进入苏格拉底复习' : undefined}
                  onClick={knowledgeSelectionReady ? enterActiveKnowledgeReview : undefined}
                  onKeyDown={knowledgeSelectionReady ? (event) => {
                    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      enterActiveKnowledgeReview();
                    }
                  } : undefined}
                >
                  {strategy === 'random' && <div className={`review-random-state is-${randomRollPhase}`}><Dices aria-hidden="true" /><span>{randomRollPhase === 'rolling' ? '知识卡带正在滚动…' : randomRollPhase === 'settled' ? '随机结果已定格' : '点击下方按钮开始随机抽取'}</span></div>}
                  <div className="review-focus-card-index">#{String(candidateIndex + 1).padStart(4, '0')}</div>
                  <h2>{activeNote.title}</h2>
                  <div className="review-focus-card-meta">
                    <small title={knowledgeCategory.source}>{knowledgeCategory.text}</small>
                    <span><Clock3 aria-hidden="true" />{activeCandidate.needsFirstReview ? '待首次复习' : knowledgePracticeRecency(activeNote)}</span>
                    {masteryReadMode() === 'legacy' && <span><BarChart3 aria-hidden="true" />{knowledgeMasteryCaption(activeNote)}</span>}
                  </div>
                  <p>{plainText(activeNote.content).slice(0, 180) || '该知识点尚未填写摘要，可以先凭记忆自由复述。'}</p>
                  {masteryReadMode() === 'current' && <KnowledgeMasteryStatus note={activeNote} compact />}
                  <div className="review-related-map">
                    <div>
                      <Network aria-hidden="true" />
                      <span>相关概念</span>
                      <small>
                        {relatedReviewNodePool.length > MAX_RELATED_GRAPH_NODES
                          ? `展示 ${relatedReviewNodes.length} / 共 ${relatedReviewNodePool.length} 个 · `
                          : `${relatedReviewNodePool.length} 个关联 · `}
                        实线：知识关联 · 虚线：项目关联
                      </small>
                    </div>
                    {relatedReviewNodes.length > 0 ? (
                      <div className="review-related-graph" aria-label={`${activeNote.title} 的相关知识与项目`}>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                          {relatedReviewNodes.map((node, index) => {
                            const position = relatedGraphPositions[index];
                            return <path key={node.id} className={`is-${node.kind}`} d={buildRelatedCurvePath(position)} />;
                          })}
                        </svg>
                        <strong className="review-related-center">{activeNote.title}</strong>
                        {relatedReviewNodes.map((node, index) => {
                          const position = relatedGraphPositions[index];
                          return (
                            <span
                              key={node.id}
                              className={`is-${node.kind} ${position.x < 50 ? 'is-left' : 'is-right'}`}
                              style={{ left: `${position.x}%`, top: `${position.y}%` }}
                              title={node.kind === 'project' ? '关联项目' : '关联知识点'}
                            >
                              {node.kind === 'project' && <Folder aria-hidden="true" />}{node.title}
                            </span>
                          );
                        })}
                      </div>
                    ) : <div className="review-related-empty">暂未建立知识点或项目关联</div>}
                  </div>
                </article>
                {strategy !== 'random' && nextCandidate && <button type="button" className="review-preview-card is-next" onClick={() => moveCandidate(1)} aria-label={`切换到下一个知识点：${nextCandidate.noteTitle}`}><small>{nextCandidate.reason}</small><strong>{nextCandidate.noteTitle}</strong><span>{nextCandidate.mastery?.displayLabel || (nextCandidate.conceptMastery == null ? '未评估' : `历史评分 ${Math.round(nextCandidate.conceptMastery)}%`)}</span></button>}
              </>
            )}
          </section>

          {candidates.length > 0 && (
            <footer className="review-picker-actions">
              <div className="review-picker-dots" aria-hidden="true">{candidates.slice(0, 7).map((candidate, index) => <i key={candidate.noteId} className={index === candidateIndex % Math.min(candidates.length, 7) ? 'is-active' : ''} />)}</div>
              <div className="review-entry-dock">
                <div className={`review-entry-summary${knowledgeSelectionReady ? ' is-ready' : ''}`}>
                  <Target aria-hidden="true" />
                  <span>
                    <small>{knowledgeSelectionReady ? '当前已选择' : '等待抽取结果'}</small>
                    <strong>{knowledgeSelectionReady ? activeCandidate?.noteTitle : '请先完成随机抽取'}</strong>
                    <em>{knowledgeSelectionReady ? '单击知识卡或右侧按钮，进入全屏苏格拉底对话。' : '抽取停稳后即可开始复习。'}</em>
                  </span>
                </div>
                <div className="quick-check-review-actions">
                {activeCandidate && <QuickCheckButton noteId={activeCandidate.noteId} source="review-hub" disabled={!knowledgeSelectionReady} />}
                <button type="button" className="review-knowledge-start" disabled={!knowledgeSelectionReady} onClick={enterActiveKnowledgeReview}>
                  <Play aria-hidden="true" />{knowledgeSelectionReady ? '开始复习' : '等待抽取'}
                </button>
                </div>
              </div>
            </footer>
          )}
        </>
      ) : (
        <section className="review-project-workspace">
          <aside className="review-project-browser">
            <div><Folder aria-hidden="true" /><strong>项目结构</strong><span>{reviewSchedule.projects.length} 个建议复习</span></div>
            {projectTree.length > 0 ? (
              <ProjectTree nodes={projectTree} expandedIds={expandedIds} selectedId={selectedProject?.id} recommendedById={recommendedById} onToggle={toggleProject} onSelect={chooseProject} />
            ) : <div className="review-project-empty"><BookOpen aria-hidden="true" />暂无项目笔记</div>}
          </aside>
          <div className="review-project-detail">
            {!selectedProject ? (
              <div className="review-project-placeholder"><Target aria-hidden="true" /><h2>选择一个项目</h2><p>第一轮保持自由发挥，系统会根据你的回答和关联知识点，在第二轮开始动态追问。</p></div>
            ) : (
              <>
                <div className="review-project-detail-head"><span>项目复习</span><h2>{selectedProject.title}</h2><p>{buildProjectReviewKnowledgeContext(selectedProject, allNotes)}</p></div>
                <section className="review-project-mastery" aria-label="项目关联知识点掌握情况">
                  <div className="review-project-mastery-head">
                    <div><BarChart3 aria-hidden="true" /><span><strong>关联知识掌握情况</strong><small>来自项目及其子项目的显式关联</small></span></div>
                    <em>{selectedProjectKnowledge.length} 个知识点</em>
                  </div>
                  {selectedProjectKnowledge.length > 0 ? (
                    <>
                      <div className="review-project-mastery-stats">
                        <div><small>{masteryReadMode() === 'current' ? '已确认' : '历史平均评分'}</small><strong>{masteryReadMode() === 'current' ? projectMasterySummary.current.confirmedCount : projectMasterySummary.average == null ? '—' : `${projectMasterySummary.average}%`}</strong></div>
                        <div><small>{masteryReadMode() === 'current' ? '待复核' : '历史低分'}</small><strong>{masteryReadMode() === 'current' ? projectMasterySummary.current.bands.needs_review : projectMasterySummary.weak}</strong></div>
                        <div><small>待评估</small><strong>{masteryReadMode() === 'current' ? projectMasterySummary.current.assessment.unassessed : projectMasterySummary.unassessed}</strong></div>
                      </div>
                      <div className="review-project-mastery-list">
                        {projectMasterySummary.sorted.map((note) => {
                          return (
                            <div key={note.id}>
                              <span><strong>{note.title}</strong><em>{knowledgeMasteryCaption(note)}</em></span>
                              <small>{readKnowledgeMastery(note).summary}</small>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : <div className="review-project-mastery-empty">该项目还没有显式关联的知识点</div>}
                </section>
                <div className="review-project-question-head"><div><BrainCircuit aria-hidden="true" /><strong>可选问题卡</strong></div><span>不选择时使用自由复述开场</span></div>
                <div className="review-project-questions">
                  {projectQuestions.length === 0 ? <div className="review-project-empty"><BookOpen aria-hidden="true" />该项目暂无问题卡，将从自由复述开始</div> : projectQuestions.map((question) => {
                    const checked = selectedQuestionIds.has(question.id);
                    return <button type="button" key={question.id} aria-pressed={checked} className={checked ? 'is-selected' : ''} onClick={() => toggleQuestion(question.id)}>{checked ? <CheckSquare aria-hidden="true" /> : <Square aria-hidden="true" />}<span><strong>{question.question}</strong></span></button>;
                  })}
                </div>
                <button type="button" className="review-project-start" onClick={startProjectReview}><Play aria-hidden="true" />{selectedQuestionIds.size > 0 ? `开始复习 · 已选 ${selectedQuestionIds.size} 个问题` : '开始自由复述'}</button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
};
