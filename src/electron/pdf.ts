import { readFile } from 'fs/promises';
import { spawn } from 'child_process';

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

/** 清理抽取文本：映射康熙部首/兼容字符，删除控制符（含退格 U+0008），归一空白 */
function sanitizePdfText(text: string): string {
  let out = text;
  // 统一换行为 \n
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 康熙部首 + 兼容字符映射
  out = out.replace(
    /[\u2e80-\u2eff\u2f00-\u2fdf\uff00-\uff5e\u3000-\u303f\u2018\u2019\u201c\u201d]/g,
    (ch) => KANGXI_MAP[ch] ?? COMPAT_MAP[ch] ?? '',
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
  error?: string;
}

/** 用 PyMuPDF 子进程抽取 PDF 文本（超时 60s，失败抛错并清空主输出） */
function extractPdfTextPymupdf(filePath: string): Promise<string> {
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
        resolve(sanitizePdfText(result.text ?? ''));
      } catch (e) {
        reject(new Error('PyMuPDF 输出解析失败: ' + (e as Error).message));
      }
    });
  });
}

/** unpdf 兜底抽取（保留原有逻辑） */
async function extractPdfTextUnpdf(filePath: string): Promise<string> {
  const ext = await getExtractText();
  const buf = await readFile(filePath);
  const result = await ext(new Uint8Array(buf), { mergePages: true });
  const text = result?.text ?? '';
  const raw = Array.isArray(text) ? text.join('\n') : String(text);
  return sanitizePdfText(raw);
}

/** 从 PDF 文件路径抽取纯文本：优先 PyMuPDF，失败/空则回退 unpdf（返回空串表示无可抽取文本层） */
export async function extractPdfText(filePath: string): Promise<string> {
  try {
    const text = await extractPdfTextPymupdf(filePath);
    if (text) return text;
  } catch (e) {
    console.warn('[pdf] PyMuPDF 抽取失败，回退 unpdf:', (e as Error)?.message);
  }

  try {
    return await extractPdfTextUnpdf(filePath);
  } catch (e) {
    console.warn('[pdf] unpdf 抽取失败:', (e as Error)?.message);
    return '';
  }
}
