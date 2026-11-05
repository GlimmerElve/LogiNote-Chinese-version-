/** Only URLs already selected and attached to the target project can enter this scope. */
export interface TextbookBoundUrl { id: string; url: string; title: string; resourceType?: string }
export interface TextbookWebPointer {
  snapshotId: string; url: string; finalUrl: string; readAt: string;
  contentType: string; format: 'html' | 'document' | 'text' | 'transcript';
  transcriptUrl?: string;
  /** Explicitly distinguish publicly displayed abstracts from an article's full body. */
  contentKind?: 'article' | 'abstract';
  acquisition?: 'anonymous_browser' | 'provider_api';
  coverage: 'full_text' | 'excerpt';
}
export interface TextbookWebSnapshot {
  schemaVersion: 1; jobId: string; resourceId: string; version: string; title: string;
  web: TextbookWebPointer; text: string;
  assets?: import('./types').TextbookImageAsset[];
}
export interface TextbookWebReadRequest { jobId: string; token: string; resourceId: string }
export interface TextbookWebEvidenceRequest {
  projectNoteId: string; sourceId: string; snapshotId: string; version: string; cursor?: number;
}
export interface TextbookWebReadStatus { id: string; title: string; status: 'saved' | 'failed'; error?: string }
