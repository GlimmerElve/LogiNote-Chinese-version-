/**
 * S4 推导画布 —— 节点动作上下文
 *
 * 节点组件（FormulaNode / GivenNode / ConclusionNode）是 React Flow 的自定义节点，
 * 无法从 props 直接拿到「提交 / 求助 / 删除」等画布级动作。
 * 因此用 Context 从 DerivationCanvas 向下传递，保持节点组件「纯展示 + 回调」。
 *
 * 编辑语义（阶段九重构）：
 * - `onDraftSave`：仅暂存草稿并退出编辑，**不验证**（失焦 / Enter 时调用）
 * - `onSubmitNode`：**唯一的验证入口**，只由节点下方「提交」按钮触发
 *
 * 二者彻底解耦的动机：旧实现把「失焦」与「Enter / 完成」都等同「提交并验证」，
 * 导致用户编辑未完成时拖动节点（必然失焦）就被送去判定，半成品公式被判 fail
 * （界面显示「有误」），且因状态被改写而难以继续编辑。
 * 阶段九进一步统一为：写公式与交卷是两件事，交卷只发生在点「提交」的那一刻。
 */

import { createContext, useContext } from 'react';

export interface NodeActions {
  /** 提交节点做验证（阶段四接线到 analyzeStep） */
  onSubmitNode: (nodeId: string) => void;
  /** 请求助手帮助（阶段四接线到 requestHelp） */
  onRequestHelp: (nodeId: string) => void;
  /** 双击静态公式 → 请求进入编辑态 */
  onRequestEdit: (nodeId: string) => void;
  /**
   * 暂存草稿（失焦时调用）。
   *
   * 只写数据、**不触发验证、不进历史栈**，避免「还没写完就被判错」。
   */
  onDraftSave: (nodeId: string, latex: string) => void;
  /** 暂存备注（备注栏失焦时调用），同样不验证、不进历史栈 */
  onNoteDraftSave: (nodeId: string, note: string) => void;
  /** 取消编辑（Escape / 暂存后退出编辑态） */
  onCancelEdit: (nodeId: string) => void;
  /** 删除节点 */
  onDeleteNode: (nodeId: string) => void;
  /** 删除连线（边中点「×」按钮，或不依赖键盘的删除入口） */
  onDeleteEdge: (edgeId: string) => void;
  /** 冻结 / 解冻节点 */
  onToggleFreeze: (nodeId: string) => void;
  /** 当前处于编辑态的节点 id（同一时刻只允许一个） */
  editingNodeId: string | null;
  /** 是否只读（历史回放 / 反事实对比视图） */
  readOnly: boolean;
}

/** 空实现，保证节点组件脱离画布单独渲染时不崩 */
const noop = (): void => {
  /* 空实现 */
};

export const NodeActionsContext = createContext<NodeActions>({
  onSubmitNode: noop,
  onRequestHelp: noop,
  onRequestEdit: noop,
  onDraftSave: noop,
  onNoteDraftSave: noop,
  onCancelEdit: noop,
  onDeleteNode: noop,
  onDeleteEdge: noop,
  onToggleFreeze: noop,
  editingNodeId: null,
  readOnly: false,
});

export function useNodeActions(): NodeActions {
  return useContext(NodeActionsContext);
}