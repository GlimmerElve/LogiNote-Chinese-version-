import React, { useEffect, useRef, useState } from 'react';
import type { SceneInteractionPackRef, ScenePackMaterialScope, ScenePackViewContext } from '../../types/sceneInteractionPack';
import { sceneInteractionPacks } from '../../services/scene/sceneInteractionPacks';
import { readScenePackViewPolicy } from '../../services/scene/sceneInteractionPackProtocol';
import { s2BuiltinPluginRegistry } from '../../services/scene/sceneS2PluginRegistry';
import { createScenePackMaterialScope } from '../../services/scene/sceneInteractionPackMaterials';

export function scenePackViewPolicy(ref: SceneInteractionPackRef | null | undefined, context: ScenePackViewContext) {
  const policy = ref ? sceneInteractionPacks.resolve(ref).views?.[`${context.node.pluginId}/${context.node.capabilityId}`]?.policy : undefined;
  if (!policy) return undefined;
  try { return readScenePackViewPolicy(policy(context), s2BuiltinPluginRegistry().capability(context.node)); }
  catch (error) {
    // Keep the generic canvas usable and show the rejected package policy on its node.
    // Calling onError here would update parent React state during render.
    return { annotation: `交互包视图接口错误：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function scenePackView(ref: SceneInteractionPackRef | null | undefined, node: ScenePackViewContext['node'], slot: 'settings' | 'inline' | 'node') {
  if (!ref) return undefined;
  const value = sceneInteractionPacks.resolve(ref).views?.[`${node.pluginId}/${node.capabilityId}`]?.[slot];
  return typeof value === 'function' ? value as React.ComponentType<ScenePackViewContext> : undefined;
}
export function scenePackHasCustomView(ref: SceneInteractionPackRef | null | undefined, node: ScenePackViewContext['node']) {
  return !!(['node', 'inline', 'settings'] as const).some(slot => scenePackView(ref, node, slot));
}
/** The function comes only from an installed package, never from scene JSON or an Agent reply. */
export function scenePackNodeDoubleClick(ref: SceneInteractionPackRef | null | undefined, context: ScenePackViewContext) {
  const handler = ref ? sceneInteractionPacks.resolve(ref).views?.[`${context.node.pluginId}/${context.node.capabilityId}`]?.onDoubleClick : undefined;
  if (!handler) return undefined;
  return () => {
    context.guard();
    if (!context.active || context.editable === false) throw new Error('当前节点不可编辑');
    handler(context);
  };
}
export function ScenePackView({ reference, slot, context }: { reference?: SceneInteractionPackRef | null; slot: 'settings' | 'inline' | 'node'; context: ScenePackViewContext }) {
  const Component = scenePackView(reference, context.node, slot);
  const live = useRef<ScenePackViewContext | null>(context); live.current = context;
  useEffect(() => { live.current = context; return () => { live.current = null; }; }, [context]);
  const materialOwner = JSON.stringify([reference?.id, reference?.version, context.materialScopeKey ?? context.node.id, slot]);
  const needsMaterials = !!Component && !!reference && sceneInteractionPacks.resolve(reference).manifest.protocolVersion === 2;
  const [materialState, setMaterialState] = useState<{ owner: string; scope?: ScenePackMaterialScope; error?: string; lifetime: { active: boolean } }>();
  useEffect(() => {
    if (!needsMaterials || !reference || !context.active) return;
    let scope: ScenePackMaterialScope | undefined;
    const lifetime = { active: true };
    try {
      scope = createScenePackMaterialScope(reference);
      if (!scope) throw new Error('当前包的物料服务尚未就绪');
      setMaterialState({ owner: materialOwner, scope, lifetime });
    } catch (error) { setMaterialState({ owner: materialOwner, error: error instanceof Error ? error.message : String(error), lifetime }); }
    return () => { lifetime.active = false; scope?.dispose(); };
  }, [materialOwner, needsMaterials, context.active]);
  const check = () => { if (live.current !== context) throw new Error('组件视图已变化，请在当前画布重新操作'); };
  if (needsMaterials) {
    if (!context.active || materialState?.owner !== materialOwner || !materialState.lifetime.active) return null;
    if (materialState.error) return <div role="alert">物料接口错误：{materialState.error}</div>;
  }
  return Component ? <Component {...context}
    materials={needsMaterials ? materialState?.scope : undefined}
    onDocumentChange={document => { check(); context.onDocumentChange(document); }}
    onInputChange={(port, binding, source) => { check(); context.onInputChange(port, binding, source); }}
    navigate={target => { check(); context.navigate(target); }}
    execution={context.execution ? { ...context.execution, run: targets => { check(); context.execution!.run(targets); },
      ...(context.execution.cancel ? { cancel: () => { check(); context.execution!.cancel!(); } } : {}) } : undefined}
    focusSettings={() => { check(); context.focusSettings(); }}
    onNotice={message => { if (live.current === context) context.onNotice(message); }}
    onError={message => { if (live.current === context) context.onError(message); }} /> : null;
}
