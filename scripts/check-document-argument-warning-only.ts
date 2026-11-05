import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setDataRoot,writeStructuredDocumentFile} from '../src/electron/ragIndex';
import {setKnowledgeDataRoot} from '../src/electron/rag/knowledgeStore';
import {buildStructuredDocument} from '../src/electron/rag/structuredDocument';
import {prepareDocumentArgumentV5,commitDocumentArgumentV5,readDocumentArgumentV5View} from '../src/electron/rag/documentArgumentV5Service';
import {readSavedDocumentArgumentV5} from '../src/electron/rag/documentArgumentV5Store';
import {runDocumentArgumentV5Batch} from '../src/services/documentArgumentV5Pipeline';
import {validateDocumentArgumentV5Graph} from '../src/services/documentArgumentV5Protocol';
import {layoutDocumentArgumentGraph} from '../src/services/documentArgumentGraphLayout';
import {routeDocumentArgumentGraph} from '../src/services/documentArgumentGraphRouting';
import {projectDocumentArgumentV5,qualifiedV5NodeId} from '../src/electron/rag/documentArgumentV5Retrieval';
import {readQaDocumentGraphPacket} from '../src/services/agent/qaDocumentGraph';
import type {DocumentArgumentV5Commit} from '../src/services/documentArgumentV5Types';

// Synthetic store and fixed vectors only. Never touch a user vault or call a model.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'argument-warning-only-')),dir=path.join(root,'rag-index');
await fs.mkdir(dir);await fs.mkdir(path.join(root,'documents'));setDataRoot(root);setKnowledgeDataRoot(root);
const docId='synthetic-warnings',texts=['甲主张成立。','乙主张成立。','这是测量方法。','这是单独的背景。'];
await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify([{id:docId,fileName:'合成.txt',indexable:true,status:'ready'}]));
await fs.writeFile(path.join(dir,'knowledge-settings.json'),JSON.stringify({enabled:true}));
await writeStructuredDocumentFile(buildStructuredDocument(docId,texts.map((text,i)=>({text,kind:'paragraph' as const,
  locator:{kind:'text' as const,charStart:i,charEnd:i+1}}))));
const snapshot=await prepareDocumentArgumentV5(docId),embed=async()=>Array.from({length:384},(_,i)=>Number(i===0));
const raw={nodes:texts.map((quote,i)=>({id:`N${i+1}`,role:['claim','claim','method','background'][i],source:[{quote}]})),
  arguments:[{id:'A1',claim:'N1',support:['N2','N2','N1','N999'],oppose:['N2'],status:'argued'},
    {id:'A2',claim:'N2',support:['N1','N3'],oppose:[],status:'argued'}],
  relations:[{id:'R1',kind:'context',from:'N2',to:'N1',reason:'故意反向且来源角色不匹配'},
    {id:'R2',kind:'method_for',from:'N1',to:'N2',reason:'故意方法角色错误'},
    {id:'R3',kind:'relates',from:'N1',to:'N1',reason:'故意自环'},
    {id:'R4',kind:'method_for',from:'N1',to:'N2',reason:'故意重复'},
    {id:'R5',kind:'relates',from:'N999',to:'N2',reason:'故意悬空'}],unresolved:[]};
let calls=0;
const result=await runDocumentArgumentV5Batch(snapshot,{
  prepare:prepareDocumentArgumentV5,guard:async()=>{},commit:c=>commitDocumentArgumentV5(c,{embed}),
  recall:async()=>[{taskId:'C1',component:[{id:'N4',role:'background',text:texts[3]}],
    candidates:[{id:'N2',role:'claim',text:texts[1],distance:2,selection:'ordinal'}],existingEdges:[],round:1,exhaustive:true}],
  call:async(stage)=>{
    calls++;
    if(stage==='extract')return JSON.stringify(raw);
    return JSON.stringify({bridges:[{taskId:'C1',decision:'add',basis:'故意返回有语义校验问题的补链',additions:[
      {kind:'method_for',from:'N4',to:'N4',basis:'自环且目标角色错误'},
      {kind:'context',from:'N2',to:'N1',basis:'超出局部候选、来源角色错误、反向、重复'},
      {kind:'relates',from:'N998',to:'N4',basis:'悬空端点'},
    ]}]});
  },
});
assert.equal(calls,2);assert(result.warning);
const saved=await readSavedDocumentArgumentV5(dir,docId,[]);assert(saved,'warnings do not hide the published graph');
assert.equal(saved.nodes.length,4);assert.equal(saved.relations.length,7,'keep readable new edges, do not reappend an existing arrow');
assert.equal(saved.semanticCertified,false);assert(saved.arguments[0].support.includes('N999'));
assert.throws(()=>validateDocumentArgumentV5Graph(saved),'offline strict audit remains available');
const issues=validateDocumentArgumentV5Graph(saved,{qualityMode:'record'});
for(const needle of ['重复论据','同时支持和反对','关系字段或端点','method_for 角色不匹配','context 来源','必须由前文','自证闭环','重复关系','孤立节点','断开分量'])
  assert(issues.some(s=>s.includes(needle)),`missing diagnostic: ${needle}`);
assert(saved.unresolved.some(u=>u.reason.includes('补链超出局部候选')));
assert(saved.unresolved.some(u=>u.reason.includes('N998')));
assert(!(await fs.readdir(dir)).some(name=>name.includes('.pending.')),'full graph is published even with unresolved components');
const view=await readDocumentArgumentV5View(docId);assert(view.published);assert.equal(view.nodes.length,4);
const layout=layoutDocumentArgumentGraph(view),routing=routeDocumentArgumentGraph(view,layout.positions);
assert(routing.branches.every(b=>layout.positions.has(b.source)&&layout.positions.has(b.target)));
assert(view.edges.some(e=>e.from.includes('N998')),'dangling edge is stored and inspectable, not silently erased');
const sources=snapshot.chunks.map((c,index)=>({...c,docId,fileName:'合成.txt',index,embedding:[]}));
const packet=projectDocumentArgumentV5([saved],sources,[{docId,nodeId:qualifiedV5NodeId(saved,'N2')}]);
assert(packet.omissions.some(o=>o.reason==='dangling_endpoint_recorded_not_executable'));
assert(packet.nodes.length>0);assert(packet.relations.some(r=>r.from.includes(r.to)),'self loops do not erase the whole RAG packet');
const cited={...packet,nodes:packet.nodes.map(n=>({...n,citationId:'C1',sourceParts:n.sourceParts?.map(p=>({...p,citationId:'C1'}))}))};
assert(readQaDocumentGraphPacket(cited,new Set(['C1'])),'consumer does not reject the entire warning-bearing v5 packet');
assert(packet.limitations.some(s=>s.includes('循环不得当成独立佐证')));

// Local quality relaxation must never weaken overwrite/version protections.
const current=await prepareDocumentArgumentV5(docId),stale:DocumentArgumentV5Commit={...current.current!,previousRevision:null};
await assert.rejects(()=>commitDocumentArgumentV5(stale,{embed}),/图谱版本已变化/);
const wrongSource={...current.current!,previousRevision:current.previousRevision,sourceFingerprint:'wrong'};
await assert.rejects(()=>commitDocumentArgumentV5(wrongSource,{embed}),/资料来源版本/);
assert(await readSavedDocumentArgumentV5(dir,docId,[]));
console.log('Warning-only passed: initial + bridge role/direction/self/cycle/duplicate/dangling issues retained; publication/read/view/RAG work; CAS/source protections remain.');
console.log('Synthetic store only; cloud requests=0; production writes=0.');
