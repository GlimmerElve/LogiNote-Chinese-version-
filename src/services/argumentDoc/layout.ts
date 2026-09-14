import type { ArgNode, ArgEdge, Point } from './types';
import { getNodeRank } from './types';

/**
 * 三层自动布局（复制自 argument-editor-standalone 的 hierarchicalLayout.ts）
 *
 * 按论证层级强制三层：概念层 rank0 / 判断层 rank1 / 逻辑层 rank2。
 * - 同一层节点横向等距排布（绝无重叠）
 * - 三层纵向间距固定
 * - 孤立节点（无任何边）单独放在最左侧一列，纵向排布
 */

/** 节点固定宽度（与编辑器画布一致） */
const NODE_WIDTH = 300;
/** 同层节点之间的水平间距 */
const HORIZONTAL_GAP = 60;
/** 横向步长（节点宽 + 间距） */
const HORIZONTAL_STEP = NODE_WIDTH + HORIZONTAL_GAP;
/** 画布左侧起始边距 */
const MARGIN_X = 40;
/** 层间纵向间距 */
const LAYER_SEP = 260;
/** 孤立节点列与主图之间的 x 间距 */
const ISOLATED_GAP_X = 400;

/**
 * 计算自动布局后的节点位置。
 * 返回 positions[id] = { x, y }（左上角坐标）。
 */
export function layoutDoc(nodes: ArgNode[], edges: ArgEdge[]): Record<string, Point> {
  const positions: Record<string, Point> = {};
  if (nodes.length === 0) return positions;

  // 找出有连接的节点（非孤立）
  const connectedIds = new Set<string>();
  for (const e of edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }

  // 按层分组
  const layers: Record<number, ArgNode[]> = { 0: [], 1: [], 2: [] };
  const isolated: ArgNode[] = [];
  for (const n of nodes) {
    if (connectedIds.has(n.id)) {
      layers[getNodeRank(n.mainType)].push(n);
    } else {
      isolated.push(n);
    }
  }

  // 孤立节点列在左侧；有孤立节点时主图让出左侧空间
  const hasIsolated = isolated.length > 0;
  const mainStartX = hasIsolated ? MARGIN_X + HORIZONTAL_STEP : MARGIN_X;

  // 三层横向排布
  for (const rank of [0, 1, 2]) {
    const list = layers[rank];
    list.forEach((n, i) => {
      positions[n.id] = {
        x: mainStartX + i * HORIZONTAL_STEP,
        y: rank * LAYER_SEP,
      };
    });
  }

  // 孤立节点单独一列（最左侧，纵向排布）
  isolated.forEach((n, i) => {
    positions[n.id] = {
      x: MARGIN_X,
      y: i * LAYER_SEP,
    };
  });

  // 保留常量引用，避免未使用告警
  void ISOLATED_GAP_X;

  return positions;
}