import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import { isS4ReferenceUnlocked } from '../src/services/scene/sceneS4Policy';

globalThis.fetch = async () => assert.fail('Curve UI checks must not access real services');
const flush = async () => {for (let i = 0; i < 18; i++) await Promise.resolve();};
const gate = () => {let resolve!: (value:any) => void, reject!: (error:Error) => void; const promise = new Promise<any>((yes,no) => {resolve=yes; reject=no;}); return {promise,resolve,reject};};
const all = (n:any): any[] => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(all) : [n,...all(n.props?.children)];
function compile(path:string, target:string) {
  const source = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n) && !ts.isExportAssignment(n))
    .map(n=>n.getText(source)).join('\n').replace(/^export\s+/gm,'').replace("import('function-plot')",'loadPlot()');
  return ts.transpileModule(`${body}\nreturn ${target};`, {compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText;
}
function mount(code:string, environment:any, initial:any) {
  const slots:any[] = [], effects:Array<()=>void> = [], cleanups:any[] = [];
  let cursor=0, props=initial, nodes:any[] = [], live=true, afterUnmount=0;
  const same = (a:any[],b:any[]) => a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  const hooks = {
    useState(value:any) {const i=cursor++; slots[i] ||= {value:typeof value==='function'?value():value}; return [slots[i].value,(next:any)=>{if(!live) afterUnmount++; slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},
    useRef(value:any) {const i=cursor++; return slots[i] ||= {current:value};},
    useMemo(fn:any,deps:any[]) {const i=cursor++; if(!slots[i] || !same(slots[i].deps,deps)) slots[i]={deps,value:fn()}; return slots[i].value;},
    useCallback(fn:any,deps:any[]) {return hooks.useMemo(()=>fn,deps);},
    useEffect(effect:any,deps:any[]) {const i=cursor++; if(!slots[i] || !same(slots[i].deps,deps)) {slots[i]={deps}; effects.push(()=>{cleanups[i]?.(); cleanups[i]=effect();});}},
  };
  const env={...environment,...hooks,React:{...hooks,createElement:(type:any,props:any,...children:any[])=>({type,props:{...props,children}})}};
  const Component = new Function(...Object.keys(env),code)(...Object.values(env));
  const render = () => {cursor=0; nodes=all(Component(props)); for(const n of nodes) if(n.props.className==='scene-s4-chart-host') n.props.ref.current=environment.host; effects.splice(0).forEach(fn=>fn());};
  const find = (test:(n:any)=>boolean) => {const n=nodes.find(test); assert.ok(n,'UI control exists'); return n.props;};
  render(); render();
  return {render,find,get nodes(){return nodes;},get afterUnmount(){return afterUnmount;},update(next:any){props={...props,...next}; render(); render();},unmount(){live=false; cleanups.forEach(fn=>fn?.());}};
}
const settle = async (ui:ReturnType<typeof mount>) => {for(let i=0;i<4;i++){await flush();ui.render();}};
const spec:any={sceneId:'synthetic-curves',compute:{symbols:[{name:'x',kind:'variable'},{name:'y',kind:'variable'}],given:[],expected_formula:'ANSWER_SECRET',expected_steps:['ANSWER_STEP_SECRET']},meta:{name:'合成曲线',subject:'合成'}};
const run:any={runId:'synthetic-run',status:'running',canvas:{nodes:[
  {id:'a',type:'formula',data:{label:'第一条',latex:'x'}},
  {id:'b',type:'formula',data:{label:'第二条',latex:'x**2'}},
]}};
const curveCode=compile('src/components/scene/CurvePanel.tsx','CurvePanel');
const candidate=(ui:ReturnType<typeof mount>,label:string)=>ui.find(n=>n.type==='label' && all(n).some(child=>child.type==='span' && child.props.children.includes(label)));
const checkbox=(ui:ReturnType<typeof mount>,label:string)=>all({props:candidate(ui,label)}).find(n=>n.type==='input').props;
let resolves=0, fail=true;
const curveEnv:any={isS4ReferenceUnlocked,ChartView:'chart',LineChart:'line',Loader2:'loader',CircleAlert:'alert',Calculator:'calculator',
  resolveNodeExpression:async(n:any)=>{resolves++;if(fail)throw new Error('合成转译失败');return {ok:true,expr:n.data.latex};},
  parseExpression:async(expr:string)=>({ok:true,result:{variables:expr.includes('y')?['y']:['x']}}),
  solveIntersections:async()=>({ok:true,result:{points:[{x:1,y:1}]}})};
const curves=mount(curveCode,curveEnv,{spec,run,isEnded:false});
const autoEnded = mount(curveCode, curveEnv, {spec, run: {...run, status: 'success', endedByUser: false}, isEnded: true});
autoEnded.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick(); autoEnded.render();
assert.ok(!autoEnded.nodes.some(n => n.type === 'span' && n.props.children.includes('标准答案')), 'auto completion does not expose the reference curve');
autoEnded.update({run: {...run, status: 'success', endedByUser: false, s4ReferenceUnlocked: true}});
assert.ok(candidate(autoEnded, '标准答案'));
autoEnded.update({run: {...run, status: 'failure', endedByUser: true}});
assert.ok(candidate(autoEnded, '标准答案'), 'manual ending preserves legacy curve consent'); autoEnded.unmount();
curves.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick();curves.render();
checkbox(curves,'第一条').onChange();curves.render();await settle(curves);
assert.equal(resolves,1);assert.equal(checkbox(curves,'第一条').disabled,undefined,'failed formula can still be deselected');
assert.equal(checkbox(curves,'第一条')['aria-label'],'第一条','error descriptions cannot rename the checkbox');
assert.ok(curves.find(n=>n.type==='button' && n.props.children.includes('重试所选公式')));
checkbox(curves,'第一条').onChange();curves.render();assert.equal(checkbox(curves,'第一条').checked,false);
checkbox(curves,'第一条').onChange();curves.render();fail=false;
curves.find(n=>n.type==='button' && n.props.children.includes('重试所选公式')).onClick();curves.render();await settle(curves);
assert.equal(curves.find(n=>n.type==='chart').series[0].expr,'x');assert.equal(resolves,2);
curves.find(n=>n.type==='select').onChange({target:{value:'y'}});curves.render();
assert.equal(curves.nodes.some(n=>n.type==='chart'),false,'old variable cache cannot draw immediately after switching');
await settle(curves);assert.match(candidate(curves,'第一条').title,/其他未定变量/);
const beforeRunChange=resolves;curves.update({run:{...run,runId:'replacement'}});await settle(curves);
assert.equal(resolves,beforeRunChange,'changing run clears selection without starting old selections again');
assert.equal(checkbox(curves,'第一条').checked,false);curves.unmount();

let lateCalls=0;const old=gate(), fresh=gate();
const lateCurves=mount(curveCode,{...curveEnv,resolveNodeExpression:async(n:any)=>{lateCalls++;return n.data.latex==='x'?old.promise:fresh.promise;}},{spec,run,isEnded:false});
lateCurves.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick();lateCurves.render();
checkbox(lateCurves,'第一条').onChange();lateCurves.render();
lateCurves.update({run:{...run,canvas:{nodes:[{...run.canvas.nodes[0],data:{...run.canvas.nodes[0].data,latex:'x+1'}}]}}});
old.resolve({ok:true,expr:'old_expression'});await settle(lateCurves);
assert.equal(lateCurves.nodes.some(n=>n.type==='chart'),false,'late translation for an edited formula is not rendered');
fresh.resolve({ok:true,expr:'x+1'});await settle(lateCurves);
assert.equal(lateCurves.find(n=>n.type==='chart').series[0].expr,'x+1');assert.equal(lateCalls,2);
lateCurves.unmount();

const pendingFormula=gate();let sharedCalls=0, intersectionsCalls=0, intersectionFails=true;
const shared=mount(curveCode,{...curveEnv,
  resolveNodeExpression:async(n:any)=>{sharedCalls++;return n.id==='a'?pendingFormula.promise:{ok:true,expr:n.data.latex};},
  solveIntersections:async()=>{intersectionsCalls++;if(intersectionFails)throw new Error('合成交点失败');return {ok:true,result:{points:[{x:1,y:1}]}};},
},{spec,run,isEnded:false});
shared.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick();shared.render();
checkbox(shared,'第一条').onChange();shared.render();
checkbox(shared,'第二条').onChange();shared.render();
assert.equal(sharedCalls,1,'selection changes share the pending translation');
pendingFormula.resolve({ok:true,expr:'x'});await settle(shared);
assert.equal(sharedCalls,2);assert.equal(intersectionsCalls,1);
assert.ok(shared.find(n=>n.props.role==='alert'));
intersectionFails=false;
shared.find(n=>n.type==='button' && n.props.children.includes('重试交点')).onClick();shared.render();await settle(shared);
assert.deepEqual(shared.find(n=>n.type==='chart').intersections,[{x:1,y:1}]);assert.equal(intersectionsCalls,2);
checkbox(shared,'第二条').onChange();shared.render();
assert.deepEqual(shared.find(n=>n.type==='chart').intersections,[],'deselection immediately clears outdated intersections');shared.unmount();

const delayedIntersections=gate();
const lateIntersection=mount(curveCode,{...curveEnv,
  resolveNodeExpression:async(n:any)=>({ok:true,expr:n.data.latex}),solveIntersections:async()=>delayedIntersections.promise,
},{spec,run,isEnded:false});
lateIntersection.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick();lateIntersection.render();
checkbox(lateIntersection,'第一条').onChange();checkbox(lateIntersection,'第二条').onChange();lateIntersection.render();await settle(lateIntersection);
checkbox(lateIntersection,'第二条').onChange();lateIntersection.render();
delayedIntersections.resolve({ok:true,result:{points:[{x:9,y:9}]}});await settle(lateIntersection);
assert.deepEqual(lateIntersection.find(n=>n.type==='chart').intersections,[]);lateIntersection.unmount();
const unmountedFormula=gate();let parsesAfterDeparture=0;
const formulaDeparture=mount(curveCode,{...curveEnv,resolveNodeExpression:async()=>unmountedFormula.promise,
  parseExpression:async()=>{parsesAfterDeparture++;return {ok:true,result:{variables:['x']}};},
},{spec,run,isEnded:false});
formulaDeparture.find(n=>n.type==='button' && n.props['aria-expanded']===false).onClick();formulaDeparture.render();
checkbox(formulaDeparture,'第一条').onChange();formulaDeparture.render();formulaDeparture.unmount();
unmountedFormula.resolve({ok:true,expr:'x'});await flush();
assert.equal(formulaDeparture.afterUnmount,0);assert.equal(parsesAfterDeparture,0,'departure prevents the next compute stage');

const plotCode=compile('src/components/scene/ChartView.tsx','ChartView');
const series=(expr:string)=>[{id:'a',label:'合成曲线',expr,color:'#315e49'}];
const sample=(y=1)=>({ok:true,result:{x:[0,1],y:[0,y]}});
const plotEnv=(fetcher:any)=>{
  const host={innerHTML:'',clientWidth:280}, plots:any[]=[], observers:any[]=[];
  return {host,plots,observers,fetchPlotData:fetcher,LineChart:'line',Loader2:'loader',CircleAlert:'alert',
    ResizeObserver:class{callback:any;constructor(cb:any){this.callback=cb;observers.push(this);}observe(){}disconnect(){}},
    loadPlot:async()=>({default:(options:any)=>{plots.push(options);host.innerHTML='<svg>synthetic</svg>';}})};
};
let fetches=0;const oldSamples=gate(),newSamples=gate();
const plot=plotEnv(async(expr:string)=>{fetches++;return expr==='old'?oldSamples.promise:newSamples.promise;});
const graph=mount(plotCode,plot,{series:series('old'),variable:'x',range:['0','1']});
assert.equal(fetches,1,'resize initialization reuses the pending sample request');
graph.update({series:series('new')});oldSamples.resolve(sample(9));await settle(graph);assert.equal(plot.plots.length,0);
newSamples.resolve(sample(2));await settle(graph);assert.equal(plot.plots.at(-1).data[0].points[1][1],2);
const sampled=fetches;graph.update({intersections:[{x:.5,y:1}]});await settle(graph);assert.equal(fetches,sampled,'intersection annotations do not resample curves');
plot.host.clientWidth=180;plot.observers[0].callback();graph.render();await settle(graph);
assert.equal(plot.plots.at(-1).width,180);assert.equal(fetches,sampled,'responsive redraw does not call compute again');graph.unmount();

let failures=0;const retryPlot=plotEnv(async()=>{failures++;if(failures===1)throw new Error('合成采样失败');return sample();});
const retryGraph=mount(plotCode,retryPlot,{series:series('x'),variable:'x',range:['0','1']});await settle(retryGraph);
assert.ok(retryGraph.find(n=>n.props.role==='alert'));assert.equal(retryPlot.host.innerHTML,'');
const retryAction=retryGraph.find(n=>n.type==='button' && n.props.children.includes('重试绘图')).onClick;
retryAction();retryAction();await settle(retryGraph);assert.equal(failures,2,'same-frame retry is locked');assert.equal(retryPlot.plots.length,1);retryGraph.unmount();
const departed=gate(),departurePlot=plotEnv(async()=>departed.promise);
const departure=mount(plotCode,departurePlot,{series:series('x'),variable:'x',range:['0','1']});departure.unmount();
departed.resolve(sample());await flush();assert.equal(departure.afterUnmount,0);assert.equal(departurePlot.plots.length,0);

const latexCode=compile('src/services/scene/sceneExport.ts','buildSceneLatex');
const buildLatex=new Function('stepDisplay',latexCode)((s:any)=>typeof s==='string'?s:s.display);
const exportRun={...run,canvas:{...run.canvas,nodes:run.canvas.nodes.map((n:any)=>({...n,position:{x:0,y:0}}))}};
assert.doesNotMatch(buildLatex(spec,exportRun),/ANSWER|标准解法|目标结果/);
assert.match(buildLatex(spec,{...exportRun,status:'success'}),/ANSWER_SECRET/);
assert.match(buildLatex(spec,{...exportRun,status:'success'}),/ANSWER\\_STEP\\_SECRET/);
console.log('Scene curves UI passed: keyed formula/variable cache, deselection/retry, run isolation, stale translation/sample rejection, single-flight requests, responsive redraw, unmount safety and running-export answer lock. All services synthetic; no downloads.');
