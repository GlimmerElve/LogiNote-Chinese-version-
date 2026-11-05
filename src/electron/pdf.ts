import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import type { DocumentPreprocessingMetadata, SourceBlockKind } from '../types.ts';
import { preprocessPdfBlocks, type PdfRawBlock } from './pdfPreprocessing.ts';

// Node 22 才引入 Promise.try；Electron 31 内置的是 Node 20，缺少该 API，
// 而 unpdf 内部打包的 pdf.js 依赖它，导致 PDF 解析抛 "Promise.try is not a function"。
// 这里在主进程加载 unpdf 之前先补一个等价 shim（unpdf 兜底路径仍需要）。
if (typeof (Promise as any).try !== 'function') {
  (Promise as any).try = function (fn: (...args: any[]) => any, ...args: any[]) {
    return new Promise((resolve, reject) => {
      try {
        resolve(fn(...args));
      } catch (e) {
        reject(e);
      }
    });
  };
}

/**
 * 主进程 PDF 文本抽取。
 *
 * 首选 PyMuPDF（Python 子进程，中文 CJK 字形抽取远优于 pdf.js，能避免
 * "芯片→芯""龙头企业→头企业"的缺字问题），失败或输出为空时回退 unpdf。
 * - 只抽文本层，图片及其内部文字不会进入文本流。
 * - 扫描/图片型 PDF（无文本层）抽取结果为空，由调用方据此落 failed。
 */

/** Python 抽取脚本绝对路径（由 main.ts 启动时注入） */
let pdfExtractScript = '';

export function setPdfExtractScript(scriptPath: string): void {
  pdfExtractScript = scriptPath;
}
export function getPdfExtractScriptPath(): string { return pdfExtractScript; }

type UnpdfExtractText = (
  data: Uint8Array,
  options?: { mergePages?: boolean },
) => Promise<{ totalPages: number; text: string | string[] }>;

let extractTextFn: UnpdfExtractText | null = null;

/** 懒加载 unpdf 的 extractText（避免主进程启动即加载 pdf.js 内核） */
async function getExtractText(): Promise<UnpdfExtractText> {
  if (!extractTextFn) {
    const { extractText } = await import('unpdf');
    extractTextFn = extractText as unknown as UnpdfExtractText;
  }
  return extractTextFn;
}

/**
 * 中文 PDF 文本层常见「康熙部首」乱码映射表。
 * 部分中文 PDF 会把常用汉字编码成康熙部首（U+2F00–U+2FDF）或兼容汉字，
 * 这些字符不在嵌入模型词表中，会污染向量质量，这里映射回常规字。
 */
const KANGXI_MAP: Record<string, string> = {
  '\u2f64': '用',
  '\u2f1b': '力',
  '\u2f56': '厂',
  '\u2f4d': '十',
  '\u2f6c': '目',
  '\u2ea5': '又',
  '\u2e93': '日',
  '\u2f88': '马',
  '\u2f92': '鱼',
  '\u2e9f': '亠',
  '\u2f82': '页',
  '\u2f7d': '页',
};

/** 通用兼容区字符映射（全角字母数字等） */
const COMPAT_MAP: Record<string, string> = {
  '\uff02': '"',
  '\u300c': '"',
  '\u300d': '"',
  '\u201c': '"',
  '\u201d': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u3000': ' ',
  '\u3001': ',',
  '\u3002': '.',
};

/** 清理抽取文本：映射已知乱码但绝不删除未知的合法 Unicode 字符。 */
export function sanitizePdfText(text: string): string {
  let out = text;
  // 统一换行为 \n
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Compatibility normalization destroys mathematical meaning (²→2, ₁→1, 𝑥→x).
  // Keep canonical normalization; fold only full-width ASCII, never math glyphs.
  out = out.normalize('NFC').replace(/[\uFF01-\uFF5E]/gu,
    (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
  // 康熙部首 + 已知标点映射。未收录的部首或标点原样保留，交给质量检查提示人工复核。
  out = out.replace(
    /[\u2e80-\u2eff\u2f00-\u2fdf\uff00-\uff5e\u3000-\u303f\u2018\u2019\u201c\u201d]/g,
    (ch) => KANGXI_MAP[ch] ?? COMPAT_MAP[ch] ?? ch,
  );
  // 删除退格 U+0008 及其它无意义 C0 控制符（0x00-0x08、0x0B、0x0C、0x0E-0x1F、0x7F）。
  // 注意：必须保留 \t(0x09) 与 \n(0x0A)，否则会抹掉换行导致段落分块失效。
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  // 删除零宽字符、行/段分隔符、BOM
  out = out.replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '');
  // 水平空白归一（tab / 空格 → 单空格），保留换行
  out = out.replace(/[ \t\u00a0]+/g, ' ');
  // 连续空行收敛为单个空行
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

interface PymupdfResult {
  ok: boolean;
  totalPages?: number;
  text?: string;
  blocks?: Array<{
    id?: string;
    page?: number;
    blockIndex?: number;
    bbox?: number[];
    pageHeight?: number;
    tableIndex?: number;
    kind?: SourceBlockKind;
    rawText?: string;
    text?: string;
    formulaEvidence?: import('../types.ts').FormulaEvidence;
    layoutRole?: import('../types.ts').SourceBlockFragment['layoutRole'];
  }>;
  engine?: string;
  warnings?: string[];
  error?: string;
}

export interface PdfExtractedBlock {
  page: number;
  blockIndex: number;
  bbox?: [number, number, number, number];
  kind: SourceBlockKind;
  text: string;
  sourceFragments: import('../types.ts').SourceBlockFragment[];
}

export interface PdfExtractedDocument {
  totalPages: number;
  text: string;
  blocks: PdfExtractedBlock[];
  preprocessing: DocumentPreprocessingMetadata;
}

/** 用 PyMuPDF 子进程抽取 PDF 文本（超时 60s，失败抛错并清空主输出） */
function extractPdfDocumentPymupdf(filePath: string): Promise<PdfExtractedDocument> {
  return new Promise((resolve, reject) => {
    if (!pdfExtractScript) {
      reject(new Error('PyMuPDF 抽取脚本路径未配置'));
      return;
    }

    const child = spawn('python', [pdfExtractScript, filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('PyMuPDF 抽取超时'));
      }
    }, 60_000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(new Error(stderr.trim() || `PyMuPDF 子进程退出码 ${code}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as PymupdfResult;
        if (!result.ok) {
          reject(new Error(result.error || 'PyMuPDF 抽取失败'));
          return;
        }
        const rawBlocks = (result.blocks || []).flatMap((block, index): PdfRawBlock[] => {
          const rawText = String(block.rawText ?? block.text ?? '');
          const text = sanitizePdfText(String(block.text ?? rawText));
          const bbox = Array.isArray(block.bbox) && block.bbox.length === 4
            ? block.bbox.map((value) => Number(value)) as [number, number, number, number]
            : undefined;
          if (!text) return [];
          const page = Math.max(1, Math.floor(Number(block.page) || 1));
          // Zero is a real page-local source ID, not a missing value. Falling
          // back to the document-wide array index can duplicate a later block
          // on this page and breaks provenance even if the text is intact.
          const blockIndex = typeof block.blockIndex === 'number'
            && Number.isSafeInteger(block.blockIndex) && block.blockIndex >= 0 ? block.blockIndex : index;
          return [{
            id: String(block.id || `p${page}:b${blockIndex}`),
            page,
            blockIndex,
            bbox,
            pageHeight: Number.isFinite(Number(block.pageHeight)) ? Number(block.pageHeight) : undefined,
            tableIndex: Number.isSafeInteger(block.tableIndex) ? block.tableIndex : undefined,
            kind: ['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes'].includes(String(block.kind))
              ? block.kind as SourceBlockKind : 'paragraph',
            rawText,
            text,
            ...(block.layoutRole ? { layoutRole: block.layoutRole } : {}),
            ...(block.formulaEvidence ? { formulaEvidence: block.formulaEvidence } : {}),
          }];
        });
        const projection = preprocessPdfBlocks(rawBlocks, result.engine || 'pymupdf', result.warnings || []);
        const blocks = projection.blocks;
        const text = blocks.length > 0
          ? blocks.map((block) => block.text).join('\n\n')
          : sanitizePdfText(result.text ?? '');
        resolve({
          totalPages: Math.max(0, Number(result.totalPages) || 0),
          text,
          blocks,
          preprocessing: projection.metadata,
        });
      } catch (e) {
        reject(new Error('PyMuPDF 输出解析失败: ' + (e as Error).message));
      }
    });
  });
}

/** unpdf 兜底抽取（保留原有逻辑） */
async function extractPdfDocumentUnpdf(filePath: string): Promise<PdfExtractedDocument> {
  const ext = await getExtractText();
  const buf = await readFile(filePath);
  const result = await ext(new Uint8Array(buf), { mergePages: false });
  const text = result?.text ?? '';
  const pages = Array.isArray(text) ? text : [String(text)];
  const rawBlocks = pages.flatMap((raw, index): PdfRawBlock[] => {
    const pageText = sanitizePdfText(raw);
    return pageText ? [{
      id: `p${index + 1}:b0`, page: index + 1, blockIndex: 0, kind: 'paragraph',
      rawText: String(raw), text: pageText,
    }] : [];
  });
  const projection = preprocessPdfBlocks(rawBlocks, 'unpdf', ['表格结构抽取不可用：已降级为页级文本。']);
  return {
    totalPages: Math.max(Number(result?.totalPages) || 0, pages.length),
    text: projection.blocks.map((block) => block.text).join('\n\n'),
    blocks: projection.blocks,
    preprocessing: projection.metadata,
  };
}

/** 从 PDF 抽取结构块：优先 PyMuPDF+bbox，失败时回退到 unpdf 页级定位。 */
export async function extractPdfDocument(filePath: string): Promise<PdfExtractedDocument> {
  try {
    const document = await extractPdfDocumentPymupdf(filePath);
    if (document.text) return document;
  } catch (e) {
    console.warn('[pdf] PyMuPDF 抽取失败，回退 unpdf:', (e as Error)?.message);
  }

  try {
    return await extractPdfDocumentUnpdf(filePath);
  } catch (e) {
    console.warn('[pdf] unpdf 抽取失败:', (e as Error)?.message);
    return {
      totalPages: 0,
      text: '',
      blocks: [],
      preprocessing: {
        version: 1, engine: 'none', rawBlockCount: 0, projectedBlockCount: 0,
        sourceCoverage: 1, issues: [],
      },
    };
  }
}

/** 旧调用兼容入口。 */
export async function extractPdfText(filePath: string): Promise<string> {
  return (await extractPdfDocument(filePath)).text;
}
