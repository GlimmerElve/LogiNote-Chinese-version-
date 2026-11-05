/** S2 plugin contract v1. Separate version axis from S2 canvas/document v1. */
export type S2Json = null | boolean | number | string | S2Json[] | { [key: string]: S2Json };
/** Closed, bounded schema dialect; deliberately NOT the full JSON Schema standard. */
export type S2ValueSchema =
  | { kind: 'json'; maxDepth: number; maxEntries: number; maxBytes: number }
  | { kind: 'string'; maxLength: number; enum?: string[] }
  | { kind: 'number'; integer: boolean; minimum: number; maximum: number }
  | { kind: 'boolean' }
  | { kind: 'array'; maxItems: number; item: S2ValueSchema }
  | { kind: 'object'; fields: Record<string, S2ValueSchema>; required: string[] };
export interface S2TypeRef { id: string; version: number }
export interface S2DataType extends S2TypeRef { meaning: string; schema: S2ValueSchema }
export interface S2PluginPort { id: string; label: string; meaning: string; type: S2TypeRef; required: boolean; multiple: boolean }
export type S2PluginPermission = 'notes-read' | 'profile-read' | 'network' | 'model-call' | 'file-read' | 'file-write' | 'code-execution';
export interface S2PluginCapability {
  id: string;
  kind: 'editor' | 'renderer' | 'transform' | 'validator' | 'action' | 'human';
  meaning: string;
  inputs: S2PluginPort[];
  outputs: S2PluginPort[];
  /** Plugin claims are reviewed by the host at installation; never runtime authority. */
  effect: 'pure' | 'read' | 'external';
  permissions: S2PluginPermission[];
  confirmation: 'none' | 'per-run' | 'per-call';
  /** v1 never automatically retries. This describes how a user-approved retry must behave. */
  retry: 'manual-only' | 'same-idempotency-key';
  timeoutMs: number;
}
export interface S2PluginManifest {
  protocolVersion: 1;
  id: string;
  /** Exact x.y.z release version. v1 has no guessed/ranged dependency upgrades. */
  version: string;
  label: string;
  meaning: string;
  dependencies: Array<{ id: string; version: string }>;
  dataTypes: S2DataType[];
  capabilities: S2PluginCapability[];
}
export interface S2PluginNode { id: string; pluginId: string; pluginVersion: string; capabilityId: string }
export interface S2ExecutionLink { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } }
/** Inline data are immutable snapshots. Ref IDs are host artifact-store handles, NEVER URLs/paths. */
export interface S2Artifact {
  protocolVersion: 1;
  id: string;
  type: S2TypeRef;
  source: { sceneId: string; runId: string; nodeId: string; revision: number; kind: 'user' | 'host' | 'plugin'; invocationId?: string };
  complete: true;
  payload: { kind: 'inline'; value: S2Json } | { kind: 'reference'; artifactRef: string; bytes: number; sha256: string };
}
/** Created from trusted local authorization, never from a model/plugin response or saved manifest. */
export interface S2PluginGrant {
  sceneId: string;
  runId: string;
  capabilities: Array<{ pluginId: string; pluginVersion: string; capabilityId: string }>;
  permissions: S2PluginPermission[];
  /** Exact host resource handles, e.g. approved note/model/endpoint/file sets; never raw paths/URLs. */
  resourceScopes: Array<{ permission: S2PluginPermission; resourceIds: string[] }>;
  readableArtifactIds: string[];
  /** Bound to the host-owned CURRENT canvas revision, not merely the request's revision. */
  revision: number;
  remainingCalls: number;
  confirmedInvocationIds: string[];
}
export interface S2PluginInvocation {
  protocolVersion: 1;
  id: string;
  sceneId: string;
  runId: string;
  nodeId: string;
  revision: number;
  pluginId: string;
  pluginVersion: string;
  capabilityId: string;
  idempotencyKey: string;
  inputs: Record<string, string[]>;
}
/** Adapter reply is untrusted. Host validates all ports/data before issuing a receipt. */
export type S2PluginOutcome =
  | { status: 'succeeded'; outputs: Record<string, S2Artifact[]> }
  | { status: 'failed' | 'cancelled' | 'unknown'; error: { code: string; message: string }; outputs: Record<string, never> };
/** An execution success is NOT a positive content assessment; verdict data live in typed output artifacts. */
export interface S2ExecutionReceipt {
  protocolVersion: 1;
  id: string;
  invocationId: string;
  sceneId: string;
  runId: string;
  revision: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  publication: 'current' | 'stale';
  outputArtifactIds: Record<string, string[]>;
  error?: { code: string; message: string };
}
/** Host constructs this observation after validation. It is not a free-form model memory. */
export interface S2PluginObservation {
  invocationId: string;
  pluginId: string;
  capabilityId: string;
  executionStatus: S2ExecutionReceipt['status'];
  publication: 'current' | 'stale';
  artifacts: Array<{ id: string; type: S2TypeRef; meaning: string; artifactComplete: true; preview: string; previewOmitted: boolean }>;
  error?: { code: string; message: string };
}
/** Host-built event frame. Moving/zooming is local UI state, not an implicit model trigger. */
export interface S2InteractionFrame {
  protocolVersion: 1;
  sceneId: string;
  runId: string;
  revision: number;
  event: { id: string; kind: 'user-message' | 'node-submit' | 'request-check' | 'plugin-completed' | 'workflow-completed'; text?: string; nodeId?: string; invocationId?: string; workflowRunId?: string };
  focusNodeIds: string[];
  availableNodeIds: string[];
  availableArtifactIds: string[];
  observations: S2PluginObservation[];
  /** Human task/scene strategy, never executable authority. */
  strategy: { goal: string; understanding: string; planning: string; response: string };
}
/** Semantic tool intention, not an executable invocation or a grant. Host assigns run/revision/call/idempotency IDs. */
export interface S2PluginRequest {
  nodeId: string;
  pluginId: string;
  pluginVersion: string;
  capabilityId: string;
  inputs: Record<string, string[]>;
  reason: string;
}
/** Passed live by the host at publication, not copied from the original invocation. */
export interface S2PublicationContext { sceneId: string; runId: string; revision: number; active: boolean }
