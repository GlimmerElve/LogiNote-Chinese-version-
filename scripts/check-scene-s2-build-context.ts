import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ScenePackDescription } from '../src/types/sceneInteractionPack';
import { S2_BUILDER_BOUNDARY, S2_BUILDER_CANVAS_RULES, projectS2BuilderGuide } from '../src/services/scene/sceneS2BuildContext';

globalThis.fetch = async () => assert.fail('Builder context checks must never call a model, network or personal sources');
const guide: ScenePackDescription = {
  purpose: '自定义数值学习包',
  components: [{ id: 'arbitrary-business-component', name: '一个开发者组件', purpose: '由开发者定义用途，不猜测组件与能力一一对应',
    configuration: '配置全部保留', example: { node: { values: ['原样', 0, false, null] } } }],
  combinations: ['开发者给出的组合规则，不能按业务名字过滤'],
  operations: [{ id: 'customOperation', description: '可观察已有结果', parameters: 'RUNTIME_PARAMETERS_ONLY', errors: ['RUNTIME_ERROR_ONLY'] }],
  builder: { assemble: 'THIRD_PARTY_ASSEMBLE:保留开发者业务约定', repair: 'THIRD_PARTY_REPAIR:保留修复约定' },
  assistant: { instructions: '未来场景互动Agent策略参考，原样保留。', defaultAllowedOperations: ['customOperation'] },
};
const original = JSON.stringify(guide);
const assembled = projectS2BuilderGuide(guide, 'assemble', `HOST_RULES\n${guide.builder.assemble}`);
assert.equal(assembled.builder, undefined, 'The exact assembly policy is included only once');
assert.deepEqual(assembled.components, guide.components); assert.deepEqual(assembled.combinations, guide.combinations);
assert.deepEqual(assembled.operations, [{ id: 'customOperation', description: guide.operations[0].description }]);
assert.deepEqual(Object.keys(assembled.assistant).sort(), ['instructions', 'ownership']);
assert.equal(assembled.assistant.instructions, guide.assistant.instructions);
assert.match(assembled.assistant.ownership, /场景内互动Agent/);
assert.match(assembled.assistant.ownership, /不是搭建Agent/);
assert(!JSON.stringify(assembled).includes('RUNTIME_PARAMETERS_ONLY'));
assert(!JSON.stringify(assembled).includes('RUNTIME_ERROR_ONLY'));
assert(!JSON.stringify(assembled).includes('defaultAllowedOperations'));
assert.equal(assembled.purpose, guide.purpose);

const override = projectS2BuilderGuide(guide, 'assemble', 'OVERRIDING_CALLER_POLICY');
assert.deepEqual(override.builder, { assemble: guide.builder.assemble }, 'A different caller policy cannot erase original package constraints');
const similar = projectS2BuilderGuide(guide, 'assemble', guide.builder.assemble.slice(0, -1));
assert.equal(similar.builder?.assemble, guide.builder.assemble, 'Similar text is not treated as complete policy');
const repaired = projectS2BuilderGuide(guide, 'repair', `HOST_RULES\n${guide.builder.repair}`);
assert.deepEqual(repaired.builder, { assemble: guide.builder.assemble }, 'Repair retains original assembly conventions, deduplicating only its compiled repair policy');
assert.deepEqual(projectS2BuilderGuide(guide, 'repair', 'OVERRIDE').builder, guide.builder);
assert.equal(projectS2BuilderGuide(guide, 'repair', `${guide.builder.assemble}\n${guide.builder.repair}`).builder, undefined);
assert.deepEqual(projectS2BuilderGuide(guide, 'review', 'REVIEW_ONLY').builder, { assemble: guide.builder.assemble });
assert.equal(projectS2BuilderGuide(guide, 'understand', '').builder, undefined);

(assembled.components[0].example as { node: { values: unknown[] } }).node.values.push('投影修改不能影响原包');
assembled.components[0].configuration = '新值'; assembled.combinations.push('本地投影');
assert.equal(JSON.stringify(guide), original, 'The public description and nested examples remain unchanged');
assert.equal(projectS2BuilderGuide(guide, 'assemble', guide.builder.assemble).components[0].configuration, '配置全部保留');

assert(S2_BUILDER_BOUNDARY.length < 300);
assert(S2_BUILDER_CANVAS_RULES.length < 2400, 'Builder declaration rules stay compact');
assert.match(S2_BUILDER_BOUNDARY, /理解用户目标.*选择.*组件.*初始内容.*连接.*交互提示词/s);
assert.match(S2_BUILDER_BOUNDARY, /数据传输、校验、调度与报错由本地程序完成/);
assert.match(S2_BUILDER_CANVAS_RULES, /version:1,goal,instructions/);
assert.match(S2_BUILDER_CANVAS_RULES, /kind:"text-length",min,max/);
assert(!S2_BUILDER_CANVAS_RULES.includes('min?,max?'));
for (const required of ['blockTypes', 'position:{x,y}', 'execution.links', 'core.text@1', 'kind:"literal"', 'kind:"field"',
  'readOnly:true保留', 'nodeId:来源执行节点id', 'equals:完整JSON值', 'match:布尔值', 'human-input.decision',
  '/approved等于true', '缺值或失败不是false', '数据与条件依赖合并后须无环', '0路跳过、1路传递、多路冲突',
  '失败来源仍阻塞', 'inputForms', 'responseForm', 'groups', 'composites', 'criteria', 'text-includes', 'text-length', 'json-pointer-equals']) {
  assert(S2_BUILDER_CANVAS_RULES.includes(required), `Missing authoring declaration: ${required}`);
}
for (const runtimeOnly of ['commands', 'pluginRequests', 'executionRequest', 'idempotencyKey', 'artifactRef', 'cacheReuses', 'remainingCalls']) {
  assert(!S2_BUILDER_CANVAS_RULES.includes(runtimeOnly), `Runtime detail leaked into builder rules: ${runtimeOnly}`);
}
const moduleSource = readFileSync('src/services/scene/sceneS2BuildContext.ts', 'utf8');
assert(!/^import(?! type)/mu.test(moduleSource), 'Pure builder projection has no runtime dependency graph');
assert(!/prompt-lab|text-template|model-test/u.test(moduleSource), 'Canvas context cannot require a specific business package');
console.log(`S2 builder context passed: pure stage projection, exact policy deduplication, preserved third-party conventions and examples, explicit assistant ownership, no runtime operation payload, and generic declaration boundaries (${S2_BUILDER_BOUNDARY.length} boundary / ${S2_BUILDER_CANVAS_RULES.length} canvas chars). Offline only.`);
