/**
 * S4 推导画布 —— 公式节点（核心节点）
 *
 * 用户在这里输入推导步骤的公式，是《场景设计原则》「原则 2 表现性」的直接承载者：
 * 用户必须**写出公式**才能推进，不能靠答题。
 *
 * 编辑交互（阶段九重构）：
 * - 双击 → 进入编辑态（按需加载 MathLive，虚拟键盘由 MathLive 自带开关唤起）
 * - **失焦 / Enter → 仅暂存草稿并退出编辑，不验证**
 *   （用户可能只是想挪动节点、看助手面板，或先写一半）
 * - **验证的唯一触发点是节点下方「提交」按钮**（NodeShell 提供 → onSubmitNode）
 * - Escape → 回到上次提交值，不保存
 * - 输入期不写 store（避免回声链打断输入、污染撤销栈）
 *
 * 备注栏：
 * 节点内可选填一段自然语言解释（「为什么这一步这样做」），
 * 随公式一起进入 LLM 上下文，但不参与对错判定。
 */

import { useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { DerivationFlowNode } from '../nodeVisuals';
import { NodeShell } from './NodeShell';
import { MathField } from './MathField';
import { NoteField } from './NoteField';
import { useNodeActions } from './NodeActionsContext';

export function FormulaNode({ id, data, selected }: NodeProps<DerivationFlowNode>) {
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

  /** 取消编辑：退出编辑态（值已在 Escape 中由 MathField 回退） */
  const handleCancel = useCallback(() => {
    actions.onCancelEdit(id);
  }, [actions, id]);

  /* ===== 验证反馈（阶段四填充；此处渲染既有结果） ===== */
  const verification = nodeData.verification;
  const footer =
    verification && !isEditing ? (
      <div className="dc-node-feedback">
        <p className="dc-node-feedback-text">{verification.feedback}</p>
        {verification.verdictSource === 'llm' && (
          <span className="dc-node-verdict-badge" title="SymPy 五级兜底未确定，由 AI 终裁">
            AI 裁决
          </span>
        )}
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
      nodeType="formula"
      label={nodeData.label}
      status={nodeData.status}
      frozen={nodeData.frozen}
      highlighted={highlighted}
      canSubmit={!isReadOnly}
      showHelp={!isReadOnly}
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
        placeholder="双击输入本步公式…"
      />
      {/* 备注：对这一步的解释（选填），会随公式进入 LLM 上下文 */}
      <NoteField nodeId={id} note={nodeData.note} frozen={nodeData.frozen} readOnly={isReadOnly} />
      {nodeData.unitHint && <p className="dc-node-unithint">量纲：{nodeData.unitHint}</p>}
    </NodeShell>
  );
}