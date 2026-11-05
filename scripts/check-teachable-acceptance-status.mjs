import assert from 'node:assert/strict';
import { classifyTeachableAcceptance as classify } from './teachable-acceptance-status.mjs';
const base={checks:[{status:'passed'}],liveResults:[{status:'generated',runtime:{screenshot:true,diagnostics:{interaction:'observed',reset:'restored'}}}]};
assert.equal(classify(base),'passed');
for(const diagnostics of ['unavailable',{interaction:'inconclusive',reset:'restored'},{interaction:'observed',reset:'different'},{interaction:'observed',reset:'restored',warnings:['chart-overflow']}])
  assert.equal(classify({...base,liveResults:[{status:'generated',runtime:{screenshot:true,diagnostics}}]}),'needs-review');
assert.equal(classify({...base,liveResults:[{status:'generated',runtime:{screenshot:false,diagnostics:base.liveResults[0].runtime.diagnostics}}]}),'needs-review');
assert.equal(classify({...base,liveResults:[{status:'failed'}]}),'failed');
assert.equal(classify({...base,checks:[{status:'skipped'}]}),'failed');
assert.equal(classify({...base,liveResults:[{status:'generated'}]}),'passed');
console.log('PASS acceptance status: failures and inconclusive runtime checks are not presented as clean passes');
