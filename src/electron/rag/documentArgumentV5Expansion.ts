import {QA_GRAPH_LIMITS, type QaDocumentGraph} from '../../services/agent/qaDocumentGraph';
import {retrievalQueryIntent, type DocumentRetrievalStrategy} from '../../services/agent/documentRetrievalPolicy';
import {cosineSimilarity} from './embedding';

type Node=QaDocumentGraph['nodes'][number];
type Edge=QaDocumentGraph['relations'][number];
type Unit={key:string;root:string;rootRank:number;depth:number;tier:number;edges:Edge[];ids:string[];score:number};

/** Read-only projection. Whole direct structures and their connecting paths are atomic.
 * A higher-ranked root may evict lower-ranked roots, never partially clip a package. */
export function expandLayeredDocumentGraph(out:QaDocumentGraph,nodes:Node[],relations:Edge[],seeds:string[],options:{
  strategy:DocumentRetrievalStrategy;query?:string;intentQuery?:string;vector?:number[];embeddings:Map<string,number[]>;
}):QaDocumentGraph {
  // Rewritten searches may change the vector query, not the user's requested function.
  const intentQuery=options.intentQuery??options.query??'';
  const byId=new Map(nodes.map(n=>[n.nodeId,n])),intent=options.strategy==='intent'?retrievalQueryIntent(intentQuery):'general';
  const wantsMethod=options.strategy==='intent'&&/数据.{0,5}(怎么|如何|来源)|如何测|怎么测|用了哪些方法|使用什么方法|方法是什么|被试.{0,5}(多少|构成)|程序.{0,5}(如何|是什么)/u.test(intentQuery);
  const units:Unit[]=[],pending:Unit[]=[],attempted=new Set<string>();
  const trace:NonNullable<QaDocumentGraph['retrievalTrace']>={strategy:options.strategy,intent,entries:[],paths:[],events:[]};
  const union=(xs:Unit[])=>({ids:new Set(xs.flatMap(u=>u.ids)),edges:new Map(xs.flatMap(u=>u.edges.map(e=>[e.id,e] as const)))});
  const fits=(xs:Unit[])=>{
    const u=union(xs);
    return u.ids.size<=QA_GRAPH_LIMITS.nodes&&u.edges.size<=QA_GRAPH_LIMITS.relations
      &&[...u.ids].reduce((sum,id)=>sum+byId.get(id)!.text.length,0)<=QA_GRAPH_LIMITS.characters;
  };
  const omit=(id:string,reason:string)=>out.omissions.push({id,reason});
  for(const [rank,root] of seeds.entries()) {
    const unit={key:`seed:${root}`,root,rootRank:rank,depth:0,tier:0,edges:[],ids:[root],score:1};
    if(fits([...units,unit]))units.push(unit);else omit(root,'entry_node_or_character_budget');
  }
  const weights=(kind:Edge['kind'])=>{
    if(options.strategy!=='intent')return {support:1,oppose:1,method_for:.7,context:.6,relates:.35,explain:.6}[kind];
    if(intent==='opposition')return {support:1.1,oppose:1.4,method_for:.7,context:.65,relates:.9,explain:.65}[kind];
    if(wantsMethod)return {support:.9,oppose:.9,method_for:1.3,context:.65,relates:.5,explain:.65}[kind];
    if(intent==='definition')return {support:.45,oppose:.45,method_for:.4,context:1.4,relates:.55,explain:1.4}[kind];
    return {support:1.2,oppose:1.2,method_for:.75,context:.6,relates:.45,explain:.6}[kind];
  };
  const entryScore=(root:string,rank:number)=>{
    const embedding=options.embeddings.get(root);
    const similarity=options.vector&&embedding?Math.max(0,cosineSimilarity(options.vector,embedding)):.5;
    return .7*(1-rank/Math.max(1,seeds.length)*.25)+.3*similarity;
  };
  const enqueue=(parent:Unit,nodeId:string)=>{
    const groups=new Map<string,Edge[]>();
    // Each claim's entire direct support/oppose structure stays together.
    for(const r of relations.filter(r=>['support','oppose'].includes(r.kind)&&(r.to===nodeId||r.from.includes(nodeId)))) {
      const key=`argument:${r.to}`;
      if(!groups.has(key))groups.set(key,relations.filter(e=>['support','oppose'].includes(e.kind)&&e.to===r.to));
    }
    for(const r of relations.filter(r=>!['support','oppose'].includes(r.kind)&&(r.to===nodeId||r.from.includes(nodeId)))) {
      // All direct results of a method, or direct explanations of a concept, form one unit.
      const key=r.kind==='method_for'||r.kind==='context'?`${r.kind}:${r.from.join('|')}`:`edge:${r.id}`;
      if(!groups.has(key))groups.set(key,r.kind==='method_for'||r.kind==='context'
        ?relations.filter(e=>e.kind===r.kind&&e.from.join('|')===r.from.join('|')):[r]);
    }
    for(const [key,es] of groups) {
      const taskKey=`${parent.root}:${key}`;
      if(attempted.has(taskKey)||pending.some(p=>p.key===taskKey)||es.every(e=>parent.edges.some(p=>p.id===e.id)))continue;
      const edges=[...new Map([...parent.edges,...es].map(e=>[e.id,e])).values()];
      const ids=[...new Set([parent.root,...parent.ids,...edges.flatMap(e=>[...e.from,e.to])])];
      const freshIds=ids.filter(id=>!parent.ids.includes(id));
      const relevance=options.vector&&freshIds.length?Math.max(...freshIds.map(id=>Math.max(0,cosineSimilarity(options.vector!,options.embeddings.get(id)||[])))):.5;
      const relationWeight=Math.max(...es.map(e=>weights(e.kind)));
      const role=byId.get(nodeId)?.role;
      const primary=es.some(e=>((e.kind==='support'||e.kind==='oppose')&&(e.to===nodeId||role==='premise'))
        ||(e.kind==='method_for'&&(e.from.includes(nodeId)&&role==='method'
          ||wantsMethod&&e.to===nodeId&&(role==='premise'||role==='claim')))
        ||(e.kind==='context'&&((e.from.includes(nodeId)&&role==='background')||intent==='definition')));
      // Source/argument chains precede optional downstream influence and surrounding
      // context. Definition queries promote context; nothing is excluded by intent.
      pending.push({key:taskKey,root:parent.root,rootRank:parent.rootRank,depth:parent.depth+1,tier:Math.max(parent.tier,primary?0:1),edges,ids,
        score:entryScore(parent.root,parent.rootRank)*relationWeight/(1+parent.depth*.3)+.08*relevance});
    }
  };
  units.forEach(u=>enqueue(u,u.root));
  const rootPresent=(root:string)=>units.some(u=>u.key===`seed:${root}`);
  // Necessary direct packages precede recursive evidence; optional navigation
  // remains lower-tier. This is semantic protection, not ordinal-neighbour priority.
  while(pending.length) {
    const live=pending.filter(p=>rootPresent(p.root));
    if(!live.length)break;
    const tier=Math.min(...live.map(p=>p.tier));
    const depth=Math.min(...live.filter(p=>p.tier===tier).map(p=>p.depth));
    const load=(root:string)=>union(units.filter(u=>u.root===root)).ids.size;
    const priority=(p:Unit)=>p.score/(1+Math.max(0,load(p.root)-4)/12);
    const candidate=live.filter(p=>p.tier===tier&&p.depth===depth).sort((a,b)=>priority(b)-priority(a)||a.rootRank-b.rootRank||a.key.localeCompare(b.key))[0];
    pending.splice(pending.indexOf(candidate),1);attempted.add(candidate.key);
    const branchPenalty=1/(1+Math.max(0,load(candidate.root)-4)/12);
    // Dry-run replacement: a failed oversized package must never destroy existing entries.
    let trial=[...units,candidate];const evicted:string[]=[];
    if(!fits([candidate])) {
      omit(candidate.key,'atomic_package_exceeds_hard_budget');
      trace.events.push({id:candidate.key,reason:'atomic_package_exceeds_hard_budget',entryId:candidate.root});continue;
    }
    const replaced:Unit[]=[];
    // Reclaim lower-priority whole expansion units before sacrificing an entry.
    // Seed units and the candidate's cumulative connecting path remain intact.
    for(const old of [...units].filter(u=>u.depth>0&&u.rootRank>candidate.rootRank&&u.score<candidate.score)
      .sort((a,b)=>a.score-b.score)) {
      if(fits(trial))break;
      trial=trial.filter(u=>u!==old);replaced.push(old);
    }
    for(const root of [...seeds].reverse()) {
      if(fits(trial))break;
      // Only a direct atomic package may evict another entry. Recursive ancestry
      // is not one indivisible direct structure and must not undo first-layer coverage.
      if(candidate.depth>1)break;
      if(seeds.indexOf(root)<=candidate.rootRank||!rootPresent(root))continue;
      trial=trial.filter(u=>u.root!==root);evicted.push(root);
    }
    if(!fits(trial)) {
      omit(candidate.key,'atomic_package_deferred_budget');
      trace.events.push({id:candidate.key,reason:'atomic_package_deferred_budget',entryId:candidate.root,depth:candidate.depth,branchPenalty});continue;
    }
    units.splice(0,units.length,...trial);
    for(const old of replaced) {
      omit(old.key,'lower_priority_atomic_package_replaced');
      trace.events.push({id:old.key,reason:'lower_priority_atomic_package_replaced',entryId:candidate.root,depth:candidate.depth});
    }
    for(const root of evicted) {
      omit(root,'entry_evicted_for_higher_ranked_atomic_package');
      trace.events.push({id:root,reason:'entry_evicted_for_higher_ranked_atomic_package',entryId:candidate.root,depth:candidate.depth});
    }
    trace.events.push({id:candidate.key,reason:'atomic_package_admitted',entryId:candidate.root,depth:candidate.depth,branchPenalty});
    // context and relates are one-hop navigation, never recursively treated as evidence.
    const newEdges=candidate.edges.filter(e=>!units.some(u=>u!==candidate&&u.root===candidate.root&&u.edges.some(p=>p.id===e.id)));
    const traversable=new Set(newEdges.filter(e=>e.kind==='support'||e.kind==='oppose'||e.kind==='method_for').flatMap(e=>[...e.from,e.to]));
    if(candidate.depth<nodes.length)for(const id of traversable)enqueue(candidate,id);
  }
  const kept=union(units);
  out.nodes=nodes.filter(n=>kept.ids.has(n.nodeId));out.relations=relations.filter(r=>kept.edges.has(r.id));
  for(const r of relations)if((r.kind==='support'||r.kind==='oppose')&&kept.ids.has(r.to)&&!kept.edges.has(r.id))omit(r.id,`direct_${r.kind}_omitted`);
  trace.entries=seeds.map(nodeId=>({nodeId,status:kept.ids.has(nodeId)?'kept':'omitted'}));
  // Reconstruct real walks, not synthetic support chains. Intermediate nodes remain present.
  for(const root of seeds.filter(id=>kept.ids.has(id))) {
    const rootEdges=[...union(units.filter(u=>u.root===root)).edges.values()];
    const queue=[{id:root,ids:[root],edges:[] as string[]}],visited=new Set([root]);
    for(let i=0;i<queue.length;i++) {
      const walk=queue[i];
      trace.paths.push({entryId:root,nodeId:walk.id,nodeIds:walk.ids,relationIds:walk.edges,depth:walk.edges.length});
      for(const e of rootEdges.filter(e=>e.to===walk.id||e.from.includes(walk.id)))for(const id of [...e.from,e.to]) {
        if(visited.has(id))continue;visited.add(id);queue.push({id,ids:[...walk.ids,id],edges:[...walk.edges,e.id]});
      }
    }
  }
  trace.paths=trace.paths.slice(0,192);trace.events=trace.events.slice(0,192);
  out.retrievalTrace=trace;out.omissions=out.omissions.slice(0,128);
  out.limitations.push('检索采用分层原子包；固定24节点，完整高优先级包可淘汰低优先级入口。路径仅说明召回过程，不证明关系正确。');
  return out;
}
