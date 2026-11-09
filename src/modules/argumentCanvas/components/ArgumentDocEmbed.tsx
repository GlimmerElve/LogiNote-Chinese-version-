/**
 * 正文内嵌的「只读可缩放」论证结构图缩略图。
 *
 * - 从 ArgDoc 生成 flow 节点/边，复用节点坐标与连线关系。
 * - 只读：节点不可拖拽/连线/选中，滚轮缩放、拖拽平移。
 * - 节点用轻量渲染，所有表面、文字与连线颜色跟随 LogiNote 主题令牌。
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
import { ARGUMENT_ROLE_LABELS, getNodeLayer, LAYER_LABEL } from '../../../services/argumentDoc/types';
import { renderTextWithMath } from '../utils/formula';

type ReadonlyNodeData = { argNode: ArgNode };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ReadonlyArgNode = memo(function ReadonlyArgNode({ data }: any) {
  const node = data.argNode as ArgNode;
  const layer = getNodeLayer(node.mainType, node.role);
  return (
    <div
      className="argument-doc-embed-node"
      data-layer={layer}
      data-status={node.status}
    >
      {/* 隐形 Handle：供 React Flow 定位边的锚点，视觉不可见、不可交互 */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div className="argument-doc-embed-node-header">
        <div className="argument-doc-embed-node-heading">
          <span>{node.role ? ARGUMENT_ROLE_LABELS[node.role] : node.mainType}</span>
          {node.subTypes && (
            <small>{node.subTypes}</small>
          )}
        </div>
        <span className="argument-doc-embed-layer">
          {LAYER_LABEL[layer]}
        </span>
      </div>
      <div
        className="argument-doc-embed-node-text"
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
        const color = oppose ? 'var(--ln-danger)' : e.relation === 'support' ? 'var(--ln-accent)'
          : e.relation === 'method_for' ? 'var(--ln-warning)' : e.relation === 'context' ? 'var(--ln-text-muted)' : 'var(--ln-accent-muted)';
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'default',
          markerEnd: { type: MarkerType.ArrowClosed, color },
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: e.relation === 'support' ? undefined : oppose ? '6 3' : '4 4',
          },
        };
      }),
    [doc.edges],
  );

  return (
    <div className="argument-canvas-scope argument-doc-embed">
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
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--ln-border-subtle)" />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
