import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildScienceStage, createAreaModel, createOscillatorModel, sampleOscillatorState } from '../src/services/textbook/teachingModels/science';
import { normalizeFigureHtml } from '../src/services/textbook/interactiveFigure';

const near = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
const midpoint = { expression: 'x^2', variable: 'x', domain: [0, 1], minCount: 2, maxCount: 40, method: 'midpoint', exactIntegral: 1 / 3 };
const left = { expression: 'x', variable: 'x', domain: [-1, 1], minCount: 1, maxCount: 12, method: 'left', exactIntegral: 0 };
const right = { expression: 'sin(t)', variable: 't', domain: [0, Math.PI], minCount: 1, maxCount: 80, method: 'right', exactIntegral: 2 };
for (const frame of createAreaModel(midpoint).frames) {
  near(frame.sum, 1 / 3 - 1 / (12 * frame.count ** 2));
  near(frame.error!, 1 / (12 * frame.count ** 2));
  assert.ok(frame.sum < 1 / 3);
}
for (const frame of createAreaModel(left).frames) near(frame.sum, -2 / frame.count);
const rightModel = createAreaModel(right);
assert.ok(rightModel.frames.at(-1)!.sum > 1.99 && rightModel.frames.at(-1)!.sum < 2);
assert.equal(rightModel.curve.length, 201);
assert.equal(rightModel.frames.at(-1)!.heights.length, 80);
const withoutReference = createAreaModel({ ...left, exactIntegral: undefined });
assert.ok(withoutReference.frames.every(frame => frame.error === null));

const oscillator = { mass: .5, stiffness: 8, amplitude: .1 };
const model = createOscillatorModel(oscillator);
near(model.omega, 4); near(model.period, Math.PI / 2);
for (const [fraction, x, v, F] of [[0, .1, 0, -.8], [.25, 0, -.4, 0], [.5, -.1, 0, .8], [.75, 0, .4, 0], [1, .1, 0, -.8]]) {
  const state = sampleOscillatorState(model, model.period * fraction);
  near(state.displacement, x); near(state.velocity, v); near(state.force, F); near(state.acceleration, F / .5);
}
const phased = createOscillatorModel({ mass: 2, stiffness: 18, amplitude: .3, phase: Math.PI / 2 });
near(phased.omega, 3); near(phased.period, 2 * Math.PI / 3);
near(sampleOscillatorState(phased, 0).velocity, -.9);
near(sampleOscillatorState(phased, phased.period / 4).displacement, -.3);
const zero = createOscillatorModel({ mass: 1, stiffness: 4, amplitude: 0 });
assert.equal(sampleOscillatorState(zero, zero.period / 3).force, 0);

// Execute only the new app-owned controller in a small fake DOM. No generated
// model HTML, browser, Electron, network access or real model is executed here.
function controller(html: string) {
  type Node = { value: string; textContent: string; innerHTML: string; style: Record<string, string>; dataset: Record<string, string>;
    attrs: Record<string, string>; onclick?: () => void; oninput?: () => void; setAttribute: (key: string, value: unknown) => void };
  const node = (): Node => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, attrs: {}, setAttribute(key, value) { this.attrs[key] = String(value); } });
  const nodes = new Map<string, Node>(), fractions = [0.25, .5, .75, 1].map(fraction => { const value = node(); value.dataset.timeFraction = String(fraction); return value; });
  const q = (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector)!; };
  const root = { querySelector: q, querySelectorAll: () => fractions };
  let tick: ((dt: number) => boolean | void) | null = null;
  const clock = { reducedMotion: false, start(fn: (dt: number) => boolean | void) { tick = fn; }, pause() { tick = null; } };
  const listeners: Record<string, () => void> = {};
  const document = { currentScript: { closest: () => root }, hidden: false, addEventListener: (event: string, fn: () => void) => { listeners[event] = fn; } };
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script && html.includes('</script></section>'), 'the script stays inside its stage root');
  runInNewContext(script, { document, window: { TeachingClock: clock } }, { timeout: 1000 });
  return { q, fractions, clock, click: (key: string) => { const target = q(`[data-figure="${key}"]`); assert.ok(target.onclick, `${key} handler exists`); target.onclick(); },
    advance(dt: number, count = 1) { for (let i = 0; i < count; i++) if (tick?.(dt) === false) tick = null; },
    hide() { document.hidden = true; listeners.visibilitychange?.(); },
    running: () => tick !== null };
}

const areaStage = buildScienceStage('area', midpoint, '分割数怎样改变中点矩形和');
assert.equal(normalizeFigureHtml(areaStage.html, 'dynamic'), areaStage.html);
assert.ok(!areaStage.semantics.observation.includes('所有矩形始终在曲线下方'));
const area = controller(areaStage.html);
assert.equal(area.q('[data-count]').textContent, '2');
near(Number(area.q('[data-area]').textContent), .3125, 1e-6);
area.click('play'); area.advance(.05, 10);
assert.equal(area.q('[data-count]').textContent, '5', 'fractional progress accumulates across Clock frames');
area.click('pause'); const count = area.q('[data-count]').textContent; area.advance(.05, 30);
assert.equal(area.q('[data-count]').textContent, count);
area.click('step'); assert.equal(area.q('[data-count]').textContent, '6');
area.click('reset'); assert.equal(area.q('[data-count]').textContent, '2'); assert.ok(!area.running());
area.click('play'); area.advance(.05, 3); area.click('pause'); assert.equal(area.q('[data-count]').textContent, '3');
area.click('step'); assert.equal(area.q('[data-count]').textContent, '4', 'step advances from the visible count after pausing fractional progress');
area.q('[data-figure="time"]').value = '4'; area.q('[data-figure="time"]').oninput!();
assert.equal((area.q('[data-rectangles]').innerHTML.match(/<rect /gu) || []).length, 4);
near(Number(area.q('[data-area]').textContent), .328125, 1e-6);
area.click('play'); area.hide(); assert.ok(!area.running());
const noReference = controller(buildScienceStage('area', { ...left, exactIntegral: undefined }, '无参考值时只观察矩形和').html);
assert.equal(noReference.q('[data-error]').textContent, '未提供参考积分');

const oscillatorStage = buildScienceStage('oscillator', oscillator, '平衡位置处为何仍在运动');
assert.equal(normalizeFigureHtml(oscillatorStage.html, 'dynamic'), oscillatorStage.html);
assert.match(oscillatorStage.html, /<polyline data-spring/u);
assert.ok(!oscillatorStage.html.includes('setInterval') && !oscillatorStage.html.includes('requestAnimationFrame'));
const motion = controller(oscillatorStage.html);
near(Number(motion.q('[data-displacement]').textContent), .1);
motion.fractions[0].onclick!();
near(Number(motion.q('[data-time]').textContent), model.period / 4, 1e-6);
assert.equal(motion.q('[data-displacement]').textContent, '0');
near(Number(motion.q('[data-velocity]').textContent), -.4);
assert.equal(motion.q('[data-force]').textContent, '0');
assert.equal(motion.q('[data-force-arrow]').style.display, 'none');
const velocityArrow = motion.q('[data-velocity-arrow]').attrs;
assert.ok(Number(velocityArrow.x2) < Number(velocityArrow.x1), 'velocity points left at the first equilibrium crossing');
const springEnd = motion.q('[data-spring]').attrs.points.trim().split(/\s+/u).at(-1)!.split(',').map(Number);
near(springEnd[0], Number(motion.q('[data-block]').attrs.x)); near(springEnd[1], 148);
motion.fractions[1].onclick!();
near(Number(motion.q('[data-displacement]').textContent), -.1);
near(Number(motion.q('[data-force]').textContent), .8);
assert.ok(Number(motion.q('[data-force-arrow]').attrs.x2) > Number(motion.q('[data-force-arrow]').attrs.x1));
motion.click('reset'); motion.click('play'); motion.advance(.05, 8); motion.click('pause');
const paused = motion.q('[data-time]').textContent; motion.advance(.05, 20);
assert.equal(motion.q('[data-time]').textContent, paused, 'Clock.start returns no handle; global pause still stops the motion');
motion.click('reset'); motion.advance(.05, 20); assert.equal(motion.q('[data-time]').textContent, '0');
motion.q('[data-figure="time"]').value = '0.38'; motion.q('[data-figure="time"]').oninput!();
assert.ok(Math.abs(Number(motion.q('[data-force]').textContent)) > .04, 'a nearby time is not mislabeled as exact zero');
assert.ok(!motion.q('[data-figure="result"]').textContent.includes('F=0'));
const otherMotion = controller(buildScienceStage('oscillator', { mass: 2, stiffness: 18, amplitude: .3, phase: Math.PI / 2 }, '不同参数保持同一物理模型').html);
near(Number(otherMotion.q('[data-velocity]').textContent), -.9);
otherMotion.fractions[0].onclick!(); near(Number(otherMotion.q('[data-displacement]').textContent), -.3);

for (const bad of [{ ...midpoint, maxCount: 81 }, { ...midpoint, minCount: 1.5 }, { ...midpoint, domain: [1, 0] },
  { ...midpoint, expression: '1/x', domain: [-1, 1] }, { ...midpoint, expression: 'sqrt(x)', domain: [-1, 1] },
  { ...midpoint, expression: 'globalThis.secret' }, { ...midpoint, unexpected: true }]) assert.throws(() => createAreaModel(bad));
for (const bad of [{ ...oscillator, mass: 0 }, { ...oscillator, stiffness: Infinity }, { ...oscillator, amplitude: -1 },
  { ...oscillator, phase: NaN }, { ...oscillator, unexpected: true }]) assert.throws(() => createOscillatorModel(bad));

await mkdir('build', { recursive: true });
const directory = await mkdtemp(path.resolve('build/teaching-science-models-'));
const fixtures = [
  ['area-original', areaStage], ['area-signed-left', buildScienceStage('area', left, '有向面积：左端点取样')],
  ['area-right-80', buildScienceStage('area', right, '正弦函数：80份右端点取样')], ['oscillator-original', oscillatorStage],
  ['oscillator-phased', buildScienceStage('oscillator', { mass: 2, stiffness: 18, amplitude: .3, phase: Math.PI / 2 }, '相位与不同参数')],
] as const;
for (const [name, fixture] of fixtures) {
  assert.ok(fixture.html.length <= 100_000, `${name} stays in the existing attachment budget`);
  await writeFile(path.join(directory, `${name}.html`), fixture.html);
}
await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, realModelRequests: 0, nativeRendered: false,
  fixtures: fixtures.map(([name, fixture]) => ({ name, htmlCharacters: fixture.html.length })), checks: ['independent numeric baselines', 'signed area and absent reference', 'count progress does not round itself away', 'global Clock pause/reset', 'quarter-period signs and zero tolerance', 'connected spring geometry', 'second configurations and phase', 'invalid inputs', '100 KB budget'] }, null, 2));
console.log(`PASS app-owned area/oscillator models, original and alternate parameters, controller playback/pause/reset, semantic boundaries and 100 KB budget; 0 model requests, no native renderer`);
console.log(`Report: ${path.join(directory, 'report.json')}`);
