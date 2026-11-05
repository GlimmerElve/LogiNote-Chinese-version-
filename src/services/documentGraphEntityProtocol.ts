import {json,shape,demand,str,ids,validateEntities} from './documentGraphProtocol';
import {entityReadingLabel,locateEntityMention,type EntityReadingFragment} from './documentGraphEntityReading';
import type {DocumentGraphEntity,DocumentGraphEntityRelation} from './documentGraphTypes';
export interface EntityMappingIssue {entityId:string;fragmentId?:string;reason:string}
/** Resolve model selections against locally supplied views, then replay exact original text.
 * Bad source selections are quarantined individually; they never become retrieval aliases. */
export function parseEntityReadingResult(raw:string,fragments:EntityReadingFragment[],texts:Map<string,string>){
  const v=json(raw);shape(v,['entities','entityRelations']);
  demand(Array.isArray(v.entities)&&v.entities.length<=160&&Array.isArray(v.entityRelations)&&v.entityRelations.length<=240,'实体抽取预算');
  const byId=new Map(fragments.map(f=>[f.id,f])),seen=new Set<string>(),issues:EntityMappingIssue[]=[];
  const entities:DocumentGraphEntity[]=[],mappings:Array<{entityId:string;fragmentId:string;readingQuote:string;occurrence:number;quote:string;start:number;end:number}>=[];
  for(const e of v.entities){
    shape(e,['id','name','mentions']);str(e.id,128);str(e.name,150);
    demand(!seen.has(e.id)&&Array.isArray(e.mentions)&&e.mentions.length>0&&e.mentions.length<=160,'实体ID或提及');seen.add(e.id);
    const mentions:DocumentGraphEntity['mentions']=[];
    for(const m of e.mentions){
      shape(m,['fragmentId','quote','occurrence','reference']);str(m.fragmentId,160);str(m.quote,200);
      demand(typeof m.reference==='boolean'&&Number.isSafeInteger(m.occurrence)&&m.occurrence>=1,'实体位置选择格式');
      const fragment=byId.get(m.fragmentId);
      if(!fragment){issues.push({entityId:e.id,fragmentId:m.fragmentId,reason:'unknown_fragment'});continue;}
      const located=locateEntityMention(fragment,m.quote,m.occurrence);
      if(located.status!=='matched'){issues.push({entityId:e.id,fragmentId:m.fragmentId,reason:located.status});continue;}
      if(located.quote.length>200||texts.get(fragment.nodeId)?.slice(located.source.start,located.source.end)!==located.quote){
        issues.push({entityId:e.id,fragmentId:m.fragmentId,reason:'source_replay_failed_or_over_budget'});continue;
      }
      if(mentions.some(old=>old.nodeId===fragment.nodeId&&old.source?.start===located.source.start&&old.source.end===located.source.end)){
        issues.push({entityId:e.id,fragmentId:m.fragmentId,reason:'duplicate_occurrence'});continue;
      }
      mentions.push({nodeId:fragment.nodeId,quote:located.quote,source:located.source,reference:m.reference});
      mappings.push({entityId:e.id,fragmentId:m.fragmentId,readingQuote:m.quote,occurrence:m.occurrence,quote:located.quote,...located.source});
    }
    if(!mentions.some(m=>!m.reference&&entityReadingLabel(m.quote)===e.name)){
      issues.push({entityId:e.id,reason:'no_grounded_canonical_name'});continue;
    }
    entities.push({id:e.id,name:e.name,mentions});
  }
  const retained=new Set(entities.map(e=>e.id)),entityRelations:DocumentGraphEntityRelation[]=[];
  for(const r of v.entityRelations){
    shape(r,['from','to','predicate','evidenceNodeIds']);str(r.predicate,120);ids(r.evidenceNodeIds);
    demand(seen.has(r.from)&&seen.has(r.to)&&r.from!==r.to&&r.evidenceNodeIds.length&&r.evidenceNodeIds.every(id=>texts.has(id)),'实体关系端点或证据');
    if(!retained.has(r.from)||!retained.has(r.to)){
      issues.push({entityId:!retained.has(r.from)?r.from:r.to,reason:`relation_quarantined:${r.from}->${r.to}`});continue;
    }
    entityRelations.push(r);
  }
  validateEntities(entities,entityRelations,texts);
  return {entities,entityRelations,issues,mappings:mappings.filter(m=>retained.has(m.entityId))};
}
