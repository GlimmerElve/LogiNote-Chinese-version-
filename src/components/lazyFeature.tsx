import React, { Component, Suspense, lazy, useMemo, useRef, useState } from 'react';
import './lazyFeature.css';

class FeatureLoadBoundary extends Component<{
  label: string; visible: boolean; retry: () => void; children: React.ReactNode; stateClassName?: string;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.visible) return null;
    return <div className={`feature-load-state ${this.props.stateClassName || ''}`} role="alert">
      <p>{this.props.label}暂时无法显示，其他页面内容仍保留。</p>
      <button type="button" onClick={this.props.retry}>重试加载</button>
    </div>;
  }
}

/** Each feature owns its loading boundary: loading a route must not hide the
 * navigation shell. Hidden panels start on first activation and then stay
 * mounted, preserving their drafts, subscriptions and running requests. */
export function lazyFeature<T extends React.ComponentType<any>>(
  label: string,
  loader: () => Promise<{ default: T }>,
  options: { when?: (props: React.ComponentProps<T>) => boolean; visible?: (props: React.ComponentProps<T>) => boolean; stateClassName?: string } = {},
): React.FC<React.ComponentProps<T>> {
  type Props = React.ComponentProps<T>;
  const initial = lazy(loader as () => Promise<{ default: React.ComponentType<Props> }>);
  function DeferredFeature(props: Props) {
    const activated = useRef(false);
    const enabled = !options.when || options.when(props);
    const visible = options.visible ? options.visible(props) : enabled;
    if (enabled) activated.current = true;
    const [attempt, setAttempt] = useState(0);
    const Feature = useMemo(() => attempt === 0 ? initial
      : lazy(loader as () => Promise<{ default: React.ComponentType<Props> }>), [attempt]);
    if (!activated.current) return null;
    return <FeatureLoadBoundary key={attempt} label={label} visible={visible} stateClassName={options.stateClassName} retry={() => setAttempt(value => value + 1)}>
      <Suspense fallback={visible ? <div className={`feature-load-state ${options.stateClassName || ''}`} role="status" aria-live="polite">正在加载{label}…</div> : null}>
        <Feature {...props} />
      </Suspense>
    </FeatureLoadBoundary>;
  }
  DeferredFeature.displayName = `Deferred(${label})`;
  return DeferredFeature;
}
