import React from 'react';

type SceneWidget = 'heading' | 'role-rail' | 'message-list' | 'message' | 'answer' | 'form'
  | 'experiment-ledger' | 'metrics' | 'materials' | 'citations' | 'task' | 'events' | 'completion' | 'partial-reply';
interface Props {
  children: React.ReactNode;
  widget: SceneWidget;
  label: string;
  onFocusConversation?: () => void;
}
interface State { failed: boolean }

/** A display retry only remounts this failed widget; it cannot request a model or submit an answer. */
export class SceneWidgetErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(_error: unknown): State { return { failed: true }; }

  componentDidCatch(_error: unknown, _info: React.ErrorInfo): void {
    // No user contents, answers, tool payloads, prompts, or provider errors in diagnostics.
    console.error('[scene-widget-render]', { widget: this.props.widget, code: 'widget-render-error' });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <section className="scene-widget-error" role="alert" aria-live="polite" aria-label={this.props.label + '显示异常'}
      style={{ padding: 12, minWidth: 0, overflowWrap: 'anywhere' }}>
      <strong>{this.props.label}暂时无法显示</strong>
      <p>仅此区域受影响，已提交记录未改动。重试显示不会调用模型或重复提交。</p>
      <div className="scene-loading-actions">
        <button type="button" className="scene-btn scene-btn--ghost" onClick={() => this.setState({ failed: false })}>重试显示此区域</button>
        {this.props.onFocusConversation && <button type="button" className="scene-btn scene-btn--ghost" onClick={this.props.onFocusConversation}>转到场景交流</button>}
      </div>
    </section>;
  }
}

/** Defer potentially unsafe render calculations into a child, where the nearest boundary can catch them. */
export const SceneWidgetContent: React.FC<{ children: () => React.ReactNode }> = ({ children }) => <>{children()}</>;
