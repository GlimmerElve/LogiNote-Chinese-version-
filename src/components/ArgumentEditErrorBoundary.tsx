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
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#FEF9F3] dark:bg-slate-950 p-8">
          <div className="text-sm font-semibold text-red-600 dark:text-red-400">
            论证结构编辑器加载失败
          </div>
          <pre className="max-w-[90%] whitespace-pre-wrap break-all rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 p-3 text-xs text-red-700 dark:text-red-300">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={this.props.onBack}
            className="px-4 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 transition"
          >
            返回笔记
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}