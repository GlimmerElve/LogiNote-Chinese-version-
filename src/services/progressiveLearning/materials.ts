import type { NoteItem } from '../../types';
import { projectAncestors, projectDocumentBindings } from '../projectResourceScope';
import { readLocalMaterialCatalog, readLocalMaterialPage, searchLocalMaterial } from '../documentRagClient';
import type { MaterialSearch, MaterialSearchRequest, MaterialReadRequest } from '../textbook/materialTypes';
import type { ProgressiveSourcePacket } from './types';
import { isMaterialFrontMatter, progressiveMaterialTerms, usableProgressiveSource } from './sourcePolicy';
import type { ProgressiveExistingConcept } from './conceptPolicy';

interface Reader {
  search(request:MaterialSearchRequest):Promise<MaterialSearch>;
  page: typeof readLocalMaterialPage;
  catalog: typeof readLocalMaterialCatalog;
  web?(noteId:string):Promise<ProgressiveSourcePacket[]>;
}
const defaults:Reader={search:searchLocalMaterial,page:readLocalMaterialPage,catalog:readLocalMaterialCatalog,
  web:async id=>typeof window!=='undefined'&&window.electronAPI?.learningPreparation?.materials?window.electronAPI.learningPreparation.materials(id):[]};

/** Auto routing needs the upcoming mainline and the current gap, without one
 * consuming the other's context budget. IDs belong to this page only. */
export function mergeProgressiveMaterials(primary:ProgressiveSourcePacket[],secondary:ProgressiveSourcePacket[]):ProgressiveSourcePacket[]{
  if(!secondary.length)return primary;
  const result:ProgressiveSourcePacket[]=[],seen=new Set<string>();
  const groups=[primary,secondary].filter(g=>g.length);let remaining=12_000;
  for(const group of groups){let budget=Math.min(remaining,Math.floor(12_000/groups.length));
    for(const source of group){
      if(budget<128||result.length>=12)break;
      const key=source.kind+'\n'+source.locator+'\n'+source.text;if(seen.has(key))continue;seen.add(key);
      let end=Math.min(source.text.length,budget);if(/[\uD800-\uDBFF]/u.test(source.text[end-1]||''))end--;
      const text=source.text.slice(0,end);result.push({...source,id:`S${result.length+1}`,text});budget-=text.length;remaining-=text.length;
    }
  }
  return result;
}

/** Only bounded, versioned excerpts enter the renderer/model. Full-text search
 * reads parsed originals in the host, independently of chunk/embed readiness. */
export async function loadProgressiveMaterials(note:NoteItem,notes:NoteItem[],pageFocus?:string,signal?:AbortSignal,reader:Reader=defaults):Promise<ProgressiveSourcePacket[]>{
  const query=(pageFocus||note.title).slice(0,2000);
  const terms=progressiveMaterialTerms(query+' '+note.title),owners=new Map(notes.map(item=>[item.id,item]));
  const score=(text:string)=>terms.reduce((n,t)=>n+(text.toLowerCase().includes(t)?Math.min(4,t.length):0),0);
  const bindings=projectDocumentBindings(note,notes).map(binding=>({...binding,
    score:score(owners.get(binding.projectNoteId)?.resources?.find(r=>r.documentId===binding.documentId)?.title||'')}))
    .sort((a,b)=>b.score-a.score||Number(a.inherited)-Number(b.inherited));
  const allowedDocIds=bindings.map(b=>b.documentId);
  const hits:Array<{request:MaterialReadRequest;score:number;section:string}>=[];
  for(const binding of bindings){
    signal?.throwIfAborted();
    try{
      const result=await reader.search({allowedDocIds,docId:binding.documentId,query,subject:note.title.slice(0,600),topic:(pageFocus?.split('\n')[0]||note.title).slice(0,600),limit:12});
      signal?.throwIfAborted();
      if(result.document.docId!==binding.documentId||result.document.parseStatus!=='ready'||!result.document.version)continue;
      for(const hit of result.hits){
        if(isMaterialFrontMatter(hit.sectionPath)||!hit.blockId.startsWith(binding.documentId+':block:')||!Number.isFinite(hit.score)||hit.score<=0)continue;
        hits.push({request:{allowedDocIds,docId:binding.documentId,version:result.document.version,target:{kind:'block',blockId:hit.blockId,neighbors:2},
          ...(Number.isSafeInteger(hit.matchStart)?{cursor:Math.max(hit.textStart,hit.matchStart!-600)}:{}),omitImageData:true},score:hit.score,section:hit.sectionPath});
      }
    }catch{
      signal?.throwIfAborted();
      // Older bridges can still paginate the complete catalog. Require a
      // positive topical match instead of blindly taking its first entry.
      try{
        let offset=0,version:string|undefined;
        for(let page=0;page<200;page++){
          signal?.throwIfAborted();
          const catalog=await reader.catalog({allowedDocIds,docId:binding.documentId,version,offset,limit:100});
          if(catalog.document.docId!==binding.documentId||catalog.document.parseStatus!=='ready'||!catalog.document.version||version&&version!==catalog.document.version)break;
          version=catalog.document.version;
          for(const section of catalog.sections){const weight=score(section.sectionPath||section.title);if(weight>0&&!isMaterialFrontMatter(section.sectionPath||section.title))hits.push({request:{allowedDocIds,docId:binding.documentId,version,target:{kind:'section',sectionId:section.id},omitImageData:true},score:weight,section:section.sectionPath||section.title});}
          if(catalog.nextOffset===undefined||catalog.nextOffset<=offset||!catalog.sections.length)break;offset=catalog.nextOffset;
        }
      }catch{signal?.throwIfAborted();}
    }
  }
  hits.sort((a,b)=>b.score-a.score);
  const packets:ProgressiveSourcePacket[]=[],seen=new Set<string>();let remaining=12_000;
  for(const hit of hits){
    signal?.throwIfAborted();if(remaining<256||packets.length>=10)break;
    try{
      let cursor:number|undefined=hit.request.cursor;
      for(let page=0;page<3;page++){
        const result=await reader.page({...hit.request,cursor,maxChars:Math.min(3200,remaining)});
        signal?.throwIfAborted();
        if(result.docId!==hit.request.docId||result.version!==hit.request.version)break;
        const chosen=result.excerpts.filter(e=>!isMaterialFrontMatter(e.sectionPath)&&e.kind!=='heading'&&!seen.has(`${result.docId}@${result.version}:${e.blockId}:${e.textStart}:${e.textEnd}`));
        const text=chosen.map(e=>e.text).join('\n\n').slice(0,Math.min(3200,remaining));
        const packet:ProgressiveSourcePacket={id:`S${packets.length+1}`,title:result.fileName,kind:'document',text,
          locator:`${result.docId}@${result.version} / ${chosen.find(e=>e.sectionPath)?.sectionPath||hit.section}`.slice(0,1000)};
        if(text.trim()&&score(text)>0&&usableProgressiveSource(packet)){
          packets.push(packet);remaining-=text.length;
          chosen.forEach(e=>seen.add(`${result.docId}@${result.version}:${e.blockId}:${e.textStart}:${e.textEnd}`));break;
        }
        if(result.nextCursor===undefined||result.nextCursor===(cursor??result.targetStart))break;
        cursor=result.nextCursor;
      }
    }catch{signal?.throwIfAborted();}
  }
  if(remaining>256&&packets.length<10&&reader.web){
    try{
      for(const source of (await reader.web(note.id)).slice(0,2)){
        signal?.throwIfAborted();if(remaining<256||packets.length>=12)break;
        const text=source.text.slice(0,Math.min(2000,remaining));
        const packet={...source,id:`S${packets.length+1}`,text};
        if(source.kind==='web'&&score(text)>0&&usableProgressiveSource(packet)){packets.push(packet);remaining-=text.length;}
      }
    }catch{signal?.throwIfAborted();}
  }
  signal?.throwIfAborted();return packets;
}

/** Only public goals enter retrieval; no restatement, answers, profile or note bodies. */
export function progressiveGoalContext(note:NoteItem,notes:NoteItem[]):{title:string;rootTitle:string;existingConcepts:ProgressiveExistingConcept[]}{
  const ancestors=projectAncestors(note,notes);
  const normalized=(text:string)=>text.normalize('NFKC').trim().toLocaleLowerCase();
  const links=new Set((note.links||[]).map(normalized));
  const existingConcepts=notes.filter(candidate=>candidate.noteType==='knowledge'&&(candidate.parentId===note.id
    ||[candidate.title,...(candidate.aliases||[])].some(name=>links.has(normalized(name))))).slice(0,24)
    .map(candidate=>({title:candidate.title.slice(0,80),...(candidate.aliases?.length?{aliases:candidate.aliases.slice(0,5).map(alias=>alias.slice(0,80))}:{})}));
  return{title:note.title.slice(0,300),rootTitle:ancestors.at(-1)!.title.slice(0,300),existingConcepts};
}
