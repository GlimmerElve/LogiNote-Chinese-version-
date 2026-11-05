import type { S2PluginCapability, S2PluginPort } from '../../types/sceneS2Plugin';

/** Generic model-session@1 ABI. Business packages choose their own capability IDs and UI.
 * The legacy implementation name remains stable for already distributed v0.1 packages.
 * Declaring this ABI never creates a session, reserves budget or confirms a request.
 */
export const S2_MODEL_SESSION_BRIDGE = Object.freeze({ id: 'model-session', protocolVersion: 1, implementation: 'model-test-session' } as const);
type PortShape = readonly [id: string, type: string, required: boolean];
const INPUTS: readonly PortShape[] = [
  ['prompt', 'core.text', true], ['input', 'core.text', false], ['image', 'core.image', false],
  ['maxOutputTokens', 'core.number', false], ['temperature', 'core.number', false], ['thinkingMode', 'core.text', false],
];
function ports(actual: S2PluginPort[], expected: readonly PortShape[]): boolean {
  return actual.length === expected.length && expected.every(([id, type, required]) => actual.some(port =>
    port.id === id && port.type.id === type && port.type.version === 1 && port.required === required && port.multiple === false));
}
/** A closed ABI prevents arbitrary external actions from borrowing the host's model authority. */
export function isS2ModelSessionCapability(capability: S2PluginCapability): boolean {
  return capability.kind === 'action' && capability.effect === 'external'
    && capability.permissions.length === 1 && capability.permissions[0] === 'model-call'
    && capability.confirmation === 'per-call' && capability.retry === 'manual-only' && capability.timeoutMs === 120000
    && ports(capability.inputs, INPUTS) && ports(capability.outputs, [['text', 'core.text', true]]);
}
export function isS2ModelSessionImplementation(descriptor: { kind: string; bridge?: unknown }): boolean {
  return descriptor.kind === 'model' && descriptor.bridge === S2_MODEL_SESSION_BRIDGE.implementation;
}
