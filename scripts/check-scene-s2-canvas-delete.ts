import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { deleteS2CanvasSelection, resolveS2CanvasShortcut, type S2CanvasShortcutEvent } from '../src/services/scene/sceneS2CanvasDelete';
import { readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { assertS2ReadOnlyContent } from '../src/services/scene/sceneS2ReadOnly';
import { s2ExecutionLinkKey } from '../src/services/scene/sceneS2Workflow';

globalThis.fetch = async () => assert.fail('Canvas shortcuts must not read sources, call models, or access the network');
type Element = { tagName: string; parentElement?: Element; isContentEditable?: boolean; getAttribute(name: string): string | null; contains?(value: unknown): boolean };
function element(tagName: string, parentElement?: Element, attributes: Record<string, string> = {}): Element {
  return { tagName, parentElement, getAttribute: name => attributes[name] ?? null };
}
const body = element('BODY'), outside = element('DIV', body), canvas = element('DIV', body), pane = element('DIV', canvas);
const scope = { contains(target: unknown) { for (let current = target as Element | undefined; current; current = current.parentElement) if (current === canvas) return true; return false; } };
const available = { scope, activeElement: pane, canDelete: true, canUndo: true, canRedo: true };
const shortcut = (event: S2CanvasShortcutEvent, options = available) => resolveS2CanvasShortcut(event, options);
for (const key of ['Delete', 'Backspace']) assert.equal(shortcut({ key, target: pane }), 'delete');
for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
  assert.equal(shortcut({ key: 'z', target: pane, ...modifier }), 'undo');
  assert.equal(shortcut({ key: 'Z', target: pane, shiftKey: true, ...modifier }), 'redo');
  for (const key of ['Delete', 'Backspace']) assert.equal(shortcut({ key, target: pane, ...modifier }), null);
}
assert.equal(shortcut({ key: 'y', ctrlKey: true, target: pane }), 'redo');
assert.equal(shortcut({ key: 'y', metaKey: true, target: pane }), null);
assert.equal(shortcut({ key: 'y', ctrlKey: true, shiftKey: true, target: pane }), null);
assert.equal(shortcut({ key: 'z', target: pane }), null);
const keys: S2CanvasShortcutEvent[] = [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'z', ctrlKey: true }, { key: 'z', metaKey: true },
  { key: 'Z', ctrlKey: true, shiftKey: true }, { key: 'Z', metaKey: true, shiftKey: true }, { key: 'y', ctrlKey: true }];
const editableTargets = [
  element('INPUT', canvas), element('TEXTAREA', canvas), element('SELECT', canvas), element('OPTION', element('SELECT', canvas)),
  element('SPAN', element('DIV', canvas, { contenteditable: 'true' })), element('DIV', canvas, { contenteditable: '' }),
  element('SPAN', element('DIV', canvas, { contenteditable: 'plaintext-only' })), element('SPAN', element('DIV', canvas, { role: 'textbox' })),
  element('DIV', canvas, { role: 'searchbox' }), element('DIV', canvas, { role: 'combobox' }), element('DIV', canvas, { role: 'spinbutton' }),
  Object.assign(element('DIV', canvas), { isContentEditable: true }),
];
for (const target of editableTargets) for (const key of keys) {
  assert.equal(shortcut({ ...key, target }), null, `Do not steal ${key.key} from ${target.tagName}`);
  assert.equal(shortcut({ ...key, target: pane }, { ...available, activeElement: target }), null, 'Focused editors protect their own text history');
}
assert.equal(shortcut({ key: 'Delete', target: element('DIV', canvas, { contenteditable: 'false' }) }), 'delete');
assert.equal(shortcut({ key: 'Delete', target: { parentElement: editableTargets[0] } }), null, 'Text-node targets retain editor ownership');
assert.equal(shortcut({ key: 'Delete', target: pane, composedPath: () => [editableTargets[0], canvas] }), null, 'Composed editor paths cannot leak canvas shortcuts');
for (const key of keys) {
  assert.equal(shortcut({ ...key, target: outside }, { ...available, activeElement: outside }), null, 'Shortcuts stay inside the canvas focus scope');
  assert.equal(shortcut({ ...key, target: pane, defaultPrevented: true }), null);
  assert.equal(shortcut({ ...key, target: pane, isComposing: true }), null);
  assert.equal(shortcut({ ...key, target: pane, nativeEvent: { isComposing: true } }), null);
  assert.equal(shortcut({ ...key, target: pane, keyCode: 229 }), null);
  assert.equal(shortcut({ ...key, target: pane, altKey: true }), null);
  assert.equal(shortcut({ ...key, target: pane }, { ...available, canDelete: false, canUndo: false, canRedo: false }), null, 'Unavailable actions leave native handling intact');
}
assert.equal(resolveS2CanvasShortcut({ key: 'Delete', target: pane }, { ...available, scope: null }), null);
assert.equal(resolveS2CanvasShortcut({ key: 'z', ctrlKey: true, target: null }, available), 'undo', 'A scoped active element supports a window-level listener');
const eventWithNativeHandler = { key: 'Delete', target: pane, preventDefault() { assert.fail('The pure resolver must never prevent a native event'); } };
assert.equal(shortcut(eventWithNativeHandler), 'delete');

const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const definition = readS2Definition({ version: 1, goal: '通用画布删除', instructions: { understanding: '按需解释', planning: '用户操作', response: '保持原文' },
  blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [ref('structured-data', 'parse-json'), ref('structured-data', 'stringify'), ref('structured-view', 'text')], initial: {
    nodes: [{ id: 'source', type: 'text', position: { x: 0, y: 0 }, values: { content: '{"enabled":true,"value":0}' } },
      { id: 'other', type: 'text', position: { x: 0, y: 100 }, values: { content: '保留另一份内容' } },
      { id: 'fixed', type: 'text', readOnly: true, position: { x: 0, y: 200 }, values: { content: '固定原文' } }],
    edges: [{ id: 'relation', source: 'source', target: 'other', label: '说明关系' }],
    execution: { version: 1, nodes: [
      { ...ref('structured-data', 'parse-json'), id: 'parse', position: { x: 400, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'source', fieldId: 'content' } } },
      { ...ref('structured-data', 'stringify'), id: 'format', position: { x: 800, y: 0 }, bindings: {} },
      { ...ref('structured-view', 'text'), id: 'show', position: { x: 1200, y: 0 }, bindings: {} },
      { ...ref('structured-data', 'stringify'), id: 'conditional', position: { x: 800, y: 300 }, bindings: { value: { kind: 'literal', value: { kept: 0 } } },
        when: { nodeId: 'parse', portId: 'value', pointer: '/enabled', equals: true, match: true } },
    ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'format', portId: 'value' } },
      { source: { nodeId: 'format', portId: 'text' }, target: { nodeId: 'show', portId: 'text' } }] },
    groups: [{ id: 'words', label: '内容分组', nodeIds: ['source', 'other'], collapsed: true }],
    composites: [{ id: 'outer', label: '外组合', nodeIds: ['format', 'show'] }, { id: 'inner', label: '内组合', nodeIds: ['show'], parentId: 'outer' }],
  } } satisfies S2CanvasDefinition);
const document = definition.initial, original = JSON.stringify(document), saved = structuredClone(document);
const parsed = document.execution!.nodes.find(node => node.id === 'parse')!;
const fieldId = JSON.stringify(['parse', 'text', parsed.bindings.text]), conditionId = JSON.stringify(['condition', 'conditional']);
const firstLink = document.execution!.links[0], dataId = s2ExecutionLinkKey(firstLink);
for (const edgeId of ['relation', dataId, fieldId, conditionId]) {
  const next = deleteS2CanvasSelection(document, { edgeIds: [edgeId] }); assert.notEqual(next, document);
  assert.doesNotThrow(() => readS2Document(next, definition));
  if (edgeId === 'relation') { assert.equal(next.edges.length, 0); assert.equal(next.execution!.links.length, 2); }
  if (edgeId === dataId) { assert.equal(next.execution!.links.length, 1); assert.equal(next.execution!.nodes.length, 4); }
  if (edgeId === fieldId) { assert.equal(next.execution!.nodes.find(node => node.id === 'parse')!.bindings.text, undefined); assert.equal(next.nodes.length, 3); }
  if (edgeId === conditionId) { assert.equal(next.execution!.nodes.find(node => node.id === 'conditional')!.when, undefined); assert.equal(next.execution!.links.length, 2); }
}
const allEdges = deleteS2CanvasSelection(document, { edgeIds: ['relation', dataId, fieldId, conditionId] });
assert.equal(allEdges.edges.length, 0); assert.equal(allEdges.execution!.links.length, 1);
assert.equal(allEdges.execution!.nodes.find(node => node.id === 'parse')!.bindings.text, undefined);
assert.equal(allEdges.execution!.nodes.find(node => node.id === 'conditional')!.when, undefined);
assert.equal(allEdges.execution!.nodes.find(node => node.id === 'conditional')!.bindings.value.kind, 'literal', 'Deleting connections never removes unrelated fixed parameters');
const producer = deleteS2CanvasSelection(document, { nodeIds: ['parse'] });
assert(!producer.execution!.nodes.some(node => node.id === 'parse')); assert.equal(producer.execution!.links.length, 1);
assert.equal(producer.execution!.nodes.find(node => node.id === 'conditional')!.when, undefined, 'Deleting a condition producer clears its dependent condition');
assert.doesNotThrow(() => readS2Document(producer, definition));
const mixed = deleteS2CanvasSelection(document, { nodeIds: ['source', 'show', 'show'], edgeIds: [dataId, conditionId, 'already-missing'] });
assert.deepEqual(mixed.nodes.map(node => node.id), ['other', 'fixed']);
assert.equal(mixed.edges.length, 0); assert.equal(mixed.execution!.links.length, 0);
assert.equal(mixed.execution!.nodes.find(node => node.id === 'parse')!.bindings.text, undefined);
assert.deepEqual(mixed.groups![0].nodeIds, ['other']);
assert.deepEqual(mixed.composites!.map(item => [item.id, item.nodeIds]), [['outer', ['format']]]);
assert.doesNotThrow(() => readS2Document(mixed, definition));
const shell = deleteS2CanvasSelection(document, { nodeIds: ['outer'] });
assert.deepEqual(shell.execution!.nodes.map(node => node.id), ['parse', 'conditional']); assert.deepEqual(shell.composites, []);
assert.doesNotThrow(() => readS2Document(shell, definition));
const group = deleteS2CanvasSelection(document, { nodeIds: ['words'] });
assert.deepEqual(group.nodes.map(node => node.id), ['fixed']); assert.deepEqual(group.groups, []); assert.equal(group.edges.length, 0);
assert.doesNotThrow(() => readS2Document(group, definition));
const blocked = deleteS2CanvasSelection(document, { nodeIds: ['fixed'] });
assert.throws(() => assertS2ReadOnlyContent(document, blocked, { requirePresence: true }), /固定|只读/);
assert.equal(deleteS2CanvasSelection(document, {}), document);
assert.equal(deleteS2CanvasSelection(document, { nodeIds: ['retired-node'], edgeIds: ['result-edge-ephemeral', 'retired-edge'] }), document, 'Unknown/read-only result selection is a no-op');
const many = structuredClone(document); many.edges = Array.from({ length: 20 }, (_, index) => ({ id: `edge${index}`, source: 'source', target: 'other', label: '独立关系' }));
assert.equal(deleteS2CanvasSelection(many, { edgeIds: many.edges.map(edge => edge.id) }).edges.length, 0, 'A user can remove more than the Agent command limit in one selection');
assert.equal(JSON.stringify(document), original, 'Every delete preserves the exact source/undo snapshot');
assert.deepEqual(readS2Document(saved, definition), document, 'The retained previous document restores the full graph and values');
const moduleSource = readFileSync('src/services/scene/sceneS2CanvasDelete.ts', 'utf8');
assert(!/^import(?! type)/mu.test(moduleSource), 'Shortcut/delete projection has no registry or running application dependencies');
assert(!/prompt-lab|text-template|model-test/u.test(moduleSource), 'The helper does not depend on a business package');
console.log('S2 canvas shortcut/delete passed: scoped Delete/Backspace/undo/redo, editor and native-IME protection, unavailable-action fallthrough, four real connection kinds, multi-selection/dependent-edge cleanup, groups/composites, readonly validation and exact immutable undo snapshots. Offline only.');
