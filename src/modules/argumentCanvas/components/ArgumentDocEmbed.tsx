/**
 * 正文内嵌的「只读可缩放」论证结构图缩略图。
 *
 * - 从 ArgDoc 生成 flow 节点/边，复用节点坐标与连线关系。
 * - 只读：节点不可拖拽/连线/选中，滚轮缩放、拖拽平移。
 * - 节点用轻量渲染（硬编码配色，不依赖画布 CSS 变量，正文环境可用）。
 */

import { useMemo, memo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlowProvider,
  MarkerType,
  Handle,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ArgDoc, ArgNode } from '../../../services/argumentDoc/types';
import { getNodeLayer, LAYER_LABEL } from '../../../services/argumentDoc/types';
import { renderTextWithMath } from '../utils/formula';

const LAYER_COLOR: Record<string, string> = {
  concept: '#10B981',
  judgment: '#F59E0B',
  logic: '#6366F1',
};

const STATUS_BORDER: Record<string, string> = {
  ok: '#E8E2D6',
  error: '#DC2626',
  warning: '#F59E0B',
  suggested: '#8B5CF6',
  to_delete: '#DC2626',
  edited: '#3B82F6',
  isolated: '#9CA3AF',
};

type ReadonlyNodeData = { argNode: ArgNode };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ReadonlyArgNode = memo(function ReadonlyArgNode({ data }: any) {
  const node = data.argNode as ArgNode;
  const layer = getNodeLayer(node.mainType);
  const border = STATUS_BORDER[node.status] ?? '#E8E2D6';
  return (
    <div
      style={{
        width: 260,
        border: `2px solid ${border}`,
        borderRadius: 10,
        background: '#FFFFFF',
        boxShadow: '0 1px 4px rgba(45,52,54,0.10)',
        overflow: 'hidden',
        fontSize: 12,
        position: 'relative',
      }}
    >
      {/* 隐形 Handle：供 React Flow 定位边的锚点，视觉不可见、不可交互 */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '6px 10px', background: '#FFF8F0', borderBottom: '1px solid #F0EAE0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: '#2D3436', whiteSpace: 'nowrap' }}>{node.mainType}</span>
          {node.subTypes && (
            <span style={{ fontSize: 10, color: '#A9A29A', background: '#FFFFFF', padding: '0 5px', borderRadius: 4, whiteSpace: 'nowrap' }}>{node.subTypes}</span>
          )}
        </div>
        <span style={{ background: LAYER_COLOR[layer], color: '#FFFFFF', fontSize: 9, padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap' }}>
          {LAYER_LABEL[layer]}
        </span>
      </div>
      <div
        style={{ padding: '8px 10px', lineHeight: 1.55, color: '#2D3436', wordBreak: 'break-word', maxHeight: 120, overflow: 'hidden' }}
        dangerouslySetInnerHTML={{ __html: renderTextWithMath(node.text) }}
      />
    </div>
  );
});

const nodeTypes = { readonlyNode: ReadonlyArgNode };

export function ArgumentDocEmbed({ doc }: { doc: ArgDoc }) {
  const nodes = useMemo<Node[]>(
    () =>
      doc.nodes.map((n, i) => ({
        id: n.id,
        type: 'readonlyNode',
        position: n.position ?? { x: 40 + i * 20, y: 40 + i * 20 },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: { argNode: n },
      })),
    [doc.nodes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      doc.edges.map((e) => {
        const oppose = e.relation === 'oppose';
        const color = oppose ? '#EF4444' : '#10B981';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'default',
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: oppose ? '6 3' : undefined,
          },
        };
      }),
    [doc.edges],
  );

  return (
    <div className="argument-canvas-scope" style={{ width: '100%', height: 320, border: '1px solid #E8E2D6', borderRadius: 12, overflow: 'hidden', background: '#FEFBF7' }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.2}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}