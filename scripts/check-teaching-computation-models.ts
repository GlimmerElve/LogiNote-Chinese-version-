/** Pure-model and optional offline-browser acceptance; no model or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { parseLruStageConfig, lruStageFrames, parseKnapsackStageConfig, knapsackStageFrames,
  parseAttentionStageConfig, attentionStageFrames, buildComputationStage } from '../src/services/textbook/teachingModels/computation';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Computation acceptance must not access network or models');
const root = await fs.mkdtemp(path.resolve('build/teaching-computation-'));
const report: any = { root, status: 'running', modelRequests: 0, networkRequests: 0, checks: [], browser: [] };
const lruCases = [
  { config: { capacity: 3, initial: ['A', 'B', 'C'], accesses: ['B', 'D', 'A', 'C'] }, expected: [['A', 'B', 'C'], ['B', 'A', 'C'], ['D', 'B', 'A'], ['A', 'D', 'B'], ['C', 'A', 'D']] },
  { config: { capacity: 2, initial: ['X'], accesses: ['Y', 'X', 'Z'] }, expected: [['X'], ['Y', 'X'], ['X', 'Y'], ['Z', 'X']] },
  { config: { capacity: 1, initial: [] as string[], accesses: ['P', 'P', 'Q'] }, expected: [[], ['P'], ['P'], ['Q']] },
];
const knapsackCases = [
  { config: { capacity: 4, items: [{ weight: 1, value: 15 }, { weight: 3, value: 20 }, { weight: 4, value: 30 }] }, expected: [0, 15, 15, 20, 35] },
  { config: { capacity: 5, items: [{ weight: 2, value: 3 }, { weight: 3, value: 4 }, { weight: 4, value: 5 }] }, expected: [0, 0, 3, 4, 5, 7] },
  { config: { capacity: 3, items: [{ weight: 1, value: 0 }, { weight: 5, value: 99 }, { weight: 2, value: 6 }] }, expected: [0, 0, 6, 6] },
];
const attentionCases = [
  { queries: [[1, 0], [0, 1]], keys: [[1, 0], [0, 1], [1, 1]], values: [[1, 0], [0, 2], [2, 1]] },
  { queries: [[1], [0]], keys: [[0], [1]], values: [[2], [4]] },
  { queries: [[1, -1], [0, 0]], keys: [[2, 1], [-1, 0]], values: [[3, -2], [1, 5]] },
];
const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${label}: ${actual} versus ${expected}`);
let browser: any;
try {
  for (const { config, expected } of lruCases) {
    const original = structuredClone(config), parsed = parseLruStageConfig(config), frames = lruStageFrames(parsed);
    assert.deepEqual(frames.map(frame => frame.after), expected); assert.deepEqual(config, original);
    for (let i = 1; i < frames.length; i++) {
      assert.deepEqual(frames[i].before, frames[i - 1].after); assert.equal(frames[i].after[0], config.accesses[i - 1]);
      assert.ok(frames[i].after.length <= config.capacity); assert.equal(new Set(frames[i].after).size, frames[i].after.length);
    }
  }
  assert.equal(lruStageFrames(parseLruStageConfig(lruCases[0].config))[2].evicted, 'C');
  assert.equal(lruStageFrames(parseLruStageConfig(lruCases[0].config))[4].evicted, 'B');
  assert.throws(() => parseLruStageConfig({ capacity: 0, initial: [], accesses: [] }));
  assert.throws(() => parseLruStageConfig({ capacity: 31, initial: [], accesses: [] }));
  assert.throws(() => parseLruStageConfig({ capacity: 2, initial: ['A', 'A'], accesses: [] }));
  report.checks.push('LRU三组数据：初始最近优先、更新后再显示、命中移动、容量与淘汰对象正确，输入不被修改');

  for (const { config, expected } of knapsackCases) {
    const frames = knapsackStageFrames(parseKnapsackStageConfig(config));
    assert.deepEqual(frames.at(-1)!.after, expected);
    for (let i = 1; i < frames.length; i++) {
      const frame = frames[i]; assert.deepEqual(frame.before, frames[i - 1].after);
      if (frame.phase === 'candidate') { assert.deepEqual(frame.after, frame.before); assert.equal(frame.after[frame.capacityIndex!], frame.oldValue); }
      if (frame.phase === 'committed') { assert.equal(frame.after[frame.capacityIndex!], Math.max(frame.oldValue!, frame.takeValue!)); assert.equal(frames[i - 1].phase, 'candidate'); }
    }
    // Independent subset enumeration verifies every capacity, not the DP recurrence.
    for (let capacity = 0; capacity <= config.capacity; capacity++) {
      let expectedBest = 0;
      for (let mask = 0; mask < 1 << config.items.length; mask++) {
        let weight = 0, value = 0;
        config.items.forEach((item, index) => { if (mask & 1 << index) { weight += item.weight; value += item.value; } });
        if (weight <= capacity) expectedBest = Math.max(expectedBest, value);
      }
      assert.equal(frames.at(-1)!.after[capacity], expectedBest);
    }
  }
  assert.deepEqual(knapsackStageFrames(knapsackCases[0].config).at(-1)!.bestItems, [1, 2]);
  assert.ok(knapsackStageFrames(knapsackCases[2].config).some(frame => frame.phase === 'skipped'));
  assert.throws(() => parseKnapsackStageConfig({ capacity: 31, items: [] }));
  assert.throws(() => parseKnapsackStageConfig({ capacity: 4, items: [{ weight: 0, value: 1 }] }));
  assert.throws(() => parseKnapsackStageConfig({ capacity: 4, items: [{ weight: 1, value: -1 }] }));
  report.checks.push('0/1背包三组数据与独立子集枚举一致；候选不提前写入，提交后才变更，过重物品跳过，取物品来源为旧行');

  for (const config of attentionCases) {
    const parsed = parseAttentionStageConfig(config);
    for (let queryIndex = 0; queryIndex < config.queries.length; queryIndex++) {
      const frames = attentionStageFrames(parsed, queryIndex);
      assert.equal(frames[0].scores, null); assert.equal(frames[0].weights, null); assert.equal(frames[0].output, null);
      assert.equal(frames[1].weights, null); assert.equal(frames[1].output, null); assert.equal(frames[2].output, null);
      const last = frames[3]; close(last.weights!.reduce((sum, value) => sum + value, 0), 1, 'weights sum');
      assert.ok(last.weights!.every(value => value > 0));
      config.values[0].forEach((_, column) => close(last.output![column], config.values.reduce((sum, row, index) => sum + last.weights![index] * row[column], 0), 'weighted V output'));
      const shifted = { ...parsed, keys: parsed.keys.map(row => row.map(value => value + 10)) };
      attentionStageFrames(shifted, queryIndex)[3].weights!.forEach((weight, i) => close(weight, last.weights![i], 'softmax common-shift invariance'));
    }
  }
  const p = Math.exp(1 / Math.sqrt(2)), denominator = 2 * p + 1;
  const mainAttention = attentionStageFrames(attentionCases[0])[3];
  mainAttention.weights!.forEach((weight, i) => close(weight, (i === 1 ? 1 : p) / denominator, 'source attention weight'));
  close(mainAttention.output![0], 3 * p / denominator, 'source output 0'); close(mainAttention.output![1], (p + 2) / denominator, 'source output 1');
  assert.throws(() => parseAttentionStageConfig({ queries: [[1]], keys: [[1, 2]], values: [[1]] }));
  assert.throws(() => parseAttentionStageConfig({ queries: [[1]], keys: [[1], [2]], values: [[1]] }));
  assert.throws(() => parseAttentionStageConfig({ queries: [[NaN]], keys: [[1]], values: [[1]] }));
  assert.throws(() => attentionStageFrames(attentionCases[0], 2));
  report.checks.push('单头attention三组矩阵：分阶段披露、缩放点积、稳定softmax、加权V与共同平移不变性；查询维度和边界校验');

  const htmls = [
    ...lruCases.map(({ config }, i) => ({ type: 'lru' as const, name: 'lru-' + i, config })),
    ...knapsackCases.map(({ config }, i) => ({ type: 'knapsack' as const, name: 'knapsack-' + i, config })),
    ...attentionCases.map((config, i) => ({ type: 'attention' as const, name: 'attention-' + i, config })),
  ].map(sample => ({ ...sample, built: buildComputationStage(sample.type, sample.config, '本地计算教学验收') }));
  for (const item of htmls) {
    assert.ok(item.built.html.length < 100_000); assert.ok(item.built.html.includes('data-figure-mode="step"'));
    assert.ok(!/data-figure="(?:prediction|check)"/u.test(item.built.html));
    assert.ok(Object.values(item.built.semantics).every(text => text.length > 10));
  }
  const hostile = buildComputationStage('lru', { capacity: 1, initial: ['</script><img>'], accesses: ['<b>'] }, '</script><svg>');
  assert.ok(!hostile.html.includes('</script><img>')); assert.ok(!hostile.html.includes('<h2></script>'));
  const largest = buildComputationStage('knapsack', { capacity: 30, items: Array.from({ length: 12 }, () => ({ weight: 1, value: 1_000_000 })) }, '边界数据');
  assert.ok(largest.html.length < 100_000, 'Only config, not all generated frames, is serialized into HTML');
  report.checks.push('本地HTML无预测表单，配置与标题安全转义，合理上限的HTML仍小于附件100KB上限，不序列化冗长全帧数组');

  if (process.argv.includes('--browser')) {
    const { chromium } = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/teaching-model-test.cjs'))('playwright');
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    for (const sample of htmls) {
      const page = await browser.newPage({ viewport: { width: 900, height: 780 } }), errors: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route(/^https?:/u, (route: any) => { report.networkRequests++; return route.abort(); });
      await page.setContent(sample.built.html);
      const stage = page.locator('[data-teaching-stage]'), step = stage.locator('[data-figure="step"]');
      const initial = await stage.locator('[data-figure="visual"]').innerHTML();
      if (sample.type === 'attention') {
        const expected = attentionStageFrames(sample.config as any);
        const numbers = (selector: string, attribute: string) => stage.locator(selector).evaluateAll((nodes: Element[], attr: string) => nodes.map(node => Number(node.getAttribute(attr))), attribute);
        assert.equal(await stage.locator('[data-weight],[data-output]').count(), 0, 'No initial answer leakage');
        await step.click(); assert.equal(await stage.locator('[data-weight],[data-output]').count(), 0, 'Scores do not reveal later stages');
        assert.deepEqual(await numbers('[data-attention-score]', 'data-attention-score'), expected[1].scores);
        await step.click(); assert.ok(await stage.locator('[data-weight]').count() > 0); assert.equal(await stage.locator('[data-output]').count(), 0);
        assert.deepEqual(await numbers('[data-weight]', 'data-weight'), expected[2].weights);
        await step.click(); assert.ok(await stage.locator('[data-output]').count() > 0);
        assert.deepEqual(await numbers('[data-output]', 'data-output'), expected[3].output);
        await stage.locator('[data-attention-query]').selectOption('1');
        assert.equal(await stage.getAttribute('data-model-step'), '0'); assert.equal(await stage.locator('[data-weight],[data-output]').count(), 0);
        await step.click(); await step.click(); await step.click();
        assert.deepEqual(await numbers('[data-output]', 'data-output'), attentionStageFrames(sample.config as any, 1)[3].output);
      } else {
        const frames = sample.type === 'lru' ? lruStageFrames(sample.config as any) : knapsackStageFrames(sample.config as any);
        for (let i = 1; i < frames.length; i++) {
          await step.click();
          assert.equal(await stage.getAttribute('data-model-step'), String(i));
          if (sample.type === 'lru') assert.deepEqual(await stage.locator('[data-cache-item]').evaluateAll((nodes: Element[]) => nodes.map(node => node.getAttribute('data-cache-item'))), (frames[i] as any).after);
          else assert.deepEqual(await stage.locator('[data-dp-index]').evaluateAll((nodes: Element[]) => nodes.map(node => Number(node.getAttribute('data-dp-value')))), (frames[i] as any).after);
        }
        assert.equal(await step.isDisabled(), true);
      }
      await stage.locator('[data-figure="reset"]').click();
      assert.equal(await stage.getAttribute('data-model-step'), '0');
      assert.equal(await stage.locator('[data-figure="visual"]').innerHTML(), initial);
      if (sample.name.endsWith('-0')) await page.screenshot({ path: path.join(root, sample.type + '.png'), fullPage: true });
      await page.setViewportSize({ width: 360, height: 780 });
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No narrow-screen overflow');
      assert.deepEqual(errors, []);
      report.browser.push({ name: sample.name, status: 'passed', stateFromSameModel: true, fullReset: true, narrowDark: true });
      await page.close();
    }
    assert.equal(report.networkRequests, 0);
  }
  report.status = 'passed';
} finally {
  await browser?.close(); globalThis.fetch = originalFetch;
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
