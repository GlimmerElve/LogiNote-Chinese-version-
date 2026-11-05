import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { S2CanvasDefinition, S2WorkflowCommand, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2ExecutionLink, S2Json, S2PluginNode } from '../src/types/sceneS2Plugin';
import { applyS2Commands, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionIssue } from '../src/services/scene/sceneS2ConnectionIssues';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import { s2ExecutionLinkKey } from '../src/services/scene/sceneS2Workflow';
import { planS2MaterialInput, s2MaterialInput } from '../src/services/scene/sceneS2Materials';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings'] = {}, pluginId?: string): S2WorkflowNode => ({
  id, ...cap(capabilityId, pluginId), bindings, position: { x: 0, y: 0 }, presentation: { label: '重复步骤' },
});
const wire = (source: string, output: string, target: string, input: string): S2ExecutionLink => ({ source: { nodeId: source, portId: output }, target: { nodeId: target, portId: input } });
const connect = (link: S2ExecutionLink): S2WorkflowCommand => ({ op: 'connect-ports', link });
const originalLink = wire('first', 'value', 'text', 'value');
const definition = readS2Definition({ version: 1, goal: '合成连接故障验收',
  instructions: { understanding: '理解用户', planning: '按需处理', response: '说清材料' },
  blockTypes: [{ id: 'note', label: '说明块', fields: [{ id: 'body', label: '说明文字', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('stringify'), cap('select'), cap('merge-json', 'workflow-merge')],
  initial: { nodes: [{ id: 'note', type: 'note', position: { x: 0, y: 0 }, values: { body: 'BODY_SECRET' } }], edges: [], execution: { version: 1,
    nodes: [node('first', 'parse-json', { text: literal('null') }), node('second', 'parse-json', { text: literal('false') }),
      node('text', 'stringify'), node('fixed', 'stringify', { value: literal({ private: 'LITERAL_SECRET' }) }),
      node('bound', 'parse-json', { text: { kind: 'field', nodeId: 'note', fieldId: 'body' } }),
      node('select', 'select', { pointer: literal('') }), node('merge', 'merge-json', {}, 'workflow-merge'),
      { ...node('conditional', 'parse-json', { text: literal('0') }), when: { nodeId: 'first', portId: 'value', pointer: '', equals: 'EQUALS_SECRET', match: true } },
      node('unrelated', 'parse-json', { text: literal('123') })], links: [originalLink] } },
});
const doc = definition.initial, saved = JSON.stringify({ definition, doc });
function failed(commands: unknown, document = doc, def = definition) {
  let failure: unknown;
  try { applyS2Commands(def, document, commands); } catch (error) { failure = error; }
  assert.ok(failure, 'Synthetic operation must fail native validation');
  return { failure, issue: s2ConnectionIssue(def, document, commands, failure) };
}
const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Offline diagnostics only'); };
try {
  const duplicate = failed([connect(originalLink)]).issue!;
  assert.equal(duplicate.kind, 'duplicate'); assert.match(duplicate.summary, /步骤 1.*步骤 3/);
  assert.deepEqual(duplicate.nodeIds, ['first', 'text']); assert.deepEqual(duplicate.connectionIds, [s2ExecutionLinkKey(originalLink)]);
  assert.match(duplicate.detail, /未应用.*保留/);

  const occupiedCommands = [connect(wire('second', 'value', 'text', 'value'))];
  const occupied = failed(occupiedCommands).issue!;
  assert.equal(occupied.kind, 'occupied-input'); assert.match(occupied.summary, /2 路/);
  assert.match(occupied.detail, /材料来源.*明确选择/);
  assert.deepEqual(occupied.connectionIds, [s2ExecutionLinkKey(originalLink)]);
  assert.deepEqual(occupied.nodeIds, ['text', 'first', 'second']);
  const fixed = failed([connect(wire('second', 'value', 'fixed', 'value'))]).issue!;
  assert.match(fixed.summary, /直接填写的固定材料/); assert.doesNotMatch(JSON.stringify(fixed), /LITERAL_SECRET/);
  assert.deepEqual(fixed.connectionIds, []);
  const bound = failed([connect(wire('text', 'text', 'bound', 'text'))]).issue!;
  assert.match(bound.summary, /说明块.*说明文字/); assert.ok(bound.nodeIds.includes('note'));
  assert.deepEqual(bound.connectionIds, [JSON.stringify(['bound', 'text', doc.execution!.nodes.find(node => node.id === 'bound')!.bindings.text])]);
  const bindingConflict = failed([{ op: 'update-execution-node', id: 'text', bindings: { value: literal(false) } }]).issue!;
  assert.equal(bindingConflict.kind, 'occupied-input'); assert.deepEqual(bindingConflict.connectionIds, [s2ExecutionLinkKey(originalLink)]);

  // Replacements are applied in native command order. This valid removal-first plan is not diagnosed as occupied.
  const source = s2MaterialInput(definition, doc, 'text', 'value');
  const replacement = planS2MaterialInput(definition, doc, 'text', 'value', [JSON.stringify(['output', 'second', 'value'])], source.base);
  const replaced = applyS2Commands(definition, doc, replacement);
  assert.deepEqual(replaced.execution!.links, [wire('second', 'value', 'text', 'value')]);
  assert.equal(s2ConnectionIssue(definition, doc, replacement, failed(occupiedCommands).failure), null);
  // Connecting before removing fails its first prefix even if a hypothetical final graph would be valid.
  const wrongOrder = failed([connect(wire('second', 'value', 'text', 'value')), { op: 'disconnect-ports', link: originalLink }]).issue!;
  assert.equal(wrongOrder.kind, 'occupied-input');
  const multiTarget = failed([connect(wire('first', 'value', 'select', 'value')), connect(wire('second', 'value', 'fixed', 'value'))]).issue!;
  assert.deepEqual(multiTarget.nodeIds, ['fixed', 'second'], 'Atomic fanout reports the rejecting target, not prior successful-prefix targets');
  assert.deepEqual(multiTarget.connectionIds, [], 'Uncommitted earlier command is not a navigable current wire');

  const self = failed([connect(wire('select', 'value', 'select', 'value'))]).issue!;
  assert.equal(self.kind, 'cycle'); assert.match(self.title, /自己/); assert.deepEqual(self.nodeIds, ['select']); assert.deepEqual(self.connectionIds, []);
  const selfCondition = failed([{ op: 'set-execution-condition', id: 'first', when: { nodeId: 'first', portId: 'value', pointer: '', equals: 0, match: true } }]).issue!;
  assert.equal(selfCondition.kind, 'cycle'); assert.deepEqual(selfCondition.nodeIds, ['first']); assert.deepEqual(selfCondition.connectionIds, []);
  const cycleCommands: S2WorkflowCommand[] = [{ op: 'unbind-input', id: 'first', portId: 'text' }, connect(wire('text', 'text', 'first', 'text'))];
  const cycle = failed(cycleCommands).issue!;
  assert.equal(cycle.kind, 'cycle'); assert.deepEqual(cycle.nodeIds, ['first', 'text']);
  assert.deepEqual(cycle.connectionIds, [s2ExecutionLinkKey(originalLink)]);
  assert.doesNotMatch(cycle.summary, /步骤 9/); assert.match(cycle.detail, /普通内容关联.*可以有环/);
  const mixedCommands: S2WorkflowCommand[] = [{ op: 'set-execution-condition', id: 'first', when: { nodeId: 'conditional', portId: 'value', pointer: '', equals: false, match: true } }];
  const mixed = failed(mixedCommands).issue!;
  assert.equal(mixed.kind, 'cycle'); assert.match(mixed.summary, /包含运行条件/);
  assert.deepEqual(mixed.nodeIds, ['first', 'conditional']);
  assert.deepEqual(mixed.connectionIds, [JSON.stringify(['condition', 'conditional'])]);
  const dataCondition = failed([{ op: 'set-execution-condition', id: 'first', when: { nodeId: 'select', portId: 'value', pointer: '', equals: null, match: true } },
    connect(wire('first', 'value', 'select', 'value'))]).issue!;
  assert.equal(dataCondition.kind, 'cycle'); assert.deepEqual(dataCondition.nodeIds, ['first', 'select']);
  assert.deepEqual(dataCondition.connectionIds, [], 'A condition created earlier in the rejected batch is not an original navigation target');
  const clearAndSet: S2WorkflowCommand[] = [{ op: 'set-execution-condition', id: 'conditional', when: null }, ...mixedCommands];
  assert.doesNotThrow(() => applyS2Commands(definition, doc, clearAndSet));
  assert.equal(s2ConnectionIssue(definition, doc, clearAndSet, failed(mixedCommands).failure), null);

  // A 33rd candidate is a graph limit, not the runtime mutually-exclusive branch verdict.
  const crowded: S2CanvasDefinition = readS2Definition({ ...definition, initial: { nodes: [], edges: [], execution: { version: 1,
    nodes: [...Array.from({ length: 33 }, (_, index) => node(`source-${index}`, 'parse-json', { text: literal('null') })), node('sink', 'merge-json', {}, 'workflow-merge')],
    links: Array.from({ length: 32 }, (_, index) => wire(`source-${index}`, 'value', 'sink', 'candidates')) } } });
  const limit = failed([connect(wire('source-32', 'value', 'sink', 'candidates'))], crowded.initial, crowded).issue!;
  assert.equal(limit.kind, 'source-limit'); assert.match(limit.summary, /32.*33 路/); assert.equal(limit.connectionIds.length, 32);

  // Unknown errors, invalid commands and unrelated validations never become invented connection advice.
  for (const error of [new Error('PORT_CARDINALITY text.value'), { code: 'PORT_CARDINALITY', field: 'text.value' },
    new S2PluginProtocolError('PORT_CARDINALITY', 'invented.value', '单值输入不能接收多路数据'), new Error('private body')]) {
    assert.equal(s2ConnectionIssue(definition, doc, occupiedCommands, error), null);
  }
  assert.equal(s2ConnectionIssue(definition, doc, 'bad', failed(occupiedCommands).failure), null);
  assert.equal(failed([{ op: 'update-execution-node', id: 'text', bindings: { invented: literal(0) } }]).issue, null);
  assert.equal(failed([connect(wire('first', 'invented', 'text', 'value'))]).issue, null);
  assert.equal(failed([{ op: 'set-execution-condition', id: 'first', when: { nodeId: 'text', portId: 'text', pointer: '', equals: null, match: true } }]).issue, null);
  assert.equal(failed([{ op: 'remove-execution-node', id: 'first' }]).issue, null);
  const malformed = [{ op: 'connect-ports', link: originalLink, unsupported: true }];
  assert.equal(failed(malformed).issue, null);
  assert.equal(s2ConnectionIssue(definition, doc, Array(1), failed(occupiedCommands).failure), null);

  // Sentinel getters prove diagnostics inspect topology only, not private data, equals, literals or instructions.
  const hidden = structuredClone(doc), unread = { get() { throw new Error('Private content was read'); }, enumerable: true };
  hidden.nodes.forEach(node => Object.defineProperty(node, 'values', unread));
  for (const node of hidden.execution!.nodes) {
    for (const binding of Object.values(node.bindings)) if (binding.kind === 'literal') Object.defineProperty(binding, 'value', unread);
    if (node.when) Object.defineProperty(node.when, 'equals', unread);
  }
  const hiddenDefinition = { ...definition }; Object.defineProperty(hiddenDefinition, 'initial', unread); Object.defineProperty(hiddenDefinition, 'instructions', unread);
  assert.deepEqual(s2ConnectionIssue(hiddenDefinition, hidden, occupiedCommands, failed(occupiedCommands).failure), occupied);
  assert.deepEqual(s2ConnectionIssue(hiddenDefinition, hidden, mixedCommands, failed(mixedCommands).failure), mixed);
  const commandSecret = [{ op: 'update-execution-node', id: 'text', bindings: { value: literal('SECRET') } }];
  Object.defineProperty(commandSecret[0].bindings.value, 'value', unread);
  assert.deepEqual(s2ConnectionIssue(hiddenDefinition, hidden, commandSecret, failed([{ op: 'update-execution-node', id: 'text', bindings: { value: literal(false) } }]).failure), bindingConflict);

  // Future optional-output contracts are tested with an isolated synthetic registry facade. Never mutate
  // the installed registry or production permissions: all builtin outputs currently promise completeness.
  const builtin = s2BuiltinPluginRegistry();
  const optionalRegistry = Object.assign(Object.create(builtin), {
    capability(ref: S2PluginNode) {
      const capability = structuredClone(builtin.capability(ref));
      if (ref.id === 'second') capability.outputs.forEach(port => { port.required = false; });
      return capability;
    },
  });
  const serviceRequire = createRequire(new URL('../src/services/scene/sceneS2ConnectionIssues.ts', import.meta.url));
  function loadWithOptionalRegistry(path: string) {
    const filename = new URL(path, import.meta.url), require = createRequire(filename);
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', output)((name: string) => {
      if (name === './sceneS2PluginRegistry') return { ...require(name), s2BuiltinPluginRegistry: () => optionalRegistry };
      // s2MaterialInput delegates exact source identity to the real control-draft
      // service. Its isolated CommonJS copy must see the same installed registry,
      // including the optional target's real prompt capability, as its caller.
      if (name === './sceneS2ControlDrafts') return loadWithOptionalRegistry('../src/services/scene/sceneS2ControlDrafts.ts');
      return require(name);
    }, module, module.exports);
    return module.exports;
  }
  const optionalIssue = loadWithOptionalRegistry('../src/services/scene/sceneS2ConnectionIssues.ts').s2ConnectionIssue as typeof s2ConnectionIssue;
  const optionalMaterials = loadWithOptionalRegistry('../src/services/scene/sceneS2Materials.ts').s2MaterialInput as typeof s2MaterialInput;
  // Use the same module-loader identity as this isolated CommonJS fixture's native Error class.
  const optionalProtocol = serviceRequire('./sceneS2PluginProtocol');
  let optionalFailure: unknown;
  try { optionalProtocol.preflightS2ExecutionGraph(optionalRegistry, doc.execution!.nodes.map(({ id, pluginId, pluginVersion, capabilityId }) => ({ id, pluginId, pluginVersion, capabilityId })),
    [...doc.execution!.links, wire('second', 'value', 'select', 'value')]); } catch (error) { optionalFailure = error; }
  assert.ok(optionalFailure instanceof optionalProtocol.S2PluginProtocolError);
  const optional = optionalIssue(definition, doc, [connect(wire('second', 'value', 'select', 'value'))], optionalFailure)!;
  assert.equal(optional.kind, 'optional-output'); assert.match(optional.summary, /可能没有输出.*必须/);
  assert.deepEqual(optional.nodeIds, ['second', 'select']); assert.deepEqual(optional.connectionIds, []);
  const material = optionalMaterials(definition, doc, 'select', 'value');
  assert.ok(!material.options.some(option => option.id === JSON.stringify(['output', 'second', 'value'])));
  assert.ok(material.unavailable.some(option => option.label.includes('步骤 2') && /可能|保证|缺省/.test(option.reason)));
  const optionalTargetDefinition = readS2Definition({ ...definition, plugins: [...definition.plugins!, cap('bind', 'text-template')],
    initial: { ...doc, execution: { ...doc.execution!, nodes: [...doc.execution!.nodes, node('optional-target', 'bind', { key: literal('role'), value: literal('example') }, 'text-template')] } } });
  const optionalTarget = optionalMaterials(optionalTargetDefinition, optionalTargetDefinition.initial, 'optional-target', 'variables');
  assert.ok(optionalTarget.options.some(option => option.id === JSON.stringify(['output', 'second', 'value'])), 'Optional inputs may accept optional outputs of the exact same type');

  assert.equal(network, 0); assert.equal(JSON.stringify({ definition, doc }), saved);
  console.log('S2 connection issue diagnostics passed: native error matching, existing-only navigation, atomic prefixes, fixed/field/multi inputs, exact mixed cycles, optional output, no values/IO/mutation.');
} finally { globalThis.fetch = priorFetch; }
