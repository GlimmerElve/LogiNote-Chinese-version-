/**
 * S4 推导画布 —— 节点视觉常量与共享类型
 *
 * 集中定义「六态」配色与标签语义，供 4 个节点组件与画布复用。
 * 对齐《场景设计原则》原则 6「行动有后果」与原则 7「状态可感知」：
 * 节点颜色必须让用户一眼看出「这步对不对、卡在哪」。
 */

import type { Node, Edge } from '@xyflow/react';
import type { DerivationNodeData, DerivationEdgeType, DerivationNodeType } from '../../types/sceneS4';

/** React Flow 的节点数据载荷 */
export interface DerivationFlowNodeData extends Record<string, unknown> {
  /** 领域数据（来自 DerivationNode.data） */
  nodeData: DerivationNodeData;
  /** 领域节点类型（given / formula / note / conclusion） */
  nodeType: DerivationNodeType;
  /** 是否被环检测高亮 */
  highlighted?: boolean;
  /** 是否只读（历史回放 / 冻结视图） */
  readOnly?: boolean;
}

export type DerivationFlowNode = Node<DerivationFlowNodeData>;

export interface DerivationFlowEdgeData extends Record<string, unknown> {
  edgeType: DerivationEdgeType;
  highlighted?: boolean;
}

export type DerivationFlowEdge = Edge<DerivationFlowEdgeData>;

/** 六态主色（边框 / 强调） */
export const STATUS_COLOR: Record<string, string> = {
  draft: '#9aa8a0',
  pending: '#C99A3F',
  pass: '#3F7A50',
  warn: '#C77A3C',
  fail: '#B8574A',
  frozen: '#6B7C8A',
};

/** 六态背景色 */
export const STATUS_BG: Record<string, string> = {
  draft: '#fbfcfb',
  pending: '#fdf9ee',
  pass: '#f4faf5',
  warn: '#fdf6f0',
  fail: '#fdf3f1',
  frozen: '#f2f5f7',
};

/** 六态外发光（强调视觉） */
export const STATUS_GLOW: Record<string, string> = {
  draft: '0 0 0 0 rgba(0,0,0,0)',
  pending: '0 0 0 3px rgba(201, 154, 63, 0.18)',
  pass: '0 0 0 3px rgba(63, 122, 80, 0.16)',
  warn: '0 0 0 3px rgba(199, 122, 60, 0.18)',
  fail: '0 0 0 3px rgba(184, 87, 74, 0.20)',
  frozen: '0 0 0 0 rgba(0,0,0,0)',
};

/** 节点类型标签（显示在节点头部） */
export const NODE_TYPE_LABEL: Record<DerivationNodeType, string> = {
  given: '已知',
  formula: '推导',
  conclusion: '结论',
  // 前提链架构新增：用户自建的假设前提
  assumption: '假设前提',
};

/**
 * 假设前提节点专用配色（前提链架构新增）。
 *
 * 为什么用紫色系：公式节点是蓝色系、已给条件是灰色系、结论是绿色系。
 * 假设前提是「用户主动引入、不一定成立」的前提，视觉上必须与「已经确定的事实」
 * 明确区分，否则用户会误以为它和已知条件等价。
 */
export const ASSUMPTION_COLOR = '#7A5FA8';
export const ASSUMPTION_BG = '#f7f4fb';

/**
 * 连线颜色。
 *
 * 连线类型已收敛为单一「推导」，故不再按类型取色。
 * 保留常量而非内联字面量，是为了与 MiniMap 等处的配色保持一致口径。
 */
export const EDGE_COLOR = '#3F7A50';

/** 连线高亮色（环检测命中 / 状态异常时） */
export const EDGE_COLOR_HIGHLIGHT = '#B8574A';

/** 取状态色（未知状态回落到 draft） */
export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR.draft;
}

export function statusBg(status: string): string {
  return STATUS_BG[status] ?? STATUS_BG.draft;
}

export function statusGlow(status: string): string {
  return STATUS_GLOW[status] ?? STATUS_GLOW.draft;
}