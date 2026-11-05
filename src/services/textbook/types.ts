/** 教材正文仍在 NoteItem.content；这里仅保存身份与来源边界。 */
export interface TextbookManifest {
  schemaVersion: 1;
  textbookId: string;
  projectNoteId: string;
  rootProjectId: string;
  revisionId: string;
  regionId: string;
  createdAt: string;
  updatedAt: string;
  generationJobId?: string;
  /** Shareable source pointers, never raw profile/cognition/review evidence. */
  sources?: Array<{ sourceId: string; kind: 'document' | 'knowledge' | 'web'; id: string; title: string; version: string; locator?: import('../../types').SourceLocator;
    blockId?: string; textStart?: number; textEnd?: number; web?: import('./webTypes').TextbookWebPointer }>;
  /** Only scoped pointers are persisted. Optional vision requests read raster bytes separately. */
  assets?: TextbookImageAsset[];
  chapters?: Array<{ id: string; title: string }>;
}

export interface TextbookImageAsset {
  /** Local content hash; image bytes remain separate from notes and checkpoints. */
  attachmentHash?: string;
  /** Original public image URL for attribution; rendering uses local attachment bytes only. */
  originUrl?: string;
  id: string;
  sourceId: string;
  docId: string;
  version: string;
  blockId: string;
  imageIndex: number;
  alt: string;
}

export type LearningReviewStatus = 'pending_analysis' | 'text_only' | 'analysis_failed' | 'analyzed' | 'completed';

/** 个人状态；图数据只在既有 argumentDocs 中保存，不复制图或改变发布状态。 */
export interface LearningReviewRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  projectNoteId: string;
  rootProjectId: string;
  textbookRevisionId?: string;
  startedAt: string;
  endedAt: string;
  title: string;
  userEditedTitle: boolean;
  rawRestatement: string;
  editedRestatement: string;
  userEditedRestatement: boolean;
  summary: string;
  /** 心流分析生成的简短结果摘要；不参与画像回算。 */
  analysisSummary?: string;
  /** 本次知识点评价凭据；独立掌握状态不依赖此复盘块是否保留。 */
  masteryAssessment?: import('../masteryShadow/flow').FlowMasteryBatch;
  /** 本次增量的绑定键；原始复盘全文仍由 rawRestatement 保留。 */
  masteryInputKey?: string;
  episodeId: string;
  argumentDocIds: string[];
  /** Private source coordinate for the text actually analyzed, not a grade or publication gate. */
  argumentRestatementKey?: string;
  status: LearningReviewStatus;
  error?: string;
  /** 个人展开状态不导出到教材正文。 */
  expanded?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LearningContentMigration {
  schemaVersion: 1;
  /** 保守迁移：无法配对的旧内容原位保留，并保留完整可恢复快照。 */
  originalContent: string;
  originalArgumentDocIds: string[];
}

export interface TextbookReadingState {
  revisionId: string;
  blockAnchor?: string;
  scrollTop?: number;
  lastReadAt: string;
}

export type LearningReviewPatch = Pick<Partial<LearningReviewRecord>, 'title' | 'editedRestatement' | 'expanded'>;
