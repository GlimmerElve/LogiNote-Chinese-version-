import type { ScenePackActivationServices, ScenePackViewContext } from '../../../src/types/sceneInteractionPack';

/** Optional local presentation. Use the injected React instance, never a bundled second React. */
export function createViews(services: ScenePackActivationServices) {
  const react = services.ui.react as { createElement(type: string, props: Record<string, unknown> | null, ...children: unknown[]): unknown };
  const Settings = (props: ScenePackViewContext) => react.createElement('p', { className: 'number-scale-note' },
    `本地数值缩放 · ${props.node.id}。填写数值和正倍数后，点击节点内“计算”。`);
  const Controls = (props: ScenePackViewContext) => react.createElement('section', { className: 'number-scale-controls nodrag nopan nowheel' },
    react.createElement('button', { type: 'button', disabled: !props.execution?.enabled, onClick: () => {
      props.guard();
      const targets = props.document.execution?.links.filter(link => link.source.nodeId === props.node.id).map(link => link.target.nodeId) ?? [];
      props.execution?.run([...new Set([props.node.id, ...targets])]);
    } }, '计算'),
    props.execution?.running ? react.createElement('button', { type: 'button', onClick: () => { props.guard(); props.execution?.cancel?.(); } }, '停止') : null,
    props.execution?.error ? react.createElement('p', { role: 'alert' }, props.execution.error) : null);
  return { 'example-number-scale/scale': { settings: Settings, inline: Controls, policy: () => ({ genericSettings: true }) } };
}

export const scaleHelp = { 'example-number-scale/scale': {
  title: '缩放数值', description: '计算数值乘以倍数，保持数值类型并提供文本结果。', category: '本地数值',
  when: '需要把一个数值按正倍数缩放时。', example: '4 × 2.5 → 10；名称为“结果”时展示“结果：10”。',
  difference: '这是本地计算；不检查外部事实，不调用模型，也不把文字自动解析成数字。',
  inputLabels: { amount: '数值', factor: '正倍数', label: '结果名称' }, outputLabels: { product: '缩放后的数值', text: '结果文本' },
} };
