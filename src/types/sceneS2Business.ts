import type { S2Document } from './sceneS2';
import type { S2Json, S2PluginNode } from './sceneS2Plugin';

/** Declarative business guidance. Never executable code, a grant or an execution receipt. */
export type S2BusinessCapability = Omit<S2PluginNode, 'id'>;
export type S2BusinessRule =
  | { kind: 'text-includes'; value: string }
  | { kind: 'text-length'; min: number; max: number }
  | { kind: 'json-pointer-equals'; pointer: string; value: S2Json };
export interface S2BusinessCriterion {
  id: string;
  label: string;
  expectation: string;
  method: 'local' | 'semantic' | 'advisory';
  required: boolean;
  /** Exactly one INITIAL content field or single-value execution output. Later deletion/missing results are uncertain, never an editing lock. */
  target?: { nodeId: string; fieldId?: string; portId?: string };
  rule?: S2BusinessRule;
}
export interface S2BusinessPackage {
  version: 1;
  purpose: string;
  knowledge: Array<{ id: string; title: string; content: string }>;
  workflow: Array<{ id: string; goal: string; actor: 'user' | 'agent' | 'tool'; capabilities: S2BusinessCapability[]; input: string; output: string }>;
  completion: {
    mode: 'execution' | 'canvas';
    /** Private static feasibility witness, NOT the initial exercise or a result to show the learner. */
    reference: S2Document;
    targetNodeIds: string[];
    coverage: Array<{ requirementId: string; stepIds: string[]; nodeIds: string[];
      /** Public policy/UI evidence for non-tool responsibilities only; never a replacement for executable feasibility. */
      evidencePaths?: string[] }>;
  };
  criteria: S2BusinessCriterion[];
}
