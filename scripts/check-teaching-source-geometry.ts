/** Geometry provenance adapter checks; synthetic data, no models or browser. */
import assert from 'node:assert/strict';
import { sourceGroupingConfig, buildTeachingModel } from '../src/services/textbook/teachingModelProtocol';
import { normalizeGroupingConfig, groupingObservation } from '../src/services/textbook/teachingModels/observation';
import { INTERACTIVE_DISCIPLINE_CASES } from './fixtures/interactive-purpose-disciplines';

const source = INTERACTIVE_DISCIPLINE_CASES.find(item => item.id === 'psychology-grouping-contrast')!;
const original = { positions: [60, 100, 140, 140, 180, 220], colors: ['green', 'red', 'green', 'red', 'green', 'red'],
  gapIndex: 3, gapRange: [40, 160], initialGap: 40, threshold: 60 };
const expected = [60, 100, 140, 180, 220, 260];
const snapshot = structuredClone(original);
const normalized = normalizeGroupingConfig(sourceGroupingConfig(original, source.lesson));
assert.deepEqual(normalized.positions, expected, 'zero-offset coordinates substitute the explicit initial gap');
assert.deepEqual(original, snapshot, 'source configuration is not mutated');
const alreadySubstituted = { ...original, positions: expected };
assert.deepEqual(sourceGroupingConfig(alreadySubstituted, source.lesson), alreadySubstituted, 'actual initial coordinates retain their values');
assert.deepEqual(groupingObservation(normalized, 160).positions, [60, 100, 140, 300, 340, 380]);
assert.deepEqual(groupingObservation(normalized, 60).proximity, [[0, 1, 2, 3, 4, 5]]);
assert.deepEqual(groupingObservation(normalized, 61).proximity, [[0, 1, 2], [3, 4, 5]]);

// The source variable is not hard-coded to g, and constant coordinates are valid.
const hBasis = '合成点位置为 [10,30,30+h,50+h]，20≤h≤100，初始间距 h=20，接近阈值为25。';
const hConfig = { positions: [10, 30, 30, 50], colors: ['a', 'b', 'a', 'b'], gapIndex: 2, gapRange: [20, 100], initialGap: 20, threshold: 25 };
const hNormalized = normalizeGroupingConfig(sourceGroupingConfig(hConfig, hBasis));
assert.deepEqual(hNormalized.positions, [10, 30, 50, 70]);
assert.deepEqual(groupingObservation(hNormalized, 100).positions, [10, 30, 130, 150]);
const numericBasis = '合成横坐标为 [5,15,35,45]，初始间距20，允许间距20到50，接近阈值12。';
const numericConfig = { positions: [5, 15, 35, 45], colors: ['a', 'a', 'b', 'b'], gapIndex: 2, gapRange: [20, 50], initialGap: 20, threshold: 12 };
assert.deepEqual(normalizeGroupingConfig(sourceGroupingConfig(numericConfig, numericBasis)).positions, numericConfig.positions);

// An arbitrary error must never be treated as an omitted initial-gap substitution.
const wrong = { ...original, positions: [60, 100, 140, 180, 221, 261] };
assert.throws(() => sourceGroupingConfig(wrong, source.lesson), /与原文给定的位置关系不一致/u);
assert.deepEqual(wrong.positions, [60, 100, 140, 180, 221, 261]);
assert.throws(() => sourceGroupingConfig({ ...hConfig, positions: [10, 30, 40, 60] }, hBasis), /与原文给定的位置关系不一致/u);
assert.throws(() => sourceGroupingConfig(hConfig, '点位置 [10,30,30+h,50+g]。'), /多个未知变量/u);
assert.throws(() => sourceGroupingConfig(hConfig, '点位置 [10,30,30+h]。'), /坐标表达式不明确/u);

// Multiple explicit lists and missing coordinate context stay untouched, rather
// than picking whichever happens to make a proposed configuration work.
const ambiguousBasis = '横坐标 [60,100,140,140+g,180+g,220+g]；另一个点位置 [10,20,30,30+g,40+g,50+g]。';
assert.equal(sourceGroupingConfig(original, ambiguousBasis), original, 'multiple lists do not guess a source geometry');
assert.deepEqual(original, snapshot);
assert.equal(sourceGroupingConfig(original, '列表 [60,100,140,140+g,180+g,220+g] 只是未指定用途的数字。'), original);
assert.equal(sourceGroupingConfig(original, '这里没有坐标列表。'), original);
assert.throws(() => normalizeGroupingConfig(sourceGroupingConfig(original, ambiguousBasis)), /严格递增/u, 'unresolved zero-offset coordinates do not silently become executable');

// The actual model builder normalizes before geometry validation and preserves
// provenance, while still refusing an unrelated arbitrary position mismatch.
const candidate = { title: source.title, basis: source.lesson, design: { anchor: source.lesson.slice(0, source.lesson.indexOf('。') + 1), goal: source.objective },
  component: { type: 'grouping', config: original } };
const built = buildTeachingModel(candidate, 'grouping', source.lesson);
assert.ok(built.html.includes('data-teaching-stage="point-grouping"'));
assert.ok(built.html.includes('"positions":[60,100,140,180,220,260]'));
assert.deepEqual(original, snapshot);
assert.throws(() => buildTeachingModel({ ...candidate, component: { type: 'grouping', config: wrong } }, 'grouping', source.lesson), /与原文给定的位置关系不一致/u);
console.log('PASS source geometry: zero-offset normalization, substituted/numeric coordinates, alternate variable, no arbitrary correction, no multi-list guessing and actual builder provenance; 0 model requests');
