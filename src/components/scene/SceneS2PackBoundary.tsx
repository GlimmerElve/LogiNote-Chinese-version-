import React, { useEffect, useState } from 'react';
import { SceneS2CanvasTrial } from './SceneS2CanvasTrial';
import { loadSceneInteractionPack } from '../../services/scene/sceneInteractionPackLoader';
import { DEFAULT_PROMPT_PACK } from '../../services/scene/sceneInteractionPacks';
import { loadScene } from '../../services/scene/sceneSkillStore';
import type { SceneSpec } from '../../types';
import type { SceneInteractionPackRef } from '../../types/sceneInteractionPack';

/** Async code loading completes before creating a scene host or reading its executable capabilities. */
export function SceneS2PackBoundary(props: React.ComponentProps<typeof SceneS2CanvasTrial>) {
  // Draft callbacks update the parent during editing. They must not reload code or remount the canvas.
  const key = JSON.stringify(props.initialRequest);
  const [state, setState] = useState<{ key: string; error: string; draft?: SceneSpec | null; reference?: SceneInteractionPackRef | null; baseOnly?: boolean }>({ key: '', error: '' });
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const draft = props.initialDraft ?? (props.initialRequest.source === 'existing' ? await loadScene(props.initialRequest.sceneId || '') : null);
        const reference = draft?.interactionPack !== undefined ? draft.interactionPack
          : props.interactionPackRef !== undefined ? props.interactionPackRef
          : props.initialRequest.interactionPack !== undefined ? props.initialRequest.interactionPack : DEFAULT_PROMPT_PACK;
        if (reference) await loadSceneInteractionPack(reference);
        if (current) setState({ key, error: '', draft, reference });
      } catch (error) { if (current) setState({ key, error: error instanceof Error ? error.message : '交互包加载失败' }); }
    })();
    return () => { current = false; };
  }, [key]);
  if (state.key !== key) return <p role="status">正在加载场景交互包…</p>;
  if (state.error) return <section role="alert"><p>{state.error}</p>
    {!props.initialDraft && props.initialRequest.source !== 'existing' && <button onClick={() => setState({ key, error: '', baseOnly: true, reference: null })}>打开基础画布</button>}
    <button onClick={props.onExit}>返回</button></section>;
  return <SceneS2CanvasTrial {...props} initialRequest={state.baseOnly ? { ...props.initialRequest, source: 'custom' } : props.initialRequest}
    initialDraft={state.draft ?? props.initialDraft} interactionPackRef={state.reference} />;
}
