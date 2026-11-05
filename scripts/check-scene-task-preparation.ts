import assert from 'node:assert/strict';
import type { SceneInteractionDirective, SceneObjectiveEvaluation, SceneQuestionSetEvaluation } from '../src/types';
import { prepareSceneInteractionTask, type SceneTaskPreparationInput } from '../src/services/scene/sceneTaskPreparation';
import { normalizeSceneInteractionDirective, normalizeSceneInteractionResponse, gradeQuestionSetResponse } from '../src/services/scene/sceneInteraction';
import { gradeSceneObjectiveResponse } from '../src/services/scene/sceneAssessment';
import { getSceneInteractionComponentV2, buildSceneInteractionComponentV2Prompt, validateSceneInteractionComponentV2Registry } from '../src/services/scene/sceneInteractionComponentV2';
import { getSceneCapability, buildUnifiedSceneCapabilityPrompt } from '../src/services/scene/sceneCapabilityRegistry';

const options = [{ id: 'even', label: '6' }, { id: 'odd1', label: '3' }, { id: 'odd2', label: '5' }, { id: 'odd3', label: '7' }];
const choice: SceneInteractionDirective = { id: 'q1', type: 'single-choice', required: true, assessment: 'objective', options };
const key: SceneObjectiveEvaluation = { interactionId: 'q1', type: 'single-choice', correctId: 'even', explanation: '6能被2整除。' };
const base: SceneTaskPreparationInput = { content: '哪个数是偶数？', interaction: choice, objectiveEvaluation: key };
let samples = 0;
const prepared = prepareSceneInteractionTask(base, { random: () => { samples += 1; return 0; } });
assert.equal(prepared.interaction.type, 'single-choice');
if (prepared.interaction.type !== 'single-choice') throw new Error('choice fixture');
assert.deepEqual(prepared.interaction.options.map(option => option.id), ['odd1', 'odd2', 'odd3', 'even']);
assert.deepEqual(choice.options.map(option => option.id), ['even', 'odd1', 'odd2', 'odd3'], 'source not mutated');
assert.deepEqual(prepared.objectiveEvaluation, key, 'answer IDs and explanation stay unchanged');
const response = normalizeSceneInteractionResponse({ interactionId: 'q1', type: 'single-choice', selectedId: 'even' }, prepared.interaction)!;
assert.equal(gradeSceneObjectiveResponse(response, prepared.objectiveEvaluation)?.correct, true);
assert.equal(samples, 3);
const variables = prepareSceneInteractionTask({ ...base,
  content: 'A student compares mathematical variables A and B. 计算 a/b，A和B表示两个变量。',
  objectiveEvaluation: { ...key, explanation: 'A and B are independent variables, and a/b is their ratio.' },
}, { random: () => 0 });
assert.equal(variables.interactionPreparation.orders[0].mode, 'shuffled', 'articles and math variables are not option references');
const saved = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
assert.deepEqual(prepareSceneInteractionTask(saved, { random: () => assert.fail('saved replay cannot consume randomness') }), saved);
assert.deepEqual(prepareSceneInteractionTask({ ...base, interactionPreparation: saved.interactionPreparation }, { random: () => assert.fail('original replay cannot consume randomness') }), saved);
assert.throws(() => prepareSceneInteractionTask({ ...saved, content: 'changed question' }), /另一道题/);
const corrupt = structuredClone(saved);
corrupt.interactionPreparation.orders[0].ids.reverse();
assert.throws(() => prepareSceneInteractionTask(corrupt), /损坏/);

const multi: SceneInteractionDirective = { ...choice, id: 'multi1', type: 'multiple-choice', minSelections: 2, options };
const multiKey: SceneObjectiveEvaluation = { interactionId: 'multi1', type: 'multiple-choice', correctIds: ['even', 'odd2'], explanation: '选择两个指定数字。' };
const multiPrepared = prepareSceneInteractionTask({ content: '选择6和5。', interaction: multi, objectiveEvaluation: multiKey }, { random: () => 0 });
assert.equal(multiPrepared.interaction.type, 'multiple-choice');
const multiResponse = normalizeSceneInteractionResponse({ interactionId: 'multi1', type: 'multiple-choice', selectedIds: ['odd2', 'even'] }, multiPrepared.interaction)!;
assert.equal(gradeSceneObjectiveResponse(multiResponse, multiPrepared.objectiveEvaluation)?.correct, true);
assert.deepEqual(multiPrepared.objectiveEvaluation.correctIds, ['even', 'odd2']);

for (const change of [
  { interaction: { ...choice, assessment: 'none' as const, orderPolicy: { mode: 'shuffle' as const } }, objectiveEvaluation: undefined },
  { interaction: { ...choice, orderPolicy: { mode: 'preserve' as const, reason: 'ordered-scale' as const } } },
  { content: '请比较选项A与其他选项。' },
  { objectiveEvaluation: { ...key, explanation: '正确答案是 A。' } },
  { objectiveEvaluation: { ...key, explanation: 'B正确，因为它满足条件。' } },
  { objectiveEvaluation: { ...key, explanation: '正确的是 B。' } },
  { interaction: { ...choice, assessment: undefined }, objectiveEvaluation: undefined },
  { interaction: { ...choice, options: [{ id: 't', label: '正确' }, { id: 'f', label: '错误' }] } },
  { interaction: { ...choice, options: options.map((option, index) => ({ ...option, label: `${String.fromCharCode(65 + index)}. ${option.label}` })) } },
  { interaction: { ...choice, options: [{ id: 'x', label: '第一个选项' }, { id: 'y', label: '以上都不是' }] } },
]) {
  const source = { ...base, ...change };
  const preserved = prepareSceneInteractionTask(source, { random: () => assert.fail('semantic preserve-order exception') });
  assert.deepEqual(preserved.interaction, source.interaction);
  assert.equal(preserved.interactionPreparation.orders[0].mode, 'preserved');
}

const ordering: SceneInteractionDirective = { id: 'ord', type: 'ordering', required: true, assessment: 'objective',
  items: [{ id: 'one', content: '准备' }, { id: 'two', content: '执行' }, { id: 'three', content: '收尾' }] };
const orderingKey: SceneObjectiveEvaluation = { interactionId: 'ord', type: 'ordering', correctOrderIds: ['one', 'two', 'three'], explanation: '先准备，再执行，最后收尾。' };
const orderingPrepared = prepareSceneInteractionTask({ content: '将流程按正确顺序排列。', interaction: ordering, objectiveEvaluation: orderingKey }, { random: () => 0.999 });
assert.equal(orderingPrepared.interaction.type, 'ordering');
if (orderingPrepared.interaction.type !== 'ordering') throw new Error('ordering fixture');
assert.notDeepEqual(orderingPrepared.interaction.items.map(item => item.id), orderingKey.correctOrderIds, 'even identity RNG cannot expose solved unique order');
assert.deepEqual(orderingPrepared.objectiveEvaluation, orderingKey, 'target not mutated');
const orderingResponse = normalizeSceneInteractionResponse({ interactionId: 'ord', type: 'ordering', orderedIds: ['one', 'two', 'three'] }, orderingPrepared.interaction)!;
assert.equal(gradeSceneObjectiveResponse(orderingResponse, orderingKey)?.correct, true);
const legacyOrdering = { ...ordering, assessment: undefined };
const legacyPrepared = prepareSceneInteractionTask({ content: '排列', interaction: legacyOrdering }, { random: () => 0.999 });
assert.deepEqual(legacyPrepared.interaction.items, ordering.items, 'legacy unknown target is not guessed from source order');
assert.throws(() => prepareSceneInteractionTask({ content: '排列', interaction: ordering, orderingTargetIds: ['one', 'one', 'three'] }), /私有目标/);
assert.deepEqual(prepareSceneInteractionTask({ content: '排列', interaction: { ...ordering, orderPolicy: { mode: 'preserve', reason: 'ordered-instruction' } } }, { random: () => assert.fail('ordered instruction') }).interaction.items, ordering.items);

const group: SceneInteractionDirective = { id: 'set1', type: 'question-set', required: true, submissionMode: 'batch', feedbackMode: 'after-submit', items: [
  { id: 'c1', type: 'single-choice', required: true, content: '选偶数。', options },
  { id: 'm1', type: 'multiple-choice', required: true, content: '选6和5。', options, minSelections: 2 },
  { id: 'tf1', type: 'true-false', required: true, content: '6是偶数。' },
] };
const groupKey: SceneQuestionSetEvaluation = { interactionId: 'set1', type: 'question-set', items: [
  { itemId: 'c1', type: 'single-choice', correctId: 'even', explanation: '6能被2整除。' },
  { itemId: 'm1', type: 'multiple-choice', correctIds: ['even', 'odd2'] },
  { itemId: 'tf1', type: 'true-false', correctValue: true },
] };
const groupPrepared = prepareSceneInteractionTask({ content: '完成这组题。', interaction: group, interactionEvaluation: groupKey }, { random: () => 0 });
assert.equal(groupPrepared.interactionPreparation.orders.length, 2, 'only registered choice children are randomized');
if (groupPrepared.interaction.type !== 'question-set') throw new Error('group fixture');
assert.deepEqual(groupPrepared.interaction.items.map(item => item.id), ['c1', 'm1', 'tf1'], 'question order unchanged');
assert.deepEqual(groupPrepared.interaction.items[2], group.items[2], 'true/false unchanged');
assert.deepEqual(groupPrepared.interactionEvaluation, groupKey);
const groupResponse = normalizeSceneInteractionResponse({ interactionId: 'set1', type: 'question-set', answers: [
  { itemId: 'c1', type: 'single-choice', selectedId: 'even' },
  { itemId: 'm1', type: 'multiple-choice', selectedIds: ['odd2', 'even'] },
  { itemId: 'tf1', type: 'true-false', value: true },
] }, groupPrepared.interaction)!;
assert.equal(gradeQuestionSetResponse(groupResponse, groupPrepared.interactionEvaluation)?.correct, 3);
assert.deepEqual(prepareSceneInteractionTask(JSON.parse(JSON.stringify(groupPrepared)), { random: () => assert.fail('group replay') }), groupPrepared);

const protocol = { version: '1.0' as const, allowedTypes: ['single-choice', 'multiple-choice', 'ordering', 'question-set'] as const, defaultType: 'single-choice' as const, allowTextFallback: false };
const normalized = normalizeSceneInteractionDirective({ ...ordering, orderPolicy: { mode: 'preserve', reason: 'position-dependent' } }, { ...protocol, allowedTypes: [...protocol.allowedTypes] });
assert.equal(normalized?.type, 'ordering');
if (normalized?.type !== 'ordering') throw new Error('normalization fixture');
assert.equal(normalized.assessment, 'objective');
assert.deepEqual(normalized.orderPolicy, { mode: 'preserve', reason: 'position-dependent' });
assert.equal(normalizeSceneInteractionDirective({ ...choice, orderPolicy: { mode: ['preserve'] } }, { ...protocol, allowedTypes: [...protocol.allowedTypes] }), undefined);
assert.equal(normalizeSceneInteractionDirective({ ...choice, orderPolicy: { mode: 'preserve', reason: 'arbitrary-code' } }, { ...protocol, allowedTypes: [...protocol.allowedTypes] }), undefined);

// Deterministic sampling tests the algorithm without flakiness or claiming a live-model result.
let seed = 0x12345678;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
const positions = [0, 0, 0, 0];
const patterns = new Set<string>();
for (let i = 0; i < 4000; i += 1) {
  const next = prepareSceneInteractionTask({ ...base, interaction: { ...choice, id: `q-${i}` } }, { random });
  if (next.interaction.type !== 'single-choice') throw new Error('distribution fixture');
  positions[next.interaction.options.findIndex(option => option.id === 'even')] += 1;
  patterns.add(next.interaction.options.map(option => option.id).join(','));
}
assert.ok(positions.every(count => count > 750 && count < 1250), `no fixed-position bias: ${positions}`);
assert.equal(patterns.size, 24, 'not a fixed ABCD rotation');
assert.deepEqual(validateSceneInteractionComponentV2Registry(), []);
assert.equal(getSceneInteractionComponentV2('single-choice')?.preparation?.randomization, 'objective-options');
assert.equal(getSceneCapability('single-choice')?.taskPreparation, 'shuffle-objective-options-once');
assert.match(buildUnifiedSceneCapabilityPrompt('turn'), /shuffle-objective-options-once/);
assert.match(buildSceneInteractionComponentV2Prompt(), /一次性洗牌/);
console.log(`Scene task preparation checks passed (single/multiple/order/group; replay; preserve exceptions; position bins ${positions.join('/')}).`);
