import type {DocumentArgumentWindow} from './documentArgumentV5Types';

/** One request gets one continuous body. IDs and offsets are local-only and the
 * original paragraph plan remains the saved progress/source basis. */
export function documentArgumentReadingWindows(paragraphs:DocumentArgumentWindow[],hints:Array<{chunkId:string;offset:number}>=[]):DocumentArgumentWindow[]{
  if(!paragraphs.length)return [];
  let text='';const parts:DocumentArgumentWindow['parts']=[];
  for(const paragraph of paragraphs){
    if(text)text+='\n\n';
    const base=text.length;let offset=0;
    for(const part of paragraph.parts){
      const start=part.windowStart??offset;
      parts.push({chunkId:part.chunkId,start:part.start,end:part.end,windowStart:base+start});
      offset=start+part.end-part.start;
    }
    text+=paragraph.text;
  }
  const wrapHyphens=parts.flatMap(part=>hints.filter(h=>h.chunkId===part.chunkId&&h.offset>=part.start&&h.offset<part.end)
    .map(h=>part.windowStart!+h.offset-part.start));
  return [{id:'batch-text',section:'',text,parts,...(wrapHyphens.length?{wrapHyphens}:{})}];
}
