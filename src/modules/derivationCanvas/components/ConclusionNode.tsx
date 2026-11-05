/**
 * S4 推导画布 —— 结论节点
 *
 * 用户对最终公式的收束表达，对应《场景设计原则》「原则 1 目标对齐」：
 * 结论节点是「达成什么表现才算学会」的可视化锚点。
 *
 * 与 FormulaNode 的差异：
 * - 视觉上更强调（旗帜图标 + 加粗标题）
 * - 提交后触发的是「最终锚点比对」而非中间步骤匹配
 * - 不可冻结（终点冻结无意义）
 *
 * 编辑语义与 FormulaNode 一致（阶段九重构）：
 * 失焦 / Enter 仅暂存并退出编辑、验证只由节点下方「提交」按钮触发、输入期不写 store。
 */

import { useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';
import { CheckCircle2, Flag } from 'lucide-react';
import type { DerivationFlowNode } from '../nodeVisuals';
import { NodeShell } from './NodeShell';
import { MathField } from './MathField';
import { NoteField } from './NoteField';
import { useNodeActions } from './NodeActionsContext';

export function ConclusionNode({ id, data }: NodeProps<DerivationFlowNode>) {
  const { nodeData, highlighted, readOnly } = data;
  const actions = useNodeActions();
  const isEditing = actions.editingNodeId === id;
  const isReadOnly = Boolean(readOnly) || actions.readOnly;
  const isPass = nodeData.status === 'pass';

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

  const handleCancel = useCallback(() => {
    actions.onCancelEdit(id);
  }, [actions, id]);

  const verification = nodeData.verification;

  return (
    <NodeShell
      nodeId={id}
      nodeType="conclusion"
      label={nodeData.label}
      status={nodeData.status}
      frozen={nodeData.frozen}
      highlighted={highlighted}
      canSubmit={!isReadOnly}
      showHelp={!isReadOnly}
      canConnectSource={false}
      footer={
        verification ? (
          <div className="dc-node-feedback">
            {isPass && (
              <span className="dc-node-pass-badge">
                <CheckCircle2 size={12} /> 已达成目标公式
              </span>
            )}
            <p className="dc-node-feedback-text">{verification.feedback}</p>
            {verification.verdictSource === 'llm' && (
              <span className="dc-node-verdict-badge" title="SymPy 五级兜底未确定，由 AI 终裁">
                AI 裁决
              </span>
            )}
          </div>
        ) : null
      }
    >
      <div className="dc-conclusion-head">
        <Flag size={13} className="dc-conclusion-flag" />
        <span>最终结论</span>
      </div>
      <MathField
        value={nodeData.latex ?? ''}
        editing={isEditing}
        readOnly={isReadOnly}
        frozen={nodeData.frozen}
        onDraftSave={handleDraftSave}
        onCancel={handleCancel}
        onRequestEdit={handleRequestEdit}
        placeholder="双击写出结论公式…"
      />
      {/* 备注：对结论的说明（选填），会随公式进入 LLM 上下文 */}
      <NoteField
        nodeId={id}
        note={nodeData.note}
        frozen={nodeData.frozen}
        readOnly={isReadOnly}
      />
    </NodeShell>
  );
}
