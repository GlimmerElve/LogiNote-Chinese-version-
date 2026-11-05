import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { closeSceneInteractionHost, enqueueSceneInteractionWorkflow, scenePackLocalAdapter } from '../src/services/scene/sceneInteractionHostServices';
import { exportS2Workspace, importS2WorkspaceWithPack, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { scenePackViewPolicy } from '../src/components/scene/ScenePackView';
import type { SceneInteractionPackManifest, ScenePackConfig, ScenePackHostServices, ScenePackRun, ScenePackViewContext } from '../src/types/sceneInteractionPack';
import { activate as arithmeticActivate, arithmeticConfig } from './fixtures/s2-arithmetic-pack';

// Run with --no-scene-pack-bootstrap. All package discovery and code transport below
// are in memory; no real directory, browser, network or model service is accessed.
assert.deepEqual(sceneInteractionPacks.catalog(), [], 'Contract integration starts with an empty package registry');
const capabilityRegistry = s2BuiltinPluginRegistry();
assert(!capabilityRegistry.catalog().some(plugin => ['arithmetic', 'text-template', 'model-test'].includes(plugin.id)));
type Probe = {
  creates: number; runs: number; executes: number; disposes: number; updates: number;
  validates: Array<{ goal: string; a: unknown }>;
  issues: 'normal' | 'malformed'; runtime: 'normal' | 'promise' | 'missing' | 'throws'; handle: 'normal' | 'malformed';
  lastHandle?: ScenePackRun; retainedServices?: ScenePackHostServices;
};
const probe: Probe = { creates: 0, runs: 0, executes: 0, disposes: 0, updates: 0,
  validates: [], issues: 'normal', runtime: 'normal', handle: 'normal' };
const globalKey = '__scenePackContractIntegrationProbe';
const previousProbe = Object.getOwnPropertyDescriptor(globalThis, globalKey);
const previousFetch = globalThis.fetch;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const styles: unknown[] = [];
const hosts = new Set<S2PluginHost>();
const payloads = new Map<string, { manifest: SceneInteractionPackManifest; codeBase64: string; styles: string }>();
let cliRoot: string | undefined;

async function fixture(id: string, invalid: '' | 'description' | 'views' | 'help' = '') {
  const manifest = { ...arithmeticActivate({ editor: {} as never, ui: { react: {} } }).manifest, id };
  const bundled = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', sourcefile: `${id}.ts`, contents: `
    import { activate as createArithmetic } from './scripts/fixtures/s2-arithmetic-pack';
    export function activate(services) {
      const pack = createArithmetic(services), probe = globalThis.${globalKey};
      pack.manifest = ${JSON.stringify(manifest)};
      const originalDescription = pack.describe;
      const originalValidate = pack.validate;
      const originalCreate = pack.createRuntime;
      const originalExecute = pack.executeLocal;
      pack.validate = config => {
        const a = config.document.execution?.nodes.find(node => node.id === 'sum')?.bindings.a;
        probe.validates.push({ goal: config.definition.goal, a: a?.kind === 'literal' ? a.value : null });
        if (probe.issues === 'malformed') return { valid: true };
        if (a?.kind === 'literal' && typeof a.value === 'number' && a.value < 0)
          return [{ path: '/document/execution/nodes/0/bindings/a', message: '此示例只接受非负数；草稿仍可编辑保存' }];
        return originalValidate(config);
      };
      pack.createRuntime = (config, host) => {
        probe.creates++; probe.retainedServices = host;
        if (probe.runtime === 'promise') return Promise.resolve({});
        if (probe.runtime === 'missing') return { run() { probe.runs++; } };
        if (probe.runtime === 'throws') throw new Error('CONSTRUCTOR_FAILED');
        const runtime = originalCreate(config, host);
        return {
          ...runtime,
          updateConfig(config) { probe.updates++; return runtime.updateConfig(config); },
          run(...args) {
            probe.runs++;
            const job = runtime.run(...args); probe.lastHandle = job;
            return probe.handle === 'malformed' ? { id: job.id, completion: 7 } : job;
          },
          dispose() { probe.disposes++; return runtime.dispose(); },
        };
      };
      pack.executeLocal = (...args) => { probe.executes++; return originalExecute(...args); };
      if (${JSON.stringify(invalid)} === 'description') pack.describe = () => ({ ...originalDescription(), builder: { assemble: 7, repair: '修复数字输入' } });
      if (${JSON.stringify(invalid)} === 'views') pack.views = { 'arithmetic/sum': { settings: 7 } };
      if (${JSON.stringify(invalid)} === 'help') pack.help = { 'arithmetic/sum': { when: '相加', example: '2 + 3', difference: '纯本地运算', hideLiteralInputs: ['nonexistent'] } };
      return pack;
    }
  ` }, bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  payloads.set(id, { manifest, codeBase64: Buffer.from(bundled.outputFiles[0].contents).toString('base64'), styles: '.contract-fixture { color: inherit; }' });
  return { id, version: manifest.version };
}
function hostFor(config: ScenePackConfig, reference: { id: string; version: string }) {
  const host = new S2PluginHost(`contract-${hosts.size}`, config.definition, scenePackLocalAdapter(reference));
  host.setDocument(config.document); hosts.add(host); return host;
}
function setA(config: ScenePackConfig, a: number): ScenePackConfig {
  const next = structuredClone(config);
  next.document.execution!.nodes.find(node => node.id === 'sum')!.bindings.a = { kind: 'literal', value: a };
  return next;
}
function shown(host: S2PluginHost, result: Awaited<ReturnType<S2PluginHost['enqueueWorkflow']>['completion']>) {
  const output = result.nodes.find(node => node.nodeId === 'show')!;
  return host.currentArtifact(output.artifactIds[0]).payload;
}
try {
  Object.defineProperty(globalThis, globalKey, { configurable: true, value: probe });
  globalThis.fetch = async () => assert.fail('Contract integration forbids real IO/model calls');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: {
    async list() { return { managed: true, packs: [...payloads.values()].map(value => structuredClone(value.manifest)), errors: [] }; },
    async load(reference: { id: string; version: string }) {
      const value = payloads.get(reference.id); assert(value); assert.equal(reference.version, value.manifest.version);
      return structuredClone(value);
    },
  } }, localStorage: { getItem() { assert.fail('No persistent browser storage'); }, setItem() { assert.fail('No persistent browser storage'); } } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: (style: unknown) => styles.push(style) },
  } });

  const invalid = [await fixture('contract-bad-description', 'description'), await fixture('contract-bad-views', 'views'),
    await fixture('contract-bad-help', 'help')];
  const reference = await fixture('contract-independent-arithmetic');
  const beforePackages = sceneInteractionPacks.catalog(), beforeCapabilities = capabilityRegistry.catalog();
  for (const candidate of invalid) {
    await assert.rejects(loadSceneInteractionPack(candidate), /PACK_CONTRACT/, `Reject invalid ${candidate.id} before publication`);
    assert.deepEqual(sceneInteractionPacks.catalog(), beforePackages, 'A rejected package is never published');
    assert.deepEqual(capabilityRegistry.catalog(), beforeCapabilities, 'A rejected package leaves capabilities unchanged');
  }
  assert.equal(styles.length, 0, 'Rejected entries cannot publish styles');
  assert.deepEqual([probe.creates, probe.runs, probe.executes, probe.validates.length], [0, 0, 0, 0], 'Loading does not probe runtime or execution');
  await loadSceneInteractionPack(reference);
  assert.equal(sceneInteractionPacks.resolve(reference).manifest.id, reference.id);
  assert.equal(capabilityRegistry.capability({ pluginId: 'arithmetic', pluginVersion: '1.0.0', capabilityId: 'sum' }).kind, 'transform');
  assert.equal(styles.length, 1);
  assert.deepEqual([probe.creates, probe.runs, probe.executes], [0, 0, 0], 'A successful load also performs no execution');

  const definition = readS2Definition(arithmeticConfig.definition);
  const config: ScenePackConfig = { definition, document: readS2Document(arithmeticConfig.document, definition) };
  const dynamicPolicyRef = { id: 'contract-dynamic-policy', version: reference.version };
  let renderErrors = 0, policyActions = 0;
  const loaded = sceneInteractionPacks.resolve(reference);
  sceneInteractionPacks.register({ ...loaded, manifest: { ...loaded.manifest, id: dynamicPolicyRef.id }, views: {
    'arithmetic/sum': { policy: () => ({ visibleNodeInputs: ['nonexistent'],
      inputActions: { nonexistent: { label: 'Invalid action', run() { policyActions++; } } } }) },
  } });
  sceneInteractionPacks.setAvailable([reference, dynamicPolicyRef]);
  const policyContext: ScenePackViewContext = { ...config, node: config.document.execution!.nodes[0], active: true,
    state: { get<T>() { return undefined; }, initialize<T>(_key: string, create: () => T) { return create(); }, set() {}, delete() {} },
    guard() {}, readCurrent() { return structuredClone(config); }, registerPanel() {}, navigate() {}, focusSettings() {},
    nodeLabel(nodeId) { return nodeId; }, inputLabel(_nodeId, portId) { return portId; },
    onNotice() {}, onDocumentChange() {}, onInputChange() {}, onError() { renderErrors++; } };
  const policy = scenePackViewPolicy(dynamicPolicyRef, policyContext);
  assert.match(policy!.annotation!, /交互包视图接口错误：.*\[PACK_CONTRACT_REFERENCE\].*\/viewPolicy\/visibleNodeInputs\/0/);
  assert.deepEqual(Object.keys(policy!), ['annotation'], 'An invalid dynamic view cannot publish ports or action callbacks');
  assert.deepEqual([renderErrors, policyActions], [0, 0], 'Render-time rejection reports a node annotation without state updates or actions');
  const host = hostFor(config, reference);
  probe.issues = 'malformed';
  assert.throws(() => enqueueSceneInteractionWorkflow(host, config, reference, ['show']), /PACK_CONTRACT/);
  assert.deepEqual([probe.creates, probe.runs, probe.executes], [0, 0, 0], 'Malformed issue results cannot create or run a runtime');
  probe.issues = 'normal';

  const unfinished = { definition: structuredClone(definition), document: { nodes: [], edges: [], execution: { version: 1 as const, nodes: [], links: [] } } };
  const draftText = exportS2Workspace(unfinished.definition, unfinished.document, reference);
  assert.deepEqual(importS2WorkspaceWithPack(draftText).definition.initial, unfinished.document, 'Business-incomplete drafts remain readable and exportable');
  assert.throws(() => enqueueSceneInteractionWorkflow(host, unfinished, reference), /PACK_CONFIG_INVALID/);
  assert.deepEqual([probe.creates, probe.runs, probe.executes], [0, 0, 0], 'Business issues prevent execution without destroying editable drafts');

  const job = enqueueSceneInteractionWorkflow(host, config, reference, ['show']);
  assert.strictEqual(job, probe.lastHandle, 'The package run handle is preserved');
  assert.strictEqual(job.completion, probe.lastHandle!.completion, 'Completion is not awaited, replaced or assimilated');
  const result = await job.completion;
  assert.equal(result.status, 'succeeded'); assert.deepEqual(shown(host, result), { kind: 'inline', value: '5' });
  const completedCounts = [probe.creates, probe.runs, probe.executes];
  const negative = setA(config, -1); host.setDocument(negative.document);
  assert.throws(() => enqueueSceneInteractionWorkflow(host, negative, reference, ['show']), /PACK_CONFIG_INVALID/);
  assert.deepEqual([probe.creates, probe.runs, probe.executes], completedCounts, 'Each run validates the current configuration before cached runtime execution');
  assert.equal(importS2WorkspaceWithPack(exportS2Workspace(negative.definition, negative.document, reference)).definition.initial.execution!.nodes[0].bindings.a.kind, 'literal');
  const repaired = setA(config, 7); host.setDocument(repaired.document);
  const repairedResult = await enqueueSceneInteractionWorkflow(host, repaired, reference, ['show']).completion;
  assert.equal(repairedResult.status, 'succeeded'); assert.deepEqual(shown(host, repairedResult), { kind: 'inline', value: '10' });
  assert(probe.validates.some(value => value.a === -1) && probe.validates.some(value => value.a === 7));
  assert.equal(probe.updates, 0, 'Configuration refresh does not call a package write operation in a read/run-only host');

  const cancelled = enqueueSceneInteractionWorkflow(host, repaired, reference, ['show'], undefined, { force: true });
  assert.strictEqual(cancelled, probe.lastHandle); host.cancelWorkflow(cancelled.id);
  assert.equal((await cancelled.completion).status, 'cancelled', 'Original IDs still address cancellation');
  const closing = enqueueSceneInteractionWorkflow(host, repaired, reference, ['show'], undefined, { force: true });
  closeSceneInteractionHost(host); closeSceneInteractionHost(host);
  assert.equal((await closing.completion).status, 'cancelled'); assert.equal(probe.disposes, 1, 'Closing retires the package once and cancels outstanding host work');

  for (const mode of ['promise', 'missing', 'throws'] as const) {
    probe.runtime = mode;
    const malformedHost = hostFor(config, reference), before = [probe.runs, probe.executes];
    assert.throws(() => enqueueSceneInteractionWorkflow(malformedHost, config, reference, ['show']), mode === 'throws' ? /CONSTRUCTOR_FAILED/ : /PACK_CONTRACT/);
    assert.deepEqual([probe.runs, probe.executes], before, 'A malformed synchronous runtime is not probed');
    assert.deepEqual(malformedHost.workflowHistory(), []);
    assert.throws(() => probe.retainedServices!.readConfig(), /关闭|结束|CLOSED|active/i, 'Even an ordinary constructor exception retires captured services');
    assert.throws(() => malformedHost.enqueueWorkflow(['show']), /关闭|结束|CLOSED|active/i, 'Rejected runtime services are retired');
  }
  probe.runtime = 'normal'; probe.handle = 'malformed';
  const malformedHandleHost = hostFor(config, reference), beforeExecute = probe.executes;
  assert.throws(() => enqueueSceneInteractionWorkflow(malformedHandleHost, config, reference, ['show']), /PACK_CONTRACT/);
  assert.equal((await probe.lastHandle!.completion as { status: string }).status, 'cancelled', 'A malformed handle cannot leave scheduled work alive');
  assert.equal(malformedHandleHost.workflowHistory().length, 1);
  assert.equal(probe.executes, beforeExecute, 'Handle rejection closes the host before local execution publishes data');

  // Exercise the actual developer command in a clean process. Runtime methods are
  // tripwires: validation may activate/describe/validate but must never execute.
  cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-pack-contract-cli-'));
  const cliManifest = { ...payloads.get(reference.id)!.manifest, id: 'contract-cli-arithmetic' };
  const cliDirectory = path.join(cliRoot, cliManifest.id, cliManifest.version);
  await fs.mkdir(cliDirectory, { recursive: true });
  const cliBundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { activate as createArithmetic } from './scripts/fixtures/s2-arithmetic-pack';
    export function activate(services) {
      const pack = createArithmetic(services);
      return { ...pack, manifest: ${JSON.stringify(cliManifest)},
        createRuntime() { throw new Error('CLI_MUST_NOT_CREATE_RUNTIME'); },
        executeLocal() { throw new Error('CLI_MUST_NOT_EXECUTE'); } };
    }
  ` }, bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' });
  const cliGuide = arithmeticActivate({ editor: {} as never, ui: { react: {} } }).describe();
  await Promise.all([
    fs.writeFile(path.join(cliDirectory, 'manifest.json'), JSON.stringify(cliManifest)),
    fs.writeFile(path.join(cliDirectory, 'agent.json'), JSON.stringify(cliGuide)),
    fs.writeFile(path.join(cliDirectory, 'main.js'), cliBundle.outputFiles[0].contents),
    fs.writeFile(path.join(cliDirectory, 'styles.css'), ''),
    fs.writeFile(path.join(cliRoot, 'config.json'), JSON.stringify(config)),
  ]);
  const cliSnapshot = async () => Promise.all((await fs.readdir(cliDirectory)).sort().map(async name => [name, (await fs.readFile(path.join(cliDirectory, name))).toString('base64')]));
  const runCli = () => spawnSync(process.execPath, ['scripts/run-tsx-safe.cjs', 'scripts/validate-scene-pack.ts', '--dir', cliDirectory,
    '--scene', path.join(cliRoot!, 'config.json')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  let beforeFiles = await cliSnapshot(), cli = runCli();
  assert.equal(cli.status, 0, cli.stderr || cli.error?.message); assert.match(cli.stdout, /contract-cli-arithmetic@1\.0\.0/);
  assert.deepEqual(await cliSnapshot(), beforeFiles, 'Successful CLI validation never writes into the input package');
  await fs.writeFile(path.join(cliDirectory, 'agent.json'), JSON.stringify({ ...cliGuide, purpose: 'Outdated agent manual' }));
  beforeFiles = await cliSnapshot(); cli = runCli();
  assert.equal(cli.status, 1); assert.match(cli.stderr, /PACK_AGENT_MISMATCH.*\/agent\.json/);
  assert.deepEqual(await cliSnapshot(), beforeFiles, 'Failed CLI validation preserves the original package');
  await fs.writeFile(path.join(cliDirectory, 'main.js'), Buffer.alloc(524289, 32));
  beforeFiles = await cliSnapshot(); cli = runCli();
  assert.equal(cli.status, 1); assert.match(cli.stderr, /PACK_FILE_LIMIT.*\/main\.js/);
  assert.deepEqual(await cliSnapshot(), beforeFiles, 'CLI applies the shared 512 KiB code bound without rewriting or truncating it');

  console.log('Scene package contract integration passed: production loader rejects malformed manuals/views/help atomically; independent arithmetic loads without business-specific host changes; dynamic policy errors become visible annotations without render state updates or invalid ports/actions; current-config validation blocks bad issues/business errors while drafts remain editable; repaired runs, original handles, cancellation, disposal, malformed runtimes, ordinary constructor exceptions and scheduled-handle cleanup remain controlled; developer CLI checks real files, scenes, manual mismatch and common limits without runtime execution or input mutation. Synthetic transport and isolated temporary files only; no network/model/user-data IO.');
} finally {
  for (const host of hosts) closeSceneInteractionHost(host);
  globalThis.fetch = previousFetch;
  if (previousProbe) Object.defineProperty(globalThis, globalKey, previousProbe); else Reflect.deleteProperty(globalThis, globalKey);
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  if (cliRoot) {
    assert.equal(path.dirname(cliRoot), os.tmpdir()); assert(path.basename(cliRoot).startsWith('loginote-pack-contract-cli-'));
    await fs.rm(cliRoot, { recursive: true, force: true });
  }
}
