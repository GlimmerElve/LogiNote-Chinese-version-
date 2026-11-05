import type { ScenePackActivationServices, ScenePackViewContext } from '../../../../src/types/sceneInteractionPack';
import { EVENT_TYPES, EVENT_LABELS, CONTENT_LIMIT, isEventType } from '../domain';
import { localReact, readParameter, setParameter, nodeHint } from './shared';
export function createEventNode(services: ScenePackActivationServices) {
  const h = localReact(services).createElement;
  return function EventNode(context: ScenePackViewContext) {
    const type = readParameter(context, 'eventType'), content = readParameter(context, 'content');
    const disabled = !context.active || context.editable === false;
    const write = (id: string, value: string) => { try { setParameter(services, context, id, value); } catch (error) { context.onError(String(error)); } };
    return h('div', { className: 'fta-event-node', 'data-fta-event': isEventType(type) ? type : 'unknown' },
      h('section', { className: 'fta-event-shape', 'aria-label': '事件块' },
        h('label', { className: 'fta-event-type' }, h('span', { className: 'fta-sr-only' }, '事件类型'), h('select', { className: 'nodrag nopan nowheel', 'aria-label': '事件类型', value: typeof type === 'string' ? type : '', disabled,
          onChange: (event: { target: { value: string } }) => write('eventType', event.target.value) },
          ...EVENT_TYPES.map(value => h('option', { key: value, value }, EVENT_LABELS[value])))),
        h('label', { className: 'fta-event-content' }, h('span', { className: 'fta-sr-only' }, '内容'), h('textarea', { className: 'nodrag nopan nowheel', 'aria-label': '内容', value: typeof content === 'string' ? content : '',
          placeholder: '填写事件内容', rows: 2, maxLength: CONTENT_LIMIT, disabled,
          onDoubleClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
          onChange: (event: { target: { value: string } }) => write('content', event.target.value) }))), nodeHint(services, context));
  };
}
