import type { S2CanvasDefinition, S2Document } from './sceneS2';
import type { S2Artifact, S2Json, S2PluginInvocation, S2PluginManifest, S2PluginOutcome } from './sceneS2Plugin';
import type { S2WorkflowNode } from './sceneS2';

import type { SceneInteractionPackRef, SceneInteractionPackManifest, ScenePackMaterialDescriptor, ScenePackMaterialMediaType } from '../../apps/community-api/src/scenePackageTypes';
export type { SceneInteractionPackRef, SceneInteractionPackManifest, SceneInteractionPackManifestV1, SceneInteractionPackManifestV2, ScenePackMaterialDescriptor, ScenePackMaterialMediaType } from '../../apps/community-api/src/scenePackageTypes';

/** Terminal-owned material lifecycle. Reading package assets does not grant access to user files or model inputs. */
export interface ScenePackMaterialScope {
  list(): ScenePackMaterialDescriptor[];
  read(id: string, signal?: AbortSignal): Promise<{ id: string; mediaType: ScenePackMaterialMediaType; data: Uint8Array }>;
  openUrl(id: string, signal?: AbortSignal): Promise<{ url: string; release(): void }>;
  dispose(): void;
}
export interface ScenePackExecutionContext { materials?: ScenePackMaterialScope }
export interface ScenePackComponentGuide {
  id: string;
  name: string;
  purpose: string;
  configuration: string;
  example: S2Json;
  /** Exact capabilities used by this logical component; [] means native canvas content only.
   * When every component declares this field, new discovery starts with their union. */
  capabilities?: Array<{ pluginId: string; pluginVersion: string; capabilityId: string }>;
}
/** One public authoring type. Implementation identities stay in the local package;
 * users and building Agents share the public id, parameters and ports. */
export interface ScenePackPublicComponent {
  id: string;
  label: string;
  purpose: string;
  group?: { id: string; label: string };
  implementation: { kind: 'content'; blockType: S2CanvasDefinition['blockTypes'][number] }
    | { kind: 'capability'; pluginId: string; pluginVersion: string; capabilityId: string };
  /** Connectable native input port ids; content blocks have no input ports. */
  inputs: string[];
  /** Native output ports, or content field ids. */
  outputs: string[];
  /** Editable literal inputs, or editable content fields. */
  parameters: string[];
  /** Initial native literals; undeclared parameters remain fixed at these values. */
  defaults?: Record<string, S2Json>;
}
/** Explicit versioned public boundary. [] means no public components, never all capabilities.
 * Internal objects are package-owned immutable baselines, even if their types are public. */
export interface ScenePackAuthoringCatalog {
  version: 1;
  components: ScenePackPublicComponent[];
  internal?: { blockTypes: S2CanvasDefinition['blockTypes']; document: S2Document };
}
/** Inert manual read by builder/interaction Agents. This is not component implementation code. */
export interface ScenePackDescription {
  purpose: string;
  components: ScenePackComponentGuide[];
  combinations: string[];
  operations: Array<{ id: ScenePackOperation; description: string; parameters: string; errors: string[] }>;
  builder: { assemble: string; repair: string };
  /** Agent guidance only; listing operations does not register tools or grant dispatch authority. */
  assistant: { instructions: string; defaultAllowedOperations: ScenePackOperation[] };
}
/** Agent/user-authored canvas configuration; contains references and values, never bundled code or runtime grants. */
export interface ScenePackConfig {
  /** Scene definition and authored initial baseline. Exact package identity lives in the outer scene/workspace envelope. */
  definition: S2CanvasDefinition;
  /** Current canvas instance snapshot. */
  document: S2Document;
}
export interface ScenePackIssue { path: string; message: string }
/** Operations may be extended by each package. The terminal does not interpret their business meaning. */
export type ScenePackOperation = 'readState' | 'readResult' | 'run' | 'cancel' | (string & {});
export interface ScenePackRun {
  id: string;
  completion: Promise<unknown>;
}
/** Issued by the terminal for one scene/session. Never supplied by a scene JSON or Agent. */
export interface ScenePackHostServices {
  materials?: ScenePackMaterialScope;
  readConfig(): ScenePackConfig;
  validateConfig(config: ScenePackConfig): void;
  applyConfig(config: ScenePackConfig): void;
  run(targets?: string[], notify?: () => void, options?: { force?: boolean }): ScenePackRun;
  cancel(runId: string): void;
  readResults(): unknown;
  /** A declared business event. The terminal supplies source, revision and causal metadata. */
  emitEvent?(nodeId: string, eventId: string, data: S2Json): void;
  close(): void;
}
/** Generic S2 editor helpers. No prompt component names or business policies belong here. */
export interface ScenePackEditorServices {
  readDefinition(raw: unknown): S2CanvasDefinition;
  readDocument(raw: unknown, definition: S2CanvasDefinition): S2Document;
  snapshot<T>(raw: T, limits?: { maxBytes?: number; maxEntries?: number }): T;
  canonicalJson(raw: S2Json): string;
  nodeTitle(node: S2WorkflowNode): string;
  parameterSource(document: S2Document, nodeId: string, portId: string): { key: string; connected: boolean };
}
export interface ScenePackActivationServices {
  editor: ScenePackEditorServices;
  ui: { react: unknown };
}
export type ScenePackNavigationTarget = { kind: 'content'; nodeId: string; fieldId: string }
  | { kind: 'input'; nodeId: string; portId: string; sectionId?: string }
  | { kind: 'settings'; nodeId: string; sectionId?: string };
/** Package-owned geometry for an existing port. Never part of an Agent-authored scene. */
export interface ScenePackPortAnchor {
  side: 'top' | 'right' | 'bottom' | 'left';
  /** Fraction along that edge, from left to right or top to bottom. Defaults to 0.5. */
  offset?: number;
}
export interface ScenePackViewPolicy {
  /** Override ordinary host parameter editors; defaults off for complete/settings views. */
  genericSettings?: boolean;
  /** Ordinary status text; complete node views own it by default. Errors/waits stay visible. */
  showStatus?: boolean;
  inputAnchors?: Record<string, ScenePackPortAnchor>;
  outputAnchors?: Record<string, ScenePackPortAnchor>;
  /** Exact real port IDs. Omitted means the normal canvas port list. */
  visibleNodeInputs?: string[];
  /** Presentation labels for exact existing input ports; never changes their identity or type. */
  inputLabels?: Record<string, string>;
  /** Controls the node's result preview only. Artifacts remain available to connected consumers. */
  showResult?: boolean;
  /** Explicitly renders resourceInput inside the package view; omitted keeps the host's existing picker. */
  resourceInputInView?: boolean;
  /** Embeds the node-scoped native human/model wait UI; otherwise the host shows it on this node. */
  interactionInputInView?: boolean;
  hiddenSettingsInputs?: string[];
  inputActions?: Record<string, { label: string; run(): void }>;
  addInput?: { label: string; disabled: boolean; run(): void };
  annotation?: string;
}
export interface ScenePackViewContext {
  materials?: ScenePackMaterialScope;
  /** Opaque terminal identity for async view work; never a package path or a saved scene field. */
  materialScopeKey?: string;
  definition: S2CanvasDefinition;
  document: S2Document;
  node: S2WorkflowNode;
  active: boolean;
  /** Authoring access is separate from view/material lifetime. Internal read-only
   * views stay active but cannot submit edits; the terminal enforces this boundary. */
  editable?: boolean;
  /** Detached results for this exact node. Stale outputs are never presented as current artifacts. */
  results?: { status: string; stale: boolean; artifacts: ReadonlyArray<S2Artifact> };
  model?: { supportsThinking?: boolean; maxOutputTokens?: number };
  /** Optional terminal-rendered local resource input for this exact node. */
  resourceInput?: unknown;
  /** Native pending human input/model request controls for this exact node, with guarded submit/cancel. */
  interactionInput?: unknown;
  /** An explicit user action; scheduling and all grants remain owned by the terminal. */
  execution?: {
    enabled: boolean;
    running?: boolean;
    status?: string;
    error?: string;
    run(targetNodeIds?: string[]): void;
    cancel?(): void;
  };
  /** Terminal-owned state is scoped to exact package, scene and node; it never enters saved scene JSON. */
  state: { get<T>(key: string): T | undefined; initialize<T>(key: string, create: () => T): T; set(key: string, value: unknown): void; delete(key: string): void };
  guard(): void;
  readCurrent(): ScenePackConfig;
  registerPanel(target: ScenePackNavigationTarget, element: HTMLElement | null): void;
  navigate(target: ScenePackNavigationTarget): void;
  focusSettings(): void;
  nodeLabel(nodeId: string): string;
  inputLabel(nodeId: string, portId: string): string;
  onNotice(message: string): void;
  onDocumentChange(document: S2Document): void;
  onInputChange(portId: string, binding: import('./sceneS2').S2InputBinding | null, sourceKey: string): void;
  onError(message: string): void;
}
/** Package-owned session orchestration, instantiated only when execution is requested. */
export interface SceneInteractionRuntime {
  updateConfig(config: ScenePackConfig): void;
  dispatch(operation: ScenePackOperation, input?: { targets?: string[]; runId?: string; force?: boolean; [key: string]: unknown }, notify?: () => void): unknown;
  run(targets?: string[], notify?: () => void, options?: { force?: boolean }): ScenePackRun;
  dispose(): void;
}
/** Optional canvas presentation. Keys identify real pluginId/capabilityId declarations. */
export type ScenePackCapabilityViews = Record<string, {
  settings?: unknown;
  inline?: unknown;
  /** Complete package-owned node body; the host still owns handles and runtime feedback. */
  node?: unknown;
  /** Local user gesture only. Updates must use the guarded context callbacks. */
  onDoubleClick?: (context: ScenePackViewContext) => void;
  policy?: (context: ScenePackViewContext) => ScenePackViewPolicy;
}>;
/** User-facing explanations and labels, separate from the Agent manual and executable views. */
export type ScenePackCapabilityHelp = Record<string, {
  when: string; example: string; difference: string; category?: string; hideLiteralInputs?: string[];
  title?: string; description?: string; inputLabels?: Record<string, string>; outputLabels?: Record<string, string>;
}>;
/** Package-owned canvas presentation. These declarations never grant or restrict runtime authority. */
export interface ScenePackCanvasPolicy {
  contentEditing?: 'panel' | 'inline' | 'double-click';
  openSettingsOnSelect?: boolean;
  contentSettings?: 'show' | 'hide';
  /** @deprecated Accepted for old package metadata only; both values have no UI effect.
   * All packages own their execution controls. The host provides no default run panel. */
  executionUi?: 'panel' | 'inline';
  addMenu?: {
    /** The terminal expands this entry using the current scene's real blockTypes. */
    contentLabel?: string;
    groups: Array<{ id: string; label: string; capabilities: Array<{ pluginId: string; pluginVersion: string; capabilityId: string; defaults?: Record<string, S2Json> }> }>;
    /** Unlisted composable capabilities remain visible unless explicitly hidden here. */
    otherCapabilities?: 'show' | 'hide';
  };
}
/** Shared assembly interface for v1/v2 envelopes. Source modules are separate; distribution is one browser ESM entry. */
export interface SceneInteractionPack {
  manifest: SceneInteractionPackManifest;
  /** Returns fresh plain data. Descriptions never carry executable authority. */
  describe(): ScenePackDescription;
  /** Package business rules. Terminal also invokes this before execution, while drafts remain saveable. */
  validate(config: ScenePackConfig): ScenePackIssue[];
  createRuntime(config: ScenePackConfig, host: ScenePackHostServices): SceneInteractionRuntime;
  /** Machine-readable component/port/type declarations, exposed to the terminal and Agent catalogue. */
  capabilities: S2PluginManifest[];
  /** Full capabilities above retain internal implementations. This separate directory
   * is the only public authoring surface; omission uses the explicit legacy adapter. */
  authoring?: ScenePackAuthoringCatalog;
  /** Trusted local package policy, never writable by a scene or Agent.
   * Omitted keeps legacy on-demand execution. Editing never implies execution. */
  execution?: 'none' | 'on-demand';
  /** Inert custom event declarations; scene triggers remain in the scene configuration. */
  interaction?: import('./sceneS2Interaction').S2PackInteraction;
  /** Optional executable views keyed by existing capability identity, provided by a trusted entry module. */
  views?: ScenePackCapabilityViews;
  help?: ScenePackCapabilityHelp;
  /** Optional declarative canvas UX; omitted preserves the terminal's existing behavior. */
  canvas?: ScenePackCanvasPolicy;
  /** Component implementation. Only the host calls this with resolved inputs; the Agent never implements transport. */
  executeLocal(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal, context?: ScenePackExecutionContext): Promise<S2PluginOutcome>;
}
/** Developer entry before terminal normalization. An explicit authoring directory
 * permits omitting Agent guidance; the terminal supplies a small normalized manual. */
export type SceneInteractionPackDefinition = Omit<SceneInteractionPack, 'describe' | 'authoring'> & (
  { authoring: ScenePackAuthoringCatalog; describe?: () => ScenePackDescription }
  | { authoring?: undefined; describe: () => ScenePackDescription }
);
