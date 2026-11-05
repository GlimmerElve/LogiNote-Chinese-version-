import type {ArgumentFunctionType} from '../types';

/** Separate from the legacy scoring/cognition schemas. Offsets are local UTF-16 chunk coordinates. */
export interface DocumentGraphSource {chunkId: string; start: number; end: number}
export interface DocumentGraphNode {
  id: string; graphId: string; type: ArgumentFunctionType; source: DocumentGraphSource[];
}
export interface DocumentGraphRelation {
  id: string; kind: 'support' | 'oppose' | 'explain'; from: string[]; to: string; reason: string;
}
export interface DocumentGraphEntity {
  id: string; name: string;
  /** References are scoped occurrences, never global aliases such as “该实验”. */
  mentions: Array<{nodeId:string; quote:string; reference:boolean;
    /** Exact UTF-16 range in the host-replayed node text. Optional only for legacy entries. */
    source?:{start:number;end:number}}>; 
}
export interface DocumentGraphEntityRelation {
  from:string; to:string; predicate:string; evidenceNodeIds:string[];
}
export interface DocumentGraphBuild {
  version:'document-pipeline-v1'; completedWindowIds:string[]; totalWindows:number; windowPlanFingerprint:string;
}
export interface DocumentGraphWindow {
  id:string; section:string; parts:DocumentGraphSource[];
}
export interface DocumentGraphCommit {
  docId: string; sourceFingerprint: string; previousRevision: string | null;
  nodes: DocumentGraphNode[]; relations: DocumentGraphRelation[]; unresolved: string[];
  entities?:DocumentGraphEntity[]; entityRelations?:DocumentGraphEntityRelation[]; build?:DocumentGraphBuild;
}
export interface DocumentGraphSourceSnapshot {
  docId: string; sourceFingerprint: string; previousRevision: string | null;
  chunks: Array<{id: string; sectionPath: string; content: string}>;
  windows?:DocumentGraphWindow[];
  current?:DocumentGraphCommit;
  limitations?:string[];
  environmentId?:string;
  windowPlanFingerprint?:string;
}
export interface SavedDocumentGraph extends DocumentGraphCommit {
  schemaVersion: 1; revision: string; embeddingModel: 'paraphrase-multilingual-MiniLM-L12-v2';
  nodes: Array<DocumentGraphNode & {text: string; embedding: number[]}>;
  entities?:Array<DocumentGraphEntity & {embedding:number[]}>;
  semanticCertified: false;
}
