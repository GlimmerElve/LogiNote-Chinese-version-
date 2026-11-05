import { adoptPendingReviewAnswers, applyCognitionMutation, emptyCognitionFile, parseCognitionFile } from './core.ts';
import type { CognitionFile, CognitionMutation } from './types';
import type { ReviewEpisodeCapture } from '../memory/types';
import { reviewCognitionObservations } from './observations.ts';
import { readCognitionRetrieval, retrieveCurrentCognition, withCognitionNeighborhood, type CognitionRetrieval } from './retrieval.ts';
import { retrieveProjectMaterials, retrievePublishedMaterials } from './materials.ts';
import { readNotesForCognition } from '../storage';
import { savedFlowReviewGraphs, retrieveFlowReviewGraphs } from './flowReviewMaterials';
import { savedRestatementObservations } from './restatements';
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

export async function captureRestatementCognition(note: NoteItem, recordId?: string): Promise<void> {
  const api = getApi(), storageScopeId = await api?.getAgentTaskScope?.();
  const observations = savedRestatementObservations([note]).filter(row => !recordId || row.recordId === recordId);
  if (!observations.length) return;
  await savePersonalCognition({ kind: 'record_restatements', observations, ...(storageScopeId ? { storageScopeId } : {}) });
}

/** Local source synchronization only; opening a graph must not run semantic retrieval/embedding. */
export async function syncSavedRestatementsForCognition(): Promise<{ warning: string }> {
  const api = getApi();
  let syncWarning = '';
  const scope = await api?.getAgentTaskScope?.();
  try {
    // Read saved restatements plus their bound analysis structure, never arbitrary project prose/graphs.
    const observations = savedRestatementObservations(await readNotesForCognition());
    if (api && (!scope || scope !== await api.getAgentTaskScope?.())) throw new Error('认知来源资料库发生变化');
    for (let i = 0; i < observations.length; i += 500) await savePersonalCognition({ kind: 'record_restatements',
      observations: observations.slice(i, i + 500), ...(scope ? { storageScopeId: scope } : {}) });
  } catch { syncWarning = '已保存复述的自动同步暂不可用，本次可能遗漏这部分认知。'; }
  if (scope && scope !== await api?.getAgentTaskScope?.()) throw new Error('认知资料库已切换，请重新查询');
  return { warning: syncWarning };
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
