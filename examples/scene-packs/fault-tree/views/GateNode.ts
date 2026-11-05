import type { ScenePackActivationServices, ScenePackViewContext } from '../../../../src/types/sceneInteractionPack';
import { GATE_INPUT_PORTS, isGateType } from '../domain';
import { localReact, readParameter, setParameter, nodeHint } from './shared';
export function toggleGate(services: ScenePackActivationServices, context: ScenePackViewContext) {
  const type = readParameter(context, 'gateType'); if (!isGateType(type)) throw new Error('门类型无效，请修复为 AND 或 OR');
  setParameter(services, context, 'gateType', type === 'AND' ? 'OR' : 'AND');
}
export function createGateNode(services: ScenePackActivationServices) {
  const h = localReact(services).createElement;
  return function GateNode(context: ScenePackViewContext) {
    const type = readParameter(context, 'gateType'), and = type === 'AND', disabled = !context.active || context.editable === false;
    const count = new Set((context.document.execution?.links ?? [])
      .filter(link => link.target.nodeId === context.node.id && GATE_INPUT_PORTS.some(id => id === link.target.portId))
      .map(link => link.source.nodeId)).size;
    const label = and ? '与门' : '或门', next = and ? '或门' : '与门';
    return h('div', { className: 'fta-gate-node', 'data-fta-gate': type },
      h('div', { className: 'fta-gate-symbol', role: 'button', tabIndex: disabled ? -1 : 0, 'aria-disabled': disabled,
        'aria-label': `逻辑门：${label}，双击切换为${next}`, title: `双击切换为${next}；也可按 Enter 或空格`,
        onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
          if (!['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); if (disabled) return;
          try { toggleGate(services, context); } catch (error) { context.onError(String(error)); }
        } },
        h('svg', { width: 88, height: 80, viewBox: '0 0 80 72', 'aria-hidden': true },
          h('path', { d: and ? 'M12 64V34a28 28 0 0 1 56 0v30Z' : 'M12 64Q23 44 18 30Q20 14 40 6Q60 14 62 30Q57 44 68 64Q40 50 12 64Z',
            fill: 'var(--fta-surface)', stroke: 'currentColor', strokeWidth: 2 }),
          h('text', { x: 40, y: 43, textAnchor: 'middle', fontSize: 24, fill: 'currentColor' }, and ? '·' : '+')),
        h('span', { className: 'fta-gate-label' }, label)),
      h('small', { className: 'fta-gate-inputs', title: '两个底部接入点均可多连，合计最多32个不同事件' }, `${count} 个输入 · 可继续接线`), nodeHint(services, context));
  };
}
