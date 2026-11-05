import assert from 'node:assert/strict';
import { applyFigurePatches, repairFigureLocally } from '../src/services/textbook/interactiveFigureRepair';
import type { FigureDesign } from '../src/services/textbook/interactiveFigureDesign';
import { interactiveFigureKey, prepareInteractiveFigure } from '../src/services/textbook/interactiveFigure';
import type { FigureArtifact } from '../src/electron/interactiveFigureStore';
import { webcrypto } from 'node:crypto';
import type { FigureRepairReceipt } from '../src/services/textbook/figureRepairReceipt';

const original = '<div data-figure="visual"><p>错误反馈</p><p>保留说明</p></div><button data-figure="reset">重置</button>';
const good = { patches: [{ search: '错误反馈', replacement: '正确反馈' }] };
const patched = original.replace('错误反馈', '正确反馈');
assert.equal(applyFigurePatches(original, good), patched);
assert.equal(applyFigurePatches('重复片段 重复片段', { patches: [{ search: '重复片段', replacement: '修复' }] }), undefined);
assert.equal(applyFigurePatches(original, { patches: [{ search: '不存在片段', replacement: '修复' }] }), undefined);
assert.equal(applyFigurePatches(original, { patches: [] }), undefined);
assert.equal(applyFigurePatches(original, { patches: [{ search: original, replacement: '重写' }] }), undefined);
const design: FigureDesign = { kind:'comparison', anchor:'合成', goal:'比较', action:'调整', observation:'观察', model:'示意', prediction:'预测', caveat:'假设', transfer:'迁移' };
const initial = { interaction:'observed' as const, reset:'restored' as const, warnings:['prediction-consistency' as const] };
const clean = { interaction:'observed' as const, reset:'restored' as const, checks:{ predictionConsistency:true as const } };
let calls = 0, checks = 0;
const api = { diagnose: async (html: string) => html === original ? initial : clean,
  preflight: async (html: string) => { checks++; assert.equal(html, patched); } };
const generate = async (request: any, options: any) => { calls++; assert.ok(request.skipMemoryInjection && request.skipProfileInjection);
  assert.ok(options.signal instanceof AbortSignal); assert.deepEqual(JSON.parse(request.userInput).warnings, ['prediction-consistency']);
  return { content: JSON.stringify(good) }; };
const input = { html: original, lesson:'合成教材', brief:'比较', design, api, generate, validateHtml: (html: unknown) => String(html) };
assert.equal(await repairFigureLocally(input), patched);
let receipt: FigureRepairReceipt | undefined;
assert.equal(await repairFigureLocally({...input,onOutcome:value=>{receipt=value},generate:async request=>{
  assert.ok(request.systemPromptOverride?.includes('题目固定情境'));
  assert.ok(!request.systemPromptOverride?.includes('柱形越界'));
  return {content:JSON.stringify(good)};
}}),patched);
assert.equal(receipt?.status,'repaired');assert.equal(receipt?.reason,'verified');
await repairFigureLocally({...input,onOutcome:value=>{receipt=value},generate:async()=>{throw Error('offline')}});
assert.equal(receipt?.status,'unresolved');assert.equal(receipt?.reason,'model-unavailable');
await repairFigureLocally({...input,onOutcome:value=>{receipt=value},generate:async()=>({content:JSON.stringify({patches:[]})})});
assert.equal(receipt?.reason,'no-change');
assert.equal(calls, 1); assert.equal(checks, 2);
assert.equal(await repairFigureLocally({ ...input, api: { ...api, diagnose: async () => clean } }), original);
assert.equal(calls, 1, 'no warnings must not call the model');
assert.equal(await repairFigureLocally({ ...input, generate: async () => { throw Error('offline'); } }), original);
assert.equal(await repairFigureLocally({ ...input, generate: async () => ({ content: JSON.stringify({ patches: [{ search:'不存在片段', replacement:'修复' }] }) }) }), original);
assert.equal(await repairFigureLocally({ ...input, api: { ...api, preflight: async () => { throw Error('runtime'); } } }), original);
assert.equal(await repairFigureLocally({ ...input, api: { ...api, diagnose: async () => initial } }), original, 'persisting a warning rejects the candidate');
assert.equal(await repairFigureLocally({ ...input, api: { ...api, diagnose: async html => html === original ? initial : { interaction:'observed', reset:'restored' } } }), original, 'a patch cannot pass by disabling the relevant probe');
assert.equal(await repairFigureLocally({ ...input, api: { ...api, diagnose: async html => html === original ? initial : { ...clean, reset:'different' } } }), original, 'a reset regression rejects the candidate');
const budgetInitial = { interaction:'observed' as const, reset:'restored' as const, warnings:['budget-readout' as const], checks:{ budgetReadout:true as const }, evidence:{ budget:{category:'餐饮',baseline:100,spend:100,remaining:40} } };
const budgetClean = { interaction:'observed' as const, reset:'restored' as const, checks:{budgetReadout:true as const} };
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? budgetInitial : budgetClean }, generate:async request => {
  assert.equal(JSON.parse(request.userInput).evidence.budget.remaining, 40); return {content:JSON.stringify(good)} as any;
} }), patched, 'budget evidence reaches the repair model');
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? budgetInitial : { interaction:'observed', reset:'restored' } }, generate:async () => ({content:JSON.stringify(good)} as any) }), original, 'cannot hide a budget issue by disabling the probe');
const axisInitial = { interaction:'observed' as const, reset:'restored' as const, warnings:['axis-scale' as const], checks:{ axisScale:true as const }, evidence:{ axis:{ ticks:[{value:0,x:80},{value:60,x:200},{value:100,x:320}],expectedX:224,observedX:200} } };
const axisClean = { interaction:'observed' as const, reset:'restored' as const, checks:{axisScale:true as const} };
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? axisInitial : axisClean }, generate:async request => {
  assert.equal(JSON.parse(request.userInput).evidence.axis.expectedX, 224); return {content:JSON.stringify(good)} as any;
} }), patched, 'axis evidence reaches targeted repair');
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? axisInitial : { interaction:'observed', reset:'restored' } }, generate:async () => ({content:JSON.stringify(good)} as any) }), original, 'cannot hide an axis issue by disabling the probe');
const chartInitial = { interaction:'observed' as const, reset:'restored' as const, warnings:['chart-overflow' as const], checks:{chartBounds:true as const}, evidence:{chart:{label:'柱状图',value:50,bar:'barH2',top:-110,bottom:210,viewTop:0,viewBottom:260}} };
const chartClean = { interaction:'observed' as const, reset:'restored' as const, checks:{chartBounds:true as const} };
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? chartInitial : chartClean }, generate:async request => {
  assert.equal(JSON.parse(request.userInput).evidence.chart.bar,'barH2'); assert.ok(request.systemPromptOverride?.includes('柱形越界')); return {content:JSON.stringify(good)} as any;
} }), patched);
assert.equal(await repairFigureLocally({ ...input, api:{ ...api, diagnose:async html => html === original ? chartInitial : {interaction:'observed',reset:'restored'} }, generate:async () => ({content:JSON.stringify(good)} as any) }), original, 'removing the chart probe cannot make a repair pass');
assert.equal(await repairFigureLocally({ ...input, html:'x'.repeat(24_001) }), 'x'.repeat(24_001), 'oversized figures do not trigger costly repair');
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const figure = '<svg><circle r="2"/></svg><input data-figure="prediction"><button data-figure="check">检查</button><button data-figure="reset">重置</button><p data-figure="transfer">迁移</p><p>错误反馈</p>';
const expected = figure.replace('错误反馈', '正确反馈'), lesson = '合成教材：比较。', brief = '比较';
const records = new Map<string, FigureArtifact>();
const model = async (request: any) => {
  const payload = JSON.parse(request.userInput);
  return { content: JSON.stringify(payload.warnings ? good : { design: { ...design, anchor: brief }, html: figure }) };
};
const figureApi = { read: async (key: string) => records.get(key) || null, write: async (key: string, item: FigureArtifact) => { records.set(key, item); },
  compareReady: async (key: string, prior: FigureArtifact, next: FigureArtifact) => { if (records.get(key) !== prior) return false; records.set(key, next); return true; },
  preflight: async () => {}, diagnose: async (html: string) => html.includes('错误反馈') ? initial : clean,
  open: async () => ({ processId: 1 }), bounds: async () => {}, visible: async () => {}, close: async () => {}, onFailure: () => () => {} };
const oldKey = await interactiveFigureKey('old', lesson, brief);
records.set(oldKey, { status:'ready', html:figure, design });
assert.equal(await prepareInteractiveFigure(oldKey, lesson, brief, false, { api:figureApi, generate:model }), expected, 'an older ready figure is repaired without a full regeneration');
assert.equal((records.get(oldKey) as { autoChecked?: number }).autoChecked, 1);
assert.equal(await prepareInteractiveFigure(oldKey, lesson, brief, false, { api:figureApi, generate:async () => { throw Error('must not retry'); } }), expected);
const noDesignKey = await interactiveFigureKey('old-without-design', lesson, brief);
records.set(noDesignKey, { status:'ready', html:figure });
assert.equal(await prepareInteractiveFigure(noDesignKey, lesson, brief, false, { api:figureApi, generate:model }), expected, 'old figures without a stored design remain eligible');
assert.equal((records.get(noDesignKey) as { autoChecked?: number }).autoChecked, 1);
const newKey = await interactiveFigureKey('new', lesson, brief);
assert.equal(await prepareInteractiveFigure(newKey, lesson, brief, false, { api:figureApi, generate:model }), expected, 'new figures are repaired before publication');
assert.equal((records.get(newKey) as { autoChecked?: number }).autoChecked, 1);
assert.equal((records.get(newKey) as {repairReceipt?:FigureRepairReceipt}).repairReceipt?.status,'repaired');
const unresolvedKey=await interactiveFigureKey('unresolved',lesson,brief);
records.set(unresolvedKey,{status:'ready',html:figure,design,autoChecked:1,repairReceipt:{version:1,status:'unresolved',reason:'model-unavailable',warnings:['prediction-consistency'],requested:true}});
let targetedCalls=0;
assert.equal(await prepareInteractiveFigure(unresolvedKey,lesson,brief,false,{api:figureApi,generate:async()=>{throw Error('reopen cannot call model')}}),figure);
assert.equal(await prepareInteractiveFigure(unresolvedKey,lesson,brief,true,{api:figureApi,generate:async request=>{
  targetedCalls++;assert.ok(JSON.parse(request.userInput).warnings,'explicit repair sends a patch request, never full generation');return {content:JSON.stringify(good)};
}}),expected);
assert.equal(targetedCalls,1);
records.set(unresolvedKey,{status:'ready',html:figure,design,autoChecked:1,repairReceipt:{version:1,status:'unresolved',reason:'model-unavailable',warnings:['prediction-consistency'],requested:true}});
await assert.rejects(prepareInteractiveFigure(unresolvedKey,lesson,brief,true,{api:figureApi,generate:async()=>{throw Error('offline')}}),/局部修复未完成/u);
assert.equal((records.get(unresolvedKey) as {html:string}).html,figure,'failed targeted repair preserves the ready figure');
const staleKey = await interactiveFigureKey('stale', lesson, brief);
records.set(staleKey, { status:'ready', html:figure, design });
const newer = { status:'ready' as const, html:figure.replace('错误反馈', '用户新图'), design };
const staleApi = { ...figureApi, compareReady: async (key: string) => { records.set(key, newer); return false; } };
assert.equal(await prepareInteractiveFigure(staleKey, lesson, brief, false, { api:staleApi, generate:model }), newer.html, 'a concurrent newer version wins over repair');
console.log('PASS figure repair: bounded unique patches, isolated recheck, no-warning and failure fallback');
