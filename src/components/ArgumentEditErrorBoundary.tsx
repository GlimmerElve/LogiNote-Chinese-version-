/**
 * 论证编辑视图的错误边界。
 *
 * 论证画布引入 @xyflow/react 后，运行时若抛错会直接把整个 React 树打成白屏。
 * 此边界捕获渲染错误，回退为可读的错误提示 + 返回按钮，便于排查而非白屏。
 */

import React from 'react';

interface Props extends React.PropsWithChildren<{ onBack: () => void }> {}

interface State {
  error: Error | null;
}

export class ArgumentEditErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ArgumentEdit] 渲染错误:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[var(--ln-bg-app)] p-8 text-[var(--ln-text-primary)]">
          <div role="alert" className="text-sm font-semibold text-[var(--ln-danger)]">
            论证结构编辑器加载失败
          </div>
          <pre tabIndex={0} aria-label="错误详情" className="max-w-[90%] whitespace-pre-wrap break-all rounded-lg border border-[color-mix(in_srgb,var(--ln-danger)_32%,var(--ln-border))] bg-[var(--ln-bg-surface)] p-3 text-xs text-[var(--ln-danger)]">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            type="button"
            onClick={this.props.onBack}
            className="min-h-11 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] px-4 py-2 text-xs font-semibold text-[var(--ln-text-primary)] transition hover:border-[var(--ln-accent)] hover:bg-[var(--ln-bg-subtle)] focus-visible:outline-2 focus-visible:outline-[var(--ln-accent)]"
          >
            返回笔记
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
