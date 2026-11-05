import type {DocumentGraphEntity,DocumentGraphEntityRelation,DocumentGraphRelation} from './documentGraphTypes';
import type {ReviewedLocalDocumentGraph} from './documentGraphBinding';
import {entityReadingLabel} from './documentGraphEntityReading';
export type ExtractionNode=ReviewedLocalDocumentGraph['nodes'][number];
export type ExtractionWindow={id:string;section:string;text:string};
export type Gap={nodeId:string;reason:string;kind?:'missing_material'|'node_issue'|'classification_note'};
export type Claim={nodeId:string;status:'argued'|'stated_only'|'incomplete';gaps:string[]};
export type ReviewTask={id:string;nodeId:string;check:string;quote:string};
export const NODE_TYPES=['定义','命名','推理','事实陈述','假设','对比','举例','反例削弱','建议对策'];
export function demand(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`图谱校验未通过：${message}`);}
export function shape(v:any,keys:string[]){demand(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===keys.sort().join('|'),'字段不符合协议');}
export function str(v:any,max=600):asserts v is string {demand(typeof v==='string'&&v.trim()&&v.length<=max,'文本为空或超限');}
export function ids(v:any,max=12):asserts v is string[]{demand(Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'),'ID列表无效');}
export function json(raw:string):any {
  demand(raw.length<=2_000_000,'返回过长');const parsed=JSON.parse(raw),stack:Array<Set<string>|null>=[];
  for(let i=0;i<raw.length;i++){
    if(raw[i]==='{')stack.push(new Set());else if(raw[i]==='[')stack.push(null);
    else if(raw[i]==='}'||raw[i]===']')stack.pop();
    else if(raw[i]==='"'){
      const start=i++;while(i<raw.length){if(raw[i]==='\\')i+=2;else if(raw[i]==='"')break;else i++;}
      let next=i+1;while(next<raw.length&&/\s/u.test(raw[next]))next++;
      if(raw[next]===':'){const key=JSON.parse(raw.slice(start,i+1)),seen=stack.at(-1);demand(seen&&!seen.has(key),'JSON重复字段');seen.add(key);}
    }
  }return parsed;
}
/** Validate the envelope without certifying quote provenance. Never use alone for storage. */
export function parseNodeEnvelope(raw:string):ExtractionNode[]{
  const v=json(raw);shape(v,['nodes']);demand(Array.isArray(v.nodes)&&v.nodes.length<=160,'节点上限');
  for(const [i,n] of v.nodes.entries()){
    shape(n,['id','type','source']);demand(n.id===`N${i+1}`&&NODE_TYPES.includes(n.type),'节点编号或类型');
    demand(Array.isArray(n.source)&&n.source.length>0&&n.source.length<=12,'来源数量');
    for(const s of n.source){shape(s,['window','quote']);str(s.window,128);str(s.quote,12000);}
  }
  return v.nodes;
}
export function parseNodes(raw:string,windows:ExtractionWindow[]):ExtractionNode[]{
  const v={nodes:parseNodeEnvelope(raw)},wm=new Map(windows.map(w=>[w.id,w.text]));
  for(const n of v.nodes)for(const s of n.source){const text=wm.get(s.window),at=text?.indexOf(s.quote)??-1;
    demand(text!==undefined&&at>=0&&text.indexOf(s.quote,at+1)<0,`${n.id} 原话缺失或无法唯一定位`);}
  for(let i=0;i<v.nodes.length;i++)for(let j=i+1;j<v.nodes.length;j++)for(const a of v.nodes[i].source)for(const b of v.nodes[j].source)
    if(a.window===b.window)demand(!a.quote.includes(b.quote)&&!b.quote.includes(a.quote),'同一原文位置被重复包含成块');
  return v.nodes;
}
function validateRelationRows(value:any,nodeIds:Set<string>,cap:number):asserts value is DocumentGraphRelation[]{
  demand(Array.isArray(value)&&value.length<=cap,'关系上限');const seen=new Set<string>();
  for(const r of value){shape(r,['id','kind','from','to','reason']);str(r.id,128);ids(r.from);str(r.reason);
    demand(['support','oppose','explain'].includes(r.kind)&&r.from.length&&nodeIds.has(r.to)&&r.from.every(id=>nodeIds.has(id)&&id!==r.to),'关系端点或类型');
    demand(!seen.has(r.id),'重复关系ID');seen.add(r.id);
  }
}
const relationSignature=(r:DocumentGraphRelation)=>JSON.stringify([r.kind,[...r.from].sort(),r.to]);
export function validateRelations(value:any,nodeIds:Set<string>,cap=240):DocumentGraphRelation[]{
  validateRelationRows(value,nodeIds,cap);const sig=new Set<string>();
  for(const r of value){const signature=relationSignature(r);demand(!sig.has(signature),'重复关系');sig.add(signature);}
  for(const kind of ['support','explain']){const active=new Set<string>(),done=new Set<string>();const visit=(id:string)=>{
    demand(!active.has(id),'支持／解释形成闭环');if(done.has(id))return;active.add(id);
    for(const r of value)if(r.kind===kind&&r.from.includes(id))visit(r.to);active.delete(id);done.add(id);
  };for(const id of nodeIds)visit(id);}
  return value;
}
export interface RelationNormalization {
  removedId:string;retainedId:string;kind:DocumentGraphRelation['kind'];from:string[];to:string;
  removedReason:string;retainedReason:string;
}
export interface RelationFormatNormalization {relationId:string;field:'to';before:[string];after:string}
/** List cyclic components, not proposed deletions. Joint premises remain joint edges. */
export function relationCycleGroups(relations:DocumentGraphRelation[]){
  const groups:Array<{kind:'support'|'explain';nodeIds:string[];relationIds:string[]}>=[];
  for(const kind of ['support','explain'] as const){
    const rows=relations.filter(r=>r.kind===kind),ids=[...new Set(rows.flatMap(r=>[...r.from,r.to]))];
    const reach=new Map<string,Set<string>>();
    for(const id of ids){const visited=new Set<string>(),pending=[id];
      while(pending.length){const current=pending.pop()!;if(visited.has(current))continue;visited.add(current);
        for(const r of rows)if(r.from.includes(current))pending.push(r.to);}
      reach.set(id,visited);
    }
    const grouped=new Set<string>();
    for(const id of ids){if(grouped.has(id))continue;
      const nodeIds=ids.filter(other=>reach.get(id)!.has(other)&&reach.get(other)!.has(id));
      nodeIds.forEach(n=>grouped.add(n));if(nodeIds.length<2)continue;
      groups.push({kind,nodeIds,relationIds:rows.filter(r=>nodeIds.includes(r.to)&&r.from.some(n=>nodeIds.includes(n))).map(r=>r.id)});
    }
  }return groups;
}
/** Model-output normalization only. Store validation stays strict. No semantic repairs:
 * keep the first edge, retain both reasons in the audit, and alias only exact edge identities.
 * Unwrap only singleton string targets with an audit, then validate every row and
 * the original budget before deduplication. No multi-target expansion or guessed IDs. */
export function normalizeModelRelations(value:unknown,nodeIds:Set<string>,cap=240,options:{draft?:boolean}={}){
  demand(Array.isArray(value)&&value.length<=cap,'关系上限');
  const formatAudit:RelationFormatNormalization[]=[];
  const rows=value.map(r=>{
    shape(r,['id','kind','from','to','reason']);
    if(Array.isArray(r.to)&&r.to.length===1&&typeof r.to[0]==='string'){
      formatAudit.push({relationId:r.id,field:'to',before:[r.to[0]],after:r.to[0]});return {...r,to:r.to[0]};
    }return r;
  });
  validateRelationRows(rows,nodeIds,cap);
  const relations:DocumentGraphRelation[]=[],bySignature=new Map<string,DocumentGraphRelation>();
  const aliases=new Map<string,string>(),normalizationAudit:RelationNormalization[]=[];
  for(const r of rows){
    const signature=relationSignature(r),first=bySignature.get(signature);
    if(first){
      aliases.set(r.id,first.id);
      normalizationAudit.push({removedId:r.id,retainedId:first.id,kind:r.kind,from:[...r.from],to:r.to,removedReason:r.reason,retainedReason:first.reason});
    }else{
      const copy={...r,from:[...r.from]};bySignature.set(signature,copy);relations.push(copy);aliases.set(r.id,r.id);
    }
  }
  // Only an explicitly requested intermediate draft can reach review with cycles.
  // Final review, retrieval binding and the host remain strict.
  if(!options.draft)validateRelations(relations,nodeIds,cap);
  return {relations,aliases,normalizationAudit,formatAudit};
}
function gaps(value:any,nodes:Set<string>,requireKind=false):Gap[]{demand(Array.isArray(value)&&value.length<=40,'缺口上限');for(const u of value){
  shape(u,requireKind||u?.kind!==undefined?['nodeId','kind','reason']:['nodeId','reason']);
  demand(nodes.has(u.nodeId),'缺口节点');str(u.reason);
  if(requireKind||u.kind!==undefined)demand(['missing_material','node_issue','classification_note'].includes(u.kind),'问题类别');
}return value;}
export function parseRelations(raw:string,nodes:ExtractionNode[],options:{requireGapKind?:boolean;draft?:boolean}={}){
  const v=json(raw);shape(v,['coreClaims','relations','unresolved']);const nm=new Set(nodes.map(n=>n.id));
  const {relations,normalizationAudit,formatAudit}=normalizeModelRelations(v.relations,nm,240,{draft:options.draft}),unresolved=gaps(v.unresolved,nm,options.requireGapKind);
  demand(Array.isArray(v.coreClaims)&&v.coreClaims.length<=40,'主张上限');const seen=new Set<string>();
  for(const c of v.coreClaims){shape(c,['nodeId','status','gaps']);demand(nm.has(c.nodeId)&&!seen.has(c.nodeId)&&['argued','stated_only','incomplete'].includes(c.status),'主张状态');
    demand(Array.isArray(c.gaps)&&c.gaps.length<=40,'主张缺口');c.gaps.forEach(g=>str(g));seen.add(c.nodeId);}
  return {relations,coreClaims:v.coreClaims as Claim[],unresolved,normalizationAudit,formatAudit};
}
/** Only an explicit missing-material diagnosis authorizes automatic cross-graph work.
 * Legacy unclassified diagnostics remain visible, but are not guessed from prose. */
export function missingMaterialNodeIds(unresolved:Gap[]):string[]{
  return [...new Set(unresolved.filter(u=>u.kind==='missing_material').map(u=>u.nodeId))];
}
export function makeReviewTasks(nodes:ExtractionNode[],relations:DocumentGraphRelation[],claims:Claim[],unresolved:Gap[]):ReviewTask[]{
  const tasks:ReviewTask[]=[];const add=(n:ExtractionNode,check:string,quote='')=>tasks.push({id:`T${tasks.length+1}`,nodeId:n.id,check,quote});
  for(const n of nodes){const phrases=new Set<string>();
    for(const s of n.source)for(const m of s.quote.matchAll(/(?:以上|上述|前述|这|那)?(?:两|三|四|五|六|七|八|九|十|[2-9])(?:个|种)?(?:情景|情境|方案|实验)|本实验|该实验|这个效应|该结果|这一结果/gu))phrases.add(m[0]);
    for(const phrase of phrases)add(n,'reference_target',phrase);
    if(n.type==='定义')add(n,'definition_application');if(n.type==='事实陈述')add(n,'factual_explanation');
    if(['推理','命名','反例削弱'].includes(n.type)||claims.some(c=>c.nodeId===n.id))add(n,'argument_chain');
    if(!relations.some(r=>r.to===n.id||r.from.includes(n.id)))add(n,'isolated_context');
    if(unresolved.some(u=>u.nodeId===n.id&&u.kind!=='classification_note'))add(n,'prior_gap');
  }
  for(const group of relationCycleGroups(relations))tasks.push({id:`T${tasks.length+1}`,nodeId:group.nodeIds[0],check:'relation_cycle',quote:JSON.stringify(group)});
  return tasks;
}
export function parseReview(raw:string,nodes:ExtractionNode[],tasks:ReviewTask[],options:{requireGapKind?:boolean}={}){
  const v=json(raw);shape(v,['relations','decisions','referenceResolutions','unresolved']);const nm=new Set(nodes.map(n=>n.id));
  const {relations,aliases,normalizationAudit,formatAudit}=normalizeModelRelations(v.relations,nm),unresolved=gaps(v.unresolved,nm,options.requireGapKind),rm=new Map(relations.map(r=>[r.id,r]));
  demand(Array.isArray(v.decisions)&&v.decisions.length===tasks.length,'复核任务遗漏');const decisions=new Map<string,any>();
  for(const d of v.decisions){shape(d,['taskId','relationIds','reason']);str(d.reason);ids(d.relationIds,240);const task=tasks.find(t=>t.id===d.taskId);
    demand(task&&!decisions.has(d.taskId),'重复或未知复核任务');
    const relationIds=[...new Set((d.relationIds as string[]).map(id=>{const canonical=aliases.get(id);demand(canonical,'复核任务引用未知关系');return canonical;}))];
    for(const id of relationIds){const r=rm.get(id);demand(r&&(r.to===task.nodeId||r.from.includes(task.nodeId)),'复核任务未落实到对应边');}decisions.set(d.taskId,{...d,relationIds});}
  const refs=tasks.filter(t=>t.check==='reference_target'),seen=new Set<string>();demand(Array.isArray(v.referenceResolutions)&&v.referenceResolutions.length===refs.length,'回指任务遗漏');
  for(const ref of v.referenceResolutions){shape(ref,['taskId','targets','reason']);str(ref.reason);ids(ref.targets);const t=refs.find(t=>t.id===ref.taskId);demand(t&&!seen.has(t.id),'回指任务');seen.add(t.id);
    const edges=decisions.get(t.id).relationIds.map(id=>rm.get(id)!);
    for(const id of ref.targets)demand(id!==t.nodeId&&nm.has(id)&&edges.some(r=>r.to===t.nodeId&&r.from.includes(id)||r.to===id&&r.from.includes(t.nodeId)),'回指目标没有对应直接连线');
    if(!ref.targets.length)demand(unresolved.some(u=>u.nodeId===t.nodeId&&u.kind!=='classification_note'&&u.reason.includes(t.quote)),'未解析回指未记录');
  }
  return {relations,unresolved,decisions:[...decisions.values()],normalizationAudit,formatAudit,
    referenceResolutions:v.referenceResolutions as Array<{taskId:string;targets:string[];reason:string}>};
}
/** Shared renderer + host checks. Structural grounding is not a semantic certificate. */
export function validateEntities(entities:DocumentGraphEntity[],relations:DocumentGraphEntityRelation[],texts:Map<string,string>){
  demand(Array.isArray(entities)&&entities.length<=1280&&Array.isArray(relations)&&relations.length<=2560,'实体上限');const seen=new Set<string>();
  for(const e of entities){shape(e,['id','name','mentions']);str(e.id,128);str(e.name,150);demand(!seen.has(e.id)&&Array.isArray(e.mentions)&&e.mentions.length>0&&e.mentions.length<=160,'实体ID或提及');seen.add(e.id);
    let named=false;
    for(const m of e.mentions){shape(m,m.source===undefined?['nodeId','quote','reference']:['nodeId','quote','reference','source']);str(m.quote,200);const text=texts.get(m.nodeId);demand(text&&text.includes(m.quote)&&typeof m.reference==='boolean','实体来源未落在节点原文');
      if(m.source!==undefined){shape(m.source,['start','end']);
        demand(Number.isSafeInteger(m.source.start)&&Number.isSafeInteger(m.source.end)&&m.source.start>=0&&m.source.end>m.source.start&&m.source.end<=text.length&&text.slice(m.source.start,m.source.end)===m.quote,'实体原文坐标不符');}
      if(!m.reference&&(m.quote===e.name||(m.source!==undefined&&entityReadingLabel(m.quote)===e.name)))named=true;
    }demand(named,'实体名称没有原文命名依据');
  }
  for(const r of relations){shape(r,['from','to','predicate','evidenceNodeIds']);str(r.predicate,120);ids(r.evidenceNodeIds);demand(seen.has(r.from)&&seen.has(r.to)&&r.from!==r.to&&r.evidenceNodeIds.length&&r.evidenceNodeIds.every(id=>texts.has(id)),'实体关系端点或证据');}
}
