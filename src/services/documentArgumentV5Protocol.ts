import type { CompactInheritedGraph, DocumentArgumentGraph, DocumentArgumentNode, DocumentArgumentV5Snapshot, DocumentArgumentWindow, DocumentArgumentRelationPolicy, DocumentArgumentEdgeAudit } from './documentArgumentV5Types';
import { ArgumentQuoteLocationError, locateDocumentArgumentQuote } from './documentArgumentQuoteLocator';
import {documentArgumentEffectiveRoles,documentArgumentEffectiveNodes} from './documentArgumentRoleRevisions';

export function v5Demand(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`资料论证图校验失败：${message}`);
}
const roles = new Set(['claim', 'premise', 'background', 'method']);
const kinds = new Set(['context', 'method_for', 'relates']);
const id = (value: unknown): value is string => typeof value === 'string' && /^N[1-9]\d*$/u.test(value);
const array = (value: unknown, limit: number): value is any[] => Array.isArray(value) && value.length <= limit;

export function documentArgumentEdges(graph: DocumentArgumentGraph) {
  return [
    ...graph.arguments.flatMap(a => [
      ...a.support.map(from => ({ kind: 'support' as const, from, to: a.claim })),
      ...a.oppose.map(from => ({ kind: 'oppose' as const, from, to: a.claim })),
    ]),
    ...graph.relations.map(({ kind, from, to }) => ({ kind, from, to })),
  ];
}
export const documentArgumentEdgeSignature=(edge:{kind:string;from:string;to:string})=>JSON.stringify([edge.kind,edge.from,edge.to]);
/** A transient topology projection, never a rewrite of saved arguments or joint grounds. */
export function documentArgumentUniqueEdges(graph:DocumentArgumentGraph){
  return [...new Map(documentArgumentEdges(graph).map(edge=>[documentArgumentEdgeSignature(edge),edge])).values()];
}
export function replayDocumentArgumentNode(node: DocumentArgumentNode, chunks: DocumentArgumentV5Snapshot['chunks']) {
  if (node.fallbackText !== undefined) {
    v5Demand(typeof node.fallbackText==='string'&&!!node.fallbackText.trim()&&node.fallbackText.length<=20000,`${node.id} 节点正文`);
    return node.fallbackText;
  }
  return node.source.map(s => {
    const chunk = chunks.find(c => c.id === s.chunkId);
    v5Demand(chunk && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= chunk.content.length, `${node.id} 来源范围`);
    return chunk.content.slice(s.start, s.end);
  }).join('\n');
}

/** Strict mode is retained for offline diagnostics. Production records graph
 * quality issues; unreadable fields and unusable node identities remain fatal. */
export function validateDocumentArgumentV5Graph(graph: DocumentArgumentGraph, options:{allowRoleConflicts?:boolean;qualityMode?:'strict'|'record'}={}) {
  const issues:string[]=[];
  const check=(value:unknown,message:string)=>{
    if(value)return;
    if(options.qualityMode!=='record')v5Demand(false,message);
    if(!issues.includes(message))issues.push(message);
  };
  v5Demand(array(graph.nodes, 4000) && array(graph.arguments, 2000) && array(graph.relations, 8000) && array(graph.unresolved, 2000), '图谱字段或预算');
  const byId = new Map<string, DocumentArgumentNode>();
  for (const node of graph.nodes) {
    v5Demand(node && id(node.id) && !byId.has(node.id) && roles.has(node.role) && Number.isSafeInteger(node.batch) && node.batch > 0
      && array(node.source, 64) && (node.source.length > 0 || typeof node.fallbackText==='string'&&!!node.fallbackText.trim())
      && (node.fallbackText===undefined||typeof node.fallbackText==='string'&&!!node.fallbackText.trim()&&node.fallbackText.length<=20000), '节点格式或重复编号');
    byId.set(node.id, node);
  }
  const effective=documentArgumentEffectiveRoles(graph);
  for(const [nodeId,node] of byId)byId.set(nodeId,{...node,role:effective.get(nodeId)!});
  const argumentIds = new Set<string>();
  for (const a of graph.arguments) {
    v5Demand(a && typeof a.id === 'string' && a.id.length <= 100 && typeof a.claim==='string'
      && array(a.support, 200) && array(a.oppose, 200) && [...a.support,...a.oppose].every(n=>typeof n==='string')
      && typeof a.status==='string', '主张字段无法读取');
    check(!argumentIds.has(a.id)&&byId.has(a.claim)
      &&(options.allowRoleConflicts||byId.get(a.claim)?.role==='claim')
      &&['argued','stated_only','incomplete'].includes(a.status),`${a.id} 主张结构、角色或状态`);
    argumentIds.add(a.id);
    check(new Set(a.support).size === a.support.length && new Set(a.oppose).size === a.oppose.length, `${a.id} 重复论据`);
    for (const n of [...a.support, ...a.oppose]) check(n !== a.claim && byId.has(n)
      && (options.allowRoleConflicts || ['claim', 'premise'].includes(byId.get(n)?.role || '')), `${a.id} 论据端点或角色`);
    check(a.support.every(n => !a.oppose.includes(n)), `${a.id} 同一材料同时支持和反对`);
  }
  const edgeIds = new Set<string>(), signatures = new Set<string>();
  for (const r of graph.relations) {
    v5Demand(r && typeof r.id === 'string' && r.id.length <= 100 && kinds.has(r.kind)
      &&typeof r.from==='string'&&typeof r.to==='string'&&typeof r.reason==='string'&&r.reason.length<=600,'关系字段无法读取');
    check(!edgeIds.has(r.id)&&byId.has(r.from)&&byId.has(r.to)&&r.from!==r.to&&!!r.reason.trim(),
      `${String(r?.id)} 关系字段或端点（${String(r?.kind)}：${String(r?.from)} → ${String(r?.to)}）`);
    const signature = JSON.stringify([r.kind, r.from, r.to]);
    check(!signatures.has(signature), `${r.id} 重复关系 ${r.from} → ${r.to}`);
    signatures.add(signature); edgeIds.add(r.id);
    v5Demand(r.policy===undefined||r.policy==='v5.0.8','关系规则版本');
    const policy=r.policy||'legacy';
    check(options.allowRoleConflicts || r.kind !== 'context' || documentArgumentEdgeRolesValid(r,effective,policy), `${r.id} context 来源不是背景或允许的前提`);
    check(options.allowRoleConflicts || r.kind !== 'method_for' || documentArgumentEdgeRolesValid(r,effective,policy), `${r.id} method_for 角色不匹配`);
    // With optional anchors, numbering alone is not proof of source order for
    // an unlocated block. Keep those cases semantic instead of reintroducing a
    // quote-location gate through a different validation rule.
    check(policy!=='v5.0.8'||r.kind!=='context'||!byId.has(r.from)||!byId.has(r.to)||byId.get(r.from)!.fallbackText!==undefined
      ||byId.get(r.to)!.fallbackText!==undefined||Number(r.from.slice(1))<Number(r.to.slice(1)),
      `${r.id} v5.0.8 context 必须由前文指向后文；回指应使用 relates`);
  }
  v5Demand(graph.pendingEdges===undefined||array(graph.pendingEdges,8000),'待复核关系预算');
  const pendingIds=new Set<string>();
  for(const edge of graph.pendingEdges||[]){
    v5Demand(edge&&Object.keys(edge).sort().join('|')===(edge.policy===undefined?'batch|from|id|kind|reason|to':'batch|from|id|kind|policy|reason|to')
      &&(edge.policy===undefined||edge.policy==='v5.0.8')
      &&typeof edge.id==='string'&&edge.id.length<=100&&!pendingIds.has(edge.id)
      &&Number.isSafeInteger(edge.batch)&&edge.batch>0
      &&['support','oppose','context','method_for','relates'].includes(edge.kind)
      &&typeof edge.from==='string'&&typeof edge.to==='string'
      &&typeof edge.reason==='string'&&!!edge.reason.trim()&&edge.reason.length<=600,'待复核关系字段');
    check(byId.has(edge.from)&&byId.has(edge.to)&&edge.from!==edge.to,`${edge.id} 待复核关系端点或自环`);
    pendingIds.add(edge.id);
  }
  for (const u of graph.unresolved) {
    v5Demand(u && Number.isSafeInteger(u.batch) && u.batch > 0 && typeof u.reason === 'string'
      && u.reason.length <= 600 && (u.nodeId===undefined||typeof u.nodeId==='string'), '未解决项字段');
    check(!u.nodeId||byId.has(u.nodeId),`未解决项节点不存在：${u.nodeId}`);
  }
  // A support cycle is circular proof. Oppose and navigation edges do not prove a claim.
  const next = new Map<string, string[]>();
  for (const e of documentArgumentEdges(graph).filter(e => e.kind === 'support')) next.set(e.from, [...(next.get(e.from) || []), e.to]);
  const active = new Set<string>(), seen = new Set<string>();
  const visit = (n: string) => {
    if(active.has(n)){check(false,`support 自证闭环：${n}`);return;}
    if (seen.has(n)) return;
    active.add(n); for (const to of next.get(n) || []) visit(to); active.delete(n); seen.add(n);
  };
  for (const n of byId.keys()) visit(n);
  if(options.qualityMode==='record'){
    const touched=new Set(documentArgumentEdges(graph).filter(e=>byId.has(e.from)&&byId.has(e.to)&&e.from!==e.to).flatMap(e=>[e.from,e.to]));
    for(const n of graph.nodes)if(!touched.has(n.id))check(false,`孤立节点：${n.id}`);
    const detached=documentArgumentComponents(graph).slice(1);
    for(const group of detached)check(false,`断开分量：${group.join('、').slice(0,480)}`);
  }
  return issues;
}

/** Persist diagnostics without deleting, retyping or redirecting model edges. */
export function recordDocumentArgumentV5Issues(graph:DocumentArgumentGraph,batch=Math.max(1,...graph.nodes.map(n=>n.batch))){
  const issues=validateDocumentArgumentV5Graph(graph,{qualityMode:'record'});
  for(const issue of issues){
    const reason=`[本地告警] ${issue}`.slice(0,600);
    if(graph.unresolved.length<2000&&!graph.unresolved.some(u=>u.reason===reason))graph.unresolved.push({batch,reason});
  }
  recordDocumentArgumentEdgeAudits(graph);
  return issues;
}

/** Mechanical diagnostics only. Semantic validity and boundary exceptions are
 * deliberately not inferred from roles, proximity or an existing arrow. */
export function recordDocumentArgumentEdgeAudits(graph:DocumentArgumentGraph){
  const roles=documentArgumentEffectiveRoles(graph),nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const current:DocumentArgumentEdgeAudit[]=[];
  const check=(edge:{id:string;kind:DocumentArgumentEdgeAudit['kind'];from:string;to:string},valid:boolean,
    localRule:string,issueType:'structural_violation'|'type_mismatch',reason:string)=>{
    if(!valid)current.push({edgeId:edge.id,kind:edge.kind,from:edge.from,to:edge.to,timeStatus:'current',
      issueType,reason,action:'pending_review',localRule});
  };
  const edges=[...graph.arguments.flatMap(a=>[
    ...a.support.map(from=>({id:a.id,kind:'support' as const,from,to:a.claim,policy:undefined})),
    ...a.oppose.map(from=>({id:a.id,kind:'oppose' as const,from,to:a.claim,policy:undefined})),
  ]),...graph.relations];
  const signatures=new Set<string>();
  for(const edge of edges){
    const endpoints=nodes.has(edge.from)&&nodes.has(edge.to);
    check(edge,endpoints&&edge.from!==edge.to,'endpoints','structural_violation','端点不存在或自环；仅记录，不自动修改。');
    const signature=documentArgumentEdgeSignature(edge);
    check(edge,!signatures.has(signature),'duplicate','structural_violation','与已有同类型、同方向、同端点关系重复。');
    signatures.add(signature);
    if(!endpoints)continue;
    check(edge,documentArgumentEdgeRolesValid(edge,roles,edge.policy||'legacy'),'roles','type_mismatch',
      '有效角色与关系的端点契约不符；不代表已确认语义错误或其他类型成立。');
    if(edge.kind==='context'&&edge.policy==='v5.0.8'){
      check(edge,nodes.get(edge.from)!.fallbackText!==undefined||nodes.get(edge.to)!.fallbackText!==undefined
        ||Number(edge.from.slice(1))<Number(edge.to.slice(1)),'context_order','structural_violation',
      '不符合 context 前文→后文输出约定；是否存在后文解释前文需另行语义核对，不自动改 relates。');
    }
  }
  const key=(a:DocumentArgumentEdgeAudit)=>JSON.stringify([a.edgeId,a.kind,a.from,a.to,a.localRule]);
  const present=new Set(current.map(key)),byKey=new Map(current.map(a=>[key(a),a]));
  // Manually classified records (no localRule) and imported history stay intact.
  const retained=(graph.edgeAudits||[]).map(a=>{
    if(!a.localRule||a.timeStatus==='historical')return a;
    const live=byKey.get(key(a));
    return live?{...a,timeStatus:'current' as const}:a.timeStatus==='current'?{...a,timeStatus:'resolved' as const}:a;
  });
  const known=new Set(retained.filter(a=>a.timeStatus!=='historical').map(key));
  for(const a of current)if(present.has(key(a))&&!known.has(key(a))){retained.push(a);known.add(key(a));}
  if(retained.length||graph.edgeAudits)graph.edgeAudits=retained;
  return current;
}

export function documentArgumentEdgeRolesValid(edge:{kind:string;from:string;to:string},roles:Map<string,string>,policy:DocumentArgumentRelationPolicy='legacy'){
  if(edge.kind==='support'||edge.kind==='oppose')return ['claim','premise'].includes(roles.get(edge.from)||'')&&roles.get(edge.to)==='claim';
  if(edge.kind==='context')return (policy==='v5.0.8'?['background','premise']:['background']).includes(roles.get(edge.from)||'');
  if(edge.kind==='method_for')return (policy==='v5.0.8'?['method','background']:['method']).includes(roles.get(edge.from)||'')&&['claim','premise'].includes(roles.get(edge.to)||'');
  return edge.kind==='relates';
}

export class DocumentArgumentQuoteValidationError extends Error {
  readonly issues: Array<{nodeId:string;window:string;quote:string;reason:string}>;
  readonly issueCount:number;
  constructor(issues:Array<{nodeId:string;window:string;quote:string;reason:string}>) {
    super(`资料论证图校验失败：${issues.length}处引文定位问题；${issues.slice(0,3).map(i=>`${i.nodeId} / ${i.window}：${i.reason}（${i.quote.slice(0,100)}）`).join('；')}`);
    this.name='DocumentArgumentQuoteValidationError';
    this.issueCount=issues.length;this.issues=issues.slice(0,20);
  }
}

export function parseDocumentArgumentV5Batch(raw: string, windows: DocumentArgumentWindow[], prior: DocumentArgumentGraph,
  inherited: CompactInheritedGraph, batch: number, sourceMode:'window'|'batch-text'='window',deferRoleConflicts=false,relationPolicy:DocumentArgumentRelationPolicy='legacy',qualityMode:'strict'|'record'='strict') {
  v5Demand(sourceMode!=='batch-text'||windows.length===1,'本批正文必须唯一');
  v5Demand(raw.length <= 2_000_000, '响应预算');
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
  v5Demand(value && Object.keys(value).sort().join('|') === 'arguments|nodes|relations|unresolved', '根字段');
  v5Demand(array(value.nodes, 200) && array(value.arguments, 60) && array(value.relations, 200) && array(value.unresolved, 20), '批次字段预算');
  const inheritedIds = new Set(inherited.nodes.map(n => n.id));
  const localIds = new Set<string>();
  const endpointIssues:string[]=[];
  const quoteIssues: Array<{nodeId:string;window:string;quote:string;reason:string}>=[];
  // Unique first quotes anchor model-declared source order. Only use TWO agreed
  // neighbours to disambiguate a repeated first quote; never choose the first hit.
  const primary=value.nodes.map((node:any)=>{
    try{
      const s=node.source[0],wi=sourceMode==='batch-text'?0:windows.findIndex(w=>w.id===s.window),w=windows[wi];
      return {wi,...locateDocumentArgumentQuote(w.text,s.quote,{wrapHyphens:w.wrapHyphens})};
    }catch{return null;}
  });
  const anchored=primary.filter((p:any)=>p!==null);
  const ordered=value.nodes.every((n:any,i:number)=>id(n?.id)&&(i===0||Number(n.id.slice(1))>Number(value.nodes[i-1].id.slice(1))))
    &&anchored.every((p:any,i:number)=>i===0||p.wi>anchored[i-1].wi||p.wi===anchored[i-1].wi&&p.start>=anchored[i-1].start);
  const located = value.nodes.map((node: any,nodeIndex:number) => {
    v5Demand(node && Object.keys(node).sort().join('|') === 'id|role|source' && id(node.id) && roles.has(node.role)
      && !localIds.has(node.id) && !prior.nodes.some(n => n.id === node.id) && array(node.source, 12) && node.source.length, '新增节点或继承节点被重抽');
    localIds.add(node.id);
    const sources: DocumentArgumentNode['source'] = [];
    let unlocated=false;
    let position = Infinity;
    for (const [sourceIndex,source] of node.source.entries()) {
      v5Demand(source && Object.keys(source).sort().join('|') === (sourceMode==='batch-text'?'quote':'quote|window') && typeof source.quote === 'string' && source.quote.trim(), '引文字段');
      const wi = sourceMode==='batch-text'?0:windows.findIndex(w => w.id === source.window), window = windows[wi];
      let range:{start:number;end:number};
      try {
        v5Demand(window, '引文窗口不存在');
        try{range=locateDocumentArgumentQuote(window.text, source.quote,{wrapHyphens:window.wrapHyphens});}
        catch(error){
          if(!(error instanceof ArgumentQuoteLocationError)||error.reason!=='ambiguous'||sourceIndex!==0||!ordered)throw error;
          const before=primary.slice(0,nodeIndex).filter((p:any)=>p?.wi===wi).at(-1);
          const after=primary.slice(nodeIndex+1).find((p:any)=>p?.wi===wi);
          if(!before||!after||before.start>=after.start)throw error;
          range=locateDocumentArgumentQuote(window.text,source.quote,{wrapHyphens:window.wrapHyphens,minStart:before.start+1,maxStart:after.start-1});
          if(range.end>after.start)throw error;
        }
      } catch(error) {
        unlocated=true;
        quoteIssues.push({nodeId:node.id,window:sourceMode==='batch-text'?'本批正文':String(source.window),quote:source.quote,reason:error instanceof Error?error.message:String(error)});
        continue;
      }
      position = Math.min(position, windows.slice(0, wi).reduce((s, w) => s + w.text.length + 1, 0) + range.start);
      let offset = 0;
      for (const part of window.parts) {
        offset=part.windowStart??offset;
        const length = part.end - part.start;
        const begin = Math.max(range.start, offset), end = Math.min(range.end, offset + length);
        if (end > begin) sources.push({ chunkId: part.chunkId, start: part.start + begin - offset, end: part.start + end - offset });
        offset += length;
      }
      v5Demand(offset === window.text.length, '窗口坐标映射长度');
    }
    return { originalId: node.id, position, node: { id: node.id, role: node.role, batch,
      source:unlocated&&sourceMode==='batch-text'?[]:sources,
      ...(unlocated&&sourceMode==='batch-text'?{fallbackText:node.source.map((s:any)=>s.quote).join('\n')}:{}),
    } as DocumentArgumentNode };
  });
  if(quoteIssues.length&&sourceMode==='window')throw new DocumentArgumentQuoteValidationError(quoteIssues);
  // Correct all fully anchored nodes independently of quote failures elsewhere.
  // Unlocated/partially located blocks retain their MODEL-order slots, not
  // fabricated source coordinates. Filling the other slots with sorted anchors
  // keeps every known pair in source order without pushing unknown blocks to
  // the tail or allowing one bad quote to freeze the entire batch's ordering.
  const sourceOrdered=located.filter(n=>n.node.fallbackText===undefined&&Number.isFinite(n.position))
    .sort((a,b)=>a.position-b.position);
  const modelOrdered=[...located].sort((a,b)=>Number(a.originalId.slice(1))-Number(b.originalId.slice(1)));
  let sourceIndex=0;
  const orderedNodes=modelOrdered.map(n=>n.node.fallbackText!==undefined||!Number.isFinite(n.position)?n:sourceOrdered[sourceIndex++]);
  located.splice(0,located.length,...orderedNodes);
  const next = Number(inherited.next_node_id.slice(1));
  const remap = new Map<string,string>(located.map((n, i) => [n.originalId, `N${next + i}`]));
  // Explainability fields may mention node IDs too. Replace exact ID tokens in
  // one pass (not recursively), while leaving immutable original quotes alone.
  const remapMentions=(text:string)=>text.replace(/(?<![A-Za-z0-9_])N[1-9]\d*(?![A-Za-z0-9_])/gu,old=>remap.get(old)||old);
  const endpoint = (n: unknown) => {
    v5Demand(typeof n === 'string'&&n.length>0&&n.length<=100,'端点字段无法读取');
    if(!localIds.has(n)&&!inheritedIds.has(n)){
      if(qualityMode==='strict')v5Demand(false,'端点超出本批与交接图');
      endpointIssues.push(`端点超出本批与交接图：${n}`);
    }
    return remap.get(n) || n;
  };
  // Accept argument edges emitted in relations without changing their semantics.
  if(sourceMode==='batch-text')value.relations=value.relations.filter((r:any)=>{
    if(!r||!['support','oppose'].includes(r.kind))return true;
    v5Demand(Object.keys(r).sort().join('|')==='from|id|kind|reason|to'
      &&typeof r.reason==='string'&&!!r.reason.trim()&&r.reason.length<=600,`${String(r.id)} 论证关系字段`);
    endpoint(r.from);endpoint(r.to);
    let a=value.arguments.find((a:any)=>a?.claim===r.to);
    if(!a){a={id:`normalized-${value.arguments.length+1}`,claim:r.to,support:[],oppose:[],status:'stated_only'};value.arguments.push(a);}
    v5Demand(array(a.support,200)&&array(a.oppose,200),`${String(a.id)} 论据数组`);
    const target=r.kind==='support'?a.support:a.oppose;
    if(!target.includes(r.from))target.push(r.from);
    return false;
  });
  const graph: DocumentArgumentGraph = {
    nodes: located.map(n => ({ ...n.node, id: remap.get(n.originalId)! })),
    arguments: value.arguments.map((a: any, i: number) => {
      v5Demand(a && Object.keys(a).sort().join('|') === 'claim|id|oppose|status|support' && array(a.support, 200) && array(a.oppose, 200), 'argument 格式');
      return { id: `B${batch}:A${i + 1}`, claim: endpoint(a.claim), support: a.support.map(endpoint), oppose: a.oppose.map(endpoint), status: a.status };
    }),
    relations: value.relations.map((r: any, i: number) => {
      v5Demand(r && Object.keys(r).sort().join('|') === 'from|id|kind|reason|to', 'relation 格式');
      return { id: `B${batch}:R${i + 1}`, kind: r.kind, from: endpoint(r.from), to: endpoint(r.to), reason: remapMentions(r.reason),
        ...(relationPolicy==='v5.0.8'?{policy:'v5.0.8' as const}:{}) };
    }),
    unresolved: value.unresolved.map((u: any) => {
      v5Demand(typeof u === 'string' || (u && typeof u.reason === 'string'), 'unresolved 格式');
      return { batch, ...(u.nodeId ? { nodeId: endpoint(u.nodeId) } : {}), reason: remapMentions(typeof u === 'string' ? u : u.reason) };
    }),
  };
  for(const n of located)if(n.node.fallbackText!==undefined||!Number.isFinite(n.position)){
    // Diagnostics are bounded by the shared storage budget; uncertainty never
    // becomes a new admission gate, and no exact position is invented.
    if(prior.unresolved.length+graph.unresolved.length<2000)graph.unresolved.push({batch,nodeId:remap.get(n.originalId)!,
      reason:'[本地告警] 原文顺序未确认：引文未能完整定位，暂保留模型编号槽位；其余已定位节点独立按原文顺序纠正，未推断本节点的来源位置。'});
  }
  // Deduplicate exact model repetitions without changing relation semantics.
  if(qualityMode==='strict')graph.relations = graph.relations.filter((r, i, all) => all.findIndex(e => e.kind === r.kind && e.from === r.from && e.to === r.to) === i);
  const combined=()=>({ ...(prior.roleRevisions?{roleRevisions:prior.roleRevisions}:{}),nodes: [...prior.nodes, ...graph.nodes], arguments: [...prior.arguments, ...graph.arguments],
    relations: [...prior.relations, ...graph.relations].filter((r, i, all) => all.findIndex(e => e.kind === r.kind && e.from === r.from && e.to === r.to) === i), unresolved: [...prior.unresolved, ...graph.unresolved] });
  if(deferRoleConflicts&&qualityMode==='strict'){
    // Relax roles ONLY during inspection: malformed fields/endpoints, duplicates,
    // self-loops and circular proof must still fail before anything is saved.
    validateDocumentArgumentV5Graph(combined(),{allowRoleConflicts:true});
    const roles=documentArgumentEffectiveRoles(combined());
    const defer=(kind:'support'|'oppose'|'context'|'method_for'|'relates',from:string,to:string,reason:string)=>{
      (graph.pendingEdges??=[]).push({id:`B${batch}:P${(graph.pendingEdges?.length||0)+1}`,batch,kind,from,to,reason,
        ...(relationPolicy==='v5.0.8'?{policy:'v5.0.8' as const}:{})});
    };
    graph.relations=graph.relations.filter(edge=>{
      if(documentArgumentEdgeRolesValid(edge,roles,relationPolicy))return true;
      defer(edge.kind,edge.from,edge.to,edge.reason);return false;
    });
    graph.arguments=graph.arguments.filter(argument=>{
      for(const kind of ['support','oppose'] as const)argument[kind]=argument[kind].filter(from=>{
        if(documentArgumentEdgeRolesValid({kind,from,to:argument.claim},roles))return true;
        defer(kind,from,argument.claim,'初抽提出的论证关系存在角色冲突，须语义复核');return false;
      });
      if(roles.get(argument.claim)!=='claim'){
        graph.unresolved.push({batch,nodeId:argument.claim,reason:'初抽将非主张角色节点用作 argument.claim，需角色复核；未强改原始角色。'});
        return false;
      }
      if(argument.status==='argued'&&!argument.support.length)argument.status='stated_only';
      return true;
    });
  }
  if(qualityMode==='record'){
    const all={...combined(),relations:[...prior.relations,...graph.relations]};
    const issues=[...endpointIssues,...validateDocumentArgumentV5Graph(all,{qualityMode:'record'})];
    for(const reason of new Set(issues))if(graph.unresolved.length<2000)graph.unresolved.push({batch,reason:`[本地告警] ${reason}`.slice(0,600)});
  }else validateDocumentArgumentV5Graph({...combined(),...(graph.pendingEdges?{pendingEdges:graph.pendingEdges}:{})});
  return graph;
}

/** Frozen tail-six + one-hop sources selection, bounded to sixteen nodes. */
export function selectDocumentArgumentV5Handoff(graph: DocumentArgumentGraph, chunks: DocumentArgumentV5Snapshot['chunks']): CompactInheritedGraph {
  graph={...graph,nodes:documentArgumentEffectiveNodes(graph)};
  const lastBatch = Math.max(0, ...graph.nodes.map(n => n.batch));
  const tail = graph.nodes.filter(n => n.batch === lastBatch).slice(-6);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const edges = documentArgumentEdges(graph), priority = new Map<string, number>();
  const add = (n: string, p: number) => { if (byId.has(n)) priority.set(n, Math.min(p, priority.get(n) ?? 99)); };
  for (const node of tail) {
    add(node.id, 0);
    if (/(上述|以上|之前|前述|两个情景|该实验|此结果|这些数据|实验\s*[12]|本实验)/u.test(replayDocumentArgumentNode(node, chunks))) {
      for (const e of edges.filter(e => e.from === node.id)) add(e.to, 1);
    }
    if (node.role === 'claim') {
      for (const e of edges.filter(e => e.to === node.id && ['support', 'oppose'].includes(e.kind))) add(e.from, 2);
      for (const e of edges.filter(e => e.to === node.id && ['context', 'method_for'].includes(e.kind))) add(e.from, 3);
    } else if (node.role === 'premise') {
      for (const e of edges.filter(e => e.to === node.id && ['context', 'method_for'].includes(e.kind))) add(e.from, 2);
      for (const e of edges.filter(e => e.from === node.id && ['support', 'oppose'].includes(e.kind))) add(e.to, 2);
    } else if (node.role === 'background') {
      for (const e of edges.filter(e => e.from === node.id)) add(e.to, 3);
    } else {
      for (const e of edges.filter(e => e.from === node.id && ['method_for', 'relates'].includes(e.kind))) add(e.to, 2);
    }
  }
  const selected = new Set([...priority.entries()].sort((a, b) => a[1] - b[1] || Number(b[0].slice(1)) - Number(a[0].slice(1))).slice(0, 16).map(([n]) => n));
  return { next_node_id: `N${Math.max(0, ...graph.nodes.map(n => Number(n.id.slice(1)))) + 1}`,
    nodes: graph.nodes.filter(n => selected.has(n.id)).map(n => ({ id: n.id, role: n.role, text: replayDocumentArgumentNode(n, chunks) })),
    edges: edges.filter(e => selected.has(e.from) && selected.has(e.to)).filter((e, i, all) => all.findIndex(r => r.kind === e.kind && r.from === e.from && r.to === e.to) === i) };
}

export function documentArgumentComponents(graph: DocumentArgumentGraph) {
  const adjacency = new Map(graph.nodes.map(n => [n.id, [] as string[]]));
  for (const e of documentArgumentEdges(graph)) {
    if(!adjacency.has(e.from)||!adjacency.has(e.to))continue;
    adjacency.get(e.from)!.push(e.to); adjacency.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>(), components: string[][] = [];
  for (const n of graph.nodes) if (!seen.has(n.id)) {
    const queue = [n.id]; seen.add(n.id);
    for (let i = 0; i < queue.length; i++) for (const neighbor of adjacency.get(queue[i])!) if (!seen.has(neighbor)) { seen.add(neighbor); queue.push(neighbor); }
    components.push(queue);
  }
  return components.sort((a, b) => b.length - a.length);
}
