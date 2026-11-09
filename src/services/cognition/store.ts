import { adoptPendingReviewAnswers, applyCognitionMutation, emptyCognitionFile, parseCognitionFile } from './core.ts';
import type { CognitionFile, CognitionMutation } from './types';
import type { ReviewEpisodeCapture } from '../memory/types';
import { reviewCognitionObservations } from './observations.ts';
import { readCognitionRetrieval, retrieveCurrentCognition, withCognitionNeighborhood, type CognitionRetrieval } from './retrieval.ts';
import { retrieveProjectMaterials, retrievePublishedMaterials } from './materials.ts';
import { readNotesForCognition } from '../storage';
import { savedFlowReviewGraphs, retrieveFlowReviewGraphs } from './flowReviewMaterials';
import type { NoteItem } from '../../types';

const KEY = 'loginote-personal-cognition-v1';
const EVENT = 'loginote:cognition-changed';
type CognitionApi = {
  loadCognition?: () => Promise<CognitionFile>;
  searchCognition?: (query: string) => Promise<CognitionRetrieval>;
  mutateCognition?: (input: CognitionMutation) => Promise<CognitionFile>;
  onCognitionChanged?: (callback: () => void) => () => void;
  getAgentTaskScope?: () => Promise<string>;
};
function getApi(): CognitionApi | undefined {
  const electron = (window as unknown as { electronAPI?: { userState?: CognitionApi } }).electronAPI;
  if (electron && !electron.userState) throw new Error('桌面端私人存储接口不可用，请重启应用；不会改写到浏览器临时库');
  return electron?.userState;
}

function browserCognition(): CognitionFile {
  const raw = localStorage.getItem(KEY);
  return raw ? parseCognitionFile(JSON.parse(raw)) : emptyCognitionFile();
}
async function loadCognitionSource(): Promise<CognitionFile> {
  const api = getApi();
  if (api) {
    if (!api.loadCognition) throw new Error('请重启桌面应用以加载新的认知库接口');
    return parseCognitionFile(await api.loadCognition());
  }
  return browserCognition();
}

/** Automatic ingestion is local and source-bound, not a model inference of beliefs. */
export async function loadPersonalCognition(): Promise<CognitionFile> {
  const file = await loadCognitionSource();
  if (getApi()) return file; // Desktop upgrades pending answers under its file lock.
  const projected = adoptPendingReviewAnswers(file, { id: 'preview', at: new Date().toISOString() });
  if (projected === file) return file;
  const observations = (file.candidates || []).flatMap(candidate => candidate.status === 'pending' ? [candidate.observation] : []);
  for (let i = 0; i < observations.length; i += 500) await savePersonalCognition({ kind: 'record_review', enabled: true, observations: observations.slice(i, i + 500) });
  return loadCognitionSource();
}

/** Compatibility hook for older note writers. Saving a review or graph is not
 * permission to adopt it as personal cognition. Only the explicit editor action
 * or the native source-checked confirmation transaction may do so. */
export async function captureRestatementCognition(_note: NoteItem, _recordId?: string): Promise<void> { }

/** Reading must never adopt unconfirmed reviews. Existing private records stay
 * unchanged: this entry deliberately performs no scan, backfill or migration. */
export async function syncSavedRestatementsForCognition(): Promise<{ warning: string }> {
  return { warning: '' };
}

export async function searchCurrentPersonalCognition(query: string): Promise<CognitionRetrieval> {
  const api = getApi(), scope = await api?.getAgentTaskScope?.();
  const { warning: syncWarning } = await syncSavedRestatementsForCognition();
  if (scope && scope !== await api?.getAgentTaskScope?.()) throw new Error('认知资料库已切换，请重新查询');
  if (api?.searchCognition) {
    const result = readCognitionRetrieval(await api.searchCognition(query));
    if (!result) throw new Error('个人认知检索结果无效');
    if (scope && scope !== await api.getAgentTaskScope?.()) throw new Error('认知资料库已切换，请重新查询');
    return { ...result, warning: `${syncWarning}${result.warning}` };
  }
  const file = await loadPersonalCognition();
  const result = withCognitionNeighborhood(file, retrieveCurrentCognition(file, query));
  // Never fall back to a public/possibly stale browser vault on desktop.
  if (api) return { ...result, materialsStatus: 'unavailable', warning: `${syncWarning}请重启桌面应用启用个人素材检索。${result.warning}` };
  try {
    const notes = await readNotesForCognition();
    const inputs = notes.map((note) => ({ ...note, publishedArguments: (note.argumentDocs || []).flatMap((doc) =>
      doc.rag?.publishedSnapshot ? [{ argumentDocId: doc.doc_id, snapshot: doc.rag.publishedSnapshot }] : []) }));
    return { ...result, materialsStatus: 'ready', materials: [...retrieveProjectMaterials(inputs, query).slice(0, 2),
      ...retrieveFlowReviewGraphs(notes.flatMap(savedFlowReviewGraphs), query), ...retrievePublishedMaterials(inputs, query)],
      warning: `${syncWarning}网页模式仅支持词项检索。未接入自动记录的项目素材和图不代表已认同。${result.warning}` };
  } catch {
    return { ...result, materialsStatus: 'unavailable', warning: `${syncWarning}个人素材读取失败，不等于没有素材。${result.warning}` };
  }
}

export async function savePersonalCognition(input: CognitionMutation): Promise<CognitionFile> {
  // Protect browser mode and older renderer callers as well. Progressive review
  // confirmation is committed by its native authority, not by this adapter.
  if (input.kind === 'record_restatements') throw new Error('复盘认知需要核对论证图后明确确认写入。');
  const api = getApi();
  let next: CognitionFile;
  if (api) {
    if (!api.mutateCognition) throw new Error('请重启桌面应用以加载新的认知库接口');
    next = parseCognitionFile(await api.mutateCognition(input));
  } else {
    // Cross-tab lock rather than an unsafe renderer-local read/modify/write queue.
    if (!navigator.locks) throw new Error('当前浏览器不支持安全的多窗口认知写入，请使用桌面端或 localhost');
    next = await navigator.locks.request(KEY, async () => {
      const state = applyCognitionMutation(browserCognition(), input, { id: crypto.randomUUID(), at: new Date().toISOString() });
      localStorage.setItem(KEY, JSON.stringify(state));
      return state;
    });
  }
  window.dispatchEvent(new Event(EVENT));
  return next;
}

/** Called once at an activity boundary; idempotent source IDs make retry safe. */
export async function captureReviewCognition(episode: ReviewEpisodeCapture, note: { id?: string; title: string }, enabled = true): Promise<void> {
  if (!enabled) return;
  const observations = reviewCognitionObservations(episode, note);
  if (!observations.length) return;
  const storageScopeId = await getApi()?.getAgentTaskScope?.();
  await savePersonalCognition({ kind: 'record_review', enabled: true, observations, ...(storageScopeId ? { storageScopeId } : {}) });
}

export function subscribePersonalCognition(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) callback(); };
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', onStorage);
  // A missing bridge is reported by load/save, not thrown from a React effect subscription.
  let off: (() => void) | undefined;
  try { off = getApi()?.onCognitionChanged?.(callback); } catch { /* load reports the actionable error */ }
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', onStorage); off?.(); };
}
