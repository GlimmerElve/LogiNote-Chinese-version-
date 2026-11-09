import { readings as previousReadings } from './data';
import { initialMobileTasks, type MobileTask } from './mobile-task-data';
import { getMobilePlatform } from './mobile-platform';

export type Tab = 'home' | 'discover' | 'messages' | 'records' | 'mine';
export type Photo = { id: string; time: number; media?: string };
export type Segment = { id: string; time: number; text: string };
export type Note = { id: string; title: string; at: string; duration: number; kind: '课堂' | '照片' | '复述'; segments: Segment[]; photos: Photo[]; source?: string; sourceTitle?: string; audioUri?: string; recordingState?: 'stopped' | 'interrupted' };
export type ChatMessage = { id: string; text: string; self: boolean; attachment?: string };
export type AssistantConversation = { id: string; title: string; tags: string[]; updatedAt: string; messages: ChatMessage[]; draft: string; context?: { id: string; title: string } };
export type Session = { id: string; title: string; at: string; elapsed: number; started: number | null; photos: Photo[]; native?: boolean };
export type State = { notes: Note[]; bookmarks: string[]; drafts: Record<string, string>; chats: Record<string, ChatMessage[]>; assistant: ChatMessage[]; assistantThreads: AssistantConversation[]; activeAssistantId: string; mobileTasks: MobileTask[]; dismissedRecordingIds: string[]; pendingRecordingDeletes: string[]; blocked: string[]; session: Session | null; recap: string; recapSource?: string; recapSourceTitle?: string };
export const uid = () => crypto.randomUUID();
export const clock = (value: number) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`;
export const sessionTime = (session: Session) => session.elapsed + (session.started === null ? 0 : Math.max(0, (Date.now() - session.started) / 1000));
export const materials = [{ id: 'derivative', title: '导数与变化率', category: '高等数学', summary: '从切线斜率出发，理解函数如何变化。', sections: [{ heading: '从切线理解', text: '导数描述函数在某一点的瞬时变化率。当两个点逐渐靠近，割线的斜率趋近于切线的斜率。' }, { heading: '一个例子', text: '对于 y = x²，导数为 2x。在 x = 2 时，变化率为 4。' }] }, ...previousReadings];
export const threads = [{ id: 'group', name: '高数学习小组', avatar: '群', group: true, preview: '小林：我把今天的板书整理好了。' }, { id: 'lin', name: '小林', avatar: '林', group: false, preview: '你说的例题，方便发我看看吗？' }, { id: 'english', name: '英语共学', avatar: '英', group: true, preview: '明晚一起练听力。' }];
export function newAssistantConversation(): AssistantConversation { return { id: uid(), title: '新的对话', tags: [], updatedAt: new Date().toISOString(), messages: [], draft: '' }; }
export function sourceTitle(note: Pick<Note, 'source' | 'sourceTitle'>) { return materials.find(m => m.id === note.source)?.title || note.sourceTitle || (note.source ? '关联资料' : ''); }
export function initialState(): State {
  const assistant = newAssistantConversation();
  return { bookmarks: [], drafts: {}, chats: {}, assistant: [], assistantThreads: [assistant], activeAssistantId: assistant.id, mobileTasks: initialMobileTasks(), dismissedRecordingIds: [], pendingRecordingDeletes: [], blocked: [], session: null, recap: '', notes: getMobilePlatform().isNative ? [] : [
    { id: 'sample-class', title: '高等数学 · 导数', at: new Date().toISOString(), duration: 2720, kind: '课堂', segments: [{ id: 's1', time: 1450, text: '导数描述函数在某一点的变化率。先看切线的斜率。' }, { id: 's2', time: 1628, text: '我们用这道例题来看计算过程。对于 y = x²，导数为 2x。' }], photos: [{ id: 'sample-photo', time: 1532 }] },
    { id: 'sample-recap', title: '关于主动回忆的理解', at: new Date(Date.now() - 86400000).toISOString(), duration: 0, kind: '复述', segments: [{ id: 's3', time: 0, text: '复述让我发现了理解中的空白。先尝试回忆，再回看资料。' }], photos: [] },
  ] };
}
const KEY = 'loginote.interactions.v2';
export function loadState(): { state: State; error: string; damaged?: string } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
    if (!raw) return { state: initialState(), error: '' };
    const state = JSON.parse(raw);
    if (!state || !Array.isArray(state.notes) || !Array.isArray(state.bookmarks) || !Array.isArray(state.assistant) || !Array.isArray(state.blocked) || !state.chats || !state.drafts || typeof state.recap !== 'string' || state.notes.some((n: Note) => typeof n.id !== 'string' || typeof n.title !== 'string' || !Array.isArray(n.segments) || !Array.isArray(n.photos)) || (state.session && (typeof state.session.id !== 'string' || typeof state.session.elapsed !== 'number' || !Array.isArray(state.session.photos)))) throw Error('invalid state');
    if (state.notes.some((n: Note) => n.source !== undefined && typeof n.source !== 'string' || n.sourceTitle !== undefined && typeof n.sourceTitle !== 'string') || state.recapSource !== undefined && typeof state.recapSource !== 'string' || state.recapSourceTitle !== undefined && typeof state.recapSourceTitle !== 'string') throw Error('invalid source');
    if (state.assistantThreads === undefined) {
      const legacy = newAssistantConversation(); legacy.messages = state.assistant; legacy.draft = typeof state.drafts.assistant === 'string' ? state.drafts.assistant : '';
      legacy.title = state.assistant.find((m: ChatMessage) => m.self)?.text.slice(0, 24) || '新的对话';
      if (legacy.messages.length) legacy.tags = ['历史对话'];
      state.assistantThreads = [legacy]; state.activeAssistantId = legacy.id;
    }
    if (!Array.isArray(state.assistantThreads) || state.assistantThreads.some((t: AssistantConversation) => typeof t.id !== 'string' || typeof t.title !== 'string' || !Array.isArray(t.tags) || t.tags.some(tag => typeof tag !== 'string') || !Array.isArray(t.messages) || t.messages.some(m => typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.self !== 'boolean' || m.attachment !== undefined && typeof m.attachment !== 'string') || typeof t.draft !== 'string' || typeof t.updatedAt !== 'string' || t.context !== undefined && (!t.context || typeof t.context.id !== 'string' || typeof t.context.title !== 'string')) || new Set(state.assistantThreads.map((t: AssistantConversation) => t.id)).size !== state.assistantThreads.length) throw Error('invalid assistant conversations');
    if (!state.assistantThreads.length) state.assistantThreads.push(newAssistantConversation());
    if (!state.assistantThreads.some((t: AssistantConversation) => t.id === state.activeAssistantId)) state.activeAssistantId = state.assistantThreads[0].id;
    if (state.mobileTasks === undefined) state.mobileTasks = initialMobileTasks();
    if (state.dismissedRecordingIds === undefined) state.dismissedRecordingIds = [];
    if (state.pendingRecordingDeletes === undefined) state.pendingRecordingDeletes = [];
    if (!Array.isArray(state.pendingRecordingDeletes) || state.pendingRecordingDeletes.some((id: string) => typeof id !== 'string')) throw Error('invalid pending recording deletions');
    if (!Array.isArray(state.dismissedRecordingIds) || state.dismissedRecordingIds.some((id: string) => typeof id !== 'string')) throw Error('invalid dismissed recordings');
    if (!Array.isArray(state.mobileTasks) || state.mobileTasks.some((t: MobileTask) => typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.plan !== 'string' || !['阅读', '复述', '简测', '待办', '桌面任务'].includes(t.kind) || typeof t.day !== 'string' || !Number.isFinite(t.minutes) || t.minutes < 0 || typeof t.done !== 'boolean')) throw Error('invalid mobile tasks');
    if (state.notes.some((n: Note) => n.audioUri !== undefined && typeof n.audioUri !== 'string')) throw Error('invalid audio');
    return { state, error: '' };
  } catch { return { state: initialState(), error: '本机缓存异常，原始内容会先备份，当前使用演示资料。', damaged: raw || undefined }; }
}
export function persistState(state: State, damaged?: string) {
  if (damaged) localStorage.setItem(`${KEY}.recovery.${uid()}`, damaged);
  localStorage.setItem(KEY, JSON.stringify(state));
}

let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('loginote-interaction-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('media');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
export async function saveMedia(file: File) {
  const database = await db(), key = uid();
  await new Promise<void>((resolve, reject) => { const tx = database.transaction('media', 'readwrite'); tx.objectStore('media').put(file, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  return key;
}
export async function readMedia(key: string): Promise<Blob | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => { const request = database.transaction('media').objectStore('media').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
