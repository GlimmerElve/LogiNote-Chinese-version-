import type { PlanBuilderDraftValue } from '../../components/PlanBuilder';
interface SavedDraft { version: 1; base: string; value: PlanBuilderDraftValue }
export const planDraftKey = (id?: string) => `loginote_manual_plan_draft_v1:${id || 'new'}`;
export function loadManualPlanDraft(key: string | undefined, base: string): PlanBuilderDraftValue | null {
  if (!key) return null;
  try {
    const record = JSON.parse(localStorage.getItem(key) || 'null') as SavedDraft | null;
    if (record?.version !== 1 || record.base !== base || !Array.isArray(record.value?.tree) || record.value.tree.length !== 1
      || !record.value.tree[0] || !record.value.planMeta) return null;
    return record.value;
  } catch { return null; }
}
export function saveManualPlanDraft(key: string | undefined, base: string, value: PlanBuilderDraftValue) {
  if (!key) return;
  const raw = localStorage.getItem(key);
  let previous: SavedDraft | null = null;
  try { previous = JSON.parse(raw || 'null'); } catch { /* Corrupt entries have no valid draft to archive. */ }
  // Keep a recoverable copy when the published base changed while the editor was away.
  if (previous?.version === 1 && previous.base !== base && raw) localStorage.setItem(`${key}:previous`, raw);
  localStorage.setItem(key, JSON.stringify({ version: 1, base, value } satisfies SavedDraft));
}
export function loadConflictingManualPlanDraft(key: string | undefined, base: string): PlanBuilderDraftValue | null {
  if (!key) return null;
  try {
    const record = JSON.parse(localStorage.getItem(key) || 'null') as SavedDraft | null;
    const archived = JSON.parse(localStorage.getItem(`${key}:previous`) || 'null') as SavedDraft | null;
    const conflicting = record?.base !== base ? record : archived;
    return conflicting?.version === 1 && conflicting.base !== base && conflicting.value?.tree?.length === 1
      && conflicting.value.planMeta ? conflicting.value : null;
  } catch { return null; }
}
export function clearManualPlanDraft(key: string | undefined) {
  if (key) { localStorage.removeItem(key); localStorage.removeItem(`${key}:previous`); }
}
