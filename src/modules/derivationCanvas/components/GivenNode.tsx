/**
 * S4 推导画布 —— 已知条件节点（只读）
 *
 * 承载《场景设计原则》七要素之「资源嵌入」：
 * 用户需要随时看到题目给定的条件（含单位的人类可读形式）。
 *
 * 只读约束：
 * - 不可编辑、不可删除、不可冻结（由画布自动铺入，非用户创建）
 * - 可作为连线的起点（推导从这里出发）
 */

import type { NodeProps } from '@xyflow/react';
import type { DerivationFlowNode } from '../nodeVisuals';
import { NodeShell } from './NodeShell';
import { MathField } from './MathField';

export function GivenNode({ id, data }: NodeProps<DerivationFlowNode>) {
  const { nodeData, highlighted } = data;

  /**
   * 解构失败降级标记。
   *
   * 为什么单独判断而非直接渲染 unitHint：二者语义完全不同 ——
   * unitHint 是「单位」，降级标记是「此前提不可用」。
   * 混在一起会渲染成「单位：此前提无法被引擎识别」，语义错乱。
   */
  const isUnrecognized = nodeData.unitHint === '此前提无法被引擎识别';
  /** 真正需要展示的单位（排除降级标记） */
  const unit = isUnrecognized ? undefined : nodeData.unitHint;

  return (
    <NodeShell
      nodeId={id}
      nodeType="given"
      label={nodeData.label}
      status={nodeData.status}
      frozen={nodeData.frozen}
      highlighted={highlighted}
      canSubmit={false}
      showHelp={false}
      showDelete={false}
      canConnectTarget={false}
    >
      {/* ① 数学式子：前提包逐条目 / 旧格式 display，均经 latex 渲染 */}
      {nodeData.latex && (
        <MathField value={nodeData.latex} editing={false} readOnly placeholder="" />
      )}

      {/* ② 框外文字解释（前提链架构：与数学式子严格分离） */}
      {nodeData.note && <p className="dc-node-given-text">{nodeData.note}</p>}

      {/* ③ 单位提示（仅在确有单位时展示） */}
      {unit && <p className="dc-node-unithint">单位：{unit}</p>}

      {/* ④ 解构失败降级：必须显式告知，否则用户会连一条永远无效的线 */}
      {isUnrecognized && (
        <p className="dc-node-unithint is-warn">⚠ {nodeData.unitHint}</p>
      )}
    </NodeShell>
  );
}
