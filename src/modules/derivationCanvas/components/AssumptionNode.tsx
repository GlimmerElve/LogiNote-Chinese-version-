/**
 * S4 推导画布 —— 假设前提节点（前提链架构新增）
 *
 * ## 与公式节点的差异（仅三处）
 * 1. **配色**：紫色系（`ASSUMPTION_COLOR`），与公式（蓝）、已知（灰）、结论（绿）区分。
 *    用户主动引入的、不一定成立的前提，视觉上必须与「已确定的事实」明确分开 ——
 *    否则会误以为它和 given 等价。
 * 2. **标签文案**：`NODE_TYPE_LABEL.assumption` = 「假设前提」。
 * 3. **判定路径**：提交后走 `analyzeAssumptionStep`（只做「语法 + 与祖先前提冲突」检查，
 *    不走参考解比对 —— 假设本就没有参考答案）。
 *    但**分流发生在调用方**（`SceneDerivationView`），节点侧无需知情：
 *    它和公式节点一样只调 `onSubmitNode(id)`。
 *
 * ## 为什么不做成分离的编辑逻辑
 * 复用 `MathField` + `NoteField` + `NodeShell`：假设前提的输入体验
 * （LaTeX 编辑、虚拟键盘、备注栏）与公式完全一致，另造一套只会增加维护面。
 *
 * ## 语义提示（用户可见）
 * 节点内提示「仅在该支路生效」—— 这是用户必须知道的关键约束：
 * 假设通过连线作用于下游，不会全局生效，也不会推翻场景给定的前提
 * （冲突时由引擎判 `conflict`，场景前提优先）。
 */

import { useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Lightbulb } from 'lucide-react';
import type { DerivationFlowNode } from '../nodeVisuals';
import { NodeShell } from './NodeShell';
import { MathField } from './MathField';
import { NoteField } from './NoteField';
import { useNodeActions } from './NodeActionsContext';

export function AssumptionNode({ id, data, selected }: NodeProps<DerivationFlowNode>) {
  const { nodeData, highlighted, readOnly } = data;
  const actions = useNodeActions();
  const isEditing = actions.editingNodeId === id;
  const isReadOnly = Boolean(readOnly) || actions.readOnly;

  /** 双击静态公式 → 请求进入编辑态 */
  const handleRequestEdit = useCallback(() => {
    actions.onRequestEdit(id);
  }, [actions, id]);

  /** 失焦暂存：只落数据，不验证 */
  const handleDraftSave = useCallback(
    (latex: string) => {
      actions.onDraftSave(id, latex);
    },
    [actions, id],
  );

  /** 取消编辑：退出编辑态 */
  const handleCancel = useCallback(() => {
    actions.onCancelEdit(id);
  }, [actions, id]);

  const verification = nodeData.verification;

  /**
   * 底部反馈区。
   *
   * 与公式节点的差异：假设的判定来源恒为 `premise`（不与参考解比），
   * 故不渲染「AI 裁决」徽标 —— 假设校验是纯引擎行为（语法 + 冲突检查），
   * 不存在 LLM 终裁这条路径。标了反而误导。
   */
  const footer =
    verification && !isEditing ? (
      <div className="dc-node-feedback">
        <p className="dc-node-feedback-text">{verification.feedback}</p>
        {verification.suggestions && verification.suggestions.length > 0 && (
          <ul className="dc-node-suggestions">
            {verification.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  return (
    <NodeShell
      nodeId={id}
      nodeType="assumption"
      label={nodeData.label}
      status={nodeData.status}
      frozen={nodeData.frozen}
      highlighted={highlighted}
      canSubmit={!isReadOnly}
      /**
       * 假设前提**不提供求助**。
       *
       * 为什么：求助的语义是「我下一步该怎么推」，而假设是用户**主动设定**的
       * 额外条件（如「假定 m 远大于 M」）。向助手要一个「假设」等于让 AI
       * 替他设定前提，会架空「独立推导」的考核目标，也与求助次数作为
       * 稀缺资源的定位冲突。
       */
      showHelp={false}
      footer={footer}
    >
      {selected && !isEditing && <span className="dc-node-selected-hint" aria-hidden />}

      <MathField
        value={nodeData.latex ?? ''}
        editing={isEditing}
        readOnly={isReadOnly}
        frozen={nodeData.frozen}
        onDraftSave={handleDraftSave}
        onCancel={handleCancel}
        onRequestEdit={handleRequestEdit}
        placeholder="双击输入假设条件…"
      />

      {/* 语义提示：让「仅在该支路生效」这条约束对用户可见 */}
      <p className="dc-node-assumption-hint">
        <Lightbulb size={10} />
        仅对下方连线步骤生效
      </p>

      <NoteField nodeId={id} note={nodeData.note} frozen={nodeData.frozen} readOnly={isReadOnly} />
    </NodeShell>
  );
}