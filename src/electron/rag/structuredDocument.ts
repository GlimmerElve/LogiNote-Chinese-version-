import type {
  DocumentPreprocessingMetadata,
  SourceBlock,
  SourceBlockFragment,
  SourceBlockKind,
  SourceLocator,
  StructuredDocument,
  SentenceSpan,
} from '../../types.ts';
import { sentenceRanges } from './sentenceBoundaries.ts';

export interface LocatedTextBlock {
  text: string;
  kind: SourceBlockKind;
  sectionPath?: string;
  locator: SourceLocator;
  sourceFragments?: SourceBlockFragment[];
}

export interface StructuredDocumentBuildOptions {
  preprocessing?: DocumentPreprocessingMetadata;
}

function normalizeBlockText(text: string, kind: SourceBlockKind): string {
  const normalized = String(text || '').replace(/\r\n?/gu, '\n');
  // 教材示例中的 Python 缩进、Markdown 表格和围栏不能在建索引时压成空格。
  if (kind === 'code' || kind === 'table') return normalized.replace(/^\n+|\n+$/gu, '');
  return normalized
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 用已经带原始定位信息的块构造统一文本，并在同一步生成不会漂移的 source span。 */
export function buildStructuredDocument(
  docId: string,
  inputBlocks: LocatedTextBlock[],
  options: StructuredDocumentBuildOptions = {},
): StructuredDocument {
  const parts: string[] = [];
  const blocks: SourceBlock[] = [];
  let offset = 0;
  let currentSection = '';
  for (const [index, input] of inputBlocks.entries()) {
    const text = normalizeBlockText(input.text, input.kind);
    if (!text) continue;
    if (parts.length > 0) {
      parts.push('\n\n');
      offset += 2;
    }
    const start = offset;
    parts.push(text);
    offset += text.length;
    if (input.kind === 'heading') {
      const match = text.match(/^(#{1,6})\s+(.+)$/u);
      currentSection = input.sectionPath || match?.[2]?.trim() || text;
    }
    blocks.push({
      id: `${docId}:block:${index + 1}`,
      textStart: start,
      textEnd: offset,
      kind: input.kind,
      sectionPath: input.sectionPath ?? currentSection,
      locator: input.locator,
      ...(input.sourceFragments?.length ? { sourceFragments: input.sourceFragments } : {}),
    });
  }
  return {
    schemaVersion: 1,
    docId,
    normalizedText: parts.join(''),
    blocks,
    ...(options.preprocessing ? { preprocessing: options.preprocessing } : {}),
  };
}

/** TXT/Markdown 路径：标题和段落均保留原字符定位。 */
export function buildTextStructuredDocument(docId: string, input: string): StructuredDocument {
  const text = String(input || '').replace(/\r\n?/gu, '\n');
  const blocks: LocatedTextBlock[] = [];
  const headingStack: string[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;
  let sectionPath = '';
  let fence: { char: string; length: number } | null = null;

  const flushParagraph = () => {
    if (paragraphStart === null) return;
    const raw = text.slice(paragraphStart, paragraphEnd).trim();
    if (raw) {
      blocks.push({
        text: raw,
        kind: /^ {0,3}(?:`{3,}|~{3,})/u.test(raw) ? 'code'
          : /^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/mu.test(raw) ? 'table'
          : /^\s*(?:[-*+] |\d+[.)] )/mu.test(raw) ? 'list' : 'paragraph',
        sectionPath,
        locator: { kind: 'text', charStart: paragraphStart, charEnd: paragraphEnd },
      });
    }
    paragraphStart = null;
  };

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      paragraphEnd = lineEnd;
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        flushParagraph();
        fence = null;
      }
      offset = lineEnd + 1;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      flushParagraph();
      fence = { char: marker[1][0], length: marker[1].length };
      paragraphStart = lineStart;
      paragraphEnd = lineEnd;
      offset = lineEnd + 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      headingStack.length = level - 1;
      headingStack.push(heading[2].trim());
      sectionPath = headingStack.filter(Boolean).join(' > ');
      blocks.push({
        text: line.trim(),
        kind: 'heading',
        sectionPath,
        locator: { kind: 'text', charStart: lineStart, charEnd: lineEnd },
      });
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      if (paragraphStart === null) paragraphStart = lineStart;
      paragraphEnd = lineEnd;
    }
    offset = lineEnd + 1;
  }
  flushParagraph();
  return buildStructuredDocument(docId, blocks);
}

export function sourceBlocksForRange(
  document: StructuredDocument,
  start: number,
  end: number,
): SourceBlock[] {
  return document.blocks.filter((block) => block.textEnd > start && block.textStart < end);
}

/** 句子 ID 与全局 span 完全由程序生成，后续模型只能引用这些 ID。 */
export function buildSentenceSpans(chunkId: string, content: string, globalStart: number, paragraphBreaks = true): SentenceSpan[] {
  return sentenceRanges(content, paragraphBreaks).map((range, index) => ({
    id: `${chunkId}:s${index + 1}`,
    textStart: globalStart + range.start,
    textEnd: globalStart + range.end,
  }));
}
