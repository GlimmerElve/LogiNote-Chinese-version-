/**
 * S4 推导画布 —— 节点内「备注」选填栏
 *
 * 语义（对应《场景设计原则》「原则 2 表现性」）：
 * 备注是**对这一步为什么这样做的解释**，例如「因为洛伦兹因子在低速下近似为 1」。
 * 它不参与对错判定，但会作为理解意图的上下文随公式一起送给 LLM
 * （见 `computeAnalyze.buildAnalyzeInput` 与 `sceneHelp`）。
 *
 * 为什么并入公式块 / 结论块，而不是独立节点：
 * 1. 独立节点与公式之间没有归属关系，LLM 无法判断这段文字在解释哪一步；
 * 2. 并进节点后，备注随节点一起被提交、一起被导出，语义天然绑定；
 * 3. 减少一类节点，画布结构更接近真实推导书写习惯。
 *
 * 交互：
 * - 未编辑态：显示为一行紧凑文本；空时显示「＋ 添加解释（选填）」
 * - 点击进入编辑：展开 textarea，**失焦即保存**（不验证），Enter 换行不提交
 * - 只读态：纯文本展示，不可点击
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { useNodeActions } from './NodeActionsContext';

export interface NoteFieldProps {
  /** 所属节点 id（写入时使用） */
  nodeId: string;
  /** 当前备注内容 */
  note?: string;
  /** 节点是否冻结 */
  frozen?: boolean;
  /** 只读（历史回放 / 运行结束） */
  readOnly?: boolean;
}

export function NoteField({ nodeId, note, frozen = false, readOnly = false }: NoteFieldProps) {
  const actions = useNodeActions();
  const isReadOnly = readOnly || actions.readOnly || frozen;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 外部内容变化时同步草稿（仅非编辑态，避免打断正在输入的内容）
  useEffect(() => {
    if (!editing) setDraft(note ?? '');
  }, [note, editing]);

  // 进入编辑态：聚焦并把光标放到末尾
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      /* 某些环境不支持，忽略 */
    }
  }, [editing]);

  /**
   * 保存并退出。
   *
   * 用「不进历史栈」的草稿写入通道：备注属于解释性文本，
   * 不应污染 Ctrl+Z（用户撤销时期望回退推导步骤，而不是备注的逐字变化）。
   */
  const save = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (next === (note ?? '').trim()) return;
    actions.onNoteDraftSave(nodeId, next);
  }, [actions, nodeId, draft, note]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter 换行（备注是多行自然语言）；用 Escape 或失焦结束
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(note ?? '');
        setEditing(false);
      }
    },
    [note],
  );

  if (isReadOnly) {
    if (!note?.trim()) return null;
    return <p className="dc-node-note">{note}</p>;
  }

  if (editing) {
    return (
      <div className="dc-notefield nodrag">
        <textarea
          ref={textareaRef}
          className="dc-notefield-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={handleKeyDown}
          placeholder="解释这一步为什么这样做…（失焦自动保存）"
          rows={2}
        />
      </div>
    );
  }

  const hasNote = Boolean(note?.trim());

  return (
    <button
      type="button"
      className={`dc-notefield-trigger${hasNote ? ' has-note' : ''} nodrag`}
      onClick={() => setEditing(true)}
      title={hasNote ? '点击修改解释' : '为这一步补充解释（选填）'}
    >
      {hasNote ? (
        <span className="dc-notefield-text">{note}</span>
      ) : (
        <>
          <MessageSquarePlus size={11} />
          添加解释（选填）
        </>
      )}
    </button>
  );
}