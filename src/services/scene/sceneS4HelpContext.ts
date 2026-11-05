import type { SceneRunState, SceneSpec } from '../../types';
import { collectAncestors } from '../../modules/derivationCanvas/utils/branchGraph';
import { s4GoalInputKey } from './sceneS4Goal';

/** A card refers to the branch seen when it was generated, not whichever node is selected later. */
export function s4HelpInputKey(spec: SceneSpec, run: SceneRunState, nodeId: string | null): string {
  const ids = new Set(nodeId ? [nodeId,...collectAncestors(nodeId,run.canvas?.edges ?? [])] : run.canvas?.nodes.map(node=>node.id));
  return JSON.stringify({taskKey:s4GoalInputKey(spec,run,nodeId ?? ''),nodeId,
    nodes:(run.canvas?.nodes ?? []).filter(node=>ids.has(node.id)).map(({id,type,data})=>({id,type,
      latex:data.latex,note:data.note,entries:data.entries,verification:data.verification ? {
        formula_correct:data.verification.formula_correct,verdictSource:data.verification.verdictSource,premiseVerdict:data.verification.premiseVerdict,
      } : undefined})).sort((a,b)=>a.id.localeCompare(b.id)),
    edges:(run.canvas?.edges ?? []).filter(edge=>ids.has(edge.target)).map(({source,target})=>({source,target}))
      .sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target)),
  });
}
