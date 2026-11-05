/**
 * S4 画布错误边界。
 *
 * 为什么需要它：
 * 画布依赖 React Flow 的 Provider、引擎返回结构、节点渲染等多环节，
 * 任一环节抛错都会让 React 卸载整棵树，表现为「整个窗口全白」，
 * 用户与开发者都拿不到任何线索（本次白屏问题即耗费了额外排查成本）。
 * 此边界把异常拦在画布范围内，显示可读原因，并保留重试入口。
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** 兜底标题（缺省「画布渲染失败」） */
  title?: string;
}

interface State {
  error: Error | null;
}

export class SceneErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };
  private retryRef = React.createRef<HTMLButtonElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 开发期留档：控制台可直接看到组件栈，生产不额外上报
    console.error('[SceneErrorBoundary] 画布渲染失败：', error, info.componentStack);
    window.requestAnimationFrame(() => this.retryRef.current?.focus({ preventScroll: true }));
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="scene-s4-error" role="alert" aria-live="assertive">
        <div className="scene-s4-error-title">{this.props.title ?? '画布渲染失败'}</div>
        <div className="scene-s4-error-msg">{error.message || String(error)}</div>
        <div className="scene-s4-error-hint">
          画布组件在渲染时抛出了上述错误。可点击重试；若持续失败，请把此提示反馈给开发者。
        </div>
        <button ref={this.retryRef} type="button" className="scene-s4-btn-ghost" onClick={this.handleRetry}>
          重试
        </button>
      </div>
    );
  }
}

export default SceneErrorBoundary;
