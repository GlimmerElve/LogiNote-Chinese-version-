/**
 * 场景搭建面板（LearnHub 第 4 tab「场景模拟」的内容区）。
 *
 * 形态：固定高度向导（单窗口分步切换）——
 *   ① 选项目 → ② 选来源 → ③ 补充条件 → ④ 确认进入
 * 其中 ③ 仅 build / auto 需要，existing / custom 自动跳过。
 *
 * 为何用向导而非单页长表单：外壳 .learn-hub-container 是 justify-content:center，
 * 内容一旦超高会同时向上下两端溢出，底部被 overflow:hidden 裁掉、顶部把标题与
 * tab 切换条挤出视口。固定高度 + 内容区内部滚动可从根上避免该问题。
 *
 * 本组件不发起任何 LLM 调用，只收集 SceneInitialRequest 交给 SceneMode。
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, Sparkles, Wand2, PenLine, Trash2, RefreshCw,
  ArrowRight, ArrowLeft, ChevronRight, Check, FolderTree, SlidersHorizontal,
  ClipboardCheck,
} from 'lucide-react';
import { NoteItem, SceneCapabilityId, SceneManifestEntry, SceneInitialRequest, SceneRecipeId, SceneSkillType } from '../../types';
import {
  SCENE_SKILL_S1,
  SCENE_SKILL_S4,
} from '../../types/sceneS4';
import { listScenes, deleteScene } from '../../services/scene/sceneSkillStore';
import { listSceneInteractionPacks, importSceneInteractionPack } from '../../services/scene/sceneInteractionPackLoader';
import { H5pLibraryPanel } from './H5pLibraryPanel';
import type { SceneInteractionPackManifest, SceneInteractionPackRef } from '../../types/sceneInteractionPack';
import { collectKnowledgePoints } from '../../services/scene/sceneKnowledgePoints';
import { ProjectTreePanel, buildProjectTreeStructure } from '../ProjectTreePanel';
import { useDialog } from '../useDialog';
import {
  listSceneCapabilities,
  UNIFIED_SCENE_RECIPE_DEFINITIONS,
} from '../../services/scene/sceneCapabilityRegistry';

interface SceneBuilderPanelProps {
  allNotes: NoteItem[];
  /** 交给上层（App）切换到 SceneMode 全屏视图 */
  onEnterScene: (request: SceneInitialRequest) => void;
}

type SceneSource = SceneInitialRequest['source'];

/**
 * 场景类型选项（S4 新增 —— 隔离点 I10）。
 *
 * 默认 S1（对话场景），与改动前行为完全一致；选 S4 后走数理推导画布流程。
 */
const SCENE_KIND_OPTIONS: Array<{
  key: SceneSkillType;
  label: string;
  desc: string;
}> = [
  { key: SCENE_SKILL_S1, label: '对话场景', desc: '流式回合互动：对话、答题、诊断或引导，由 AI 按目标设计' },
  { key: 'S2', label: '通用画布（试验）', desc: '独立画布搭建与 Agent 局部操作；不接入 S4 数理引擎' },
  { key: SCENE_SKILL_S4, label: '数理场景', desc: '画布式公式推导，由计算引擎验证' },
];

/** 场景来源选项（顺序即界面顺序） */
const SOURCE_OPTIONS: Array<{ key: SceneSource; label: string; desc: string; Icon: typeof Sparkles }> = [
  { key: 'existing', label: '复用已有场景', desc: '直接从场景库里挑一个进入', Icon: Layers },
  { key: 'build', label: '搭建新场景', desc: '先判断能否复用骨架，再产出场景', Icon: Sparkles },
  { key: 'auto', label: '交给 AI 判断', desc: '跳过复用判断，直接生成全新场景', Icon: Wand2 },
  { key: 'custom', label: '自定义场景', desc: '载入空白骨架，七要素自己填', Icon: PenLine },
];

/** 步骤定义（③ 对 existing / custom 跳过） */
const WIZARD_STEPS = [
  { n: 1, label: '选择项目', desc: '确定训练对象', Icon: FolderTree },
  { n: 2, label: '场景来源', desc: '选择构建方式', Icon: Layers },
  { n: 3, label: '补充条件', desc: '配置角色与组件', Icon: SlidersHorizontal },
  { n: 4, label: '确认进入', desc: '核对场景信息', Icon: ClipboardCheck },
] as const;

/** 该来源是否需要「补充条件」步骤 */
function needsStep3(source: SceneSource): boolean {
  return source === 'build' || source === 'auto';
}

const SOURCE_LABELS: Record<SceneSource, string> = {
  existing: '复用已有场景',
  build: '搭建新场景',
  auto: '交给 AI 判断',
  custom: '自定义场景',
};

export const SceneBuilderPanel: React.FC<SceneBuilderPanelProps> = ({ allNotes, onEnterScene }) => {
  const [step, setStep] = useState(1);
  const [h5pMode, setH5pMode] = useState(false);

  const [projectId, setProjectId] = useState<string>('');
  const [customTitle, setCustomTitle] = useState('');
  const [source, setSource] = useState<SceneSource>('build');
  /** 场景类型（S4 新增，默认 S1 —— 隔离点 I10，默认值 = 改动前行为） */
  const [sceneSkill, setSceneSkill] = useState<SceneSkillType>(SCENE_SKILL_S1);
  const [roleHints, setRoleHints] = useState('');
  const [extraHints, setExtraHints] = useState('');
  const [agentCompose, setAgentCompose] = useState(true);
  const [recipeId, setRecipeId] = useState<SceneRecipeId>('guided-practice');
  const [requestedCapabilities, setRequestedCapabilities] = useState<SceneCapabilityId[]>([]);
  const [interactionPacks, setInteractionPacks] = useState<SceneInteractionPackManifest[]>([]);
  const [interactionPack, setInteractionPack] = useState<SceneInteractionPackRef | null>(null);
  const [packStatus, setPackStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [packErrors, setPackErrors] = useState<string[]>([]);
  const [installingPack, setInstallingPack] = useState(false);
  const [installNotice, setInstallNotice] = useState('');
  const packInstallLock = useRef(false);
  const packReadVersion = useRef(0);
  const packChoiceInitialized = useRef(false);

  const [scenes, setScenes] = useState<SceneManifestEntry[]>([]);
  const [pickedSceneId, setPickedSceneId] = useState<string>('');
  const [loadingScenes, setLoadingScenes] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SceneManifestEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [entryError, setEntryError] = useState('');
  const mounted = useRef(true);
  const readVersion = useRef(0);
  const mutationLock = useRef(false);
  const entered = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useRef(false);
  const fieldId = useId();
  const closeDelete = useCallback(() => {
    if (mutationLock.current) return;
    setDeleteTarget(null); setDeleteError('');
  }, []);
  useDialog(Boolean(deleteTarget), dialogRef, deleting ? undefined : closeDelete, 80);
  useLayoutEffect(() => {
    if (!deleteTarget && focusAfterDelete.current) {
      focusAfterDelete.current = false;
      refreshButtonRef.current?.focus({ preventScroll: true });
    }
  }, [deleteTarget]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readVersion.current++; packReadVersion.current++; };
  }, []);
  const priorStep = useRef(step);
  useEffect(() => {
    if (priorStep.current !== step) {
      bodyRef.current?.scrollTo({ top: 0 });
      bodyRef.current?.focus({ preventScroll: true });
      priorStep.current = step;
      setEntryError('');
    }
  }, [step]);

  /** 项目结构树的展开态（与心流模式一致：默认只展开第一层） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  /** 项目结构树：只显示项目节点，知识点不进树（仍会被推导带入 knowledgePoints） */
  const projectTree = useMemo(() => buildProjectTreeStructure(allNotes, { projectOnly: true }), [allNotes]);

  useEffect(() => { setExpandedIds(new Set(projectTree.map(n => n.note.id))); }, []);
  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, []);

  const selectedProject = useMemo(() => allNotes.find((n) => n.id === projectId && n.noteType === 'project') || null, [allNotes, projectId]);

  /** 知识点：随所选项目自动推导 */
  const derivedKps = useMemo(
    () => (projectId ? collectKnowledgePoints(projectId, allNotes) : []),
    [projectId, allNotes],
  );

  const refreshScenes = useCallback(async () => {
    const version = ++readVersion.current;
    setLoadingScenes(true);
    setLibraryError('');
    try {
      const next = await listScenes({ strict: true });
      if (!mounted.current || version !== readVersion.current) return;
      setScenes(next);
      setPickedSceneId(current => next.some(scene => scene.sceneId === current) ? current : '');
    } catch (error) {
      if (mounted.current && version === readVersion.current) {
        setLibraryError(error instanceof Error ? error.message : '场景库读取失败，请重试。');
      }
    } finally {
      if (mounted.current && version === readVersion.current) setLoadingScenes(false);
    }
  }, []);

  const refreshInteractionPacks = useCallback(async (refresh = false) => {
    const version = ++packReadVersion.current;
    setPackStatus('loading');
    setPackErrors([]);
    try {
      // Discovery reads manifests only. Selected code is activated by the S2 boundary.
      const result = await listSceneInteractionPacks(refresh ? { refresh: true } : undefined);
      if (!mounted.current || version !== packReadVersion.current) return;
      const packs = result.packs.filter(pack => pack.paradigm === 'S2');
      setInteractionPacks(packs);
      const firstChoice = !packChoiceInitialized.current;
      packChoiceInitialized.current = true;
      setInteractionPack(current => {
        if (firstChoice) {
          const familiar = packs.find(pack => pack.id === 'prompt-lab' && pack.version === '0.1.0');
          return familiar ? { id: familiar.id, version: familiar.version } : null;
        }
        return current && packs.some(pack => pack.id === current.id && pack.version === current.version)
          ? current : null;
      });
      setPackErrors(result.errors);
      setPackStatus('ready');
      return packs;
    } catch (error) {
      if (!mounted.current || version !== packReadVersion.current) return;
      setInteractionPacks([]);
      setInteractionPack(null);
      packChoiceInitialized.current = true;
      setPackErrors([error instanceof Error ? error.message : '交互包清单读取失败。']);
      setPackStatus('error');
    }
  }, []);

  const installInteractionPack = async () => {
    if (packInstallLock.current) return;
    packInstallLock.current = true; setInstallingPack(true); setInstallNotice('');
    try {
      const result = await importSceneInteractionPack();
      if (!mounted.current) return;
      if (result.canceled) { setInstallNotice('已取消，现有场景未改动。'); return; }
      const packs = await refreshInteractionPacks(true);
      if (!mounted.current) return;
      if (result.manifest && packs?.some(pack => pack.id === result.manifest!.id && pack.version === result.manifest!.version)) {
        packChoiceInitialized.current = true;
        setInteractionPack({ id: result.manifest.id, version: result.manifest.version });
        setInstallNotice(`${result.manifest.name} ${result.manifest.version} ${result.alreadyInstalled ? '已安装' : '已导入'}，可直接用于新场景。已有场景继续使用原版本。`);
      } else setInstallNotice('交互包已安装，但列表刷新未完成，请刷新后选择。无需重复导入，已有场景不变。');
    } catch (error) { if (mounted.current) setInstallNotice(error instanceof Error ? error.message : '交互包导入失败，原版已保留。'); }
    finally { packInstallLock.current = false; if (mounted.current) setInstallingPack(false); }
  };

  useEffect(() => {
    if (sceneSkill === 'S2') void refreshInteractionPacks();
    return () => { packReadVersion.current++; };
  }, [sceneSkill, refreshInteractionPacks]);

  const confirmDelete = async () => {
    if (!deleteTarget || mutationLock.current) return;
    mutationLock.current = true;
    ++readVersion.current;
    setLoadingScenes(false); setDeleting(true); setDeleteError('');
    try {
      await deleteScene(deleteTarget.sceneId, { strict: true });
      if (!mounted.current) return;
      setScenes(current => current.filter(scene => scene.sceneId !== deleteTarget.sceneId));
      setPickedSceneId(current => current === deleteTarget.sceneId ? '' : current);
      focusAfterDelete.current = true;
      setDeleteTarget(null);
    } catch (error) {
      if (mounted.current) setDeleteError(error instanceof Error ? error.message : '删除失败，请重试。');
    } finally {
      mutationLock.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  /** 仅在进入「选来源」且来源为复用时拉取场景库，避免无谓 IO */
  useEffect(() => {
    if (step === 2 && source === 'existing') void refreshScenes();
  }, [step, source, refreshScenes]);

  /** 场景名：自定义标题优先，其次项目标题 */
  const sceneName = customTitle.trim() || selectedProject?.title || '';
  const s1Recipes = useMemo(
    () => UNIFIED_SCENE_RECIPE_DEFINITIONS.filter((item) => item.sceneSkill === 'S1'),
    [],
  );
  const s1Capabilities = useMemo(
    () => listSceneCapabilities({ surface: 'turn', sceneSkill: 'S1' })
      .filter((item) => item.supportsTopLevel && item.userCreatable),
    [],
  );

  useEffect(() => {
    if (sceneSkill === SCENE_SKILL_S4) {
      setAgentCompose(true);
      setRecipeId('guided-derivation');
      setRequestedCapabilities([]);
    } else if (recipeId === 'guided-derivation') {
      setRecipeId('guided-practice');
    }
  }, [recipeId, sceneSkill]);

  /** 最终能否进入场景（沿用原判定口径） */
  const pickedScene = scenes.find(scene => scene.sceneId === pickedSceneId && scene.sceneSkill === sceneSkill);
  const libraryBusy = loadingScenes || deleting || Boolean(deleteTarget);
  const needsPackChoice = sceneSkill === 'S2' && source !== 'existing';
  const packsBusy = installingPack || needsPackChoice && (packStatus === 'idle' || packStatus === 'loading');
  const selectedPack = interactionPack && interactionPacks.find(pack => pack.id === interactionPack.id && pack.version === interactionPack.version);
  const packLabel = selectedPack ? `${selectedPack.name}（${selectedPack.id}@${selectedPack.version}）` : '基础画布（不使用交互包）';
  const canEnter = !libraryBusy && !packsBusy && (source === 'existing'
    ? Boolean(pickedScene) && !libraryError
    : Boolean(sceneName) && (!projectId || Boolean(selectedProject)));

  /**
   * 各步骤的「下一步」可用性。
   *
   * ① 不做拦截：此时尚未选来源，无法判断该路径是否真需要场景名
   *    （「复用已有场景」就完全不需要）。若在此卡住，该路径用户会走不下去。
   * ② 才做真正的校验：复用路径要求选中场景，其余路径要求有场景名。
   * ③ 补充条件为可选；④ 由 canEnter 兜底。
   */
  const canNext = (() => {
    if (step === 1) return true;
    if (step === 2) return canEnter;
    return true;
  })();

  /** ② 选了需要场景名的来源却没名字时，就地在底栏提示（不让用户走到最后才被拦） */
  const needsNameHint = step === 2 && source !== 'existing' && !sceneName;

  const goNext = () => {
    if (!canNext) return;
    if (step === 1) return setStep(2);
    if (step === 2) return setStep(needsStep3(source) ? 3 : 4);
    if (step === 3) return setStep(4);
  };
  const goPrev = () => {
    if (step === 4) return setStep(needsStep3(source) ? 3 : 2);
    if (step > 1) setStep(step - 1);
  };

  const handleEnter = () => {
    if (!canEnter || entered.current || mutationLock.current) return;
    if (projectId && !selectedProject) {
      setEntryError('关联项目已移除，请返回第一步重新选择。'); return;
    }
    entered.current = true;
    try {
    onEnterScene({
      source,
      subject: sceneName,
      knowledgePoints: derivedKps,
      customTitle: customTitle.trim() || undefined,
      // 标题可以改名，任务关联仍以用户实际选中的项目 ID 为准。
      taskBinding: selectedProject?.noteType === 'project'
        ? { noteId: selectedProject.id }
        : undefined,
      sceneId: source === 'existing' ? pickedSceneId : undefined,
      roleHints: roleHints.trim() || undefined,
      extraHints: extraHints.trim() || undefined,
      recipeId: sceneSkill === 'S2' || agentCompose ? undefined : recipeId,
      requestedCapabilities: sceneSkill === SCENE_SKILL_S1 && !agentCompose && requestedCapabilities.length > 0
        ? requestedCapabilities
        : undefined,
      // S4 新增：把所选场景类型带进生成/运行流程（隔离点 I10）
      sceneSkill,
      ...(needsPackChoice ? { interactionPack } : {}),
    });
    } catch (error) {
      entered.current = false;
      setEntryError(error instanceof Error ? error.message : '无法进入场景，请重试。');
    }
  };

  /** 步骤条：已走过或当前步骤可点击回跳 */
  const renderSteps = () => (
    <div className="scene-wizard-steps">
      <div className="scene-wizard-steps-head">
        <span>SCENE COMPOSER</span>
        <h3>搭建训练场景</h3>
        <p>把项目、互动形式与训练目标组合成一次可执行的模拟。</p>
      </div>
      <div className="scene-wizard-step-list">
        {WIZARD_STEPS.map((s) => {
          const skipped = s.n === 3 && !needsStep3(source);
          const done = s.n < step && !skipped;
          const active = s.n === step;
          const clickable = s.n < step && !skipped && !libraryBusy;
          const StepIcon = s.Icon;
          return (
            <button key={s.n} type="button" aria-current={active ? 'step' : undefined} className={`scene-wizard-step ${active ? 'is-active' : ''} ${done ? 'is-done' : ''} ${skipped ? 'is-skipped' : ''}`} disabled={!clickable} onClick={() => clickable && setStep(s.n)} title={skipped ? '该步骤在当前来源下已跳过' : undefined}>
              <span className="scene-wizard-step-dot">{done ? <Check /> : <StepIcon />}</span>
              <span className="scene-wizard-step-copy"><strong>{s.label}</strong><small>{skipped ? '当前来源无需设置' : s.desc}</small></span>
              <span className="scene-wizard-step-number">0{s.n}</span>
            </button>
          );
        })}
      </div>
      <div className="scene-wizard-steps-foot"><Sparkles /><span>场景不会直接发布<br />确认后才进入训练</span></div>
    </div>
  );

  /** ① 选项目 */
  const renderStep1 = () => (
    <section className="scene-builder-section">
      <div className="scene-builder-head">
        <span className="scene-builder-title">选择项目</span>
        {!projectTree.length && <span className="scene-builder-note">还没有项目笔记，可在下方直接填写场景名</span>}
      </div>

      {projectTree.length > 0 && (
        <div className="scene-builder-tree">
          <ProjectTreePanel
            nodes={projectTree}
            expandedIds={expandedIds}
            selectedTreeId={projectId || null}
            onToggleExpand={toggleExpand}
            onSelect={(id) => setProjectId(projectId === id ? '' : id)}
          />
        </div>
      )}

      <div className="scene-field-row">
        <label className="scene-field-label" htmlFor={`${fieldId}-title`}>
          场景名 <span className="text-[10px] font-normal text-slate-400">（留空则用项目标题）</span>
        </label>
        <input
          id={`${fieldId}-title`}
          className="scene-input"
          value={customTitle}
          placeholder={selectedProject?.title || '给这个场景起个名字'}
          onChange={(e) => setCustomTitle(e.target.value)}
        />
      </div>

      {derivedKps.length > 0 && (
        <p className="scene-builder-note">
          已从所选项目推导出 {derivedKps.length} 个知识点，将随生成请求一并交给 AI
        </p>
      )}
    </section>
  );

  /** ② 选来源（含场景库） */
  const renderStep2 = () => (
    <>
      {/* 场景类型（S4 新增 —— 隔离点 I10）：并入本步，不增加向导步骤数 */}
      <section className="scene-builder-section">
        <div className="scene-builder-head">
          <span className="scene-builder-title">场景类型</span>
          <span className="scene-builder-note">决定运行时用对话还是画布</span>
        </div>
        <div className="scene-builder-sources">
          {SCENE_KIND_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`scene-builder-source ${sceneSkill === opt.key ? 'is-active' : ''}`}
              aria-pressed={sceneSkill === opt.key}
              disabled={deleting}
              onClick={() => {
                if (sceneSkill !== opt.key) {
                  setPickedSceneId('');
                  if (opt.key === 'S2') setPackStatus('idle');
                }
                setSceneSkill(opt.key);
              }}
            >
              <span className="scene-builder-source-label">{opt.label}</span>
              <span className="scene-builder-source-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {sceneSkill === 'S2' && (
        <section className="scene-builder-section">
          <div className="scene-builder-head">
            <label className="scene-builder-title" htmlFor={`${fieldId}-interaction-pack`}>S2 交互包</label>
            <button type="button" className="scene-btn scene-btn--ghost" disabled={packsBusy || installingPack || deleting}
              onClick={() => void installInteractionPack()} aria-label="导入或更新 S2 交互包">{installingPack ? '正在导入…' : '导入 / 更新'}</button>
            <button type="button" className="scene-icon-btn" disabled={packsBusy || deleting}
              onClick={() => void refreshInteractionPacks(true)} title="刷新交互包" aria-label="刷新交互包">
              <RefreshCw className={`w-3.5 h-3.5 ${packsBusy ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {needsPackChoice && <select id={`${fieldId}-interaction-pack`} className="scene-input" disabled={packsBusy || deleting}
            value={interactionPack ? `${interactionPack.id}@${interactionPack.version}` : ''}
            onChange={event => {
              packChoiceInitialized.current = true;
              const selected = interactionPacks.find(pack => `${pack.id}@${pack.version}` === event.target.value);
              setInteractionPack(selected ? { id: selected.id, version: selected.version } : null);
            }}>
            <option value="">基础画布（不使用交互包）</option>
            {interactionPacks.map(pack => <option key={`${pack.id}@${pack.version}`} value={`${pack.id}@${pack.version}`}>
              {pack.name}（{pack.id}@{pack.version}）
            </option>)}
          </select>}
          {installNotice && <p role="status" className="scene-builder-note">{installNotice}</p>}
          {packsBusy && <p role="status" className="scene-builder-note">正在读取已安装交互包…</p>}
          {!packsBusy && <p className="scene-builder-note">支持 ZIP 导入，即装即用。更新与旧版并存，已有场景和进度不自动迁移。</p>}
          {packErrors.length > 0 && <div role="alert" className="scene-builder-error">
            {packErrors.map((message, index) => <p key={index}>{message}</p>)}
            <p>可以选择可用交互包或基础画布，也可刷新清单后重试。</p>
          </div>}
        </section>
      )}

      <section className="scene-builder-section">
        <div className="scene-builder-head">
          <span className="scene-builder-title">场景来源</span>
        </div>
        <div className="scene-builder-sources">
          {SOURCE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={`scene-builder-source ${source === opt.key ? 'is-active' : ''}`}
              aria-pressed={source === opt.key}
              disabled={deleting}
              onClick={() => setSource(opt.key)}
            >
              <opt.Icon className="w-4 h-4" />
              <span className="scene-builder-source-label">{opt.label}</span>
              <span className="scene-builder-source-desc">{opt.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 复用已有：场景库列表 */}
      {source === 'existing' && (
        <section className="scene-builder-section">
          <div className="scene-list-head">
            <span className="text-[11px] text-slate-500">场景库（按复用次数排序）</span>
            <button ref={refreshButtonRef} type="button" className="scene-icon-btn" disabled={libraryBusy}
              onClick={() => void refreshScenes()} title="刷新场景库" aria-label="刷新场景库">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingScenes ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {loadingScenes && <p role="status" className="scene-builder-note">正在读取场景库…</p>}
          {libraryError && <div role="alert" className="scene-builder-error"><p>{libraryError}</p>
            <button type="button" className="scene-btn scene-btn--ghost" disabled={libraryBusy} onClick={() => void refreshScenes()}>重试读取场景库</button></div>}
          {!loadingScenes && !libraryError && !scenes.some((s) => s.sceneSkill === sceneSkill) && (
            <p className="text-xs text-slate-400 py-2">
              {sceneSkill === SCENE_SKILL_S4
                ? '还没有数理场景，先选「搭建新场景」并保持类型为「数理场景」生成第一个吧'
                : '场景库还是空的，先选「搭建新场景」生成第一个吧'}
            </p>
          )}
          {scenes.filter((s) => s.sceneSkill === sceneSkill).map((s) => (
            <div key={s.sceneId}
              className={`scene-list-item ${pickedSceneId === s.sceneId ? 'is-picked' : ''}`}>
              <button type="button" className="scene-list-main" aria-pressed={pickedSceneId === s.sceneId}
                disabled={libraryBusy || Boolean(libraryError)} onClick={() => setPickedSceneId(s.sceneId)}>
                <div className="scene-list-title">
                  {s.name}
                  {s.reuseCount > 0 && <span className="scene-tab-badge">复用 {s.reuseCount}</span>}
                </div>
                <div className="scene-list-meta">
                  {s.subject}{s.knowledgePoints?.length > 0 ? `｜${s.knowledgePoints.join('、')}` : ''}
                </div>
                <div className="scene-list-arch">
                  {s.sceneSkill === SCENE_SKILL_S4 && (
                    <span className="scene-arch-tag scene-arch-tag--s4">数理场景</span>
                  )}
                  <span className="scene-arch-tag">{s.architecture?.paradigmLabel}</span>
                  {s.architecture?.hasEvents && <span className="scene-arch-tag scene-arch-tag--soft">突发事件</span>}
                  {s.architecture?.injectProfile && <span className="scene-arch-tag scene-arch-tag--soft">画像注入</span>}
                </div>
              </button>
              <button type="button" className="scene-icon-btn scene-list-del" title="删除该场景"
                aria-label={`删除场景 ${s.name}`} disabled={libraryBusy || Boolean(libraryError)}
                onClick={() => { setDeleteError(''); setDeleteTarget(s); }}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );

  /** ③ 补充条件（仅 build / auto） */
  const renderStep3 = () => (
    <section className="scene-builder-section">
      <div className="scene-builder-head">
        <span className="scene-builder-title">补充条件</span>
        <span className="scene-builder-note">可选，越具体越贴合你的需要</span>
      </div>
      <div className="scene-field-row">
        <label className="scene-field-label" htmlFor={`${fieldId}-roles`}>期望角色</label>
        <input id={`${fieldId}-roles`} className="scene-input" value={roleHints}
          placeholder="如：希望对方是个严厉的导师，说话直接不留情面"
          onChange={(e) => setRoleHints(e.target.value)} />
      </div>
      <div className="scene-field-row">
        <label className="scene-field-label" htmlFor={`${fieldId}-hints`}>其它要求</label>
        <input id={`${fieldId}-hints`} className="scene-input" value={extraHints}
          placeholder="如：把重点放在成本与收益的权衡上"
          onChange={(e) => setExtraHints(e.target.value)} />
      </div>
      {sceneSkill === SCENE_SKILL_S4 && (
        <span className="scene-builder-note">场景搭建 Agent 会在数理画布边界内选择推导组件、验证器和提示模块。</span>
      )}
      {sceneSkill === 'S2' && <span className="scene-builder-note">S2 是你主导的实验画布：填写材料、连接步骤、运行并反复调整，助手按需解释或分析。可按目标组合本地文本、表单、图片与结构化处理插件；使用已配置模型前须单独授权用量并确认实际请求。模板不保存本局资料权限或实验记录；S1、S4 保持独立。</span>}
      {sceneSkill === SCENE_SKILL_S1 && (
        <>
          <div className="scene-field-row">
            <label className="scene-field-label">装配方式</label>
            <div className="scene-builder-recipe-grid">
              <button
                type="button"
                className={`scene-builder-recipe ${agentCompose ? 'is-active' : ''}`}
                aria-pressed={agentCompose}
                onClick={() => setAgentCompose(true)}
              >
                <strong>Agent 自主装配</strong>
                <span>理解目标后决定训练方式、组件、上下文与提示模块</span>
              </button>
              <button
                type="button"
                className={`scene-builder-recipe ${!agentCompose ? 'is-active' : ''}`}
                aria-pressed={!agentCompose}
                onClick={() => setAgentCompose(false)}
              >
                <strong>手动约束</strong>
                <span>由你指定训练配方和希望出现的交互组件</span>
              </button>
            </div>
            {agentCompose && (
              <span className="scene-builder-note">场景搭建 Agent 会输出运行契约；逐轮场景还会自动装配互动 Agent。</span>
            )}
          </div>
          {!agentCompose && <div className="scene-field-row">
            <label className="scene-field-label">训练方式</label>
            <div className="scene-builder-recipe-grid">
              {s1Recipes.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  className={`scene-builder-recipe ${recipeId === recipe.id ? 'is-active' : ''}`}
                  aria-pressed={recipeId === recipe.id}
                  onClick={() => setRecipeId(recipe.id)}
                >
                  <strong>{recipe.label}</strong>
                  <span>{recipe.purpose}</span>
                </button>
              ))}
            </div>
          </div>}
          {!agentCompose && <div className="scene-field-row">
            <label className="scene-field-label">可选交互组件</label>
            <div className="scene-builder-capability-list">
              {s1Capabilities.map((capability) => {
                const selected = requestedCapabilities.includes(capability.id);
                return (
                  <button
                    key={capability.id}
                    type="button"
                    className={`scene-builder-capability ${selected ? 'is-active' : ''}`}
                    aria-pressed={selected}
                    title={capability.purpose}
                    onClick={() => setRequestedCapabilities((current) => (
                      selected
                        ? current.filter((id) => id !== capability.id)
                        : [...current, capability.id]
                    ))}
                  >
                    {capability.label}
                  </button>
                );
              })}
            </div>
            <span className="scene-builder-note">配方会自动装配必需能力；这里只补充你明确希望使用的组件。</span>
          </div>}
        </>
      )}
    </section>
  );

  /** ④ 确认汇总 */
  const renderStep4 = () => {
    return (
      <section className="scene-builder-section">
        <div className="scene-builder-head">
          <span className="scene-builder-title">确认并进入</span>
        </div>

        <div className="scene-wizard-summary">
          <div className="scene-wizard-summary-row">
            <span className="scene-kv-label">场景名</span>
            <span>{source === 'existing' ? pickedScene?.name || '—' : sceneName || '—'}</span>
          </div>
          <div className="scene-wizard-summary-row">
            <span className="scene-kv-label">场景类型</span>
            <span>{SCENE_KIND_OPTIONS.find(kind => kind.key === sceneSkill)?.label}</span>
          </div>
          <div className="scene-wizard-summary-row">
            <span className="scene-kv-label">来源</span>
            <span>{SOURCE_LABELS[source]}</span>
          </div>
          {needsPackChoice && <div className="scene-wizard-summary-row">
            <span className="scene-kv-label">S2 交互包</span>
            <span>{packLabel}</span>
          </div>}
          {source === 'existing' ? (
            <div className="scene-wizard-summary-row">
              <span className="scene-kv-label">复用场景</span>
              <span>{pickedScene?.name || '—'}</span>
            </div>
          ) : (
            <div className="scene-wizard-summary-row">
              <span className="scene-kv-label">关联知识点</span>
              <span>{derivedKps.length > 0 ? `${derivedKps.length} 个` : '（未指定，由 AI 推断）'}</span>
            </div>
          )}
          {needsStep3(source) && (
            <>
              <div className="scene-wizard-summary-row">
                <span className="scene-kv-label">期望角色</span>
                <span>{roleHints.trim() || '（未填写）'}</span>
              </div>
              <div className="scene-wizard-summary-row">
                <span className="scene-kv-label">其它要求</span>
                <span>{extraHints.trim() || '（未填写）'}</span>
              </div>
              {sceneSkill === SCENE_SKILL_S1 && (
                <>
                  <div className="scene-wizard-summary-row">
                    <span className="scene-kv-label">装配方式</span>
                    <span>{agentCompose ? 'Agent 自主装配' : '手动约束'}</span>
                  </div>
                  {!agentCompose && <>
                    <div className="scene-wizard-summary-row">
                      <span className="scene-kv-label">训练方式</span>
                      <span>{s1Recipes.find((item) => item.id === recipeId)?.label || recipeId}</span>
                    </div>
                    <div className="scene-wizard-summary-row">
                      <span className="scene-kv-label">交互组件</span>
                      <span>{requestedCapabilities.length > 0
                        ? requestedCapabilities.map((id) => s1Capabilities.find((item) => item.id === id)?.label || id).join('、')
                        : '由训练方式自动装配'}</span>
                    </div>
                  </>}
                </>
              )}
              {sceneSkill === SCENE_SKILL_S4 && (
                <div className="scene-wizard-summary-row">
                  <span className="scene-kv-label">装配方式</span>
                  <span>Agent 自主装配（数理画布）</span>
                </div>
              )}
            </>
          )}
        </div>

        <p className="scene-entry-hint">
          {source === 'existing' && '将直接进入所选场景'}
          {source === 'build' && '系统会先判断是否可复用已有场景骨架，再产出完整场景'}
          {source === 'auto' && '直接生成全新场景，不做复用判断'}
          {source === 'custom' && '载入空白骨架，七要素由你自己填写'}
        </p>

        {!canEnter && (
          <p className="scene-builder-warn">
            <ChevronRight className="w-3 h-3" />{packsBusy ? '正在读取交互包清单，请稍候。' : source === 'existing'
              ? '请返回场景来源，读取并选择当前类型的场景。'
              : '请先选择一个项目，或直接填写场景名。'}
          </p>
        )}
      </section>
    );
  };

  return (
    <div className="h5p-scene-entry">
    <div className="h5p-mode-switch" role="group" aria-label="场景运行方式">
      <button type="button" aria-pressed={!h5pMode} disabled={Boolean(deleteTarget)} onClick={() => setH5pMode(false)}>原生场景搭建</button>
      <button type="button" aria-pressed={h5pMode} disabled={Boolean(deleteTarget)} onClick={() => setH5pMode(true)}>H5P 互动场景</button>
    </div>
    {h5pMode ? <H5pLibraryPanel /> : <>
    <div className="scene-builder" inert={deleteTarget ? true : undefined}>
      {renderSteps()}

      <div ref={bodyRef} className="scene-wizard-body" tabIndex={-1} role="region" aria-label={WIZARD_STEPS[step - 1].label}>
        {entryError && <p role="alert" className="scene-builder-error">{entryError}</p>}
        {projectId && !selectedProject && <p role="alert" className="scene-builder-error">关联项目已移除，请返回第一步重新选择。</p>}
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
        {step === 4 && renderStep4()}
      </div>

      <div className="scene-wizard-foot">
        <button type="button" className="scene-btn scene-btn--ghost"
          disabled={step === 1 || deleting} onClick={goPrev}>
          <ArrowLeft className="w-4 h-4" />上一步
        </button>

        <div className="scene-wizard-foot-right">
          {needsNameHint && (
            <span className="scene-builder-warn">请回到上一步选择项目或填写场景名</span>
          )}
          {step < 4 ? (
            <button type="button" className="scene-btn scene-btn--primary" disabled={!canNext || deleting} onClick={goNext}>
              下一步<ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" className="scene-btn scene-btn--primary" disabled={!canEnter} onClick={handleEnter}>
              <ArrowRight className="w-4 h-4" />
              进入场景
            </button>
          )}
        </div>
      </div>
    </div>
    {deleteTarget && <div className="scene-builder-confirm-overlay" onClick={closeDelete}>
      <div className="scene-builder-confirm" ref={dialogRef} role="alertdialog" aria-modal="true"
        aria-labelledby={`${fieldId}-delete-title`} aria-describedby={`${fieldId}-delete-description`}
        tabIndex={-1} aria-busy={deleting} onClick={event => event.stopPropagation()}>
        <h3 id={`${fieldId}-delete-title`}>删除场景？</h3>
        <p id={`${fieldId}-delete-description`}>将删除场景库中的“{deleteTarget.name}”。此操作无法撤销，不会删除关联的项目笔记。</p>
        {deleteError && <p role="alert" className="scene-builder-error">{deleteError}</p>}
        <div className="scene-builder-confirm-actions">
          <button type="button" className="scene-btn scene-btn--ghost" disabled={deleting} onClick={closeDelete}>取消</button>
          <button type="button" className="scene-btn scene-builder-delete" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '正在删除…' : deleteError ? '重试删除' : '确认删除'}</button>
        </div>
      </div>
    </div>}
    </>}
    </div>
  );
};
