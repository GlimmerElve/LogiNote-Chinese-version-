/**
 * MathLive 公式输入组件（S4 专用，按需加载）
 *
 * 设计要点：
 * 1. **按需加载**：`mathlive` 体积较大（含虚拟键盘字体），只在首次进入编辑态时 `import()`，
 *    落实实施计划 §10.4 K7「MathLive 体积大影响加载 → 仅 S4 视图动态 import」。
 * 2. **自定义元素**：使用 `document.createElement('math-field')`（MathLive 导入后自动注册），
 *    比 `new MathfieldElement()` 跨版本更稳定，且避免 JSX intrinsic element 类型声明问题。
 * 3. **只读态**：不加载 MathLive，用 KaTeX 静态渲染（轻量，且允许**双击进入编辑**）。
 * 4. **编辑语义（阶段九重构，见实施计划 §10.3.5）**：
 *    - **输入期不写 store**：内容只存在 MathLive 元素自身，杜绝「每击键 → 写 store →
 *      回传父级 → props 回灌 → 回写 value」这条回声链（它会打断中文/长公式输入，
 *      表现为输入框突然失焦，并把逐字符写进撤销历史栈）。
 *    - **失焦 / Enter = 暂存并退出**：调用 `onDraftSave` 落一次数据，**不触发验证**。
 *      两者语义完全一致 —— 都是「先把写到哪儿的东西存下来」，不是「交卷」。
 *    - **Escape = 放弃**：回退到进入编辑时的值，不保存、不验证。
 *    - **验证的唯一入口是节点下方的「提交」按钮**（由 NodeShell 提供），
 *      走 `actions.onSubmitNode` → `analyzeStep`，与编辑态彻底解耦。
 *    - 旧实现把 Enter / 「完成」当作提交验证，导致边写边判、半成品被判 fail；
 *      同时编辑态工具条额外挂了一个「公式键盘」按钮，与 MathLive 自带的键盘开关
 *      重复（屏幕上出现两个键盘按钮），现仅提供「暂存 / 取消」且不验证。
 * 5. **虚拟键盘**：
 *    策略固定为 `manual` —— 聚焦不再自动弹键盘，由用户自行决定何时需要。
 *    显隐**只用 MathLive `<math-field>` 自带的开关按钮**（`[part=virtual-keyboard-toggle]`，
 *    位于输入框内右上角）。该按钮直接调用 `mathVirtualKeyboard.show()/hide()`，
 *    不受 `manual` 策略限制，可正常开与关，故不再自造按钮。
 *    收起路径：进入只读、失焦、Enter、Escape、组件卸载、退出画布（见 DerivationCanvas）。
 * 6. **编辑区不可拖拽**：编辑容器带 `nodrag`，否则在输入框内按下会被 React Flow
 *    当作节点拖拽，导致选字时整个节点被拖走。
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import katex from 'katex';
import { forceManualKeyboardPolicy, hideVirtualKeyboard } from '../utils/virtualKeyboard';

/** 模块级缓存：mathlive 只加载一次（跨组件实例共享） */
let mathlivePromise: Promise<void> | null = null;

function ensureMathLive(): Promise<void> {
  if (!mathlivePromise) {
    // Bundle the installed font CSS through Vite. MathLive's default ./fonts directory
    // otherwise resolves relative to a generated JS chunk and is absent offline.
    mathlivePromise = import('mathlive/fonts.css').then(() => import('mathlive')).then(() => undefined)
      .catch((error) => { mathlivePromise = null; throw error; });
  }
  return mathlivePromise;
}

/** MathLive 自定义元素的最小接口（避免直接耦合其类型声明） */
interface MathfieldLike extends HTMLElement {
  value: string;
  mathVirtualKeyboardPolicy?: string;
  smartFence?: boolean;
  smartSuperscript?: boolean;
  focus: () => void;
}

interface ScopedKeyboard { container?: HTMLElement | null; hide: () => unknown }
function scopedKeyboard(): ScopedKeyboard | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { mathVirtualKeyboard?: ScopedKeyboard }).mathVirtualKeyboard;
}
function hideKeyboardFor(container?: HTMLElement | null): void {
  if (!container) { hideVirtualKeyboard(); return; }
  try { const keyboard = scopedKeyboard(); if (keyboard?.container === container) keyboard.hide(); } catch { /* Optional keyboard. */ }
}

/** KaTeX 静态渲染为 HTML（失败返回空串，由调用方回退原始文本） */
function renderStaticHtml(latex: string): string {
  // MathLive serializes a double prime using this alias, which KaTeX does not understand.
  const tex = latex.trim().replace(/\\doubleprime\b/g, '\\prime\\prime');
  if (!tex) return '';
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: false });
  } catch {
    return '';
  }
}

export interface MathFieldProps {
  /** 当前 LaTeX（受控值，来自节点 data.latex） */
  value: string;
  /** 是否处于编辑态（由父组件控制） */
  editing: boolean;
  /** 只读：永远不进入编辑（历史回放 / 权限受限） */
  readOnly?: boolean;
  /** 已冻结：视觉锁定且不可编辑 */
  frozen?: boolean;
  /**
   * 暂存草稿（失焦 / Enter 时调用），**不触发验证**。
   *
   * 这是编辑态唯一的落库出口。验证由节点下方的「提交」按钮触发，
   * 与编辑态解耦，避免「还没写完就被判错」。
   */
  onDraftSave?: (latex: string) => void;
  /**
   * 退出编辑态。
   *
   * 三个触发点：Escape（放弃修改）、失焦、Enter（后两者均已先调用 onDraftSave 暂存）。
   * 实现上只需把 editingNodeId 置空。
   */
  onCancel?: () => void;
  /** 双击静态公式时请求进入编辑态 */
  onRequestEdit?: () => void;
  /** 值为空时的占位提示 */
  placeholder?: string;
  /** Optional modal-local keyboard host. Default canvas keyboard behavior is unchanged. */
  keyboardContainer?: HTMLElement | null;
  /** Optional input notification for a separately persisted pending draft; never validates. */
  onInputDraft?: (latex: string) => void;
}

export function MathField({
  value,
  editing,
  readOnly = false,
  frozen = false,
  onDraftSave,
  onCancel,
  onRequestEdit,
  placeholder = '双击输入公式…',
  keyboardContainer,
  onInputDraft,
}: MathFieldProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<MathfieldLike | null>(null);
  /** 编辑期已暂存过的值，避免失焦时重复写入 store */
  const draftedRef = useRef<string>(value);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const inputRef = useRef(value);
  const finishedRef = useRef(false);
  const finishRef = useRef<(save: boolean, restoreFocus?: boolean) => void>(() => {});
  const blurRef = useRef<(relatedTarget: EventTarget | null | undefined) => void>(() => {});
  const focusReturnRef = useRef(false);
  const callbacksRef = useRef({ onDraftSave, onCancel, onInputDraft });
  callbacksRef.current = { onDraftSave, onCancel, onInputDraft };

  // 非编辑态时同步草稿（下次进入编辑即以当前值为准）
  useEffect(() => {
    if (!editing) {
      draftedRef.current = value;
      inputRef.current = value;
    }
  }, [value, editing]);

  /** 退出编辑态：强制收起虚拟键盘（键盘挂在 document.body，不随元素销毁而消失） */
  useEffect(() => {
    if (editing) return;
    hideKeyboardFor(keyboardContainer);
    if (focusReturnRef.current) {
      focusReturnRef.current = false;
      if (!readOnly && !frozen) {
        // Wait for the controlled canvas to finish applying the draft before focusing its node.
        const frame = requestAnimationFrame(() => {
          if (!document.activeElement || document.activeElement === document.body || document.activeElement === staticRef.current) {
            staticRef.current?.focus({ preventScroll: true });
          }
        });
        return () => cancelAnimationFrame(frame);
      }
    }
  }, [editing, readOnly, frozen, keyboardContainer]);

  /** 挂载 MathLive 自定义元素 */
  useEffect(() => {
    if (!editing || readOnly || frozen) return undefined;
    let cancelled = false;
    let mf: MathfieldLike | null = null;
    let ownedKeyboard: ScopedKeyboard | undefined;
    let previousKeyboardContainer: HTMLElement | null | undefined;
    let blurFrame: number | undefined;
    finishedRef.current = false;
    setLoadError(null);
    setLoading(true);

    const cancelBlurFrame = () => {
      if (blurFrame !== undefined) cancelAnimationFrame(blurFrame);
      blurFrame = undefined;
    };
    /** 同步锁先于收起键盘，避免 Enter/按钮后的 blur 再次保存或取消。 */
    const finish = (save: boolean, restoreFocus = true) => {
      if (cancelled || finishedRef.current) return;
      cancelBlurFrame();
      finishedRef.current = true;
      focusReturnRef.current = restoreFocus;
      const latex = mf?.value ?? inputRef.current;
      hideKeyboardFor(keyboardContainer);
      // 仅在内容真的变了才写 store，减少一次无谓的受控回传
      if (save && latex !== draftedRef.current) {
        draftedRef.current = latex;
        callbacksRef.current.onDraftSave?.(latex);
      }
      callbacksRef.current.onCancel?.();
    };
    finishRef.current = finish;

    const isInternalFocus = (target: EventTarget | null | undefined) => target instanceof Node
      && (target === mf || wrapRef.current?.contains(target) || keyboardContainer?.contains(target));
    const onBlur = (relatedTarget: EventTarget | null | undefined) => {
      cancelBlurFrame();
      if (cancelled || finishedRef.current || isInternalFocus(relatedTarget)) return;
      if (keyboardContainer && relatedTarget == null) {
        // MathLive dispatches synthetic blur/focusout events without relatedTarget.
        // Its local virtual keyboard can transiently move/refocus the shadow input;
        // wait for that transfer before treating it as leaving the modal editor.
        // Keep the original synchronous S4 blur contract when no host is provided.
        blurFrame = requestAnimationFrame(() => {
          blurFrame = undefined;
          if (!cancelled && !finishedRef.current && !isInternalFocus(document.activeElement)) finish(true, false);
        });
        return;
      }
      finish(true, false);
    };
    blurRef.current = onBlur;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        // Enter = 暂存并退出，与失焦同语义；验证交给节点下方的「提交」按钮
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // 放弃本次编辑：回退到进入编辑时的值，不保存不验证
        finish(false);
      }
    };
    const onBlurEvent = (e: FocusEvent) => {
      /**
       * 失焦只暂存。
       *
       * 用户可能只是点开虚拟键盘、拖动节点、去看助手面板 —— 这些都不该判对错。
       * 真正的验证由节点下方的「提交」按钮触发。
       */
      onBlur(e.relatedTarget);
    };
    const onInput = () => {
      if (!mf || cancelled || finishedRef.current) return;
      inputRef.current = mf.value;
      callbacksRef.current.onInputDraft?.(mf.value);
    };

    ensureMathLive()
      .then(() => {
        if (cancelled || finishedRef.current || !hostRef.current) return;

        // MathLive 导入后自动注册 <math-field> 自定义元素
        const el = document.createElement('math-field') as MathfieldLike;
        el.value = inputRef.current;
        el.setAttribute('aria-label', '公式输入');

        el.addEventListener('keydown', onKeyDown as EventListener);
        el.addEventListener('blur', onBlurEvent);
        el.addEventListener('input', onInput);

        if (keyboardContainer) {
          try {
            ownedKeyboard = scopedKeyboard();
            if (ownedKeyboard) {
              previousKeyboardContainer = ownedKeyboard.container;
              ownedKeyboard.container = keyboardContainer;
            }
          } catch { ownedKeyboard = undefined; }
        }

        // 先入文档流再设属性：MathLive 元素在连接前不会处理自定义属性
        hostRef.current.appendChild(el);

        /**
         * 键盘策略必须在挂载后设置：
         * - 元素级 `manual` → 该 math-field 获焦时不自动弹键盘，
         *   显隐由 MathLive 自带的键盘开关按钮控制
         * - 全局 `manual`   → 兜底，避免其它实例把策略改回 auto
         */
        try {
          el.mathVirtualKeyboardPolicy = 'manual';
          el.smartFence = true;
          el.smartSuperscript = true;
        } catch {
          /* 旧版本可能不支持，忽略 */
        }
        forceManualKeyboardPolicy();

        mf = el;
        fieldRef.current = el;
        setLoading(false);

        // 挂载后聚焦（延迟到下一帧，确保元素已进入文档流）
        requestAnimationFrame(() => {
          if (!cancelled && !finishedRef.current) {
            try {
              el.focus();
            } catch {
              /* 聚焦失败不影响输入能力 */
            }
          }
        });
      })
      .catch(() => {
        if (!cancelled && !finishedRef.current) {
          setLoading(false);
          setLoadError('公式编辑器未能加载，可重试或直接输入 LaTeX。');
        }
      });

    return () => {
      cancelled = true;
      cancelBlurFrame();
      finishRef.current = () => {};
      blurRef.current = () => {};
      if (mf) {
        mf.removeEventListener('keydown', onKeyDown as EventListener);
        mf.removeEventListener('blur', onBlurEvent);
        mf.removeEventListener('input', onInput);
        mf.remove();
      }
      fieldRef.current = null;
      // 元素销毁后键盘不会自动消失（挂在 document.body 上）→ 必须显式收起
      hideKeyboardFor(keyboardContainer);
      // Restore only while this editor still owns the singleton. Another editor
      // that has taken ownership must not have its keyboard hidden or moved.
      if (ownedKeyboard && ownedKeyboard.container === keyboardContainer) {
        try { ownedKeyboard.container = previousKeyboardContainer ?? null; } catch { /* Old keyboard version. */ }
      }
    };
    // 仅在编辑态切换时重挂载；value 的同步由下一个 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, readOnly, frozen, retry, keyboardContainer]);

  /**
   * 外部 value 变化 → 同步进 mathfield。
   *
   * 关键守卫：**正在输入时不回写**。
   * 编辑期 store 里的 latex 仍是上次提交值，若此时回写会把用户正在写的内容冲掉。
   */
  useEffect(() => {
    const mf = fieldRef.current;
    if (!mf || !editing) return;
    if (typeof document !== 'undefined' && document.activeElement === mf) return;
    if (mf.value !== value) {
      mf.value = value;
      draftedRef.current = value;
      inputRef.current = value;
    }
  }, [value, editing]);

  const handleStaticDoubleClick = useCallback(() => {
    if (readOnly || frozen) return;
    onRequestEdit?.();
  }, [readOnly, frozen, onRequestEdit]);

  /* ===================== 编辑态 ===================== */
  if (editing && !readOnly && !frozen) {
    return (
      <div ref={wrapRef} className="dc-mathfield-wrap nodrag nowheel"
        onBlur={(e) => {
          if (!loading) blurRef.current(e.relatedTarget);
        }}
        onKeyDown={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest('button')) return;
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape' || !loading) finishRef.current(e.key === 'Enter');
          }
        }}>
        <div ref={hostRef} className="dc-mathfield" />
        {loading && <span className="dc-mathfield-loading" role="status">正在加载公式编辑器…</span>}
        {loadError && <>
          <span className="dc-mathfield-error" role="alert">{loadError}</span>
          <textarea className="dc-mathfield-fallback" aria-label="LaTeX 公式输入" autoFocus
            defaultValue={inputRef.current} onChange={(e) => { inputRef.current = e.target.value; callbacksRef.current.onInputDraft?.(e.target.value); }} />
        </>}
        <div className="dc-mathfield-actions">
          {loadError && <button type="button" onPointerDown={(e) => e.preventDefault()}
            onClick={() => setRetry(n => n + 1)}>重试</button>}
          <button type="button" onPointerDown={(e) => e.preventDefault()}
            onClick={() => finishRef.current(false)}>取消</button>
          <button type="button" className="is-primary" disabled={loading}
            onPointerDown={(e) => e.preventDefault()} onClick={() => finishRef.current(true)}>暂存</button>
        </div>
      </div>
    );
  }

  /* ===================== 只读 / 静态态 ===================== */
  const html = renderStaticHtml(value);
  const isEmpty = !value.trim();
  const canEdit = !readOnly && !frozen;

  return (
    <div
      ref={staticRef}
      className={`dc-math-static${isEmpty ? ' is-empty' : ''}${frozen ? ' is-frozen' : ''}`}
      onDoubleClick={handleStaticDoubleClick}
      role={canEdit ? 'button' : undefined}
      tabIndex={canEdit ? 0 : undefined}
      aria-label={canEdit ? '编辑公式' : undefined}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (canEdit && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault(); e.stopPropagation(); handleStaticDoubleClick();
        }
      }}
      title={canEdit ? '双击或按 Enter 编辑' : undefined}
    >
      {isEmpty ? (
        <span className="dc-math-placeholder">{placeholder}</span>
      ) : html ? (
        /* KaTeX 输出为受信任 HTML（throwOnError: false，不会执行脚本） */
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="dc-math-raw">{value}</code>
      )}
    </div>
  );
}
