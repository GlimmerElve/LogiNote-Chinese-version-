import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as contracts from '../src/services/scene/sceneRuntimeContract';
import * as pending from '../src/services/scene/scenePendingTask';
import * as forms from '../src/services/scene/sceneInputForm';
import * as capabilities from '../src/services/scene/sceneCapabilityRegistry';
import * as availability from '../src/services/scene/sceneInputAvailability';
import { isSupportedStructuredInteraction } from '../src/components/scene/SceneInteractionInput';
const path = 'src/components/scene/SceneChatView.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n)).map(n => n.getText(source)).join('\n').replace(/^export\s+/gm, '');
const compiled = ts.transpileModule(body + '\nreturn SceneChatView;', { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None } }).outputText;
const React = { Fragment: 'fragment', createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) };
const flatten = (v: any): any[] => !v || typeof v !== 'object' ? [] : Array.isArray(v) ? v.flatMap(flatten)
 : v.props?.hidden ? [] : v.type === 'deferred-content' ? flatten(v.props.children[0]()) : [v, ...flatten(v.props?.children)];
const slots: any[] = [], effects: any[] = []; let cursor = 0;
const hooks = {
  useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (v: any) => { slots[i].value = typeof v === 'function' ? v(slots[i].value) : v; }]; },
  useRef(initial: any) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useEffect(effect: any, deps: any[]) { const i = cursor++; if (!slots[i] || deps.some((v,j) => v !== slots[i].deps[j])) { slots[i] = { deps }; effects.push(effect); } },
};
const icons = Object.fromEntries(['Send','Loader2','Zap','Square','RotateCcw','Trophy','XCircle','PanelLeftClose','PanelLeftOpen','Target','Clock3','UserRound','Bot','BookOpen','CircleHelp','Flag'].map(n => [n,n]));
const env = { React, ...hooks, ...icons, ...contracts, ...pending, ...forms, ...capabilities, ...availability, isSupportedStructuredInteraction, SceneInteractionInput: 'task-input',
  SceneWidgetErrorBoundary: 'widget-boundary', SceneWidgetContent: 'deferred-content',
  SceneDynamicForm: 'form', SceneRichMessage: 'message', SceneMetricPanel: 'metrics', SceneExperimentLedger: 'experiments', useDialog() {},
  window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) } };
const Component = new Function(...Object.keys(env), compiled)(...Object.values(env));
const question = { id: 'q1', type: 'single-choice', required: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
let spec: any = { sceneId:'s', capabilityRecipeId:'guided-practice', promptModuleIds:['structured-interaction','turn-agent-planning'],
 meta:{name:'Practice',goal:'Practice',sceneSkill:'S1',knowledgePoints:[]},role:{name:'Tutor',attributes:[]},situation:'',task:'One question',resources:[],rules:[],metrics:[],events:[],completion:{mode:'signal',maxTurns:8},
 behavior:{recipeId:'guided-practice',kind:'Practice',aiBehavior:'Ask',userAction:'Choose',evaluationRule:'Check',progressionRule:'Next',
 interaction:{version:'1.0',allowedTypes:['single-choice'],defaultType:'single-choice',allowTextFallback:false}}};
let run: any = { runId:'r',sceneId:'s',turnCount:0,status:'running',metrics:[],events:[],messages:[{id:'task-message',speakerType:'role',speakerName:'Tutor',content:'Question',timestamp:'',interaction:question}] };
let sending=false,turnError='',nodes:any[]=[];const sends:any[][]=[];
const render=()=>{cursor=0;nodes=flatten(Component({spec,run,sending,turnError,hasPrevRun:false,onSend:(...a:any[])=>sends.push(a),onInjectEvent(){},onEnd(){},onRerun(){}}));effects.splice(0).forEach(f=>f());};
const find=(type:string,label?:string)=>nodes.find(n=>n.type===type&&(label===undefined||n.props['aria-label']===label));
const control=(type:string,label?:string)=>{const n=find(type,label);assert.ok(n,type+' '+label);return n.props;};
const edit=(v:string)=>{control('textarea','场景交流').onChange({target:{value:v}});render();};
render();assert.equal(control('task-input').directive.id,'q1');assert.equal(find('textarea','本轮回答'),undefined);
edit('  下一题更复杂  ');control('button','发送交流').onClick();render();
assert.deepEqual(sends[0],['下一题更复杂',undefined,undefined,'conversation']);assert.equal(control('textarea','场景交流').value,'');
run={...run,messages:[...run.messages,{id:'hint',speakerType:'role',speakerName:'Tutor',content:'A hint',timestamp:''}]};render();assert.equal(control('task-input').directive.id,'q1');
run={...run,messages:[...run.messages,{id:'text',speakerType:'role',speakerName:'Tutor',content:'Discuss',timestamp:'',interaction:{id:'text',type:'text'}}]};render();assert.equal(control('task-input').directive.id,'q1');
const answer={interactionId:'q1',type:'single-choice',selectedId:'a',submittedAt:''};control('task-input').onSubmit(answer);assert.equal(sends.at(-1)?.[1],answer);assert.notEqual(sends.at(-1)?.[3],'conversation');
edit('hint');const count=sends.length;
for(const event of [{shiftKey:true,nativeEvent:{}},{shiftKey:false,nativeEvent:{isComposing:true,keyCode:229}}])control('textarea','场景交流').onKeyDown({key:'Enter',...event,preventDefault(){}});
assert.equal(sends.length,count);control('textarea','场景交流').onKeyDown({key:'Enter',shiftKey:false,nativeEvent:{},preventDefault(){}});
assert.equal(sends.length,count+1);render();
edit('retain draft');sending=true;render();assert.equal(control('task-input').disabled,true);assert.equal(control('textarea','场景交流').disabled,true);
const before=sends.length;control('button','发送交流').onClick();assert.equal(sends.length,before);sending=false;render();assert.equal(control('textarea','场景交流').value,'retain draft');
spec={...spec,runtimeContract:{allowConversation:false}};render();assert.equal(find('textarea','场景交流'),undefined);assert.equal(control('task-input').directive.id,'q1');
spec={...spec,runtimeContract:{allowConversation:true}};turnError='Failure';render();assert.ok(!find('button','发送交流')||find('button','发送交流').props.disabled);
turnError='';run={...run,status:'success'};render();assert.ok(!find('button','发送交流')||find('button','发送交流').props.disabled);

// A text task has two distinct channels: its answer draft is not the place to
// submit a new teaching instruction. Clearing a sent discussion cannot clear it.
slots.splice(0); effects.splice(0); sending=false; turnError='';
spec={...spec,capabilityRecipeId:'agent-designed',capabilityIds:['text'],runtimeContract:{allowConversation:true,allowTextFallback:true,allowedInteractionTypes:['text']},
 behavior:{...spec.behavior,recipeId:'agent-designed',interaction:{version:'1.0',allowedTypes:['text'],defaultType:'text',allowTextFallback:true}}};
run={...run,status:'running',turnCount:0,messages:[{id:'text-task-message',speakerType:'role',speakerName:'Tutor',content:'请用自己的话解释比例。',timestamp:'',
 interaction:{id:'text-answer-task',type:'text',required:true,placeholder:'写下你的解释'}}]};
render();assert.ok(find('textarea','本轮回答'));assert.ok(find('textarea','场景交流'));
const discussionControl=control('textarea','场景交流');
assert.ok(nodes.some(node=>node.type==='label'&&node.props.htmlFor===discussionControl.id),'discussion has a visible associated label');
assert.ok(nodes.some(node=>node.props?.id===discussionControl['aria-describedby']),'discussion has an associated no-answer/no-round hint');
const textStart=sends.length,answerDraft='我的答案草稿：百分比表示每一百份中的份数。';
control('textarea','本轮回答').onChange({target:{value:answerDraft}});render();
edit('  以后解释请多用生活类比和形象例子，但保留这道原题。  ');
control('button','发送交流').onClick();render();
assert.deepEqual(sends.at(-1),['以后解释请多用生活类比和形象例子，但保留这道原题。',undefined,undefined,'conversation']);
assert.equal(control('textarea','本轮回答').value,answerDraft,'discussion send retains the answer draft');
assert.equal(control('textarea','场景交流').value,'');assert.equal(run.turnCount,0);
assert.equal(pending.getPendingSceneInteraction(run)?.interaction?.id,'text-answer-task');
run={...run,messages:[...run.messages,{id:'text-style-confirmation',speakerType:'role',speakerName:'Tutor',content:'已记录，之后用生活例子说明；原题保留。',timestamp:''}]};
render();assert.equal(control('textarea','本轮回答').value,answerDraft);
assert.equal(pending.getPendingSceneInteraction(run)?.interaction?.id,'text-answer-task');
control('button','提交回答').onClick();render();
const textAnswer=sends.at(-1)!;
assert.equal(textAnswer[0],answerDraft);assert.equal(textAnswer[1].type,'text');
assert.equal(textAnswer[1].interactionId,'text-answer-task');assert.equal(textAnswer[1].value,answerDraft);
assert.notEqual(textAnswer[3],'conversation');
assert.equal(sends.slice(textStart).filter(args=>args[1]?.type==='text').length,1);
assert.equal(control('textarea','本轮回答').value,'');

// IME, shift-enter, waiting and error/terminal/permission locks cover the new
// text-task channel as well as the existing choice-task channel.
control('textarea','本轮回答').onChange({target:{value:'保留中的新答案草稿'}});render();edit('保留中的交流草稿');
const textImeCount=sends.length;
for(const event of [{shiftKey:true,nativeEvent:{}},{shiftKey:false,nativeEvent:{isComposing:true}},{shiftKey:false,nativeEvent:{keyCode:229}}]) {
 control('textarea','场景交流').onKeyDown({key:'Enter',...event,preventDefault(){}});
}
assert.equal(sends.length,textImeCount);assert.equal(control('textarea','场景交流').value,'保留中的交流草稿');
sending=true;render();assert.equal(control('textarea','场景交流').disabled,true);assert.equal(control('textarea','本轮回答').disabled,true);
control('button','发送交流').onClick();control('button','正在等待回应').onClick();assert.equal(sends.length,textImeCount);
sending=false;render();assert.equal(control('textarea','场景交流').value,'保留中的交流草稿');
assert.equal(control('textarea','本轮回答').value,'保留中的新答案草稿');
turnError='Synthetic text turn error';render();assert.equal(find('textarea','场景交流'),undefined);assert.equal(find('textarea','本轮回答'),undefined);
turnError='';render();assert.equal(control('textarea','场景交流').value,'保留中的交流草稿');
spec={...spec,runtimeContract:{...spec.runtimeContract,allowConversation:false}};render();assert.equal(find('textarea','场景交流'),undefined);
assert.ok(find('textarea','本轮回答'),'denied discussion does not remove the authorized text answer control');
spec={...spec,runtimeContract:{...spec.runtimeContract,allowConversation:true}};run={...run,status:'success'};render();
assert.equal(find('textarea','场景交流'),undefined);assert.ok(!find('textarea','本轮回答')||find('textarea','本轮回答').props.disabled);

// A form also keeps independent discussion, but pure free chat without an
// active task/form still has just its original input, not duplicate composers.
run={...run,status:'running',messages:[{id:'plain-chat',speakerType:'role',speakerName:'Tutor',content:'直接聊吧。',timestamp:''}]};render();
assert.ok(find('textarea','本轮回答'));assert.equal(find('textarea','场景交流'),undefined);
spec={...spec,promptModuleIds:[...spec.promptModuleIds,'input-form'],inputForm:{id:'synthetic-form',title:'表单',
 fields:[{id:'context',label:'背景',kind:'text',purpose:'context',required:false,maxLength:1000}]}};render();
assert.ok(find('form'));assert.ok(find('textarea','场景交流'),'form submissions must not be the only way to adjust teaching');
console.log('Scene conversation UI passed: real component handlers/hooks, answer/conversation routing, pending preservation, IME, waiting drafts and permission/terminal locks. Not browser rendering evidence.');
