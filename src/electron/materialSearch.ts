import type { MaterialSearch, MaterialSearchRequest } from '../services/textbook/materialTypes';
import { MaterialError, materialDocIds } from '../services/textbook/materialScope';
import { isMaterialFrontMatter, progressiveMaterialTerms as materialQueryTerms, progressiveTopicAnchor } from '../services/progressiveLearning/sourcePolicy';
import { loadMaterial } from './materialStore';

/** Full parsed original, including blocks beyond the catalog prefix and text
 * deep inside a chapter. No model, index, parser or vector write is involved.
 * Yield every small batch so native IPC and window actions can keep running. */
export async function searchMaterialText(request:MaterialSearchRequest):Promise<MaterialSearch>{
  materialDocIds(request);
  if(typeof request.query!=='string'||!request.query.trim()||request.query.length>2000||request.subject!==undefined&&(typeof request.subject!=='string'||request.subject.length>600)||request.topic!==undefined&&(typeof request.topic!=='string'||request.topic.length>600)
    ||request.limit!==undefined&&(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>24))throw new MaterialError('INVALID_REQUEST','原文检索条件无效');
  const {doc,document,version}=await loadMaterial(request,request.docId,request.version);
  const focus=materialQueryTerms(request.query),subject=materialQueryTerms(request.subject||'');
  const terms=[...new Set([...focus,...subject])];
  const anchor=progressiveTopicAnchor(request.topic||request.subject||request.query);
  const subjectAnchor=progressiveTopicAnchor(request.subject||'');
  const candidates:Array<{block:typeof document.blocks[number];hits:string[];focusHits:string[];subjectHits:string[];topicMatch:boolean;subjectMatch:boolean}>=[];
  const frequency=new Map<string,number>();
  for(let i=0;i<document.blocks.length;i++){
    if(i%48===0)await new Promise<void>(resolve=>setImmediate(resolve));
    const block=document.blocks[i];if(block.kind==='heading'||isMaterialFrontMatter(block.sectionPath))continue;
    const text=document.normalizedText.slice(block.textStart,block.textEnd).toLowerCase();
    if(text.trim().length<16||text.length<800&&/ISBN\s*[:：]?\s*[\d-]+/iu.test(text)&&/(?:出版社|版权所有|copyright)/iu.test(text))continue;
    let hits=terms.filter(term=>text.includes(term));
    // Two fragments occurring separately are not an exact name/term match.
    // E.g. "斯内" and "内尔" from different names do not establish "斯内尔".
    const collisions=new Set(terms.filter(t=>t.length===3&&!text.includes(t)&&hits.includes(t.slice(0,2))&&hits.includes(t.slice(1))).flatMap(t=>[t.slice(0,2),t.slice(1)]));
    hits=hits.filter(t=>!collisions.has(t));if(!hits.length)continue;
    hits.forEach(term=>frequency.set(term,(frequency.get(term)||0)+1));
    candidates.push({block,hits,focusHits:focus.filter(t=>hits.includes(t)),subjectHits:subject.filter(t=>hits.includes(t)),topicMatch:Boolean(anchor&&(text.includes(anchor)||block.sectionPath.toLowerCase().includes(anchor))),subjectMatch:Boolean(subjectAnchor&&(text.includes(subjectAnchor)||block.sectionPath.toLowerCase().includes(subjectAnchor)))});
  }
  const anchored=candidates.some(row=>row.topicMatch)?candidates.filter(row=>row.topicMatch)
    :subjectAnchor?candidates.filter(row=>row.subjectMatch):candidates.filter(row=>row.focusHits.length>=3);
  const scored=anchored.map(row=>{
    const weight=(t:string)=>Math.log(1+document.blocks.length/(frequency.get(t)||1))*Math.min(4,t.length);
    const focusScore=row.focusHits.reduce((n,t)=>n+weight(t),0),subjectScore=row.subjectHits.reduce((n,t)=>n+weight(t),0);
    const headingTerms=focus.filter(t=>row.block.sectionPath.toLowerCase().includes(t)).length;
    return {...row,score:focusScore+subjectScore*.45+Math.min(3,headingTerms)};
  }).filter(row=>row.focusHits.length>0).sort((a,b)=>b.score-a.score||a.block.textStart-b.block.textStart);
  const selected:typeof scored=[];
  for(const hit of scored){
    // Nearby hits are one context window; prefer additional sections/claims.
    if(selected.some(old=>old.block.sectionPath===hit.block.sectionPath&&Math.abs(old.block.textStart-hit.block.textStart)<700))continue;
    selected.push(hit);if(selected.length>=(request.limit||8))break;
  }
  return {document:{docId:doc.id,fileName:doc.fileName,fileType:doc.fileType,parseStatus:'ready',indexStatus:doc.status,version,totalChars:document.normalizedText.length,blockCount:document.blocks.length},
    hits:selected.map(row=>{
      const anchor=[...row.focusHits].sort((a,b)=>(frequency.get(a)||1)-(frequency.get(b)||1)||b.length-a.length)[0];
      const index=document.normalizedText.slice(row.block.textStart,row.block.textEnd).toLowerCase().indexOf(anchor);
      return{blockId:row.block.id,sectionPath:row.block.sectionPath,locator:row.block.locator,textStart:row.block.textStart,textEnd:row.block.textEnd,
        matchStart:row.block.textStart+Math.max(0,index),score:row.score,matchedTerms:row.focusHits.slice(0,24)};
    })};
}
