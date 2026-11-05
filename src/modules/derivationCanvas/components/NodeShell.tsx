/**
 * S4 推导画布 —— 节点共享外壳
 *
 * 3 个节点组件（FormulaNode / GivenNode / ConclusionNode）共用：
 * - 四向 Handle（上下左右均可连线，方便自由布局）
 * - 节点头部（类型标签 + 标签 + 状态徽标 + 操作按钮）
 * - 六态视觉（边框 / 背景 / 外发光）
 *
 * 通过「外壳 + 内容插槽」拆分，避免多份重复的视觉代码。
 *
 * 注：原 NoteNode（独立注释节点）已在阶段七并入公式/结论节点内的备注栏
 * （见 NoteField.tsx），不再作为独立节点类型存在。
 */

import type { ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Lock,
  Unlock,
  Circle,
  Trash2,
  HelpCircle,
  Send,
} from 'lucide-react';
import { DERIVATION_STATUS_LABEL } from '../../../types/sceneS4';
import type { DerivationNodeStatus, DerivationNodeType } from '../../../types/sceneS4';
import { statusColor, statusBg, statusGlow, NODE_TYPE_LABEL } from '../nodeVisuals';
import { useNodeActions } from './NodeActionsContext';

/** 六态图标（与 DERIVATION_STATUS_LABEL 一一对应） */
function StatusIcon({ status }: { status: DerivationNodeStatus }) {
  const size = 13;
  switch (status) {
    case 'pass':
      return <CheckCircle2 size={size} />;
    case 'warn':
      return <AlertTriangle size={size} />;
    case 'fail':
      return <XCircle size={size} />;
    case 'pending':
      return <Loader2 size={size} className="dc-spin" />;
    case 'frozen':
      return <Lock size={size} />;
    default:
      return <Circle size={size} />;
  }
}

export interface NodeShellProps {
  /** 节点 id（用于回调） */
  nodeId: string;
  /** 领域节点类型 */
  nodeType: DerivationNodeType;
  /** 节点标签（可由用户改写，如 "Step 1"） */
  label: string;
  /** 六态状态 */
  status: DerivationNodeStatus;
  /** 是否冻结不可编辑 */
  frozen: boolean;
  /** 是否被环检测高亮 */
  highlighted?: boolean;
  /** 是否可提交验证（given 节点不可提交） */
  canSubmit?: boolean;
  /** 是否显示「求助」按钮 */
  showHelp?: boolean;
  /** 是否显示「删除」按钮 */
  showDelete?: boolean;
  /** 是否允许其他节点连入 */
  canConnectTarget?: boolean;
  /** 是否允许从本节点连出 */
  canConnectSource?: boolean;
  /** 节点主体内容 */
  children: ReactNode;
  /** 底部附加区（如验证反馈） */
  footer?: ReactNode;
}

export function NodeShell({
  nodeId,
  nodeType,
  label,
  status,
  frozen,
  highlighted = false,
  canSubmit = false,
  showHelp = false,
  showDelete = true,
  canConnectTarget = true,
  canConnectSource = true,
  children,
  footer,
}: NodeShellProps) {
  const actions = useNodeActions();
  const readOnly = actions.readOnly;
  const border = statusColor(status);
  const bg = statusBg(status);
  const glow = statusGlow(status);
  const statusText = DERIVATION_STATUS_LABEL[status] ?? status;

  return (
    <div
      className={`dc-node dc-node-${nodeType}${highlighted ? ' is-highlighted' : ''}${
        frozen ? ' is-frozen' : ''
      }`}
      style={{
        borderColor: highlighted ? '#B8574A' : border,
        background: bg,
        boxShadow: highlighted ? '0 0 0 3px rgba(184, 87, 74, 0.28)' : glow,
      }}
    >
      {/* 四向 Handle：上下左右均可作为连线起点/终点，配合自由布局 */}
      {canConnectTarget && (
        <>
          <Handle type="target" position={Position.Top} id="t" className="dc-handle" />
          <Handle type="target" position={Position.Left} id="l" className="dc-handle" />
        </>
      )}
      {canConnectSource && (
        <>
          <Handle type="source" position={Position.Bottom} id="b" className="dc-handle" />
          <Handle type="source" position={Position.Right} id="r" className="dc-handle" />
        </>
      )}

      {/* 头部：类型标签 + 名称 + 状态徽标 */}
      <div className="dc-node-head">
        <span className="dc-node-type" style={{ color: border, borderColor: border }}>
          {NODE_TYPE_LABEL[nodeType]}
        </span>
        <span className="dc-node-label" title={label}>
          {label}
        </span>
        <span className="dc-node-status" style={{ color: border }} title={statusText}>
          <StatusIcon status={status} />
          <span className="dc-node-status-text">{statusText}</span>
        </span>
      </div>

      {/* 主体内容 */}
      <div className="dc-node-body">{children}</div>

      {/* 底部：验证反馈 */}
      {footer && <div className="dc-node-footer">{footer}</div>}

      {/* 系统已知条件及只读态不暴露写操作，底层另有独立校验。 */}
      {!readOnly && nodeType !== 'given' && (
        <div className="dc-node-actions">
          {canSubmit && (
            <button
              type="button"
              className="dc-node-btn is-primary"
              onClick={() => actions.onSubmitNode(nodeId)}
              disabled={frozen || status === 'pending'}
              title="提交验证（由计算引擎判定）"
            >
              <Send size={11} />
              提交
            </button>
          )}
          {showHelp && (
            <button
              type="button"
              className="dc-node-btn"
              onClick={() => actions.onRequestHelp(nodeId)}
              disabled={frozen}
              title="向助手求助下一步解法（消耗求助次数）"
            >
              <HelpCircle size={11} />
              求助
            </button>
          )}
          <button
            type="button"
            className="dc-node-btn"
            onClick={() => actions.onToggleFreeze(nodeId)}
            title={frozen ? '解冻后可编辑' : '冻结后不可编辑'}
          >
            {frozen ? <Unlock size={11} /> : <Lock size={11} />}
            {frozen ? '解冻' : '冻结'}
          </button>
          {showDelete && (
            <button
              type="button"
              className="dc-node-btn is-danger"
              onClick={() => actions.onDeleteNode(nodeId)}
              title="删除节点（同时移除相关连线）"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
