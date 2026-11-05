import React, { useState, useMemo, useRef, useEffect, useId } from 'react';
import { NoteItem } from '../types';
import {
  Folder, Sparkles, Plus, FileText, Loader2, Check, X, Pause,
  Search, Network, Files, ShieldCheck, ArrowRight, FolderPlus,
} from 'lucide-react';
import { runStormPipeline, createStormPipelineSession, makeRootProjectNote, STORM_STEPS, StormStep, StormPipelineSession } from '../services/stormService';
import { ProjectTreePanel, buildProjectTreeStructure } from './ProjectTreePanel';

interface StormModeProps {
  allNotes: NoteItem[];
  onUpdateNote: (u: NoteItem, signal?: AbortSignal, expected?: NoteItem | null) => void | Promise<void>;
  onOpenNote?: (id: string) => void;
}

type EntryMode = 'new' | 'existing';

export const StormMode: React.FC<StormModeProps> = ({ allNotes, onUpdateNote, onOpenNote }) => {
  const [entryMode, setEntryMode] = useState<EntryMode>('new');
  const [newTitle, setNewTitle] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [pipelineStage, setPipelineStage] = useState<'idle' | 'running' | 'stopping' | 'stopped' | 'done' | 'error'>('idle');
  const [currentStep, setCurrentStep] = useState<StormStep | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<StormStep>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [generatedNotes, setGeneratedNotes] = useState<NoteItem[]>([]);
  const [researchStatus, setResearchStatus] = useState('');

  const projectTree = useMemo(() => buildProjectTreeStructure(allNotes, {projectOnly: true}), [allNotes]);
  const selectedProject = allNotes.find(note => note.id === selectedProjectId && note.noteType === 'project');
  const sessionRef = useRef<StormPipelineSession | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const updateRef = useRef(onUpdateNote);
  updateRef.current = onUpdateNote;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stageRef = useRef(pipelineStage);
  const fieldId = useId();
  const tabRefs = useRef<Map<EntryMode, HTMLButtonElement>>(new Map());
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; controllerRef.current?.abort(); }; }, []);
  useEffect(() => { setExpandedIds(new Set(projectTree.map(node => node.note.id))); }, []);
  useEffect(() => {
    if (stageRef.current !== pipelineStage) headingRef.current?.focus({preventScroll: true});
    stageRef.current = pipelineStage;
  }, [pipelineStage]);

  // 展开/收起项目节点
  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleStart = async (resume = false) => {
    if (runningRef.current) return;
    let session = resume ? sessionRef.current : null;
    if (session && ((!allNotes.some(note => note.id === session!.parentProject.id && note.noteType === 'project')
      && (!session.createRoot || session.persistedIds.has(session.parentProject.id)))
      || [...session.persistedIds].some(id => !allNotes.some(note => note.id === id)))) {
      setErrorMsg('承载研究的项目或报告笔记已移除，不能继续写入，请返回重新选择');
      return;
    }
    if (!session) {
      const title = entryMode === 'new' ? newTitle.trim() : selectedProject?.title.trim();
      if (!title) { setErrorMsg('请填写研究主题或重新选择有效项目'); return; }
      if (title.length > 500) { setErrorMsg('研究主题请控制在 500 字符以内'); return; }
      const parent = entryMode === 'new' ? makeRootProjectNote(title) : selectedProject!;
      session = createStormPipelineSession(parent, title, entryMode === 'new');
      sessionRef.current = session;
    }
    runningRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setPipelineStage('running');
    setErrorMsg(null);
    setCurrentStep(null);
    setCompletedSteps(new Set(session.completedSteps));
    setGeneratedNotes([]);
    setResearchStatus('正在准备联网研究…');

    try {
      const notes = await runStormPipeline({
        subject: session.subject,
        parentProject: session.parentProject,
        session,
        signal: controller.signal,
        onUpdateNote: async (note, signal, expected) => {
          if (!mountedRef.current || signal?.aborted) throw new DOMException('研究已停止', 'AbortError');
          await updateRef.current(note, signal, expected);
        },
        onProgress: (status) => {
          if (!mountedRef.current || controller.signal.aborted) return;
          setCurrentStep(status.current);
          if (status.detail) setResearchStatus(status.detail);
          if (status.state === 'done') {
            setCompletedSteps(prev => new Set(prev).add(status.current));
          }
        },
      });
      if (!mountedRef.current) return;
      if (controller.signal.aborted) { setPipelineStage('stopped'); return; }
      setGeneratedNotes(notes);
      setPipelineStage('done');
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (controller.signal.aborted) setPipelineStage('stopped');
      else { setErrorMsg(err instanceof Error ? err.message : 'STORM 执行失败'); setPipelineStage('error'); }
    } finally { if (controllerRef.current === controller) { controllerRef.current = null; runningRef.current = false; } }
  };

  const handleStop = () => { controllerRef.current?.abort(); setPipelineStage('stopping'); };
  const handleTabKey = (event: React.KeyboardEvent, mode: EntryMode) => {
    const target = event.key === 'Home' ? 'new' : event.key === 'End' ? 'existing'
      : event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? (mode === 'new' ? 'existing' : 'new') : null;
    if (target) { event.preventDefault(); tabRefs.current.get(target)?.focus(); }
  };

  const canStart = entryMode === 'new' ? newTitle.trim().length > 0 : !!selectedProject;
  const stepIcons = [Search, Network, Files, ShieldCheck];

  // 结果态：只展示已生成笔记
  if (pipelineStage === 'done') {
    return (
      <div className="storm-stage-panel is-done">
        <div className="storm-stage-icon"><Check /></div>
        <div className="storm-stage-heading">
          <span>RESEARCH COMPLETE</span>
          <h3 ref={headingRef} tabIndex={-1}>STORM 报告已生成</h3>
          <p>四个研究阶段已经完成，内容已整理为结构化项目笔记。</p>
        </div>
        <div className="storm-result-list">
          {generatedNotes.map(n => (
            <button type="button" key={n.id} className="storm-result-item" disabled={!onOpenNote || !allNotes.some(note => note.id === n.id)} onClick={() => onOpenNote?.(n.id)}>
              <FileText />
              <span>{n.title}</span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))}
        </div>
        <button
          onClick={() => { sessionRef.current = null; setPipelineStage('idle'); setGeneratedNotes([]); setSelectedProjectId(null); setNewTitle(''); }}
          className="storm-secondary-button"
        >
          发起另一项研究<ArrowRight />
        </button>
      </div>
    );
  }

  // 错误态
  if (pipelineStage === 'error' || pipelineStage === 'stopped') {
    return (
      <div className={`storm-stage-panel ${pipelineStage === 'error' ? 'is-error' : 'is-stopped'}`}>
        <div className="storm-stage-icon">{pipelineStage === 'error' ? <X /> : <Pause />}</div>
        <div className="storm-stage-heading">
          <span>{pipelineStage === 'error' ? 'PIPELINE INTERRUPTED' : 'RESEARCH STOPPED'}</span>
          <h3 ref={headingRef} tabIndex={-1}>{pipelineStage === 'stopped' ? '研究已停止' : 'STORM 执行失败'}</h3>
          {errorMsg && <p role="alert">{errorMsg}</p>}
          <p>已生成内容保留。继续本次研究会使用原报告，从未完成阶段续作，不重复创建项目。</p>
          <p>续作仅保留在当前入口；离开或关闭后不会在后台继续。</p>
        </div>
        <div className="storm-stage-actions">
        <button type="button" onClick={() => void handleStart(true)} className="storm-secondary-button">继续本次研究<ArrowRight /></button>
        <button
          onClick={() => setPipelineStage('idle')}
          className="storm-secondary-button is-subtle"
        >
          返回设置（新研究）<ArrowRight />
        </button>
        </div>
      </div>
    );
  }

  // 运行态
  if (pipelineStage === 'running' || pipelineStage === 'stopping') {
    return (
      <div className="storm-stage-panel is-running">
        <div className="storm-stage-icon"><Loader2 className="animate-spin" /></div>
        <div className="storm-stage-heading">
          <span>STORM PIPELINE</span>
          <h3 ref={headingRef} tabIndex={-1}>{pipelineStage === 'stopping' ? '正在停止研究' : '正在组织研究报告'}</h3>
          <p role="status">{pipelineStage === 'stopping' ? '正在取消当前请求，已生成内容保留。' : `已完成 ${completedSteps.size} / 4 阶段 · 可停止，已生成内容保留。`}</p>
          {pipelineStage === 'running' && <p role="status">{researchStatus}</p>}
        </div>
        <div className="storm-progress-list">
          {STORM_STEPS.map((step, index) => {
            const isDone = completedSteps.has(step.key);
            const isCurrent = currentStep === step.key && !isDone;
            const StepIcon = stepIcons[index];
            return (
              <div key={step.key} className={`storm-progress-item ${isDone ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
                <span className="storm-progress-index">{isDone ? <Check /> : isCurrent ? <Loader2 className="animate-spin" /> : <StepIcon />}</span>
                <div><small>0{index + 1}</small><strong>{step.title}</strong><span>{isDone ? '已完成' : isCurrent ? '进行中' : '待开始'}</span></div>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={handleStop} disabled={pipelineStage === 'stopping'} className="storm-secondary-button">{pipelineStage === 'stopping' ? '正在停止…' : '停止研究'}</button>
      </div>
    );
  }

  // 空闲态：入口选择
  return (
    <div className="storm-studio-entry">
      <aside className="storm-entry-guide">
        <div className="storm-entry-brand">
          <span><Sparkles /> RESEARCH STUDIO</span>
          <h2>STORM<br />研究工作流</h2>
          <p>从不同视角进入问题，把分歧、证据与结论沉淀为可继续学习的项目笔记。</p>
        </div>
        <div className="storm-method-list">
          {STORM_STEPS.map((step, index) => {
            const StepIcon = stepIcons[index];
            return (
              <div className="storm-method-item" key={step.key}>
                <span><StepIcon /></span>
                <div><small>0{index + 1}</small><strong>{step.title}</strong></div>
              </div>
            );
          })}
        </div>
        <p className="storm-entry-footnote">先联网取证，再完成四阶段分析。每阶段保留来源链接与检索时间。</p>
      </aside>

      <section className="storm-entry-form">
        <div className="storm-entry-config" role="region" aria-label="STORM 研究设置" tabIndex={0}>
        <header className="storm-entry-form-head">
          <span>START A RESEARCH</span>
          <h3 ref={headingRef} tabIndex={-1}>选择这次研究的起点</h3>
          <p>新建一个独立主题，或让研究结果继续生长在已有项目下。开始后会将研究主题发送至搜索服务或搜索引擎，可能产生搜索和模型费用。</p>
        </header>

        <div className="storm-entry-tabs" role="tablist" aria-label="STORM 研究起点">
          <button type="button" role="tab" id={`${fieldId}-new`} aria-controls={`${fieldId}-pane`} tabIndex={entryMode === 'new' ? 0 : -1} ref={el => { if (el) tabRefs.current.set('new', el); }} onKeyDown={event => handleTabKey(event, 'new')} aria-selected={entryMode === 'new'} className={entryMode === 'new' ? 'is-active' : ''} onClick={() => { setEntryMode('new'); setErrorMsg(null); }}>
            <FolderPlus />
            <span><strong>新建研究项目</strong><small>从一个主题开始</small></span>
          </button>
          <button type="button" role="tab" id={`${fieldId}-existing`} aria-controls={`${fieldId}-pane`} tabIndex={entryMode === 'existing' ? 0 : -1} ref={el => { if (el) tabRefs.current.set('existing', el); }} onKeyDown={event => handleTabKey(event, 'existing')} aria-selected={entryMode === 'existing'} className={entryMode === 'existing' ? 'is-active' : ''} onClick={() => { setEntryMode('existing'); setErrorMsg(null); }}>
            <Folder />
            <span><strong>连接已有项目</strong><small>延展现有知识结构</small></span>
          </button>
        </div>

        <div className="storm-entry-pane" id={`${fieldId}-pane`} role="tabpanel" aria-labelledby={`${fieldId}-${entryMode}`}>
          {entryMode === 'new' ? (
            <label className="storm-topic-field" htmlFor={`${fieldId}-topic`}>
              <span>研究主题</span>
              <div><Search /><input id={`${fieldId}-topic`} type="text" maxLength={500} aria-label="研究主题" placeholder="例如：人工智能对教育的影响" value={newTitle} onChange={e => { setNewTitle(e.target.value); setErrorMsg(null); }} /></div>
              <small>系统会以此创建根项目，并在其下建立完整 STORM 报告结构。</small>
            </label>
          ) : (
            <div className="storm-project-picker">
              <div className="storm-project-picker-head"><span>选择承载研究结果的项目</span><small>{projectTree.length} 个根项目</small></div>
              {projectTree.length === 0 ? (
                <div className="storm-project-empty">暂无项目笔记</div>
              ) : (
                <ProjectTreePanel nodes={projectTree} expandedIds={expandedIds} selectedTreeId={selectedProject?.id || null} onToggleExpand={toggleExpand} onSelect={id => { setSelectedProjectId(id); setErrorMsg(null); }} />
              )}
            </div>
          )}
        </div>
        {(errorMsg || (selectedProjectId && entryMode === 'existing' && !selectedProject)) && <p className="storm-entry-error" role="alert">{errorMsg || '所选项目已移除，请重新选择'}</p>}
        </div>

        <div className="storm-entry-action">
          <div>
            <span>{entryMode === 'new' ? '将创建新的研究项目' : '将写入所选项目'}</span>
            <strong>{entryMode === 'new' ? (newTitle.trim() || '等待填写主题') : (selectedProject?.title || '等待选择项目')}</strong>
          </div>
          <button type="button" onClick={() => void handleStart()} disabled={!canStart}>
            <Plus />开始 STORM<ArrowRight />
          </button>
        </div>
      </section>
    </div>
  );
};
