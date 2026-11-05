import { argumentContextHash } from '../argumentContext/hash';
import { ARGUMENT_PROJECTION_BUILD_LIMITS } from '../argumentContext/buildTypes';
import { prepareSourcePropositionReviewInput, validateSourcePropositionContextSnapshot,
  SOURCE_PROPOSITION_LIMITS, type SourcePropositionContext, type SourcePropositionDraft } from './sourcePropositionAnchors';
import { sourcePropositionRequiredNodeIds } from './sourcePropositionAnchors';

export const SOURCE_PROPOSITION_SELECTION_PROTOCOL = 'review-source-proposition-selection-v2' as const;
export const SOURCE_PROPOSITION_PARENT_SELECTION_PROTOCOL = 'review-source-proposition-parent-selection-v3' as const;
/** A parent menu is not a candidate list: all 64 nodes may each own 16 parents. */
export const SOURCE_PROPOSITION_SELECTION_PARENT_CHOICES_LIMIT = ARGUMENT_PROJECTION_BUILD_LIMITS.nodes * ARGUMENT_PROJECTION_BUILD_LIMITS.quoteReferences;
export interface SourcePropositionSelectionParentChoice {
  parentChoiceId: string; nodeId: string; quoteId: string; text: string;
}
export interface SourcePropositionSelectionInput {
  version: 2; protocol: 'review-source-proposition-selection-input-v2'; contextHash: string;
  parentChoices: SourcePropositionSelectionParentChoice[];
}
export interface SourcePropositionSelection {
  version: 2; protocol: typeof SOURCE_PROPOSITION_SELECTION_PROTOCOL; contextHash: string;
  anchors: { parentChoiceId: string; text: string }[];
}
/** Explicit whole-owned-parent protocol. Unlike v2 it cannot request a substring. */
export interface SourcePropositionParentSelection {
  version: 3; protocol: typeof SOURCE_PROPOSITION_PARENT_SELECTION_PROTOCOL; contextHash: string;
  anchors: { parentChoiceId: string }[];
}
export interface SourcePropositionParentSelectionInput {
  version: 3; protocol: 'review-source-proposition-parent-selection-input-v3'; contextHash: string;
  parentChoices: SourcePropositionSelectionParentChoice[];
}
export class SourcePropositionSelectionError extends Error {}
const fail = (code: string): never => { throw new SourcePropositionSelectionError(code); };
const invalid = 'invalid_source_proposition_selection';
const contextInvalid = 'source_proposition_selection_context_invalid';
const budgetExceeded = 'source_proposition_selection_budget_exceeded';
const contextFields = ['version', 'protocol', 'source', 'sourceBindingHash', 'buildId', 'resultHash', 'structureHash',
  'sourceKey', 'scope', 'scopeHash', 'canonicalText', 'quotes', 'projection', 'qualification'];

function utf16(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (point >= 0xdc00 && point <= 0xdfff) return false;
  }
  return true;
}
/** Inspect descriptors before cloning/serialization; never evaluate a data getter. */
function plain(value: unknown, code: string, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 64) fail(code);
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') { if (!utf16(value)) fail(code); return; }
  if (!value || typeof value !== 'object' || ancestors.has(value)) return fail(code);
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length > 2049 || keys.some(key => typeof key !== 'string')) fail(code);
  if (array) {
    if (value.length > 2048 || keys.length !== value.length + 1
      || Object.keys(value).some((key, index) => key !== String(index))) fail(code);
  }
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || (key !== 'length' || !array) && !descriptor.enumerable) fail(code);
    if (key !== 'length' || !array) plain(descriptor.value, code, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
function closed(value: unknown, fields: readonly string[], code = invalid): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(code);
  const keys = Object.keys(value).sort(), expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(code);
}
function budget(value: unknown, maximum: number): void { if (JSON.stringify(value).length > maximum) fail(budgetExceeded); }
function contextSnapshot(context: SourcePropositionContext): SourcePropositionContext {
  plain(context, contextInvalid); closed(context, contextFields, contextInvalid);
  budget(context, SOURCE_PROPOSITION_LIMITS.context);
  return structuredClone(context);
}

/** Mechanical menu only. It does not authenticate eligibility, semantic truth or
 * current host publication. The explicit factory must receive a prevalidated context.
 * This synchronous function performs no model calls and cannot be counted as dispatch. */
export function buildSourcePropositionSelectionParentChoices(context: SourcePropositionContext): SourcePropositionSelectionParentChoice[] {
  const captured = contextSnapshot(context), choices: SourcePropositionSelectionParentChoice[] = [];
  if (!captured.projection || !Array.isArray(captured.projection.nodes) || !Array.isArray(captured.quotes)
    || !captured.projection.nodes.length || !captured.quotes.length) fail(contextInvalid);
  const nodeIds = new Set<string>(), quoteIds = new Set<string>();
  for (const quote of captured.quotes) {
    if (!quote || typeof quote.quoteId !== 'string' || quoteIds.has(quote.quoteId) || !quote.evidence) fail(contextInvalid);
    quoteIds.add(quote.quoteId);
  }
  const required = new Set(sourcePropositionRequiredNodeIds(captured));
  for (const node of captured.projection.nodes.filter(node => required.has(node.id))) {
    if (!node || typeof node.id !== 'string' || nodeIds.has(node.id) || !Array.isArray(node.evidence)) fail(contextInvalid);
    nodeIds.add(node.id); let owned = 0;
    for (const quote of captured.quotes) {
      const parent = quote.evidence;
      if (!node.evidence.some(span => span && span.sentenceId === parent.sentenceId && span.start === parent.start
        && span.end === parent.end && span.quote === parent.quote)) continue;
      if (!utf16(parent.quote) || !parent.quote.trim()) fail(contextInvalid);
      choices.push({ parentChoiceId: `PC${choices.length + 1}`, nodeId: node.id, quoteId: quote.quoteId, text: parent.quote });
      owned++;
      // Never retain a prefix of a large menu and present it as complete.
      if (choices.length > SOURCE_PROPOSITION_SELECTION_PARENT_CHOICES_LIMIT) fail(budgetExceeded);
    }
    if (!owned) fail('source_proposition_selection_parent_missing');
  }
  budget(choices, SOURCE_PROPOSITION_LIMITS.reviewInput);
  return choices;
}

async function prepareCaptured(context: SourcePropositionContext): Promise<SourcePropositionSelectionInput> {
  let validated: SourcePropositionContext;
  try { validated = await validateSourcePropositionContextSnapshot(context); }
  catch { return fail(contextInvalid); }
  const selection: SourcePropositionSelectionInput = { version: 2, protocol: 'review-source-proposition-selection-input-v2',
    contextHash: await argumentContextHash(validated), parentChoices: buildSourcePropositionSelectionParentChoices(validated) };
  // The final factory also checks its exact system prompt + serialized input.
  budget({ ...selection, reference: validated }, SOURCE_PROPOSITION_LIMITS.reviewInput);
  return selection;
}

export async function prepareSourcePropositionSelection(context: SourcePropositionContext): Promise<SourcePropositionSelectionInput> {
  const captured = contextSnapshot(context); // All caller data detached before the first await.
  return prepareCaptured(captured);
}

export async function prepareSourcePropositionParentSelection(context: SourcePropositionContext): Promise<SourcePropositionParentSelectionInput> {
  const captured = contextSnapshot(context);
  const menu = await prepareCaptured(captured);
  return { version: 3, protocol: 'review-source-proposition-parent-selection-input-v3', contextHash: menu.contextHash,
    parentChoices: menu.parentChoices };
}

/** JSON.parse alone silently accepts duplicate object keys. Reject ambiguous
 * names (including escaped aliases) after syntax parsing, without salvaging Markdown. */
function uniqueJsonKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === '{') stack.push(new Set());
    else if (character === '[') stack.push(null);
    else if (character === '}' || character === ']') stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') index += 2;
        else if (raw[index] === '"') break;
        else index++;
      }
      let next = index + 1; while (/\s/u.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] === ':') {
        const keys = stack.at(-1), key = JSON.parse(raw.slice(start, index + 1)) as string;
        if (!keys || keys.has(key)) fail(invalid); keys.add(key);
      }
    }
  }
}
function selectionSnapshot(raw: unknown): SourcePropositionSelection {
  let value = raw;
  if (typeof raw === 'string') {
    if (!utf16(raw) || !raw.trim() || raw.length > SOURCE_PROPOSITION_LIMITS.draft) fail(invalid);
    try { value = JSON.parse(raw); } catch { return fail(invalid); }
    uniqueJsonKeys(raw);
  }
  plain(value, invalid); closed(value, ['version', 'protocol', 'contextHash', 'anchors']);
  budget(value, SOURCE_PROPOSITION_LIMITS.draft);
  if (value.version !== 2 || value.protocol !== SOURCE_PROPOSITION_SELECTION_PROTOCOL
    || typeof value.contextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contextHash)
    || !Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > SOURCE_PROPOSITION_LIMITS.anchors) return fail(invalid);
  for (const row of value.anchors) {
    closed(row, ['parentChoiceId', 'text']);
    if (typeof row.parentChoiceId !== 'string' || !/^PC[1-9][0-9]{0,3}$/u.test(row.parentChoiceId)
      || Number(row.parentChoiceId.slice(2)) > SOURCE_PROPOSITION_SELECTION_PARENT_CHOICES_LIMIT
      || !utf16(row.text) || !row.text.trim() || row.text.length > SOURCE_PROPOSITION_LIMITS.text) fail(invalid);
  }
  return structuredClone(value) as unknown as SourcePropositionSelection;
}

/** The model may choose a real owned parent and exact words, not identities or
 * coordinates. Rebuild the menu from the full host context; caller/model menus
 * never grant permission. Canonical v1 must still pass the existing strict preparer
 * before the separately requested semantic review. No votes or missing nodes are filled. */
export async function readSourcePropositionSelection(raw: unknown, context: SourcePropositionContext): Promise<SourcePropositionDraft> {
  const captured = contextSnapshot(context), selected = selectionSnapshot(raw); // Both before first await.
  const menu = await prepareCaptured(captured);
  if (selected.contextHash !== menu.contextHash) fail('source_proposition_selection_context_changed');
  const parents = new Map(menu.parentChoices.map(choice => [choice.parentChoiceId, choice]));
  const locations = new Set<string>();
  const anchors = selected.anchors.map((selection, index) => {
    const choice = parents.get(selection.parentChoiceId);
    if (!choice) return fail('source_proposition_selection_parent_unknown');
    const offset = choice.text.indexOf(selection.text);
    if (offset < 0) return fail('source_proposition_selection_text_missing');
    if (choice.text.indexOf(selection.text, offset + 1) >= 0) return fail('source_proposition_selection_text_ambiguous');
    const parent = captured.quotes.find(quote => quote.quoteId === choice.quoteId)!;
    const start = parent.evidence.start + offset, end = start + selection.text.length;
    const location = JSON.stringify([choice.nodeId, choice.quoteId, start, end]);
    if (locations.has(location)) return fail('source_proposition_selection_anchor_duplicate');
    locations.add(location);
    return { id: `P${index + 1}`, nodeId: choice.nodeId, quoteId: choice.quoteId, start, end, text: selection.text };
  });
  if (sourcePropositionRequiredNodeIds(captured).some(nodeId => !anchors.some(anchor => anchor.nodeId === nodeId))) fail('source_proposition_selection_required_nodes_missing');
  const draft: SourcePropositionDraft = { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: menu.contextHash, anchors };
  // This second validation is intentional: a syntactically valid selection menu
  // is not a shortcut around the legacy parent/UTF16/closure/budget contract.
  const validated = await prepareSourcePropositionReviewInput(captured, draft);
  return structuredClone(validated.draft);
}

/** No text generation, truncation, parent expansion or semantics are performed.
 * A partial Q remains partial: the independent review must still hold it if its
 * meaning/constraints cannot be established. Existing v1/v2 proofs are unchanged. */
export async function readSourcePropositionParentSelection(raw: unknown, context: SourcePropositionContext): Promise<SourcePropositionDraft> {
  const captured = contextSnapshot(context);
  let value = raw;
  if (typeof raw === 'string') {
    if (!utf16(raw) || !raw.trim() || raw.length > SOURCE_PROPOSITION_LIMITS.draft) fail(invalid);
    try { value = JSON.parse(raw); } catch { return fail(invalid); }
    uniqueJsonKeys(raw);
  }
  plain(value, invalid); closed(value, ['version', 'protocol', 'contextHash', 'anchors']);
  budget(value, SOURCE_PROPOSITION_LIMITS.draft);
  if (value.version !== 3 || value.protocol !== SOURCE_PROPOSITION_PARENT_SELECTION_PROTOCOL
    || typeof value.contextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contextHash)
    || !Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > SOURCE_PROPOSITION_LIMITS.anchors) return fail(invalid);
  for (const row of value.anchors) {
    closed(row, ['parentChoiceId']);
    if (typeof row.parentChoiceId !== 'string' || !/^PC[1-9][0-9]{0,3}$/u.test(row.parentChoiceId)
      || Number(row.parentChoiceId.slice(2)) > SOURCE_PROPOSITION_SELECTION_PARENT_CHOICES_LIMIT) fail(invalid);
  }
  const selected = structuredClone(value) as unknown as SourcePropositionParentSelection;
  const menu = await prepareCaptured(captured);
  if (selected.contextHash !== menu.contextHash) fail('source_proposition_selection_context_changed');
  const parents = new Map(menu.parentChoices.map(choice => [choice.parentChoiceId, choice]));
  const seen = new Set<string>();
  const anchors = selected.anchors.map((selection, index) => {
    const choice = parents.get(selection.parentChoiceId);
    if (!choice) return fail('source_proposition_selection_parent_unknown');
    if (seen.has(choice.parentChoiceId)) fail('source_proposition_selection_anchor_duplicate');
    seen.add(choice.parentChoiceId);
    const parent = captured.quotes.find(quote => quote.quoteId === choice.quoteId)!;
    return { id: `P${index + 1}`, nodeId: choice.nodeId, quoteId: choice.quoteId,
      start: parent.evidence.start, end: parent.evidence.end, text: parent.evidence.quote };
  });
  if (sourcePropositionRequiredNodeIds(captured).some(nodeId => !anchors.some(anchor => anchor.nodeId === nodeId))) fail('source_proposition_selection_required_nodes_missing');
  const draft: SourcePropositionDraft = { version: 1, protocol: 'review-source-proposition-draft-v1', contextHash: menu.contextHash, anchors };
  const validated = await prepareSourcePropositionReviewInput(captured, draft);
  return structuredClone(validated.draft);
}
