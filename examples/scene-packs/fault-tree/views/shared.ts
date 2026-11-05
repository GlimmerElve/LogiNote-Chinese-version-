import type { ScenePackActivationServices, ScenePackViewContext } from '../../../../src/types/sceneInteractionPack';
import { literal, readFaultTreeModel } from '../model';
export interface LocalReact { createElement(type: string | ((props: any) => unknown), props: Record<string, unknown> | null, ...children: unknown[]): unknown }
export const localReact = (services: ScenePackActivationServices) => services.ui.react as LocalReact;
export const readParameter = (context: ScenePackViewContext, id: string) => literal(context.node, id);
export function setParameter(services: ScenePackActivationServices, context: ScenePackViewContext, id: string, value: string) {
  context.guard(); if (!context.active || context.editable === false) throw new Error('当前事件或逻辑门不可编辑');
  context.onInputChange(id, { kind: 'literal', value }, services.editor.parameterSource(context.document, context.node.id, id).key);
}
export function nodeHint(services: ScenePackActivationServices, context: ScenePackViewContext) {
  const issue = readFaultTreeModel(context.document).issues.find(item => item.nodeId === context.node.id);
  return issue ? localReact(services).createElement('small', { className: 'fta-node-hint', role: 'status' }, issue.message) : null;
}
