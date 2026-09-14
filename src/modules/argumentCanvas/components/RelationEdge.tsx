/**
 * 自定义论证连线（从 argument-editor-standalone 迁移）
 * support 绿实线 / oppose 红虚线。
 */

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type Edge } from '@xyflow/react';
import type { RelationType } from '../../../services/argumentDoc/types';

export type RelationEdgeData = { relation: RelationType; highlighted?: boolean };
export type ArgumentFlowEdge = Edge<RelationEdgeData, 'relationEdge'>;

const RELATION_STYLE: Record<RelationType, { stroke: string; dash: string | undefined; label: string }> = {
  support: { stroke: 'var(--edge-support)', dash: undefined, label: '支撑' },
  oppose: { stroke: 'var(--edge-oppose)', dash: '8 4', label: '反对' },
};

export function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
  style: edgeStyle,
}: EdgeProps<ArgumentFlowEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const relation = data?.relation ?? 'support';
  const highlighted = data?.highlighted ?? false;
  const relStyle = RELATION_STYLE[relation];
  const opacity = typeof edgeStyle?.opacity === 'number' ? edgeStyle.opacity : 1;

  const stroke = highlighted ? 'var(--color-error)' : relStyle.stroke;
  const strokeWidth = highlighted ? 3.5 : selected ? 2.5 : 1.75;
  const strokeDasharray = highlighted ? undefined : relStyle.dash;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth, strokeDasharray, opacity: highlighted ? 1 : opacity }} />
      <EdgeLabelRenderer>
        <div style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all', background: 'var(--color-surface)', padding: '2px 6px', borderRadius: 'var(--radius-xs)', fontSize: 10, border: `1px solid ${highlighted ? 'var(--color-error)' : relStyle.stroke}`, color: highlighted ? 'var(--color-error)' : relStyle.stroke, opacity: highlighted ? 1 : opacity }} className="nodrag nopan">
          {relStyle.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}