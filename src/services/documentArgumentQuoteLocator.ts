export type ArgumentQuoteFailure = 'not_found' | 'ambiguous' | 'numeric_mismatch';
export class ArgumentQuoteLocationError extends Error {
  constructor(public readonly reason: ArgumentQuoteFailure) {
    super(reason === 'ambiguous' ? '引文在本次原文范围内不唯一'
      : reason === 'numeric_mismatch' ? '引文数字或数值格式与原文不一致' : '引文不能逐字定位');
  }
}

const QUOTES: Record<string, string> = { '“': '"', '”': '"', '「': '"', '」': '"', '‘': "'", '’': "'" };
const BRACKETS: Record<string, string> = { '（': '(', '）': ')', '［': '[', '］': ']' };
const numericSignature = (text: string) => JSON.stringify(
  (text.match(/[+\-−]?\d+(?:\s*[.,，．]\s*\d+)*(?:\s*[%％‰])?/gu) || []).map(s => s.replace(/\s/gu, '')));

/** Only typographic substitutions with a reversible UTF-16 position map.
 * Do not use NFKC: it also changes exponents, fractions and other meaningful symbols. */
function project(text: string, formatting: boolean, wrapHyphens=new Set<number>(), omitCommas=false) {
  const positions: number[] = [];
  let value = '';
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (/\s/u.test(ch)) continue;
    if(ch==='-'&&wrapHyphens.has(i))continue;
    if(omitCommas&&/[,，]/u.test(ch)&&/\p{Script=Han}/u.test(text.slice(0,i).trimEnd().at(-1)||'')
      &&/\p{Script=Han}/u.test(text.slice(i+1).trimStart()[0]||''))continue;
    if (formatting) {
      const before = text.slice(0, i).trimEnd().at(-1) || '';
      const after = text.slice(i + 1).trimStart()[0] || '';
      ch = QUOTES[ch] || BRACKETS[ch] || ch;
      if ((ch === ',' || ch === '，') && !/\p{N}/u.test(before + after)) ch = ',';
      // Periods in numbers, abbreviations, URLs and ellipses are NOT sentence stops.
      // A Chinese sentence followed by a new numbered list item is still a stop.
      // Without this case the full source sees "3)" while the quoted sentence
      // sees end-of-string, so identical sentence punctuation projects differently.
      const numberedItemAfter = /^[ \t]*\r?\n\s*\d{1,3}[)）、]/u.test(text.slice(i + 1));
      if ((ch === '.' || ch === '。') && /[\p{Script=Han}）)】\]”"’']/u.test(before)
        && (!after || /[\p{Script=Han}）)】\]”"’']/u.test(after) || numberedItemAfter)) ch = '。';
    }
    value += ch;
    positions.push(i);
  }
  return { value, positions };
}

export interface ArgumentQuoteOptions {wrapHyphens?:number[];minStart?:number;maxStart?:number}
export function locateDocumentArgumentQuote(text: string, quote: string, options:ArgumentQuoteOptions={}): { start: number; end: number; match: 'exact' | 'whitespace' | 'formatting' } {
  if (!quote.trim()) throw new ArgumentQuoteLocationError('not_found');
  const find=(source:string,needle:string,positions?:number[])=>{
    const ranges:Array<{start:number;end:number}>=[];
    if(!needle)return ranges;
    for(let at=source.indexOf(needle);at>=0;at=source.indexOf(needle,at+1)){
      const start=positions?positions[at]:at,end=positions?positions[at+needle.length-1]+1:at+needle.length;
      if(start>=(options.minStart??0)&&start<=(options.maxStart??text.length))ranges.push({start,end});
    }
    return ranges;
  };
  const exact=find(text,quote);
  if(exact.length>1)throw new ArgumentQuoteLocationError('ambiguous');
  if(exact.length===1)return {...exact[0],match:'exact'};
  // Last pass repairs only evidenced line hyphens and <=2 Chinese interior commas
  // in a long quote. Decimal punctuation, negation, words and conditions stay exact.
  for (const mode of [0,1,2]) {
    const omitCommas=mode===2&&(quote.match(/\p{Script=Han}/gu)||[]).length>=24;
    const source=project(text,mode>0,mode===2?new Set(options.wrapHyphens):undefined,omitCommas);
    const needle=project(quote,mode>0,undefined,omitCommas).value;
    const ranges=find(source.value,needle,source.positions);
    if(ranges.length>1)throw new ArgumentQuoteLocationError('ambiguous');
    if(!ranges.length)continue;
    const range=ranges[0],original=text.slice(range.start,range.end);
    if(mode===2&&Math.abs((original.match(/[,，]/gu)||[]).length-(quote.match(/[,，]/gu)||[]).length)>2)continue;
    if(numericSignature(original)!==numericSignature(quote))throw new ArgumentQuoteLocationError('numeric_mismatch');
    return {...range,match:mode>0?'formatting':'whitespace'};
  }
  throw new ArgumentQuoteLocationError('not_found');
}
