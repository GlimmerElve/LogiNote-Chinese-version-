import type {StructuredDocument} from '../types';

/** Layout evidence only. Never guess dehyphenation from a dictionary or model text. */
export function documentArgumentQuoteHints(document:StructuredDocument|null){
  const hints:Array<{chunkId:string;offset:number}>=[];
  for(const block of document?.blocks||[]){
    const text=document!.normalizedText.slice(block.textStart,block.textEnd);
    for(const fragment of block.sourceFragments||[]){
      for(const match of fragment.rawText.matchAll(/([A-Za-z]{2,})-\r?\n\s*([a-z]{2,})/gu)){
        const token=`${match[1]}-${match[2]}`,start=text.indexOf(token);
        if(start<0||text.indexOf(token,start+1)>=0)continue;
        const offset=start+match[1].length;
        if(!hints.some(h=>h.chunkId===block.id&&h.offset===offset))hints.push({chunkId:block.id,offset});
      }
    }
  }
  return hints;
}
