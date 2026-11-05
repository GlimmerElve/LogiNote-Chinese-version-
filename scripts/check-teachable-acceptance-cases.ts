/** Fixed synthetic teaching contracts; no network, profile, or vault access. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { selectFigureComponent } from '../src/services/textbook/interactiveFigureCapabilities';
import { requiresReferenceGeometry } from '../src/services/textbook/interactiveFigureDesign';
import { compileTextbookFunction, parseFunctionPlot, riemannRectangles } from '../src/services/textbook/functionPlot';
import { extractThresholdSamples, thresholdCounts } from '../src/services/textbook/interactiveThresholdFigure';
import { extractExternalGearFacts } from '../src/services/textbook/interactiveGearFigure';
import { extractLruFacts } from '../src/services/textbook/interactiveLruFigure';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';

interface Case { id:string; discipline:string; goal:string; lesson:string; component:string; renderer?:string; checks:string[] }
const collection = JSON.parse(await readFile('scripts/fixtures/teachable-acceptance-cases.json','utf8')) as {version:number;source:string;cases:Case[]};
assert.equal(collection.version,1); assert.match(collection.source,/合成/u); assert.ok(collection.cases.length >= 17);
const ids=new Set<string>();
for(const item of collection.cases){
  assert.ok(/^[a-z0-9-]+$/u.test(item.id) && !ids.has(item.id)); ids.add(item.id);
  assert.ok(item.goal && item.lesson && item.discipline && item.checks.length>=2);
  if(item.component==='blocked') assert.ok(requiresReferenceGeometry(item.goal), `${item.id} requires reference geometry`);
  else { const selected=selectFigureComponent(item.goal,item.lesson); assert.equal(selected.component,item.component, `${item.id} route`);
    if(item.renderer)assert.equal(selected.renderer,item.renderer,`${item.id} renderer`); }
}
const get=(id:string)=>{const item=collection.cases.find(value=>value.id===id);assert.ok(item,id);return item};
const square=compileTextbookFunction('x^2','x'); assert.equal(square.evaluate(-2),4); assert.equal(square.evaluate(2),4);
const reciprocal=compileTextbookFunction('1/x','x'); assert.ok(!Number.isFinite(reciprocal.evaluate(0))); assert.equal(reciprocal.evaluate(-1),-1);
const area=parseFunctionPlot(JSON.stringify({title:'积分面积',variable:'x',xLabel:'x',yLabel:'y',xDomain:[0,1],yDomain:[0,1],curves:[{id:'f',label:'y=x',expression:'x'}],riemann:{curveId:'f',from:0,to:1,count:4,method:'right'}}));
assert.equal(riemannRectangles(area).signedSum,.625);
const limit=compileTextbookFunction('(1+k/x)^x','x',{k:1}); assert.ok(Math.abs(limit.evaluate(10_000)-Math.E)<.001);
const samples=extractThresholdSamples(get('threshold').lesson); assert.ok(samples);
assert.deepEqual(thresholdCounts(samples,.5),{falsePositive:1,falseNegative:1,positives:2,negatives:2});
assert.deepEqual(thresholdCounts(samples,.3),{falsePositive:1,falseNegative:0,positives:2,negatives:2});
assert.deepEqual(extractExternalGearFacts(get('gear-external').lesson),{driverTeeth:12,drivenTeeth:24});
assert.deepEqual(extractLruFacts(get('lru').lesson),{initial:['A','B','C']});
assert.equal(compileTextbookFunction('100*x','x').evaluate(.02),2);
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
let modelCalls=0;
const api={read:async()=>null,write:async()=>{},open:async()=>({processId:1}),bounds:async()=>{},visible:async()=>{},close:async()=>{},onFailure:()=>()=>{}};
const anatomy=get('anatomy-reference'), key=await interactiveFigureKey('synthetic',anatomy.lesson,anatomy.goal);
await assert.rejects(prepareInteractiveFigure(key,anatomy.lesson,anatomy.goal,false,{api,generate:async()=>{modelCalls++;throw Error('unexpected model call')}}),/几何/u);
assert.equal(modelCalls,0);
console.log(`PASS ${collection.cases.length} synthetic contracts: routing, boundary values, conflicts and reference-geometry refusal`);
