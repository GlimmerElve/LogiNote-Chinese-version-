import assert from 'node:assert/strict';
import type { SceneInteractionPack, ScenePackDescription } from '../src/types/sceneInteractionPack';
import { readSceneInteractionPackManifest, readSceneInteractionPackRef } from '../src/services/scene/sceneInteractionPackManifest';
import { ScenePackProtocolError, describeSceneInteractionPack, readSceneInteractionPack, readScenePackDescription,
  readScenePackIssues, readScenePackRun, readScenePackRuntime, readScenePackViewPolicy, validateScenePackConfig } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities, s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { promptLabPack } from '../src/interaction-packs/prompt-lab';
import { promptLabHelp } from '../src/interaction-packs/prompt-lab/help';
import { activate, arithmeticConfig } from './fixtures/s2-arithmetic-pack';

globalThis.fetch = async () => assert.fail('Contract checks forbid network, models and external data');
let executions = 0, renders = 0;
const arithmetic = activate({ editor: {} as any, ui: { react: { createElement() { renders++; assert.fail('Never render in a contract check'); } } } });
const pack = (): SceneInteractionPack => ({ ...arithmetic, capabilities: structuredClone(arithmetic.capabilities),
  manifest: structuredClone(arithmetic.manifest), executeLocal: async () => { executions++; assert.fail('Never execute package code while validating metadata'); } });
const description = (): ScenePackDescription => structuredClone(arithmetic.describe());
function denied(code: string, path: string, action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof ScenePackProtocolError, `Expected structured contract failure, got ${String(error)}`);
    assert.equal(error.code, code); assert(error.path.startsWith(path), `${error.path} must start with ${path}`);
    assert(error.message.includes(code) && error.message.includes(error.path)); return true;
  });
}
const mutateDescription = (change: (value: ScenePackDescription) => void) => { const next = description(); change(next); return next; };

// Real first-party and independent package descriptors must conform without being run.
const prompt = readSceneInteractionPack({ ...promptLabPack, help: promptLabHelp });
assert.equal(prompt.execution, 'on-demand', 'Prompt testing remains an explicit package-owned execution flow');
assert.equal(prompt.describe().components.length, 5);
const checked = readSceneInteractionPack(arithmetic);
assert.equal(readSceneInteractionPack({ ...arithmetic, execution: 'none' }).execution, 'none');
assert.equal(readSceneInteractionPack({ ...arithmetic, execution: 'on-demand' }).execution, 'on-demand');
assert.equal(checked.execution, undefined, 'Existing packages retain on-demand execution without a new field');
denied('PACK_EXECUTION_MODE', '/execution', () => readSceneInteractionPack({ ...arithmetic, execution: 'auto-run' }));
assert.equal(checked.manifest.id, 'arithmetic-lab'); assert.equal(typeof checked.views?.['arithmetic/sum'].settings, 'function');
assert.deepEqual(readSceneInteractionPackManifest(arithmetic.manifest), arithmetic.manifest);
assert.deepEqual(readSceneInteractionPackRef({ id: 'arithmetic-lab', version: '1.0.0' }), { id: 'arithmetic-lab', version: '1.0.0' });
assert.throws(() => readSceneInteractionPackManifest({ ...arithmetic.manifest, optionalServices: [] }), /清单字段不完整/);
assert.throws(() => readSceneInteractionPackManifest({ ...arithmetic.manifest, paradigm: 'S4' }), /协议或S2接口版本不支持/);
for (const executionUi of ['panel', 'inline'] as const) {
  const canvas = { executionUi }, result = readSceneInteractionPack({ ...pack(), canvas });
  assert.deepEqual(result.canvas, canvas);
  canvas.executionUi = executionUi === 'panel' ? 'inline' : 'panel';
  assert.equal(result.canvas!.executionUi, executionUi, 'Execution presentation is detached from package metadata');
}
denied('PACK_CONTRACT_DATA', '/canvas/executionUi', () => readSceneInteractionPack({ ...pack(), canvas: { executionUi: 'auto-send' } }));
denied('PACK_CONTRACT_FIELD', '/canvas', () => readSceneInteractionPack({ ...pack(), canvas: { executionUi: 'inline', modelConfirmation: 'user-action' } }));
let describes = 0, runtimeCalls = 0, validationCalls = 0;
const source: any = { ...pack(), ownerTag: 'original receiver', describe() {
  assert.equal(this.ownerTag, 'original receiver'); describes++;
  if (describes > 1) return { purpose: 'A second call must never reach installation' };
  return description();
}, validate() { assert.equal(this.ownerTag, 'original receiver'); validationCalls++; return [{ path: '/document', message: '业务条件未满足' }]; },
createRuntime() { runtimeCalls++; assert.fail('No runtime probing during load'); } };
const detached = readSceneInteractionPack(source);
assert.equal(describes, 1); assert.equal(runtimeCalls, 0); assert.equal(validationCalls, 0);
const manual = detached.describe(); manual.components.length = 0;
assert.equal(describeSceneInteractionPack(detached).components.length, 1);
assert.equal(describes, 1, 'Registration pins a validated guide instead of re-invoking a stateful describe during install');
source.manifest.name = '不能污染已校验清单'; source.capabilities[0].capabilities[0].inputs.length = 0;
assert.notEqual(detached.manifest.name, source.manifest.name); assert.equal(detached.capabilities[0].capabilities[0].inputs.length, 2);
assert.deepEqual(validateScenePackConfig(detached, arithmeticConfig), [{ path: '/document', message: '业务条件未满足' }]);
assert.equal(validationCalls, 1, 'A well-formed nonempty business issue list is returned, not automatically repaired or executed');

for (const name of ['describe', 'validate', 'createRuntime', 'executeLocal']) {
  denied('PACK_CONTRACT_FUNCTION', '/' + name, () => readSceneInteractionPack({ ...pack(), [name]: 'not callable' }));
}
denied('PACK_CONTRACT_FIELD', '/describe', () => readScenePackDescription({ purpose: '缺字段' }));
denied('PACK_CONTRACT_DATA', '/describe/purpose', () => readScenePackDescription(mutateDescription(value => { value.purpose = ' '; })));
denied('PACK_CONTRACT_DUPLICATE', '/describe/components', () => readScenePackDescription(mutateDescription(value => { value.components.push(structuredClone(value.components[0])); })));
denied('PACK_CONTRACT_DUPLICATE', '/describe/operations', () => readScenePackDescription(mutateDescription(value => { value.operations.push(structuredClone(value.operations[0])); })));
denied('PACK_CONTRACT_DUPLICATE', '/describe/combinations', () => readScenePackDescription(mutateDescription(value => { value.combinations.push(value.combinations[0]); })));
denied('PACK_CONTRACT_REFERENCE', '/describe/assistant/defaultAllowedOperations/0', () => readScenePackDescription(mutateDescription(value => { value.assistant.defaultAllowedOperations = ['undeclaredOperation']; })));
denied('PACK_CONTRACT_FIELD', '/describe', () => readScenePackDescription({ ...description(), permissions: ['network'] }));
denied('PACK_CONTRACT_LIMIT', '/describe/components', () => readScenePackDescription(mutateDescription(value => { value.components = Array.from({ length: 65 }, (_, id) => ({ ...value.components[0], id: String(id) })); })));
const cycle: any = description(); cycle.components[0].example = cycle;
denied('PACK_CONTRACT_DATA', '/describe/components/0/example', () => readScenePackDescription(cycle));
denied('PACK_CONTRACT_LIMIT', '/describe/purpose', () => readScenePackDescription({ ...description(), purpose: 'x'.repeat(64001) }));
denied('PACK_CONTRACT_OBJECT', '/describe', () => readScenePackDescription(Promise.resolve(description())));
const empty = description(); empty.components = []; empty.operations = []; empty.combinations = []; empty.assistant.defaultAllowedOperations = [];
assert.doesNotThrow(() => readScenePackDescription(empty), 'No prescribed component or operation vocabulary');
let getterCalls = 0;
const getter = { enumerable: true, get() { getterCalls++; throw Error('Getter must not execute'); } };
denied('PACK_CONTRACT_FIELD', '/describe', () => readSceneInteractionPack(Object.defineProperty(pack(), 'describe', getter)));
const getterGuide = description(); Object.defineProperty(getterGuide.components[0], 'example', getter);
denied('PACK_CONTRACT_FIELD', '/describe/components/0/example', () => readScenePackDescription(getterGuide));
const sparse = description(); sparse.components = Array(1);
denied('PACK_CONTRACT_FIELD', '/describe/components', () => readScenePackDescription(sparse));
denied('PACK_CONTRACT_CAPABILITY', '/capabilities/0', () => readSceneInteractionPack({ ...pack(), capabilities: [Object.defineProperty({}, 'id', getter)] }));
denied('PACK_CONTRACT_DUPLICATE', '/capabilities', () => readSceneInteractionPack({ ...pack(), capabilities: [arithmetic.capabilities[0], arithmetic.capabilities[0]] }));
assert.equal(getterCalls, 0);

// No capability can be published before a malformed guide has been rejected.
const catalog = s2BuiltinPluginRegistry().catalog();
denied('PACK_CONTRACT_REFERENCE', '/describe/assistant', () => installSceneInteractionCapabilities(readSceneInteractionPack({ ...pack(),
  describe: () => mutateDescription(value => { value.assistant.defaultAllowedOperations = ['invented']; }) })));
assert.deepEqual(s2BuiltinPluginRegistry().catalog(), catalog);

denied('PACK_CONTRACT_REFERENCE', '/views', () => readSceneInteractionPack({ ...pack(), views: { arithmetic: { settings() {} } } }));
denied('PACK_CONTRACT_REFERENCE', '/views', () => readSceneInteractionPack({ ...pack(), views: { 'arithmetic/missing': { settings() {} } } }));
denied('PACK_CONTRACT_FUNCTION', '/views', () => readSceneInteractionPack({ ...pack(), views: { 'arithmetic/sum': { settings: 'module.js' } } }));
denied('PACK_CONTRACT_REFERENCE', '/views', () => readSceneInteractionPack({ ...pack(), views: { 'uninstalled/custom': { settings() {} } } }, { sharedCapabilities: [] }));
assert.doesNotThrow(() => readSceneInteractionPack({ ...pack(), views: { 'shared/custom': { settings() {} } } }), 'No-context parse defers unknown shared references');
const shared = s2BuiltinPluginRegistry().catalog();
assert.doesNotThrow(() => readSceneInteractionPack({ ...pack(), views: { 'structured-view/text': { settings() {} } } }, { sharedCapabilities: shared }));
const help = { when: '何时使用', example: '使用示例', difference: '区别', inputLabels: { a: '甲', b: '乙' }, outputLabels: { text: '和' }, hideLiteralInputs: ['a'] };
const withHelp = readSceneInteractionPack({ ...pack(), help: { 'arithmetic/sum': help } });
help.inputLabels.a = '污染源'; help.hideLiteralInputs.length = 0;
assert.equal(withHelp.help!['arithmetic/sum'].inputLabels!.a, '甲'); assert.deepEqual(withHelp.help!['arithmetic/sum'].hideLiteralInputs, ['a']);
denied('PACK_CONTRACT_REFERENCE', '/help', () => readSceneInteractionPack({ ...pack(), help: { 'arithmetic/sum': { ...help, inputLabels: { fake: '虚构端口' } } } }));
denied('PACK_CONTRACT_REFERENCE', '/help', () => readSceneInteractionPack({ ...pack(), help: { 'arithmetic/sum': { ...help, hideLiteralInputs: ['text'] } } }));
denied('PACK_CONTRACT_FIELD', '/help', () => readSceneInteractionPack({ ...pack(), help: { 'arithmetic/sum': { when: '缺少示例和区别' } } }));
const long = pack(); long.capabilities[0].id = 'a'.repeat(120); long.capabilities[0].capabilities[0].id = 'B'.repeat(120);
long.views = { ['a'.repeat(120) + '/' + 'B'.repeat(120)]: { settings() {} } };
long.capabilities[0].capabilities[0].inputs[0].id = 'P'.repeat(120);
long.help = { ['a'.repeat(120) + '/' + 'B'.repeat(120)]: { when: '长标识', example: '合法端口', difference: '同一ID方言', hideLiteralInputs: ['P'.repeat(120)] } };
assert.doesNotThrow(() => readSceneInteractionPack(long), 'View keys use the same 120-character ID dialect as capability manifests');

const cap = arithmetic.capabilities[0].capabilities[0]; let callbacks = 0;
const rawPolicy = { visibleNodeInputs: ['a', 'b'], hiddenSettingsInputs: ['b'], annotation: '说明',
  inputActions: { a: { label: '查看甲', run() { callbacks++; } } }, addInput: { label: '添加', disabled: false, run() { callbacks++; } } };
const policy = readScenePackViewPolicy(rawPolicy, cap);
rawPolicy.visibleNodeInputs.length = 0; rawPolicy.inputActions.a.label = '污染源';
assert.deepEqual(policy.visibleNodeInputs, ['a', 'b']); assert.equal(policy.inputActions!.a.label, '查看甲'); assert.equal(callbacks, 0);
denied('PACK_CONTRACT_REFERENCE', '/viewPolicy/visibleNodeInputs/0', () => readScenePackViewPolicy({ visibleNodeInputs: ['fake'] }, cap));
denied('PACK_CONTRACT_DUPLICATE', '/viewPolicy/hiddenSettingsInputs', () => readScenePackViewPolicy({ hiddenSettingsInputs: ['a', 'a'] }, cap));
denied('PACK_CONTRACT_REFERENCE', '/viewPolicy/inputActions', () => readScenePackViewPolicy({ inputActions: { fake: { label: '假端口', run() {} } } }, cap));
denied('PACK_CONTRACT_FUNCTION', '/viewPolicy/inputActions', () => readScenePackViewPolicy({ inputActions: { a: { label: '错误回调', run: true } } }, cap));
denied('PACK_CONTRACT_DATA', '/viewPolicy/addInput/disabled', () => readScenePackViewPolicy({ addInput: { label: '添加', disabled: 'false', run() {} } }, cap));
denied('PACK_CONTRACT_FIELD', '/viewPolicy/annotation', () => readScenePackViewPolicy(Object.defineProperty({}, 'annotation', getter), cap));
denied('PACK_CONTRACT_LIMIT', '/viewPolicy/annotation', () => readScenePackViewPolicy({ annotation: 'x'.repeat(6001) }, cap));

// Runtime and actual return boundaries do not execute methods or settle handles during inspection.
let runtimeExecutions = 0;
const rawRuntime: any = { marker: 'runtime receiver', updateConfig() { assert.equal(this.marker, 'runtime receiver'); runtimeExecutions++; },
  dispatch() { runtimeExecutions++; }, run() { runtimeExecutions++; }, dispose() { runtimeExecutions++; } };
const runtime = readScenePackRuntime(rawRuntime); assert.equal(runtimeExecutions, 0);
runtime.updateConfig(arithmeticConfig); assert.equal(runtimeExecutions, 1);
denied('PACK_CONTRACT_FIELD', '/runtime/dispose', () => readScenePackRuntime({ updateConfig() {}, dispatch() {}, run() {} }));
denied('PACK_CONTRACT_FUNCTION', '/runtime/run', () => readScenePackRuntime({ ...rawRuntime, run: Promise.resolve() }));
denied('PACK_CONTRACT_OBJECT', '/runtime', () => readScenePackRuntime(Promise.resolve(rawRuntime)));
assert.deepEqual(readScenePackIssues([]), []);
for (const invalid of [null, false, {}]) denied('PACK_CONTRACT_DATA', '/validate', () => readScenePackIssues(invalid));
denied('PACK_CONTRACT_OBJECT', '/validate', () => readScenePackIssues(Promise.resolve([])));
denied('PACK_CONTRACT_FIELD', '/validate/0/message', () => readScenePackIssues([{ path: '/document' }]));
denied('PACK_CONTRACT_DATA', '/validate/0/path', () => readScenePackIssues([{ path: 'document', message: '错误' }]));
denied('PACK_CONTRACT_DATA', '/validate/0/message', () => readScenePackIssues([{ path: '/', message: '' }]));
const completion = Promise.resolve({ status: 'succeeded' }), cancel = () => { callbacks++; };
const handle = { id: 'queue-example', completion, cancel, opaque: { hostOwned: true } };
assert.equal(readScenePackRun(handle), handle); assert.equal(readScenePackRun(handle).completion, completion); assert.equal(readScenePackRun(handle).cancel, cancel);
let assimilations = 0;
const thenable = { then() { assimilations++; } }; assert.equal(readScenePackRun({ id: 'run', completion: thenable }).completion, thenable);
assert.equal(assimilations, 0);
denied('PACK_CONTRACT_RUN', '/run/completion', () => readScenePackRun({ id: 'run', completion: {} }));
denied('PACK_CONTRACT_RUN', '/run/completion', () => readScenePackRun({ id: 'run', completion: Object.defineProperty({}, 'then', getter) }));
denied('PACK_CONTRACT_FIELD', '/run/id', () => readScenePackRun({ completion }));
assert.equal(getterCalls, 0); assert.equal(callbacks, 0); assert.equal(executions, 0); assert.equal(renders, 0); assert.equal(runtimeCalls, 0);
console.log('Scene pack contract passed: unchanged strict v1 manifest/ref, complete bounded detached Agent guide, duplicate/reference checks, no getters or runtime probing, atomic pre-install rejection, arbitrary operations, own/shared view/help references and long IDs, dynamic policy callback safety, bound runtime methods, validation-result shape and original Promise/extra run-handle preservation. No UI, model or network calls.');
