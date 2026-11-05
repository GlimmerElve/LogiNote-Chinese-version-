import type { S2Workflow } from './sceneS2';
import type { S2ExecutionLink, S2Json, S2PluginNode, S2TypeRef } from './sceneS2Plugin';

export type S2CompositeCapability = Omit<S2PluginNode, 'id'>;
export type S2CompositeEndpoint = S2ExecutionLink['source'];
/** Design data only. A blueprint is not an installed plugin, a grant or an execution receipt. */
export interface S2CompositeBlueprint {
  format: 's2-composite'; protocolVersion: 1;
  id: string; version: string; label: string; description: string;
  plugins: S2CompositeCapability[];
  /** Portable v1 blueprints keep a flat executable graph; scene-local hierarchy is separate design metadata. */
  workflow: S2Workflow;
  inputs: Array<{ id: string; label: string; type: S2TypeRef; required: boolean; multiple: boolean; targets: S2CompositeEndpoint[] }>;
  /** Cardinality is the producer's successful-output contract, not a promise that a guarded branch will run. */
  outputs: Array<{ id: string; label: string; type: S2TypeRef; required: boolean; multiple: boolean; source: S2CompositeEndpoint }>;
  parameters: Array<{ id: string; label: string; type: S2TypeRef; target: S2CompositeEndpoint; defaultValue?: S2Json }>;
}
export interface S2CompositeValues {
  /** Complete typed literal values, not expressions, paths, grants or artifact references. Missing inputs remain editable holes. */
  inputs?: Record<string, S2Json>;
  parameters?: Record<string, S2Json>;
  position?: { x: number; y: number };
}
/** A flat, editable expansion for the existing Host. This metadata is never evidence of execution. */
export interface S2CompositeExpansion {
  instanceId: string;
  blueprint: { id: string; version: string; label: string };
  workflow: S2Workflow;
  sourceMap: Array<{ localNodeId: string; nodeId: string }>;
  inputs: S2CompositeBlueprint['inputs'];
  outputs: S2CompositeBlueprint['outputs'];
  parameters: S2CompositeBlueprint['parameters'];
}
/** Scene-local hierarchy. nodeIds includes ALL real steps in the subtree, not shell IDs.
 * Overlap is legal only along the explicit parent chain. Interfaces are always recomputed. */
export interface S2CompositeInstanceMapping {
  nodes: Array<{ localId: string; id: string }>;
  composites: Array<{ localId: string; id: string }>;
}
export interface S2CanvasComposite {
  id: string; label: string; nodeIds: string[]; parentId?: string;
  /** Design provenance only, not authenticity, unchanged-content evidence or permission.
   * Missing/moved IDs are retained as tombstones; editing must not erase drift evidence. */
  blueprint?: { id: string; version: string; mapping?: S2CompositeInstanceMapping };
}
/** Portable published design, including the entire bounded scene-local hierarchy; never grants or runtime state. */
export interface S2CompositeDesign {
  format: 's2-composite-design'; protocolVersion: 1;
  blueprint: S2CompositeBlueprint;
  rootId: string;
  composites: S2CanvasComposite[];
}
