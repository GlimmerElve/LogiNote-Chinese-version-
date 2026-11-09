import type { ConceptDraft, ConceptSourceEvidence, NoteItem } from '../types';
import { KNOWLEDGE_PLACEHOLDER } from './wikiKnowledge';

export const MAX_CONCEPT_AUGMENT_CONTEXT_CHARS = 8000;
export interface ConceptAugmentation {
  originalContent: string;
  context: string;
  contextTruncated: boolean;
  citationOffset: number;
  originalReferences: NonNullable<ConceptDraft['references']>;
}

/** The bounded excerpt never becomes the saved original. Formula/code blocks,
 * whitespace and the original source list remain byte-for-byte intact. */
export function prepareConceptAugmentation(note: NoteItem, existingContent = note.content): ConceptAugmentation | undefined {
  const originalContent = String(existingContent || '');
  if (!originalContent.trim() || originalContent.trim() === KNOWLEDGE_PLACEHOLDER) return undefined;
  const originalReferences = (note.referenceSources || []).map(reference => ({ ...reference }));
  const ids = [...originalContent.matchAll(/\[(\d+)\]/gu)].map(match => match[1]);
  originalReferences.forEach((reference, index) => ids.push(reference.sourceId && /^\d+$/u.test(reference.sourceId) ? reference.sourceId : String(index + 1)));
  let citationOffset = 0;
  for (const id of ids) {
    const value = Number(id);
    if (!Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER - 100) throw Error('现有引用编号超出可安全扩充的范围，请先整理引用。');
    citationOffset = Math.max(citationOffset, value);
  }
  const contextTruncated = originalContent.length > MAX_CONCEPT_AUGMENT_CONTEXT_CHARS;
  const context = contextTruncated ? originalContent.slice(0, MAX_CONCEPT_AUGMENT_CONTEXT_CHARS) : originalContent;
  return { originalContent, context, contextTruncated, citationOffset, originalReferences };
}

export function numberAugmentationEvidence(evidence: ConceptSourceEvidence[], augmentation: ConceptAugmentation): ConceptSourceEvidence[] {
  if (augmentation.citationOffset + evidence.length > Number.MAX_SAFE_INTEGER) throw Error('现有引用编号超出可安全扩充的范围，请先整理引用。');
  return evidence.map((item, index) => ({ ...item, sourceId: String(augmentation.citationOffset + index + 1) }));
}

/** Supplement has passed normal citation checks. Only its presentation headings
 * change; the user's original is never processed or rewritten. */
export function composeConceptAugmentation(augmentation: ConceptAugmentation, finalizedSupplement: string): string {
  let supplement = finalizedSupplement.replace(/^#\s+[^\r\n]*(?:\r?\n|$)/u, '').trim();
  if (!supplement) throw Error('LLM 未返回概念草稿');
  let fence = '';
  supplement = supplement.split(/\r?\n/u).map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; return line; }
    if (fence) return line;
    if (/^##\s+来源\s*$/u.test(line)) return '### 本次补充来源';
    return line.replace(/^##\s+/u, '### ');
  }).join('\n');
  const original = augmentation.originalContent;
  const gap = original.endsWith('\n\n') ? '' : original.endsWith('\n') ? '\n' : '\n\n';
  return `${original}${gap}## 概念补充\n\n${supplement}`;
}
