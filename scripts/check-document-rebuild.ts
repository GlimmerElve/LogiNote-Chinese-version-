import assert from 'node:assert/strict';
import {rebuildDocumentAndArguments} from '../src/services/documentRebuildCoordinator';
import type {UploadedDocument} from '../src/types';
import {documentGraphAction,documentGraphStatus,documentProcessingDescription} from '../src/services/documentProcessingActions';
let calls=0,retries=0;
const doc={id:'d',status:'ready',indexable:true} as UploadedDocument;
const deps={guard:async()=>{},retry:async()=>{retries++;},list:async()=>[doc],subscribe:(_fn:()=>void)=>()=>{},process:async()=>{
  calls++;return {done:calls,total:3,requests:1,bridgePending:false,warning:'',fileName:'synthetic'};
}};
assert.deepEqual(await rebuildDocumentAndArguments('d',deps,()=>{}),{batches:3,requests:3});
assert.equal(retries,1);assert.equal(calls,3,'one click processes every new batch');
calls=0;retries=0;
await assert.rejects(()=>rebuildDocumentAndArguments('d',{...deps,process:async()=>{calls++;throw Error('provider failed');}},()=>{}),/provider failed/);
assert.equal(calls,1,'failed provider request is never retried automatically');
await assert.rejects(()=>rebuildDocumentAndArguments('d',{...deps,guard:async()=>{throw Error('mode disabled');}},()=>{}),/mode disabled/);
assert.equal(retries,1,'configuration guard precedes destructive/index work');
const controller=new AbortController();controller.abort();
await assert.rejects(()=>rebuildDocumentAndArguments('d',deps,()=>{},controller.signal),/已停止/);
await assert.rejects(()=>rebuildDocumentAndArguments('d',{...deps,list:async()=>[{...doc,status:'failed',error:'parse failure'}]},()=>{}),/parse failure/);
calls=0;
assert.deepEqual(await rebuildDocumentAndArguments('d',{...deps,process:async()=>{calls++;return {done:3,total:3,requests:2,bridgePending:true,warning:'bridge failed',fileName:'synthetic'};}},()=>{}),{batches:1,requests:2});
assert.equal(calls,1,'bridge failure stops full run rather than retrying');
calls=0;
assert.deepEqual(await rebuildDocumentAndArguments('d',{...deps,process:async()=>{
  calls++;return {done:3,total:3,requests:1,bridgePending:true,bridgeProgress:false,warning:'',fileName:'synthetic'};
}},()=>{}),{batches:1,requests:1});
assert.equal(calls,1,'a no-progress bridge is not automatically requested again');
calls=0;
await rebuildDocumentAndArguments('d',{...deps,process:async()=>{
  calls++;return {done:calls,total:3,requests:1,bridgePending:false,warning:'local role warning',fileName:'synthetic'};
}},()=>{});
assert.equal(calls,3,'quality warnings do not stop later extraction batches');
calls=0;
await rebuildDocumentAndArguments('d',{...deps,process:async()=>{
  calls++;return {done:3,total:3,requests:1,bridgePending:calls===1,bridgeProgress:true,
    bridgeReviewRequired:false,warning:'isolated node warning',fileName:'synthetic'};
}},()=>{});
assert.equal(calls,2,'quality warnings alone do not suppress the next nominated bridge candidate page');
calls=0;retries=0;let resets=0;
const actions={...deps,resetGraph:async()=>{resets++;}};
await rebuildDocumentAndArguments('d',actions,()=>{},undefined,{rebuildBody:false,resetGraph:false});
assert.equal(retries,0,'generate/continue reuses body index');assert.equal(resets,0,'continue keeps existing graph progress');
calls=0;
await rebuildDocumentAndArguments('d',actions,()=>{},undefined,{rebuildBody:false,resetGraph:true});
assert.equal(retries,0,'graph-only regeneration does not reparse source');assert.equal(resets,1);
calls=0;
await rebuildDocumentAndArguments('d',actions,()=>{});
assert.equal(retries,1,'all rebuild reparses source');assert.equal(resets,2);
assert.equal(documentGraphAction(doc).label,'生成论证图');
const graph={version:'v5.0' as const,completedWindows:2,totalWindows:3,nodes:12,entities:0,unresolved:0};
assert.equal(documentGraphAction({...doc,documentGraphProgress:graph}).label,'继续生成论证图');
assert.equal(documentGraphAction({...doc,documentGraphProgress:{...graph,completedWindows:3}}).label,'查看论证图');
assert.equal(documentGraphAction({...doc,documentGraphProgress:{...graph,stale:true}}).action,'regenerate');
assert.equal(documentGraphAction({...doc,documentGraphProgress:{...graph,completedWindows:3,publicationPending:true}}).label,'继续生成论证图');
assert(documentGraphStatus({...doc,documentGraphProgress:{...graph,stale:true}}).includes('待更新'));
assert(documentProcessingDescription('body','allow-cloud').includes('不调用论证抽取模型'));
assert(documentProcessingDescription('regenerate','allow-cloud').includes('复用当前预处理正文'));
console.log('One-click document rebuild: all batches, preflight, parse failure, cancellation and no automatic retries passed.');
