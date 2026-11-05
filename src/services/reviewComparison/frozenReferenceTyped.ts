import type { FrozenReferenceItemObservation, FrozenReferenceShadowInput } from './frozenReferenceShadow';
import { buildFrozenReferenceReadableInput, readableReferenceId, readableUserId,
  type FrozenReferenceReadableInput } from './frozenReferenceReadable';
import { referenceNodeAnchor, validateFrozenOutcomeWitness } from './frozenReferenceEvidence';

export const FROZEN_REFERENCE_TYPED_INPUT_LIMIT = 60000;
export class FrozenReferenceTypedError extends Error {
  constructor(code: string, readonly itemId?: string, readonly field = 'items') { super(code); }
}
const fail = (code: string, itemId?: string, field?: string): never => { throw new FrozenReferenceTypedError(code, itemId, field); };
function closed(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join('|') !== [...keys].sort().join('|')) throw new Error('invalid_typed_output');
  return raw as Record<string, any>;
}
function dense(raw: unknown, maximum: number): any[] {
  if (!Array.isArray(raw) || raw.length > maximum || Object.keys(raw).length !== raw.length
    || Object.keys(raw).some((key, index) => key !== String(index))) throw new Error('invalid_typed_evidence');
  return raw;
}

type TypedItem = FrozenReferenceReadableInput['frames'][number]['items'][number] & {
  evidenceMode: 'statement' | 'inference';
  scopeRule: 'same_object_property_conditions_time_certainty';
  supportRule: 'complete_required_nodes_and_relation_meanings';
};
export interface FrozenReferenceTypedInput extends Omit<FrozenReferenceReadableInput, 'version' | 'protocol' | 'frames'> {
  version: 3; protocol: 'review-frozen-reference-typed-v3';
  frames: (Omit<FrozenReferenceReadableInput['frames'][number], 'items'> & { items: TypedItem[] })[];
}
export interface FrozenReferenceTypedInputV4 extends Omit<FrozenReferenceTypedInput, 'version' | 'protocol'> {
  version: 4; protocol: 'review-frozen-reference-typed-v4';
}
type TypedVersion = 3 | 4;

/** No new authority, retrieval, clipping, or proposition guessed by the host. */
function buildTypedInput(input: FrozenReferenceShadowInput, version: TypedVersion): FrozenReferenceTypedInput | FrozenReferenceTypedInputV4 {
  const readable = buildFrozenReferenceReadableInput(input);
  const frames = readable.frames.map(frame => ({ ...frame, items: frame.items.map(item => ({ ...item,
    evidenceMode: item.criterionId === 'inference_link' ? 'inference' as const : 'statement' as const,
    scopeRule: 'same_object_property_conditions_time_certainty' as const,
    supportRule: 'complete_required_nodes_and_relation_meanings' as const })) }));
  const content = { ...readable, frames,
    user: { ...readable.user, edges: frames.some(frame => frame.items.some(item => item.evidenceMode === 'inference')) ? readable.user.edges : [] } };
  const result: FrozenReferenceTypedInput | FrozenReferenceTypedInputV4 = version === 3
    ? { ...content, version: 3, protocol: 'review-frozen-reference-typed-v3' }
    : { ...content, version: 4, protocol: 'review-frozen-reference-typed-v4' };
  if (JSON.stringify(result).length > FROZEN_REFERENCE_TYPED_INPUT_LIMIT) fail('typed_context_budget_exceeded', undefined, 'context');
  return result;
}
/** Frozen strict legacy v3 contract; never implicitly upgraded to v4. */
export function buildFrozenReferenceTypedInput(input: FrozenReferenceShadowInput): FrozenReferenceTypedInput {
  return buildTypedInput(input, 3) as FrozenReferenceTypedInput;
}
export function buildFrozenReferenceTypedInputV4(input: FrozenReferenceShadowInput): FrozenReferenceTypedInputV4 {
  return buildTypedInput(input, 4) as FrozenReferenceTypedInputV4;
}

/**
 * v3 declares one explicit semantic scope assertion, not five repeated axes.
 * scope=same means ALL object/property/conditions/time/certainty were checked,
 * including absence of additional restrictions. It is NOT inferred from a
 * verdict, missing field, not_applicable, or an ID match. Structural obligations
 * come from the original contract; no model can select a weaker standard.
 */
export function readFrozenReferenceTypedOutput(raw: unknown, original: FrozenReferenceShadowInput) {
  return readTypedOutput(raw, original, 3);
}
/** v4 alone allows absent non-contradiction opposition, not absent semantic assertions. */
export function readFrozenReferenceTypedOutputV4(raw: unknown, original: FrozenReferenceShadowInput) {
  return readTypedOutput(raw, original, 4);
}
function readTypedOutput(raw: unknown, original: FrozenReferenceShadowInput, version: TypedVersion) {
  const input = structuredClone(original), readable = buildTypedInput(input, version);
  let root: Record<string, any>;
  try { root = closed(raw, ['version', 'evaluationId', 'contractHash', 'items']); }
  catch { return fail('invalid_typed_output'); }
  if (root.version !== version || root.evaluationId !== input.evaluationId || root.contractHash !== input.reference.contractHash)
    fail('invalid_typed_output');
  const expected = readable.frames.flatMap((frame, index) => frame.items.map(item => ({ frame, item,
    originalFrame: input.reference.frames[index], originalItem: input.reference.frames[index].items.find(value => readableReferenceId(input.reference.frames[index].frameId, 'item', value.itemId) === item.itemId)! })));
  let rows: any[];
  try { rows = dense(root.items, expected.length); } catch { return fail('invalid_typed_output'); }
  if (rows.length !== expected.length) fail('incomplete_shadow_items');
  const seen = new Set<string>();
  const observations: FrozenReferenceItemObservation[] = rows.map(value => {
    const selected = expected.find(entry => entry.item.itemId === value?.itemId);
    if (!selected || seen.has(selected.item.itemId)) return fail('invalid_typed_output');
    seen.add(selected.item.itemId);
    const { item, originalFrame: frame, originalItem: fixed } = selected;
    let field = 'item';
    try {
      const requiresOpposition = version === 3 || value?.verdict === 'contradicted' || Object.hasOwn(value, 'opposition');
      const row = closed(value, ['itemId', 'verdict', 'scope', 'matches', ...(requiresOpposition ? ['opposition'] : []),
        ...(item.evidenceMode === 'inference' ? ['edgeIds', 'direction', 'premises'] : [])]);
      field = 'verdict';
      if (!['supported', 'contradicted', 'partial', 'unverifiable'].includes(row.verdict)) throw new Error('invalid_shadow_item');
      field = 'scope';
      if (!['same', 'different', 'unknown'].includes(row.scope)) throw new Error('invalid_typed_scope');
      if (['supported', 'contradicted'].includes(row.verdict) && row.scope !== 'same') throw new Error('unsubstantiated_shadow_verdict');
      field = 'matches';
      const pairs = dense(row.matches, 48), keys = new Set<string>();
      const mappings = pairs.map(value => {
        const pair = closed(value, ['claimId', 'nodeId', 'referenceQuoteId', 'referenceQuote']);
        const claim = input.graph.claims.find(claim => readableUserId(claim.id) === pair.claimId);
        const nodeId = fixed.nodeIds.find(id => readableReferenceId(frame.frameId, 'node', id) === pair.nodeId);
        const key = JSON.stringify([pair.claimId, pair.nodeId]);
        if (!claim || !nodeId || keys.has(key)) throw new Error('invalid_typed_evidence');
        keys.add(key);
        const anchor = referenceNodeAnchor(input, frame.frameId, nodeId, pair.referenceQuoteId, pair.referenceQuote);
        // Minimum role separation, not proof of semantic equivalence. A general
        // premise/rule cannot impersonate the explicit outcome of an inference.
        if (item.evidenceMode === 'inference' && row.verdict === 'supported' && anchor.role === 'conclusion'
          && !['conclusion', 'fact', 'counterexample'].includes(claim.role))
          throw new Error('reference_role_mismatch');
        // v4 distinguishes concrete observed/derived facts from general rules.
        // A prior concrete conclusion may become this inference's premise,
        // without replaying its earlier proof as a new scoring obligation.
        // This checks declared responsibilities, NOT semantic certification.
        if (version === 4 && item.evidenceMode === 'inference' && row.verdict === 'supported' && anchor.role === 'fact'
          && frame.groups.some(group => group.premiseNodeIds.includes(nodeId))
          && !['fact', 'counterexample', 'conclusion'].includes(claim.role))
          throw new Error('reference_role_mismatch');
        return { claimId: claim.id, nodeId };
      });
      const nodeIds = [...new Set(mappings.map(pair => pair.nodeId))];
      field = 'opposition';
      if (row.verdict === 'contradicted') {
        const witness = closed(row.opposition, ['claimId', 'nodeId', 'referenceQuoteId', 'referenceQuote', 'userOutcome', 'referenceOutcome']);
        const pair = pairs.find(pair => pair.claimId === witness.claimId && pair.nodeId === witness.nodeId
          && pair.referenceQuoteId === witness.referenceQuoteId && pair.referenceQuote === witness.referenceQuote);
        const mapping = pair && mappings.find(mapping => readableUserId(mapping.claimId) === witness.claimId
          && readableReferenceId(frame.frameId, 'node', mapping.nodeId) === witness.nodeId);
        if (!mapping) throw new Error('invalid_opposition_witness');
        const claim = input.graph.claims.find(claim => claim.id === mapping.claimId)!;
        const anchor = referenceNodeAnchor(input, frame.frameId, mapping.nodeId, witness.referenceQuoteId, witness.referenceQuote);
        validateFrozenOutcomeWitness(input.answer.text.slice(claim.start, claim.end), anchor.quote, witness.userOutcome, witness.referenceOutcome);
        if (item.evidenceMode === 'inference') {
          const conclusions = new Set([...frame.groups.map(group => group.conclusionNodeId),
            ...frame.nodes.filter(node => node.role === 'conclusion').map(node => node.id)]);
          if (!conclusions.has(mapping.nodeId)) throw new Error('invalid_opposition_witness');
        }
      } else if ((version === 3 || Object.hasOwn(row, 'opposition')) && row.opposition !== null)
        throw new Error('invalid_opposition_witness');
      field = 'reasoning';
      const selectedEdges = item.evidenceMode === 'inference' ? dense(row.edgeIds, input.graph.edges.length).map(id => {
        const edge = input.graph.edges.find(edge => readableUserId(edge.id) === id);
        if (!edge) throw new Error('invalid_typed_evidence');
        return edge;
      }) : [];
      if (new Set(selectedEdges.map(edge => edge.id)).size !== selectedEdges.length) throw new Error('invalid_typed_evidence');
      const direction = item.evidenceMode === 'inference' ? row.direction : 'not_required';
      const premises = item.evidenceMode === 'inference' ? row.premises : 'not_required';
      if (!['correct', 'reverse', 'undetermined', 'not_required'].includes(direction)
        || !['complete', 'missing', 'not_required'].includes(premises)) throw new Error('invalid_shadow_item');
      // Relations are immutable obligations, not a model-selectable subset.
      // supported explicitly asserts complete meanings above; the old host
      // still verifies required endpoints, all nodes and real user direction.
      const relationIds = row.verdict === 'supported' ? [...fixed.relationIds] : [];
      const axis = row.scope === 'same' ? 'match' as const : row.scope === 'different' ? 'different' as const : 'unknown' as const;
      return { frameId: frame.frameId, itemId: fixed.itemId, verdict: row.verdict,
        claimIds: [...new Set([...mappings.map(pair => pair.claimId), ...selectedEdges.flatMap(edge => [edge.source, edge.target])])],
        edgeIds: selectedEdges.map(edge => edge.id), nodeIds, relationIds, nodeMappings: mappings,
        axes: { object: axis, metric: axis, condition: axis, time: axis, certainty: axis }, direction, premises };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_typed_output';
      const known = ['invalid_typed_output', 'invalid_typed_scope', 'invalid_typed_evidence', 'invalid_shadow_item',
        'unsubstantiated_shadow_verdict', 'invalid_reference_node_anchor', 'invalid_exact_evidence', 'invalid_opposition_witness', 'reference_role_mismatch'];
      return fail(known.includes(code) ? code : 'invalid_typed_output', item.itemId, field);
    }
  });
  return { version: 1, evaluationId: input.evaluationId, contractHash: input.reference.contractHash, items: observations };
}
