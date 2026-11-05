import type { ScenePackActivationServices, ScenePackCapabilityViews } from '../../../src/types/sceneInteractionPack';
import { PLUGIN_ID } from './domain';
import { createEventNode } from './views/EventNode';
import { createGateNode, toggleGate } from './views/GateNode';
export function createViews(services: ScenePackActivationServices): ScenePackCapabilityViews {
  return {
    [`${PLUGIN_ID}/event`]: { node: createEventNode(services), policy: () => ({ genericSettings: false, showResult: false, showStatus: false,
      inputAnchors: { condition: { side: 'bottom' } }, outputAnchors: { event: { side: 'top' } } }) },
    [`${PLUGIN_ID}/gate`]: { node: createGateNode(services), onDoubleClick: context => toggleGate(services, context), policy: () => ({ genericSettings: false, showResult: false, showStatus: false,
      inputAnchors: { left: { side: 'bottom', offset: 0.25 }, right: { side: 'bottom', offset: 0.75 } }, outputAnchors: { condition: { side: 'top' } } }) },
  };
}
export const help = {
  [`${PLUGIN_ID}/event`]: { title: '事件', description: '只填写事件类型和内容。', category: '事故树', when: '描述顶事件、中间事件或基本事件。',
    example: '基本事件 A 与 B 经一个与门连接顶事件 C。', difference: '事件类型不是发生状态；同文事件不自动合并。', inputLabels: { condition: '下级逻辑门' }, outputLabels: { event: '事件' } },
  [`${PLUGIN_ID}/gate`]: { title: '逻辑门', description: '默认与门，双击切换与门/或门；两个接入点均可继续接入多个事件。', category: '事故树', when: '表达2至32个下级事件对一个上级事件的组合条件。',
    example: 'C = AND(A, B, D) 表示所有接入事件发生时 C 发生。', difference: '至少两个不同事件，合计最多32个；所有输入合并运算。只表达逻辑结构，不计算概率，不认定现实事件已发生。', inputLabels: { left: '事件接入点1（可多连）', right: '事件接入点2（可多连）' }, outputLabels: { condition: '组合条件' } },
};
