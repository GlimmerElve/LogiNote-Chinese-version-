import type { ArgumentReferenceDisclosureContext } from '../argumentContext/referenceDisclosure';
import { ARGUMENT_CONTEXT_ROLES, type ArgumentContextNode } from '../argumentContext/types';
import type { FrozenReferenceShadowInput } from './frozenReferenceShadow';

const SOURCE_TEXT_LIMIT = 60000;
export const FROZEN_REFERENCE_PROPOSITION_ANCHOR_LIMIT = 1600;
export const FROZEN_REFERENCE_OUTCOME_WITNESS_LIMIT = 320;
const fail = (code: string): never => { throw new Error(code); };

export interface FrozenExactEvidenceSpan { start: number; end: number; quote: string }

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/**
 * Literal provenance only. No trim, normalization, keyword cutting, semantic
 * role inference or repair is applied to the selected text. Repeated wording,
 * including overlapping occurrences, requires a future explicit coordinate
 * protocol rather than an arbitrary first-occurrence guess.
 */
export function exactUniqueSpan(text: string, quote: unknown,
  maximum = FROZEN_REFERENCE_PROPOSITION_ANCHOR_LIMIT): FrozenExactEvidenceSpan {
  if (typeof text !== 'string' || text.length > SOURCE_TEXT_LIMIT || !wellFormedUtf16(text)
    || typeof quote !== 'string' || !quote.trim() || !wellFormedUtf16(quote)
    || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > SOURCE_TEXT_LIMIT
    || quote.length > maximum) return fail('invalid_exact_evidence');
  const start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) return fail('invalid_exact_evidence');
  return { start, end: start + quote.length, quote };
}

export interface FrozenReferencePropositionAnchorSelection {
  frameId: string; nodeId: string; quoteId: string; referenceQuote: unknown;
  /** If supplied by the host, must be the node's stored role, not a new model role. */
  role?: ArgumentContextNode['role'];
}
export interface FrozenReferencePropositionAnchor extends FrozenExactEvidenceSpan {
  frameId: string; nodeId: string; role: ArgumentContextNode['role']; quoteId: string;
  source: ArgumentReferenceDisclosureContext['frames'][number]['source']; sourceKey: string;
  /** Entire retained evidence quotation: a selected subspan is never its replacement. */
  context: { start: number; end: number; text: string };
  semanticTruth: 'not_certified';
}

/**
 * Resolve an explicit model-selected proposition anchor within one previously
 * authenticated, frozen node. This does NOT authenticate a self-supplied frame
 * bundle and does NOT certify that the selected clause expresses the stored
 * role. The host still checks its retained receipt, and the semantic matcher
 * must inspect the whole quotation (including qualifiers, negation and rules).
 * Existing stored node evidence/contracts remain unchanged.
 */
export function validateFrozenReferencePropositionAnchor(context: ArgumentReferenceDisclosureContext,
  selection: FrozenReferencePropositionAnchorSelection): FrozenReferencePropositionAnchor {
  const code = 'invalid_reference_node_anchor';
  if (!context || context.version !== 1 || context.protocol !== 'review-frozen-reference-context-v1'
    || context.coverage !== 'complete_required' || !selection || typeof selection !== 'object'
    || Array.isArray(selection) || Object.keys(selection).some(key => !['frameId', 'nodeId', 'quoteId', 'referenceQuote', 'role'].includes(key))
    || ['frameId', 'nodeId', 'quoteId', 'referenceQuote'].some(key => !Object.hasOwn(selection, key))
    || [selection.frameId, selection.nodeId, selection.quoteId].some(id => typeof id !== 'string' || !id.trim() || id.length > 300)
    || !Array.isArray(context.frames) || !Array.isArray(context.quotes)) return fail(code);
  const frames = context.frames.filter(frame => frame.frameId === selection.frameId);
  if (frames.length !== 1 || !Array.isArray(frames[0].nodes)) return fail(code);
  const frame = frames[0], nodes = frame.nodes.filter(node => node.id === selection.nodeId);
  if (nodes.length !== 1 || !ARGUMENT_CONTEXT_ROLES.includes(nodes[0].role)
    || Object.hasOwn(selection, 'role') && selection.role !== nodes[0].role
    || !Array.isArray(nodes[0].quoteIds) || new Set(nodes[0].quoteIds).size !== nodes[0].quoteIds.length
    || !nodes[0].quoteIds.includes(selection.quoteId)) return fail(code);
  const quotes = context.quotes.filter(quote => quote.quoteId === selection.quoteId);
  if (quotes.length !== 1) return fail(code);
  const quote = quotes[0];
  if (!Number.isSafeInteger(quote.start) || !Number.isSafeInteger(quote.end) || quote.start < 0 || quote.end <= quote.start
    || typeof quote.text !== 'string' || quote.end - quote.start !== quote.text.length
    || typeof quote.sourceKey !== 'string' || !quote.sourceKey.trim() || quote.sourceKey.length > 300
    || !frame.source || frame.source.kind !== 'knowledge-note') return fail(code);
  let span: FrozenExactEvidenceSpan;
  try { span = exactUniqueSpan(quote.text, selection.referenceQuote); } catch { return fail(code); }
  const start = quote.start + span.start, end = quote.start + span.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return fail(code);
  return { frameId: frame.frameId, nodeId: nodes[0].id, role: nodes[0].role, quoteId: quote.quoteId,
    source: structuredClone(frame.source), sourceKey: quote.sourceKey, start, end, quote: span.quote,
    context: { start: quote.start, end: quote.end, text: quote.text }, semanticTruth: 'not_certified' };
}

/** Canonical IDs only; model-facing namespaced IDs are decoded by the caller. */
export function referenceNodeAnchor(input: FrozenReferenceShadowInput, frameId: string, nodeId: string,
  quoteId: string, referenceQuote: unknown, role?: ArgumentContextNode['role']): FrozenReferencePropositionAnchor {
  return validateFrozenReferencePropositionAnchor(input.reference, {
    frameId, nodeId, quoteId, referenceQuote, ...(role === undefined ? {} : { role }),
  });
}

function normalizeOutcome(value: string): string {
  // This only rejects cosmetic variants of the SAME literal result. It does not
  // turn different strings, synonyms, numeric differences or polarity words into
  // a machine-certified opposition. Numeric signs and internal units are kept.
  let normalized = value.normalize('NFKC').replace(/\s/gu, '').toLowerCase();
  const edgePunctuation = new Set([...`。!！?？,，;；:：、\"'“”‘’「」『』()（）【】[]《》〈〉`]);
  // Textual sentence periods/ellipsis are cosmetic, but decimal points touching
  // digits (including '.5' and '1.') must not lose their numeric meaning.
  while (edgePunctuation.has(normalized[0]) || normalized.startsWith('.') && !/[0-9]/u.test(normalized[1] ?? '')) {
    normalized = normalized.slice(1);
  }
  while (edgePunctuation.has(normalized.at(-1)!) || normalized.endsWith('.') && !/[0-9]/u.test(normalized.at(-2) ?? '')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export interface FrozenReferenceOppositionWitness {
  user: FrozenExactEvidenceSpan & { context: string };
  reference: FrozenExactEvidenceSpan & { context: string };
  comparison: 'different_literal_values_only'; semanticTruth: 'not_certified';
}

/**
 * A necessary provenance guard, NOT a contradiction classifier. Both outcome
 * values must be exact, unambiguous original subspans and cannot be cosmetic
 * variants of one another. The complete contexts are retained for semantic
 * review; a model can still misread negation, modality or the same-condition
 * requirement, so the caller may not treat this return value as factual truth.
 */
export function validateFrozenReferenceOppositionWitness(userText: string, referenceText: string,
  userOutcome: unknown, referenceOutcome: unknown): FrozenReferenceOppositionWitness {
  const code = 'invalid_opposition_witness';
  let user: FrozenExactEvidenceSpan, reference: FrozenExactEvidenceSpan;
  try {
    user = exactUniqueSpan(userText, userOutcome, FROZEN_REFERENCE_OUTCOME_WITNESS_LIMIT);
    reference = exactUniqueSpan(referenceText, referenceOutcome, FROZEN_REFERENCE_OUTCOME_WITNESS_LIMIT);
  } catch { return fail(code); }
  const left = normalizeOutcome(user.quote), right = normalizeOutcome(reference.quote);
  if (!left || !right || left === right) return fail(code);
  return { user: { ...user, context: userText }, reference: { ...reference, context: referenceText },
    comparison: 'different_literal_values_only', semanticTruth: 'not_certified' };
}

export const validateFrozenOutcomeWitness = validateFrozenReferenceOppositionWitness;
