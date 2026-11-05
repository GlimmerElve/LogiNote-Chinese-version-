import assert from 'node:assert/strict';
import { formatS2Assessment, readS2AssessmentRequest, S2_ASSESSMENT_RULES } from '../src/services/scene/sceneS2Assessment';
import type { S2BusinessCriterion, S2BusinessPackage } from '../src/types/sceneS2Business';
import type { S2Document } from '../src/types/sceneS2';

globalThis.fetch = async () => assert.fail('Offline assessment only; no model, notes, profile, network or external artifacts');
const current: S2Document = { nodes: [
  { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, values: { content: '请只返回JSON，包含summary字段。🙂', empty: '' } },
  { id: 'result', type: 'text', position: { x: 100, y: 0 }, values: { content: '{"summary":"示例","meta":{"b":2,"a":1},"items":[true],"a/b":{"~x":5}}' } },
], edges: [] };
const criteria: S2BusinessCriterion[] = [
  { id: 'contains', label: '格式要求', expectation: '提示词明确要求JSON', method: 'local', required: true,
    target: { nodeId: 'prompt', fieldId: 'content' }, rule: { kind: 'text-includes', value: '只返回JSON' } },
  { id: 'length', label: '长度', expectation: '字符范围', method: 'local', required: false,
    target: { nodeId: 'prompt', fieldId: 'content' }, rule: { kind: 'text-length', min: 1, max: 100 } },
  { id: 'json', label: 'JSON值', expectation: 'meta保持预设值', method: 'local', required: true,
    target: { nodeId: 'result', fieldId: 'content' }, rule: { kind: 'json-pointer-equals', pointer: '/meta', value: { a: 1, b: 2 } } },
  { id: 'clarity', label: '明确性', expectation: '输出要求明确', method: 'semantic', required: true },
  { id: 'style', label: '风格建议', expectation: '可以尝试增加示例，不据此判失败', method: 'advisory', required: false },
  { id: 'later', label: '后续字段', expectation: '可在后续评价', method: 'local', required: false,
    target: { nodeId: 'gone', fieldId: 'content' }, rule: { kind: 'text-includes', value: '存在' } },
];
const business: Pick<S2BusinessPackage, 'criteria'> = { criteria };
const original = JSON.stringify(current), originalBusiness = JSON.stringify(business);
const request = (criterionIds: string[], judgments?: unknown[]) => ({ criterionIds, ...(judgments ? { judgments } : {}) });
const judgment = (criterionId: string, verdict: 'met' | 'unmet' | 'uncertain', evidence: unknown[] = [], reason = '合成测试判断，不证明真实模型语义准确') => ({ criterionId, verdict, reason, evidence });
const field = (quote: string) => ({ sourceId: 'field:prompt:content', quote });
const evaluate = (raw: unknown, document = current, supplied = business, query?: string) => readS2AssessmentRequest(raw, supplied, document, query);
const withCriterion = (patch: Partial<S2BusinessCriterion>) => ({ criteria: [{ ...criteria[2], ...patch }] });

const exact = evaluate(request(['contains', 'json']));
assert.equal(exact.overall, 'met'); assert.equal(exact.scope, 'selected-criteria-only');
assert.deepEqual(exact.omittedCriterionIds, ['length', 'clarity', 'style', 'later']);
assert.ok(exact.checks.every(check => check.method === 'local' && check.verdict === 'met'));
assert.equal(evaluate(request(['contains'], [judgment('contains', 'unmet')])).checks[0].verdict, 'met', 'Do not trust the model verdict for local rules');
const changed = structuredClone(current); changed.nodes[0].values.content = '普通文本';
assert.equal(evaluate(request(['contains'], [judgment('contains', 'met')]), changed).overall, 'unmet', 'A model claim cannot override current exact field data');
assert.equal(evaluate(request(['later'])).overall, 'uncertain', 'A deleted target is unknown, not an invalid editing operation');
assert.equal(evaluate(request(['length'])).overall, 'met', 'If there are no selected required formal criteria, count the selected optional formal criteria');
const oneCodepoint = structuredClone(current); oneCodepoint.nodes[0].values.content = '🙂';
const onlyLength = { criteria: [{ ...criteria[1], rule: { kind: 'text-length', min: 1, max: 1 } } as S2BusinessCriterion] };
assert.equal(evaluate(request(['length']), oneCodepoint, onlyLength).overall, 'met', 'Length uses Unicode code points, not surrogate halves');
assert.equal(evaluate(request(['contains', 'clarity'])).overall, 'uncertain', 'Missing semantic judgment must not become an implicit pass');
const missingPointer = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/missing', value: null } });
assert.equal(evaluate(request(['json']), current, missingPointer).overall, 'unmet');
assert.match(evaluate(request(['json']), current, missingPointer).checks[0].reason, /不存在/);
const slashPointer = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/a~1b/~0x', value: 5 } });
assert.equal(evaluate(request(['json']), current, slashPointer).overall, 'met', 'Standard escaped JSON Pointer reads exact keys');
const arrayPointer = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/items/0', value: true } });
assert.equal(evaluate(request(['json']), current, arrayPointer).overall, 'met');
const nameOnly = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/0/name', value: '示例甲' } });
const nameSource = structuredClone(current), changedSibling = structuredClone(current);
nameSource.nodes[1].values.content = '[{"name":"示例甲","score":80}]';
changedSibling.nodes[1].values.content = '[{"name":"示例甲","score":120},{"name":"新增记录"}]';
assert.notEqual(nameSource.nodes[1].values.content, changedSibling.nodes[1].values.content);
for (const document of [nameSource, changedSibling]) {
  const narrow = evaluate(request(['json']), document, nameOnly);
  assert.equal(narrow.overall, 'met', 'A name-only comparison does not check score, sibling fields or the entire record array');
  assert.equal(narrow.checks[0].reason, '当前JSON路径值与预设值一致。', 'Host evidence must stay narrower than whole-record preservation');
}
const noncanonicalArray = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/items/00', value: true } });
assert.equal(evaluate(request(['json']), current, noncanonicalArray).overall, 'unmet');
const rootPointer = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '', value: JSON.parse(current.nodes[1].values.content) } });
assert.equal(evaluate(request(['json']), current, rootPointer).overall, 'met');
const invalidJson = structuredClone(current); invalidJson.nodes[1].values.content = '{"summary":';
assert.equal(evaluate(request(['json']), invalidJson).overall, 'unmet', 'Truncated JSON is not repaired, executed or silently accepted');
const deepJson = structuredClone(current); deepJson.nodes[1].values.content = '['.repeat(18) + '0' + ']'.repeat(18);
assert.equal(evaluate(request(['json']), deepJson).overall, 'uncertain', 'Host safety bounds do not prove failure of a business criterion');
for (const segments of [16, 17]) {
  const deepPointer = withCriterion({ rule: { kind: 'json-pointer-equals', pointer: '/a'.repeat(segments), value: true } });
  const shallow = evaluate(request(['json']), current, deepPointer);
  assert.equal(shallow.overall, 'unmet', `${segments}-segment saved pointers remain valid rules; a missing shallow-data path is not a protocol failure`);
  assert.match(shallow.checks[0].reason, /不存在/);
  const complete = structuredClone(current);
  complete.nodes[1].values.content = '{"a":'.repeat(segments) + 'true' + '}'.repeat(segments);
  assert.equal(evaluate(request(['json']), complete, deepPointer).overall, segments === 16 ? 'met' : 'uncertain',
    'Pointer syntax and actual JSON inspection depth are distinct: out-of-range real data is uncertain, not an invalid saved rule');
}
const legacyUnselected = { criteria: [criteria[0], { ...criteria[2], rule: { kind: 'json-pointer-equals', pointer: '/bad~2path', value: true } } as S2BusinessCriterion] };
assert.equal(evaluate(request(['contains']), current, legacyUnselected).overall, 'met', 'An unselected obsolete in-memory rule cannot prevent checking an unrelated valid criterion');
assert.deepEqual(evaluate(request(['contains']), current, legacyUnselected).omittedCriterionIds, ['json']);
assert.throws(() => evaluate(request(['json']), current, legacyUnselected), /JSON Pointer/, 'Selecting an invalid legacy rule still fails explicitly, never treating it as assessed');

const semantic = evaluate(request(['clarity'], [judgment('clarity', 'met', [field('只返回JSON，包含summary字段')])]));
assert.equal(semantic.overall, 'met'); assert.equal(semantic.checks[0].method, 'semantic');
assert.deepEqual(semantic.checks[0].evidence, [field('只返回JSON，包含summary字段')]);
const query = '先只检查格式，不要运行模型。';
const fromQuery = evaluate(request(['clarity'], [judgment('clarity', 'unmet', [{ sourceId: 'query', quote: '只检查格式' }])]), current, business, query);
assert.equal(fromQuery.overall, 'unmet');
assert.equal(evaluate(request(['clarity'], [judgment('clarity', 'uncertain')])).overall, 'uncertain');
const targetedSemantic = { criteria: [{ ...criteria[3], target: { nodeId: 'prompt', fieldId: 'content' } }] };
assert.equal(evaluate(request(['clarity'], [judgment('clarity', 'met', [field('只返回JSON')])]), current, targetedSemantic).overall, 'met');
assert.throws(() => evaluate(request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'query', quote: '只检查格式' }])]), current, targetedSemantic, query), /目标字段/);
assert.throws(() => evaluate(request(['clarity'], [judgment('clarity', 'unmet', [{ sourceId: 'field:result:content', quote: 'summary' }])]), current, targetedSemantic), /目标字段/);
const deletedSemantic: S2Document = { nodes: [], edges: [] };
assert.equal(evaluate(request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'query', quote: '只检查格式' }])]), deletedSemantic, targetedSemantic, query).overall, 'uncertain', 'A real user requirement cannot certify a deleted target');
assert.equal(evaluate(request(['style'], [judgment('style', 'unmet', [], '建议加一个小例子')])).overall, 'advisory');
assert.equal(evaluate(request(['style'])).checks.length, 0);
assert.equal(evaluate(request(['contains', 'style'], [judgment('style', 'unmet')])).overall, 'met', 'Advisory verdicts never enter formal pass/fail');
const optionalUnmet = { criteria: [criteria[0], { ...criteria[3], required: false }] };
assert.equal(evaluate(request(['contains', 'clarity'], [judgment('clarity', 'unmet', [field('只返回JSON')])]), current, optionalUnmet).overall, 'met', 'Selected required formal criteria control overall; optional details remain visible');
const rendered = formatS2Assessment(semantic);
assert.match(rendered, /仅限本次所选/); assert.match(rendered, /不代表整场景完成/); assert.match(rendered, /语义判断/); assert.match(rendered, /未评指标/);
assert.match(S2_ASSESSMENT_RULES, /评价是按本轮语义选择的行动，不要求每轮评价/);
assert.match(S2_ASSESSMENT_RULES, /intent\.evaluation=criteria[\s\S]*必须附assessment/);
assert.match(S2_ASSESSMENT_RULES, /不再要求重复确认是否提交同一评价/);
assert.match(S2_ASSESSMENT_RULES, /evaluation=advice[\s\S]*不输出正式checks/);
assert.match(S2_ASSESSMENT_RULES, /每项指标的解释只能覆盖实际检查范围/);
assert.match(S2_ASSESSMENT_RULES, /不能证明整条记录、其他字段或整个数据集原样保留/);
assert.match(S2_ASSESSMENT_RULES, /不执行插件、不改图、不授权/);

for (const bad of [
  {}, request([]), request(['unknown']), request(['contains', 'contains']), { criterionIds: ['contains'], execute: true },
  { criterionIds: ['contains'], judgments: null }, request(['contains'], [judgment('clarity', 'met', [field('只返回JSON')])]),
  request(['clarity'], [judgment('clarity', 'met')]), request(['clarity'], [judgment('clarity', 'unmet', [field('拼接…JSON')])]),
  request(['clarity'], [judgment('clarity', 'met', [field('')])]), request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'field:gone:content', quote: '存在' }])]),
  request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'query', quote: '没有提供query' }])]),
  request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'reference:answer:content', quote: '示例' }])]),
  request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'artifact:preview', quote: '成功' }])]),
  request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'D:/secret.txt', quote: '内容' }])]),
  request(['clarity'], [judgment('clarity', 'met', [{ sourceId: 'field:prompt:__proto__', quote: '内容' }])]),
  request(['clarity'], [judgment('clarity', 'uncertain'), judgment('clarity', 'uncertain')]),
  request(['clarity'], [{ ...judgment('clarity', 'uncertain'), evidence: [{ ...field('只返回JSON'), grant: true }] }]),
  request(['clarity'], [{ ...judgment('clarity', 'uncertain'), reason: 'x'.repeat(1201) }]),
  { criterionIds: Array(7).fill('contains') }, request(['contains'], Array(7).fill(judgment('contains', 'met'))),
  Object.assign(Object.create({ inheritedAuthority: true }), request(['contains'])),
  JSON.parse('{"criterionIds":["contains"],"__proto__":{"grant":true}}'),
]) assert.throws(() => evaluate(bad), undefined, JSON.stringify(bad));
const sparse = Array(1); assert.throws(() => evaluate({ criterionIds: sparse }));
const getterList = ['contains']; Object.defineProperty(getterList, 0, { get() { assert.fail('Do not evaluate accessors'); } });
assert.throws(() => evaluate({ criterionIds: getterList }), /访问器/);
const getterObject = { criterionIds: ['contains'] }; Object.defineProperty(getterObject, 'judgments', { get() { assert.fail('Do not evaluate accessors'); } });
assert.throws(() => evaluate(getterObject), /访问器/);
for (const rule of [
  { kind: 'json-pointer-equals', pointer: '/__proto__/value', value: 1 },
  { kind: 'json-pointer-equals', pointer: '/constructor/prototype', value: 1 },
  { kind: 'json-pointer-equals', pointer: '/bad~2path', value: 1 },
  { kind: 'json-pointer-equals', pointer: 'file://secret', value: 1 },
  { kind: 'json-pointer-equals', pointer: '/' + 'a'.repeat(500), value: 1 },
  { kind: 'json-pointer-equals', pointer: '/meta', value: JSON.parse('{"__proto__":1}') },
  { kind: 'expression', code: 'fetch("secret")' }, { kind: 'text-includes', value: '', regex: true },
  { kind: 'text-length', min: 3, max: 1 },
  { kind: 'text-includes', value: 'a'.repeat(1001) },
  { kind: 'json-pointer-equals', pointer: '', value: 'a'.repeat(4095) },
]) assert.throws(() => evaluate(request(['json']), current, withCriterion({ rule: rule as any })));
assert.throws(() => evaluate(request(['style']), current, { criteria: [{ ...criteria[4], required: true }] }), /建议/);
assert.equal(JSON.stringify(current), original, 'Assessment cannot edit the canvas or inject execution state');
assert.equal(JSON.stringify(business), originalBusiness, 'Assessment cannot mutate the business package or create authority');
console.log('S2 assessment passed: bounded explicit criteria, host-recomputed local text/JSON rules, genuine current source quotes, uncertain fallback, advisory-only suggestions, selected-only aggregation, malformed/prototype/unknown-field rejection and no mutation/execution. Synthetic offline checks only; no semantic-accuracy or whole-scene completion claim.');
