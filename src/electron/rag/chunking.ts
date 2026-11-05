import type { StructuredDocument } from '../../types.ts';
import { endsWithSentenceBoundary, sentenceRanges } from './sentenceBoundaries.ts';

export interface SemanticChunk {
  sectionPath: string;
  content: string;
  /** 在换行已归一化的源文本中的半开区间。标题行不进入正文块。 */
  textStart: number;
  textEnd: number;
  paragraphCount: number;
  forcedSplit?: boolean;
}

export interface ChunkingOptions {
  /** Soft target only. Whole semantic units may grow until the hard limits. */
  minChars?: number;
  targetEstimatedTokens?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
  /** PDF blank lines may separate visual blocks inside one sentence. */
  pdfLayout?: boolean;
}

interface TextUnit {
  sectionPath: string;
  start: number;
  end: number;
  paragraphId: number;
  forcedSplit?: boolean;
}

const DEFAULT_OPTIONS: Required<ChunkingOptions> = {
  minChars: 360,
  targetEstimatedTokens: 360,
  maxChars: 2400,
  maxEstimatedTokens: 900,
  pdfLayout: false,
};

/** Body-index contract only. Argument-RAG windows have their own frozen planner. */
export const DOCUMENT_SEMANTIC_CHUNKING_VERSION = 4;
export const EMBEDDING_VIEW_TOKEN_BUDGET = 96;

function normalizeOptions(rawOptions: ChunkingOptions): Required<ChunkingOptions> {
  const merged = { ...DEFAULT_OPTIONS, ...rawOptions };
  const maxChars = Math.max(1, Math.floor(merged.maxChars));
  const maxEstimatedTokens = Math.max(1, Math.floor(merged.maxEstimatedTokens));
  return {
    maxChars,
    maxEstimatedTokens,
    minChars: Math.min(maxChars, Math.max(1, Math.floor(merged.minChars))),
    targetEstimatedTokens: Math.min(maxEstimatedTokens,
      Math.max(1, Math.floor(merged.targetEstimatedTokens))),
    pdfLayout: Boolean(merged.pdfLayout),
  };
}

/** 保守估算多语言 MiniLM 的 token 数，避免中文按英文字符比例低估。 */
export function estimateEmbeddingTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  const words = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu) || []).length;
  const other = Math.max(0, text.replace(/\s/gu, '').length - cjk);
  return cjk + words + Math.ceil(other * 0.35);
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

function fits(text: string, start: number, end: number, options: Required<ChunkingOptions>): boolean {
  const value = text.slice(start, end);
  return value.length <= options.maxChars
    && estimateEmbeddingTokens(value) <= options.maxEstimatedTokens;
}

function splitOversizedRange(
  text: string,
  sectionPath: string,
  start: number,
  end: number,
  paragraphId: number,
  options: Required<ChunkingOptions>,
): TextUnit[] {
  if (fits(text, start, end, options)) {
    return [{ sectionPath, start, end, paragraphId }];
  }

  const units: TextUnit[] = [];
  let cursor = start;
  const boundaries = sentenceRanges(text.slice(start, end), !options.pdfLayout).map((range) => start + range.end);
  const clauseBoundaries = [...text.slice(start, end).matchAll(/(?:[，,：:、——)）]”?[ \t]*|\n+)/gu)]
    .map((match) => start + match.index! + match[0].length);
  let continuesSentence = false;
  while (cursor < end) {
    let bestEnd = cursor;
    for (const candidateEnd of boundaries) {
      if (candidateEnd <= cursor) continue;
      if (!fits(text, cursor, candidateEnd, options)) break;
      bestEnd = candidateEnd;
    }

    const sentenceWouldSplit = bestEnd <= cursor;
    if (bestEnd <= cursor) {
      for (const candidateEnd of clauseBoundaries) {
        if (candidateEnd <= cursor) continue;
        if (!fits(text, cursor, candidateEnd, options)) break;
        bestEnd = candidateEnd;
      }
    }
    const forcedEnd = bestEnd <= cursor;
    if (bestEnd <= cursor) {
      let hardEnd = Math.min(end, cursor + options.maxChars);
      while (hardEnd > cursor + 1
        && estimateEmbeddingTokens(text.slice(cursor, hardEnd)) > options.maxEstimatedTokens) {
        hardEnd -= Math.max(1, Math.ceil((hardEnd - cursor) * 0.05));
      }
      bestEnd = Math.max(cursor + 1, hardEnd);
      // Do not split a UTF-16 surrogate pair when a single sentence exceeds the budget.
      if (bestEnd < end && /[\uD800-\uDBFF]/u.test(text[bestEnd - 1]) && bestEnd > cursor + 1) bestEnd -= 1;
    }

    const range = trimRange(text, cursor, bestEnd);
    if (range) units.push({ sectionPath, ...range, paragraphId,
      forcedSplit: continuesSentence || sentenceWouldSplit || forcedEnd || undefined });
    continuesSentence = sentenceWouldSplit || forcedEnd;
    cursor = bestEnd;
  }
  return units;
}

function collectUnits(text: string, options: Required<ChunkingOptions>): TextUnit[] {
  const headingStack: string[] = [];
  const units: TextUnit[] = [];
  const lines = text.split(/\n/gu);
  let offset = 0;
  let sectionPath = '';
  let paragraphStart: number | null = null;
  let paragraphId = 0;

  const flushParagraph = (end: number) => {
    if (paragraphStart === null) return;
    const range = trimRange(text, paragraphStart, end);
    paragraphStart = null;
    if (!range) return;
    units.push(...splitOversizedRange(
      text,
      sectionPath,
      range.start,
      range.end,
      paragraphId++,
      options,
    ));
  };

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (heading) {
      flushParagraph(lineStart);
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack.push(heading[2].trim());
      sectionPath = headingStack.filter(Boolean).join(' > ');
    } else if (!line.trim()) {
      if (!options.pdfLayout || paragraphStart === null || endsWithSentenceBoundary(text.slice(paragraphStart, lineStart), text.slice(lineEnd))) {
        flushParagraph(lineStart);
      }
    } else if (paragraphStart === null) {
      paragraphStart = lineStart;
    }
    offset = lineEnd + 1;
  }
  flushParagraph(text.length);
  return units;
}

/**
 * 生成无重叠的规范块。检索时再按需补邻居，避免相同文字被重复向量化和重复计分。
 */
export function chunkSemanticText(input: string, rawOptions: ChunkingOptions = {}): SemanticChunk[] {
  const text = String(input || '').replace(/\r\n?/gu, '\n');
  if (!text.trim()) return [];
  const options = normalizeOptions(rawOptions);

  const units = collectUnits(text, options);
  const chunks: SemanticChunk[] = [];
  let group: TextUnit[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    chunks.push({
      sectionPath: group[0].sectionPath,
      content: text.slice(start, end).trim(),
      textStart: start,
      textEnd: end,
      paragraphCount: new Set(group.map((unit) => unit.paragraphId)).size,
      forcedSplit: group.some((unit) => unit.forcedSplit) || undefined,
    });
    group = [];
  };

  for (const unit of units) {
    if (group.length === 0) {
      group.push(unit);
      continue;
    }
    const first = group[0];
    const combinedFits = first.sectionPath === unit.sectionPath
      && fits(text, first.start, unit.end, options);
    const currentLength = group[group.length - 1].end - first.start;
    const currentTokens = estimateEmbeddingTokens(text.slice(first.start, group[group.length - 1].end));
    const nextText = text.slice(unit.start, unit.end).trimStart();
    const directlyContinues = /^(?:因此|所以|但|然而|不过|同时|此外|进一步|由此|对此|其中|这|该|上述|以上|其)/u.test(nextText)
      || /^(?:thus|therefore|however|moreover|furthermore|this|these)\b/iu.test(nextText);
    if (!combinedFits || first.forcedSplit || (!directlyContinues
      && (currentLength >= options.minChars || currentTokens >= options.targetEstimatedTokens))) flush();
    group.push(unit);
  }
  flush();
  return chunks;
}

/**
 * A stored chunk stays semantically complete, while the 128-token local model
 * receives sentence-aligned views. Every source character is represented in a
 * view; overlong single sentences use the same auditable clause fallback.
 */
export function semanticEmbeddingViews(content: string, sectionPath = '', budget = EMBEDDING_VIEW_TOKEN_BUDGET): string[] {
  const requestedPrefix = sectionPath.trim();
  const prefixLimit = Math.max(0, Math.floor(budget / 3));
  let prefix = requestedPrefix;
  while (prefix && estimateEmbeddingTokens(prefix) > prefixLimit) prefix = prefix.slice(0, -1);
  const prefixTokens = prefix ? estimateEmbeddingTokens(prefix) + 1 : 0;
  const bodyBudget = Math.max(24, budget - Math.min(prefixTokens, Math.floor(budget / 3)));
  const pieces = chunkSemanticText(content, {
    minChars: 1,
    targetEstimatedTokens: bodyBudget,
    maxChars: 600,
    maxEstimatedTokens: bodyBudget,
    pdfLayout: true,
  });
  return pieces.map((piece) => prefix ? `${prefix}\n${piece.content}` : piece.content);
}

/**
 * Consume the parser's StructuredDocument directly. In particular, PDF text is
 * never cleaned a second time here: its repaired prose, tables, captions and
 * immutable source coordinates are the exact projection shared with argument RAG.
 */
export function chunkStructuredDocument(document: StructuredDocument, options: ChunkingOptions = {}): SemanticChunk[] {
  if (!document.blocks.length) {
    return chunkSemanticText(document.normalizedText, options);
  }
  const pdfLayout = document.blocks.every((block) => block.locator.kind === 'pdf');
  const chunks: SemanticChunk[] = [];
  let start: number | null = null;
  let end = 0;
  let sectionPath = '';
  const flush = () => {
    if (start === null) return;
    const offset = start;
    chunks.push(...chunkSemanticText(document.normalizedText.slice(offset, end), { ...options, pdfLayout })
      .map((chunk) => ({ ...chunk, sectionPath, textStart: chunk.textStart + offset, textEnd: chunk.textEnd + offset })));
    start = null;
  };
  const emitObject = (objectStart: number, objectEnd: number, objectSection: string, objectCount: number) => {
    const range = trimRange(document.normalizedText, objectStart, objectEnd);
    if (!range) return;
    chunks.push({
      sectionPath: objectSection,
      content: document.normalizedText.slice(range.start, range.end),
      textStart: range.start,
      textEnd: range.end,
      paragraphCount: objectCount,
    });
  };
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index];
    // Keep auxiliary PDF text in normalizedText and the source ledger, but do
    // not embed print furniture or contents as if they were factual prose.
    if (block.locator.kind === 'pdf' && block.sourceFragments?.length
      && block.sourceFragments.every(fragment => fragment.layoutRole
        && ['print_furniture', 'chapter_label', 'credit', 'contents'].includes(fragment.layoutRole))) {
      flush();
      continue;
    }
    if (block.kind === 'heading') {
      flush();
      sectionPath = block.sectionPath || document.normalizedText.slice(block.textStart, block.textEnd);
      continue;
    }
    if (block.kind === 'paragraph') {
      if (start === null) start = block.textStart;
      end = block.textEnd;
      continue;
    }
    flush();
    // A caption and its immediately following table form one readable object.
    // The stored object stays whole even when its embedding needs several views.
    const next = document.blocks[index + 1];
    if (block.kind === 'caption' && next?.kind === 'table') {
      emitObject(block.textStart, next.textEnd, block.sectionPath || sectionPath, 2);
      index += 1;
      continue;
    }
    emitObject(block.textStart, block.textEnd, block.sectionPath || sectionPath, 1);
  }
  flush();
  return chunks;
}
