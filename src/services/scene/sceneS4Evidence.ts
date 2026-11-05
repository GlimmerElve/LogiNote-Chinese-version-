import type { SceneSpec } from '../../types';
import type { DerivationCanvasState, DerivationNode } from '../../types/sceneS4';
import { s4AllowedNodeTypes } from './sceneS4Policy';

/** A status badge alone is never a mathematical receipt (including historical canvases). */
export function isS4EngineVerifiedNode(node: DerivationNode): boolean {
  const v = node.data.verification;
  return Boolean(node.data.latex?.trim() && ['pass', 'frozen'].includes(node.data.status)
    && v?.formula_correct === true && ['engine', 'premise'].includes(v.verdictSource)
    && (!v.premiseVerdict || v.premiseVerdict.legit === 'legit'));
}

/** One graph predicate for execution, metrics and completion; unrelated bad branches stay isolated. */
export function createS4ProofEvidence(spec: SceneSpec, canvas?: DerivationCanvasState) {
  const nodes = new Map((canvas?.nodes ?? []).map(node => [node.id, node]));
  const parents = new Map<string, string[]>();
  for (const edge of canvas?.edges ?? []) parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  const allowed = new Set(s4AllowedNodeTypes(spec));
  const cache = new Map<string, boolean>(), visiting = new Set<string>();
  const usablePremise = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (cache.has(id)) return cache.get(id)!;
    const node = nodes.get(id);
    if (!node || !allowed.has(node.type) || node.type === 'conclusion') return false;
    if (node.type === 'given') return !(parents.get(id)?.length) && (Array.isArray(node.data.entries)
      ? node.data.entries.some(entry => typeof entry.symbolic === 'string' && Boolean(entry.symbolic.trim()))
      : Boolean(node.data.latex?.trim() || node.data.note?.trim()));
    if (!isS4EngineVerifiedNode(node)) return false;
    visiting.add(id);
    const valid = (parents.get(id) ?? []).every(usablePremise);
    visiting.delete(id); cache.set(id, valid); return valid;
  };
  const valid = [...nodes.values()].filter(node => (node.type === 'formula' || node.type === 'conclusion')
    && allowed.has(node.type) && isS4EngineVerifiedNode(node) && (parents.get(node.id) ?? []).every(usablePremise));
  return { usablePremise, hasFormula: valid.length > 0,
    conclusions: valid.filter(node => node.type === 'conclusion' && Boolean(parents.get(node.id)?.length)) };
}
