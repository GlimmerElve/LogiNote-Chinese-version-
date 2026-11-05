import assert from 'node:assert/strict';
import {parseDocumentArgumentV5Batch,replayDocumentArgumentNode,selectDocumentArgumentV5Handoff} from '../src/services/documentArgumentV5Protocol';
import type {DocumentArgumentGraph} from '../src/services/documentArgumentV5Types';
const empty:DocumentArgumentGraph={nodes:[],arguments:[],relations:[],unresolved:[]};
const inherited={next_node_id:'N1',nodes:[],edges:[]};
const text='甲依据。乙定义。丙结论。丁背景。';
const windows=[{id:'batch-text',section:'',text,parts:[{chunkId:'source',start:0,end:text.length}]}];
const chunks=[{id:'source',sectionPath:'',content:text}];
const node=(id:string,quote:string,role='background')=>({id,role,source:[{quote}]});
const parse=(raw:any,prior=empty,handoff=inherited)=>parseDocumentArgumentV5Batch(JSON.stringify(raw),windows,prior,handoff,2,'batch-text',false,'v5.0.8','record');
const body=(nodes:any[])=>({nodes,arguments:[],relations:[],unresolved:[]});
const texts=(g:DocumentArgumentGraph)=>g.nodes.map(n=>replayDocumentArgumentNode(n,chunks));

const allLocated=parse(body([node('N1','丁背景。'),node('N2','丙结论。'),node('N3','甲依据。'),node('N4','乙定义。')]));
assert.deepEqual(texts(allLocated),['甲依据。','乙定义。','丙结论。','丁背景。']);
assert(!allLocated.unresolved.some(u=>u.reason.includes('原文顺序未确认')));

const raw={nodes:[node('N1','丙结论。','claim'),node('N2','定位不了的节点。'),node('N3','甲依据。','premise'),node('N4','乙定义。')],
  arguments:[{id:'A1',claim:'N1',support:['N3'],oppose:[],status:'argued'}],
  relations:[{id:'R1',kind:'context',from:'N4',to:'N1',reason:'N4定义引入N1；不是N40、XN4或N4_id。'}],
  unresolved:[{nodeId:'N1',reason:'N1仍需核对N3。'}]};
const original=JSON.stringify(raw),mixed=parse(raw);
assert.equal(JSON.stringify(raw),original,'input model graph is not mutated');
assert.deepEqual(texts(mixed),['甲依据。','定位不了的节点。','乙定义。','丙结论。']);
assert.deepEqual(mixed.nodes.map(n=>n.id),['N1','N2','N3','N4']);
assert.deepEqual(mixed.nodes[1].source,[]);assert.equal(mixed.nodes[1].fallbackText,'定位不了的节点。');
assert.deepEqual(mixed.arguments[0],{id:'B2:A1',claim:'N4',support:['N1'],oppose:[],status:'argued'});
assert.equal(mixed.relations[0].from,'N3');assert.equal(mixed.relations[0].to,'N4');
assert.equal(mixed.relations[0].reason,'N3定义引入N4；不是N40、XN4或N4_id。','mentions remap once with token boundaries');
assert(mixed.unresolved.some(u=>u.nodeId==='N4'&&u.reason==='N4仍需核对N1。'));
assert(mixed.unresolved.some(u=>u.nodeId==='N2'&&u.reason.includes('原文顺序未确认')));
assert(!mixed.unresolved.some(u=>u.reason.includes('前文指向后文')),'known source ordering is corrected before context validation');
assert.deepEqual(selectDocumentArgumentV5Handoff(mixed,chunks).nodes.map(n=>n.id),['N1','N2','N3','N4']);

const many=parse(body([node('N1','未知甲。'),node('N2','丁背景。'),node('N3','未知乙。'),node('N4','乙定义。'),node('N5','甲依据。'),node('N6','未知丙。')]));
assert.deepEqual(texts(many),['未知甲。','甲依据。','未知乙。','乙定义。','丁背景。','未知丙。'],'unknown slots and relative order survive independently');
assert.deepEqual(many.unresolved.filter(u=>u.reason.includes('原文顺序未确认')).map(u=>u.nodeId),['N1','N3','N6']);
const unknown=parse(body([node('N3','未知丙。'),node('N1','未知甲。'),node('N2','未知乙。')]));
assert.deepEqual(texts(unknown),['未知甲。','未知乙。','未知丙。'],'no anchors: model numeric order, no invented location');

const partial=parse(body([{id:'N1',role:'background',source:[{quote:'丁背景。'},{quote:'未知片段。'}]},node('N2','丙结论。'),node('N3','甲依据。')]));
assert.deepEqual(texts(partial),['丁背景。\n未知片段。','甲依据。','丙结论。']);
assert.equal(partial.nodes[0].fallbackText,'丁背景。\n未知片段。');assert.deepEqual(partial.nodes[0].source,[],'a partial quote cannot masquerade as a complete source anchor');

const prior:DocumentArgumentGraph={nodes:[{id:'N1',role:'premise',batch:1,source:[],fallbackText:'上一批原文。'}],arguments:[],relations:[],unresolved:[]};
const priorBefore=JSON.stringify(prior),next={next_node_id:'N2',nodes:[{id:'N1',role:'premise' as const,text:'上一批原文。'}],edges:[]};
const continuation=parse({nodes:[node('N2','丙结论。','claim'),node('N3','未知说明。'),node('N4','甲依据。','premise')],
  arguments:[{id:'A1',claim:'N2',support:['N1','N4'],oppose:[],status:'argued'}],relations:[],unresolved:[]},prior,next);
assert.equal(JSON.stringify(prior),priorBefore,'frozen prior graph never renumbered');
assert.deepEqual(continuation.nodes.map(n=>n.id),['N2','N3','N4']);
assert.equal(continuation.arguments[0].claim,'N4');assert.deepEqual(continuation.arguments[0].support,['N1','N2']);

const normalised=parse({nodes:[node('N1','丙结论。','claim'),node('N2','未知说明。'),node('N3','甲依据。','premise')],arguments:[],
  relations:[{id:'R1',kind:'support',from:'N3',to:'N1',reason:'原始数据支持概括'}],unresolved:[]});
assert.equal(normalised.arguments[0].claim,'N3');assert.deepEqual(normalised.arguments[0].support,['N1']);
assert(!normalised.relations.length,'proof emitted in relations still normalises and remaps correctly');
console.log('Node order passed: independent anchor sorting, unknown slots/full text/warnings, partial anchors, all-unknown order, inherited IDs, argument/relation/diagnostic remap and handoff. No model calls or production writes.');

if(process.argv.includes('--real-fixture')){
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const {documentArgumentSourceBlocks}=await import('../src/electron/rag/documentArgumentV5Sources');
  const {planDocumentArgumentV5}=await import('../src/electron/rag/documentArgumentV5Plan');
  const {documentArgumentReadingWindows}=await import('../src/services/documentArgumentReadingWindows');
  const dir='D:/新建文件夹/Storagetest/rag-index',docId='doc-1791351154309-8wcx7u';
  const file=`${dir}/argument-graph-v5-${docId}.json`,bytes=await readFile(file);
  const saved=JSON.parse(bytes.toString()),structured=JSON.parse(await readFile(`${dir}/structured-${docId}.json`,'utf8'));
  const source=documentArgumentSourceBlocks(structured,'目标内容效应及其心理机制_胡小勇.pdf');
  const plan=planDocumentArgumentV5(source,structured),windowIds=new Set(saved.build.batches.find((b:any)=>b.batch===2).coverage.map((c:any)=>c.window));
  const reading=documentArgumentReadingWindows(plan.windows.filter(w=>windowIds.has(w.id)));
  const oldNodes=saved.nodes.filter((n:any)=>n.batch===2),oldPrior:DocumentArgumentGraph={nodes:saved.nodes.filter((n:any)=>n.batch<2)
    .map(({text:_t,embedding:_e,...n}:any)=>n),arguments:[],relations:[],unresolved:[]};
  const reconstruct={nodes:oldNodes.map((n:any)=>({id:n.id,role:n.role,source:n.fallbackText!==undefined?[{quote:n.fallbackText}]:n.source.map((p:any)=>({quote:source.find(c=>c.id===p.chunkId)!.content.slice(p.start,p.end)}))})),
    arguments:saved.arguments.filter((a:any)=>a.id.startsWith('B2:')),
    relations:saved.relations.filter((r:any)=>r.id.startsWith('B2:')).map(({policy:_p,...r}:any)=>r),unresolved:[]};
  const parsed=parseDocumentArgumentV5Batch(JSON.stringify(reconstruct),reading,oldPrior,selectDocumentArgumentV5Handoff(oldPrior,source),2,'batch-text',false,'v5.0.8','record');
  const sameNode=(before:any,after:any)=>before.fallbackText!==undefined?before.fallbackText===after.fallbackText
    :JSON.stringify(before.source)===JSON.stringify(after.source);
  const mapping=new Map(oldNodes.map((n:any)=>[n.id,parsed.nodes.find(after=>sameNode(n,after))?.id]));
  assert.equal(mapping.get('N43'),'N56');assert.equal(mapping.get('N44'),'N43');assert.equal(mapping.get('N56'),'N55');
  assert.equal(mapping.get('N76'),'N76');assert.equal(parsed.nodes.find(n=>n.id==='N76')!.fallbackText,oldNodes.find((n:any)=>n.id==='N76').fallbackText);
  for(const old of reconstruct.arguments){const after=parsed.arguments.find(a=>a.id===old.id)!;assert(after);
    assert.equal(after.claim,mapping.get(old.claim)||old.claim);
    assert.deepEqual(after.support,old.support.map((id:string)=>mapping.get(id)||id));assert.deepEqual(after.oppose,old.oppose.map((id:string)=>mapping.get(id)||id));}
  for(const old of reconstruct.relations){const after=parsed.relations.find(r=>r.id===old.id)!;assert(after);
    assert.equal(after.from,mapping.get(old.from)||old.from);assert.equal(after.to,mapping.get(old.to)||old.to);}
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
  console.log('Read-only real-fixture replay passed: reconstructed saved batch2 (not an original model receipt), old N43 sorts after old N56 and before old N57, N76 text/slot retained, all proof/navigation endpoints remapped, stored production file unchanged.');
}
