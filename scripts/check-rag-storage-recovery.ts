import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Evaluate production handlers, not a duplicate recovery algorithm. All storage,
// worker and model dependencies are memory stubs; importing main.ts would start
// Electron and touch a real vault, so extract only the relevant AST declarations.
const text=readFileSync('src/electron/main.ts','utf8');
const source=ts.createSourceFile('main.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=['stopBackgroundCompute','notifyRagChanged','processOneVectorization','drainVectorizationQueue','enqueueVectorization','recoverBodyIndexQueue'];
const declarations=names.map(name=>{
  const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert(node,`missing production function ${name}`);return node.getText(source);
});
let handler='';
const visit=(node:ts.Node)=>{
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='ipcMain.handle'
    &&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='storage:set-root')handler=node.arguments[1].getText(source);
  ts.forEachChild(node,visit);
};
visit(source);assert(handler);
const code=ts.transpileModule(`
const vectorizationQueue:string[]=[];let vectorizing=false,activeVectorizationDocument:string|undefined;
let vectorizationDrain:Promise<void>=Promise.resolve(),backgroundGeneration=0;
let referenceEnvironmentSuspended=false,referenceSourceWriteEpoch=0,documentRecoveryWriting=false,learningMigrationPending=false;
const h5pHost=undefined,scenePackHost=undefined,progressiveLearning=undefined,progressiveDerived=undefined,learningPreparation=undefined;
const indexProgress=new Map(),documentCompute=compute,embeddingCompute=compute,mainWindow=null;
${declarations.join('\n')}
module.exports={migrate:${handler},enqueue:enqueueVectorization,stop:stopBackgroundCompute,
  state:()=>({queue:[...vectorizationQueue],vectorizing,activeVectorizationDocument,backgroundGeneration})};
`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(failure:'migration'|'mkdir'|'anchor'|'none'){
  const documents=[{id:'doc-active',fileName:'active.txt',fileType:'txt',indexable:true,status:'pending'},
    {id:'doc-queued',fileName:'queued.txt',fileType:'txt',indexable:true,status:'pending'}];
  const parsed:string[]=[],vectorized:string[]=[],committed:string[]=[],events:string[]=[];
  let first=true,release!:()=>void;
  const stalled=new Promise<void>(resolve=>{release=resolve;});
  const compute={cancelAll:()=>{events.push('cancel');release();}};
  const module={exports:{} as any};
  runInNewContext(code,{module,path,compute,Promise,Map,Set,Error,Date,console:{warn:()=>{}},
    getDataRoot:()=>path.resolve('synthetic-old-root'),getVaultRoot:()=>path.resolve('synthetic-old-root/vault'),getUserStateDir:()=>path.resolve('synthetic-old-root/user-state'),
    referenceEnvironments:{revoke:()=>{}},referenceQuestions:{revoke:()=>{}},revokeReferenceBuilds:()=>{},
    withRagSourceTransaction:async(_roots:unknown,action:()=>Promise<unknown>)=>action(),
    migrateDataTo:async()=>{if(failure==='migration')throw Error('synthetic migration failure');},
    recoverVaultSnapshotInTransaction:async()=>{},copyNoteIndexCleanupForMigration:async()=>{},
    prepareLearningStateMigration:async()=>({}),copyLearningStateMigration:async()=>{},
    fs:{mkdir:async()=>{if(failure==='mkdir')throw Error('synthetic mkdir failure');}},
    saveAnchorConfig:()=>{if(failure==='anchor')throw Error('synthetic anchor failure');},
    readManifest:async()=>structuredClone(documents),documentExists:async(id:string)=>documents.some(d=>d.id===id),
    updateManifest:async(id:string,patch:any)=>{const d=documents.find(d=>d.id===id);if(d)Object.assign(d,patch);},
    deleteChunksFile:async()=>{},deleteStructuredDocumentFile:async()=>{},deleteKnowledgeDocument:async()=>{},
    prepareMaterial:async(_scope:unknown,id:string,options:{assertCurrent():Promise<void>})=>{
      parsed.push(id);if(first){first=false;await stalled;}await options.assertCurrent();return {docId:id,normalizedText:'合成正文。'};
    },
    vectorizeDocument:async(id:string)=>{vectorized.push(id);return [{id:`${id}#one`,docId:id}];},
    loadMaterial:async()=>{},materialVersion:()=>'',
    writeChunksFile:async(id:string,_chunks:unknown,options:{assertCurrent():Promise<void>})=>{await options.assertCurrent();committed.push(id);},
    readKnowledgeSettings:async()=>({enabled:false}),ensureKnowledgeJob:async()=>{throw Error('must not initialize cloud work');},CURRENT_INDEX_SCHEMA_VERSION:4,
  });
  return {...module.exports,documents,parsed,vectorized,committed,events,release};
}
async function begin(f:ReturnType<typeof fixture>){f.enqueue('doc-active');f.enqueue('doc-queued');await tick();assert.deepEqual(f.parsed,['doc-active']);}
async function settle(f:ReturnType<typeof fixture>){for(let i=0;i<30;i++){await tick();if(!f.state().vectorizing&&!f.state().queue.length)return;}throw Error('synthetic queue did not settle');}

for(const failure of ['migration','mkdir','anchor'] as const){
  const f=fixture(failure);await begin(f);
  assert.equal((await f.migrate({},'synthetic-new-root',failure!=='mkdir')).ok,false);
  await settle(f);
  assert(f.documents.every(d=>d.status==='ready'),'failed migration restores both active and queued body jobs without restarting');
  assert.deepEqual(f.parsed,['doc-active','doc-active','doc-queued']);
  assert.deepEqual(f.vectorized,['doc-active','doc-queued']);
  assert.deepEqual(f.committed,['doc-active','doc-queued'],'cancelled old generation cannot publish, recovered jobs publish once');
}
const successful=fixture('none');await begin(successful);
assert.equal((await successful.migrate({},'synthetic-new-root',true)).ok,true);await settle(successful);
assert.deepEqual(successful.parsed,['doc-active'],'successful migration keeps the explicit restart behavior');assert.equal(successful.committed.length,0);
const preflight=fixture('none');await begin(preflight);
assert.equal((await preflight.migrate({},'',true)).ok,false);assert.equal(preflight.events.length,0,'invalid path does not cancel indexing');
preflight.release();await settle(preflight);assert.equal(preflight.committed.length,2);
const reset=fixture('migration');await begin(reset);
await reset.migrate({},'synthetic-new-root',true);reset.stop();reset.documents.splice(0);await settle(reset);
assert.equal(reset.committed.length,0,'a newer stop/reset invalidates the scheduled old-root recovery');
console.log('Storage recovery passed: migration/mkdir/anchor failure resumes local body work once; success, preflight and newer reset remain isolated. No cloud or production IO.');
