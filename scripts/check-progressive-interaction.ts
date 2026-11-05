import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProgressiveLearningStore } from '../src/electron/progressiveLearningStore';
import { progressiveGenerationRequest } from '../src/services/progressiveLearning/generation';
import type { ProgressiveBeginReply, ProgressiveCourse, ProgressiveQuestion } from '../src/services/progressiveLearning/types';
import type { NoteItem } from '../src/types';

globalThis.fetch=async()=>assert.fail('offline synthetic interaction regression');
const root=await fs.mkdtemp(path.resolve('build/progressive-interaction-'));
const at=new Date().toISOString();
const project:NoteItem={id:'interaction-check',title:'合成函数入门',noteType:'project',projectRole:'learning',content:'',tags:[],links:[],backlinks:[],createdAt:at,updatedAt:at,dueDates:[{id:'target',noteId:'interaction-check',noteTitle:'合成函数入门',taskText:'合成函数入门',dueDate:'2026-11-08',estimatedMinutes:80,completed:false,priority:'medium'}]};
const store=new ProgressiveLearningStore(root,{readTarget:async()=>({note:project,root:project,isLeaf:true})});
const command=async(input:any):Promise<any>=>store.command(input,1);
const plan={title:'合成函数入门',objectives:['确认允许输入和唯一对应'],pages:[
  {id:'main-1',title:'解释唯一对应',objectives:['解释同一输入的唯一性']},
  {id:'main-2',title:'应用唯一对应',objectives:['识别一个反例']},
  {id:'main-3',title:'输入限制',objectives:['求分母限制','求根式限制']},
  {id:'main-4',title:'三种独立检验',objectives:['求允许输入','判断输出唯一性','求指定输入的输出值']},
]};
const questions=(count:number):ProgressiveQuestion[]=>Array.from({length:count},(_,index)=>({id:'q'+(index+1),kind:'choice',prompt:'第'+(index+1)+'个独立目标的情境',objective:plan.pages[3].objectives[index],conceptKeys:[],focus:'concept',options:[{id:'A',text:'成立'},{id:'B',text:'不成立'}],correctOptionId:'A',referenceAnswer:'成立',explanation:'按本页边界判断'}));
const body='每个允许的输入必须对应唯一输出。不同输入可以得到同一输出。判断时先确认允许输入的范围，再检查对应关系。分母不能为零，偶次根式的被开方数应非负。先写出各项限制，再取交集；不能因为表达式具有某种形式就忽略其实际条件。';
let reply:ProgressiveBeginReply=await command({op:'begin',projectNoteId:project.id});
let course:ProgressiveCourse=reply.course;
for(const count of [0,1,2,3]){
 const request=progressiveGenerationRequest(reply.course),input=JSON.parse(request.userInput);
 assert.equal(input.interactionDesign.inheritPreviousQuestionCount,false);
 assert.equal(input.interactionDesign.fixedQuestionTypeMix,false);
 if(input.sourcePage){assert.equal('questionCount'in input.sourcePage,false);assert.equal('contentHash'in input.sourcePage,false);}
 assert.ok(request.systemPromptOverride!.includes('先确定本页最需要检验的关键关系'));
 assert.ok(!request.systemPromptOverride!.includes('三题错0–1道'));
 course=await command({op:'publish',lease:reply.lease,teaching:{sequence:course.generation.sequence+1,plan,title:plan.pages[count].title,body,concepts:[],questions:questions(count),hook:{id:'hook-'+count,kind:'reflection',prompt:'用自己的话说明本页关键关系。'}}});
 assert.equal(course.page?.questions?.length||0,count,'publication preserves the selected count instead of padding a three-type template');
 if(count<3)reply=await command({op:'next',projectNoteId:project.id,request:{environmentId:course.environmentId,courseId:course.id,expectedRevision:course.revision,requestId:'next-'+count,intent:'mainline',fromPageId:course.page!.id}});
}
const priorHashes=course.pages!.map(p=>p.contentHash);
reply=await command({op:'next',projectNoteId:project.id,request:{environmentId:course.environmentId,courseId:course.id,expectedRevision:course.revision,requestId:'one-gap',intent:'expansion',fromPageId:'main-4'}});
const expansion=JSON.parse(progressiveGenerationRequest(reply.course).userInput);
assert.ok(expansion.interactionDesign.preference.includes('当前薄弱点'));
assert.equal(expansion.sourcePage.id,'main-4');assert.equal(expansion.sourcePage.questionCount,undefined);
const feedback=structuredClone(reply.course);feedback.generation.adaptation={feedbackKey:'synthetic',fresh:true,restatement:'合成反馈：我混淆了输入范围与输出唯一性。',remainingMainline:0,expansionAvailable:true,answers:questions(3).map(q=>({question:q.prompt,answer:'合成作答',outcome:'incorrect',errorKind:'concept',explanation:'核对本页边界'}))};
const adaptive=JSON.parse(progressiveGenerationRequest(feedback).userInput);
assert.equal(adaptive.adaptation.answers.length,3,'actual feedback remains available even though its count is not a question quota');
assert.equal(adaptive.interactionDesign.inheritPreviousQuestionCount,false);
const reopened=new ProgressiveLearningStore(root,{readTarget:async()=>({note:project,root:project,isLeaf:true})});
for(const [index,count]of [0,1,2,3].entries()){
 const saved=await reopened.command({op:'read-page',projectNoteId:project.id,pageId:'main-'+(index+1)},2) as ProgressiveCourse;
 assert.equal(saved.page?.questions?.length||0,count);assert.equal(saved.pages![index].contentHash,priorHashes[index]);assert.equal(saved.page!.body,body);
}
await fs.writeFile(path.join(root,'result.json'),JSON.stringify({status:'passed',root,counts:[0,1,2,3],network:'blocked',checks:['production requests select minimal sufficient interaction; no inherited count or fixed type mix','actual model feedback retained independently of next-page question quantity','all counts persist exactly without padding, truncating or changing published pages']},null,2));
console.log(JSON.stringify({status:'passed',root,counts:[0,1,2,3],remoteCalls:0}));
