import type { LlmProvider } from '../../types';

export interface NewLlmProviderDraft {
  open: boolean;
  provider: Partial<LlmProvider>;
  contextInput?: string;
}

const emptyDraft = (): NewLlmProviderDraft => ({
  open: false, provider: { apiType: 'openai-compatible', enabled: true },
});

// New, unsubmitted credentials belong only to this renderer's memory. Keeping
// the draft outside the panel preserves it across navigation without writing
// API keys to another browser/disk cache or making an incomplete route usable.
let draft = emptyDraft();
export function readNewLlmProviderDraft(): NewLlmProviderDraft { return draft; }
export function updateNewLlmProviderDraft(update: Partial<NewLlmProviderDraft>): void {
  draft = { ...draft, ...update };
}
export function clearNewLlmProviderDraft(): void { draft = emptyDraft(); }
