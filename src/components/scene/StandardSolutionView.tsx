/**
 * S4 标准解法视图（对应实施计划 F20，轮次 N 重构解锁口径）。
 *
 * ## 职责
 * 把 `spec.compute.expected_steps`（参考解步骤表）与 `expected_formula`（目标结果）
 * 在**用户主动结束本次推导后**呈现，供对照复盘。
 *
 * ## 解锁口径（轮次 N，用户明确定稿）
 *
 * **只认用户主动授权**，不认「系统自动判定完成」：
 * - 运行中：整块**不可展开**（按钮 disabled），连「命中几步」都不显示 ——
 *   不给任何关于答案的线索（用户原话：右侧参考步骤是折叠的不可展开，不能看）。
 * - 用户点「结束」后（`run.endedByUser === true`）：解锁完整内容，可自由展开/收起。
 * - 系统自动判定完成时**不解锁** —— 那往往发生在用户还在继续推导时，
 *   此时放出答案会打断思考。
 * - 自动结束后可主动点击「查看参考解」单独授权；不改写结束来源、时间或得分。
 *
 * 为什么不能只看 `status !== 'running'`：该条件无法区分两种结束来源，
 * 自动完成时也会为真，会把答案提前放出来。故单列 `endedByUser` 字段。
 *
 * ## 为什么删掉「命中 N/M」与 ✓/○ 达成度
 * 用户明确要求：「前端展示不再判定达成度，也不需要显示命中多少步骤」。
 * 达成度依赖 `matchedStepIndexes`（由参考解比对产出），而该链路已随
 * 「取消参考链判定」一并删除，故相关展示同时移除。
 *
 * ## 与导出的关系
 * 导出是「留档」诉求，产物需要完整可读，故保留 `forceOpen` / `forceUnlock`
 * 两个逃生口，由 `sceneExport` 调用；界面管控不受其影响。
 */

import React, { useState } from 'react';
import katex from 'katex';
import { ChevronDown, ChevronRight, BookOpenCheck, Flag } from 'lucide-react';
import type { SceneRunState, SceneSpec } from '../../types';
import { stepDisplay, stepSymbolic, stepNote } from '../../types/sceneS4';
import { isS4ReferenceUnlocked } from '../../services/scene/sceneS4Policy';

export interface StandardSolutionViewProps {
  spec: SceneSpec;
  run: SceneRunState;
  /** Explicit reference consent after an automatic terminal result. Does not re-end the run. */
  onRequestUnlock?: () => void;
  /** 强制展开（由调用方控制，如导出场景） */
  forceOpen?: boolean;
  /**
   * 强制解锁答案内容（导出场景时使用）。
   *
   * 导出是「留档」诉求，产物需要完整可读；而界面上的解锁由「用户点结束」驱动。
   * 二者分离，避免为了导出而放宽界面管控。
   */
  forceUnlock?: boolean;
}

/**
 * 渲染单条参考解文本。
 * 参考解是「自然语言 + LaTeX」混合串，因此仅当整条被 $...$ / $$...$$ 包裹时才走
 * KaTeX，其余按纯文本展示——避免把普通文字误当公式渲染成红字。
 */
function SolutionStepText({ text }: { text: string }) {
  const trimmed = (text ?? '').trim();
  const match = /^\$\$([\s\S]+)\$\$$/.exec(trimmed) || /^\$([\s\S]+)\$$/.exec(trimmed);

  if (match) {
    let html = '';
    try {
      html = katex.renderToString(match[1], {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });
    } catch {
      html = '';
    }
    if (html) {
      // KaTeX 输出源自本地渲染结果，非用户输入直出
      return <span className="scene-s4-solution-math" dangerouslySetInnerHTML={{ __html: html }} />;
    }
  }

  return <span>{trimmed}</span>;
}

export const StandardSolutionView: React.FC<StandardSolutionViewProps> = ({
  spec,
  run,
  forceOpen,
  forceUnlock,
  onRequestUnlock,
}) => {
  const compute = spec.compute;
  const steps = compute?.expected_steps ?? [];
  const expectedCount = compute?.expected_steps_count ?? steps.length;

  /**
   * 是否已解锁答案内容。
   *
   * 用户主动结束或终态主动查看才解锁；自动结束本身不构成授权。
   */
  const unlocked = isS4ReferenceUnlocked(run) || Boolean(forceUnlock);
  const canRequestUnlock = run.status !== 'running' && Boolean(onRequestUnlock);

  /** 未授权时不展示内容；终态按钮可请求独立授权，随后由用户自由展开/收起。 */
  const [open, setOpen] = useState<boolean>(Boolean(forceOpen));
  const expanded = unlocked && (Boolean(forceOpen) || open);

  // 单式模式也需要解锁目标公式；仅在步骤和目标都不存在时省略。
  if (!compute || (steps.length === 0 && !compute.expected_formula)) return null;

  return (
    <div className="scene-s4-solution">
      <button
        type="button"
        className="scene-s4-solution-head"
        disabled={!unlocked && !canRequestUnlock}
        aria-disabled={!unlocked && !canRequestUnlock}
        aria-expanded={expanded}
        onClick={() => {
          // Running scenes remain locked even if a caller invokes the handler directly.
          if (!unlocked) {
            if (canRequestUnlock) { onRequestUnlock?.(); setOpen(true); }
            return;
          }
          setOpen((v) => !v);
        }}
        title={unlocked ? undefined : canRequestUnlock ? '本次推导已结束，点击主动查看参考解' : '本次推导结束后可查看参考答案'}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <BookOpenCheck className="w-3.5 h-3.5" />
        <span className="scene-s4-solution-title">{!unlocked && canRequestUnlock ? '查看参考解' : '标准解法'}</span>
        {/* 未解锁时不再显示任何进度/命中信息，仅给一行极简提示 */}
        {!unlocked && <span className="scene-s4-solution-locked-hint-inline">{canRequestUnlock ? '主动查看后解锁' : '结束后可查看'}</span>}
      </button>

      {expanded && (
        <div className="scene-s4-solution-body">
          <ol className="scene-s4-solution-list">
            {steps.map((s, i) => (
              <li key={i} className="scene-s4-solution-item">
                <span className="scene-s4-solution-index">{i + 1}</span>
                <div className="scene-s4-solution-text">
                  {/* 两分层展示（轮次 B）：display 给人看，note 说做什么 */}
                  <SolutionStepText text={stepDisplay(s)} />
                  {stepNote(s) && (
                    <span className="scene-s4-solution-note">{stepNote(s)}</span>
                  )}
                  {/* symbolic 缺失 = 该步不参与自动判定，须明示避免误以为漏判 */}
                  {!stepSymbolic(s) && (
                    <span
                      className="scene-s4-solution-displayonly"
                      title="该步仅在参考解中展示，不参与自动判定"
                    >
                      仅展示
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {/* 最终锚点：目标结果 */}
          <div className="scene-s4-solution-target">
            <span className="scene-s4-solution-target-label">
              <Flag className="w-3 h-3" />
              目标结果
            </span>
            <code className="scene-s4-solution-target-formula">{compute.expected_formula}</code>
          </div>

          <p className="scene-s4-solution-meta">
            预期 {expectedCount} 步
            {compute.operation ? ` · 操作类型 ${compute.operation}` : ''}
          </p>
        </div>
      )}
    </div>
  );
};

export default StandardSolutionView;
