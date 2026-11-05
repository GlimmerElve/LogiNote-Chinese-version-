/** Pure source validation and readback packaging. Never certifies model semantic judgements. */
export interface CoreSourceSentence { id:string; text:string; scope:'core'|'before'|'after'|'annotation'; window:number|null }
export interface CoreQuote { sentence:string; quote:string }
export interface BoundCoreQuote extends CoreQuote { start:number; end:number }
export type CoreRole='CLAIM'|'PREMISE'|'REBUTTAL';
export type CoreRelationKind='SUPPORTS'|'REBUTS'|'PRESUPPOSES'|'CONTEXT_FOR';
export interface CoreArgumentNode { id:string;role:CoreRole;source:BoundCoreQuote[];text:string;entityIds:string[] }
export interface CoreArgumentRelation { id:string;kind:CoreRelationKind;from:string[];to:string;reason:string }
export interface CoreEntity { id:string;name:string;type:'concept'|'person'|'study'|'metric'|'other';source:BoundCoreQuote[] }
export interface CoreEntityRelation { id:string;from:string;to:string;predicate:string;qualifiers:string[];status:string;source:BoundCoreQuote[] }
export interface CoreClaim { nodeId:string;status:'argued'|'stated_only'|'incomplete';gaps:string[] }
export interface CoreExtractionIssue { layer:string;id:string;code:string }
const fail=(code:string):never=>{throw new Error(`core_knowledge_${code}`);};
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail('shape');}
function text(v:unknown,max=400):string{if(typeof v!=='string'||!v.trim()||v.length>max)return fail('text');return v;}
function strings(v:unknown,max:number):string[]{if(!Array.isArray(v)||v.length>max||v.some(s=>typeof s!=='string'||!s.trim())||new Set(v).size!==v.length)return fail('strings');return [...v];}
function rows(v:unknown,max:number):any[]{if(!Array.isArray(v)||v.length>max)return fail('array_budget');return v;}
function member<T extends string>(v:unknown,values:readonly T[]):T{if(!values.includes(v as T))fail('enum');return v as T;}
function bind(v:unknown,bySentence:Map<string,CoreSourceSentence>):BoundCoreQuote[]{
  const input=rows(v,12);if(!input.length)fail('empty_source');const seen=new Set<string>();
  return input.map(q=>{exact(q,['sentence','quote']);const sentence=bySentence.get(q.sentence),quote=text(q.quote,20000);
    if(!sentence)fail('unknown_sentence');const at=sentence.text.indexOf(quote);if(at<0||sentence.text.indexOf(quote,at+1)>=0)fail('quote_not_unique');
    const key=`${q.sentence}:${at}:${at+quote.length}`;if(seen.has(key))fail('duplicate_source');seen.add(key);
    return{sentence:q.sentence,quote,start:at,end:at+quote.length};});
}
/** Per-record quarantine keeps an invalid argument edge from discarding unrelated entities or raw text. */
export function validateCoreKnowledgeExtraction(raw:unknown,sentences:CoreSourceSentence[]){
  exact(raw,['nodes','relations','coreClaims','entities','entityRelations']);const value=raw as any;
  const bySentence=new Map(sentences.map(s=>[s.id,s]));if(bySentence.size!==sentences.length)fail('duplicate_sentence');
  const issues:CoreExtractionIssue[]=[],quarantined:Array<{layer:string;id:string;value:unknown}>=[];
  function collect<T>(layer:string,input:any[],prefix:string,parse:(row:any)=>T):T[]{
    // Duplicate identities are all quarantined, never first-wins references.
    const counts=new Map<string,number>();for(const r of input)if(typeof r?.id==='string')counts.set(r.id,(counts.get(r.id)||0)+1);
    const output:T[]=[];
    for(const [i,row]of input.entries()){
      const id=typeof row?.id==='string'?row.id:`row-${i}`;
      try{if(!new RegExp(`^${prefix}[1-9][0-9]*$`,'u').test(id)||counts.get(id)!==1)fail('duplicate_or_invalid_id');output.push(parse(row));}
      catch(error){issues.push({layer,id,code:error instanceof Error?error.message:'invalid'});quarantined.push({layer,id,value:row});}
    }return output;
  }
  const entities=collect<CoreEntity>('entities',rows(value.entities,60),'T',e=>{exact(e,['id','name','type','source']);
    const source=bind(e.source,bySentence),name=text(e.name,120);if(!source.some(s=>s.quote.includes(name)))fail('entity_name_not_in_source');
    return{id:e.id,name,type:member(e.type,['concept','person','study','metric','other']),source};});
  const entityById=new Map(entities.map(e=>[e.id,e]));
  const nodes=collect<CoreArgumentNode>('nodes',rows(value.nodes,60),'N',n=>{exact(n,['id','role','source','entityIds']);
    const source=bind(n.source,bySentence),suppliedIds=strings(n.entityIds,30);
    const missing=suppliedIds.filter(id=>!entityById.has(id));
    if(missing.length){issues.push({layer:'entityLinks',id:n.id,code:'core_knowledge_unknown_entity'});
      quarantined.push({layer:'entityLinks',id:n.id,value:missing});}
    return{id:n.id,role:member(n.role,['CLAIM','PREMISE','REBUTTAL']),source,text:source.map(s=>s.quote).join('\n'),entityIds:suppliedIds.filter(id=>entityById.has(id))};});
  const nodeById=new Map(nodes.map(n=>[n.id,n]));
  const relations=collect<CoreArgumentRelation>('relations',rows(value.relations,100),'R',r=>{exact(r,['id','kind','from','to','reason']);
    const from=strings(r.from,12),to=text(r.to,30),kind=member(r.kind,['SUPPORTS','REBUTS','PRESUPPOSES','CONTEXT_FOR']);
    if(!from.length||from.includes(to)||!nodeById.has(to)||from.some(id=>!nodeById.has(id)))fail('invalid_endpoint');
    if((kind==='SUPPORTS'||kind==='REBUTS')&&nodeById.get(to)!.role!=='CLAIM')fail('logical_target_not_claim');
    if(kind==='CONTEXT_FOR'&&from.length!==1)fail('context_single_source');
    return{id:r.id,kind,from,to,reason:text(r.reason)};});
  const entityRelations=collect<CoreEntityRelation>('entityRelations',rows(value.entityRelations,100),'K',r=>{exact(r,['id','from','to','predicate','qualifiers','status','source']);
    if(!entityById.has(r.from)||!entityById.has(r.to)||r.from===r.to)fail('invalid_endpoint');
    return{id:r.id,from:r.from,to:r.to,predicate:text(r.predicate,120),qualifiers:strings(r.qualifiers,12).map(s=>text(s,400)),
      status:member(r.status,['asserted','research_question','hypothesis','unspecified']),source:bind(r.source,bySentence)};});
  const coreClaims:CoreClaim[]=[],claimIds=new Set<string>();
  for(const [i,c]of rows(value.coreClaims,12).entries()){
    try{exact(c,['nodeId','status','gaps']);const node=nodeById.get(c.nodeId);
      if(!node||node.role!=='CLAIM'||claimIds.has(c.nodeId)||!node.source.some(q=>bySentence.get(q.sentence)!.scope==='core'))fail('invalid_core_claim');
      claimIds.add(c.nodeId);coreClaims.push({nodeId:c.nodeId,status:member(c.status,['argued','stated_only','incomplete']),gaps:strings(c.gaps,12).map(s=>text(s))});
    }catch(error){issues.push({layer:'coreClaims',id:c?.nodeId||`row-${i}`,code:error instanceof Error?error.message:'invalid'});quarantined.push({layer:'coreClaims',id:c?.nodeId||`row-${i}`,value:c});}
  }
  // Backward expansion follows complete joint-premise groups; never split a hyperedge to fit a budget.
  const chains=coreClaims.map(claim=>{
    const reached=new Set([claim.nodeId]),edgeIds=new Set<string>();let changed=true;
    while(changed){changed=false;for(const r of relations)if(reached.has(r.to)&&!edgeIds.has(r.id)){
      edgeIds.add(r.id);for(const id of r.from)if(!reached.has(id)){reached.add(id);changed=true;}}}
    const chainNodes=nodes.filter(n=>reached.has(n.id)),chainEntities=new Set(chainNodes.flatMap(n=>n.entityIds));
    const directLogic=relations.filter(r=>r.to===claim.nodeId&&(r.kind==='SUPPORTS'||r.kind==='REBUTS'));
    const sourceGaps=[...claim.gaps];if(claim.status==='argued'&&!directLogic.length)sourceGaps.push('模型标为有论证，但未返回直接支持或反驳关系。');
    return{claimId:claim.nodeId,declaredStatus:claim.status,nodeIds:chainNodes.map(n=>n.id),relationIds:[...edgeIds],
      entityIds:[...chainEntities],sourceSentenceIds:[...new Set(chainNodes.flatMap(n=>n.source.map(s=>s.sentence)))],gaps:sourceGaps,
      completeness:'model_declared_pending_semantic_review' as const};
  });
  const selectedIds=new Set(chains.flatMap(c=>c.nodeIds));
  const detachedNodeIds=nodes.filter(n=>!selectedIds.has(n.id)).map(n=>n.id);
  // Citation reach is NOT semantic coverage. Exact raw sentences always remain available.
  const coverage=sentences.filter(s=>s.scope==='core').map(s=>{
    const argumentQuotes=nodes.flatMap(n=>n.source).filter(q=>q.sentence===s.id),entityQuotes=[...entities.flatMap(e=>e.source),...entityRelations.flatMap(e=>e.source)].filter(q=>q.sentence===s.id);
    const count=(quotes:BoundCoreQuote[])=>new Set(quotes.flatMap(q=>Array.from({length:q.end-q.start},(_,i)=>q.start+i))).size;
    return{sentence:s.id,window:s.window,characters:s.text.length,argumentCitedCharacters:count(argumentQuotes),entityCitedCharacters:count(entityQuotes),
      rawRetained:true,coverageMeaning:'source_citation_only_not_semantic_completeness' as const};});
  return{nodes,relations,coreClaims,entities,entityRelations,chains,detachedNodeIds,issues,quarantined,coverage,
    rawSentences:sentences.map(s=>({...s})),protocolAccepted:issues.length===0,
    semanticAccepted:false,productionAdmission:false,queryable:false,requiresSemanticReview:true,
    policy:{argumentFullTextCoverageRequired:false,entityExtractionScope:'all_core_sentences',rawFallback:'all_input_sentences',automaticSemanticEdgeChanges:0}};
}

/** Progressive disclosure after recall. Bounds select whole chains, never silently truncate premises. */
export function buildCoreKnowledgeContext(result:ReturnType<typeof validateCoreKnowledgeExtraction>,seeds:{argumentNodeIds?:string[];entityIds?:string[];sentenceIds?:string[];maxChains?:number}){
  const nodeIds=new Set(seeds.argumentNodeIds||[]),entityIds=new Set(seeds.entityIds||[]),sentenceIds=new Set(seeds.sentenceIds||[]);
  const eligible=result.chains.filter(c=>c.nodeIds.some(id=>nodeIds.has(id))||c.entityIds.some(id=>entityIds.has(id))||c.sourceSentenceIds.some(id=>sentenceIds.has(id)));
  const maxChains=Math.max(1,Math.min(12,Math.floor(seeds.maxChains||3))),chains=eligible.slice(0,maxChains);
  chains.forEach(c=>{c.nodeIds.forEach(id=>nodeIds.add(id));c.entityIds.forEach(id=>entityIds.add(id));c.sourceSentenceIds.forEach(id=>sentenceIds.add(id));});
  const argumentNodes=result.nodes.filter(n=>nodeIds.has(n.id)),selectedNodeIds=new Set(argumentNodes.map(n=>n.id));
  argumentNodes.forEach(n=>n.source.forEach(q=>sentenceIds.add(q.sentence)));
  const relationIds=new Set(chains.flatMap(c=>c.relationIds));
  const argumentRelations=result.relations.filter(r=>relationIds.has(r.id)&&selectedNodeIds.has(r.to)&&r.from.every(id=>selectedNodeIds.has(id)));
  // Exactly one entity hop; no cascade across an entire document on a common concept.
  const entityRelations=result.entityRelations.filter(r=>entityIds.has(r.from)||entityIds.has(r.to));
  entityRelations.forEach(r=>{entityIds.add(r.from);entityIds.add(r.to);r.source.forEach(q=>sentenceIds.add(q.sentence));});
  const entities=result.entities.filter(e=>entityIds.has(e.id));entities.forEach(e=>e.source.forEach(q=>sentenceIds.add(q.sentence)));
  return{chains,argumentNodes,argumentRelations,entities,entityRelations,rawPassages:result.rawSentences.filter(s=>sentenceIds.has(s.id)),
    deferredClaimIds:eligible.slice(maxChains).map(c=>c.claimId),scope:'validated_sources_pending_semantic_review',semanticAccepted:false};
}
