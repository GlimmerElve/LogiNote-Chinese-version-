import React from 'react';

interface Props {
  children: React.ReactNode;
  section: 'preview' | 'running';
  onReturn: () => void;
}
interface State { code: 'invalid-display-value' | 'render-error' | null }

/** Keep the parent scene state mounted; retrying display never reruns a paid model request. */
export class ScenePageErrorBoundary extends React.Component<Props, State> {
  state: State = { code: null };
  private retryRef = React.createRef<HTMLButtonElement>();

  static getDerivedStateFromError(error: unknown): State {
    return { code: error instanceof Error && error.message.startsWith('Objects are not valid as a React child')
      ? 'invalid-display-value' : 'render-error' };
  }

  componentDidCatch(_error: unknown, _info: React.ErrorInfo): void {
    // Never put scene bodies, prompts, answer keys or raw provider errors into diagnostics.
    console.error('[scene-render]', { section: this.props.section, code: this.state.code });
    if (typeof window !== 'undefined') window.requestAnimationFrame(() => this.retryRef.current?.focus());
  }

  render(): React.ReactNode {
    if (!this.state.code) return this.props.children;
    return <section className="scene-response-zone" role="alert" aria-live="assertive" style={{ padding: 20, alignSelf: 'center' }}>
      <h3>{this.props.section === 'running' ? '场景运行页暂时无法显示' : '场景预览暂时无法显示'}</h3>
      <p>{this.state.code === 'invalid-display-value' ? '场景中存在无法直接显示的字段。' : '场景组件发生了渲染异常。'}错误码：{this.state.code}</p>
      <p>场景配置和已提交记录仍保留在当前会话中。重试显示不会重新生成场景或重复调用模型。</p>
      <div className="scene-loading-actions">
        <button ref={this.retryRef} type="button" className="scene-btn scene-btn--primary" onClick={() => this.setState({ code: null })}>重试显示</button>
        <button type="button" className="scene-btn scene-btn--ghost" onClick={this.props.onReturn}>
          {this.props.section === 'running' ? '结束本局并返回预览' : '返回搭建面板'}
        </button>
      </div>
    </section>;
  }
}
