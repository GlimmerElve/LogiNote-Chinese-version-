import type { S2Json, S2ValueSchema } from './sceneS2Plugin';
import type { S2PublicCanvas } from '../services/scene/sceneS2PublicAuthoring';

/** Interaction speaks the same public component vocabulary as canvas authoring. */
export type S2InteractionActionKind = 'reply' | 'edit' | 'execute';
export interface S2InteractionScope {
  actions: S2InteractionActionKind[];
  /** Omission means all public objects in the current scene, never private instances. */
  nodeIds?: string[];
}
export interface S2InteractionTrigger {
  id: string;
  on: { event: string; nodeId: string };
  task: string;
  /** Omitted actions mean reply only. This is configuration, not an assistant toggle. */
  scope?: Partial<S2InteractionScope>;
}
export interface S2InteractionConfig { version: 1; triggers: S2InteractionTrigger[] }
export interface S2InteractionEventDeclaration { id: string; purpose: string; dataSchema: S2ValueSchema }
export interface S2PackInteraction { version: 1; events: S2InteractionEventDeclaration[] }
/** Terminal-owned causal envelope. It is never accepted from model output. */
export interface S2InteractionEvent {
  id: string;
  type: string;
  nodeId: string;
  data: S2Json;
  causeId: string;
  chain: string[];
  revision: number;
  /** Local source binding only; never serialize it into an Agent request. */
  invocationId?: string;
}
export type S2InteractionAction =
  | { type: 'addNode'; node: S2PublicCanvas['nodes'][number] }
  | { type: 'setValues'; nodeId: string; values: Record<string, S2Json> }
  | { type: 'removeNode'; nodeId: string }
  | { type: 'connect' | 'disconnect'; connection: S2PublicCanvas['connections'][number] }
  | { type: 'run'; targetNodeIds: string[] }
  | { type: 'cancel'; runId: string };
/** Omitted categories read the field/port index; named categories read complete constraints. */
export interface S2InteractionInterfaceRead {
  componentId: string;
  parameters?: string[];
  inputs?: string[];
  outputs?: string[];
}
/** Read complete values only for named parameters of a public instance. */
export interface S2InteractionValueRead {
  nodeId: string;
  parameterIds: string[];
}
export interface S2InteractionRead {
  nodeIds?: string[];
  values?: S2InteractionValueRead[];
  /** Compatibility path for a whole component interface. */
  componentIds?: string[];
  interfaces?: S2InteractionInterfaceRead[];
  resultIds?: string[];
  /** Read the selected package's complete Agent instructions only when needed. */
  packageInstructions?: true;
  /** Read the configured event payload only when the current task needs it. */
  eventData?: true;
}
export interface S2InteractionResponse {
  reply?: string;
  actions?: S2InteractionAction[];
  /** A read response cannot execute actions in the same model result. */
  read?: S2InteractionRead;
}
