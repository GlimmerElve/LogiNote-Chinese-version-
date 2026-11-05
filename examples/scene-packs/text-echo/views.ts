import type { ScenePackActivationServices, ScenePackCapabilityViews, ScenePackViewContext } from '../../../src/types/sceneInteractionPack';
import { PLUGIN_ID, MAX_TEXT_LENGTH } from './plugins/echo';

export function createViews(services: ScenePackActivationServices): ScenePackCapabilityViews {
  const h = (services.ui.react as { createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown }).createElement;
  const Controls = (context: ScenePackViewContext) => {
    const binding = context.node.bindings.text;
    const value = binding?.kind === 'literal' && typeof binding.value === 'string' ? binding.value : '';
    const act = (action: () => void) => { try { context.guard(); action(); } catch (error) { context.onError((error as Error).message); } };
    return h('section', { className: 'text-echo-controls nodrag nopan nowheel', 'aria-label': '文字回显控件' },
      h('label', null, '文字', h('textarea', { 'aria-label': '回显文字', value, rows: 3, maxLength: MAX_TEXT_LENGTH,
        disabled: !context.active || context.editable === false,
        onChange: (event: { target: { value: string } }) => act(() => context.onInputChange('text', { kind: 'literal', value: event.target.value },
          services.editor.parameterSource(context.document, context.node.id, 'text').key)) })),
      h('button', { type: 'button', disabled: !context.execution?.enabled, onClick: () => act(() => context.execution?.run([context.node.id])) }, '回显'),
      context.execution?.running ? h('button', { type: 'button', onClick: () => act(() => context.execution?.cancel?.()) }, '停止') : null,
      context.execution?.error ? h('p', { role: 'alert' }, context.execution.error) : null);
  };
  return { [`${PLUGIN_ID}/echo`]: { inline: Controls, policy: () => ({ genericSettings: false, visibleNodeInputs: [] }) } };
}
