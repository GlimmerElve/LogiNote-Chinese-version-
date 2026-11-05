import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../../types/sceneS2';
import type { S2Json } from '../../types/sceneS2Plugin';

/** Pure editor helpers only. No credentials, storage, model transport or live host instance. */
export interface PromptLabUiHost {
  readS2Definition(raw: unknown): S2CanvasDefinition;
  readS2Document(raw: unknown, definition: S2CanvasDefinition): S2Document;
  snapshotS2CompositeData<T>(raw: T, limits?: { maxBytes?: number; maxEntries?: number }): T;
  canonicalS2Json(raw: S2Json): string;
  s2NodeTitle(node: S2WorkflowNode): string;
  s2ParameterSource(document: S2Document, nodeId: string, portId: string): { key: string; connected: boolean };
}
let host: PromptLabUiHost | undefined;
export function bindPromptLabUiHost(value: PromptLabUiHost) { host = value; }
function useHost(): PromptLabUiHost { if (!host) throw new Error('提示词交互包尚未绑定S2编辑接口'); return host; }
export const readS2Definition: PromptLabUiHost['readS2Definition'] = (...args) => useHost().readS2Definition(...args);
export const readS2Document: PromptLabUiHost['readS2Document'] = (...args) => useHost().readS2Document(...args);
export const snapshotS2CompositeData: PromptLabUiHost['snapshotS2CompositeData'] = (raw, limits) => useHost().snapshotS2CompositeData(raw, limits);
export const canonicalS2Json: PromptLabUiHost['canonicalS2Json'] = (...args) => useHost().canonicalS2Json(...args);
export const s2NodeTitle: PromptLabUiHost['s2NodeTitle'] = (...args) => useHost().s2NodeTitle(...args);
export const s2ParameterSource: PromptLabUiHost['s2ParameterSource'] = (...args) => useHost().s2ParameterSource(...args);
