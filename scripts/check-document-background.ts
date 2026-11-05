import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fork,type Serializable} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDocumentBackgroundQueue,documentJobActive} from '../src/services/documentBackgroundQueue';
import {RagComputeClient,type ComputeTransport} from '../src/electron/ragComputeClient';
import {extractStructuredDocument} from '../src/electron/documentParsers';
import {setModelsDir} from '../src/electron/rag/embedding';
import {setDataRoot,vectorizeDocument,writeChunksFile,readChunksFile,writeStructuredDocumentFile,readStructuredDocumentFile} from '../src/electron/ragIndex';
import type {DocumentChunk,StructuredDocument} from '../src/types';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

let saved:unknown=[];
const jobs=createDocumentBackgroundQueue({read:()=>saved,write:value=>{saved=value;}});
const first=deferred(),second=deferred();let calls=0,updates=0;
const unsubscribe=jobs.subscribe(()=>{updates++;});
const one=jobs.enqueue({docId:'doc-one',fileName:'合成1.txt',action:'all'},async progress=>{calls++;progress('处理中');await first.promise;});
jobs.enqueue({docId:'doc-two',fileName:'合成2.txt',action:'continue'},async()=>{calls++;await second.promise;});
await tick();assert.equal(calls,1,'graph jobs run serially');
assert.throws(()=>jobs.enqueue({docId:'doc-one',fileName:'duplicate',action:'next'},async()=>{}),/重复/);
unsubscribe();const notifications=updates;
first.resolve();await tick();assert.equal(calls,2,'page unmount does not stop the next approved job');
assert.equal(updates,notifications,'unmounted page receives no state updates');
assert.equal(jobs.getSnapshot().find(job=>job.id===one.id)?.status,'completed');
second.resolve();await tick();
let aborted=false;
const stop=jobs.enqueue({docId:'doc-stop',fileName:'stop.txt',action:'next'},async(_progress,signal)=>{
  await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
});
let queuedCalls=0;
const queued=jobs.enqueue({docId:'doc-queued',fileName:'queued.txt',action:'next'},async()=>{queuedCalls++;});
await tick();jobs.cancel(queued.id);jobs.cancel(stop.id);await tick();
assert(aborted);assert.equal(queuedCalls,0);assert.equal(jobs.getSnapshot().find(job=>job.id===stop.id)?.status,'cancelled');
let failures=0;
jobs.enqueue({docId:'doc-failure',fileName:'failure.txt',action:'next'},async()=>{failures++;throw Error('fixture failure');});
await tick();await tick();assert.equal(failures,1,'failure never resends a model request');
assert.equal(jobs.getSnapshot().at(-1)?.status,'failed');
const live=deferred();
jobs.enqueue({docId:'doc-reload',fileName:'reload.txt',action:'all'},async()=>live.promise);
await tick();const restored=createDocumentBackgroundQueue({read:()=>saved,write:()=>{}});
assert.equal(restored.getSnapshot().at(-1)?.status,'interrupted');
assert(!restored.getSnapshot().some(documentJobActive),'reload does not replay paid work');
assert(!JSON.stringify(saved).includes('apiKey'),'progress cache has metadata only');
live.resolve();await tick();

// History retention cannot discard a still-running job or its runner.
const retention=createDocumentBackgroundQueue(),hold=deferred();
const retained=retention.enqueue({docId:'doc-held',fileName:'held',action:'all'},async()=>hold.promise);
await tick();
for(let i=0;i<60;i++){
  const job=retention.enqueue({docId:`doc-history-${i}`,fileName:'history',action:'next'},async()=>{});
  retention.cancel(job.id);
}
assert(retention.getSnapshot().some(job=>job.id===retained.id&&job.status==='running'));
assert(retention.getSnapshot().length<=40);hold.resolve();await tick();
if(process.argv.includes('--queue-only')){
  console.log('Background queue-only checks passed (synthetic runners; no model or worker).');
  process.exit(0);
}

class FakeChild extends EventEmitter implements ComputeTransport {
  sent:any[]=[];killed=false;throwOnSend=false;
  postMessage(value:unknown){if(this.throwOnSend)throw Error('pipe closed');this.sent.push(value);}
  kill(){this.killed=true;}
}
const config={modelsDir:path.resolve('models'),pdfExtractScript:path.resolve('python/pdf_extract.py')};
const children:FakeChild[]=[];
const client=new RagComputeClient(()=>{const child=new FakeChild();children.push(child);return child;},()=>config);
let progress=0;
const a=client.run('parse',{},()=>{progress++;}),b=client.run('embed',{});
assert.equal(children[0].sent.length,1);
children[0].emit('message',{id:99,ok:true,value:'stale'});
children[0].emit('message',{id:1,type:'progress',value:{completed:1,total:1}});assert.equal(progress,1);
children[0].emit('message',{id:1,ok:true,value:'parsed'});assert.equal(await a,'parsed');await tick();
const bRejected=assert.rejects(b,/进程退出/);children[0].emit('exit',1);await bRejected;
const c=client.run('parse',{});assert.equal(children.length,2);
children[0].emit('message',{id:3,ok:true,value:'stale'});
children[1].emit('message',{id:3,ok:true,value:'current'});assert.equal(await c,'current');
const d=client.run('parse',{}),e=client.run('parse',{});
const dRejected=assert.rejects(d,/fixture stop/),eRejected=assert.rejects(e,/fixture stop/);
client.cancelAll('fixture stop');await Promise.all([dRejected,eRejected]);assert(children[1].killed);
const bad=new FakeChild();bad.throwOnSend=true;
const broken=new RagComputeClient(()=>bad,()=>config);
await assert.rejects(broken.run('parse',{}),/pipe closed/);assert(bad.killed);
console.log('Background queue: leave/remount, serial execution, stop, dedup, reload and crash handling passed.');

// Real bundled worker, real offline embeddings; no Electron UI, cloud or vault.
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'loginote-background-check-'));
const transports:ReturnType<typeof fork>[]=[];
const worker=new RagComputeClient(()=>{
  const child=fork(path.resolve('dist-electron/rag-compute.cjs'),[],{stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced'});
  transports.push(child);let errors='';child.stderr?.on('data',value=>{errors=String(value).slice(-2000);});
  child.on('exit',code=>{if(code&&errors)console.error(errors);});
  return {postMessage:value=>{child.send(value as Serializable);},on:(event,listener)=>child.on(event,listener),kill:()=>child.kill()};
},()=>config);
try {
  const text='# 合成资料\n\n实验采用两种条件，每组回答相同问题。\n\n结果显示，两组的选择比例不同。\n\n因此作者认为条件影响了决策。';
  const file=path.join(temporary,'fixture.md');await fs.writeFile(file,text);
  const direct=await extractStructuredDocument(file,'md','doc-fixture');
  const parsed=await worker.run<StructuredDocument>('parse',{filePath:file,fileType:'md',docId:'doc-fixture'});
  assert.deepEqual(parsed,direct,'background parsing preserves preprocessing and source positions');
  let beats=0;const timer=setInterval(()=>{beats++;},10);
  let lastProgress={completed:0,total:0};
  const chunks=await worker.run<DocumentChunk[]>('vectorize',{docId:'doc-fixture',fileName:'fixture.md',text:parsed.normalizedText,structured:parsed},value=>{lastProgress=value;});
  clearInterval(timer);assert(beats>1,'parent remains responsive during native embedding work');
  assert.equal(lastProgress.completed,chunks.length);assert.equal(lastProgress.total,chunks.length);
  setModelsDir(config.modelsDir);
  const reference=await vectorizeDocument('doc-fixture','fixture.md',direct.normalizedText,direct);
  assert.deepEqual(chunks.map(({embedding,...chunk})=>chunk),reference.map(({embedding,...chunk})=>chunk),'same semantic chunks, IDs and locators');
  chunks.forEach((chunk,i)=>{
    assert.equal(chunk.embedding.length,384);
    assert(chunk.embedding.every((value,j)=>Math.abs(value-reference[i].embedding[j])<1e-6),'same local model vectors');
  });
  setDataRoot(temporary);await writeChunksFile('doc-fixture',chunks);
  await assert.rejects(writeChunksFile('doc-fixture',[],{assertCurrent:()=>{throw Error('environment changed');}}),/environment changed/);
  assert.deepEqual(await readChunksFile('doc-fixture'),JSON.parse(JSON.stringify(chunks)),'stale job cannot overwrite the accepted index');
  await writeChunksFile('doc-fixture',chunks);
  assert.equal((await fs.readdir(path.join(temporary,'rag-index'))).filter(name=>name.startsWith('chunks-')).length,1,'rebuild still replaces one index');
  await writeStructuredDocumentFile(parsed);
  await assert.rejects(writeStructuredDocumentFile({...parsed,normalizedText:'stale'},{assertCurrent:()=>{throw Error('environment changed');}}),/environment changed/);
  assert.equal((await readStructuredDocumentFile('doc-fixture'))?.normalizedText,parsed.normalizedText);
  const largeText=Array.from({length:8000},(_,index)=>`第${index+1}段：这是本地合成的长资料。这里保留完整语义段落，观察两个实验条件下的选择差异，但不包含真实用户资料。`).join('\n\n');
  const largeFile=path.join(temporary,'large.txt');await fs.writeFile(largeFile,largeText);
  const large=await worker.run<StructuredDocument>('parse',{filePath:largeFile,fileType:'txt',docId:'doc-large'});
  assert(large.normalizedText.length>400000);assert.equal(large.blocks.length,8000);
  console.log(`Real worker: parser/vector parity, ${beats} parent heartbeat ticks, progress and guarded single-index replacement passed.`);
} finally {
  worker.cancelAll();transports.forEach(child=>{if(!child.killed)child.kill();});
  assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep));
  await fs.rm(temporary,{recursive:true,force:true});
}
