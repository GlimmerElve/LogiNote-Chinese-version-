/** Input-packaging-only experiment; use the unmodified evidence-first prompt and parser. */
import { prepareEvidenceFirstUseProbe } from './authorUseEvidenceFirstProbe';
import type { AuditInput } from './relationAuditShadow';

export const AUTHOR_USE_INLINE_VERSION = 'author-use-inline-endpoints-v1';
export function prepareInlineUseProbe(input: AuditInput) {
  const original = prepareEvidenceFirstUseProbe(input);
  const nodes = new Map(input.nodes.map(node => [node.id, node]));
  if (nodes.size !== input.nodes.length) throw new Error('Inline experiment: duplicate node ID, input left unchanged');
  const resolve = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error('Inline experiment: missing endpoint ' + id);
    return structuredClone(node);
  };
  const packet = JSON.parse(original.userInput);
  packet.candidates = input.candidates.map(candidate => ({ ...structuredClone(candidate),
    premiseStatements: candidate.premises.map(resolve), targetStatement: resolve(candidate.target) }));
  const userInput = JSON.stringify(packet);
  if (userInput.length > 22000) throw new Error('Inline experiment packet exceeds 22000 characters; no truncation');
  return { ...original, version: AUTHOR_USE_INLINE_VERSION, userInput };
}
