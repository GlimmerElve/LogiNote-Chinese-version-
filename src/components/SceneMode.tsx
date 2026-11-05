/**
 * 应用板块主入口：串联「生成中 → 场景确认 → 运行中」三态。
 *
 * 入口态已外移到 LearnHub 的 SceneBuilderPanel，本组件通过 initialRequest 接收来源：
 * - existing：读已有场景 → 直接进预览（0 次 LLM 调用）
 * - build   ：场景搭建 Agent → decideScene → adapt / generate
 * - auto    ：场景搭建 Agent → 跳过复用判断 → generateScene
 * - custom  ：载入空白骨架 → 直接进预览（0 次 LLM 调用）
 *
 * 对话循环：新式 S1 由互动 Agent 每轮先规划上下文与组件，再生成结构化回应；
 * 旧式角色场景也通过运行期角色契约接入互动 Agent。启用指标时再执行 updateMetrics。
 *   → checkEventTriggers 注入突发事件 → checkCompletion 判定结束
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, ArrowLeft } from 'lucide-react';
import {
  NoteItem, SceneSpec, SceneRunState, SceneRunOverrides, MetricDiffItem, SceneInitialRequest,
  SceneSkillType, RoleAttribute, SceneCitation, SceneInteractionResponse,
} from '../types';
import { loadManifest, loadScene, saveScene, generateSceneId } from '../services/scene/sceneSkillStore';
import {
  decideScene, generateScene, adaptScene, saveGeneratedScene, SceneBuildInterruptedError, type SceneBuildCheckpoint,
  // S4：两阶段生成的第二阶段（产出 compute/help）
  generateS4ComputeConfig,
} from '../services/scene/sceneGenerator';
// S4：结束语义（判定权在系统，不走 LLM 的 completionStatus）
import { applyS4Completion } from '../services/scene/derivationRuntime';
import { generateGeneralTurn, fireEvent, makeManualEvent, makeActionMessages, makeEndMessage } from '../services/scene/sceneDirector';
import { updateMetrics, applyOverrides, diffMetrics } from '../services/scene/metricEngine';
import { splitGeneralTurnReply } from '../services/scene/sceneSignal';
import {
  createRunState, appendMessage, appendMessages, incrementTurn,
  updateRunMetrics, checkEventTriggers, checkCompletion, resetForRerun, generateMessageId,
} from '../services/scene/sceneRuntime';
import { SceneSpecPreview } from './scene/SceneSpecPreview';
import { SceneChatView } from './scene/SceneChatView';
import { ScenePageErrorBoundary } from './scene/ScenePageErrorBoundary';
import { normalizeScenePresentation } from '../services/scene/scenePresentation';
import { SceneRerunPanel } from './scene/SceneRerunPanel';
// S4：数理推导画布主视图（隔离点 I8）
import { SceneDerivationView } from './scene/SceneDerivationView';
import {
  formatSceneInteractionResponseContent,
  resolveSceneRuntimeInteractionProtocol,
} from '../services/scene/sceneInteraction';
import { normalizeSceneInteractionResponseV2 } from '../services/scene/sceneInteractionV2Adapter';
import type { SceneTurnAttemptDiagnostic } from '../services/scene/sceneTurnDiagnostics';
import { recordSceneInteractionAudit } from '../services/scene/sceneInteractionAudit';
import { preflightSceneSpec } from '../services/scene/sceneAssembly';
import { recordSceneAssemblyAudit } from '../services/scene/sceneAssemblyAudit';
import { runSceneMultiAgent } from '../services/agent/sceneMultiAgent';
import { gradeSceneObjectiveResponse } from '../services/scene/sceneAssessment';
import { getPendingSceneInteraction } from '../services/scene/scenePendingTask';
import { renderFinalSceneAnswerFeedback } from '../services/scene/sceneTeaching';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from '../services/scene/sceneRuntimeContract';
import { bindSceneProjectMaterials, getSceneProjectMaterials } from '../services/scene/sceneKnowledgePoints';
import { SceneClarificationRequired } from '../services/scene/sceneUnderstanding';
import { closeSceneExperimentSession, sceneExperimentRecords } from '../services/scene/sceneExperiment';
import { sceneInputForm, readSceneFormSubmission, formatSceneFormSubmission } from '../services/scene/sceneInputForm';
import { resolveSceneInputAvailability } from '../services/scene/sceneInputAvailability';

interface Props {
  allNotes: NoteItem[];
  /** 来自 SceneBuilderPanel 的初始请求 */
  initialRequest: SceneInitialRequest;
  /** 跨重启恢复的预览草稿；存在时跳过生成流水线和 LLM 调用。 */
  initialDraft?: SceneSpec | null;
  /** 仅同步预览草稿，不包含运行中的对话与指标状态。 */
  onDraftChange?: (draft: SceneSpec | null) => void;
  /** 返回场景搭建面板（放弃当前场景） */
  onExit: () => void;
  /** 一局首次进入终态后上报压缩记忆；不传完整对话到持久层。 */
  onRunComplete?: (result: { spec: SceneSpec; run: SceneRunState }) => void;
  onSessionStatusChange?: (status: 'idle' | 'running' | 'finished') => void;
  /** 从场景引用跳转到已有笔记。 */
  onOpenNote?: (noteId: string) => void;
  /** 完成场景后提供手动完成任务的入口，不由得分或结束信号自动更新项目。 */
  completionContent?: React.ReactNode;
}

type Phase = 'generating' | 'preview' | 'running';

interface PendingSceneTurn {
  spec: SceneSpec;
  run: SceneRunState;
  lastUserText: string | null;
}

/**
 * S4 助理角色的预设字段（自定义 / 空白骨架用）。
 * 字段名与 SCENE_COMPUTE_GENERATE_PROMPT 要求的 role 输出保持一致，
 * 避免「LLM 生成」与「用户自定义」两条路径产出不同形态。
 */
const S4_ASSISTANT_ATTRIBUTES: RoleAttribute[] = [
  { id: 's4-attr-1', key: '语气', value: '平和、鼓励为主，指出问题时不打击信心', enabled: true },
  { id: 's4-attr-2', key: '性格', value: '耐心、严谨，重视推导过程的合理性', enabled: true },
  { id: 's4-attr-3', key: '知识水平', value: '与场景学科匹配的本科水平', enabled: true },
  { id: 's4-attr-4', key: '讲解详略', value: '先给关键思路，再补充必要推导细节', enabled: true },
  { id: 's4-attr-5', key: '语言风格', value: '简洁清晰，公式与文字结合说明', enabled: true },
];

/** S4 默认推导约束（可编辑；与固定约束不冲突） */
const S4_DEFAULT_RULES: string[] = [
  '每个节点必须写出完整的数学表达式，不得只写结论',
  '数值答案优先使用精确分数（如 4/10、1/3），避免小数近似',
  '必须说明每一步使用的定理或公式依据',
];

/**
 * 构造空白骨架（自定义场景模式：七要素由用户在预览页填写）。
 *
 * S4 与 S1 的差异仅体现在空白骨架的**初值**上（S1 路径行为与改动前完全一致）：
 * - 助理角色预填 5 个可调字段（语气 / 性格 / 知识水平 / 讲解详略 / 语言风格）
 * - 预填 3 条推导约束
 * - 无开场旁白、无突发事件（画布不承载对话流与事件注入）
 * - engineConfig 标注计算引擎；注入画像默认开启（用于按画像调整难度）
 */
function createBlankSpec(
  name: string,
  knowledgePoints: string[],
  sceneSkill: SceneSkillType = 'S1',
): SceneSpec {
  const now = new Date().toISOString();
  const isS4 = sceneSkill === 'S4';

  return {
    sceneId: generateSceneId(),
    version: '1.0',
    meta: {
      name: name || (isS4 ? '自定义数理场景' : '自定义场景'),
      subject: '',
      sceneSkill,
      knowledgePoints,
      goal: '',
    },
    capabilityRecipeId: isS4 ? 'guided-derivation' : undefined,
    situation: '',
    task: '',
    role: isS4
      ? {
          id: 'role-1',
          name: '推导助理',
          attributes: S4_ASSISTANT_ATTRIBUTES.map((a) => ({ ...a })),
        }
      : { id: 'role-1', name: '', attributes: [] },
    userRole: '',
    openingNarrative: '',
    resources: [],
    rules: isS4 ? [...S4_DEFAULT_RULES] : [],
    metrics: [],
    completion: { mode: 'signal', successExpression: '', maxTurns: isS4 ? 30 : 12 },
    evaluationDimensions: [],
    engineConfig: isS4
      ? {
          paradigm: 'single-role-dialogue',
          roleMemory: false,
          technologies: ['SymPy计算引擎', '推导画布', '指标引擎'],
          engines: ['SymPyServer', 'DerivationCanvas', 'MetricEngine'],
        }
      : {
          paradigm: 'single-role-dialogue',
          roleMemory: true,
          technologies: ['LLM流式对话', '指标引擎'],
          engines: ['SceneDirector', 'MetricEngine'],
        },
    events: [],
    // S4 不使用事件注入；S1 保持默认 true
    eventInjection: isS4 ? false : true,
    injectProfile: isS4,
    origin: 'new',
    createdAt: now,
    updatedAt: now,
  };
}

export const SceneMode: React.FC<Props> = ({ allNotes, initialRequest, initialDraft, onDraftChange, onExit, onRunComplete, onOpenNote, onSessionStatusChange, completionContent }) => {
  void allNotes; // 场景生成不依赖笔记列表，仅保持与 LearnHub 入参签名一致

  const [phase, setPhase] = useState<Phase>(initialDraft ? 'preview' : 'generating');
  const [busyLabel, setBusyLabel] = useState('正在准备场景…');
  const [draft, setDraft] = useState<SceneSpec | null>(() => initialDraft ? normalizeScenePresentation(initialDraft) : null);
  const [spec, setSpec] = useState<SceneSpec | null>(null);
  const [run, setRun] = useState<SceneRunState | null>(null);
  const [prevRun, setPrevRun] = useState<SceneRunState | null>(null);
  const [diff, setDiff] = useState<MetricDiffItem[]>([]);
  const [sending, setSending] = useState(false);
  const turnBusyRef = useRef(false);
  const pendingTurnRef = useRef<PendingSceneTurn | null>(null);
  const [turnError, setTurnError] = useState('');
  const [partialReply, setPartialReply] = useState('');
  const [showRerun, setShowRerun] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const startBusyRef = useRef(false);
  const pipelineBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const activeTurnAbortRef = useRef<AbortController | null>(null);
  const activeSetupAbortRef = useRef<AbortController | null>(null);
  const activeComputeAbortRef = useRef<AbortController | null>(null);
  const activeExperimentRunRef = useRef<SceneRunState | null>(null);
  useLayoutEffect(() => {
    activeExperimentRunRef.current = spec?.promptModuleIds?.includes('model-experiment') ? run : null;
  }, [spec, run]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; activeTurnAbortRef.current?.abort(); activeSetupAbortRef.current?.abort(); activeComputeAbortRef.current?.abort();
      if (activeExperimentRunRef.current) closeSceneExperimentSession(activeExperimentRunRef.current);
    };
  }, []);
  useEffect(() => {
    if (run && run.status !== 'running' && spec?.promptModuleIds?.includes('model-experiment')) closeSceneExperimentSession(run);
  }, [run?.runId, run?.status, spec?.promptModuleIds]);
  useLayoutEffect(() => {
    onSessionStatusChange?.(phase === 'running' && run ? run.status === 'running' ? 'running' : 'finished' : 'idle');
  }, [phase, run?.status, onSessionStatusChange]);
  /** 生成失败信息（展示在错误页，不弹窗打断） */
  const [errorMsg, setErrorMsg] = useState('');
  const [clarificationQuestion, setClarificationQuestion] = useState('');
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const clarificationInputRef = useRef<HTMLTextAreaElement>(null);
  const pipelineRequestRef = useRef(initialRequest);
  // Private mount-lifetime recovery only: never write material/context/checkpoints to public diagnostics or a new model phase.
  const pipelineResumeRef = useRef<{
    binding: string;
    materials: ReturnType<typeof getSceneProjectMaterials>;
    coordinated?: Awaited<ReturnType<typeof runSceneMultiAgent>>;
    manifest?: Awaited<ReturnType<typeof loadManifest>>;
    decision?: Awaited<ReturnType<typeof decideScene>>;
    sourceSpec?: SceneSpec | null;
    checkpoint?: SceneBuildCheckpoint;
  } | null>(null);
  useEffect(() => { if (clarificationQuestion) clarificationInputRef.current?.focus(); }, [clarificationQuestion]);
  const capturedRunIdsRef = useRef(new Set<string>());
  const auditedBlockedSceneIdsRef = useRef(new Set<string>());
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);

  useEffect(() => {
    onDraftChangeRef.current?.(phase === 'preview' ? draft : null);
  }, [draft, phase]);

  /** 反事实重跑会生成新的 runId，因此每局都能独立保存且不会重复。 */
  useEffect(() => {
    if (!spec || !run || run.status === 'running' || capturedRunIdsRef.current.has(run.runId)) return;
    capturedRunIdsRef.current.add(run.runId);
    onRunComplete?.({ spec, run });
  }, [onRunComplete, run, spec]);

  /** 按钮会阻止无效场景启动，因此在预览阶段补记一次 blocked；不保存任何场景正文。 */
  useEffect(() => {
    if (phase !== 'preview' || !draft || auditedBlockedSceneIdsRef.current.has(draft.sceneId)) return;
    const result = preflightSceneSpec(draft, { allowDeferredCompute: true });
    if (result.valid) return;
    auditedBlockedSceneIdsRef.current.add(draft.sceneId);
    void recordSceneAssemblyAudit({
      sceneId: draft.sceneId,
      sceneSkill: draft.meta.sceneSkill === 'S4' ? 'S4' : 'S1',
      result,
    }).catch((error) => console.warn('[scene] 装配审计保存失败:', error));
  }, [draft, phase]);

  /* ===== 生成流水线（按来源分支） ===== */
  const runPipeline = async (req: SceneInitialRequest) => {
    if (pipelineBusyRef.current || startBusyRef.current || !mountedRef.current) return;
    pipelineBusyRef.current = true;
    setPhase('generating');
    setErrorMsg('');
    setClarificationQuestion('');
    pipelineRequestRef.current = req;
    const setupAbort = new AbortController();
    activeSetupAbortRef.current = setupAbort;

    try {
      const binding = JSON.stringify(req);
      if (pipelineResumeRef.current?.binding !== binding) pipelineResumeRef.current = {
        binding, materials: getSceneProjectMaterials(req.taskBinding?.noteId, allNotes),
      };
      const recovery = pipelineResumeRef.current;
      const materials = recovery.materials;
      // ① 复用已有场景：直接读取，零 LLM 调用
      if (req.source === 'existing') {
        if (!req.sceneId) throw new Error('未指定要复用的场景');
        setBusyLabel('正在读取场景…');
        const src = await loadScene(req.sceneId);
        if (src?.meta.sceneSkill === 'S2') throw new Error('此场景属于 S2，请从「通用画布（试验）」入口打开；不会按 S1/S4 协议运行');
        if (!mountedRef.current) return;
        if (!src) throw new Error('该场景文件已不存在');
        setDraft(bindSceneProjectMaterials(src, materials));
        pipelineResumeRef.current = null;
        setPhase('preview');
        return;
      }

      // ② 自定义场景：载入空白骨架，零 LLM 调用
      if (req.source === 'custom') {
        setBusyLabel('正在准备空白骨架…');
        // S4 空白骨架预填助理角色与推导约束（S1 保持原样）
        setDraft(bindSceneProjectMaterials(createBlankSpec(req.subject, req.knowledgePoints, req.sceneSkill), materials));
        pipelineResumeRef.current = null;
        setPhase('preview');
        return;
      }

      /**
       * 场景生成参数。
       *
       * `sceneSkill` 是「两个框架」的分派开关：S4 会走数理画布提示词
       * （scene-compute-generate）先生成不含答案的预览外壳，确认后再补 compute/help；
       * S1 保持原有对话场景提示词，行为不变。
       */
      let agentAssembly: Awaited<ReturnType<typeof runSceneMultiAgent>>['recommendation'] | undefined;
      let buildContext: Awaited<ReturnType<typeof runSceneMultiAgent>>['buildContext'] | undefined;
      {
        setBusyLabel('场景搭建 Agent 正在理解目标并装配能力…');
        const designRequest = [
          `搭建一个 ${req.sceneSkill || 'S1'} 学习场景。`,
          `主题：${req.subject}`,
          req.knowledgePoints.length > 0 ? `关联知识点：${req.knowledgePoints.join('、')}` : '',
          req.roleHints ? `用户期望角色：${req.roleHints}` : '',
          req.extraHints ? `用户其它要求：${req.extraHints}` : '',
        ].filter(Boolean).join('\n');
        const coordinated = recovery.coordinated || await runSceneMultiAgent({
          userRequest: designRequest,
          sceneSkillConstraint: req.sceneSkill === 'S4' ? 'S4' : 'S1',
          recipeConstraint: req.recipeId,
          requestedCapabilities: req.requestedCapabilities,
          requestedPromptModules: req.requestedPromptModules,
          materialSummary: materials?.summary,
          buildMaterialScope: materials?.scope,
          signal: setupAbort.signal,
          onDiagnostic: diagnostic => {
            if (!mountedRef.current) return;
            console.warn('[scene-setup]', diagnostic);
            if (diagnostic.retrying) setBusyLabel(diagnostic.stage === 'understand' ? '正在修复需求理解格式…' : '正在修复能力装配格式…');
          },
        });
        if (!mountedRef.current) return;
        if (!coordinated.recommendation.valid) throw new Error('场景搭建 Agent 未能生成可执行的装配方案');
        recovery.coordinated = coordinated;
        agentAssembly = coordinated.recommendation;
        buildContext = coordinated.buildContext;
      }

      const opts = {
        buildContext,
        resume: recovery.checkpoint,
        onCheckpoint: (checkpoint: SceneBuildCheckpoint) => { if (mountedRef.current && pipelineResumeRef.current === recovery) recovery.checkpoint = checkpoint; },
        signal: setupAbort.signal,
        onStage: (stage: import('../services/scene/sceneSetupStage').SceneSetupStage) => {
          if (!mountedRef.current) return;
          const labels: Record<string, string> = { flow: '正在设计互动流程…', instructions: '正在编写场景专属指令…',
            generate: '正在编译完整场景…', accept: '正在逐项验收用户要求…', repair: '正在定向修复验收问题…' };
          if (labels[stage]) setBusyLabel(labels[stage]);
        },
        subject: req.subject,
        knowledgePoints: req.knowledgePoints,
        roleHints: req.roleHints,
        extraHints: [req.extraHints,
          // The full accepted understanding already travels in buildContext; do not duplicate it in prose.
          ...(!buildContext && agentAssembly ? [`搭建 Agent 的目标：${agentAssembly.learningObjective}`,
            `互动设计：${agentAssembly.interactionPlan}`, `约束：${agentAssembly.constraints.join('；')}`] : []),
          materials ? `项目候选知识点 ${materials.summary.candidateCount} 个，可用正文 ${materials.summary.usableCount} 个，空内容 ${materials.summary.emptyCount} 个。只按题目需要读取少量可用正文；不要求先通读或覆盖全部，空正文不能作为证据，也不妨碍设计场景。` : ''].filter(Boolean).join('\n'),
        recipeId: agentAssembly?.recipeId || req.recipeId || (req.sceneSkill === 'S4' ? 'guided-derivation' : undefined),
        requestedCapabilities: agentAssembly?.requestedCapabilities || req.requestedCapabilities,
        requestedPromptModules: agentAssembly?.requestedPromptModules || req.requestedPromptModules,
        sceneSkill: req.sceneSkill,
      };

      // ③ 交给 AI 判断：跳过 decide，直接全新生成
      if (req.source === 'auto') {
        setBusyLabel('正在生成全新场景…');
        const manifest = recovery.manifest || await loadManifest({ strict: true });
        recovery.manifest = manifest;
        if (!mountedRef.current) return;
        const result = await generateScene({ ...opts, manifest });
        if (!mountedRef.current) return;
        setDraft(bindSceneProjectMaterials(result, materials));
        pipelineResumeRef.current = null;
        setPhase('preview');
        return;
      }

      // ④ 搭建新场景：先决策，再按分支生成/改编
      setBusyLabel('正在判断是否可复用已有场景…');
      const manifest = recovery.manifest || await loadManifest({ strict: true });
      recovery.manifest = manifest;
      if (!mountedRef.current) return;
      // S4：只在同类（同 sceneSkill）场景中挑选复用候选，避免跨类型改编（隔离点 I6）
      const decision = recovery.decision || await decideScene({
        ...opts,
        manifest,
        sceneSkillFilter: req.sceneSkill,
      });
      if (!mountedRef.current) return;

      recovery.decision = decision;
      let result: SceneSpec;
      if (decision.decision === 'adapt' && decision.targetSceneId) {
        const src = recovery.sourceSpec === undefined ? await loadScene(decision.targetSceneId) : recovery.sourceSpec;
        recovery.sourceSpec = src;
        if (!mountedRef.current) return;
        if (src) {
          setBusyLabel('正在改编场景骨架…');
          result = await adaptScene({ ...opts, sourceSpec: src });
        } else {
          setBusyLabel('正在生成全新场景…');
          result = await generateScene({ ...opts, manifest });
        }
      } else {
        setBusyLabel('正在生成全新场景…');
        result = await generateScene({ ...opts, manifest });
      }
      if (!mountedRef.current) return;
      setDraft(bindSceneProjectMaterials(result, materials));
      pipelineResumeRef.current = null;
      setPhase('preview');
    } catch (e) {
      if (!mountedRef.current) return;
      if (e instanceof SceneBuildInterruptedError && pipelineResumeRef.current) pipelineResumeRef.current.checkpoint = e.checkpoint;
      if (e instanceof SceneClarificationRequired) {
        setClarificationQuestion(e.question);
        setClarificationAnswer('');
      } else {
        console.error('[scene] 生成失败:', e instanceof SceneBuildInterruptedError ? { stage:e.stage,code:e.code,retryable:e.retryable } : e);
        setErrorMsg((e as Error)?.message || '未知错误');
      }
      setPhase('generating');
      setBusyLabel('');
    } finally {
      pipelineBusyRef.current = false;
    }
  };

  /** 挂载时执行一次（用 ref 防 StrictMode 双调用导致重复扣费） */
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialDraft) return;
    void runPipeline(initialRequest);
    // initialRequest 仅在挂载时生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ===== 开始运行：落盘 + 建局 ===== */
  const handleStart = async (experimentConsent = false) => {
    if (!draft || startBusyRef.current || pipelineBusyRef.current || !mountedRef.current) return;
    startBusyRef.current = true;
    setStarting(true);
    setStartError('');

    try {
    let ready = normalizeScenePresentation(draft);
    if (ready.promptModuleIds?.includes('model-experiment') && !experimentConsent) throw new Error('请先确认模型实验的数据发送与额度消耗。');
    ready = bindSceneProjectMaterials(ready, getSceneProjectMaterials(pipelineRequestRef.current.taskBinding?.noteId || ready.referenceScope?.projectId, allNotes));

    // S4：两阶段生成的第二阶段 —— 若尚未产出 compute 配置，此时才花一次 LLM 调用（§6.8）
    // 「复用已有 S4 场景」与「已生成过 compute」两种情况都会跳过这里，零额外调用。
    if (ready.meta.sceneSkill === 'S4' && !ready.compute) {
      setBusyLabel('正在生成数理推演配置…');
      const computeAbort = new AbortController();
      activeComputeAbortRef.current = computeAbort;
      try { ready = await generateS4ComputeConfig({ spec: ready, signal: computeAbort.signal }); }
      finally { if (activeComputeAbortRef.current === computeAbort) activeComputeAbortRef.current = null; }
      if (!mountedRef.current) return;
      setDraft(ready);
    }

    const preflight = preflightSceneSpec(ready);
    void recordSceneAssemblyAudit({
      sceneId: ready.sceneId,
      sceneSkill: ready.meta.sceneSkill === 'S4' ? 'S4' : 'S1',
      result: preflight,
    }).catch((error) => console.warn('[scene] 装配审计保存失败:', error));
    if (!preflight.valid) {
      setDraft(ready);
      setStartError(preflight.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('；'));
      setBusyLabel('');
      setPhase('preview');
      return;
    }

    ready = { ...ready, capabilityRecipeId: preflight.recipeId, capabilityIds: preflight.enabledCapabilities };
    setDraft(ready);
    setBusyLabel('正在保存场景…');
    const saved = await saveGeneratedScene(ready);
    if (!mountedRef.current) return;
    // 同一局只用同一个 runState（原实现重复创建会得到两个 runId）
    const initialRun = createRunState(saved);
    initialRun.experimentApproved = saved.promptModuleIds?.includes('model-experiment') && experimentConsent;
    setSpec(saved);
    setRun(initialRun);
    setPrevRun(null);
    setDiff([]);
    setPhase('running');
    // S1 才需要角色首轮发言；S4 由画布承载，不调 streamTurn（隔离点 I8）
    if (saved.meta.sceneSkill !== 'S4') {
      void streamTurn(saved, initialRun, null);
    }
    } catch (error) {
      if (!mountedRef.current) return;
      setStartError(error instanceof Error ? error.message : '保存并开始失败，请重试。');
      setPhase('preview');
    } finally {
      startBusyRef.current = false;
      if (mountedRef.current) { setStarting(false); setBusyLabel(''); }
    }
  };

  /* ===== 一轮对话：流式发言 → 指标更新 → 事件 → 判定 ===== */
  const streamTurn = async (s: SceneSpec, startRun: SceneRunState, lastUserText: string | null) => {
    if (turnBusyRef.current || startRun.status !== 'running' || !mountedRef.current) return;
    turnBusyRef.current = true;
    pendingTurnRef.current = { spec: s, run: startRun, lastUserText };
    setSending(true);
    setTurnError('');
    setPartialReply('');
    // 占位消息：承载流式增量
    const placeholderId = generateMessageId();
    let cur: SceneRunState = appendMessage(startRun, {
      id: placeholderId,
      speakerType: 'role',
      speakerName: s.behavior?.kind || s.role.name || 'NPC',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    });
    setRun(cur);

    let acc = '';
    let citations: SceneCitation[] = [];
    let structuredEndReason: string | undefined;
    let taskUpdate: Awaited<ReturnType<typeof generateGeneralTurn>>['taskUpdate'];
    let userRequestedEnd = false;
    const isConversation = startRun.messages.findLast(message => message.speakerType === 'user')?.inputKind === 'conversation';
    let interaction: Awaited<ReturnType<typeof generateGeneralTurn>>['interaction'];
    let interactionEvaluation: Awaited<ReturnType<typeof generateGeneralTurn>>['interactionEvaluation'];
    let objectiveEvaluation: Awaited<ReturnType<typeof generateGeneralTurn>>['objectiveEvaluation'];
    let interactionPreparation: Awaited<ReturnType<typeof generateGeneralTurn>>['interactionPreparation'];
    const attemptDiagnostics: SceneTurnAttemptDiagnostic[] = [];
    let turnAudited = false;
    let discussionInteractionId: string | undefined;
    let teachingState: Awaited<ReturnType<typeof generateGeneralTurn>>['teachingState'];
    let workingMemory: Awaited<ReturnType<typeof generateGeneralTurn>>['workingMemory'];
    let agentTrace: Awaited<ReturnType<typeof generateGeneralTurn>>['agentTrace'];
    let experimentRecords = startRun.experimentRecords || [];
    let experiments: Awaited<ReturnType<typeof generateGeneralTurn>>['experiments'];
    const turnAbort = new AbortController();
    activeTurnAbortRef.current = turnAbort;
    try {
      {
        const result = await generateGeneralTurn(s, cur, { onCitations: (items) => { citations = items; },
          onExperiments: records => {
            if (!mountedRef.current || activeTurnAbortRef.current !== turnAbort) return;
            // Paid experiment receipts survive a render failure or reply retry; never attach them to a later run.
            experimentRecords = records;
            cur = { ...cur, experimentRecords: records };
            const pending = pendingTurnRef.current;
            if (pending?.run.runId === startRun.runId) pendingTurnRef.current = {
              ...pending, run: { ...pending.run, experimentRecords: records },
            };
            setRun(current => current?.runId === startRun.runId && current.status === 'running'
              ? { ...current, experimentRecords: records } : current);
          }, onDiagnostic: diagnostic => { attemptDiagnostics.push(diagnostic); }, signal: turnAbort.signal });
        if (!mountedRef.current || activeTurnAbortRef.current !== turnAbort) return;
        acc = result.content;
        interaction = result.interaction;
        interactionEvaluation = result.interactionEvaluation;
        objectiveEvaluation = result.objectiveEvaluation;
        interactionPreparation = result.interactionPreparation;
        structuredEndReason = result.endReason;
        taskUpdate = result.taskUpdate;
        userRequestedEnd = result.userRequestedEnd === true;
        workingMemory = result.workingMemory;
        teachingState = result.teachingState;
        discussionInteractionId = result.discussionInteractionId;
        agentTrace = result.agentTrace;
        experiments = result.experiments;
        const protocol = resolveSceneRuntimeInteractionProtocol(s.behavior?.interaction);
        void recordSceneInteractionAudit({
          runId: cur.runId,
          sceneId: cur.sceneId,
          turnNumber: cur.turnCount + 1,
          allowedTypes: protocol.allowedTypes,
          diagnostic: result.interactionDiagnostic,
          attempts: attemptDiagnostics,
        }).catch((error) => console.warn('[scene-interaction-audit] record failed:', error));
        turnAudited = true;
      }

      // 拆分：正文 / 动作 / 结束信号（零额外调用）
      const parts = splitGeneralTurnReply(acc);
      const signalReason = structuredEndReason;
      if (!parts.content.trim() && parts.actions.length === 0 && !signalReason && !interaction) {
        throw new Error('本轮没有收到可显示的回复，请重试本轮。');
      }
      cur = {
        ...cur,
        messages: cur.messages.map((m) =>
          m.id === placeholderId
            ? {
                ...m,
                content: parts.content,
                isStreaming: false,
                citations: parts.content.trim() && citations.length > 0 ? citations : undefined,
                agentTrace,
                discussionInteractionId,
                experiments,
                objectiveEvaluation,
                interactionPreparation,
                interaction,
                interactionEvaluation,
              }
            : m,
        ),
      };
      cur = appendMessages(cur, makeActionMessages(parts.actions));

      // ② 指标更新 + 条件型事件判定（signal 模式内部短路，不产生调用）
      const lastUserMsg =
        cur.messages.filter((m) => m.speakerType === 'user').slice(-1)[0] ||
        ({ id: 'none', speakerType: 'user', speakerName: '', content: lastUserText || '', timestamp: '' } as never);
      const metricResult = !isConversation && isScenePromptModuleEnabled(s, 'metric-state')
        ? await updateMetrics(s, cur, lastUserMsg)
        : { metrics: cur.metrics, deltas: [], triggeredEvents: [], completionStatus: 'ongoing' as const };
      if (!mountedRef.current || activeTurnAbortRef.current !== turnAbort) return;
      cur = updateRunMetrics(cur, metricResult.metrics, metricResult.deltas);

      if (metricResult.deltas.length > 0) {
        const roleMsgs = cur.messages.filter((m) => m.speakerType === 'role');
        const lastRole = roleMsgs[roleMsgs.length - 1];
        if (lastRole) {
          cur = {
            ...cur,
            messages: cur.messages.map((m) =>
              m.id === lastRole.id ? { ...m, metricDeltas: metricResult.deltas } : m,
            ),
          };
        }
      }

      const triggerResult = !isConversation && isScenePromptModuleEnabled(s, 'event-system')
        ? checkEventTriggers(cur, metricResult.triggeredEvents) : { run: cur, fired: [] };
      cur = triggerResult.run;
      for (const ev of triggerResult.fired) cur = appendMessage(cur, fireEvent(ev));

      // Only a complete reply reaches metrics, events and completion.
      if (!isConversation || userRequestedEnd) cur = checkCompletion(s, cur, { metricStatus: metricResult.completionStatus, signalReason, userIntentEnd: userRequestedEnd });
      if (taskUpdate) cur = { ...cur, retiredInteractionIds: [...new Set([...(cur.retiredInteractionIds || []), taskUpdate.interactionId])] };
      // Commit work memory only after the entire turn succeeds; failed/retried turns keep their input snapshot.
      if (workingMemory) cur = { ...cur, workingMemory };
      if (teachingState) cur = { ...cur, teachingState };
      if (s.promptModuleIds?.includes('model-experiment')) cur = { ...cur, experimentRecords };
      if (cur.status !== 'running') {
        const feedback = renderFinalSceneAnswerFeedback(s, cur), id = 'answer-feedback:' + cur.runId;
        if (feedback && !cur.messages.some(message => message.id === id)) cur = appendMessage(cur, {
          id, speakerType: 'system', speakerName: '答案核对记录', content: feedback, timestamp: new Date().toISOString(),
        });
      }
      if (cur.status !== 'running' && cur.endReason) cur = appendMessage(cur, makeEndMessage(cur.endReason));
      setRun(cur);
      pendingTurnRef.current = null;
    } catch (e) {
      if (!mountedRef.current || activeTurnAbortRef.current !== turnAbort) return;
      if (!turnAudited && attemptDiagnostics.length) void recordSceneInteractionAudit({
        runId:startRun.runId,sceneId:startRun.sceneId,turnNumber:startRun.turnCount+1,
        allowedTypes:resolveSceneRuntimeInteractionProtocol(s.behavior?.interaction).allowedTypes,
        diagnostic:{resolvedType:'none',outcome:'none',reason:'invalid-fields'},attempts:attemptDiagnostics,
      }).catch(error=>console.warn('[scene-interaction-audit] record failed:',error));
      // Keep the already-submitted user turn once; an unfinished reply is not a completed or evaluated turn.
      setRun(s.promptModuleIds?.includes('model-experiment') ? { ...startRun, experimentRecords } : startRun);
      setPartialReply(splitGeneralTurnReply(acc).content);
      setTurnError(e instanceof Error ? e.message : '本轮回复生成失败，请重试。');
    } finally {
      if (activeTurnAbortRef.current === turnAbort) {
        activeTurnAbortRef.current = null;
        turnBusyRef.current = false;
        if (mountedRef.current) setSending(false);
      }
    }
  };

  const handleRetryTurn = () => {
    const pending = pendingTurnRef.current;
    if (!pending || turnBusyRef.current || run?.status !== 'running') return;
    // Retry the reply from the same post-user snapshot: no additional answer or turn increment.
    void streamTurn(pending.spec, pending.run, pending.lastUserText);
  };

  /** 用户发言 */
  const handleReviseTurn = () => {
    if (!spec || !run || run.status !== 'running' || turnBusyRef.current || !pendingTurnRef.current
      || !(resolveSceneRuntimeContract(spec).allowConversation || resolveSceneRuntimeContract(spec).allowTextFallback)) return;
    // Retain the original submission and any paid receipts. A correction is a new user turn,
    // never an in-place rewrite of evidence or an implicit rerun of the failed operation.
    pendingTurnRef.current = null;
    setTurnError('');
    setPartialReply('');
  };

  const handleSend = async (text: string, rawResponse?: SceneInteractionResponse, rawForm?: import('../types').SceneFormSubmission, inputKind: 'response' | 'conversation' = 'response') => {
    if (!spec || !run || run.status !== 'running' || turnBusyRef.current || pendingTurnRef.current) return;
    const contract = resolveSceneRuntimeContract(spec);
    if (inputKind !== 'response' && inputKind !== 'conversation') return;
    if (inputKind === 'conversation' && (!contract.allowConversation || rawResponse || rawForm)) return;
    const pendingTask = getPendingSceneInteraction(run);
    let interactionResponse: SceneInteractionResponse | undefined;
    let sourceInteractionMessage: SceneRunState['messages'][number] | undefined;
    let content = text.trim();
    let formSubmission: import('../types').SceneFormSubmission | undefined;
    if (rawForm) {
      if (rawResponse || !resolveSceneInputAvailability(spec, run).formAvailable) return;
      const form = sceneInputForm(spec);
      if (!form) return;
      try { formSubmission = readSceneFormSubmission(rawForm, form); content = formatSceneFormSubmission(form, formSubmission); }
      catch { return; }
    }
    if (rawResponse) {
      if (!contract.allowedInteractionTypes.includes(rawResponse.type)) return;
      sourceInteractionMessage = pendingTask;
      const directive = sourceInteractionMessage?.interaction;
      if (directive?.id !== rawResponse.interactionId) return;
      interactionResponse = normalizeSceneInteractionResponseV2(rawResponse, directive);
      if (!interactionResponse) return;
      content = formatSceneInteractionResponseContent(interactionResponse, directive);
    } else if (inputKind === 'response' && (!contract.allowTextFallback || (pendingTask?.interaction && pendingTask.interaction.type !== 'text'))) return;
    if (!content) return;
    let cur = appendMessage(run, {
      id: generateMessageId(),
      speakerType: 'user',
      speakerName: '你',
      content,
      timestamp: new Date().toISOString(),
      interactionResponse,
      inputKind,
      formSubmission,
      objectiveAssessment: interactionResponse ? gradeSceneObjectiveResponse(interactionResponse, sourceInteractionMessage?.objectiveEvaluation) : undefined,
    });
    if (inputKind === 'response') cur = incrementTurn(cur);
    setRun(cur);
    // All submitted tasks keep deterministic local keys/records, but teaching and feedback stay with the Agent.
    await streamTurn(spec, cur, content);
  };

  /** 手动注入突发事件（不写入场景定义，仅进入本局） */
  const handleInjectEvent = (text: string) => {
    if (!run || run.status !== 'running' || !spec?.eventInjection || !isScenePromptModuleEnabled(spec, 'event-system') || turnBusyRef.current || pendingTurnRef.current) return;
    const ev = makeManualEvent(text);
    let cur = appendMessage(run, fireEvent(ev));
    cur = { ...cur, events: [...cur.events, ev] };
    setRun(cur);
  };

  /** 用户主动结束 */
  const handleEnd = async () => {
    if (!spec || !run || run.status !== 'running' || turnBusyRef.current) return;
    if (spec.meta.sceneSkill !== 'S4' && !pendingTurnRef.current) {
      const content = '结束本场景。请按当前反馈策略总结本局已提交的答案、未解决问题与后续建议，不再出题。';
      const cur = appendMessage(run, { id: generateMessageId(), speakerType: 'user', speakerName: '你',
        content, timestamp: new Date().toISOString(), inputKind: 'conversation', endRequested: true });
      setRun(cur);
      await streamTurn(spec, cur, content);
      return;
    }
    // A failed model turn must not trap the end button; retain records and expose only final-authorized local feedback.
    pendingTurnRef.current = null;
    setTurnError('');
    setPartialReply('');
    // S4：走系统判定（checkS4Completion + 最终得分），不走 LLM 的 completionStatus
    let cur =
      spec.meta.sceneSkill === 'S4'
        ? applyS4Completion(spec, run, { userIntentEnd: true })
        : checkCompletion(spec, run, { userIntentEnd: true });
    if (spec.meta.sceneSkill !== 'S4') {
      const feedback = renderFinalSceneAnswerFeedback(spec, cur), id = 'answer-feedback:' + cur.runId;
      if (feedback && !cur.messages.some(message => message.id === id)) cur = appendMessage(cur, {
        id, speakerType: 'system', speakerName: '答案核对记录', content: feedback, timestamp: new Date().toISOString(),
      });
    }
    if (cur.endReason) cur = appendMessage(cur, makeEndMessage(cur.endReason));
    setRun(cur);
  };

  /** End locally only on explicit recovery action; preserve submitted records and never replay the model. */
  const handleRenderFailureReturn = () => {
    // Capture completed target output even if its independent judge has not delivered the final callback yet.
    const experimentSnapshot = run && spec?.promptModuleIds?.includes('model-experiment') ? sceneExperimentRecords(run) : [];
    const controller = activeTurnAbortRef.current;
    activeTurnAbortRef.current = null;
    controller?.abort();
    turnBusyRef.current = false;
    pendingTurnRef.current = null;
    setSending(false);
    setTurnError('');
    setPartialReply('');
    setShowRerun(false);
    setRun(current => current?.status === 'running' ? {
      ...current, messages: current.messages.filter(message => !message.isStreaming),
      ...(experimentSnapshot.length ? { experimentRecords: [...new Map([
        ...(current.experimentRecords || []), ...experimentSnapshot,
      ].map(record => [record.id, record])).values()] } : {}),
      status: 'success', completionOutcome: 'stopped',
      endReason: '用户因界面渲染异常结束本局并返回预览。',
      endedAt: new Date().toISOString(),
    } : current);
    if (spec) setDraft(normalizeScenePresentation(spec));
    setPhase('preview');
  };

  /* ===== 反事实重跑 ===== */
  const handleRerunConfirm = async (overrides: SceneRunOverrides) => {
    if (!spec || !run || run.status === 'running' || turnBusyRef.current) return;
    const nextSpec = applyOverrides(spec, overrides);
    const nextRun = { ...resetForRerun(nextSpec, { ...run, overrides }), experimentApproved: run.experimentApproved };
    // 差异对比：上一局（本局结束态）vs 重跑的新局（初值态）
    setDiff(diffMetrics(run, nextRun, nextSpec));
    setPrevRun(run);
    setSpec(nextSpec);
    setRun(nextRun);
    setShowRerun(false);
    if (nextSpec.meta.sceneSkill !== 'S4') await streamTurn(nextSpec, nextRun, null);
  };

  /* ===== 渲染 ===== */
  if (phase === 'generating') {
    if (clarificationQuestion) {
      return (
        <form className="scene-loading" aria-label="补充场景条件" onSubmit={event => {
          event.preventDefault();
          if (!clarificationAnswer.trim() || pipelineBusyRef.current) return;
          const prior = pipelineRequestRef.current;
          void runPipeline({ ...prior, extraHints: [prior.extraHints, `用户补充说明：${clarificationAnswer.trim()}`].filter(Boolean).join('\n') });
        }}>
          <p className="scene-loading-text">需要确认一项条件</p>
          <p id="scene-clarification-question" className="scene-loading-hint" role="status">{clarificationQuestion}</p>
          <label className="scene-field-label w-full max-w-lg">补充说明
            <textarea ref={clarificationInputRef} className="scene-textarea w-full" aria-describedby="scene-clarification-question"
              value={clarificationAnswer} onChange={event => setClarificationAnswer(event.target.value)} rows={3} maxLength={2000} required />
          </label>
          <div className="scene-loading-actions">
            <button type="submit" className="scene-btn scene-btn--primary" disabled={!clarificationAnswer.trim()}>继续搭建</button>
            <button type="button" className="scene-btn scene-btn--ghost" onClick={onExit}>返回</button>
          </div>
        </form>
      );
    }
    // 失败态：给出重试与返回入口，不用 alert 打断
    if (errorMsg) {
      return (
        <div className="scene-loading">
          <p className="scene-loading-text">场景生成失败</p>
          <p className="scene-loading-hint" role="alert">{errorMsg}</p>
          <div className="scene-loading-actions">
            <button type="button" className="scene-btn scene-btn--primary" onClick={() => void runPipeline(pipelineRequestRef.current)}>
              重试
            </button>
            <button type="button" className="scene-btn scene-btn--ghost" onClick={onExit}>
              返回
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="scene-loading">
        <Loader2 className="w-6 h-6 animate-spin text-[#3F7A50]" />
        <p className="scene-loading-text">{busyLabel || '正在生成场景…'}</p>
        <p className="scene-loading-hint">首次生成可能需要 20~60 秒</p>
        <button type="button" className="scene-btn scene-btn--ghost scene-btn--tiny" onClick={onExit}>
          <ArrowLeft className="w-3 h-3" />
          放弃并返回
        </button>
      </div>
    );
  }

  if (phase === 'preview' && draft) {
    // 复用已有 / 自定义场景没有「重新生成」语义，仅在生成来源下提供
    const canRegenerate = initialRequest.source === 'build' || initialRequest.source === 'auto';
    return (
      <ScenePageErrorBoundary key={"preview:" + draft.sceneId} section="preview" onReturn={onExit}>
      <SceneSpecPreview
        spec={draft}
        busy={starting}
        busyLabel={busyLabel}
        startError={startError}
        onChange={(next) => { if (!startBusyRef.current) { setDraft(next); setStartError(''); } }}
        onStart={consent => void handleStart(consent)}
        onRegenerate={canRegenerate ? () => void runPipeline(pipelineRequestRef.current) : undefined}
        onDelete={onExit}
        modeHint={
          initialRequest.source === 'custom'
            ? '自定义场景：请补全情境、任务、角色、规则等要素。未设指标时以对话自然结束为准。'
            : undefined
        }
      />
      </ScenePageErrorBoundary>
    );
  }

  if (phase === 'running' && spec && run) {
    if (showRerun && prevRun) {
      return (
        <SceneRerunPanel
          spec={spec}
          prevRun={prevRun}
          busy={sending}
          diff={diff}
          onConfirm={(ov) => void handleRerunConfirm(ov)}
          onClose={() => setShowRerun(false)}
        />
      );
    }
    // S4 分流：数理场景走画布视图（隔离点 I8）。S1 走下方原路径，完全不变。
    if (spec.meta.sceneSkill === 'S4' && run.canvas) {
      return (
        <>
          <SceneDerivationView
            spec={spec}
            run={run}
            busy={sending}
            onRunChange={setRun}
            onEnd={handleEnd}
            onExit={onExit}
            completionContent={completionContent}
            onRerun={() => setShowRerun(true)}
            hasPrevRun={prevRun !== null}
          />
          {run.status !== 'running' && !prevRun && (
            <div className="scene-after-end">
              <button type="button" className="scene-btn scene-btn--primary"
                onClick={() => { setPrevRun(run); setDiff([]); setShowRerun(true); }}>
                反事实重跑：改变条件再试一次
              </button>
            </div>
          )}
        </>
      );
    }

    return (
      <>
        <ScenePageErrorBoundary key={"running:" + run.runId} section="running" onReturn={handleRenderFailureReturn}>
        <SceneChatView
          spec={spec}
          run={run}
          sending={sending}
          turnError={turnError}
          partialReply={partialReply}
          onRetryTurn={handleRetryTurn}
          onReviseTurn={resolveSceneRuntimeContract(spec).allowConversation || resolveSceneRuntimeContract(spec).allowTextFallback ? handleReviseTurn : undefined}
          onSend={(text, response, submission, inputKind) => void handleSend(text, response, submission, inputKind)}
          onInjectEvent={handleInjectEvent}
          onEnd={handleEnd}
          onExit={onExit}
          completionContent={completionContent}
          onRerun={() => setShowRerun(true)}
          hasPrevRun={prevRun !== null}
          onOpenNote={onOpenNote}
        />
        </ScenePageErrorBoundary>
        {/* 结束后可进入反事实重跑：用本局作为「上一局」 */}
        {run.status !== 'running' && !prevRun && (
          <div className="scene-after-end">
            <button type="button" className="scene-btn scene-btn--primary"
              onClick={() => { setPrevRun(run); setDiff([]); setShowRerun(true); }}>
              反事实重跑：改变条件再试一次
            </button>
          </div>
        )}
      </>
    );
  }

  return null;
};
