/**
 * S4 推导画布 —— 可删除的连线（推导 / 依赖 / 分支 / 对比）
 *
 * 背景（阶段七缺陷修复）：
 * 旧实现里连线建错了**完全无法删除**（除了删掉两端节点）：
 * `handleSelectionChange` 丢弃了 `params.edges`，Delete 键只处理节点，
 * 且画布设置了 `deleteKeyCode={null}` 关掉了 React Flow 内置删除。
 *
 * 本组件在默认连线的基础上：
 * 1. 保留原有 `smoothstep` 路径与标签
 * 2. 在标签旁叠加一个「×」按钮 —— 不依赖键盘的删除入口（触屏也可用）
 * 3. 选中态由 React Flow 的 `.selected` 类承担，样式在 CSS 中统一处理
 *
 * 注意：React Flow 的边容器默认 `pointer-events: none`，
 * 所以可交互元素必须显式 `pointer-events: all`（见样式 `dc-edge-label`）。
 */

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import type { DerivationFlowEdge } from '../nodeVisuals';
import { useNodeActions } from './NodeActionsContext';

export function EdgeWithDeleteButton({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  labelStyle,
  data,
}: EdgeProps<DerivationFlowEdge>) {
  const actions = useNodeActions();

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const highlighted = Boolean(data?.highlighted);

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className={`dc-edge-label nodrag nopan${highlighted ? ' is-highlighted' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            color: (labelStyle?.fill as string) ?? '#5b6b60',
          }}
        >
          {label ? <span className="dc-edge-label-text">{label}</span> : null}
          {!actions.readOnly && (
            <button
              type="button"
              className="dc-edge-del"
              title="删除这条连线"
              aria-label="删除连线"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                actions.onDeleteEdge(id);
              }}
            >
              <X size={10} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}