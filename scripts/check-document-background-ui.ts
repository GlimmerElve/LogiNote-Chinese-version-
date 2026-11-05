import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import React from 'react';
import ts from 'typescript';
import {createDocumentBackgroundQueue,documentJobActive} from '../src/services/documentBackgroundQueue';
import * as actions from '../src/services/documentProcessingActions';
import type {UploadedDocument} from '../src/types';

// Exercise real DocumentsView handlers and effect cleanup, with an app-owned
// in-memory job queue. No native APIs, real documents or model calls reachable.
const file=resolve('src/components/DocumentsView.tsx'),requireModule=createRequire(file);
const source=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const queue=createDocumentBackgroundQueue();
const docs=['doc-one','doc-two'].map(id=>({id,fileName:`${id}.pdf`,fileType:'pdf',extension:'.pdf',indexable:true,size:123,status:'ready',parseStatus:'ready',chunkCount:2,totalChars:42,uploadAt:'2026-10-14'} as UploadedDocument));
const settings={enabled:true,processingMode:'allow-cloud' as const};
let calls=0,cancelled=false,finish!:()=>void,notifyProgress!:(text:string)=>void;
const jobDone=new Promise<void>(resolve=>{finish=resolve;});
const tick=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
const text=(node:any):string=>Array.isArray(node)?node.map(text).join(''):node?.props?text(node.props.children):typeof node==='string'||typeof node==='number'?String(node):'';
const all=(node:any):any[]=>Array.isArray(node)?node.flatMap(all):node?.props?[node,...all(node.props.children)]:[];
const find=(tree:any,predicate:(node:any)=>boolean)=>{const found=all(tree).find(predicate);assert(found,'expected UI control');return found;};
const label=(tree:any,value:string)=>find(tree,node=>node.props['aria-label']===value);
const component=(tree:any,name:string)=>all(tree).find(node=>typeof node.type==='function'&&node.type.name===name);
function mount(){
  const slots:any[]=[],cleanup=new Map<number,()=>void>();let cursor=0,dirty=false,tree:any,unmounted=false,lateUpdates=0;
  let pending:{index:number;effect:()=>void|(()=>void)}[]=[];
  const same=(a?:unknown[],b?:unknown[])=>!!a&&!!b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const hooks={...React,
    useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],(value:any)=>{if(unmounted)lateUpdates++;const next=typeof value==='function'?value(slots[index]):value;if(!Object.is(next,slots[index])){slots[index]=next;dirty=true;}}];},
    useRef(initial:any){const index=cursor++;return slots[index]||=( {current:initial});},
    useId(){return `background-ui-${cursor++}`;},
    useCallback(value:any,deps?:unknown[]){const index=cursor++;if(!same(slots[index]?.deps,deps))slots[index]={deps,value};return slots[index].value;},
    useEffect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++;if(!same(slots[index]?.deps,deps)){slots[index]={deps};pending.push({index,effect});}},
  };
  const module={exports:{} as any};
  runInNewContext(source,{module,exports:module.exports,require(id:string){
    if(id==='react')return hooks;
    if(id==='react/jsx-runtime'||id==='lucide-react')return requireModule(id);
    if(id==='../services/documentRagClient')return {
      isDocumentRagAvailable:()=>true,listDocuments:async()=>docs,subscribeDocumentChanges:()=>()=>{},
      chooseDocumentFiles:async()=>[],previewDocument:async(id:string)=>({document:docs.find(doc=>doc.id===id),chunks:[],totalChunkCount:0,truncated:false}),
    };
    if(id==='../services/knowledgeRagClient')return {isKnowledgeRagAvailable:()=>true,getKnowledgeSettings:async()=>settings,setKnowledgeSettings:async()=>settings};
    if(id==='../services/documentBackgroundJobs')return {documentBackgroundJobs:queue,startDocumentGraphBackgroundJob:async(doc:UploadedDocument,action:any)=>queue.enqueue({docId:doc.id,fileName:doc.fileName,action},async(progress,signal)=>{
      calls++;notifyProgress=progress;signal.addEventListener('abort',()=>{cancelled=true;finish();},{once:true});await jobDone;
    })};
    if(id==='../services/documentBackgroundQueue')return {documentJobActive};
    if(id==='../services/documentProcessingActions')return actions;
    if(id==='../services/llmStorage')return {ensureLlmSettingsLoaded:async()=>{}};
    if(id==='../services/llmService')return {resolveProvider:()=>({selectedModel:'fixture'})};
    if(id==='./DocumentArgumentGraphDialog')return {DocumentArgumentGraphDialog:()=>null};
    if(id==='./DocumentProjectBindingSection')return {DocumentProjectBindingSection:()=>null};
    if(id==='./useDialog')return {useDialog:()=>{}};
    throw Error(`Unexpected UI dependency ${id}`);
  },Date,Error,Set,Map,Math,Number,String,Boolean,Promise,URL,AbortController,setInterval:()=>1,clearInterval:()=>{}});
  const render=()=>{let passes=0;do{dirty=false;cursor=0;pending=[];tree=module.exports.DocumentsView({});for(const {index,effect} of pending){cleanup.get(index)?.();const next=effect();if(next)cleanup.set(index,next);}assert(++passes<15);}while(dirty);return tree;};
  render();return {render,get tree(){return tree;},get lateUpdates(){return lateUpdates;},unmount(){unmounted=true;cleanup.forEach(fn=>fn());}};
}
const page=mount();await tick();page.render();
assert.equal(calls,0,'viewing documents does not send requests');
label(page.tree,'生成论证图：doc-one.pdf').props.onClick();page.render();
const dialog=component(page.tree,'DocumentConfirmationDialog');assert(dialog);
await dialog.props.onConfirm();await tick();page.render();
assert.equal(calls,1);assert(!component(page.tree,'DocumentConfirmationDialog'),'confirmation closes before processing completes');
assert.equal(label(page.tree,'生成论证图：doc-two.pdf').props.disabled,false,'other documents remain operable');
assert(text(page.tree).includes('停止该论证任务'));
page.unmount();notifyProgress('第2批处理中');await tick();assert(!cancelled,'navigation never aborts the graph request');
assert.equal(page.lateUpdates,0,'closed view has no progress state writes');
const returned=mount();await tick();returned.render();
assert(text(returned.tree).includes('第2批处理中'),'remount restores live job progress');
await label(returned.tree,'查看 doc-one.pdf 的资料详情与索引内容').props.onClick();returned.render();
assert.equal(component(returned.tree,'DocumentPreviewDialog').props.busy,false,'background job does not lock detail dialog');
component(returned.tree,'DocumentPreviewDialog').props.onClose();returned.render();
find(returned.tree,node=>node.type==='button'&&text(node)==='停止该论证任务').props.onClick();
await tick();returned.render();assert(cancelled,'explicit stop aborts the running request');
assert(!queue.getSnapshot().some(documentJobActive));returned.unmount();
console.log('Documents UI: immediate dialog close, usable other rows, unmount continues, remount progress and explicit Stop passed.');
