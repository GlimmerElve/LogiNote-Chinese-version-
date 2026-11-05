export type DataEntity = 'notes' | 'profile' | 'episodes';

export interface DataCenterPaths {
  vaultRoot: string;
  userStateDir: string;
}

export interface AgentDataChangedPayload {
  entity: DataEntity;
  version: number;
  op: 'update';
}

export interface AgentMasteryRequest {
  noteTitles?: string[];
}

export interface AgentMasteryRow {
  noteId: string;
  title: string;
  mastery?: number;
  /** Legacy value only; never a percentage converted from new layer states. */
  historicalMastery?: number;
  masteryState?: import('../../services/masteryReadModel').KnowledgeMasteryView;
  evidenceSamples: number;
  retrievability: number;
  reviewCount: number;
}

export interface AgentReviewQueueItem {
  noteId: string;
  title: string;
  retrievability: number;
  difficulty: number;
  conceptMastery?: number;
  masteryState?: import('../../services/masteryReadModel').KnowledgeMasteryView;
}
