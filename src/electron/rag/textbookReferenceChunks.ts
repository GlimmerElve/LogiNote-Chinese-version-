import { createHash } from 'node:crypto';
import type { NoteReferenceSectionKind } from '../../types.ts';
import { chunkSemanticText } from './chunking.ts';

export const TEXTBOOK_REFERENCE_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2:mean-normalized:384:textbook-v1';
export const textbookReferenceHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface TextbookReferenceChunkInput {
  noteId: string;
  title: string;
  textbookId: string;
  revisionId: string;
  regionId: string;
  body: string;
}

export interface TextbookReferenceChunk {
  chunkId: string;
  content: string;
  textStart: number;
  textEnd: number;
  sectionPath: string;
  sectionKind: NoteReferenceSectionKind;
  forcedSplit: boolean;
  embeddingText: string;
  embeddingKey: string;
}

export function textbookReferenceSourceHash(input: TextbookReferenceChunkInput): string {
  return textbookReferenceHash({
    noteId: input.noteId,
    textbookId: input.textbookId,
    revisionId: input.revisionId,
    regionId: input.regionId,
    body: input.body,
  });
}

const sectionKind = (sectionPath: string): NoteReferenceSectionKind => {
  const title = sectionPath.split(' > ').at(-1) || '';
  if (/来源|参考文献|references?/iu.test(title)) return 'sources';
  if (/条件|边界|例外|限制|适用/u.test(title)) return 'condition';
  if (/例子|举例|案例|实例|应用/u.test(title)) return 'example';
  if (/推理|机制|论证|因果|证明|为什么/u.test(title)) return 'reasoning';
  if (/事实|数据|实验|观察|结果/u.test(title)) return 'fact';
  if (/定义|概念|含义|是什么/u.test(title)) return 'definition';
  return 'general';
};

/**
 * 这段计算在 Electron utility process 中运行。块坐标相对于受管教材正文，
 * 复盘块和项目计划区不会进入该坐标系。
 */
export function buildTextbookReferenceChunks(input: TextbookReferenceChunkInput): TextbookReferenceChunk[] {
  const raw = input.body;
  if (!raw.trim()) return [];
  if (raw.length > 1_000_000) throw new Error('index_budget_exceeded');
  let normalized = '';
  const offsets = [0];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\r') {
      normalized += '\n';
      if (raw[index + 1] === '\n') index++;
    } else normalized += raw[index];
    offsets.push(index + 1);
  }
  const pieces = chunkSemanticText(normalized, {
    minChars: 0,
    targetEstimatedTokens: 220,
    maxChars: 650,
    maxEstimatedTokens: 360,
  });
  if (pieces.length > 2500) throw new Error('index_budget_exceeded');
  const occurrences = new Map<string, number>();
  return pieces.flatMap((piece) => {
    const textStart = offsets[piece.textStart];
    const textEnd = offsets[piece.textEnd];
    const content = raw.slice(textStart, textEnd);
    const plain = content.replace(/<[^>]*>/gu, ' ').replace(/data:image\/[^)\s]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (plain.replace(/[#>*_`\s]/gu, '').length < 2) return [];
    const embeddingText = `${input.title.slice(0, 80)}\n${piece.sectionPath.slice(-140)}\n${plain}`;
    const embeddingKey = textbookReferenceHash({ model: TEXTBOOK_REFERENCE_MODEL, text: embeddingText });
    const key = textbookReferenceHash({ noteId: input.noteId, revisionId: input.revisionId, sectionPath: piece.sectionPath, content });
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return [{
      chunkId: `trc-${key.slice(0, 24)}-${occurrence}`,
      content,
      textStart,
      textEnd,
      sectionPath: piece.sectionPath,
      sectionKind: sectionKind(piece.sectionPath),
      forcedSplit: Boolean(piece.forcedSplit),
      embeddingText,
      embeddingKey,
    }];
  });
}
