import type { DocumentChunk, StructuredDocument } from '../../types';
import type { DocumentArgumentPlan, DocumentArgumentWindow, DocumentArgumentObject } from '../../services/documentArgumentV5Types';
import {DOCUMENT_ARGUMENT_V5_LIMITS} from '../../services/documentArgumentV5Types';
import type { DocumentGraphSource } from '../../services/documentGraphTypes';

const REFERENCES = /^(?:#{1,6}\s*)?(?:\d+[.、\s]*)?(?:参考文献|參考文獻|references|bibliography)(?:\s*[（(](?:references|参考文献|參考文獻)[）)])?\s*[:：]?$/iu;
const isReferences = (text: string) => REFERENCES.test(text.split(/\s*>\s*/u).at(-1)!.trim());
const METADATA = /^(?:https?:\/\/\S+|doi\s*[:：].*|文章引用\s*[:：].*|(?:收稿|录用|接受|出版|发表)日期\s*[:：].*|(?:通讯作者|通信作者|E-?mail|版权所有|Copyright)\s*[:：©].*|\d{1,4})$/iu;

/** Reading windows are whole preprocessed paragraphs. Production passes original
 * source-block coordinate adapters; legacy callers may still pass passage chunks.
 * Semantic argument nodes are extracted later by the LLM. Tables stay whole objects. */
export function planDocumentArgumentV5(chunks: DocumentChunk[], structured: StructuredDocument | null): DocumentArgumentPlan {
  const plan: DocumentArgumentPlan = { windows: [], objects: [], limitations: [] };
  const add = (text: string, section: string, parts: DocumentGraphSource[], kind = 'paragraph') => {
    if (!text.trim()) return;
    const isReference = isReferences(section) || isReferences(text);
    if (kind === 'table' || kind === 'caption' || kind === 'metadata' || kind === 'references' || isReference || METADATA.test(text.trim())) {
      const objectKind = kind === 'table' ? 'table' : kind === 'references' || isReference ? 'references' : 'metadata';
      plan.objects.push({ id: `O${plan.objects.length + 1}`, kind: objectKind, title: section || text.slice(0, 120), text, source: parts });
    } else {
      plan.windows.push({ id: `W${plan.windows.length + 1}`, section, text, parts });
    }
  };
  if (structured) {
    if (structured.docId !== chunks[0]?.docId) throw new Error('document_argument_source_identity');
    let inReferences = false;
    const mapRange = (start: number, end: number) => {
      const parts: DocumentGraphSource[] = [];
      while (start < end) {
        const chunk = chunks.filter(c => c.textStart !== undefined && c.textEnd !== undefined && c.textStart <= start && c.textEnd > start)
          .sort((a, b) => b.textEnd! - a.textEnd!).find(c => c.content.slice(start - c.textStart!, Math.min(end, c.textEnd!) - c.textStart!) === structured.normalizedText.slice(start, Math.min(end, c.textEnd!)));
        if (!chunk) throw new Error('资料段落与原文来源坐标不一致，请重新解析资料');
        const stop = Math.min(end, chunk.textEnd!);
        parts.push({ chunkId: chunk.id, start: start - chunk.textStart!, end: stop - chunk.textStart! });
        start = stop;
      }
      return parts;
    };
    for (const block of structured.blocks) {
      const text = structured.normalizedText.slice(block.textStart, block.textEnd);
      if (isReferences(text) || isReferences(block.sectionPath)) inReferences = true;
      else if (block.kind === 'heading' && /(?:附录|附錄|appendix|补充材料)/iu.test(text)) inReferences = false;
      add(text, block.sectionPath, mapRange(block.textStart, block.textEnd), inReferences ? 'references' : block.kind);
    }
    if (!structured.preprocessing && chunks.some(c => c.sourceLocators?.some(l => l.kind === 'pdf'))) {
      plan.limitations.push('当前 PDF 索引没有阅读预处理记录；重新索引可恢复视觉换行与表格对象。');
    }
  } else {
    plan.limitations.push('旧索引无版面结构，按原文自然段准备；未猜测表格或脚注位置。');
    let inReferences = false;
    for (const chunk of [...chunks].sort((a, b) => a.index - b.index)) {
      for (const match of chunk.content.matchAll(/[^\n](?:[^\n]|\n(?!\s*\n))*/gu)) {
        const start = match.index!, text = match[0];
        if (isReferences(text) || isReferences(chunk.sectionPath)) inReferences = true;
        add(text, chunk.sectionPath, [{ chunkId: chunk.id, start, end: start + text.length }], inReferences ? 'references' : /^\s*\|/u.test(text) ? 'table' : 'paragraph');
      }
    }
  }
  // Attach the immediately preceding caption to its table without sending rows to the LLM.
  for (let i = 0; i < plan.objects.length; i++) {
    const object = plan.objects[i];
    if (object.kind !== 'table') continue;
    const caption = plan.objects[i - 1];
    if (caption?.kind === 'metadata' && /^(?:\|\s*)?(?:表|Table)\s*\d+/iu.test(caption.text.trim())) {
      object.title = caption.text; object.source = [...caption.source, ...object.source];
      object.text = caption.text + '\n' + object.text;
    }
  }
  return plan;
}

const heading=(text:string)=>text.trim().length<=120&&/^(?:#{1,6}\s+|\d+(?:\.\d+)*\.?\s+\S|第[一二三四五六七八九十\d]+[章节]|[一二三四五六七八九十]+、)/u.test(text.trim());
const listItem=(text:string)=>/^\s*(?:[-*•]\s+|\d+[)）]|[（(]\d+[)）]|[一二三四五六七八九十]+[)）、])/u.test(text);
/** Structural protection, not an assertion that local code understands semantics. */
export function documentArgumentBoundarySafe(left:string,right:string){
  if(heading(left)||/[:：]\s*$/u.test(left)||listItem(right))return false;
  if(heading(right))return true;
  return /[。！？.!?;；][”"’'）)\]]*\s*$/u.test(left);
}

/** Keep heading/body, introduction/list and unfinished sentence fragments together.
 * Then minimize batch count and prefer a section boundary near the length target. */
export function nextDocumentArgumentV5Windows(snapshot: { windows: DocumentArgumentWindow[]; current?: { build: { completedWindowIds: string[] } } }) {
  const done = snapshot.current?.build.completedWindowIds || [];
  if (done.some((id, i) => id !== snapshot.windows[i]?.id)) throw new Error('document_argument_progress_not_prefix');
  const pending = snapshot.windows.slice(done.length);
  if (!pending.length) return [];
  const {maxCharacters,minCharacters,targetCharacters}=DOCUMENT_ARGUMENT_V5_LIMITS;
  // Each paragraph adds a two-newline separator, except the first in a batch.
  // Count the actual joined body, not just the sum of paragraph text lengths.
  const separator=2,budget=maxCharacters+separator;
  const groups:Array<{end:number;size:number}>=[];
  for(let i=0;i<pending.length;i++){
    const size=[...pending[i].text].length+separator;
    if(i&& !documentArgumentBoundarySafe(pending[i-1].text,pending[i].text)){
      groups[groups.length-1].end=i+1;groups[groups.length-1].size+=size;
    }else groups.push({end:i+1,size});
  }
  const sizes = groups.map(g=>g.size);
  const oversize = sizes.findIndex(n => n > budget);
  if (oversize === 0) throw new Error(`${pending[0].id} 完整段落或受保护段落组超过${maxCharacters}字；请检查结构，未强行切开标题、列表或长句。`);
  // A later oversized paragraph is reported when reached, preserving earlier valid progress.
  const length = oversize < 0 ? groups.length : oversize;
  const jump = new Array<number>(length), suffixCount = new Array<number>(length + 1).fill(0);
  let right = 0, sum = 0;
  for (let left = 0; left < length; left++) {
    while (right < length && sum + sizes[right] <= budget) sum += sizes[right++];
    jump[left] = right; sum -= sizes[left];
  }
  for (let i = length - 1; i >= 0; i--) suffixCount[i] = 1 + suffixCount[jump[i]];
  const count = suffixCount[0], total = sizes.slice(0, length).reduce((s, n) => s + n, 0);
  const target = Math.min(targetCharacters+separator, total / count);
  let chars = 0, best = 1, delta = Infinity;
  for (let end = 1; end <= jump[0]; end++) {
    chars += sizes[end - 1];
    const cut=groups[end-1].end;
    const sectionBoundary=cut<pending.length&&heading(pending[cut].text);
    const score=Math.abs(chars-target)-(sectionBoundary&&chars-separator>=minCharacters?150:0);
    if (1 + suffixCount[end] === count && score < delta) { best = end; delta = score; }
  }
  return pending.slice(0, groups[best-1].end);
}
