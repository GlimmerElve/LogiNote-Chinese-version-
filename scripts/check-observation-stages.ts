/** Local model/configuration regression. No model requests or network. */
import assert from 'node:assert/strict';
import { buildObservationStage, groupingObservation, groupingViewBox, normalizeGroupingConfig, normalizeReactionConfig, reactionObservation } from '../src/services/textbook/teachingModels/observation';
import { GROUPING_CONFIGS, REACTION_CONFIGS } from './fixtures/observation-stage-configs';
globalThis.fetch = async () => assert.fail('Observation components must stay offline');
const checks: string[] = [];
const check = (name: string, run: () => void) => { run(); checks.push(name); };
check('分组：原参数和第二配置全间距均不裁切且共享原始类别', () => {
  for (const value of GROUPING_CONFIGS) {
    const config = normalizeGroupingConfig(value), box = groupingViewBox(config), initial = groupingObservation(config, config.initialGap);
    assert.deepEqual(initial.positions, config.positions);
    for (const gap of [config.gapRange[0],config.initialGap,config.gapRange[1]]) {
      const state = groupingObservation(config,gap);
      assert.deepEqual(state.colors, config.colors); assert.deepEqual(state.similarity, initial.similarity);
      state.positions.forEach((x,index) => { assert.ok(x-8>=box[0] && x+8<=box[0]+box[2]); assert.equal(x,config.positions[index]+(index>=config.gapIndex?gap-config.initialGap:0)); });
    }
  }
});
check('接近规则采用≤且保持颜色相似分组独立', () => {
  const config = normalizeGroupingConfig(GROUPING_CONFIGS[1]);
  assert.deepEqual(groupingObservation(config,25).proximity,[[0,1,2,3]]);
  assert.deepEqual(groupingObservation(config,26).proximity,[[0,1],[2,3]]);
  assert.deepEqual(groupingObservation(config,90).similarity,[[0,2],[1,3]]);
});
check('分组：初始间距不对应、非法边界和不匹配颜色拒绝', () => {
  const base=GROUPING_CONFIGS[0];
  for(const value of [{...base,initialGap:50},{...base,gapIndex:0},{...base,gapRange:[0,160]},{...base,positions:[20,20,60,100,120,140]},{...base,colors:['green']}]) assert.throws(()=>normalizeGroupingConfig(value));
});
check('原化学参数：计数、原子总数、停止和重置语义', () => {
  const config=normalizeReactionConfig(REACTION_CONFIGS[0]);
  assert.deepEqual([0,1,2].map(step=>reactionObservation(config,step).counts),[[4,3,0],[2,2,2],[0,1,4]]);
  for(const step of [0,1,2]) assert.deepEqual(reactionObservation(config,step).atomTotals,{H:8,O:6});
  assert.equal(reactionObservation(config,2).stopped,true); assert.deepEqual(reactionObservation(config,0).counts,[4,3,0]);
  assert.throws(()=>reactionObservation(config,3));
});
check('另一合法反应：按输入系数执行，未写死水反应', () => {
  const config=normalizeReactionConfig(REACTION_CONFIGS[1]);
  assert.deepEqual(reactionObservation(config,1).counts,[2,4,2]); assert.deepEqual(reactionObservation(config,2).counts,[1,1,4]);
  for(const step of [0,1,2]) assert.deepEqual(reactionObservation(config,step).atomTotals,{N:6,H:14});
});
check('未配平、非整数系数、负物料与60分子预算拒绝', () => {
  const base=REACTION_CONFIGS[0];
  assert.throws(()=>normalizeReactionConfig({...base,products:[{label:'H₂O',coefficient:1,atoms:{H:2,O:1}}]}));
  assert.throws(()=>normalizeReactionConfig({...base,reactants:[{...base.reactants[0],coefficient:1.5},base.reactants[1]]}));
  assert.throws(()=>normalizeReactionConfig({...base,reactants:[{...base.reactants[0],count:-1},base.reactants[1]]}));
  assert.throws(()=>normalizeReactionConfig({...base,reactants:[{...base.reactants[0],count:60},{...base.reactants[1],count:60}]}));
  const split={reactants:[{label:'A₂',coefficient:1,count:31,atoms:{A:2}}],products:[{label:'A',coefficient:2,atoms:{A:1}}]};
  assert.throws(()=>normalizeReactionConfig(split));
});
check('生成固定本地控制器：模式、稳定标记与安全数据编码', () => {
  for(const [type,configs,mode] of [['grouping',GROUPING_CONFIGS,'contrast'],['reaction',REACTION_CONFIGS,'step']] as const) for(const config of configs){
    const built=buildObservationStage(type,config,'测试 <script>title</script>');
    assert.ok(built.html.includes(`data-figure-mode="${mode}"`) && built.html.includes('data-figure="reset"') && built.html.includes('data-figure="result"'));
    assert.ok(!built.html.includes('data-figure="prediction"') && !built.html.includes('data-figure="check"'));
    assert.ok(built.html.includes('&lt;script&gt;title&lt;/script&gt;'));
    assert.ok(type==='grouping'?built.html.includes('data-point-index'):built.html.includes('data-species-index')&&built.html.includes('data-atom-total'));
    assert.ok(Object.values(built.semantics).every(value=>typeof value==='string'&&value.length>5));
    const script=built.html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];assert.ok(script);assert.doesNotThrow(()=>new Function(script));
  }
});
console.log(JSON.stringify({passed:checks.length,checks,remoteRequests:0},null,2));
