import { createHash } from 'node:crypto';
import type { NoteRagIndexInput, NoteReferenceSectionKind } from '../../types';
import { referenceNoteContent } from '../../services/ragSourcePolicy';
import { noteReferenceSourceDescriptor } from '../../services/noteReferenceSource';
export { noteReferenceSources } from '../../services/noteReferenceSource';
import { chunkSemanticText } from './chunking';

export const NOTE_REFERENCE_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2:mean-normalized:384:v1';
export const noteReferenceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface NoteReferenceChunk {
  chunkId: string;
  content: string;
  textStart: number;
  textEnd: number;
  sectionPath: string;
  sectionKind: NoteReferenceSectionKind;
  forcedSplit: boolean;
  citationIds: string[];
  embeddingText: string;
  embeddingKey: string;
}

export function noteReferenceSourceHash(input: NoteRagIndexInput): string {
  return noteReferenceHash(noteReferenceSourceDescriptor(input));
}
const sectionKind = (path: string): NoteReferenceSectionKind => {
  const title = path.split(' > ').at(-1) || '';
  if (/来源|参考文献|references?/iu.test(title)) return 'sources';
  if (/条件|边界|例外|限制|适用/u.test(title)) return 'condition';
  if (/例子|举例|案例|实例|应用/u.test(title)) return 'example';
  if (/推理|机制|论证|因果|证明|为什么/u.test(title)) return 'reasoning';
  if (/事实|数据|实验|观察|结果/u.test(title)) return 'fact';
  if (/定义|概念|含义|是什么/u.test(title)) return 'definition';
  return 'general';
};

/** Reuse semantic chunking, but map its normalized line offsets back to the EXACT saved original. */
export function buildNoteReferenceChunks(input: NoteRagIndexInput): NoteReferenceChunk[] {
  const raw = referenceNoteContent(input);
  if (!raw.trim() || raw.trim() === '请对该知识点进行定义描述') return [];
  if (raw.length > 500000) throw new Error('index_budget_exceeded');
  let normalized = '';
  const offsets = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\r') { normalized += '\n'; if (raw[i + 1] === '\n') i++; }
    else normalized += raw[i];
    offsets.push(i + 1);
  }
  const pieces = chunkSemanticText(normalized, { minChars: 0, maxChars: 450, maxEstimatedTokens: 260 });
  if (pieces.length > 2000) throw new Error('index_budget_exceeded');
  const occurrences = new Map<string, number>();
  return pieces.flatMap((piece) => {
    const textStart = offsets[piece.textStart], textEnd = offsets[piece.textEnd];
    const content = raw.slice(textStart, textEnd);
    // Render-only blocks have no reference prose. Keep their original positions out of quotations.
    const plain = content.replace(/<[^>]*>/gu, ' ').replace(/data:image\/[^)\s]+/gu, ' ').trim();
    if (plain.replace(/[#>*_`\s]/gu, '').length < 2) return [];
    const embeddingText = `${input.title.slice(0, 60)}\n${piece.sectionPath.slice(-100)}\n${plain.replace(/\s+/gu, ' ')}`;
    const embeddingKey = noteReferenceHash({ model: NOTE_REFERENCE_MODEL, text: embeddingText });
    const key = noteReferenceHash({ noteId: input.id, sectionPath: piece.sectionPath, content });
    const occurrence = (occurrences.get(key) || 0) + 1; occurrences.set(key, occurrence);
    return [{ chunkId: `nrc-${key.slice(0, 24)}-${occurrence}`, content, textStart, textEnd,
      sectionPath: piece.sectionPath, sectionKind: sectionKind(piece.sectionPath), forcedSplit: !!piece.forcedSplit,
      citationIds: [...new Set([...content.matchAll(/\[(\d+)\]/gu)].map((match) => match[1]))], embeddingText, embeddingKey }];
  });
}
