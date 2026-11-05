import React, { useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, RotateCcw } from 'lucide-react';
import type { NoteItem, VaultSettings } from '../types';
import { getLearningCompletionTarget, getProjectCompletionTarget, type LearningCompletionTarget } from '../services/learningCompletion';
import { commitLearningCompletion } from '../services/ui/learningCompletionWrite';
import { getScheduledProjectState } from '../services/planProjectState';
import { createMockFlowResult } from '../services/flowAnalysis/mockResult';
import { NoteEditor } from './NoteEditor';
import { LearningCompletionCard } from './LearningCompletionCard';
import { FlowResultView } from './FlowResultView';
import { SceneS1DemoPage } from './scene/SceneS1DemoPage';
import { SceneS4DemoPage } from './scene/SceneS4DemoPage';

const DATE = '2026-10-06';
const STAMP = `${DATE}T09:00:00.000+08:00`;
type DemoTab = 'leaf' | 'closeout' | 'parent' | 'ordinary' | 'recurring' | 'result' | 's1' | 's4';
const TABS: [DemoTab, string][] = [
  ['leaf', '叶子笔记'], ['closeout', '学习收尾'], ['parent', '父项目'], ['ordinary', '普通笔记'],
  ['recurring', '周期任务'], ['result', '复盘结果'], ['s1', 'S1 场景'], ['s4', 'S4 场景'],
];

function fixtures(): NoteItem[] {
  const project = (id: string, title: string, parentId?: string, scheduled = true): NoteItem => ({
    id, title, parentId, noteType: 'project', tags: [], links: [], backlinks: [],
    content: scheduled
      ? `# ${title}\n\n这是一份隔离的交互演示笔记，可编辑正文，再确认任务完成。\n\n- [ ] ${title} @due(2026-10-08)\n`
      : '# 普通项目对象\n\n这里只用于整理笔记，没有计划时限，因此不显示完成入口。',
    dueDates: scheduled ? [{ id: `due-${id}-4`, noteId: id, noteTitle: title, taskText: title,
      startDate: DATE, dueDate: '2026-10-08', completed: false, priority: 'medium' }] : [],
    createdAt: STAMP, updatedAt: STAMP,
  });
  const root = project('completion-demo-root', '概率论学习计划');
  root.planMeta = { schemaVersion: 2, status: 'active', weeklyBudgetMinutes: 600, milestones: [{ id: 'demo-flag', title: '分布基础验收', dueDate: '2026-10-08' }], updatedAt: STAMP };
  root.dueDates.push({ id: 'completion-demo-review', noteId: root.id, noteTitle: root.title, taskText: '每日回忆正态分布公式',
    startDate: DATE, dueDate: DATE, completed: false, priority: 'medium', recurrence: { frequency: 'daily', endDate: '2026-10-12' }, estimatedMinutes: 20 });
  return [root, project('completion-demo-parent', '掌握常见分布', root.id),
    project('completion-demo-leaf', '学习正态分布', 'completion-demo-parent'),
    project('completion-demo-leaf-2', '学习二项分布', 'completion-demo-parent'),
    project('completion-demo-ordinary', '概率论资料整理', undefined, false)];
}

/** QA-only workspace. Every mutation and simulated save stays in component memory. */
export const LearningCompletionDemoPage: React.FC<{ settings: VaultSettings }> = ({ settings }) => {
  const [notes, setNotes] = useState(fixtures);
  const notesRef = useRef(notes);
  const [tab, setTab] = useState<DemoTab>('leaf');
  const [failNext, setFailNext] = useState(false);
  const failNextRef = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [result, setResult] = useState(createMockFlowResult);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [sceneStatus, setSceneStatus] = useState<'idle' | 'running' | 'finished'>('idle');
  const updateNotes = (next: NoteItem[]) => { notesRef.current = next; setNotes(next); };
  const updateNote = (updated: NoteItem) => updateNotes(notesRef.current.map((note) => note.id === updated.id ? updated : note));
  const onSetCompleted = (target: LearningCompletionTarget, completed: boolean) => commitLearningCompletion({
    readNotes: () => notesRef.current,
    saveNotes: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (failNextRef.current) {
        failNextRef.current = false; setFailNext(false);
        throw new Error('模拟保存失败，笔记内容未丢失；请重试。');
      }
    },
    applyNotes: updateNotes,
  }, target, completed);
  const target = getProjectCompletionTarget(notes, 'completion-demo-leaf');
  const recurring = getLearningCompletionTarget(notes, { noteId: 'completion-demo-root', taskId: 'completion-demo-review', occurrenceDate: DATE });
  const nextOccurrence = getLearningCompletionTarget(notes, { noteId: 'completion-demo-root', taskId: 'completion-demo-review', occurrenceDate: '2026-10-07' });
  const parentState = getScheduledProjectState(notes, 'completion-demo-parent');
  const rootState = getScheduledProjectState(notes, 'completion-demo-root');
  const card = (kind: 'inline' | 'result', context: 'flow' | 'scene' = 'flow') => <LearningCompletionCard
    target={target} onSetCompleted={onSetCompleted} variant={kind} context={context}
    onDismiss={context === 'flow' && tab === 'closeout' ? () => setDismissed(true) : undefined}
  />;
  const noteId = tab === 'parent' ? 'completion-demo-parent' : tab === 'ordinary' ? 'completion-demo-ordinary' : 'completion-demo-leaf';
  const sceneCard = card('result', 'scene');
  const sceneLocked = sceneStatus !== 'idle';
  const switchTab = (next: DemoTab) => { if (sceneLocked) return; setTab(next); setDismissed(false); };
  const exitScene = () => { if (sceneStatus !== 'finished') return; setSceneStatus('idle'); setTab('leaf'); setDismissed(false); };
  const reset = () => {
    if (sceneLocked) return;
    updateNotes(fixtures()); setDismissed(false); failNextRef.current = false; setFailNext(false);
    setResult(createMockFlowResult()); setSceneVersion((value) => value + 1);
  };
  const topButton: React.CSSProperties = {
    minHeight: '2rem', display: 'inline-flex', alignItems: 'center', gap: '.35rem', padding: '.4rem .65rem',
    border: '1px solid var(--ln-border)', borderRadius: 'var(--ln-radius-sm)', fontSize: '.72rem', cursor: sceneLocked ? 'not-allowed' : 'pointer', opacity: sceneLocked ? 0.55 : 1,
  };

  return (
    <div style={{ height: '100dvh', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--ln-bg-surface)', color: 'var(--ln-text-primary)' }}>
      <header style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '.6rem', padding: '.7rem 1rem', borderBottom: '1px solid var(--ln-border-subtle)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', color: 'var(--ln-accent)', fontSize: '.72rem', fontWeight: 700 }}><FlaskConical size={15} />交互预览 · 不写入笔记库</span>
        <nav aria-label="学习完成演示类型" style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
          {TABS.map(([id, label]) => <button key={id} type="button" disabled={sceneLocked} aria-pressed={tab === id} onClick={() => switchTab(id)}
            style={{ ...topButton, background: tab === id ? 'var(--ln-accent)' : 'var(--ln-bg-surface)', color: tab === id ? 'var(--ln-bg-surface)' : 'var(--ln-text-secondary)' }}>{label}</button>)}
        </nav>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem', marginLeft: 'auto', color: 'var(--ln-text-secondary)', fontSize: '.72rem' }}>
          <input type="checkbox" checked={failNext} onChange={(event) => { failNextRef.current = event.target.checked; setFailNext(event.target.checked); }} />模拟下次保存失败
        </label>
        <button type="button" disabled={sceneLocked} onClick={reset} style={{ ...topButton, color: 'var(--ln-accent)', background: 'var(--ln-bg-surface)' }}><RotateCcw size={14} />重置演示</button>
      </header>
      <div role="status" aria-live="polite" style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', gap: '.8rem', padding: '.45rem 1rem', background: 'var(--ln-accent-soft)', color: 'var(--ln-text-secondary)', fontSize: '.7rem' }}>
        <span>正态分布：{target?.completed ? '已完成' : '未完成'}</span>
        <span>二项分布：{getScheduledProjectState(notes, 'completion-demo-leaf-2').completed ? '已完成' : '未完成'}</span>
        <span>父项目：{parentState.progress}%</span><span>根项目：{rootState.progress}%</span>
        {tab === 'recurring' && <span>明日待办：{nextOccurrence?.completed ? '已完成' : '未完成'}</span>}
      </div>
      <main style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {['leaf', 'closeout', 'parent', 'ordinary'].includes(tab) && <>
          {tab === 'closeout' && !dismissed && <div style={{ padding: '.9rem 1rem', flexShrink: 0 }}>{card('inline')}</div>}
          <NoteEditor note={notes.find((note) => note.id === noteId)!} allNotes={notes} settings={settings} onUpdateNote={updateNote}
            onSelectNoteByTitle={() => {}} onSetLearningCompletion={onSetCompleted} hideLearningCompletionControl={tab === 'closeout' && !dismissed} />
        </>}
        {tab === 'recurring' && <div style={{ padding: '1.25rem', overflow: 'auto' }}>
          <LearningCompletionCard target={recurring} onSetCompleted={onSetCompleted} variant="inline" context="flow" />
          <p style={{ display: 'flex', gap: '.4rem', marginTop: '1rem', color: 'var(--ln-text-secondary)', fontSize: '.8rem' }}><CheckCircle2 size={16} />完成今日待办不会勾选明日待办。</p>
        </div>}
        {tab === 'result' && <FlowResultView data={result} onChange={(doc) => setResult((current) => ({ ...current, doc }))}
          onBack={() => switchTab('leaf')} onSave={() => switchTab('closeout')} onResubmit={() => {}} completionContent={card('result')} />}
        {tab === 's1' && <SceneS1DemoPage key={`s1-${sceneVersion}`} completionContent={sceneCard} onExit={exitScene} onSessionStatusChange={setSceneStatus} />}
        {tab === 's4' && <SceneS4DemoPage key={`s4-${sceneVersion}`} completionContent={sceneCard} onExit={exitScene} onSessionStatusChange={setSceneStatus} />}
      </main>
    </div>
  );
};
