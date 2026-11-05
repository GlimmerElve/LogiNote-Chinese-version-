import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectReviewProgressiveExperiment, runReviewProgressiveExperiment } from './run-review-progressive-experiment.ts';
import { REVIEW_PROGRESSIVE_DATASET, REVIEW_PROGRESSIVE_DATASET_VERSION } from './review-progressive-dataset.ts';
import { REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION } from './review-progressive-acceptance-dataset.ts';

// OFFLINE runner-scope checks, not model evaluation or authorization to send
// either dataset. No --local/--execute run, provider settings, vault or artifacts.
let checks = 0;
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };

const original = selectReviewProgressiveExperiment([]);
assert.equal(original.dataset, REVIEW_PROGRESSIVE_DATASET);
assert.equal(original.datasetVersion, REVIEW_PROGRESSIVE_DATASET_VERSION);
assert.equal(original.datasetSelection, 'original-v1');
assert.equal(original.dataset.length, 12); assert.equal(original.maxRequests, 24);
assert.equal(original.execute, false); assert.equal(original.local, false);
pass('无参数仍选择旧12题/24请求上限，且仅预检');

const acceptance = selectReviewProgressiveExperiment(['--acceptance-v3']);
assert.equal(acceptance.dataset, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET);
assert.equal(acceptance.datasetVersion, REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION);
assert.equal(acceptance.datasetSelection, 'acceptance-v3');
assert.equal(acceptance.dataset.length, 8); assert.equal(acceptance.maxRequests, 16);
assert.equal(acceptance.execute, false); assert.equal(acceptance.local, false);
assert.ok(acceptance.dataset.every(c => c.origin === 'synthetic' && c.annotationStatus === 'assistant_draft'));
assert.equal(acceptance.dataset.flatMap(c => c.expected.frames.flatMap(f => f.items)).length, 19);
assert.ok(!acceptance.dataset.some(c => original.dataset.some(old => old.id === c.id)));
pass('新验收旗标固定独立8题/19项/16请求上限，不是发送授权');

for (const selected of [original, acceptance]) {
  const summary = selected.summarize([]);
  assert.equal(summary.datasetVersion, selected.datasetVersion);
  assert.equal(summary.expectedCases, selected.dataset.length);
  assert.equal(summary.observedCases, 0); assert.equal(summary.uniqueCases, 0);
  assert.deepEqual(summary.missingCaseIds, selected.dataset.map(c => c.id));
  assert.equal(summary.allCasesPass, false);
  assert.deepEqual(summary.metrics.endToEnd, { matched: 0, total: 0 });
  assert.equal(summary.humanGold, false); assert.equal(summary.semanticTruth, 'not_certified');
  assert.equal(summary.scoreWrite, 'disabled'); assert.equal(summary.cognitionWrite, 'disabled');
}
pass('各自报告采用12/8固定预期，不把预检当实测或把新题混入旧分母');

const permutations = (values: readonly string[]): string[][] => values.length === 0 ? [[]]
  : values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]));
for (const flag of [[], ['--acceptance-v3']]) {
  for (const mode of [[], ['--local'], ['--execute', '--allow-cloud']]) {
    for (const args of permutations([...flag, ...mode])) {
      const selected = selectReviewProgressiveExperiment(args);
      assert.equal(selected.execute, mode.includes('--execute'));
      assert.equal(selected.local, mode.includes('--local'));
      assert.equal(selected.dataset, flag.length ? acceptance.dataset : original.dataset);
      assert.equal(selected.maxRequests, flag.length ? 16 : 24);
    }
  }
}
pass('合法旗标顺序不改选题与预算，云模式必须execute/allow-cloud成对');

const invalidFlags = [
  ['--execute'], ['--allow-cloud'], ['--local', '--allow-cloud'], ['--local', '--execute'],
  ['--execute', '--allow-cloud', '--local'], ['--acceptance-v3', '--execute'],
  ['--acceptance-v3', '--allow-cloud'], ['--acceptance-v3', '--execute', '--allow-cloud', '--local'],
  ['--acceptance-v3', '--acceptance-v3'], ['--local', '--local'], ['--execute', '--allow-cloud', '--execute'],
  ['--unknown'], ['--cases=8'], ['--dataset', 'arbitrary-file.json'], ['--acceptance-v3=true'],
];
for (const args of invalidFlags) assert.throws(() => selectReviewProgressiveExperiment(args), /invalid_flags/u);
pass('拒绝重复、未知、自定义文件/题量、缺少授权旗标和local/cloud互斥组合');

const oldReadFile = fs.readFile, oldLstat = fs.lstat, oldOpen = fs.open;
const oldMkdir = fs.mkdir, oldMkdtemp = fs.mkdtemp, oldWriteFile = fs.writeFile;
const oldHome = os.homedir, oldFetch = globalThis.fetch, oldLog = console.log;
const browserNames = ['window', 'localStorage'] as const;
const browserDescriptors = browserNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
let sourceReads = 0, forbiddenCalls = 0;
const reject = (kind: string): never => { forbiddenCalls++; return assert.fail(`offline_runner_${kind}_forbidden`); };
const logs: string[] = [];
try {
  fs.readFile = (async (filename: any, ...rest: any[]) => {
    assert.equal(typeof filename, 'string');
    const resolved = path.resolve(filename), project = process.cwd();
    const relative = path.relative(project, resolved).replace(/\\/gu, '/');
    assert.ok(/^(src|scripts)\/.+\.(ts|tsx)$/u.test(relative), 'preflight_must_read_code_only');
    sourceReads++;
    return (oldReadFile as any)(filename, ...rest);
  }) as typeof fs.readFile;
  fs.lstat = (async () => reject('private_stat')) as typeof fs.lstat;
  fs.open = (async () => reject('private_open')) as typeof fs.open;
  fs.mkdir = (async () => reject('artifact_mkdir')) as typeof fs.mkdir;
  fs.mkdtemp = (async () => reject('artifact_mkdtemp')) as typeof fs.mkdtemp;
  fs.writeFile = (async () => reject('artifact_write')) as typeof fs.writeFile;
  os.homedir = () => reject('private_home');
  globalThis.fetch = async () => reject('network');
  for (const name of browserNames) Object.defineProperty(globalThis, name, { configurable: true,
    get: () => reject('browser_state') });
  console.log = (...values: unknown[]) => { assert.equal(values.length, 1); logs.push(String(values[0])); };

  for (const args of [[], ['--acceptance-v3']]) {
    const before = sourceReads;
    await runReviewProgressiveExperiment(args);
    assert.ok(sourceReads > before);
  }
  assert.equal(logs.length, 2);
  for (const [index, selected] of [original, acceptance].entries()) {
    const event = JSON.parse(logs[index]);
    assert.equal(event.event, 'preflight'); assert.equal(event.datasetVersion, selected.datasetVersion);
    assert.equal(event.datasetSelection, selected.datasetSelection);
    assert.equal(event.cases, selected.dataset.length); assert.equal(event.maxRequests, selected.maxRequests);
    assert.equal(event.requestLimitPerCase, 2); assert.equal(event.automaticRetries, 0);
    assert.equal(event.wireProtocol, 'review-frozen-reference-typed-v4');
    assert.equal(event.scoreWrite, 'disabled'); assert.equal(event.cognitionWrite, 'disabled');
    assert.equal(event.productionModified, false);
    assert.match(event.datasetFingerprint, /^[a-f0-9]{64}$/u);
    assert.match(event.sourceFingerprint, /^[a-f0-9]{64}$/u);
    assert.ok(!Object.hasOwn(event, 'outputDirectory') && !Object.hasOwn(event, 'configFingerprint')
      && !Object.hasOwn(event, 'provider') && !Object.hasOwn(event, 'apiKey'));
  }
  assert.equal(forbiddenCalls, 0);

  const beforeInvalid = sourceReads;
  for (const args of invalidFlags) await assert.rejects(runReviewProgressiveExperiment(args), /invalid_flags/u);
  assert.equal(sourceReads, beforeInvalid); assert.equal(logs.length, 2); assert.equal(forbiddenCalls, 0);
} finally {
  fs.readFile = oldReadFile; fs.lstat = oldLstat; fs.open = oldOpen;
  fs.mkdir = oldMkdir; fs.mkdtemp = oldMkdtemp; fs.writeFile = oldWriteFile;
  os.homedir = oldHome; globalThis.fetch = oldFetch; console.log = oldLog;
  for (const [name, descriptor] of browserDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
}
pass('实际旧/新预检只读源代码指纹：0私有配置、0网络、0产物、0浏览器状态');
pass('实际非法参数在读指纹、私有配置、网络和产物前拒绝');

// These source guards preserve the existing request/artifact protections. They
// are safety-regression checks, not mocked evidence of cloud semantic quality.
const runner = await fs.readFile('scripts/run-review-progressive-experiment.ts', 'utf8');
assert.ok(runner.includes("const config = execute ? await loadAuthorizedProvider() : undefined;"));
assert.ok(runner.includes('calls < maxRequests && caseRequests < 2'));
assert.ok(runner.includes("{ flag: 'wx' }") && runner.includes('await fs.mkdtemp('));
assert.ok(runner.includes('hash(dataset) === datasetFingerprint')
  && runner.includes("'scripts/review-progressive-acceptance-dataset.ts'"));
assert.ok(runner.includes('const metrics = summarize(outcomes)')
  && runner.includes('(local ? prepared : outcomes.length) === dataset.length'));
assert.ok(runner.includes('path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)'));
assert.ok(runner.includes("globalThis.fetch = async () => { throw new Error('implicit_network_forbidden'); }"));
assert.ok(runner.includes("redirect: 'error'") && runner.includes('calls++; caseRequests++;'));
pass('全代码/新数据指纹、动态总预算、单题上限、wx隔离产物和禁止隐式网络保护保留');

console.log(`Progressive acceptance runner checks complete: ${checks} groups; 0 cloud calls, no artifacts or production writes.`);
