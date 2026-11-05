import React, { useState, useMemo, useRef, useCallback, useEffect, useId } from 'react';
import { NoteItem, LearnMode, FlowSettings, SceneInitialRequest } from '../types';
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FolderTree,
  Layers3,
  MessageSquare,
  Route,
  Sparkles,
  TimerReset,
} from 'lucide-react';
import { FlowEntranceModal } from './FlowEntranceModal';
import { StormMode } from './StormMode';
import { SceneBuilderPanel } from './scene/SceneBuilderPanel';
import { ProjectTreePanel, buildProjectTreeStructure } from './ProjectTreePanel';
import { buildLearningProjectQueue, type FlowProjectEntry } from '../services/learningProjectQueue';
import { useLocalCalendarDate } from './useLocalCalendarDate';
import { LearningPreparationPanel } from './progressive/LearningPreparationPanel';
import { preparationRoot } from '../services/progressiveLearning/preparation';

interface LearnHubProps {
  notes: NoteItem[];
  flowSettings: FlowSettings;
  onEnterFlow: (noteId: string, reviewIntervalMinutes: number) => void;
  onUpdateNote: (u: NoteItem, signal?: AbortSignal, expected?: NoteItem | null) => void | Promise<void>;
  onOpenNote?: (id: string) => void;
  /** 场景模拟：进入 SceneMode 全屏视图（由 App 承载） */
  onEnterScene?: (request: SceneInitialRequest) => void;
}

type LearningHubMode = Exclude<LearnMode, 'review'>;

interface LearnModeDefinition {
  key: LearningHubMode;
  eyebrow: string;
  label: string;
  description: string;
  Icon: typeof BrainCircuit;
}

const LEARN_MODES: LearnModeDefinition[] = [
  { key: 'flow', eyebrow: 'FOCUS', label: '心流学习', description: '围绕项目持续复述、理解与沉淀', Icon: BrainCircuit },
  { key: 'storm', eyebrow: 'EXPLORE', label: 'STORM', description: '用多视角研究拓宽问题边界', Icon: Sparkles },
  { key: 'scene', eyebrow: 'PRACTICE', label: '场景模拟', description: '把知识放进真实任务中检验', Icon: MessageSquare },
];

const MODE_COPY: Record<LearningHubMode, { title: string; description: string }> = {
  flow: { title: '把注意力交给真正重要的项目', description: '沿着项目结构进入专注学习；系统会按时间、完成度与层级整理下一步。' },
  storm: { title: '从一个问题出发，建立更宽的观察坐标', description: '通过多视角扫描、矛盾图谱、综合简报与同行评审形成研究文档。' },
  scene: { title: '把知识放进情境，在行动中验证理解', description: '选择项目和训练目标，由场景组件装配对话、答题、决策或数理推导。' },
};

const DueBadge: React.FC<{ entry: FlowProjectEntry }> = ({ entry }) => {
  if (entry.inactiveStatus) return <span className="flow-due-badge flow-due-badge--none">{{ draft: '草稿', paused: '已暂停', archived: '已归档', completed: '计划已完成' }[entry.inactiveStatus]}</span>;
  if (entry.isFullyCompleted) return <span className="flow-due-badge flow-due-badge--done"><CheckCircle2 />已完成</span>;
  if (!entry.nearestDueDate) return <span className="flow-due-badge flow-due-badge--none">自由学习</span>;
  if (entry.isToday) return <span className="flow-due-badge flow-due-badge--today"><Clock3 />今天</span>;
  if (entry.isTomorrow) return <span className="flow-due-badge flow-due-badge--tomorrow">明天</span>;
  if (entry.isOverdue) return <span className="flow-due-badge flow-due-badge--overdue">需跟进</span>;
  const [, month, day] = entry.nearestDueDate.split('-');
  return <span className="flow-due-badge flow-due-badge--normal">{parseInt(month)}/{parseInt(day)}</span>;
};

const progressOf = (entry: FlowProjectEntry) => entry.totalTasks > 0
  ? Math.round((entry.completedTasks / entry.totalTasks) * 100)
  : 0;

export const LearnHub: React.FC<LearnHubProps> = ({ notes, flowSettings, onEnterFlow, onUpdateNote, onOpenNote, onEnterScene }) => {
  const [learnMode, setLearnMode] = useState<LearningHubMode>('flow');
  const [selectedNote, setSelectedNote] = useState<NoteItem | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const today = useLocalCalendarDate();
  const modeId = useId();
  const tabRefs = useRef<Map<LearningHubMode, HTMLButtonElement>>(new Map());

  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const projectTree = useMemo(() => buildProjectTreeStructure(notes, { projectOnly: true }), [notes]);
  const flowEntries = useMemo(() => buildLearningProjectQueue(notes, today), [notes, today]);
  const hasProjects = flowEntries.length > 0;
  const activeEntries = useMemo(() => flowEntries.filter(entry => !entry.isFullyCompleted && !entry.inactiveStatus), [flowEntries]);
  const recommended = activeEntries[0] || flowEntries[0] || null;
  const queueEntries = recommended ? flowEntries.filter(entry => entry.note.id !== recommended.note.id) : flowEntries;
  const pendingTasks = useMemo(
    () => activeEntries.reduce((total, entry) => total + entry.totalTasks - entry.completedTasks, 0),
    [activeEntries],
  );
  const urgentProjects = activeEntries.filter(entry => entry.isToday || entry.isOverdue).length;
  const currentCopy = MODE_COPY[learnMode];
  const preparationTarget = notes.find(note => note.id === selectedTreeId) || recommended?.note;
  const preparation = preparationTarget ? preparationRoot(preparationTarget, notes) : undefined;

  // Keep users' collapsed branches closed when a note autosaves or completion updates.
  useEffect(() => { setExpandedIds(new Set(projectTree.map(n => n.note.id))); }, []);

  const handleTreeSelect = useCallback((id: string) => {
    // 结构树仍展示完整层级；点击非叶子节点时，定位其当前排序最靠前的叶子项目。
    const target = flowEntries.find(entry => (
      entry.note.id === id || entry.parentChain.some(parent => parent.id === id)
    ));
    const targetId = target?.note.id || id;
    setSelectedTreeId(targetId);
    const card = cardRefs.current.get(targetId);
    card?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    card?.focus({ preventScroll: true });
  }, [flowEntries]);
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);
  const setCardRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);
  const openProject = useCallback((note: NoteItem) => { setLaunchError(null); setSelectedNote(note); }, []);
  const handleModeKey = (event: React.KeyboardEvent<HTMLButtonElement>, key: LearningHubMode) => {
    const index = LEARN_MODES.findIndex(mode => mode.key === key);
    const next = event.key === 'ArrowRight' ? (index + 1) % LEARN_MODES.length
      : event.key === 'ArrowLeft' ? (index + LEARN_MODES.length - 1) % LEARN_MODES.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? LEARN_MODES.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    // Manual activation avoids mounting a model-backed mode merely while navigating tabs.
    tabRefs.current.get(LEARN_MODES[next].key)?.focus();
  };

  const renderProjectCard = (entry: FlowProjectEntry) => (
    <button
      type="button"
      key={entry.note.id}
      ref={setCardRef(entry.note.id)}
      className={`flow-project-card ${selectedTreeId === entry.note.id ? 'flow-project-card--highlighted' : ''}`}
      aria-label={`打开项目：${entry.parentChain.length > 0 ? `${entry.parentChain.map(parent => parent.title).join(' / ')} / ` : ''}${entry.note.title}`}
      onClick={() => openProject(entry.note)}
    >
      <div className="flow-project-card-index"><BookOpen /></div>
      <div className="flow-project-card-body">
        {entry.parentChain.length > 0 && (
          <div className="flow-project-card-parent">{entry.parentChain.map(parent => parent.title).join(' / ')}</div>
        )}
        <div className="flow-project-card-title">{entry.note.title}</div>
        {entry.totalTasks > 0 && <div className="flow-project-card-progress">
          <span role="progressbar" aria-label="项目完成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressOf(entry)}><i style={{ width: `${progressOf(entry)}%` }} /></span>
          <small>{entry.completedTasks}/{entry.totalTasks || 0} 项</small>
        </div>}
      </div>
      <DueBadge entry={entry} />
      <ArrowRight className="flow-project-card-arrow" />
    </button>
  );

  return (
    <div className={`learn-hub-container learn-studio learn-studio--${learnMode}`}>
      <header className="learn-studio-header">
        <div className="learn-studio-heading">
          <span className="learn-studio-eyebrow"><span /> LEARNING STUDIO</span>
          <h1>{currentCopy.title}</h1>
          <p>{currentCopy.description}</p>
        </div>

        <nav className="learn-mode-switcher" role="tablist" aria-label="学习方式">
          {LEARN_MODES.map(mode => (
            <button
              key={mode.key}
              type="button"
              role="tab"
              id={`${modeId}-${mode.key}`}
              aria-controls={`${modeId}-panel`}
              aria-selected={learnMode === mode.key}
              tabIndex={learnMode === mode.key ? 0 : -1}
              ref={element => { if (element) tabRefs.current.set(mode.key, element); else tabRefs.current.delete(mode.key); }}
              onKeyDown={event => handleModeKey(event, mode.key)}
              className={`learn-mode-option ${learnMode === mode.key ? 'is-active' : ''}`}
              onClick={() => setLearnMode(mode.key)}
            >
              <span className="learn-mode-option-icon"><mode.Icon /></span>
              <span className="learn-mode-option-copy"><small>{mode.eyebrow}</small><strong>{mode.label}</strong><em>{mode.description}</em></span>
              <ArrowRight className="learn-mode-option-arrow" />
            </button>
          ))}
        </nav>
      </header>

      {launchError && <p role="alert" className="learn-launch-error">{launchError}</p>}
      <main id={`${modeId}-panel`} role="tabpanel" aria-labelledby={`${modeId}-${learnMode}`} className="learn-content-area">
        {learnMode === 'flow' ? (
          !hasProjects ? (
            <div className="learn-studio-empty">
              <div><BookOpen /></div>
              <span>EMPTY LIBRARY</span>
              <h2>还没有可以进入的项目笔记</h2>
              <p>先创建学习计划，保存后即可选择叶子项目进入心流。</p>
            </div>
          ) : (
            <section className="learn-flow-workspace">
              <aside className="flow-dual-left">
                <div className="flow-dual-left-header">
                  <span><FolderTree />项目脉络</span>
                  <small>{projectTree.length} 个根项目</small>
                </div>
                <div className="learn-flow-overview">
                  <div><strong>{activeEntries.length}</strong><span>进行中</span></div>
                  <div><strong>{pendingTasks}</strong><span>项目待办</span></div>
                  <div className={urgentProjects > 0 ? 'is-urgent' : ''}><strong>{urgentProjects}</strong><span>需跟进</span></div>
                </div>
                <div className="learn-flow-tree-scroll">
                  <ProjectTreePanel nodes={projectTree} expandedIds={expandedIds} selectedTreeId={selectedTreeId} onToggleExpand={toggleExpand} onSelect={handleTreeSelect} />
                </div>
                <div className="learn-flow-tree-foot"><Route /><span>点击项目可在右侧定位</span></div>
              </aside>

              <div className="flow-dual-right">
                {preparation && <LearningPreparationPanel key={preparation.id} rootId={preparation.id} title={preparation.title} />}
                {recommended && (
                  <div className="learn-next-card" tabIndex={-1} ref={setCardRef(recommended.note.id)}>
                    <div className="learn-next-card-top">
                      <span><TimerReset />{recommended.inactiveStatus || recommended.isFullyCompleted ? '回顾这个项目' : recommended.isFuture ? '可以提前准备' : '建议从这里继续'}</span>
                      <DueBadge entry={recommended} />
                    </div>
                    {recommended.parentChain.length > 0 && <div className="learn-next-path">{recommended.parentChain.map(parent => parent.title).join(' / ')}</div>}
                    <h2>{recommended.note.title}</h2>
                    <p>{recommended.totalTasks > 0 ? `已完成 ${recommended.completedTasks} 项，还有 ${Math.max(0, recommended.totalTasks - recommended.completedTasks)} 项等待推进。` : '这个项目还没有排定任务，可以自由进入并继续补充理解。'}</p>
                    <div className="learn-next-card-foot">
                      {recommended.totalTasks > 0 ? <div className="learn-next-progress"><span role="progressbar" aria-label="项目完成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressOf(recommended)}><i style={{ width: `${progressOf(recommended)}%` }} /></span><small>{progressOf(recommended)}%</small></div>
                        : <span className="learn-next-free">未设置项目时限</span>}
                      <button type="button" onClick={() => openProject(recommended.note)}>进入心流 <ArrowRight /></button>
                    </div>
                  </div>
                )}

                <div className="learn-queue-head">
                  <div><span>PROJECT QUEUE</span><h3>学习队列</h3></div>
                  <p><CalendarClock />按截止时间与完成状态排序</p>
                </div>
                <div className="learn-project-list">
                  {queueEntries.length > 0 ? queueEntries.map(renderProjectCard) : (
                    <div className="learn-queue-empty"><CheckCircle2 /><span>没有其他待处理项目</span></div>
                  )}
                </div>
              </div>
            </section>
          )
        ) : (
          <section className={`learn-mode-workspace is-${learnMode}`}>
            <div className="learn-mode-workspace-mark" aria-hidden="true">
              {learnMode === 'storm' ? <Layers3 /> : <Route />}
            </div>
            <div className="learn-mode-workspace-body">
              {learnMode === 'storm'
                ? <StormMode allNotes={notes} onUpdateNote={onUpdateNote} onOpenNote={onOpenNote} />
                : <SceneBuilderPanel allNotes={notes} onEnterScene={(request) => onEnterScene?.(request)} />}
            </div>
          </section>
        )}
      </main>

      {selectedNote && (
        <FlowEntranceModal
          isOpen
          note={flowEntries.find(entry => entry.note.id === selectedNote.id)?.note || selectedNote}
          defaultInterval={flowSettings.reviewIntervalMinutes}
          onClose={() => setSelectedNote(null)}
          onConfirm={(noteId, interval) => {
            setSelectedNote(null);
            if (!flowEntries.some(entry => entry.note.id === noteId)) {
              setLaunchError('该项目已被移除或不再是末级项目，请重新选择。');
              return;
            }
            onEnterFlow(noteId, interval);
          }}
        />
      )}
    </div>
  );
};
