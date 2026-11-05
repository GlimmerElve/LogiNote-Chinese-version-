import type { S2ExecutionLink, S2Json, S2PluginNode } from './sceneS2Plugin';
import type { S2BusinessCriterion, S2BusinessPackage } from './sceneS2Business';
import type { S2AssessmentReport } from '../services/scene/sceneS2Assessment';
/** S2 trial contracts. Never reuse S4 proof/score/compute state. */
export interface S2TableColumn { id: string; label: string; type: 'string' | 'number' | 'boolean'; required?: boolean; nullable?: boolean }
export interface S2ChartView { kind: 'bar' | 'line'; xKey: string; yKey: string }
export interface S2Field {
  id: string; label: string; kind: 'text' | 'multiline' | 'number' | 'enum' | 'boolean' | 'list' | 'form' | 'table' | 'json' | 'code';
  required?: boolean; defaultValue?: S2Json; maxLength?: number;
  min?: number; max?: number; integer?: boolean; options?: string[];
  minItems?: number; maxItems?: number; item?: S2Field; fields?: S2Field[];
  columns?: S2TableColumn[]; view?: S2ChartView; language?: 'plain' | 'javascript' | 'typescript' | 'python' | 'sql' | 'json';
}
export interface S2BlockType { id: string; label: string; fields: S2Field[]; advanced?: boolean }
/** Optional label is a display name only; data meaning is determined by fields and explicit bindings.
 * readOnly fixes this instance's type, values and true flag during preview/running interaction.
 * Omitted/false stays editable. Labels, layout and connections are separate from content locking.
 * Scene-authored fixed instances remain present; a derived copy may be removed/undone.
 */
export interface S2Block { id: string; type: string; componentId?: string; label?: string; readOnly?: boolean; position: { x: number; y: number }; values: Record<string, string> }
export interface S2Link { id: string; source: string; target: string; label: string }
export type S2InputBinding = { kind: 'field'; nodeId: string; fieldId: string } | { kind: 'literal'; value: S2Json };
export interface S2WorkflowCondition { nodeId: string; portId: string; pointer: string; equals: S2Json; match: boolean }
/** Display-only vocabulary mapped to real ports, never executable configuration or authority. */
export interface S2NodePresentation { label: string; description?: string; inputs?: Record<string, string>; outputs?: Record<string, string>; inputForms?: Record<string, S2Field>; responseForm?: S2Field }
/** componentId preserves the public authoring identity; it is not execution authority. */
export interface S2WorkflowNode extends S2PluginNode { componentId?: string; position: { x: number; y: number }; bindings: Record<string, S2InputBinding>; when?: S2WorkflowCondition; presentation?: S2NodePresentation }
export interface S2Workflow { version: 1; nodes: S2WorkflowNode[]; links: S2ExecutionLink[] }
export interface S2Group { id: string; label: string; nodeIds: string[]; collapsed: boolean }
export interface S2Document { nodes: S2Block[]; edges: S2Link[]; execution?: S2Workflow; groups?: S2Group[]; composites?: import('./sceneS2Composite').S2CanvasComposite[]; blueprints?: import('./sceneS2Composite').S2CompositeDesign[] }
export type S2BatchAction = { kind: 'copy' | 'delete' | 'move'; nodeIds: string[]; delta?: { x: number; y: number }; compositeId?: string };
/** Design context, never a permission grant, execution receipt or lasting acceptance certificate. */
export interface S2DesignBrief {
  goal: string;
  requirements: Array<{ id: string; description: string; source: 'task' | 'subject' | 'currentGoal' | 'currentPolicy' | 'knowledgePointTitle'; quote: string }>;
  userRole: string;
  agentRole: string;
  assumptions: string[];
  openQuestions: string[];
  /** Scope summary, not permission or proof that deferred work is complete. Legacy briefs may omit it. */
  delivery?: { initial: string; deferred: string; source: S2DesignBrief['requirements'][number]['source']; quote: string };
}
export interface S2CanvasDefinition {
  version: 1;
  goal: string;
  instructions: { understanding: string; planning: string; response: string };
  blockTypes: S2BlockType[];
  initial: S2Document;
  /** Optional scene-owned interaction tasks; no event callback code or runtime grants. */
  interaction?: import('./sceneS2Interaction').S2InteractionConfig;
  designBrief?: S2DesignBrief;
  /** Optional experiment expectations. Guidance/assessment only, never model input or execution authority. */
  criteria?: S2BusinessCriterion[];
  /** Versioned scene-local business guidance and private completion witness; never a runtime grant. */
  business?: S2BusinessPackage;
  /** Assembly selection only. A fresh host grant is required on every run. */
  plugins?: Array<{ pluginId: string; pluginVersion: string; capabilityId: string }>;
}
export type S2Command =
  | { op: 'add-node'; node: S2Block }
  | { op: 'update-node'; id: string; values: Record<string, string>; label?: string }
  | { op: 'remove-node'; id: string }
  | { op: 'add-edge'; edge: S2Link }
  | { op: 'remove-edge'; id: string };
export type S2WorkflowCommand =
  | { op: 'add-execution-node'; node: S2WorkflowNode }
  | { op: 'update-execution-node'; id: string; bindings: Record<string, S2InputBinding> }
  | { op: 'set-execution-condition'; id: string; when: S2WorkflowCondition | null }
  | { op: 'remove-execution-node'; id: string }
  | { op: 'unbind-input'; id: string; portId: string }
  | { op: 'connect-ports' | 'disconnect-ports'; link: S2ExecutionLink };
export type S2LayoutCommand = { op: 'set-group'; group: S2Group } | { op: 'remove-group'; id: string } | { op: 'batch-nodes'; action: S2BatchAction }
  | { op: 'set-composite'; composite: import('./sceneS2Composite').S2CanvasComposite } | { op: 'remove-composite'; id: string }
  | { op: 'move-composite'; id: string; parentId: string | null }
  | { op: 'instantiate-blueprint'; id: string; version: string; parentId?: string; values?: import('./sceneS2Composite').S2CompositeValues; instanceKey?: string };
export interface S2AgentReply { understanding: string; plan: string; reply: string; commands: Array<S2Command | S2WorkflowCommand | S2LayoutCommand>; pluginRequests?: import('./sceneS2Plugin').S2PluginRequest[]; executionRequest?: { targetNodeIds: string[]; reason: string; force?: boolean }; assessment?: S2AssessmentReport; comparison?: import('../services/scene/sceneS2Trials').S2TrialComparison }
