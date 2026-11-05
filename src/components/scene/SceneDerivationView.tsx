/**
 * S4 数理场景运行主视图（对应实施计划 F17，阶段八重构信息区与求助链路）。
 *
 * 布局：
 *   ┌──────────────────────────────┬──────────────┐
 *   │  顶部：标题 / 进度 / 操作      │              │
 *   ├──────────────────────────────┤  助手面板     │
 *   │  任务信息栏（任务 / 目标）     │  HelperPanel │
 *   ├──────────────────────────────┤              │
 *   │                              ├──────────────┤
 *   │   推导画布 DerivationCanvas   │  标准解法     │
 *   │                              │  结果曲线     │
 *   │                              │  指标面板     │
 *   └──────────────────────────────┴──────────────┘
 *
 * 本组件是 S4 的**唯一编排点**，把服务层与视图层接起来：
 * - 节点提交 → computeAnalyze.analyzeStep → updateNodeResult + updateS4Metrics → 事件流 → 完成判定
 * - 求助     → sceneHelp.requestHelp → 新运行态 + 历史卡
 * - 插入画布 → 用求助给的 latex 新建 formula 节点
 *
 * 阶段八的三处关键改动：
 * 1. **任务信息栏**：旧实现只显示「已完成 N/M 步」，用户看得到已知条件却不知道要干什么。
 *    现在常驻显示 `spec.task`（任务）与 `meta.goal`（目标），可展开看知识点与边界条件。
 * 2. **求助链路打通**：旧实现 `onRequestHelp` 是空实现（只清了错误），
 *    节点上的「求助」按钮点了毫无反应。现在切到求助页 + 预填当前步骤上下文 + 聚焦输入框，
 *    且**不自动消耗次数** —— 次数是稀缺资源，由用户确认后提交。
 * 3. **曲线面板接入**：改用 `CurvePanel`（用户自选要画哪些公式），
 *    不再直接绘制 `expected_formula`（那等于展示标准答案）。
 *
 * 对应《场景设计原则》：
 * - 原则 5「用户有行动」：所有推进都由用户在画布上的操作触发，无「下一步」按钮
 * - 原则 6「行动有后果」：每次提交/求助都产生节点状态变化 + 指标变化 + 事件流记录
 * - 原则 7「状态可感知」：任务、目标、进度、剩余求助次数常驻可见
 * - 原则 12「反事实支持」：顶部提供「重跑」入口
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  Loader2,
  RotateCcw,
  Flag,
  Calculator,
  CircleAlert,
  Image,
  FileText,
  Code,
  BookOpen,
  Braces,
  GitBranch,
  Info,
  PanelLeftOpen, PanelRightOpen, X,
} from 'lucide-react';
import type { SceneRunState, SceneSpec } from '../../types';
import type { DerivationNode, HelpResponse, S4HelpSource } from '../../types/sceneS4';
import { DERIVATION_STATUS_LABEL } from '../../types/sceneS4';
import { DerivationCanvas } from '../../modules/derivationCanvas/DerivationCanvas';
import { MathField } from '../../modules/derivationCanvas/components/MathField';
import { SceneMetricPanel } from './SceneMetricPanel';
import { SceneRichMessage } from './SceneRichMessage';
import { useDialog } from '../useDialog';
import { HelperPanel, type HelperTab } from './HelperPanel';
import { SceneErrorBoundary } from './SceneErrorBoundary';
import { CurvePanel } from './CurvePanel';
import { StandardSolutionView } from './StandardSolutionView';
import { analyzeStep, analyzeAssumptionStep } from '../../services/scene/computeAnalyze';
import { requestHelp } from '../../services/scene/sceneHelp';
import { s4HelpInputKey } from '../../services/scene/sceneS4HelpContext';
import { canRetryS4Goal, pendingS4GoalNodes, s4GoalInputKey, s4GoalRetryCount, S4_GOAL_RETRY_LIMIT } from '../../services/scene/sceneS4Goal';
import { requestS4GoalCheck } from '../../services/scene/sceneS4GoalCheck';
import { isS4HelpAuthorized, s4HelpLimit, s4HelpPenalty, s4AllowedNodeTypes, isS4CanvasChangeAuthorized, s4NodeAuthorizationError, s4SubmissionLimit, unlockS4ReferenceAnswer } from '../../services/scene/sceneS4Policy';
import { sessionInit, sessionClose } from '../../services/scene/computeClient';
import { buildSessionSymbols } from '../../services/scene/premiseChain';
import { exportSceneLatex, exportScenePdf, exportScenePng } from '../../services/scene/sceneExport';
import {
  appendDerivationEvent,
  applyHelpPenalty,
  applyS4Completion,
  checkS4Completion,
  makeDerivationEvent,
  updateNodeResult,
  updateS4Metrics,
  updateS4RuleMetrics,
  s4SubmissionCount,
  refreshS4EngineMetrics,
} from '../../services/scene/derivationRuntime';

export interface SceneDerivationViewProps {
  spec: SceneSpec;
  run: SceneRunState;
  /** 外部忙（如反事实重跑准备中） */
  busy: boolean;
  onRunChange: (next: SceneRunState) => void;
  /** 用户主动结束 */
  onEnd: () => void;
  onExit?: () => void;
  /** 仅在推导结束的结果栏内显示，不能触发自动完成或页面跳转。 */
  completionContent?: React.ReactNode;
  /** 进入反事实重跑面板 */
  onRerun: () => void;
  hasPrevRun: boolean;
  /** 本地演示：使用确定性模拟分析/求助，不调用 Provider 或计算服务。 */
  previewMode?: boolean;
}

/** Ignore viewport/status changes, but reject results for changed mathematical inputs. */
function derivationInputKey(run: SceneRunState): string {
  return JSON.stringify({
    nodes: run.canvas?.nodes.map(({ id, type, data }) => [id, type, data.latex, data.note, data.entries]),
    edges: run.canvas?.edges.map(({ id, source, target }) => [id, source, target]),
  });
}

/** 从事件流中还原求助历史（事件流是唯一真相来源，符合「案例可沉淀」） */
function extractHelpHistory(
  run: SceneRunState,
): Array<{ content: HelpResponse; remaining: number } & S4HelpSource> {
  const events = run.derivationEvents ?? [];
  return events
    .filter((e): e is Extract<typeof e, { type: 'help_response' }> => e.type === 'help_response')
    .map((e) => ({ content: e.content, remaining: e.remaining, nodeId:e.nodeId ?? null, inputKey:e.inputKey }));
}

/**
 * 内部实现，不直接对外导出。
 *
 * 它内部渲染的 DerivationCanvas 会调用 useReactFlow()，
 * 该 hook 必须处于 ReactFlowProvider 之内，否则抛错并卸载整棵树（全窗口白屏）。
 * 对外入口统一由文件末尾的 SceneDerivationView 包装提供 Provider。
 */
const SceneDerivationViewInner: React.FC<SceneDerivationViewProps> = ({
  spec,
  run,
  busy,
  onRunChange,
  onEnd,
  onExit,
  completionContent,
  onRerun,
  hasPrevRun,
  previewMode = false,
}) => {
  /** 正在分析的节点 id */
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  /** 正在求助 */
  const [asking, setAsking] = useState(false);
  const [goalCheckingId, setGoalCheckingId] = useState<string | null>(null);
  /** 顶部错误条 */
  const [error, setError] = useState<string | null>(null);
  /** 引擎未就绪警告（首次检测后缓存） */
  const [engineDown, setEngineDown] = useState(false);
  /** 正在导出（null = 空闲） */
  const [exporting, setExporting] = useState<'png' | 'pdf' | 'tex' | null>(null);
  /** 导出截图的 DOM 目标（画布容器） */
  const exportRef = useRef<HTMLDivElement | null>(null);
  /**
   * 前提链会话 id（轮次 I 新增）。
   *
   * 为什么需要：前提链判定（`session_step`）依赖服务端的**符号环境缓存**。
   * 没有它，`analyzeStep` 拿不到 `sessionId` 就会退回「与参考答案比差式」的
   * 旧路径 —— 而那条路已被证明在纯常数场景下会误判（如 `1=2=3`）。
   *
   * 用 ref 而非 state：它只参与请求参数组装，不驱动渲染。
   */
  const sessionIdRef = useRef<string>('');
  const [engineStarting, setEngineStarting] = useState(!previewMode);
  const [engineRetry, setEngineRetry] = useState(0);
  const latestRef = useRef({ run, spec, busy, onRunChange });
  latestRef.current = { run, spec, busy, onRunChange };
  const mountedRef = useRef(true);
  const operationRef = useRef<object | null>(null);
  const [narrowPanels, setNarrowPanels] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches);
  const [panel, setPanel] = useState<'brief' | 'helper' | null>(null);
  const briefRef = useRef<HTMLElement>(null);
  const helperRef = useRef<HTMLElement>(null);
  useDialog(narrowPanels && panel === 'brief', briefRef, () => setPanel(null));
  useDialog(narrowPanels && panel === 'helper', helperRef, () => setPanel(null));
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const update = () => { setNarrowPanels(media.matches); setPanel(null); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; operationRef.current = null; };
  }, []);
  React.useEffect(() => {
    operationRef.current = null;
    setAnalyzingId(null); setAsking(false); setGoalCheckingId(null); setExporting(null); setError(null);
    selectedNodeRef.current = null; setPrefill(null); setHelperTab('analysis'); setSelectedNodeId(null); setPanel(null);
  }, [spec.sceneId, run.runId]);
  const publishRun = useCallback((next: SceneRunState) => {
    latestRef.current = { ...latestRef.current, run: next };
    latestRef.current.onRunChange(next);
  }, []);
  const canMutate = useCallback(() => mountedRef.current && !operationRef.current
    && !latestRef.current.busy && latestRef.current.run.status === 'running', []);
  const isCurrentOperation = useCallback((token: object, original: SceneRunState, sceneId: string) => mountedRef.current
    && operationRef.current === token && latestRef.current.run.runId === original.runId
    && latestRef.current.spec.sceneId === sceneId && latestRef.current.run.status === 'running', []);

  /* ===== 助手面板：页签受控（节点「求助」按钮需要把面板切过去） ===== */
  const [helperTab, setHelperTab] = useState<HelperTab>('analysis');
  /** 求助预填请求：seq 递增即触发一次预填+聚焦，保证同节点重复点击也生效 */
  const [prefill, setPrefill] = useState<{ text: string; seq: number } | null>(null);
  const prefillSeqRef = useRef(0);
  const selectedNodeRef = useRef<string | null>(null);
  /** 画布选择态驱动属性与分析展示，不写入 SceneRunState。 */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const handleSelectNode = useCallback((id: string | null) => {
    selectedNodeRef.current = id;
    setSelectedNodeId(id);
  }, []);

  const canvas = run.canvas;
  const helpAuthorized = isS4HelpAuthorized(spec);
  const helpLimit = Math.min(canvas?.maxHelp ?? 0, s4HelpLimit(spec));
  const remaining = Math.max(0, helpLimit - (canvas?.helpUsed ?? 0));

  const helpHistory = useMemo(() => extractHelpHistory(run), [run.derivationEvents]);
  const selectedNode = useMemo(
    () => canvas?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [canvas?.nodes, selectedNodeId],
  );
  /** 展示当前输入的状态，不能把另一节点的旧结论当成当前步骤的判定。 */
  const analyzedNode = useMemo<DerivationNode | null>(() => {
    const nodes = canvas?.nodes ?? [];
    if (analyzingId) return nodes.find((node) => node.id === analyzingId) ?? null;
    if (selectedNode) return selectedNode;
    const events = run.derivationEvents ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== 'node_submit' && event.type !== 'node_verify') continue;
      const node = nodes.find((item) => item.id === event.nodeId);
      if (node) return node;
    }
    // 兼容没有提交事件的历史画布；始终使用节点当前的数据，而非事件中的旧结果。
    return [...nodes].reverse().find((node) => node.data.verification) ?? null;
  }, [canvas?.nodes, analyzingId, selectedNode, run.derivationEvents]);
  const selectedIncoming = selectedNode
    ? canvas?.edges.filter((edge) => edge.target === selectedNode.id).length ?? 0
    : 0;
  const selectedOutgoing = selectedNode
    ? canvas?.edges.filter((edge) => edge.source === selectedNode.id).length ?? 0
    : 0;

  /* ================================================================
   * 导出（阶段五：PNG / PDF / LaTeX）
   * ================================================================ */

  const handleExport = useCallback(
    async (kind: 'png' | 'pdf' | 'tex') => {
      if (!mountedRef.current || operationRef.current || latestRef.current.busy) return;
      const token = {};
      operationRef.current = token;
      setError(null);
      setExporting(kind);
      try {
        if (kind === 'tex') {
          // LaTeX 由 spec/run 重建，不依赖 DOM，任何时刻都可用
          exportSceneLatex(spec, run);
        } else {
          const ok =
            kind === 'png'
              ? await exportScenePng(exportRef.current, spec.meta.name)
              : await exportScenePdf(exportRef.current, spec.meta.name);
          if (!ok && mountedRef.current && operationRef.current === token) setError('导出失败：未找到可导出的画布区域');
        }
      } catch (e) {
        if (mountedRef.current && operationRef.current === token) setError((e as Error)?.message || '导出失败，请重试');
      } finally {
        if (operationRef.current === token) {
          operationRef.current = null;
          if (mountedRef.current) setExporting(null);
        }
      }
    },
    [spec, run],
  );

  /* ================================================================
   * 画布状态同步
   * ================================================================ */

  const handleCanvasChange = useCallback(
    (nextCanvas: NonNullable<SceneRunState['canvas']>) => {
      if (!canMutate()) return;
      const current = latestRef.current.run;
      if (current.canvas && !isS4CanvasChangeAuthorized(current.canvas, nextCanvas, s4AllowedNodeTypes(spec))) {
        setError('画布变更被拒绝：系统已知条件不可改写或删除，也不能操作未启用的节点组件。');
        return;
      }
      let nextRun: SceneRunState = refreshS4EngineMetrics(spec, { ...current, canvas: nextCanvas });
      const previousById = new Map((current.canvas?.nodes || []).map((node) => [node.id, node]));
      for (const node of nextCanvas.nodes) {
        const previous = previousById.get(node.id);
        const oldLatex = previous?.data.latex ?? '';
        const newLatex = node.data.latex ?? '';
        if (previous && oldLatex !== newLatex) {
          nextRun = appendDerivationEvent(
            nextRun,
            makeDerivationEvent('node_edit', { nodeId: node.id, oldLatex, newLatex }),
          );
        }
      }
      publishRun(nextRun);
    },
    [spec, canMutate, publishRun],
  );

  /* ================================================================
   * 提交节点 → 分析
   * ================================================================ */

  const handleSubmitNode = useCallback(
    async (nodeId: string) => {
      if (!canMutate()) return;
      const original = latestRef.current.run;
      const node = original.canvas?.nodes.find((n) => n.id === nodeId);
      if (!node || node.type === 'given' || node.data.frozen) return;
      if (!node.data.latex?.trim()) { setError('请先在公式输入区填写本步公式；备注仅用于说明，不参与验证。'); return; }
      const permissionError = s4NodeAuthorizationError(spec, original.canvas, nodeId);
      if (permissionError) { setError(permissionError); return; }
      if (!previewMode && !sessionIdRef.current) {
        setError('计算引擎尚未准备好，请等待或点击重试计算引擎。');
        return;
      }
      if (s4SubmissionCount(original) >= s4SubmissionLimit(spec)) {
        publishRun(applyS4Completion(spec, original));
        return;
      }
      const token = {};
      operationRef.current = token;
      const inputKey = derivationInputKey(original);

      setError(null);
      setAnalyzingId(nodeId);
      handleSelectNode(nodeId);
      setHelperTab('analysis');

      // 先置 pending（原则 6：让用户立刻看到「有反应了」）
      let next = updateNodeResult({ ...original, turnCount: s4SubmissionCount(original) + 1 }, nodeId, 'pending');
      next = { ...next, canvas: { ...next.canvas!, nodes: next.canvas!.nodes.map((item) =>
        item.id === nodeId ? { ...item, data: { ...item.data, verification: undefined } } : item) } };
      next = appendDerivationEvent(
        next,
        makeDerivationEvent('node_submit', { nodeId, latex: node.data.latex ?? '' }),
      );
      publishRun(next);

      try {
        /**
         * 提交分流（前提链架构新增）。
         *
         * - `assumption` 节点 → `analyzeAssumptionStep`：只做「语法 + 与祖先前提
         *   冲突」检查，**不走参考解比对**（假设在标准解里不存在，比等价无意义）
         * - 其余节点 → `analyzeStep`：传 sessionId 走前提链主判据（轮次 I）
         *
         * sessionId 为空时（会话尚未建立 / 引擎未就绪）直接给 warn，不调用分析 ——
         * 参考链回落路径已于轮次 N 删除（前提链是唯一判据）。
         */
        const result = previewMode
          ? await Promise.resolve({ status: 'warn' as const, verification: {
              formula_correct: false, dimension_check: false, verdictSource: 'none' as const,
              feedback: '交互预览：已收到本步提交，未调用计算引擎或进行真实判定。',
            }, metricUpdates: [] })
          : node.type === 'assumption'
            ? await analyzeAssumptionStep({
                spec,
                run: next,
                node,
                sessionId: sessionIdRef.current,
              })
            : await analyzeStep({
                spec,
                run: next,
                node,
                sessionId: sessionIdRef.current,
              });

        if (!isCurrentOperation(token, original, spec.sceneId)) return;
        next = latestRef.current.run;
        if (derivationInputKey(next) !== inputKey) {
          setError('推导内容已变化，本次结果未应用，请重新提交。');
          publishRun(applyS4Completion(spec, updateNodeResult(next, nodeId, 'warn')));
          return;
        }

        // 节点状态 + 验证结果
        next = updateNodeResult(next, nodeId, result.status, result.verification);

        // engine/rule/llm 三类指标分流写入（D7 决策的落点）
        next = updateS4Metrics(spec, next, result.verification, result.metricUpdates);

        // 轮次 N 删除：不再标记「已命中的参考步骤」（达成度功能已整体移除）
        // 事件流
        next = appendDerivationEvent(
          next,
          makeDerivationEvent('node_verify', {
            nodeId,
            result: result.status,
            details: result.verification,
          }),
        );

        // 完成判定（原则 10：判定权在系统）
        const verdict = checkS4Completion(spec, next);
        if (verdict.status !== 'running') {
          next = applyS4Completion(spec, next, { signalReason: verdict.reason });
        }

        publishRun(next);
      } catch (e) {
        if (!isCurrentOperation(token, original, spec.sceneId)) return;
        setError((e as Error)?.message || '分析失败，请重试');
        publishRun(applyS4Completion(spec, updateNodeResult(latestRef.current.run, nodeId, 'warn')));
      } finally {
        if (operationRef.current === token) {
          operationRef.current = null;
          if (mountedRef.current) setAnalyzingId(null);
        }
      }
    },
    [spec, previewMode, canMutate, publishRun, isCurrentOperation],
  );

  /* ================================================================
   * 求助
   * ================================================================ */

  const handleAsk = useCallback(
    async (query: string) => {
      if (!canMutate()) return false;
      const original = latestRef.current.run;
      const currentCanvas = original.canvas;
      const maxHelp = Math.min(currentCanvas?.maxHelp ?? 0, s4HelpLimit(spec));
      if (!isS4HelpAuthorized(spec) || !currentCanvas || currentCanvas.helpUsed >= maxHelp) return false;
      const currentNodeId = currentCanvas.nodes.find(node=>node.id===selectedNodeRef.current)?.id
        ?? currentCanvas.nodes.find(node=>node.id===analyzedNode?.id)?.id ?? null;
      const token = {};
      operationRef.current = token;
      const inputKey = derivationInputKey(original);
      setError(null);
      setAsking(true);
      try {
        if (previewMode) {
          await Promise.resolve();
          if (!isCurrentOperation(token, original, spec.sceneId)) return false;
          if (derivationInputKey(latestRef.current.run) !== inputKey) { setError('推导内容已变化，请重新提问。'); return false; }
          const nextCanvas = applyHelpPenalty({ ...latestRef.current.run.canvas!, maxHelp }, spec);
          const content: HelpResponse = {
            step_number: Math.max(1, canvas.nodes.filter((node) => node.type === 'formula').length),
            step_content: '先明确当前节点引用了哪些前提，再检查中值定理的区间与可导条件。',
            latex: "f'(x_2)-f'(x_1)=f''(\\xi)(x_2-x_1)",
            reason: query.trim() || '这一步的关键不是直接得到结论，而是先建立导数之差与二阶导数之间的关系。',
            related_knowledge: ['拉格朗日中值定理', '导数的单调性'],
            correction: null,
          };
          let nextRun = updateS4RuleMetrics(spec, { ...latestRef.current.run, canvas: nextCanvas });
          nextRun = appendDerivationEvent(nextRun, makeDerivationEvent('help_request', {
            step: analyzedNode?.data.label || '当前步骤', query, helpLevel: nextCanvas.helpUsed,
          }));
          nextRun = appendDerivationEvent(nextRun, makeDerivationEvent('help_response', {
            step: analyzedNode?.data.label || '当前步骤', content,
            remaining: Math.max(0, nextCanvas.maxHelp - nextCanvas.helpUsed),
            nodeId:currentNodeId,inputKey:s4HelpInputKey(spec,original,currentNodeId),
          }));
          publishRun(applyS4Completion(spec, nextRun));
          return true;
        }
        const result = await requestHelp({
          spec,
          run: original,
          currentNodeId,
          query,
        });
        if (!isCurrentOperation(token, original, spec.sceneId)) return false;
        if (!result.ok) {
          // 非 strict 模式下 TS 不按 ok 收窄判别联合，显式取失败分支
          setError((result as { ok: false; message: string }).message);
          return false;
        }
        if (derivationInputKey(latestRef.current.run) !== inputKey) {
          setError('推导内容已变化，本次求助未应用，请重新提问。');
          return false;
        }
        publishRun(applyS4Completion(spec, updateS4RuleMetrics(spec, { ...latestRef.current.run,
          canvas: { ...latestRef.current.run.canvas!, helpUsed: result.nextRun.canvas!.helpUsed,
            maxHelp: Math.min(latestRef.current.run.canvas!.maxHelp, result.nextRun.canvas!.maxHelp),
            independenceScore: result.nextRun.canvas!.independenceScore },
          derivationEvents: [...(latestRef.current.run.derivationEvents ?? []),
            ...(result.nextRun.derivationEvents ?? []).slice(original.derivationEvents?.length ?? 0)],
        })));
        return true;
      } catch (e) {
        if (!isCurrentOperation(token, original, spec.sceneId)) return false;
        setError((e as Error)?.message || '求助失败，请重试');
        return false;
      } finally {
        if (operationRef.current === token) {
          operationRef.current = null;
          if (mountedRef.current) setAsking(false);
        }
      }
    },
    [spec, analyzedNode, previewMode, canvas, canMutate, publishRun, isCurrentOperation],
  );

  /**
   * 画布节点上的「求助」按钮（阶段八接通）。
   *
   * 行为：切到求助页 + 预填当前步骤上下文 + 聚焦输入框，**不自动发起**。
   * 求助次数是稀缺资源（上限通常只有 2 次），不能让一次误点就扣掉；
   * 由用户补完问题后主动发送。
   */
  const handleRequestHelpFromNode = useCallback(
    (nodeId: string) => {
      if (!canMutate()) return;
      if (!isS4HelpAuthorized(spec)) { setError('本场景未启用数理求助组件'); return; }
      const node = canvas?.nodes.find((n) => n.id === nodeId);
      handleSelectNode(node?.id ?? null);
      const label = node?.data.label || '当前步骤';
      const hasFormula = Boolean(node?.data.latex?.trim());

      prefillSeqRef.current += 1;
      setPrefill({
        text: hasFormula
          ? `我在「${label}」这里不确定，请说明这一步的依据，并指出下一步该怎么做。`
          : `「${label}」应该怎么写？请给出思路提示（不要直接给最终答案）。`,
        seq: prefillSeqRef.current,
      });
      setHelperTab('help');
      if (narrowPanels) setPanel('helper');
    },
    [canvas?.nodes, canMutate, narrowPanels, spec],
  );

  /* ================================================================
   * 插入画布：把求助给的公式变成新节点
   * ================================================================ */

  const handleInsertLatex = useCallback(
    (latex: string, source?: S4HelpSource) => {
      if (!latex.trim() || !canMutate()) return;
      if (!s4AllowedNodeTypes(spec).includes('formula')) {
        setError('本场景未启用公式节点组件，不能插入求助内容。');
        return;
      }
      const current = latestRef.current.run;
      const currentCanvas = current.canvas;
      if (!currentCanvas) return;
      const count = currentCanvas.nodes.filter((n) => n.type === 'formula').length;
      if (source?.inputKey && source.inputKey !== s4HelpInputKey(spec,current,source.nodeId)) {
        setError('该提示对应的任务或支路已变化，请手动新建草稿并确认前提，或重新求助。'); return;
      }
      if (source?.nodeId && !currentCanvas.nodes.some(node=>node.id===source.nodeId)) {
        setError('该提示对应的节点已删除，不能自动连接到其他节点。'); return;
      }
      // Cards without a receipt are inserted unconnected, never silently rebound to a new selection.
      const anchorId = source ? (source.inputKey ? source.nodeId : null)
        : currentCanvas.nodes.find(node=>node.id===selectedNodeRef.current)?.id ?? analyzedNode?.id;
      const anchor = currentCanvas.nodes.find(node => node.id === anchorId);
      const anchorError = anchor && s4NodeAuthorizationError(spec, currentCanvas, anchor.id);
      if (anchorError) { setError(anchorError); return; }
      // Conclusions are terminal. A helper step may reuse their incoming premises, never their output.
      const premiseIds = anchor?.type === 'conclusion'
        ? [...new Set(currentCanvas.edges.filter(edge => edge.target === anchor.id).map(edge => edge.source))]
        : anchor ? [anchor.id] : [];
      if (premiseIds.some(id => {
        const premise = currentCanvas.nodes.find(node => node.id === id);
        return !premise || premise.type === 'conclusion' || s4NodeAuthorizationError(spec,currentCanvas,id);
      })) { setError('无法安全引用当前步骤的上游前提，请先修正连线。'); return; }
      setError(null);
      const position = {x: anchor ? anchor.position.x + 280 : 320, y: anchor ? anchor.position.y : 60};
      // Reserve a normal node-sized slot rather than inserting on top of an existing branch.
      while (currentCanvas.nodes.some(node => Math.abs(node.position.x - position.x) < 280
        && Math.abs(node.position.y - position.y) < 220)) position.y += 220;

      const newNode: DerivationNode = {
        id: `dformula-${crypto.randomUUID()}`,
        type: 'formula',
        position,
        data: {
          label: `推导步骤 ${count + 1}`,
          latex,
          status: 'draft',
          frozen: false,
        },
      };

      let next: SceneRunState = {
        ...current,
        canvas: { ...currentCanvas, nodes: [...currentCanvas.nodes, newNode] },
      };

      // 自动连线：从锚点指向新节点（若锚点存在）
      if (premiseIds.length) {
        next = {
          ...next,
          canvas: {
            ...next.canvas!,
            edges: [
              ...next.canvas!.edges,
              ...premiseIds.map(source => ({
                id: `dedge-${crypto.randomUUID()}`,
                source,
                target: newNode.id,
                type: 'derivation' as const,
              })),
            ],
          },
        };
      }

      next = appendDerivationEvent(
        next,
        makeDerivationEvent('node_create', { nodeId: newNode.id, nodeType: 'formula' }),
      );

      publishRun(next);
      setPanel(null);
    },
    [spec, analyzedNode, canMutate, publishRun],
  );

  const handleRetryGoal = useCallback(async (nodeId: string) => {
    if (!canMutate()) return;
    if (previewMode) {setError('交互预览不调用模型，数学结果已保留。');return;}
    const original=latestRef.current.run;
    if (!canRetryS4Goal(spec,original,nodeId)) return;
    const token={}; operationRef.current=token;
    const inputKey=s4GoalInputKey(spec,original,nodeId);
    setError(null);setGoalCheckingId(nodeId);setHelperTab('analysis');handleSelectNode(nodeId);
    publishRun(appendDerivationEvent(original,makeDerivationEvent('goal_check_request',{nodeId,inputKey})));
    try {
      const result=await requestS4GoalCheck({spec,run:original,nodeId});
      if (!isCurrentOperation(token,original,spec.sceneId)) return;
      const latest=latestRef.current;
      if (s4GoalInputKey(latest.spec,latest.run,nodeId)!==inputKey
        || !pendingS4GoalNodes(latest.spec,latest.run).includes(nodeId)) {
        setError('任务或支路已变化，本次目标检查未应用。');return;
      }
      if (result.ok===false) {setError(result.message);return;}
      const node=latest.run.canvas?.nodes.find(item=>item.id===nodeId);
      if (!node?.data.verification) return;
      const next=updateNodeResult(latest.run,nodeId,node.data.status,{...node.data.verification,goalAssessment:result.assessment});
      publishRun(applyS4Completion(latest.spec,next));
    } catch {
      if(isCurrentOperation(token,original,spec.sceneId)) setError('目标检查暂不可用，数学结果已保留；可在剩余额度内重试或主动结束。');
    } finally {
      if (operationRef.current===token) {operationRef.current=null;if(mountedRef.current)setGoalCheckingId(null);}
    }
  },[spec,previewMode,canMutate,isCurrentOperation,publishRun,handleSelectNode]);

  /* ================================================================
   * 引擎探活（首次进入时检测一次）
   * ================================================================ */

  /* ================================================================
   * 前提链会话生命周期（轮次 I 接线）
   *
   * 为什么必须显式建会话：服务端符号环境按 sessionId 缓存，
   * 且 `analyzeStep` 靠它决定走「前提链主判据」还是回退旧路径。
   *
   * 按场景、运行身份与符号表重建；初始化成功前不能提交。
   * ================================================================ */
  React.useEffect(() => {
    if (previewMode) { setEngineDown(false); setEngineStarting(false); return undefined; }
    let cancelled = false;
    const sid = `s4-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    sessionIdRef.current = '';
    setEngineStarting(true); setEngineDown(false);
    const close = () => { void sessionClose(sid).catch(() => {}); };
    void (async () => {
      try {
        // Creating the session is the demand that starts the local engine. A
        // read-only status probe can legitimately report idle before first use.
        const result = await sessionInit(sid, buildSessionSymbols(spec));
        if (cancelled) { close(); return; }
        if (!result.ok) throw new Error((result as { error: string }).error);
        sessionIdRef.current = sid;
        setEngineDown(false);
      } catch (failure) {
        close();
        if (!cancelled) { setEngineDown(true); setError((failure as Error)?.message || '计算会话初始化失败'); }
      } finally {
        if (!cancelled) setEngineStarting(false);
      }
    })();
    return () => {
      cancelled = true; close();
      if (sessionIdRef.current === sid) sessionIdRef.current = '';
    };
    // Stable primitive keys avoid rebuilding on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.sceneId, run.runId, JSON.stringify(buildSessionSymbols(spec)), previewMode, engineRetry]);

  /* ================================================================
   * 渲染
   * ================================================================ */

  if (!canvas) {
    return (
      <div className="scene-s4-view">
        <div className="scene-s4-analysis-empty">
          <CircleAlert className="w-4 h-4 mx-auto mb-2" />
          本场景未初始化推导画布，请返回重新创建。
        </div>
      </div>
    );
  }

  const isEnded = run.status !== 'running';
  const operationBusy = busy || Boolean(analyzingId) || asking || Boolean(goalCheckingId) || exporting !== null;

  /* 任务信息栏内容（原则 7：让用户随时能回答「我在做什么」） */
  const knowledgePoints = spec.meta.knowledgePoints ?? [];
  const boundaries = spec.compute?.boundary_conditions ?? [];
  const hasDetail = knowledgePoints.length > 0 || boundaries.length > 0;

  return (
    <div className="scene-s4-shell">
    <div className="scene-s4-view">
      {narrowPanels && panel && <button type="button" className="scene-s4-panel-backdrop" tabIndex={-1}
        aria-label="关闭侧栏，返回画布" onClick={() => setPanel(null)} />}
      {/* 顶部任务栏：不再展示旧的 expected steps 进度。 */}
      <header className="scene-s4-head-area">
      <div className="scene-s4-view-head">
        <div className="scene-s4-heading">
          <span className="scene-s4-kicker">S4 · 数理推导</span>
          <div className="scene-s4-heading-line">
            <Calculator className="w-4 h-4" />
            <span className="scene-s4-view-title">{spec.meta.name}</span>
          </div>
          <span className="scene-s4-view-sub">{spec.meta.goal || spec.task}</span>
          <span className="scene-s4-view-sub" aria-live="polite">节点验证提交 {s4SubmissionCount(run)} / {s4SubmissionLimit(spec)} 次</span>
        </div>

        {(engineDown || engineStarting) && (
          <span className="scene-s4-engine-warn" role="status">
            <CircleAlert className="w-3.5 h-3.5" />
            {engineStarting ? '正在准备计算引擎' : '计算引擎未就绪'}
            {engineDown && <button type="button" className="scene-s4-btn-ghost" disabled={operationBusy}
              onClick={() => { setError(null); setEngineRetry(value => value + 1); }}>重试计算引擎</button>}
          </span>
        )}

        {hasPrevRun && isEnded && (
          <button type="button" className="scene-s4-btn-ghost" disabled={operationBusy} onClick={() => { if (!operationRef.current) onRerun(); }}>
            <RotateCcw className="w-3.5 h-3.5" />
            重跑
          </button>
        )}

        <div className="scene-s4-panel-controls">
          <button type="button" className="scene-s4-btn-ghost" aria-expanded={panel === 'brief'} onClick={() => setPanel('brief')}><PanelLeftOpen />题目与已知</button>
          <button type="button" className="scene-s4-btn-ghost" aria-expanded={panel === 'helper'} onClick={() => setPanel('helper')}><PanelRightOpen />分析与求助</button>
        </div>

        {/* 导出组（原则 14「案例可沉淀」：让本次运行可留档） */}
        <div className="scene-s4-export-group">
          <button
            type="button"
            className="scene-s4-btn-ghost"
            title="导出画布为图片"
            onClick={() => void handleExport('png')}
            disabled={operationBusy}
          >
            <Image className="w-3.5 h-3.5" />
            PNG
          </button>
          <button
            type="button"
            className="scene-s4-btn-ghost"
            title="导出为 PDF"
            onClick={() => void handleExport('pdf')}
            disabled={operationBusy}
          >
            <FileText className="w-3.5 h-3.5" />
            PDF
          </button>
          <button
            type="button"
            className="scene-s4-btn-ghost"
            title="导出推导过程为 LaTeX 源文件"
            onClick={() => void handleExport('tex')}
            disabled={operationBusy}
          >
            <Code className="w-3.5 h-3.5" />
            LaTeX
          </button>
          {exporting && <Loader2 className="w-3 h-3 animate-spin" />}
        </div>

        <button
          type="button"
          className="scene-s4-btn-primary"
          onClick={() => { if (!operationRef.current && !latestRef.current.busy) { if (isEnded) onExit?.(); else onEnd(); } }}
          disabled={operationBusy || (isEnded && !onExit)}
        >
          <Flag className="w-3.5 h-3.5" />
          {isEnded ? '退出场景' : '结束'}
        </button>
      </div>
      {/* 结束横幅属于标题区，不占用画布的隐式网格行。 */}
      {isEnded && (
        <div className={`scene-s4-endbar is-${run.status}`}>
          {run.status === 'success' ? '推导完成' : '推导结束'}
          {run.endReason ? ` · ${run.endReason}` : ''}
          {typeof run.finalScore === 'number' && ` · 得分 ${run.finalScore}`}
        </div>
      )}
      </header>

      {/* 主体：画布 + 侧栏 */}
      <div className="scene-s4-view-body">
        <aside ref={briefRef} className={`scene-s4-brief ${panel === 'brief' ? 'is-open' : ''}`}
          role={narrowPanels && panel === 'brief' ? 'dialog' : undefined} aria-modal={narrowPanels && panel === 'brief' || undefined} aria-label="题目与已知">
          <div className="scene-s4-brief-head">
            <span>题目与已知</span>
            <BookOpen className="w-3.5 h-3.5" />
            <button type="button" className="scene-s4-panel-close" aria-label="关闭题目，返回画布" onClick={() => setPanel(null)}><X /></button>
          </div>

          <section className="scene-s4-brief-card is-task">
            <span className="scene-s4-brief-label">题目</span>
            <SceneRichMessage content={spec.task || '（未描述任务）'} externalLinksDisabled />
          </section>

          <section className="scene-s4-brief-card">
            <span className="scene-s4-brief-label">已知条件</span>
            <ol className="scene-s4-given-list">
              {(spec.compute?.given ?? []).map((given, index) => (
                <li key={`${given.name}-${index}`}>
                  <span>{index + 1}</span>
                  <div>
                    <MathField
                      value={given.entries?.length
                        ? given.entries.map((entry) => entry.display).join(' \\\\ ')
                        : given.display || given.name}
                      editing={false}
                      readOnly
                      placeholder=""
                    />
                    {given.note && <small>{given.note}</small>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="scene-s4-brief-card is-target">
            <span className="scene-s4-brief-label">目标</span>
            <SceneRichMessage content={spec.meta.goal || spec.compute?.operation || '完成数理推导'} externalLinksDisabled />
          </section>

          {hasDetail && (
            <section className="scene-s4-brief-card is-knowledge">
              <span className="scene-s4-brief-label">相关知识</span>
              <div className="scene-s4-brief-links">
                {knowledgePoints.map((item) => <span key={item}><BookOpen className="w-3 h-3" />{item}</span>)}
                {boundaries.map((item) => <span key={item} className="is-bound"><Braces className="w-3 h-3" />{item}</span>)}
              </div>
            </section>
          )}
        </aside>

        <div className="scene-s4-canvas-wrap" ref={exportRef}>
          <DerivationCanvas
            canvasState={canvas}
            allowedNodeTypes={s4AllowedNodeTypes(spec)}
            onChange={handleCanvasChange}
            onSubmitNode={(id) => void handleSubmitNode(id)}
            onRequestHelp={handleRequestHelpFromNode}
            readOnly={operationBusy || isEnded || Boolean(narrowPanels && panel)}
              onSelectNode={handleSelectNode}
          />
          {analyzingId && (
            <div className="scene-s4-canvas-busy" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在验证…
            </div>
          )}
        </div>

        <aside ref={helperRef} className={`scene-s4-side${panel === 'helper' ? ' is-open' : ''}`}
          role={narrowPanels && panel === 'helper' ? 'dialog' : undefined} aria-modal={narrowPanels && panel === 'helper' || undefined} aria-label="分析与求助"
          style={isEnded ? { display: 'block', overflowY: 'auto', overscrollBehavior: 'contain' } : undefined}>
          <button type="button" className="scene-s4-panel-close" aria-label="关闭助手，返回画布" onClick={() => setPanel(null)}><X /></button>
          {/* 终态优先展示收尾操作；结果栏整体滚动，避免固定高度挤掉完成按钮。 */}
          {isEnded && (
            <div className="scene-s4-side-extra is-results" style={{ maxHeight: 'none', overflowY: 'visible' }}>
              {completionContent != null && (
                <section className="learning-completion-slot" aria-label="本次训练对应任务">
                  {completionContent}
                </section>
              )}
              <StandardSolutionView key={run.runId} spec={spec} run={run} onRequestUnlock={() => {
                if (!mountedRef.current || operationRef.current || latestRef.current.busy) return;
                const current = latestRef.current;
                if (current.run.runId !== run.runId || current.spec.sceneId !== spec.sceneId) return;
                const next = unlockS4ReferenceAnswer(current.spec, current.run);
                if (next !== current.run) publishRun(next);
              }} />
              <CurvePanel spec={spec} run={run} isEnded height={160} />
            </div>
          )}
          <div className="scene-s4-side-helper">
            {!helpAuthorized && <p className="scene-preview-text" role="status">本场景未启用数理求助组件，仍可提交步骤并查看分析。</p>}
            <HelperPanel
              key={run.runId}
              analyzedNode={analyzedNode}
              analyzing={analyzingId !== null}
              goalChecking={goalCheckingId === analyzedNode?.id}
              onRetryGoal={handleRetryGoal}
              goalRetryAvailable={Boolean(analyzedNode && !previewMode && canRetryS4Goal(spec,run,analyzedNode.id))}
              goalRetryDisabled={isEnded || operationBusy}
              goalRetryNotice={analyzedNode && pendingS4GoalNodes(spec,run).includes(analyzedNode.id)
                ? `仅重试目标检查，不消耗节点提交或求助次数；每条支路最多 ${S4_GOAL_RETRY_LIMIT} 次，已使用 ${s4GoalRetryCount(spec,run,analyzedNode.id)} 次。用尽后可主动结束或重跑。` : undefined}
              helpHistory={helpHistory}
              remaining={remaining}
              maxHelp={helpLimit}
              penaltyPerHelp={s4HelpPenalty(spec)}
              asking={asking}
              error={error}
              onAsk={handleAsk}
              disabled={!helpAuthorized || isEnded || operationBusy}
              onInsert={handleInsertLatex}
              tab={helperTab}
              onTabChange={setHelperTab}
              prefill={prefill}
            />
          </div>

          <section className="scene-s4-node-inspector">
            <div className="scene-s4-node-inspector-head"><Info className="w-3.5 h-3.5" />节点属性</div>
            {selectedNode ? (
              <div className="scene-s4-node-inspector-grid">
                <span>类型</span><strong>{{given: '已知条件', formula: '公式', assumption: '假设', conclusion: '结论'}[selectedNode.type]}</strong>
                <span>名称</span><strong title={selectedNode.data.label}>{selectedNode.data.label}</strong>
                <span>状态</span><strong>{DERIVATION_STATUS_LABEL[selectedNode.data.status]}</strong>
                <span>位置</span><strong>({Math.round(selectedNode.position.x)}, {Math.round(selectedNode.position.y)})</strong>
                <span>关联</span><strong><GitBranch className="w-3 h-3" />{selectedIncoming} 入 / {selectedOutgoing} 出</strong>
              </div>
            ) : <p className="scene-s4-node-inspector-empty">选中画布节点后查看属性</p>}
          </section>

          <div className="scene-s4-side-metrics">
            <SceneMetricPanel specs={spec.metrics} values={run.metrics} compact />
          </div>
        </aside>
      </div>
    </div>
    </div>
  );
};

/**
 * 对外入口（唯一）。
 *
 * 包裹层次说明：
 * - ReactFlowProvider 必须在 DerivationCanvas 之上：其内部 useReactFlow() 依赖该上下文
 * - SceneErrorBoundary 必须在最外层：这样即使 Provider 或画布后续再出问题，
 *   也只降级为「画布区域显示错误提示」，而不是整个应用白屏
 *
 * 之所以放在这里而不是调用方（SceneMode），是为了让组件自包含：
 * 任何新入口（如反事实并排对比）复用它都不会再漏掉 Provider。
 */
export const SceneDerivationView: React.FC<SceneDerivationViewProps> = (props) => (
  <SceneErrorBoundary>
    <ReactFlowProvider>
      <SceneDerivationViewInner {...props} />
    </ReactFlowProvider>
  </SceneErrorBoundary>
);

export default SceneDerivationView;
