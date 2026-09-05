import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { NoteItem, LearnMode, FlowSettings } from '../types';
import { BookOpen, BrainCircuit, ArrowRight, CalendarClock, Folder, ChevronRight, ChevronDown, Check, Sparkles } from 'lucide-react';
import { FlowEntranceModal } from './FlowEntranceModal';
import { ReviewHub } from './ReviewHub';
import { StormMode } from './StormMode';

interface LearnHubProps {
  notes: NoteItem[];
  flowSettings: FlowSettings;
  onEnterFlow: (noteId: string, reviewIntervalMinutes: number) => void;
  onEnterReview?: (noteId: string, noteTitle: string, question: string, context: string) => void;
  onEnterBubbleMode?: () => void;
  onUpdateNote: (u: NoteItem) => void;
}

interface FlowProjectEntry { note: NoteItem; nearestDueDate: string | null; isToday: boolean; isTomorrow: boolean; isOverdue: boolean; parentChain: { id: string; title: string }[]; totalTasks: number; completedTasks: number; isFullyCompleted: boolean; }
interface ProjectTreeNode { note: NoteItem; children: ProjectTreeNode[]; fullyCompleted: boolean; }

function buildProjectTree(note: NoteItem, allNotes: NoteItem[]): NoteItem[] { const children = allNotes.filter(n => n.parentId === note.id); let result = [note]; children.forEach(child => { result = result.concat(buildProjectTree(child, allNotes)); }); return result; }
function isProjectFullyCompleted(note: NoteItem, allNotes: NoteItem[]): boolean { const tree = buildProjectTree(note, allNotes); const allDues = tree.flatMap(n => n.dueDates || []); if (allDues.length === 0) return false; return allDues.every(d => d.completed); }
function getNearestDueDate(note: NoteItem, allNotes: NoteItem[]): { date: string | null; isToday: boolean; isTomorrow: boolean; isOverdue: boolean } { const tree = buildProjectTree(note, allNotes); const pendingDues = tree.flatMap(n => n.dueDates || []).filter(d => !d.completed).map(d => d.dueDate).sort(); const nearest = pendingDues[0] || null; if (!nearest) return { date: null, isToday: false, isTomorrow: false, isOverdue: false }; const today = new Date().toISOString().slice(0, 10); const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10); return { date: nearest, isToday: nearest === today, isTomorrow: nearest === tomorrow, isOverdue: nearest < today }; }
function getParentChain(noteId: string, allNotes: NoteItem[]): { id: string; title: string }[] { const chain: { id: string; title: string }[] = []; let current = allNotes.find(n => n.id === noteId); while (current?.parentId) { const parent = allNotes.find(n => n.id === current!.parentId); if (!parent) break; chain.unshift({ id: parent.id, title: parent.title }); current = parent; } return chain; }
function buildProjectTreeStructure(notes: NoteItem[]): ProjectTreeNode[] { const roots = notes.filter(n => n.noteType === 'project' && !n.parentId); const buildNode = (note: NoteItem): ProjectTreeNode => { const children = notes.filter(n => n.parentId === note.id); return { note, children: children.map(buildNode), fullyCompleted: isProjectFullyCompleted(note, notes) }; }; return roots.map(buildNode); }
function buildFlowEntries(notes: NoteItem[]): FlowProjectEntry[] { const allProjects = notes.filter(n => n.noteType === 'project'); const entries: FlowProjectEntry[] = allProjects.map(note => { const tree = buildProjectTree(note, notes); const allDues = tree.flatMap(n => n.dueDates || []); const completedDues = allDues.filter(d => d.completed); const dueInfo = getNearestDueDate(note, notes); return { note, nearestDueDate: dueInfo.date, isToday: dueInfo.isToday, isTomorrow: dueInfo.isTomorrow, isOverdue: dueInfo.isOverdue, parentChain: getParentChain(note.id, notes), totalTasks: allDues.length, completedTasks: completedDues.length, isFullyCompleted: isProjectFullyCompleted(note, notes) }; }); entries.sort((a, b) => { if (a.isFullyCompleted && !b.isFullyCompleted) return 1; if (!a.isFullyCompleted && b.isFullyCompleted) return -1; if (a.isFullyCompleted && b.isFullyCompleted) return new Date(b.note.createdAt).getTime() - new Date(a.note.createdAt).getTime(); if (a.nearestDueDate && !b.nearestDueDate) return -1; if (!a.nearestDueDate && b.nearestDueDate) return 1; if (a.nearestDueDate && b.nearestDueDate) return a.nearestDueDate.localeCompare(b.nearestDueDate); return new Date(b.note.createdAt).getTime() - new Date(a.note.createdAt).getTime(); }); return entries; }

const DueBadge: React.FC<{ date: string | null; isToday: boolean; isTomorrow: boolean; isOverdue: boolean; isCompleted: boolean }> = ({ date, isToday, isTomorrow, isOverdue, isCompleted }) => {
  if (isCompleted) return <span className="flow-due-badge flow-due-badge--done">✓ 已完成</span>;
  if (!date) return <span className="flow-due-badge flow-due-badge--none">未设置</span>;
  if (isToday) { const [, month, day] = date.split('-'); return <span className="flow-due-badge flow-due-badge--today">今天 {parseInt(month)}/{parseInt(day)}</span>; }
  if (isTomorrow) return <span className="flow-due-badge flow-due-badge--tomorrow">明天</span>;
  if (isOverdue) return <span className="flow-due-badge flow-due-badge--overdue">已过期</span>;
  const [, month, day] = date.split('-'); return <span className="flow-due-badge flow-due-badge--normal">{parseInt(month)}/{parseInt(day)}</span>;
};

const ProjectTreePanel: React.FC<{ nodes: ProjectTreeNode[]; expandedIds: Set<string>; selectedTreeId: string | null; onToggleExpand: (id: string) => void; onSelect: (id: string) => void }> = ({ nodes, expandedIds, selectedTreeId, onToggleExpand, onSelect }) => {
  const renderNode = (node: ProjectTreeNode, depth: number): React.ReactNode => (
    <div key={node.note.id}>
      <div className={`flow-tree-node ${selectedTreeId === node.note.id ? 'flow-tree-node--active' : ''}`} style={{ paddingLeft: `${8 + depth * 16}px` }} onClick={() => onSelect(node.note.id)}>
        <button className="flow-tree-node-chevron" onClick={(e) => { e.stopPropagation(); onToggleExpand(node.note.id); }}>
          {node.children.length > 0 ? (expandedIds.has(node.note.id) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="w-3 h-3" />}
        </button>
        <Folder className="w-3 h-3 text-emerald-500 flex-shrink-0" />
        <span className="flow-tree-node-title">{node.note.title || '未命名项目'}</span>
        {node.fullyCompleted && <Check className="w-3 h-3 text-emerald-500 flex-shrink-0 ml-1" />}
      </div>
      {expandedIds.has(node.note.id) && node.children.map(child => renderNode(child, depth + 1))}
    </div>
  );
  return <div className="flow-tree-panel">{nodes.map(n => renderNode(n, 0))}</div>;
};

export const LearnHub: React.FC<LearnHubProps> = ({ notes, flowSettings, onEnterFlow, onEnterReview, onEnterBubbleMode, onUpdateNote }) => {
  const [learnMode, setLearnMode] = useState<LearnMode>('flow');
  const [selectedNote, setSelectedNote] = useState<NoteItem | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);

  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const projectTree = useMemo(() => buildProjectTreeStructure(notes), [notes]);
  const flowEntries = useMemo(() => buildFlowEntries(notes), [notes]);
  const hasProjects = useMemo(() => notes.some(n => n.noteType === 'project'), [notes]);

  useEffect(() => { setExpandedIds(new Set(projectTree.map(n => n.note.id))); }, [projectTree]);

  const handleTreeSelect = useCallback((id: string) => { setSelectedTreeId(id); const cardEl = cardRefs.current.get(id); if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, []);
  const toggleExpand = useCallback((id: string) => { setExpandedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; }); }, []);
  const setCardRef = useCallback((id: string) => (el: HTMLDivElement | null) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id); }, []);

  const learnModes: Array<{ key: LearnMode; label: string; Icon: typeof BrainCircuit }> = [
    { key: 'flow', label: '心流模式', Icon: BrainCircuit },
    { key: 'review', label: '复习模式', Icon: CalendarClock },
    { key: 'storm', label: 'STORM', Icon: Sparkles },
  ];

  return (
    <div className="learn-hub-container flex-1" style={{ flex: 1 }}>
      <div className="flex flex-col items-center gap-2">
        <h2 className="learn-hub-title">今天想怎么学？</h2>
        <p className="learn-hub-subtitle">进入心流、专注投入，或按遗忘曲线科学复习——选一个频道开始吧。</p>
      </div>

      <div className="fluid-toggle-wrapper">
        <div className="fluid-toggle">
          <div className="fluid-toggle-indicator" style={{ left: learnMode === 'flow' ? '0.3rem' : learnMode === 'review' ? 'calc(0.3rem + 130px)' : 'calc(0.3rem + 260px)', width: '130px' }} />
          {learnModes.map(m => (
            <button key={m.key} className={`fluid-toggle-option ${learnMode === m.key ? 'active' : ''}`} onClick={() => setLearnMode(m.key)}><m.Icon className="w-4 h-4" /> {m.label}</button>
          ))}
        </div>
      </div>

      <div className="learn-content-area">
        {learnMode === 'flow' ? (
          !hasProjects ? (
            <div className="flow-full-empty" style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
              <div className="learn-review-placeholder" style={{ minHeight: 200, flex: 1 }}>
                <div className="learn-review-placeholder-icon"><BookOpen className="w-8 h-8" /></div>
                <h3 className="learn-review-placeholder-title">还没有项目笔记</h3>
                <p className="learn-review-placeholder-desc">请在笔记编辑器中创建一个项目类型的笔记，然后回到这里开始专注学习</p>
              </div>
            </div>
          ) : (
            <div className="flow-dual-panel">
              <div className="flow-dual-left">
                <div className="flow-dual-left-header"><Folder className="w-3.5 h-3.5 text-emerald-500" /><span>项目结构</span></div>
                <ProjectTreePanel nodes={projectTree} expandedIds={expandedIds} selectedTreeId={selectedTreeId} onToggleExpand={toggleExpand} onSelect={handleTreeSelect} />
              </div>
              <div className="flow-dual-right">
                <div className="flow-dual-right-header"><CalendarClock className="w-3.5 h-3.5 text-indigo-500" /><span>按时间排序</span>{flowEntries.length > 0 && <span className="flow-dual-right-count">{flowEntries.length} 个项目</span>}</div>
                <div className="learn-project-list">
                  {flowEntries.length === 0 ? (
                    <div className="flow-empty-illustration"><div className="flow-empty-illustration-icon"><Sparkles className="w-9 h-9" /></div><h3 className="flow-empty-illustration-title">全部学习计划已完成！</h3><p className="flow-empty-illustration-desc">太棒了！当前所有项目任务都已完成。<br />去计划板块创建新的学习目标吧。</p></div>
                  ) : (
                    flowEntries.map(entry => (
                      <div key={entry.note.id} ref={setCardRef(entry.note.id)} className={`flow-project-card ${selectedTreeId === entry.note.id ? 'flow-project-card--highlighted' : ''}`} onClick={() => setSelectedNote(entry.note)}>
                        <div className="flow-project-card-icon"><BookOpen className="w-5 h-5" /></div>
                        <div className="flow-project-card-body">
                          <div className="flow-project-card-title">{entry.note.title}</div>
                          <div className="flow-project-card-meta"><span>{entry.totalTasks} 个任务</span>{entry.parentChain.length > 0 && <span className="flow-project-card-parent">{entry.parentChain.map(p => p.title).join(' › ')}</span>}</div>
                        </div>
                        <DueBadge date={entry.nearestDueDate} isToday={entry.isToday} isTomorrow={entry.isTomorrow} isOverdue={entry.isOverdue} isCompleted={entry.isFullyCompleted} />
                        <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0 ml-1" />
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )
        ) : learnMode === 'storm' ? (
          <StormMode allNotes={notes} onUpdateNote={onUpdateNote} />
        ) : (
          <ReviewHub allNotes={notes} onEnterReview={onEnterReview} onEnterBubbleMode={onEnterBubbleMode} />
        )}
      </div>
      {selectedNote && <FlowEntranceModal isOpen={!!selectedNote} note={selectedNote} defaultInterval={flowSettings.reviewIntervalMinutes} onClose={() => setSelectedNote(null)} onConfirm={(noteId, interval) => { setSelectedNote(null); onEnterFlow(noteId, interval); }} />}
    </div>
  );
};