import type { NoteItem, NoteSearchResult, DocumentSearchResult, DocumentPreview, SourceLocator } from '../../types';
import type { CognitionFile, CognitionGraph, CognitionStance } from '../cognition/types';
import type { ReviewQuestionIntent } from '../reviewIntent';
import type { ReviewAnswerEvidence } from '../memory/types';

export interface ReviewComparisonAnswer {
  activityId: string;
  evidence: ReviewAnswerEvidence & { messageId: string; questionIntent: ReviewQuestionIntent };
  questionText: string;
}

export interface ReviewPersonalSnapshot {
  status: 'ready' | 'not_requested' | 'unavailable' | 'stale_target' | 'target_missing';
  branchHash?: string;
  title?: string;
  context?: string;
  stance?: CognitionStance;
  graph?: CognitionGraph;
  reviewNeededNodeIds?: string[];
  truncated: boolean;
}

export interface ReviewReferenceSnapshot {
  sourceId: string;
  corpus: 'reference';
  kind: 'target-note' | 'related-note' | 'external-document';
  entityId: string;
  title: string;
  chunkId?: string;
  sectionPath?: string;
  sourceLocators?: SourceLocator[];
  text: string;
  /** Exact character interval in the original note body or chunk. */
  textStart: number;
  textEnd: number;
  contentLength: number;
  contentHash: string;
  truncated: boolean;
  version: {
    updatedAt?: string;
    /** Full saved reference descriptor, including citation provenance. Optional for historical packets. */
    referenceSourceHash?: string;
    generationId?: string;
    indexSchemaVersion?: number;
    retrievalVersion?: number;
  };
}

/** Read-only preparation. Semantic alignment and both writes are later stages. */
export interface ReviewComparisonPacket {
  version: 1;
  packetId: string;
  snapshotHash: string;
  activityId: string;
  messageId: string;
  questionText: string;
  questionIntent: ReviewQuestionIntent;
  answer: { text: string; hintLevel: 0 | 1 | 2 | 3 | 4; consultedMaterialIds: string[] };
  personal: ReviewPersonalSnapshot;
  references: ReviewReferenceSnapshot[];
  coverage: {
    referencePresence: 'available' | 'insufficient_reference';
    semanticCoverage: 'not_assessed';
    missingTargetNames: string[];
  };
  preparation: {
    cognitionGrowth: 'pending_alignment' | 'held';
    mastery: 'pending_alignment' | 'held';
    growthReasons: string[];
    masteryReasons: string[];
    warnings: string[];
  };
}

export interface ReviewComparisonDependencies {
  readNotes(): Promise<NoteItem[]>;
  loadCognition(): Promise<CognitionFile>;
  searchNotes(query: string, limit: number, options?: { allowedNoteIds: string[] }): Promise<NoteSearchResult[]>;
  searchDocuments(query: string, limit: number): Promise<DocumentSearchResult[]>;
  previewDocument(docId: string, chunkId: string): Promise<DocumentPreview>;
}

export interface ReviewComparisonSummary {
  version: 1;
  status: 'prepared' | 'partial' | 'unavailable';
  preparedAnswers: number;
  omittedAnswers: number;
  referencesAvailable: number;
  cognitionTargetsResolved: number;
  holdReasons: string[];
  /** Hashes/pointers only; do not persist private graph bodies or document text here. */
  snapshots: { packetId: string; snapshotHash: string }[];
}

export interface ReviewComparisonSession {
  packets: ReviewComparisonPacket[];
  summary: ReviewComparisonSummary;
}
