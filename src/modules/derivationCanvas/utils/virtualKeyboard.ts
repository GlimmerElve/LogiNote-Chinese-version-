/**
 * S4 推导画布 —— MathLive 虚拟键盘全局控制
 *
 * 背景（阶段七缺陷修复）：
 * MathLive 的虚拟键盘面板挂在 `document.body` 上，是**全局单例**（`window.mathVirtualKeyboard`），
 * 并不会随 `<math-field>` 元素被移除而消失。
 * 旧实现只在 MathField 里把键盘策略设为 `manual`，但赋值时机早于元素挂载（策略未生效），
 * 且全项目没有任何一处调用 `hide()`，于是出现「键盘弹出后无法收起，退出画布也一直存在」的问题。
 *
 * 因此把键盘控制统一收敛到这里：
 * 1. 只在 MathLive 已加载时操作（未加载时静默忽略，不引入硬依赖）
 * 2. 暴露 `show` / `hide` / `policy` 能力，供 MathField 与画布层共用
 */

/** MathLive 虚拟键盘的最小接口（避免直接耦合其类型声明） */
export interface VirtualKeyboardLike {
  /** 是否可见 */
  visible: boolean;
  /** 可见性策略：auto 由焦点控制，manual 由代码显式控制 */
  policy: string;
  /** 显示键盘（返回是否成功） */
  show: () => boolean;
  /** 隐藏键盘（返回是否成功） */
  hide: () => boolean;
}

/** 取全局虚拟键盘单例（MathLive 未加载时返回 null） */
export function getVirtualKeyboard(): VirtualKeyboardLike | null {
  const host = window as unknown as { mathVirtualKeyboard?: VirtualKeyboardLike };
  return host.mathVirtualKeyboard ?? null;
}

/** 显示虚拟键盘（未加载则忽略） */
export function showVirtualKeyboard(): void {
  try {
    getVirtualKeyboard()?.show();
  } catch {
    /* 忽略：键盘未就绪 */
  }
}

/** 隐藏虚拟键盘（未加载则忽略） */
export function hideVirtualKeyboard(): void {
  try {
    getVirtualKeyboard()?.hide();
  } catch {
    /* 忽略：键盘未就绪 */
  }
}

/** 当前键盘是否可见 */
export function isVirtualKeyboardVisible(): boolean {
  try {
    return Boolean(getVirtualKeyboard()?.visible);
  } catch {
    return false;
  }
}

/**
 * 把全局键盘策略固定为 `manual`。
 *
 * 必须设为 manual：否则任何 math-field 获得焦点都会自动弹出键盘，
 * 用户就无法自主决定「什么时候要键盘」。
 */
export function forceManualKeyboardPolicy(): void {
  const kb = getVirtualKeyboard();
  if (!kb) return;
  try {
    kb.policy = 'manual';
  } catch {
    /* 忽略：旧版本无 policy */
  }
}