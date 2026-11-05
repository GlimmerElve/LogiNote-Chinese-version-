import assert from 'node:assert/strict';
import type { harness } from '../scene-s2-ui-harness';
import { sceneInteractionPacks } from '../../src/services/scene/sceneInteractionPacks';

type UI = ReturnType<typeof harness>;

/** Real block activation and parent submission; the child form is an explicit harness stub. */
export function submitS2InlineContent(ui: UI, nodeId: string, value: string, fieldId = 'content') {
  const read = () => ui.flow().props.nodes.find((node: any) => node.id === nodeId)?.data.fields.find((field: any) => field.id === fieldId);
  const before = read(); assert.ok(before, `${nodeId}/${fieldId}`);
  assert.equal(typeof before.startEdit, 'function'); before.startEdit(); ui.render();
  const editing = read(); assert.ok(editing.editor); assert.equal(editing.editor.props.variant, 'inline');
  editing.editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId, fieldId, previousValue: before.value, value });
  editing.editor.props.onDone(); ui.render();
}

/** Resolve the real selected package's local mapping, then use its public type
 * control. Legacy fixtures retain their explicit legacy menu contract. */
export function addS2PackCapability(ui: UI, capability: string) {
  const reference = ui.drafts.at(-1)?.interactionPack;
  const selected = reference ? sceneInteractionPacks.resolve(reference) : undefined;
  const component = selected?.authoring?.components.find(component => component.implementation.kind === 'capability'
    && `${component.implementation.pluginId}@${component.implementation.pluginVersion}/${component.implementation.capabilityId}` === capability);
  const button = ui.elements().find(element => element.type === 'button' && (component
    ? element.props['data-s2-component'] === component.id : element.props['data-s2-capability'] === capability));
  if (!button && !component && !selected?.canvas?.addMenu) {
    const control = ui.labelControl('添加的执行能力', 'select');
    assert.ok(ui.elements(control).some(option => option.type === 'option' && option.props.value === capability), `Installed legacy capability: ${capability}`);
    control.props.onChange({ target: { value: capability } }); ui.render();
    const add = ui.button('添加执行节点'); assert.equal(Boolean(add.props.disabled), false); add.props.onClick(); ui.render(); return;
  }
  assert.ok(button, `Package add menu: ${capability}`); assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick(); ui.render();
}

export function addS2PublicComponent(ui: UI, componentId: string) {
  const button = ui.elements().find(element => element.type === 'button' && element.props['data-s2-component'] === componentId);
  assert.ok(button, `Public component: ${componentId}`); assert.equal(Boolean(button.props.disabled), false);
  button.props.onClick(); ui.render();
}
