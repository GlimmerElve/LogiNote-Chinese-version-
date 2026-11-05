import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('ProgressiveCourseReader.tsx', readFileSync('src/components/progressive/ProgressiveCourseReader.tsx','utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isArrowFunction(node) && ts.isCallExpression(node.parent) && node.parent.expression.getText(source)==='useEffect'
    && node.getText(source).includes('restored.current === key')) effect=node;
  ts.forEachChild(node, visit);
}
visit(source); assert.ok(effect);
let serial=0, writes=0, position=0;
const frames=new Map<number,()=>void>(), listeners=new Map<string,()=>void>();
const element={ get scrollTop(){return position;}, set scrollTop(value:number){writes++;position=value;},
  addEventListener:(name:string,listener:()=>void)=>listeners.set(name,listener),
  removeEventListener:(name:string,listener:()=>void)=>{if(listeners.get(name)===listener)listeners.delete(name);} };
const env={active:false,course:{id:'course',progress:{scrollTop:123}},pageId:'main-1',viewport:{current:element},restored:{current:null as string|null},
  requestAnimationFrame:(fn:()=>void)=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:(id:number)=>frames.delete(id)};
const code=ts.transpileModule('return ('+effect.getText(source)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const run=()=>new Function(...Object.keys(env),code)(...Object.values(env))();
const paint=()=>{const jobs=[...frames.values()];frames.clear();for(const job of jobs)job();};
assert.equal(run(),undefined);assert.equal(frames.size,0);assert.equal(writes,0);
env.active=true;let cleanup=run();assert.equal(writes,0,'activation never forces layout before returning');assert.equal(frames.size,1);
cleanup();paint();assert.equal(writes,0,'abandoned reader cannot restore a position');assert.equal(listeners.size,0);
cleanup=run();paint();assert.equal(position,123);assert.equal(writes,1);cleanup();
assert.equal(run(),undefined,'same page retains its live reading position');
env.pageId='main-2';env.course.progress.scrollTop=234;cleanup=run();
position=321;listeners.get('wheel')!();paint();assert.equal(position,321,'user scrolling wins over pending saved-position restoration');assert.equal(writes,1);
cleanup();assert.equal(listeners.size,0);assert.equal(frames.size,0);
console.log('PASS actual reader activation: no synchronous scroll/layout, inactive/abandoned work cancelled, position restored once, user scrolling wins');
