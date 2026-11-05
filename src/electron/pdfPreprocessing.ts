import type {
  DocumentPreprocessingIssue,
  DocumentPreprocessingMetadata,
  SourceBlockFragment,
  SourceBlockKind,
  SourceLocator,
} from '../types.ts';
import { orderPdfReadingBlocks } from './pdfReadingOrder.ts';

export interface PdfRawBlock {
  id: string;
  page: number;
  blockIndex: number;
  bbox?: [number, number, number, number];
  pageHeight?: number;
  tableIndex?: number;
  kind: SourceBlockKind;
  rawText: string;
  text: string;
  formulaEvidence?: import('../types.ts').FormulaEvidence;
  layoutRole?: SourceBlockFragment['layoutRole'];
}

export interface PdfProjectedBlock {
  page: number;
  blockIndex: number;
  bbox?: [number, number, number, number];
  kind: SourceBlockKind;
  text: string;
  sourceFragments: SourceBlockFragment[];
}

export interface PdfPreprocessingResult {
  blocks: PdfProjectedBlock[];
  metadata: DocumentPreprocessingMetadata;
}

const SENTENCE_END = /[。！？!?；;…][”’」』】）)]?$/u;
const CAPTION = /^(?:表|图|Table|Figure|Fig\.?)[ \t]*[A-Za-z]?\d+(?:[.\-－—]\d+)*(?:[：:.、]|\s)/iu;
const ANALYTIC_PROSE = /(?:由此(?:表|图)?可以看出|结果(?:表明|显示|说明)|可以发现|可见|这表明|据此)/u;
const NOTE_START = /^(?:注|注释|说明|资料来源|来源|\*|[①②③④⑤⑥⑦⑧⑨⑩]|\[?\d{1,2}\]?)[：:.、\s]/u;
const SUSPICIOUS = /[\uFFFD]|(?:\?{3,})|(?:□{2,})/u;
const LIST_START = /^(?:[-•·▪◦]|\(?\d{1,3}[.)、]|[（(][一二三四五六七八九十\d]+[）)]|[一二三四五六七八九十]+[、.])/u;

function locator(block: PdfRawBlock): SourceLocator {
  return {
    kind: 'pdf',
    page: block.page,
    bbox: block.bbox,
    blockIndex: block.blockIndex,
    tableIndex: block.tableIndex,
  };
}

/** 只修复视觉换行，不修改 rawText；中文行间不插空格，拉丁文本保留单空格。 */
export function normalizePdfReadingText(text: string, kind: SourceBlockKind, observedWords?: Set<string>): string {
  const normalized = String(text || '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized || kind === 'code') return normalized;
  if (kind === 'table') return /^\s*\|/u.test(normalized) ? normalized
    : normalized.split(/\n+/gu).map((line) => line.trim()).filter(Boolean).join(' | ');
  // A soft hyphen explicitly marks a discretionary break. ASCII '-' is
  // ambiguous: join only when the unhyphenated word occurs elsewhere in this
  // document, and the hyphenated spelling does not. rawText stays unchanged.
  const reading = normalized.replace(/([A-Za-z])\u00ad\s*\n\s*([a-z])/gu, '$1$2')
    .replace(/([A-Za-z]{2,})-\s*\n\s*([a-z]{2,})/gu, (full, left: string, right: string) =>
      observedWords?.has((left + right).toLowerCase()) && !observedWords.has(`${left}-${right}`.toLowerCase())
        ? left + right : full);
  const lines = reading.split(/\n+/gu).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return reading;
  let output = lines[0];
  for (const line of lines.slice(1)) {
    const previous = output.at(-1) || '';
    const next = line[0] || '';
    const cjkJoin = /[\p{Script=Han}，、；：！？“‘（【《]/u.test(previous)
      && /[\p{Script=Han}，、；：！？”’）】》]/u.test(next);
    const punctuationJoin = /[\-—–/（(【[]$/u.test(output) || /^[,.;:!?，。；：！？、）)】\]]/u.test(line);
    output += (cjkJoin || punctuationJoin ? '' : ' ') + line;
  }
  return output;
}

function tableLikeRow(block: PdfRawBlock, blocks: PdfRawBlock[]): boolean {
  if (block.kind !== 'paragraph' || !block.bbox || /[。！？!?；;]/u.test(block.text)) return false;
  const numbers = block.text.match(/[-+]?\d+(?:\.\d+)?%?/gu) || [];
  if (numbers.length < 2
    || !/^(?:[\p{Script=Han}A-Za-z*%()（）]{1,12}\s+)?[-+]?\d/u.test(block.text.trim())) return false;
  return blocks.some((candidate) => candidate.page === block.page && candidate.kind === 'table' && candidate.bbox
    && Math.min(candidate.bbox[2], block.bbox![2]) > Math.max(candidate.bbox[0], block.bbox![0])
    && Math.abs(candidate.bbox[3] - block.bbox![1]) <= 150);
}

function captionLike(block: PdfRawBlock, blocks: PdfRawBlock[]): boolean {
  const key = block.text.replace(/^\|\s*/u, '').replace(/\s+/gu, ' ').trim();
  const rawFirstLine = block.rawText.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || '';
  if (!CAPTION.test(key) && !CAPTION.test(rawFirstLine)) return false;
  // “表2为……由此表可以看出……”是正文中的结果分析，不是表题。
  if (ANALYTIC_PROSE.test(key) || ANALYTIC_PROSE.test(block.rawText)) return false;
  // pdfplumber 常把双语表题识别成一行 table；此时仍投影为 caption。
  if (block.kind === 'table') return true;
  if (!block.bbox) return key.length <= 100;
  return blocks.some((candidate) => {
    if (candidate === block || candidate.page !== block.page || candidate.kind !== 'table' || !candidate.bbox) return false;
    const aboveGap = candidate.bbox[1] - block.bbox![3];
    const belowGap = block.bbox![1] - candidate.bbox[3];
    const horizontalOverlap = Math.max(0,
      Math.min(block.bbox![2], candidate.bbox[2]) - Math.max(block.bbox![0], candidate.bbox[0]));
    const minWidth = Math.max(1, Math.min(block.bbox![2] - block.bbox![0], candidate.bbox[2] - candidate.bbox[0]));
    return horizontalOverlap / minWidth >= 0.5
      && ((aboveGap >= -3 && aboveGap <= 54) || (belowGap >= -3 && belowGap <= 36));
  });
}

function projectedKind(
  block: PdfRawBlock,
  repeatedFurniture: Set<string>,
  blocks: PdfRawBlock[],
): SourceBlockKind {
  if (block.kind === 'heading') return block.kind;
  const key = block.text.replace(/\s+/gu, ' ').trim();
  if (captionLike(block, blocks)) return 'caption';
  if (block.kind === 'table' || tableLikeRow(block, blocks)) return 'table';
  const bottom = block.bbox && block.pageHeight && block.bbox[1] >= block.pageHeight * 0.82;
  if ((bottom && NOTE_START.test(key)) || repeatedFurniture.has(block.id)) return 'notes';
  return block.kind;
}

function furnitureBlocks(blocks: PdfRawBlock[]): Set<string> {
  const candidates = new Map<string, PdfRawBlock[]>();
  for (const block of blocks) {
    if (!block.bbox || !block.pageHeight || block.text.length > 120) continue;
    const topOrBottom = block.bbox[1] <= block.pageHeight * 0.09 || block.bbox[1] >= block.pageHeight * 0.9;
    if (!topOrBottom) continue;
    const key = block.text.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (!key) continue;
    const list = candidates.get(key) || [];
    list.push(block);
    candidates.set(key, list);
  }
  return new Set([...candidates.values()]
    .filter((rows) => new Set(rows.map((row) => row.page)).size >= 2)
    .flatMap((rows) => rows.map((row) => row.id)));
}

function directContinuation(before: string, after: string): boolean {
  if (!before || !after || SENTENCE_END.test(before)) return false;
  if (/[，,：:；;、（(\-—]$/u.test(before)) return true;
  if (/^(?:而|但|并|且|以及|其中|相同|此外|因此|则|即|这种|该|其|与之|从而)/u.test(after)) return true;
  return /[A-Za-z0-9]$/u.test(before) && /^[a-z0-9]/u.test(after);
}

function readingSeparator(before: string, after: string): string {
  const previous = before.at(-1) || '';
  const next = after[0] || '';
  const cjkJoin = /[\p{Script=Han}，、；：！？“‘（【《]/u.test(previous)
    && /[\p{Script=Han}，、；：！？”’）】》]/u.test(next);
  const punctuationJoin = /[\-—–/（(【[]$/u.test(before) || /^[,.;:!?，。；：！？、）)】\]]/u.test(after);
  return cjkJoin || punctuationJoin ? '' : ' ';
}

type WorkingBlock = PdfProjectedBlock & { rawIds: string[] };

function columnPeers(blocks: WorkingBlock[], current: WorkingBlock): WorkingBlock[] {
  return blocks.filter(block => block.page === current.page && block.kind === 'paragraph' && block.bbox
    && current.bbox && Math.min(block.bbox[2], current.bbox[2]) > Math.max(block.bbox[0], current.bbox[0]));
}

function paragraphColumnLeft(blocks: WorkingBlock[], current: WorkingBlock): number | undefined {
  const starts = columnPeers(blocks, current)
    .map((block) => block.bbox![0]).sort((a, b) => a - b);
  if (!starts.length) return undefined;
  // 最左侧可能是边注；取靠左四分位而不是绝对最小值。
  return starts[Math.min(starts.length - 1, Math.floor(starts.length * 0.2))];
}

function paragraphColumnRight(blocks: WorkingBlock[], current: WorkingBlock): number | undefined {
  const ends = columnPeers(blocks, current)
    .map((block) => block.bbox![2]).sort((a, b) => a - b);
  if (!ends.length) return undefined;
  return ends[Math.min(ends.length - 1, Math.floor(ends.length * 0.8))];
}

function visualLineContinuation(current: WorkingBlock, next: WorkingBlock, blocks: WorkingBlock[]): boolean {
  if ([current, next].some(block => block.sourceFragments.some(fragment => fragment.formulaEvidence))) return false;
  if (current.kind !== 'paragraph' || next.kind !== 'paragraph' || current.page !== next.page
    || !current.bbox || !next.bbox || LIST_START.test(next.text)) return false;
  const gap = next.bbox[1] - current.bbox[3];
  const currentHeight = Math.max(1, current.bbox[3] - current.bbox[1]);
  const nextHeight = Math.max(1, next.bbox[3] - next.bbox[1]);
  if (gap < -2 || gap > Math.max(12, Math.min(currentHeight, nextHeight) * 0.95)) return false;
  const overlap = Math.max(0, Math.min(current.bbox[2], next.bbox[2]) - Math.max(current.bbox[0], next.bbox[0]));
  const minWidth = Math.max(1, Math.min(current.bbox[2] - current.bbox[0], next.bbox[2] - next.bbox[0]));
  if (overlap / minWidth < 0.55) return false;

  const columnLeft = paragraphColumnLeft(blocks, current);
  const columnRight = paragraphColumnRight(blocks, current);
  const nextIndented = columnLeft !== undefined && next.bbox[0] - columnLeft >= 12;
  const currentAtColumnLeft = columnLeft !== undefined && current.bbox[0] - columnLeft <= 7;
  // 上一行位于正文左缘、下一行重新首行缩进时，视为新段落。
  if (nextIndented && currentAtColumnLeft) return false;
  if (!SENTENCE_END.test(current.text)) return true;

  // 句号恰好落在满行末尾时，下一行仍可能是同一段的新句；短行句号则结束段落。
  const currentFillsLine = columnRight !== undefined && columnRight - current.bbox[2] <= 12;
  return currentFillsLine && !nextIndented;
}

function mergeVisualParagraphLines(blocks: WorkingBlock[], issues: DocumentPreprocessingIssue[]): void {
  const mergedIds: string[] = [];
  for (let index = 0; index < blocks.length - 1; index += 1) {
    const current = blocks[index];
    const next = blocks[index + 1];
    if (!visualLineContinuation(current, next, blocks)) continue;
    current.text += readingSeparator(current.text, next.text) + next.text;
    current.sourceFragments.push(...next.sourceFragments);
    current.rawIds.push(...next.rawIds);
    mergedIds.push(...next.rawIds);
    current.bbox = unionBbox(current.sourceFragments);
    blocks.splice(index + 1, 1);
    index -= 1;
  }
  if (mergedIds.length) issues.push({
    code: 'visual_line_merge', severity: 'info', blockIds: mergedIds.slice(0, 50),
    message: `${mergedIds.length} 个视觉行块已合并进连续正文段落；原始文本与坐标仍保存在 sourceFragments 中。`,
  });
}

function unionBbox(fragments: SourceBlockFragment[]): [number, number, number, number] | undefined {
  const pdfFragments = fragments.filter((fragment) => fragment.locator.kind === 'pdf');
  if (new Set(pdfFragments.map((fragment) => fragment.locator.kind === 'pdf' ? fragment.locator.page : -1)).size > 1) {
    const first = pdfFragments[0]?.locator;
    return first?.kind === 'pdf' ? first.bbox : undefined;
  }
  const boxes = pdfFragments.flatMap((fragment) => fragment.locator.kind === 'pdf' && fragment.locator.bbox
    ? [fragment.locator.bbox] : []);
  if (!boxes.length) return undefined;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

/**
 * 将不可变 PDF 原始块投影为适合 LLM/向量检索的阅读块。
 * 表格仍独立保存；若表格打断同一句，只合并表格前后的正文，并保留两个来源坐标。
 */
export function preprocessPdfBlocks(
  input: PdfRawBlock[],
  engine: string,
  extractorWarnings: string[] = [],
): PdfPreprocessingResult {
  const repeatedFurniture = furnitureBlocks(input);
  const readingOrder = orderPdfReadingBlocks(input, repeatedFurniture);
  const raw = readingOrder.blocks;
  const observedWords = new Set<string>();
  for (const block of input) {
    for (const word of block.rawText.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*/gu)) {
      observedWords.add(word[0].toLowerCase());
    }
  }
  const normalizedIds: string[] = [];
  const issues: DocumentPreprocessingIssue[] = extractorWarnings.map((message) => ({
    code: 'table_extraction_unavailable', severity: 'warning', blockIds: [], message,
  }));
  if (readingOrder.columnPages.length) issues.push({
    code: 'column_reading_order', severity: 'info', blockIds: [],
    message: `第 ${readingOrder.columnPages.join('、')} 页按分栏阅读顺序处理；跨栏对象单独分区，原始块编号和坐标保留。`,
  });
  const projected = raw.map((block): WorkingBlock => {
    const kind = projectedKind(block, repeatedFurniture, raw);
    const text = normalizePdfReadingText(block.text, kind, observedWords);
    if (SUSPICIOUS.test(block.rawText)) issues.push({
      code: 'suspicious_character', severity: 'warning', blockIds: [block.id],
      message: '检测到替换符或连续占位符；已保留原文，未进行猜测性修复。',
    });
    if (text !== block.rawText.trim()) normalizedIds.push(block.id);
    return {
      page: block.page,
      blockIndex: block.blockIndex,
      bbox: block.bbox,
      kind,
      text,
      sourceFragments: [{ locator: locator(block), rawText: block.rawText,
        ...(block.layoutRole ? { layoutRole: block.layoutRole } : {}),
        ...(block.formulaEvidence ? { formulaEvidence: block.formulaEvidence } : {}) }],
      rawIds: [block.id],
    };
  }).filter((block) => block.text);

  // A geometrically adjacent oversized initial is not a heading. Only join
  // when exactly one paragraph begins beside its top; retain both sources.
  for (const cap of [...projected]) {
    if (!cap.bbox || !cap.sourceFragments.some(fragment => fragment.layoutRole === 'drop_cap')) continue;
    const box = cap.bbox;
    const candidates = projected.filter(block => block !== cap && block.page === cap.page
      && block.kind === 'paragraph' && block.bbox && /^[a-z]{2}/u.test(block.text)
      && block.bbox[0] >= box[0] - 3 && block.bbox[0] <= box[2] + 8
      && block.bbox[1] >= box[1] - 3 && block.bbox[1] <= box[1] + (box[3] - box[1]) * .55
      && block.bbox[3] > box[3]);
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    target.text = cap.text + target.text;
    target.sourceFragments.unshift(...cap.sourceFragments);
    target.rawIds.unshift(...cap.rawIds);
    target.bbox = unionBbox(target.sourceFragments);
    projected.splice(projected.indexOf(cap), 1);
    issues.push({ code: 'drop_cap_join', severity: 'info', blockIds: [...target.rawIds],
      message: '依据首字下沉版面合并独立首字与相邻正文；未补造字符，两个原始来源均保留。' });
  }
  const auxiliary = raw.filter(block => block.layoutRole && block.layoutRole !== 'drop_cap');
  if (auxiliary.length) issues.push({ code: 'layout_auxiliary', severity: 'info', blockIds: auxiliary.map(block => block.id),
    message: '目录侧栏、章号、印刷信息及已识别署名单独保留并标记，不作为正文段落或章节标题。' });

  if (normalizedIds.length) issues.push({
    code: 'anchor_normalized', severity: 'info', blockIds: normalizedIds.slice(0, 50),
    message: `${normalizedIds.length} 个阅读块做了 Unicode、空白、标题标记或视觉换行归一化；原始文本仍保存在来源片段中。`,
  });

  // pdfplumber 可能把一个表拆成表头和若干数据行；只合并同页、紧邻的 table 块。
  for (let index = 0; index < projected.length - 1; index += 1) {
    const current = projected[index];
    const next = projected[index + 1];
    if (current.kind !== 'table' || next.kind !== 'table' || current.page !== next.page) continue;
    if (current.bbox && next.bbox && Math.min(current.bbox[2], next.bbox[2]) <= Math.max(current.bbox[0], next.bbox[0])) continue;
    const gap = current.bbox && next.bbox ? next.bbox[1] - current.bbox[3] : Number.POSITIVE_INFINITY;
    if (gap < -2 || gap > 24) continue;
    current.text += '\n' + next.text;
    current.sourceFragments.push(...next.sourceFragments);
    current.rawIds.push(...next.rawIds);
    current.bbox = unionBbox(current.sourceFragments);
    projected.splice(index + 1, 1);
    index -= 1;
  }

  // PyMuPDF 可能把同一正文段落的每个视觉行输出成独立块；在表格处理后按版面与句法合并。
  mergeVisualParagraphLines(projected, issues);

  for (let index = 0; index < projected.length; index += 1) {
    const before = projected[index];
    if (before.kind !== 'paragraph') continue;
    let cursor = index + 1;
    const interruptions: typeof projected = [];
    while (cursor < projected.length && ['table', 'caption'].includes(projected[cursor].kind)) {
      interruptions.push(projected[cursor]);
      cursor += 1;
    }
    const after = projected[cursor];
    if (before.sourceFragments.some(fragment => fragment.formulaEvidence)
      || after?.sourceFragments.some(fragment => fragment.formulaEvidence)) continue;
    if (!interruptions.length || !after || after.kind !== 'paragraph'
      || after.page - before.page > 1 || !directContinuation(before.text, after.text)) continue;
    if (before.page === after.page && before.bbox && after.bbox
      && Math.min(before.bbox[2], after.bbox[2]) <= Math.max(before.bbox[0], after.bbox[0])) continue;
    before.text += readingSeparator(before.text, after.text) + after.text;
    before.sourceFragments.push(...after.sourceFragments);
    before.rawIds.push(...after.rawIds);
    before.bbox = unionBbox(before.sourceFragments);
    projected.splice(cursor, 1);
    issues.push({
      code: 'table_interruption', severity: 'info', blockIds: [...before.rawIds],
      message: '表格或图注打断了未完成句；阅读投影已合并前后正文，表格仍作为独立块保留。',
    });
  }

  const covered = new Set(projected.flatMap((block) => block.rawIds));
  return {
    blocks: projected.map(({ rawIds: _rawIds, ...block }) => block),
    metadata: {
      version: 1,
      engine,
      rawBlockCount: raw.length,
      projectedBlockCount: projected.length,
      sourceCoverage: raw.length ? covered.size / raw.length : 1,
      issues,
    },
  };
}
