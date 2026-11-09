/** Synthetic durable/runtime regression. No provider, real vault, or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ProgressiveLearningStore,progressivePageHash} from '../src/electron/progressiveLearningStore';
import {progressiveBudgetedPageCount,progressiveAutomaticExpansionAvailable} from '../src/services/progressiveLearning/budget';
import {createProgressiveController,type ProgressiveStorageAdapter} from '../src/services/progressiveLearning/runtime';
import {progressiveGenerationRequest} from '../src/services/progressiveLearning/generation';
import {shareProgressiveTeaching} from '../src/services/progressiveLearning/share';
import {atomicWriteTextFile} from '../src/electron/atomicWrite';
import type {ProgressiveBeginReply,ProgressiveCourse,ProgressiveCommand,ProgressiveMainline,ProgressivePublication} from '../src/services/progressiveLearning/types';
import type {NoteItem} from '../src/types';

const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>assert.fail('Manual supplement regression must not call a model or network');
const root=await fs.mkdtemp(path.resolve('build/progressive-manual-supplements-'));
const checks:string[]=[];
const body='先明确允许的输入，再检查每个输入对应的输出是否唯一。不同输入可以得到相同的输出，但同一个输入不能同时得到两个不同结果。'+ '先看条件与反例，再解释判断依据，不把是否完成作答当作能否继续补充的前提。'.repeat(35);
const hook={id:'hook',kind:'reflection' as const,prompt:'如何说明输入与输出的对应条件？'};
let owner=1;
function harness(name:string,slots:number,mainlineCount:number){
 const at=new Date().toISOString();
 const note:NoteItem={id:name,title:'函数与输入限制',content:'保留人工目标。',noteType:'project',projectRole:'learning',tags:[],links:[],backlinks:[],createdAt:at,updatedAt:at,
  dueDates:[{id:'deadline',noteId:name,noteTitle:'函数与输入限制',taskText:'函数与输入限制',dueDate:'2026-11-09',estimatedMinutes:slots*5,completed:false,priority:'medium'}]};
 const directory=path.join(root,name);let failCommit=false;
 const deps={readTarget:async()=>({note,root:note,isLeaf:true}),write:async(file:string,text:string)=>{if(failCommit&&file.endsWith('course.json')){failCommit=false;throw Error('injected course commit failure');}await atomicWriteTextFile(file,text,{allowCopyFallback:false});}};
 let store=new ProgressiveLearningStore(directory,deps);
 const plan:ProgressiveMainline={title:'合成学习主线',objectives:['说明输入与唯一输出'],pages:Array.from({length:mainlineCount},(_,i)=>({id:`main-${i+1}`,title:`主线${i+1}`,objectives:[`说明条件${i+1}`]}))};
 const cmd=<T>(input:ProgressiveCommand):Promise<T>=>store.command(input,owner) as Promise<T>;
 const load=()=>cmd<ProgressiveCourse>({op:'load',projectNoteId:name});
 const publish=async(reply:ProgressiveBeginReply,extra?:Record<string,unknown>)=>{
  const teaching:ProgressivePublication={sequence:reply.course.generation.sequence+1,plan,title:reply.course.generation.kind==='expansion'?'补充条件':plan.pages[reply.course.generation.mainlineIndex||0].title,body,hook,...extra};
  return {course:await cmd<ProgressiveCourse>({op:'publish',lease:reply.lease!,teaching}),teaching};
 };
 const next=(course:ProgressiveCourse,intent:'mainline'|'expansion'|'auto',requestId:string,scope?:{text:string;pageHash:string;before?:string;after?:string})=>
  cmd<ProgressiveBeginReply>({op:'next',projectNoteId:name,request:{environmentId:course.environmentId,courseId:course.id,expectedRevision:course.revision,requestId,intent,fromPageId:course.page!.id,...(scope?{scope}:{})}});
 const fresh=async(course:ProgressiveCourse,label:string)=>cmd<ProgressiveCourse>({op:'save-progress',projectNoteId:name,progress:{environmentId:course.environmentId,courseId:course.id,expectedProgressVersion:course.progress.version,patch:{restatementDraft:label,restatementSpans:[{pageId:course.page!.id,start:0,end:label.length}]}}});
 return {name,note,directory,plan,cmd,load,publish,next,fresh,begin:()=>cmd<ProgressiveBeginReply>({op:'begin',projectNoteId:name}),
  restart:()=>{store.releaseOwner(owner);owner++;store=new ProgressiveLearningStore(directory,deps);},
  failCommit:()=>{failCommit=true;},get store(){return store;},
  courseFile:path.join(directory,'progressive-learning',`project-${createHash('sha256').update(name).digest('hex')}`,'course.json')};
}

try{
 const tight=harness('full-budget',2,2);
 let state=(await tight.publish(await tight.begin())).course;
 const mainOne=state.pages![0],budget=structuredClone(state.budget),firstBody=state.page!.body;
 assert.equal(state.currentFeedback!.fresh,false);assert.equal(state.currentFeedback!.expansionAvailable,false);
 assert.equal(progressiveAutomaticExpansionAvailable(state),false);
 for(let i=0;i<6;i++){
  const beforeCount=state.pages!.length;
  const selected=body.slice(20,1020),scope={text:selected,pageHash:state.pages!.find(p=>p.id===state.page!.id)!.contentHash,before:'选区前文',after:'选区后文'};
  const requestId=`manual-${i}`,reserved=await tight.next(state,'expansion',requestId,scope);
  assert.equal(reserved.course.generation.manualExpansion,true);assert.equal(reserved.course.generation.routePending,false);
  assert.equal(reserved.course.generation.scope?.text,selected);
  const duplicate=await tight.cmd<ProgressiveBeginReply>({op:'next',projectNoteId:tight.name,request:{environmentId:state.environmentId,courseId:state.id,expectedRevision:state.revision,requestId,intent:'expansion',fromPageId:state.page!.id,scope}});
  assert.equal(duplicate.course.generation.pageId,reserved.course.generation.pageId,'Repeated reservation resumes one page');
  let toPublish=reserved;
  if(i===2){
   await tight.cmd({op:'checkpoint',lease:reserved.lease!,checkpoint:{sequence:1,plan:tight.plan,rawDraft:'@@LESSON\n'+body.slice(0,140),bodyDraft:body.slice(0,140)}});
   await tight.cmd({op:'interrupt',lease:reserved.lease!,error:'synthetic disconnect'});
   tight.restart();toPublish=await tight.begin();
   assert.equal(toPublish.course.generation.pageId,reserved.course.generation.pageId);
   assert.equal(toPublish.course.generation.requestId,requestId);assert.equal(toPublish.course.generation.manualExpansion,true);
   assert.equal(toPublish.course.generation.bodyDraft,body.slice(0,140));
  }
  if(i===3){
   tight.failCommit();await assert.rejects(tight.publish(toPublish),/injected course commit/u);
   assert.equal((await tight.load()).pages!.length,beforeCount,'An orphan manual page is not exposed');
  }
  const publication=await tight.publish(toPublish);state=publication.course;
  assert.equal(state.pages!.length,beforeCount+1);assert.equal(state.page!.manualExpansion,true);
  assert.equal(state.pages!.find(p=>p.id===state.page!.id)!.manualExpansion,true);
  assert.equal(state.page!.parentPageId,'main-1','A manual child of a manual page stays under its root mainline');
  assert.deepEqual(state.budget,budget,'Manual pages do not raise or exhaust automatic budget');
  assert.equal(progressiveBudgetedPageCount(state.pages),1);
  assert.equal(state.currentFeedback!.expansionAvailable,false,'Manual freedom does not grant an automatic slot');
  const repeated=await tight.cmd<ProgressiveCourse>({op:'publish',lease:toPublish.lease!,teaching:publication.teaching});
  assert.equal(repeated.pages!.length,state.pages!.length,'Lost publish reply cannot create a duplicate');
  tight.restart();state=await tight.load();assert.equal(state.page!.manualExpansion,true);
 }
 assert.ok(state.pages!.length>state.budget.totalPageLimit);
 assert.equal(state.pages!.find(p=>p.id==='main-1')!.contentHash,mainOne.contentHash);
 assert.equal((await tight.cmd<ProgressiveCourse>({op:'read-page',projectNoteId:tight.name,pageId:'main-1'})).page!.body,firstBody);
 checks.push('总预算仅2页时，无作答/复述也可连续主动补充6页；超过预算重启可读，原主线及预算不变');
 checks.push('手动补充的重复请求/发布幂等；断流同页续写、保存失败只重试提交，手动标记不丢失');
 const beforeStale=JSON.stringify(state);
 await assert.rejects(tight.next(state,'expansion','bad-selection',{text:'错误版本选区',pageHash:'stale-hash'}),/变化/u);
 assert.equal(JSON.stringify(await tight.load()),beforeStale,'Stale selection leaves course and existing pages unchanged');
 await assert.rejects(tight.next(state,'expansion','oversized-selection',{text:'选'.repeat(50_001),pageHash:state.pages!.find(p=>p.id===state.page!.id)!.contentHash}),/无效|上限/u);
 checks.push('页面版本和选区长度保护保留，错误请求不预留新页、不改变旧正文');
 state=await tight.fresh(state,'这次补充仍有关键条件需要澄清。');
 const automatic=await tight.next(state,'auto','auto-after-manual');
 assert.equal(automatic.course.generation.manualExpansion,undefined,'Automatic reservation must not inherit the current manual source marker');
 await assert.rejects(tight.cmd({op:'route',lease:automatic.lease!,route:{kind:'expansion',reason:'attempt over budget'}}),/预算/u);
 const routed=await tight.cmd<ProgressiveBeginReply>({op:'route',lease:automatic.lease!,route:{kind:'mainline',reason:'继续预留的主线'}});
 state=(await tight.publish(routed,{manualExpansion:true})).course;
 assert.equal(state.page!.id,'main-2');assert.equal(state.page!.manualExpansion,undefined,'A model publication cannot forge manual origin');
 assert.equal(progressiveBudgetedPageCount(state.pages),2);assert.equal(state.currentFeedback!.expansionAvailable,false);
 const stopped=await tight.next(state,'auto','auto-complete');assert.equal(stopped.running,false);assert.equal(stopped.course.pages!.length,state.pages!.length);
 const afterMainline=await tight.next(state,'expansion','manual-after-mainline');state=(await tight.publish(afterMainline)).course;
 assert.equal(state.page!.manualExpansion,true);assert.equal(state.page!.parentPageId,'main-2');
 checks.push('手动补充不挤占剩余主线；自动编排仍拒绝超预算补充，主线完成后用户仍可主动追加');
 const shared=await tight.store.exportTeaching(tight.name);
 assert.equal(shared!.pages.length,state.pages!.length);assert.ok(!JSON.stringify(shared).includes('manualExpansion'));
 checks.push('超过自动预算的全部页面仍可导出；来源标记不进入Markdown分享内容');

 // Unlimited manual pages must not expand every subsequent LLM request without
 // bound. This limits only title context, never the source selection or pages.
 const history=structuredClone(state);
 const mainlineRefs=history.pages!.filter(p=>p.kind==='mainline');
 const manualTemplate=history.pages!.find(p=>p.manualExpansion)!;
 const unmarked={...manualTemplate,id:'extra-old-unmarked',title:'旧未标记补充'};delete unmarked.manualExpansion;
 const manualHistory=Array.from({length:24},(_,i)=>({...manualTemplate,id:`extra-history-${i}`,title:`手动历史${i}`,manualExpansion:true as const}));
 history.pages=[...mainlineRefs,unmarked,...manualHistory];
 const exactScope='这是用户选择的完整内容，不应为了缩减历史标题而截断。'.repeat(650);
 const scope={text:exactScope,before:'选区前文完整保留。',after:'选区后文完整保留。',pageHash:manualTemplate.contentHash};
 history.generation={...history.generation,kind:'expansion',fromPageId:manualHistory[1].id,scope,previousTeaching:{title:'原始衔接讲解',excerpt:'保留当前来源页的具体讲授和上下文，不替换为最近页面。'}};
 const originalHistory=JSON.stringify(history);
 const generatedInput=JSON.parse(progressiveGenerationRequest(history).userInput);
 const manualIds=new Set(manualHistory.map(p=>p.id));
 assert.deepEqual(generatedInput.generatedPages.filter((p:any)=>manualIds.has(p.id)).map((p:any)=>p.id),
  [1,16,17,18,19,20,21,22,23].map(i=>`extra-history-${i}`),'Keep the last8manual titles plus an older current source');
 assert.equal(generatedInput.generatedPages.filter((p:any)=>manualIds.has(p.id)).length,9);
 for(const required of [...mainlineRefs,unmarked])assert.ok(generatedInput.generatedPages.some((p:any)=>p.id===required.id&&p.title===required.title));
 assert.ok(generatedInput.generatedPages.every((p:any)=>JSON.stringify(Object.keys(p).sort())===JSON.stringify(['id','title'])));
 assert.equal(generatedInput.sourcePage.id,manualHistory[1].id);
 assert.deepEqual(generatedInput.supplementScope,scope);assert.equal(generatedInput.supplementScope.text.length,exactScope.length);
 assert.deepEqual(generatedInput.previousTeaching,history.generation.previousTeaching);
 assert.equal(JSON.stringify(history),originalHistory,'Preparing title context never mutates existing course pages or selected text');
 const legacyHistory=structuredClone(history);for(const page of legacyHistory.pages!)delete page.manualExpansion;
 const legacyInput=JSON.parse(progressiveGenerationRequest(legacyHistory).userInput);
 assert.deepEqual(legacyInput.generatedPages,legacyHistory.pages!.map(({id,title})=>({id,title})),
  'Unmarked historical courses retain the original full title projection');
 assert.deepEqual(legacyInput.supplementScope,scope);
 checks.push('手动补充历史只传最近8页及当前旧来源页标题，主线与未标记旧页全保留；精确选区、原页衔接和存储页面不截断');

 const spare=harness('spare-automatic-slot',3,2);
 let spareState=(await spare.publish(await spare.begin())).course;
 for(let i=0;i<5;i++)spareState=(await spare.publish(await spare.next(spareState,'expansion',`manual-spare-${i}`))).course;
 assert.equal(progressiveBudgetedPageCount(spareState.pages),1);assert.equal(progressiveAutomaticExpansionAvailable(spareState),true);
 spareState=await spare.fresh(spareState,'这里的对应规则仍需补充。');
 const pendingAuto=await spare.next(spareState,'auto','automatic-extra');
 const routedAuto=await spare.cmd<ProgressiveBeginReply>({op:'route',lease:pendingAuto.lease!,route:{kind:'expansion',reason:'使用真正剩余的自动预算'}});
 spareState=(await spare.publish(routedAuto,{manualExpansion:true})).course;
 assert.equal(spareState.page!.kind,'expansion');assert.equal(spareState.page!.manualExpansion,undefined);
 assert.equal(progressiveBudgetedPageCount(spareState.pages),2);assert.equal(spareState.currentFeedback!.expansionAvailable,false);
 spare.restart();spareState=await spare.load();assert.equal(progressiveBudgetedPageCount(spareState.pages),2);
 spareState=await spare.fresh(spareState,'本自动补充还有另一条新疑问。');
 const noMoreAuto=await spare.next(spareState,'auto','no-second-auto-extra');
 await assert.rejects(spare.cmd({op:'route',lease:noMoreAuto.lease!,route:{kind:'expansion',reason:'不能无限自动补充'}}),/预算/u);
 const lastMain=await spare.cmd<ProgressiveBeginReply>({op:'route',lease:noMoreAuto.lease!,route:{kind:'mainline',reason:'保留最后的主线'}});
 spareState=(await spare.publish(lastMain)).course;assert.equal(progressiveBudgetedPageCount(spareState.pages),3);
 checks.push('大量手动补充不消耗原有自动补充余额；自动页与旧未标记页仍计入预算，自动不能继承手动豁免');

 // Old courses have no manualExpansion marker. Simulate that metadata shape
 // using an existing saved manual page while retaining its exact teaching hash.
 const legacy=harness('legacy-unmarked',1,1);
 let legacyState=(await legacy.publish(await legacy.begin())).course;
 legacyState=(await legacy.publish(await legacy.next(legacyState,'expansion','legacy-page'))).course;
 const rawCourse=JSON.parse(await fs.readFile(legacy.courseFile,'utf8'));
 const manualRef=rawCourse.pages.find((p:any)=>p.kind==='expansion');
 delete manualRef.manualExpansion;delete rawCourse.generation.manualExpansion;delete rawCourse.generation.supplementDesign;
 const pageFile=path.join(path.dirname(legacy.courseFile),'pages',`${manualRef.id}.${manualRef.contentHash}.json`);
 const rawPage=JSON.parse(await fs.readFile(pageFile,'utf8'));delete rawPage.manualExpansion;
 assert.equal(progressivePageHash(rawPage),manualRef.contentHash,'Origin metadata does not rewrite teaching hashes');
 await fs.writeFile(pageFile,JSON.stringify(rawPage));
 // A real old unmarked page was originally valid only within its budget.
 rawCourse.budget.totalPageLimit=2;await fs.writeFile(legacy.courseFile,JSON.stringify(rawCourse));
 legacy.restart();legacyState=await legacy.load();assert.equal(progressiveBudgetedPageCount(legacyState.pages),2);
 assert.equal(progressiveAutomaticExpansionAvailable(legacyState),false);assert.equal(legacyState.page!.manualExpansion,undefined);
 for(const marker of [true,false,'manual']){
  const corrupt=structuredClone(rawCourse);corrupt.pages.find((p:any)=>p.kind==='mainline').manualExpansion=marker;
  await fs.writeFile(legacy.courseFile,JSON.stringify(corrupt));
  await assert.rejects(legacy.load(),/无效|格式|预算/u,'A mainline/malformed marker cannot bypass stored-budget validation');
 }
  for(const marker of [false,'manual']){
   for(const location of ['summary','generation']){
    const corrupt=structuredClone(rawCourse);
    if(location==='summary')corrupt.pages.find((p:any)=>p.kind==='expansion').manualExpansion=marker;
    else corrupt.generation.manualExpansion=marker;
    await fs.writeFile(legacy.courseFile,JSON.stringify(corrupt));
    await assert.rejects(legacy.load(),/无效|格式|预算/u,'Only true or absent manual metadata is valid on an expansion');
   }
  }
 await fs.writeFile(legacy.courseFile,JSON.stringify(rawCourse));
 checks.push('旧无标记课程无需迁移且保持原预算计数；主线与畸形手动标记不能伪造豁免');

 const rt=harness('runtime-right-click',1,1);let calls=0;
 const storage:ProgressiveStorageAdapter={
  load:async()=>rt.load(),begin:async()=>rt.begin(),next:async(_id,req)=>rt.cmd({op:'next',projectNoteId:rt.name,request:req}),
  checkpoint:async(lease,checkpoint)=>rt.cmd({op:'checkpoint',lease,checkpoint}),publish:async(lease,teaching)=>rt.cmd({op:'publish',lease,teaching}),
  saveProgress:async(_id,progress)=>rt.cmd({op:'save-progress',projectNoteId:rt.name,progress}),interrupt:async(lease,error)=>rt.cmd({op:'interrupt',lease,error}),
 };
 const controller=createProgressiveController({note:rt.note,allNotes:[rt.note]},{storage,loadMaterials:async()=>[],registerFlush:()=>()=>{},stream:async course=>{
  calls++;const text=`${course.plan?'':'@@PLAN\n'+JSON.stringify(rt.plan)+'\n'}@@LESSON\n${body}\n@@CONCEPTS\n[]\n@@QUESTIONS\n[]\n@@HOOK\n${JSON.stringify(hook)}\n@@END\n`;
  return new ReadableStream({start(stream){stream.enqueue({type:'content',text});stream.close();}});
 }});
 await controller.start();assert.equal(controller.getSnapshot().phase,'ready');
 await controller.next('expansion');await controller.next('expansion');
 const beforeDouble=calls;await Promise.all([controller.next('expansion'),controller.next('expansion')]);
 assert.equal(calls,beforeDouble+1);assert.equal(controller.getSnapshot().phase,'ready');
 assert.equal(controller.getSnapshot().course!.pages!.length,4);assert.equal(progressiveBudgetedPageCount(controller.getSnapshot().course!.pages),1);
 await controller.stop();controller.dispose();
 checks.push('真实controller右键同等入口在预算用完后连续补充成功；重复点击只触发一次模拟生成，读写与保存不受影响');

 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({status:'passed',root,remoteCalls:0,checks},null,2));
 console.log(JSON.stringify({status:'passed',root,remoteCalls:0,checks:checks.length}));
}finally{globalThis.fetch=originalFetch;}
