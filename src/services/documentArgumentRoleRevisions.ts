import type {DocumentArgumentGraph,DocumentArgumentRole,DocumentArgumentRoleRevision} from './documentArgumentV5Types';

function demand(value:unknown,message:string):asserts value{if(!value)throw new Error(`资料论证图校验失败：角色修订 ${message}`);}
const roles=new Set(['background','method','premise','claim']);
const reason=(value:unknown)=>typeof value==='string'&&!!value.trim()&&value.length<=600;
const quote=(value:unknown)=>typeof value==='string'&&!!value.trim()&&value.length<=20000;
export const canRefineDocumentArgumentRole=(from:DocumentArgumentRole,to:DocumentArgumentRole)=>
  from==='background'&&['method','premise','claim'].includes(to)||from==='premise'&&to==='claim';

/** Resolve the entire append-only ledger. Revoke is explicit and can only undo
 * the latest active refinement of that node, preventing hidden chain rollback. */
export function documentArgumentEffectiveRoles(graph:DocumentArgumentGraph){
  const effective=new Map(graph.nodes.map(n=>[n.id,n.role])),byId=new Map(graph.nodes.map(n=>[n.id,n]));
  const seen=new Set<string>(),active=new Map<string,Extract<DocumentArgumentRoleRevision,{action:'revise'}>>();
  const history=new Map<string,string[]>();
  demand(graph.roleRevisions===undefined||Array.isArray(graph.roleRevisions)&&graph.roleRevisions.length<=8000,'台账格式');
  for(const event of graph.roleRevisions||[]){
    demand(event&&typeof event.id==='string'&&event.id.length<=100&&!seen.has(event.id)
      &&Number.isSafeInteger(event.batch)&&event.batch>0&&reason(event.reason),'事件格式');
    seen.add(event.id);
    if(event.action==='revoke'){
      demand(Object.keys(event).sort().join('|')==='action|batch|id|reason|revisionId','撤销字段');
      const old=active.get(event.revisionId);
      demand(old&&history.get(old.nodeId)?.at(-1)===old.id&&event.batch>=old.batch,'只能撤销最新有效修订');
      effective.set(old.nodeId,old.from);active.delete(old.id);history.get(old.nodeId)!.pop();
      continue;
    }
    demand(event.action==='revise'&&Object.keys(event).sort().join('|')==='action|batch|from|id|nodeEvidence|nodeId|reason|to|usageEvidence','修订字段');
    const node=byId.get(event.nodeId),usage=byId.get(event.usageEvidence?.nodeId);
    demand(node&&usage&&node.id!==usage.id&&Number(usage.id.slice(1))>Number(node.id.slice(1))
      &&event.batch>=Math.max(node.batch,usage.batch),'必须引用实际后文节点');
    demand(roles.has(event.from)&&roles.has(event.to)&&effective.get(event.nodeId)===event.from
      &&canRefineDocumentArgumentRole(event.from,event.to),'不允许的转换或过期角色');
    demand(event.nodeEvidence&&Object.keys(event.nodeEvidence).sort().join('|')==='quote|reason'
      &&quote(event.nodeEvidence.quote)&&reason(event.nodeEvidence.reason)
      &&event.usageEvidence&&Object.keys(event.usageEvidence).sort().join('|')==='nodeId|quote|reason'
      &&quote(event.usageEvidence.quote)&&reason(event.usageEvidence.reason),'缺少两项独立证据');
    effective.set(node.id,event.to);active.set(event.id,event);
    history.set(node.id,[...(history.get(node.id)||[]),event.id]);
  }
  return effective;
}

/** Validate evidence against saved node text, never against newly proposed edges. */
export function validateDocumentArgumentRoleEvidence(graph:DocumentArgumentGraph,texts:Map<string,string>){
  documentArgumentEffectiveRoles(graph);
  for(const event of graph.roleRevisions||[])if(event.action==='revise'){
    demand(texts.get(event.nodeId)?.includes(event.nodeEvidence.quote),'节点自身证据不在原块中');
    demand(texts.get(event.usageEvidence.nodeId)?.includes(event.usageEvidence.quote),'后文使用证据不在原块中');
  }
}

/** A transient projection; never persist these modified role fields as nodes. */
export function documentArgumentEffectiveNodes<T extends DocumentArgumentGraph>(graph:T):T['nodes']{
  const effective=documentArgumentEffectiveRoles(graph);
  return graph.nodes.map(node=>({...node,role:effective.get(node.id)!})) as T['nodes'];
}
