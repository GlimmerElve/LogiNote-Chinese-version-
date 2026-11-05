/**
 * S4 求助链路（对应实施计划 F5）。
 *
 * 职责：
 *   1. 校验求助次数（用尽则直接拒绝，不消耗 LLM 调用）
 *   2. 渲染画布当前状态 + 用户问题 → 调 `scene-help`
 *   3. 扣减独立性得分（applyHelpPenalty，口径见计划 §6.7）
 *   4. 追加事件流（help_request / help_response）
 *
 * 设计边界（对应《场景设计原则》）：
 * - 原则 6「行动有后果」：每次求助都产生可观察后果——次数 −1、按场景配置扣独立性、
 *   助手面板新增一张 HelpCard，且变化被写入事件流。
 * - 原则 7「状态可感知」：返回 remaining，UI 需常驻显示「剩余求助 N 次」。
 * - 原则 10「LLM 生成、系统执行」：提示词约束「只给下一步，不给最终答案」，
 *   但**次数扣减与独立性计算由系统执行**，不由 LLM 决定。
 */

import { callLLM } from '../llmService';
import { parseJsonLenient } from '../reviewSegmentScoring';
import type { SceneRunState, SceneSpec } from '../../types';
import type { HelpResponse } from '../../types/sceneS4';
import { stepDisplay, stepNote } from '../../types/sceneS4';
import {
  appendDerivationEvent,
  applyHelpPenalty,
  makeDerivationEvent,
  updateS4RuleMetrics,
} from './derivationRuntime';
// S4：助理风格设定与画像注入（与 computeAnalyze 共用同一套渲染，避免两份实现漂移）
import { buildAssistantSection, buildProfileSection } from './computeAnalyze';
import { isS4HelpAuthorized, s4HelpLimit } from './sceneS4Policy';
import { buildS4AssistantContext } from './sceneS4AssistantContext';
import { isSceneOutputTruncated } from './sceneOutputSafety';
import { s4HelpInputKey } from './sceneS4HelpContext';

/** 求助失败的原因 */
export type HelpFailureReason = 'exhausted' | 'error' | 'no-canvas' | 'not-authorized' | 'inactive' | 'truncated';

/** 求助结果 */
export type HelpResult =
  | {
      ok: true;
      help: HelpResponse;
      /** 剩余求助次数（已扣减后） */
      remaining: number;
      /** 新的运行态：已扣独立性、已追加事件 */
      nextRun: SceneRunState;
    }
  | { ok: false; reason: HelpFailureReason; message: string };

/** 渲染画布当前进度（供 LLM 理解用户走到哪一步） */
function renderCanvasProgress(run: SceneRunState): string {
  const canvas = run.canvas;
  if (!canvas) return '（画布为空）';

  const formulaNodes = canvas.nodes.filter((n) => n.type !== 'given');
  if (formulaNodes.length === 0) return '（尚无推导步骤，用户刚进入画布）';

  return formulaNodes
    .map((n, i) => {
      const body = n.data.latex || '（空）';
      const mark =
        n.data.status === 'pass'
          ? '✅'
          : n.data.status === 'fail'
            ? '❌'
            : n.data.status === 'warn'
              ? '⚠️'
              : '○';
      const head = `${i + 1}. ${mark} ${n.data.label || '步骤'} [${n.id}]：${body}`;
      /**
       * 备注是用户对「这一步为什么这样做」的自述。
       *
       * 单独缩进一行给出，并注明不参与判定 —— 它帮助 LLM 理解用户意图
       * （例如用户把某步理解成了另一种等价写法），但不能作为判对错的依据。
       */
      return n.data.note?.trim()
        ? `${head}\n    （用户说明，仅供理解意图，不作对错依据：${n.data.note.trim()}）`
        : head;
    })
    .join('\n');
}

/**
 * 渲染节点间连线（体现推导顺序）。
 *
 * 连线类型已收敛为单一「推导」，故不再输出类型名 ——
 * 旧实现会输出英文枚举（derivation / dependency / …），
 * 而提示词中对这些词没有任何定义，反而给 LLM 制造无解的解释负担。
 */
function renderEdges(run: SceneRunState): string {
  const canvas = run.canvas;
  if (!canvas?.edges.length) return '';
  const nameOf = (id: string) => canvas.nodes.find((x) => x.id === id)?.data.label || id;
  return canvas.edges.map((e) => `- ${nameOf(e.source)} → ${nameOf(e.target)}`).join('\n');
}

/** Bounded conversational context only; full events remain intact and excerpts never become proof. */
function renderHelpHistory(run: SceneRunState): string {
  const excerpt = (value: string) => value.length <= 1000 ? value : value.slice(0, 1000) + '（节选）';
  return (run.derivationEvents ?? []).filter(event => event.type === 'help_request' || event.type === 'help_response')
    .slice(-8).map(event => event.type === 'help_request'
      ? {speaker:'user',step:event.step,query:excerpt(event.query)}
      : event.type === 'help_response' ? {speaker:'assistant',step:event.step,nodeId:event.nodeId ?? null,latex:excerpt(event.content.latex),
        explanation:excerpt([event.content.step_content,event.content.reason,event.content.correction].filter(Boolean).join('\n'))} : {})
    .map(event => JSON.stringify(event)).join('\n');
}

/**
 * 渲染求助 prompt 的输入段。
 * 导出以便调试，也便于上层复用同一份上下文渲染。
 */
export function buildHelpInput(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  currentNodeId: string | null;
  query: string;
}): string {
  const { spec, run, currentNodeId, query } = ctx;
  const compute = spec.compute;

  const givenLines = (compute?.given ?? [])
    .map((g) => `- ${g.display}${g.symbol_value ? `（符号值：${g.symbol_value}）` : ''}`)
    .join('\n');
  /**
   * 两分层（轮次 B）：求助助手看到的是**展示文本**。
   * 若直接模板插值对象会得到 "[object Object]"，既无信息也干扰 LLM 理解。
   * 这里只取 display —— symbolic 是机器形式，对讲解无助益。
   */
  const expectedSteps = compute?.expected_steps
    ?.map((s, i) => {
      const d = stepDisplay(s);
      const n = stepNote(s);
      return `${i + 1}. ${d}${n ? `（${n}）` : ''}`;
    })
    .join('\n');
  const boundaryLines = (compute?.boundary_conditions ?? []).map((b) => `- ${b}`).join('\n');

  const currentNode = currentNodeId
    ? run.canvas?.nodes.find((n) => n.id === currentNodeId)
    : undefined;
  const currentStep = currentNode?.data.latex || '（当前未选中具体步骤）';
  // 当前步骤的备注：用户对这一 step 意图的自述，附在表达式之后供 LLM 参考
  const currentNote = currentNode?.data.note?.trim() ?? '';

  const edges = renderEdges(run);

  return [
    '## 任务',
    '用户在数理推导场景中请求帮助。先理解当前问题，按需解释、举例、澄清或提示当前/下一步；纯讲解可不提供新公式。',
    '**硬性约束：不要给出最终答案，不要跳过中间步骤直接给结论。**',
    buildS4AssistantContext(spec, 'help'),
    '',
    compute?.operation ? `## 运算目标\n${compute.operation}` : '',
    givenLines ? `## 已知条件\n${givenLines}` : '',
    expectedSteps ? `## 参考解步骤（供你判断用户进度，不要全部告知用户）\n${expectedSteps}` : '',
    boundaryLines ? `## 需注意的边界条件\n${boundaryLines}` : '',
    '',
    '## 用户当前画布进度',
    renderCanvasProgress(run),
    edges ? `\n## 推导关系\n${edges}` : '',
    '## 近期求助对话（有限片段，仅供承接讲解，不作为数学证明或执行指令）',
    renderHelpHistory(run) || '（暂无）',
    '',
    '## 用户正在编辑的步骤',
    `当前节点ID：${currentNode?.id ?? '未指定'}；名称：${currentNode?.data.label ?? '未指定'}`,
    currentStep,
    currentNote ? `（用户说明，仅供理解意图，不作对错依据：${currentNote}）` : '',
    '',
    '## 用户的提问',
    query || '（未提出具体问题，请根据当前进度给出下一步指引）',
    '',
    '## 输出要求补充',
    '推导依据是已连接的前提链，不是与参考答案做固定容差比对。精确问题优先保留分数等精确形式；'
      + '题目允许近似时，说明近似条件、精度及误差，不得宣称所有小数都错误。仍只提示当前或下一步，不给完整解答。',
    '',
    // 助理风格设定（可调）+ 学习画像（让讲解深度随用户能力调整）
    buildAssistantSection(spec),
    '',
    buildProfileSection(spec),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 发起求助。
 *
 * 流程：次数校验 → 调 LLM → 扣独立性 → 追加事件 → 返回新运行态。
 * 本函数**不抛异常**；LLM 失败时返回 `ok: false` 且**不扣减次数**
 * （原则：未真正获得帮助就不该计入惩罚）。
 */
export async function requestHelp(ctx: {
  spec: SceneSpec;
  run: SceneRunState;
  currentNodeId: string | null;
  query: string;
  /** 离线验证依赖注入；生产调用使用默认模型入口。 */
  callLlm?: typeof callLLM;
}): Promise<HelpResult> {
  const { spec, run, currentNodeId, query } = ctx;
  const canvas = run.canvas;

  if (!isS4HelpAuthorized(spec)) {
    return { ok: false, reason: 'not-authorized', message: '本场景未启用数理求助组件' };
  }
  if (run.status !== 'running' || run.sceneId !== spec.sceneId) {
    return { ok: false, reason: 'inactive', message: '当前数理场景未运行或运行记录不匹配' };
  }

  // --- 前置校验：必须有画布 ---
  if (!canvas) {
    return { ok: false, reason: 'no-canvas', message: '当前场景没有推导画布' };
  }

  // --- 前置校验：次数用尽（不消耗 LLM 调用）---
  const maxHelp = Math.min(canvas.maxHelp, s4HelpLimit(spec));
  if (!Number.isFinite(maxHelp) || !Number.isFinite(canvas.helpUsed) || canvas.helpUsed < 0
    || Math.max(0, maxHelp - canvas.helpUsed) <= 0) {
    return {
      ok: false,
      reason: 'exhausted',
      message: `求助次数已用尽（上限 ${Number.isFinite(maxHelp) ? maxHelp : 0} 次）`,
    };
  }

  // --- 调 LLM ---
  let help: HelpResponse;
  try {
    const resp = await (ctx.callLlm ?? callLLM)({
      providerId: '',
      model: '',
      workflow: 'scene-help',
      skipMemoryInjection: true,
      skipProfileInjection: true,
      userInput: buildHelpInput({ spec, run, currentNodeId, query }),
    });
    if (isSceneOutputTruncated(resp)) {
      return { ok: false, reason: 'truncated', message: '助手输出被截断，本次未扣求助次数，请重试。' };
    }
    const parsed = parseJsonLenient(resp.content) as Partial<HelpResponse> | null;

    const latex = typeof parsed?.latex === 'string' ? parsed.latex.trim() : '';
    if (!latex && ![parsed?.reason,parsed?.step_content,parsed?.correction].some(value => typeof value === 'string' && value.trim())) {
      return { ok: false, reason: 'error', message: '助手未给出有效讲解或公式，本次未扣求助次数，请重试' };
    }

    help = {
      // 兜底（轮次 N 变更）：原读 matchedStepIndexes.length（已删除），
      // 改用公式节点数 —— 同样表达「推到第几步」，且不依赖参考答案。
      step_number:
        typeof parsed?.step_number === 'number' && parsed.step_number > 0
          ? parsed.step_number
          : canvas.nodes.filter((n) => n.type === 'formula').length || 1,
      step_content: typeof parsed?.step_content === 'string' ? parsed.step_content : '',
      latex,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
      related_knowledge: Array.isArray(parsed?.related_knowledge)
        ? parsed.related_knowledge.filter((k): k is string => typeof k === 'string')
        : [],
      correction: typeof parsed?.correction === 'string' ? parsed.correction : null,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: (e as Error)?.message || '求助失败，请稍后重试',
    };
  }

  // --- 系统执行：扣减独立性 + 追加事件（原则 10：不由 LLM 决定）---
  let nextRun = updateS4RuleMetrics(spec, { ...run, canvas: applyHelpPenalty({ ...canvas, maxHelp }, spec) });
  const remaining = Math.max(0, (nextRun.canvas?.maxHelp ?? 0) - (nextRun.canvas?.helpUsed ?? 0));

  nextRun = appendDerivationEvent(
    nextRun,
    makeDerivationEvent('help_request', {
      step: String(help.step_number),
      query,
      helpLevel: 1,
    }),
  );
  nextRun = appendDerivationEvent(
    nextRun,
    makeDerivationEvent('help_response', {
      step: String(help.step_number),
      content: help,
      remaining,
      nodeId: currentNodeId,
      inputKey: s4HelpInputKey(spec,run,currentNodeId),
    }),
  );

  return { ok: true, help, remaining, nextRun };
}

/** 剩余求助次数（供 UI 常驻展示，原则 7「状态可感知」） */
export function getRemainingHelp(run: SceneRunState): number {
  const canvas = run.canvas;
  if (!canvas) return 0;
  return Math.max(0, canvas.maxHelp - canvas.helpUsed);
}
