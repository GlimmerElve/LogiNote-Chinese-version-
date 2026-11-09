import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Camera, ChevronRight, CloudCheck, Compass, FileText, Folder, History, Home, ImagePlus, Keyboard, ListChecks, LogOut, MessageCircle, Mic, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Send, Settings, Square, UserRound, X } from 'lucide-react';
import tree from '../../design/loginote-world-tree-selected.png';
import { clock, loadState, materials, newAssistantConversation, persistState, readMedia, saveMedia, sessionTime, sourceTitle, threads, uid, type Note, type Photo, type State, type Tab } from './interaction-data';
import { usePressToTalkDemo } from './usePressToTalkDemo';
import { AssistantHistory } from './AssistantHistory';
import { MobileTasks } from './MobileTasks';
import { mobileDate } from './mobile-task-data';
import { getMobilePlatform, type NativeRecording } from './mobile-platform';
import { reconcileRecordings } from './reconcile-recordings';
import { RecordingPlayer } from './RecordingPlayer';
import './interactive.css';

const navigation = [{ id: 'home', name: '首页', Icon: Home }, { id: 'discover', name: '发现', Icon: Compass }, { id: 'messages', name: '消息', Icon: MessageCircle }, { id: 'records', name: '记录', Icon: FileText }, { id: 'mine', name: '我的', Icon: UserRound }] as const;
type Overlay = 'sync' | 'auth' | 'policies' | 'register' | 'forgot' | 'share' | 'thread-menu' | 'note-menu' | 'delete' | 'assistant-history' | 'assistant-settings' | 'assistant-attachments' | 'chat-attachments' | null;
type PhotoDestination = { target: 'session' | 'new' | 'edit' | 'chat' | 'assistant'; sessionId?: string; assistantId?: string; threadId?: string; time?: number };

function Dialog({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; const el = ref.current!; el.showModal(); return () => { el.close(); previous?.isConnected && previous.focus(); }; }, []);
  return <dialog ref={ref} className="ix-dialog" aria-label={title} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close(); } }}><header><h2>{title}</h2><button className="ix-icon" autoFocus aria-label="关闭弹层" onClick={close}><X /></button></header>{children}</dialog>;
}
function Board() {
  return <div className="ix-board" role="img" aria-label="示例板书：导数 y 等于 x 平方，导数等于 2x"><span>导数</span><strong>y = x²</strong><strong>y′ = 2x</strong><small>示例板书</small></div>;
}
function PhotoView({ photo, open }: { photo: Photo; open?: () => void }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { let active = true, src = ''; if (photo.media) readMedia(photo.media).then(blob => { if (!blob) throw Error(); src = URL.createObjectURL(blob); if (active) setUrl(src); else URL.revokeObjectURL(src); }).catch(() => { if (active) setFailed(true); }); return () => { active = false; if (src) URL.revokeObjectURL(src); }; }, [photo.media]);
  const content = url ? <img src={url} alt="保存的课堂照片" /> : photo.media ? <span>{failed ? '照片暂不可用' : '载入照片…'}</span> : <Board />;
  return open ? <button className="ix-photo" onClick={open} aria-label={`查看 ${clock(photo.time)} 的照片`}>{content}</button> : <div className="ix-photo">{content}</div>;
}
function Recap({ text, onChange, save, close, error, resumedSource }: { text: string; onChange: (text: string) => void; save: () => void; close: () => void; error: string; resumedSource?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const voice = usePressToTalkDemo({ onPressStart: () => input.current?.blur() });
  return <Dialog title="复述" close={close}><small className="ix-hint">语音手势演示 · 未录音</small>{resumedSource && <p className="ix-resumed-source">继续草稿 · {resumedSource}</p>}<textarea ref={input} aria-label="复述内容" placeholder="点这里输入" rows={5} value={text} readOnly={voice.active} onChange={e => onChange(e.target.value)} /><button {...voice.buttonProps} className="ix-hold" type="button" data-phase={voice.phase} aria-label="按住说话"><Mic />{voice.phase === 'canceling' ? '松开取消' : voice.phase === 'recording' ? '松开结束' : '按住说话'}</button><p className="ix-voice-status" role="status">{voice.active ? `${clock(voice.elapsedSeconds)} · ${voice.phase === 'canceling' ? '松开取消' : '上滑取消'}` : voice.feedback}</p>{error && <p role="alert">{error}</p>}<button className="ix-primary" disabled={!text.trim() || voice.active} onClick={save}>保存复述</button></Dialog>;
}
function HoldInput() {
  const voice = usePressToTalkDemo({ onPressStart: () => { const active = document.activeElement; if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur(); } });
  return <div className="ix-composer-voice"><span role="status">{voice.active ? `${clock(voice.elapsedSeconds)} · ${voice.phase === 'canceling' ? '松开取消' : '上滑取消'}` : voice.feedback || '语音演示 · 未录音'}</span><button {...voice.buttonProps} className="ix-hold" data-phase={voice.phase} type="button" aria-label="按住说话">{voice.phase === 'canceling' ? '松开取消' : voice.phase === 'recording' ? '松开结束' : '按住说话'}</button></div>;
}

export function InteractiveApp() {
  const platform = getMobilePlatform();
  const [loaded] = useState(loadState);
  const [state, setState] = useState(loaded.state);
  const current = useRef(state); current.current = state;
  const damaged = useRef(loaded.damaged);
  const [error, setError] = useState(loaded.error);
  const [signedIn, setSignedIn] = useState(() => { try { return platform.isNative ? localStorage.getItem('loginote.local-onboarding') === 'yes' : sessionStorage.getItem('loginote.demo-session') === 'yes'; } catch { return false; } });
  const [tab, setTab] = useState<Tab>('home');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [consent, setConsent] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [notice, setNotice] = useState('');
  const [feed, setFeed] = useState<'推荐' | '资料'>('推荐');
  const [query, setQuery] = useState(''); const [folder, setFolder] = useState(''); const [card, setCard] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [sourceReturnNote, setSourceReturnNote] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [recordSearch, setRecordSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [thread, setThread] = useState<string | null>(null); const [chatSearch, setChatSearch] = useState('');
  const [recap, setRecap] = useState(false);
  const [assistantVoice, setAssistantVoice] = useState(false);
  const [chatVoice, setChatVoice] = useState(false);
  const [assistantEdit, setAssistantEdit] = useState({ title: '', tags: '' });
  const [shareId, setShareId] = useState<string | null>(null);
  const [recordingPage, setRecordingPage] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [bookmarksOnly, setBookmarksOnly] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const nativeOperation = useRef(false), nativeEpoch = useRef(0);
  const [photoOpen, setPhotoOpen] = useState<Photo | null>(null);
  const photoDestination = useRef<PhotoDestination>({ target: 'new' });
  const photoInput = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(Date.now());
  const [position, setPosition] = useState(0); const [playing, setPlaying] = useState(false); const [speed, setSpeed] = useState(1);
  const scroll = useRef<HTMLDivElement>(null); const assistantLog = useRef<HTMLDivElement>(null); const messageLog = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swipedAt = useRef(0);
  const [keyboard, setKeyboard] = useState(false);
  const restingHeight = useRef(window.innerHeight);
  const note = state.notes.find(n => n.id === selectedNote && !state.pendingRecordingDeletes.includes(n.id));
  const material = materials.find(n => n.id === reading);
  const conversation = threads.find(t => t.id === thread);
  const activeAssistant = state.assistantThreads.find(t => t.id === state.activeAssistantId) || state.assistantThreads[0];
  const assistantContext = activeAssistant.context;
  const elapsed = state.session ? sessionTime(state.session) : 0;
  const todayTasks = state.mobileTasks.filter(t => t.day <= mobileDate() && !t.done);
  void now;
  function commit(update: (value: State) => State) {
    const next = update(current.current);
    try { persistState(next, damaged.current); damaged.current = undefined; current.current = next; setState(next); setError(''); return true; }
    catch { setError('本机保存失败，输入已保留，请释放存储空间后重试。'); return false; }
  }
  function draft(key: string, text: string) {
    const next = { ...current.current, drafts: { ...current.current.drafts, [key]: text } }; current.current = next; setState(next);
    try { persistState(next, damaged.current); damaged.current = undefined; setError(''); } catch { setError('草稿尚未保存，请保留当前页面。'); }
  }
  function go(next: Tab) { if (editing) { setOverlay('note-menu'); return; } setTab(next); setReading(null); setSourceReturnNote(null); setSelectedNote(null); setThread(null); setRecordingPage(false); setTasksOpen(false); setAssistantOpen(false); setBookmarksOnly(false); setPlaying(false); }
  function openRecap(source?: string) { if (!state.recap.trim() && !commit(s => ({ ...s, recapSource: source, recapSourceTitle: materials.find(m => m.id === source)?.title }))) return; setRecap(true); }
  function openRecordSource(entry: Note) { if (!entry.source || !materials.some(m => m.id === entry.source)) return; go('discover'); setReading(entry.source); setSourceReturnNote(entry.id); }
  function backFromReading() { if (sourceReturnNote) { const id = sourceReturnNote; go('records'); openNote(id); } else setReading(null); }
  function createAssistant() {
    const next = newAssistantConversation();
    if (commit(s => ({ ...s, assistantThreads: [next, ...s.assistantThreads], activeAssistantId: next.id }))) { setOverlay(null); setAssistantOpen(true); }
  }
  function selectAssistant(id: string) { if (commit(s => ({ ...s, activeAssistantId: id }))) { setOverlay(null); setAssistantOpen(true); } }
  function setAssistantContext(context: { id: string; title: string } | null) {
    return commit(s => ({ ...s, assistantThreads: s.assistantThreads.map(t => t.id === s.activeAssistantId ? { ...t, title: context && t.title === '新的对话' ? context.title : t.title, context: context || undefined, tags: context ? [...new Set([...t.tags, materials.find(m => m.id === context.id)?.category || state.notes.find(n => n.id === context.id)?.kind || '学习资料'])] : t.tags, updatedAt: new Date().toISOString() } : t) }));
  }
  function assistantDraft(text: string) {
    const next = { ...current.current, assistantThreads: current.current.assistantThreads.map(t => t.id === current.current.activeAssistantId ? { ...t, draft: text } : t) }; current.current = next; setState(next);
    try { persistState(next, damaged.current); damaged.current = undefined; setError(''); } catch { setError('对话草稿尚未保存，请保留当前页面。'); }
  }
  function openNote(id: string) { setSelectedNote(id); setPosition(0); setPlaying(false); }
  async function pickPhoto(target: PhotoDestination['target']) {
    const destination: PhotoDestination = { target, sessionId: current.current.session?.id, assistantId: current.current.activeAssistantId, threadId: thread || undefined, time: Math.floor(current.current.session ? sessionTime(current.current.session) : position) };
    photoDestination.current = destination;
    setOverlay(null);
    if (!platform.takePhoto) { photoInput.current?.click(); return; }
    try {
      localStorage.setItem('loginote.pending-camera', JSON.stringify(destination));
      const file = await platform.takePhoto();
      if (file) await attachPhoto(file, destination);
      localStorage.removeItem('loginote.pending-camera');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '拍照未完成，请重试。'); }
  }
  function adoptNative(status: NativeRecording, completed: NativeRecording[] = []) {
    const next = reconcileRecordings(current.current, status, completed);
    if (next !== current.current && !commit(() => next)) { current.current = next; setState(next); }
    if (status.error) setError(status.error);
  }
  async function nativeAction(action: () => Promise<void>) {
    if (nativeOperation.current) return;
    nativeOperation.current = true; nativeEpoch.current++; setNativeBusy(true);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : '录音操作失败，请重试。'); }
    finally { nativeOperation.current = false; setNativeBusy(false); }
  }
  function startRecording() {
    if (state.session) { setRecordingPage(true); return; }
    if (platform.recorder) {
      void nativeAction(async () => { const running = await platform.recorder!.getStatus(); const status = running.state === 'recording' || running.state === 'paused' ? running : await platform.recorder!.start({ id: uid(), title: '新的课堂' }); if (!status.id || !['recording', 'paused'].includes(status.state)) throw Error(status.error || '录音未能启动，请重试。'); adoptNative(status); setRecordingPage(true); });
      return;
    }
    if (commit(s => ({ ...s, session: { id: uid(), title: '新的课堂', at: new Date().toISOString(), elapsed: 0, started: Date.now(), photos: [] } }))) setRecordingPage(true);
  }
  function finishRecording() {
    const session = current.current.session; if (!session) return;
    if (session.native && platform.recorder) {
      void nativeAction(async () => { const result = await platform.recorder!.stop(); if (!result.id || !['stopped', 'interrupted'].includes(result.state)) throw Error(result.error || '录音尚未停止，请重试。'); adoptNative(result, [result]); go('records'); openNote(result.id); setNotice(result.error ? '录音已保留，请检查文件' : '录音已保存到本机'); });
      return;
    }
    const record: Note = { id: session.id, title: session.title || '新的课堂', at: session.at, duration: Math.max(1, Math.floor(sessionTime(session))), kind: '课堂', photos: session.photos, segments: [] };
    if (commit(s => ({ ...s, notes: [record, ...s.notes], session: null }))) { go('records'); openNote(record.id); setNotice('已保存课堂演示记录'); }
  }
  function toggleRecordingPause() {
    const session = current.current.session; if (!session) return;
    if (session.native && platform.recorder) { void nativeAction(async () => adoptNative(await (session.started === null ? platform.recorder!.resume() : platform.recorder!.pause()))); return; }
    commit(s => ({ ...s, session: s.session ? { ...s.session, elapsed: sessionTime(s.session), started: s.session.started === null ? Date.now() : null } : null }));
  }
  async function deleteNote() {
    const entry = current.current.notes.find(n => n.id === selectedNote); if (!entry) return;
    if (entry.audioUri && platform.recorder) {
      if (nativeOperation.current) return;
      if (!commit(s => ({ ...s, pendingRecordingDeletes: [...new Set([...s.pendingRecordingDeletes, entry.id])], dismissedRecordingIds: [...new Set([...s.dismissedRecordingIds, entry.id])] }))) return;
      setSelectedNote(null); setOverlay(null); await finishNativeDeletes();
    } else if (commit(s => ({ ...s, notes: s.notes.filter(n => n.id !== entry.id), dismissedRecordingIds: [...new Set([...s.dismissedRecordingIds, entry.id])] }))) { setSelectedNote(null); setOverlay(null); setNotice('已删除本机记录'); }
  }
  async function finishNativeDeletes() {
    if (!platform.recorder) return;
    await nativeAction(async () => {
      for (const id of [...current.current.pendingRecordingDeletes]) {
        await platform.recorder!.deleteRecording({ id });
        if (!commit(s => ({ ...s, notes: s.notes.filter(n => n.id !== id), pendingRecordingDeletes: s.pendingRecordingDeletes.filter(value => value !== id) }))) { setError('录音文件已删除，记录清理待重试。'); return; }
      }
      setNotice('录音与记录已删除');
    });
  }
  async function attachPhoto(file?: File, destination = photoDestination.current) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('请选择图片文件。'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('图片请小于 20 MB。'); return; }
    const targetSession = current.current.session;
    const { target, sessionId, assistantId, threadId } = destination;
    try {
      const media = await saveMedia(file), photo: Photo = { id: uid(), time: destination.time ?? Math.floor(targetSession ? sessionTime(targetSession) : position), media };
      if (target === 'session' && sessionId && (current.current.session?.id === sessionId || current.current.notes.some(n => n.id === sessionId))) commit(s => s.session?.id === sessionId ? { ...s, session: { ...s.session!, photos: [...s.session!.photos, photo] } } : { ...s, notes: s.notes.map(n => n.id === sessionId ? { ...n, photos: [...n.photos, { ...photo, time: Math.min(photo.time, n.duration) }] } : n) });
      else if (target === 'edit' && editing) setEditing({ ...editing, photos: [...editing.photos, photo] });
      else if (target === 'chat' && threadId && threads.some(item => item.id === threadId)) commit(s => ({ ...s, chats: { ...s.chats, [threadId]: [...(s.chats[threadId] || []), { id: uid(), self: true, text: '照片（本机演示）', attachment: `photo:${media}` }] } }));
      else if (target === 'assistant' && assistantId && current.current.assistantThreads.some(item => item.id === assistantId)) commit(s => ({ ...s, assistantThreads: s.assistantThreads.map(item => item.id === assistantId ? { ...item, title: item.title === '新的对话' ? '图片提问' : item.title, updatedAt: new Date().toISOString(), messages: [...item.messages, { id: uid(), self: true, text: '照片（本机）', attachment: `photo:${media}` }] } : item) }));
      else {
        const entry: Note = { id: uid(), title: file.name.replace(/\.[^.]+$/, '') || '拍照记录', at: new Date().toISOString(), kind: '照片', duration: 0, segments: [], photos: [{ ...photo, time: 0 }] };
        if (commit(s => ({ ...s, notes: [entry, ...s.notes] }))) { go('records'); openNote(entry.id); }
      }
    } catch { setError('照片未保存，请重试。'); }
  }
  function ask(id: string, title: string) {
    if (editing) { setOverlay('note-menu'); return; }
    const existing = current.current.assistantThreads.find(t => t.context?.id === id);
    const next = { ...newAssistantConversation(), title, context: { id, title }, tags: [materials.find(m => m.id === id)?.category || state.notes.find(n => n.id === id)?.kind || '学习资料'] };
    if (commit(s => ({ ...s, assistantThreads: existing ? s.assistantThreads : [next, ...s.assistantThreads], activeAssistantId: existing?.id || next.id }))) { setPlaying(false); setAssistantOpen(true); }
  }
  function sendAssistant() {
    const active = current.current.assistantThreads.find(t => t.id === current.current.activeAssistantId)!;
    const text = active.draft.trim(); if (!text) return;
    const assistantContext = active.context;
    const context = assistantContext ? materials.find(m => m.id === assistantContext.id)?.sections.map(s => s.text).join('\n') || state.notes.find(n => n.id === assistantContext.id)?.segments.map(s => s.text).join('\n') : '';
    const reply = context ? `演示回复：依据「${assistantContext!.title}」：\n${context}\n\n正式接入后，学习助手将根据你的问题回答。` : '演示回复：问题已保存在本机。这里将接入学习助手 Agent，当前未调用模型。';
    commit(s => ({ ...s, assistantThreads: s.assistantThreads.map(t => t.id === active.id ? { ...t, draft: '', title: t.title === '新的对话' ? text.slice(0, 24) : t.title, tags: t.tags.length ? t.tags : ['自由提问'], updatedAt: new Date().toISOString(), messages: [...t.messages, { id: uid(), self: true, text: `${assistantContext ? `关于「${assistantContext.title}」\n` : ''}${text}` }, { id: uid(), self: false, text: reply }] } : t) }));
  }
  function sendChat() {
    if (!thread || state.blocked.includes(thread)) return;
    const text = state.drafts[thread]?.trim(); if (!text) return;
    commit(s => ({ ...s, drafts: { ...s.drafts, [thread]: '' }, chats: { ...s.chats, [thread]: [...(s.chats[thread] || []), { id: uid(), self: true, text }] } }));
  }
  function share(to: string) {
    if (!shareId || state.blocked.includes(to)) { setNotice('该会话已屏蔽'); return; }
    const title = state.notes.find(n => n.id === shareId)?.title || materials.find(m => m.id === shareId)?.title || '资料';
    if (commit(s => ({ ...s, chats: { ...s.chats, [to]: [...(s.chats[to] || []), { id: uid(), self: true, text: title, attachment: shareId }] } }))) { setOverlay(null); go('messages'); setThread(to); }
  }
  function bookmark(id: string) { commit(s => ({ ...s, bookmarks: s.bookmarks.includes(id) ? s.bookmarks.filter(x => x !== id) : [...s.bookmarks, id] })); }
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!state.session?.started) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [state.session?.started]);
  useEffect(() => { if (!playing || !note || note.audioUri) return; const timer = setInterval(() => setPosition(p => { const next = Math.min(note.duration, p + speed / 2); if (next >= note.duration) setPlaying(false); return next; }), 500); return () => clearInterval(timer); }, [playing, speed, note?.id]);
  useEffect(() => { setPlaying(false); }, [selectedNote]);
  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [tab, reading, selectedNote, recordingPage, assistantOpen]);
  useEffect(() => { assistantLog.current?.scrollTo(0, assistantLog.current.scrollHeight); }, [assistantOpen, state.activeAssistantId, activeAssistant.messages.length]);
  useEffect(() => { messageLog.current?.scrollTo(0, messageLog.current.scrollHeight); }, [thread, state.chats]);
  useEffect(() => { const fit = () => { const height = window.visualViewport?.height || window.innerHeight; const focused = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement; if (!focused) restingHeight.current = height; document.documentElement.style.setProperty('--ix-vh', `${height}px`); setKeyboard(focused && Math.max(restingHeight.current, window.innerHeight) - height > 150); }; fit(); window.visualViewport?.addEventListener('resize', fit); window.addEventListener('resize', fit); document.addEventListener('focusin', fit); document.addEventListener('focusout', fit); return () => { window.visualViewport?.removeEventListener('resize', fit); window.removeEventListener('resize', fit); document.removeEventListener('focusin', fit); document.removeEventListener('focusout', fit); }; }, []);
  useEffect(() => { const onLeave = (e: BeforeUnloadEvent) => { if (current.current.session || editing || error) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', onLeave); return () => window.removeEventListener('beforeunload', onLeave); }, [editing, error]);
  useEffect(() => {
    if (!platform.recorder) return;
    if (current.current.pendingRecordingDeletes.length) void finishNativeDeletes();
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending || nativeOperation.current) return;
      pending = true; const epoch = nativeEpoch.current;
      try {
        const [status, saved] = await Promise.all([platform.recorder!.getStatus(), platform.recorder!.listRecordings()]);
        if (cancelled || epoch !== nativeEpoch.current) return;
        const previous = current.current.session;
        adoptNative(status, saved.recordings);
        if (previous?.native && recordingPage && !['recording', 'paused'].includes(status.state)) { setRecordingPage(false); setTab('records'); openNote(previous.id); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : '暂时无法读取录音状态。'); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(refresh, 1500);
    window.addEventListener('loginote:native-resume', refresh);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('loginote:native-resume', refresh); };
  }, [platform.recorder, recordingPage]);
  useEffect(() => {
    if (!platform.onRestoredPhoto) return;
    return platform.onRestoredPhoto(file => { void (async () => { let destination: PhotoDestination = { target: 'new' }; try { const pending = JSON.parse(localStorage.getItem('loginote.pending-camera') || '{}'); if (['session', 'new', 'chat', 'assistant'].includes(pending.target)) destination = { target: pending.target, sessionId: typeof pending.sessionId === 'string' ? pending.sessionId : undefined, assistantId: typeof pending.assistantId === 'string' ? pending.assistantId : undefined, threadId: typeof pending.threadId === 'string' ? pending.threadId : undefined, time: Number.isFinite(pending.time) ? pending.time : undefined }; if (platform.recorder) { const [status, saved] = await Promise.all([platform.recorder.getStatus(), platform.recorder.listRecordings()]); adoptNative(status, saved.recordings); } } catch { /* Preserve the restored image independently if its destination cannot be recovered. */ } await attachPhoto(file, destination); localStorage.removeItem('loginote.pending-camera'); })().catch(() => setError('恢复的照片未保存，请检查本机空间。')); });
  }, [platform.onRestoredPhoto]);
  useEffect(() => {
    const back = (event: Event) => {
      const request = event as CustomEvent<{ handled: boolean }>;
      if (overlay) setOverlay(null);
      else if (photoOpen) setPhotoOpen(null);
      else if (recap) setRecap(false);
      else if (editing) setOverlay('note-menu');
      else if (assistantOpen) setAssistantOpen(false);
      else if (recordingPage) setRecordingPage(false);
      else if (reading) backFromReading();
      else if (tasksOpen) { const detail = document.querySelector<HTMLButtonElement>('.mt-has-selection .mt-mobile-back'); if (detail) detail.click(); else setTasksOpen(false); }
      else if (selectedNote) setSelectedNote(null);
      else if (thread) setThread(null);
      else if (bookmarksOnly) go('mine');
      else if (tab !== 'home') go('home');
      else return;
      request.detail.handled = true;
    };
    const keyboardEvent = (event: Event) => { const detail = (event as CustomEvent<{ visible: boolean; height: number }>).detail; setKeyboard(detail.visible); if (detail.visible && detail.height > 0) document.documentElement.style.setProperty('--ix-vh', `${Math.min(window.innerHeight, restingHeight.current - detail.height)}px`); else document.documentElement.style.setProperty('--ix-vh', `${window.visualViewport?.height || window.innerHeight}px`); };
    const nativeError = (event: Event) => setError((event as CustomEvent<{ message: string }>).detail.message || '原生操作失败，请重试。');
    window.addEventListener('loginote:native-back', back); window.addEventListener('loginote:native-keyboard', keyboardEvent); window.addEventListener('loginote:native-error', nativeError);
    return () => { window.removeEventListener('loginote:native-back', back); window.removeEventListener('loginote:native-keyboard', keyboardEvent); window.removeEventListener('loginote:native-error', nativeError); };
  }, [overlay, photoOpen, recap, editing, assistantOpen, tasksOpen, recordingPage, reading, selectedNote, thread, tab, sourceReturnNote, bookmarksOnly]);

  function header(title: string, back?: () => void, action?: React.ReactNode) { return <header className="ix-page-head">{back && <button className="ix-icon" aria-label="返回" onClick={back}><ArrowLeft /></button>}<h1>{title}</h1>{action}</header>; }
  function photoTimeline(entry: Note, editable = false) {
    const entries = [...entry.segments.map(s => ({ ...s, type: 'text' as const })), ...entry.photos.map(p => ({ ...p, type: 'photo' as const }))].sort((a, b) => a.time - b.time);
    return <div className="ix-timeline">{entries.map(item => <section key={item.id} className={item.type === 'photo' ? 'ix-photo-block' : ''}><button className="ix-time" onClick={() => setPosition(item.time)} aria-label={`跳到 ${clock(item.time)}`}>{clock(item.time)}</button>{item.type === 'photo' ? <><PhotoView photo={item} open={() => setPhotoOpen(item)} />{editable && <button className="ix-text" onClick={() => setEditing({ ...entry, photos: entry.photos.filter(p => p.id !== item.id) })}>移除照片</button>}</> : editable ? <textarea aria-label={`编辑 ${clock(item.time)} 的转写`} rows={3} value={item.text} onChange={e => setEditing({ ...entry, segments: entry.segments.map(s => s.id === item.id ? { ...s, text: e.target.value } : s) })} /> : <p data-active={position >= item.time && position < item.time + 45}>{item.text}</p>}</section>)}</div>;
  }
  function renderRecord(entry: Note) {
    const value = editing?.id === entry.id ? editing : entry;
    const boundTitle = sourceTitle(entry), sourceAvailable = materials.some(m => m.id === entry.source);
    return <section className="ix-detail" aria-label="记录详情">{header(editing ? '编辑记录' : value.title, () => { if (editing) setOverlay('note-menu'); else setSelectedNote(null); }, editing ? <button className="ix-text" onClick={() => { if (!editing.title.trim()) { setError('请填写记录标题。'); return; } if (commit(s => ({ ...s, notes: s.notes.map(n => n.id === editing.id ? editing : n) }))) { setEditing(null); setNotice('已保存修改'); } }}>完成</button> : <button className="ix-icon" aria-label="记录更多操作" onClick={() => setOverlay('note-menu')}><MoreHorizontal /></button>)}
      <div className="ix-detail-scroll">{editing && <input className="ix-title-input" aria-label="记录标题" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} />}<p className="ix-hint">{new Date(entry.at).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
        {boundTitle && (sourceAvailable ? <button className="ix-source-link" aria-label={`查看关联资料：${boundTitle}`} disabled={!!editing} onClick={() => openRecordSource(entry)}><FileText /><span><small>关联资料</small><strong>{boundTitle}</strong></span><ChevronRight /></button> : <div className="ix-source-link ix-source-unavailable"><FileText /><span><small>关联资料 · 资料暂不可用</small><strong>{boundTitle}</strong></span></div>)}
        {!!entry.duration && <RecordingPlayer note={entry} position={position} playing={playing} speed={speed} onPosition={setPosition} onPlaying={setPlaying} onSpeed={setSpeed} onError={setError} />}
        {photoTimeline(value, !!editing)}
        {!value.segments.length && !editing && value.kind === '课堂' && platform.isNative && <p className="ix-hint">转写服务尚未接入，可先回听或编辑记录。</p>}{!platform.isNative && !value.segments.length && !editing && value.kind === '课堂' && <button className="ix-secondary" onClick={() => commit(s => ({ ...s, notes: s.notes.map(n => n.id === entry.id ? { ...n, segments: [{ id: uid(), time: 0, text: '【演示转写】导数表示函数在某一点的瞬时变化率。此段为示例文字，未识别你的录音。' }] } : n) }))}>查看转写演示</button>}
        {editing && <div className="ix-row"><button className="ix-secondary" onClick={() => setEditing({ ...editing, segments: [...editing.segments, { id: uid(), time: Math.floor(position), text: '' }] })}><Plus />添加文字</button><button className="ix-secondary" onClick={() => pickPhoto('edit')}><ImagePlus />添加照片</button></div>}
      </div>{!editing && <footer className="ix-actions"><button onClick={() => ask(entry.id, entry.title)}><MessageCircle />问助手</button><button onClick={() => { setPlaying(false); setEditing(structuredClone(entry)); }}><Pencil />编辑</button></footer>}</section>;
  }
  function renderRecords() {
    const term = recordSearch.trim().toLowerCase();
    const visible = state.notes.filter(n => !state.pendingRecordingDeletes.includes(n.id)).filter(n => `${n.title} ${sourceTitle(n)} ${n.segments.map(s => s.text).join(' ')}`.toLowerCase().includes(term)).sort((a, b) => b.at.localeCompare(a.at));
    const groups = new Map<string, Note[]>(); visible.forEach(n => { const at = new Date(n.at), today = new Date(); const days = (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86400000; const label = days === 0 ? '今天' : days === 1 ? '昨天' : at.toLocaleDateString('zh-CN'); groups.set(label, [...(groups.get(label) || []), n]); });
    return <div className={`ix-master-detail ${note ? 'has-detail' : ''}`}><section className="ix-master">{header('记录', undefined, <button className="ix-icon" aria-label="写一条记录" onClick={() => { setReading(null); openRecap(); }}><Plus /></button>)}<label className="ix-search"><Search /><input aria-label="搜索记录" placeholder="搜索记录" value={recordSearch} onChange={e => setRecordSearch(e.target.value)} /></label><div className="ix-list-scroll">{[...groups].map(([label, rows]) => <section key={label}><h2 className="ix-group-title">{label}</h2>{rows.map(n => <button key={n.id} className="ix-list-row" data-selected={selectedNote === n.id} aria-current={selectedNote === n.id ? 'true' : undefined} onClick={() => openNote(n.id)}>{n.kind === '课堂' ? <Mic /> : n.kind === '照片' ? <Camera /> : <FileText />}<span><strong>{n.title}</strong><small>{new Date(n.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}{n.duration ? ` · ${clock(n.duration)}` : ''}{n.photos.length ? ` · ${n.photos.length} 张照片` : ''}</small>{(n.source || n.sourceTitle) && <small className="ix-record-source"><FileText />{sourceTitle(n)}</small>}</span><ChevronRight /></button>)}</section>)}{!visible.length && <p className="ix-empty">没有匹配的记录</p>}</div></section>{note ? renderRecord(note) : <div className="ix-unselected"><FileText /><p>选择一条记录</p></div>}</div>;
  }
  function messageAttachment(id: string) {
    if (id.startsWith('photo:')) { const photo = { id, media: id.slice(6), time: 0 }; return <PhotoView photo={photo} open={() => setPhotoOpen(photo)} />; }
    const entry = state.notes.find(n => n.id === id), source = materials.find(m => m.id === id);
    return <button className="ix-attachment" onClick={() => { if (entry) { go('records'); openNote(entry.id); } else if (source) { go('discover'); setReading(source.id); } }}><FileText /><span>{entry?.title || source?.title || '资料已移除'}<small>{entry ? `${clock(entry.duration)} · ${entry.photos.length} 张照片` : '笔记'}</small></span><ChevronRight /></button>;
  }
  function renderMessages() {
    return <div className={`ix-master-detail ${conversation ? 'has-detail' : ''}`}><section className="ix-master">{header('消息')}<label className="ix-search"><Search /><input aria-label="搜索会话" placeholder="搜索会话" value={chatSearch} onChange={e => setChatSearch(e.target.value)} /></label><div className="ix-list-scroll">{threads.filter(t => t.name.includes(chatSearch)).map(t => <button className="ix-list-row" key={t.id} data-selected={thread === t.id} aria-current={thread === t.id ? 'true' : undefined} onClick={() => setThread(t.id)}><span className="ix-avatar">{t.avatar}</span><span><strong>{t.name}{t.group && <small className="ix-inline">群聊</small>}</strong><small>{state.blocked.includes(t.id) ? '已屏蔽' : state.chats[t.id]?.at(-1)?.text || t.preview}</small></span></button>)}</div></section>{conversation ? <section className="ix-detail ix-chat">{header(conversation.name, () => setThread(null), <button className="ix-icon" aria-label="会话设置" onClick={() => setOverlay('thread-menu')}><MoreHorizontal /></button>)}<div className="ix-messages" role="log" aria-label="会话消息" ref={messageLog}><p className="ix-hint">本机演示 · 消息不会发给他人</p><div className="ix-bubble">{conversation.group && <small>小林</small>}{conversation.preview}</div>{conversation.group && messageAttachment('derivative')}{(state.chats[conversation.id] || []).map(m => <div key={m.id} className={m.self ? 'ix-message-self' : ''}>{m.attachment ? messageAttachment(m.attachment) : <p className="ix-bubble">{m.text}</p>}{m.self && <small className="ix-delivery">仅本机</small>}</div>)}</div>{state.blocked.includes(conversation.id) ? <footer className="ix-actions"><span>已屏蔽</span><button onClick={() => commit(s => ({ ...s, blocked: s.blocked.filter(id => id !== conversation.id) }))}>解除屏蔽</button></footer> : <form className="ix-composer" onSubmit={e => { e.preventDefault(); sendChat(); }}><button className="ix-icon" type="button" aria-label="添加内容" onClick={() => setOverlay('chat-attachments')}><Plus /></button>{chatVoice ? <HoldInput /> : <textarea aria-label="聊天消息" rows={1} placeholder="消息" value={state.drafts[conversation.id] || ''} onChange={e => draft(conversation.id, e.target.value)} />}<button className="ix-icon" type="button" aria-label={chatVoice ? '切换文字输入' : '切换语音输入'} onClick={() => setChatVoice(!chatVoice)}>{chatVoice ? <Keyboard /> : <Mic />}</button><button className="ix-send" aria-label="发送消息" disabled={!state.drafts[conversation.id]?.trim()}><Send /></button></form>}</section> : <div className="ix-unselected"><MessageCircle /><p>选择一个会话</p></div>}</div>;
  }
  function renderAssistantHistory() {
    return <AssistantHistory items={state.assistantThreads} activeId={state.activeAssistantId} onSelect={selectAssistant} onCreate={createAssistant} />;
  }
  function renderHome() {
    const recent = state.assistantThreads.filter(item => item.messages.length || item.draft.trim() || item.context).slice().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
    return <section className="ix-home ix-dashboard" aria-label="首页工具"><div className="ix-dashboard-content">
      <section className="ix-tools" aria-label="常用工具"><div className="ix-row"><button className="ix-secondary" disabled={nativeBusy} onClick={startRecording}><Mic />{state.session ? '继续课堂' : '录音'}</button><button className="ix-secondary" onClick={() => pickPhoto(state.session ? 'session' : 'new')}><Camera />拍照</button></div><button className="ix-task-entry" aria-label="查看我的任务" onClick={() => setTasksOpen(true)}><ListChecks /><span><strong>今日任务</strong><small>样例 · {todayTasks.length} 项待完成 · 约 {todayTasks.reduce((sum,t) => sum + t.minutes, 0)} 分钟</small></span><ChevronRight /></button>{state.session && <button className="ix-live" onClick={() => setRecordingPage(true)}>{state.session.native ? state.session.started === null ? '录音已暂停' : '课堂录音中' : '课堂演示进行中'} · {clock(elapsed)}</button>}</section>
      <button className="ix-assistant-entry" aria-label="打开学习助手" onClick={() => setAssistantOpen(true)}><img src={tree} alt="" /><strong>学习助手</strong><ChevronRight /></button>
      {!!recent.length && <section className="ix-recent-assistants" aria-label="最近助手对话"><h2>最近对话</h2>{recent.map(item => <button className="ix-list-row" key={item.id} aria-label={`继续助手对话：${item.title}`} onClick={() => selectAssistant(item.id)}><MessageCircle /><span><strong>{item.title}</strong>{!!item.tags.length && <small>{item.tags.join(' · ')}</small>}</span><ChevronRight /></button>)}</section>}
    </div></section>;
  }
  function renderAssistant() {
    return <section className="ix-assistant-page" aria-label="学习助手页面"><aside className="ix-assistant-sidebar">{renderAssistantHistory()}</aside>
      <section className="ix-assistant"><header className="ix-page-head"><button className="ix-icon" aria-label="返回上一页" onClick={() => setAssistantOpen(false)}><ArrowLeft /></button><h1>学习助手</h1><button className="ix-icon ix-history-toggle" aria-label="对话记录" onClick={() => setOverlay('assistant-history')}><History /></button><button className="ix-icon ix-assistant-new" aria-label="新对话" onClick={createAssistant}><Plus /></button></header>
        <div className="ix-assistant-topic"><div className="ix-topic-copy"><span>{activeAssistant.title}</span><div>{activeAssistant.tags.map(tag => <small key={tag}>{tag}</small>)}</div></div><button className="ix-icon" aria-label="对话设置" onClick={() => { setAssistantEdit({ title: activeAssistant.title, tags: activeAssistant.tags.join('、') }); setOverlay('assistant-settings'); }}><MoreHorizontal /></button></div>
        {assistantContext && <div className="ix-context"><FileText /><span>{assistantContext.title}</span><button className="ix-icon" aria-label="移除资料引用" onClick={() => setAssistantContext(null)}><X /></button></div>}
        <div className="ix-messages" ref={assistantLog} role="log" aria-label="学习助手对话">{activeAssistant.messages.length ? <><p className="ix-hint">助手演示 · 未调用 Agent</p>{activeAssistant.messages.map(m => <div key={m.id} className={m.self ? 'ix-message-self' : ''}>{m.attachment ? messageAttachment(m.attachment) : <p className="ix-bubble">{m.text}</p>}</div>)}</> : <div className="ix-assistant-empty"><img src={tree} alt="" /><small>助手演示 · 未调用 Agent</small></div>}</div>
        <form key={activeAssistant.id} className="ix-composer" onSubmit={e => { e.preventDefault(); sendAssistant(); }}><button type="button" className="ix-icon" aria-label="添加内容" onClick={() => setOverlay('assistant-attachments')}><Plus /></button>{assistantVoice ? <HoldInput /> : <textarea aria-label="问问助手" placeholder="问问助手" rows={1} value={activeAssistant.draft} onChange={e => assistantDraft(e.target.value)} />}<button className="ix-icon" type="button" aria-label={assistantVoice ? '切换文字输入' : '切换语音输入'} onClick={() => setAssistantVoice(!assistantVoice)}>{assistantVoice ? <Keyboard /> : <Mic />}</button><button className="ix-send" disabled={!activeAssistant.draft.trim()} aria-label="向助手发送"><Send /></button></form>
      </section>
    </section>;
  }
  function renderRecording() {
    return <section className="ix-recording">{header('课堂记录', () => setRecordingPage(false))}<div className="ix-detail-scroll"><input className="ix-title-input" aria-label="课堂标题" value={state.session!.title} onChange={e => commit(s => ({ ...s, session: { ...s.session!, title: e.target.value } }))} /><div className="ix-recording-status"><small>{state.session?.native ? state.session.started === null ? '录音已暂停' : '录音中' : '录音演示 · 未录音'}</small><strong>{clock(elapsed)}</strong><span>{state.session?.started === null ? '已暂停' : '课堂进行中'}</span></div><div className="ix-timeline">{state.session?.photos.map(p => <section key={p.id}><span className="ix-time">{clock(p.time)}</span><PhotoView photo={p} open={() => setPhotoOpen(p)} /></section>)}{!state.session?.photos.length && <p className="ix-empty">还没有课堂照片</p>}</div></div><footer className="ix-actions"><button disabled={nativeBusy} onClick={toggleRecordingPause}>{state.session?.started === null ? <Play /> : <Pause />}{state.session?.started === null ? '继续' : '暂停'}</button><button onClick={() => pickPhoto('session')}><Camera />拍照</button><button className="ix-stop" disabled={nativeBusy} onClick={finishRecording}><Square />结束并保存</button></footer></section>;
  }
  function renderDiscover() {
    const term = query.trim().toLowerCase(); const visible = materials.filter(m => (!bookmarksOnly || state.bookmarks.includes(m.id)) && (!term || `${m.title} ${m.summary} ${m.sections.map(s => s.text).join(' ')}`.toLowerCase().includes(term)) && (!folder || m.category === folder)); const index = Math.min(card, Math.max(0, visible.length - 1)), item = visible[index];
    if (material) return <section className="ix-detail">{header('阅读', backFromReading, <button className="ix-icon" aria-label="分享这篇资料" onClick={() => { setShareId(material.id); setOverlay('share'); }}><Send /></button>)}<article className="ix-reading ix-detail-scroll"><small>{material.category} · 桌面资料演示</small><h1>{material.title}</h1>{material.id === 'derivative' && <Board />}{material.sections.map(s => <section key={s.heading}><h2>{s.heading}</h2><p>{s.text}</p></section>)}{state.notes.some(n => n.kind === '复述' && n.source === material.id) && <section className="ix-reading-recaps" aria-label="我的复述"><h2>我的复述</h2>{state.notes.filter(n => n.kind === '复述' && n.source === material.id).sort((a,b) => b.at.localeCompare(a.at)).map(n => <button className="ix-list-row" key={n.id} onClick={() => { go('records'); openNote(n.id); }}><Mic /><span><strong>{n.title}</strong><small>{new Date(n.at).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span><ChevronRight /></button>)}</section>}</article><footer className="ix-actions"><button onClick={() => openRecap(material.id)}><Mic />复述</button><button onClick={() => ask(material.id, material.title)}><MessageCircle />问助手</button><button aria-pressed={state.bookmarks.includes(material.id)} onClick={() => bookmark(material.id)}><Bookmark fill={state.bookmarks.includes(material.id) ? 'currentColor' : 'none'} />收藏</button></footer></section>;
    return <section className="ix-discover">{header(bookmarksOnly ? '我的收藏' : '发现', bookmarksOnly ? () => go('mine') : undefined, <button className="ix-icon" aria-label="查看同步状态" onClick={() => setOverlay('sync')}><CloudCheck /></button>)}<label className="ix-search"><Search /><input aria-label="搜索资料" placeholder="搜索笔记、资料" value={query} onChange={e => { setQuery(e.target.value); setCard(0); }} /></label>{!bookmarksOnly && <div className="ix-tabs">{(['推荐', '资料'] as const).map(f => <button key={f} aria-pressed={feed === f} onClick={() => { setFeed(f); setFolder(''); setCard(0); }}>{f}</button>)}</div>}{feed === '资料' ? <div className="ix-library">{!bookmarksOnly && <aside className="ix-folders"><button data-selected={!folder} aria-pressed={!folder} onClick={() => setFolder('')}><Folder />全部资料</button>{[...new Set(materials.map(m => m.category))].map(f => <button key={f} data-selected={folder === f} aria-pressed={folder === f} onClick={() => setFolder(f)}><Folder />{f}</button>)}</aside>}<div className="ix-material-list">{visible.map(m => <button className="ix-list-row" key={m.id} onClick={() => setReading(m.id)}><FileText /><span><strong>{m.title}</strong><small>{m.category}</small></span><ChevronRight /></button>)}{!visible.length && <p className="ix-empty">没有找到资料</p>}</div></div> : <div className="ix-feed">{item ? <><article className="ix-card" data-testid="discover-card" tabIndex={0} onKeyDown={e => { if (e.target !== e.currentTarget) return; if (e.key === 'ArrowRight') setCard(Math.min(index + 1, visible.length - 1)); if (e.key === 'ArrowLeft') setCard(Math.max(index - 1, 0)); }} onTouchStart={e => { if ((e.target as HTMLElement).closest('.ix-card-footer')) return; swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }} onTouchCancel={() => { swipe.current = null; }} onTouchEnd={e => { const start = swipe.current; swipe.current = null; if (!start) return; const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.3) { swipedAt.current = Date.now(); setCard(Math.max(0, Math.min(visible.length - 1, index + (dx < 0 ? 1 : -1)))); } }}><button className="ix-card-open" onClick={() => { if (Date.now() - swipedAt.current > 500) setReading(item.id); }}><small><Folder />{item.category}</small><h2>{item.title}</h2>{item.id === 'derivative' && <Board />}<p>{item.summary}</p><p className="ix-excerpt">{item.sections[0].text}</p></button><div className="ix-card-footer"><small>桌面笔记 · 演示</small><button className="ix-icon" aria-label="收藏卡片" aria-pressed={state.bookmarks.includes(item.id)} onClick={() => bookmark(item.id)}><Bookmark fill={state.bookmarks.includes(item.id) ? 'currentColor' : 'none'} /></button></div></article><div className="ix-pagination"><button className="ix-icon" aria-label="上一张" disabled={index === 0} onClick={() => setCard(index - 1)}><ArrowLeft /></button><span>{index + 1} / {visible.length}</span><button className="ix-icon" aria-label="下一张" disabled={index === visible.length - 1} onClick={() => setCard(index + 1)}><ArrowRight /></button></div></> : <p className="ix-empty">没有找到资料</p>}</div>}</section>;
  }

  const mobileDetail = tasksOpen || assistantOpen || recordingPage || !!reading || bookmarksOnly || tab === 'messages' && !!thread || tab === 'records' && !!note;
  return <div className="ix-root" data-keyboard={keyboard} data-native={platform.isNative}><div className="ix-prototype-bar"><span>LogiNote · 前端交互演示</span><a href="../mobile-concepts/index.html">概念图</a></div>{!signedIn && platform.isNative ? <main className="ix-login ix-native-welcome"><img src={tree} alt="LogiNote 世界树" /><strong className="ix-wordmark">LogiNote</strong><h1>本机学习空间</h1><p>课堂录音与照片保存在此设备。云同步和学习助手服务尚未接入。</p><button className="ix-primary" onClick={() => { try { localStorage.setItem('loginote.local-onboarding', 'yes'); setSignedIn(true); } catch { setError('无法保存本机设置，请检查存储空间。'); } }}>开始本机使用</button></main> : !signedIn ? <main className="ix-login"><img src={tree} alt="LogiNote 世界树" /><strong className="ix-wordmark">LogiNote</strong><form onSubmit={e => { e.preventDefault(); try { sessionStorage.setItem('loginote.demo-session', 'yes'); setSignedIn(true); setPassword(''); setError(''); } catch { setError('浏览器会话存储不可用，请允许本机存储。'); } }}><h1>登录</h1><input type="email" aria-label="邮箱" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} required /><input type="password" autoComplete="off" aria-label="密码" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} required /><button type="button" className="ix-text ix-forgot" onClick={() => setOverlay('forgot')}>忘记密码</button><button className="ix-primary" disabled={!consent || !email || !password}>进入登录演示</button><button type="button" className="ix-text" onClick={() => setOverlay('register')}>注册账号</button><label className="ix-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我已阅读演示说明 <button type="button" className="ix-text" onClick={() => setOverlay('policies')}>协议与隐私</button></label><small className="ix-hint">仅演示登录交互，请使用任意测试邮箱与测试密码。</small></form></main> : <div className={`ix-shell ${mobileDetail ? 'ix-mobile-detail' : ''}`}><nav className="ix-nav" aria-label="主导航"><div className="ix-nav-brand">LogiNote</div>{navigation.map(({ id, name, Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}><Icon /><span>{name}</span></button>)}</nav><main className="ix-main" ref={scroll}>{tab === 'home' && !assistantOpen && !recordingPage && !tasksOpen && <div className="ix-home-head"><strong className="ix-wordmark">LogiNote</strong></div>}{tasksOpen && <div className="ix-task-surface" hidden={!!reading || assistantOpen || recordingPage}><MobileTasks tasks={state.mobileTasks} onChange={tasks => commit(s => ({ ...s, mobileTasks: tasks }))} onOpenMaterial={id => setReading(id)} onRecap={openRecap} onAsk={ask} onClose={() => setTasksOpen(false)} /></div>}{assistantOpen ? renderAssistant() : tasksOpen && reading ? renderDiscover() : recordingPage && state.session ? renderRecording() : tasksOpen ? null : tab === 'home' ? renderHome() : tab === 'discover' ? renderDiscover() : tab === 'messages' ? renderMessages() : tab === 'records' ? renderRecords() : <section className="ix-mine">{header('我的')}<div className="ix-profile"><img src={tree} alt="" /><div><h2>{platform.isNative ? '本机学习空间' : '本机体验账号'}</h2><small>{platform.isNative ? 'Android 本机版' : '前端演示'}</small></div></div><button className="ix-settings-row" onClick={() => setOverlay('sync')}><CloudCheck />设备与同步<ChevronRight /></button><button className="ix-settings-row" onClick={() => { go('discover'); setFeed('资料'); setQuery(''); setBookmarksOnly(true); }}><Bookmark />我的收藏<span>{state.bookmarks.length}</span></button><button className="ix-settings-row" onClick={() => setOverlay('policies')}><Settings />隐私与说明<ChevronRight /></button><button className="ix-settings-row" onClick={() => { if (state.session || editing) { setNotice('请先结束课堂并保存编辑'); return; } try { if (platform.isNative) localStorage.removeItem('loginote.local-onboarding'); else sessionStorage.removeItem('loginote.demo-session'); setSignedIn(false); setPassword(''); } catch { setError('退出失败，请重试。'); } }}><LogOut />退出体验</button></section>}</main></div>}
    <input className="ix-hidden" ref={photoInput} type="file" accept="image/*" capture="environment" aria-label="选择课堂照片" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void attachPhoto(file); }} />
    {error && <div className="ix-error" role="alert">{error}{!!state.pendingRecordingDeletes.length && <button className="ix-secondary" disabled={nativeBusy} onClick={() => void finishNativeDeletes()}>重试删除</button>}<button className="ix-icon" aria-label="收起错误提示" onClick={() => setError('')}><X /></button></div>}{notice && <div className="ix-toast" role="status">{notice}</div>}
    {recap && <Recap text={state.recap} resumedSource={state.recap.trim() && state.recapSource !== reading ? sourceTitle({ source: state.recapSource, sourceTitle: state.recapSourceTitle }) || '独立记录' : undefined} error={error} onChange={text => { const next = { ...current.current, recap: text }; current.current = next; setState(next); try { persistState(next, damaged.current); damaged.current = undefined; } catch { setError('草稿尚未保存，请保留当前页面。'); } }} close={() => setRecap(false)} save={() => { const text = state.recap.trim(); if (!text) return; const entry: Note = { id: uid(), title: text.slice(0, 24), at: new Date().toISOString(), duration: 0, kind: '复述', source: state.recapSource, sourceTitle: sourceTitle({ source: state.recapSource, sourceTitle: state.recapSourceTitle }) || undefined, photos: [], segments: [{ id: uid(), time: 0, text }] }; if (commit(s => ({ ...s, recap: '', recapSource: undefined, recapSourceTitle: undefined, notes: [entry, ...s.notes] }))) { setRecap(false); setNotice(entry.sourceTitle ? `已关联「${entry.sourceTitle}」并保存` : '复述已保存到记录'); } }} />}
    {photoOpen && <Dialog title="课堂照片" close={() => setPhotoOpen(null)}><PhotoView photo={photoOpen} /></Dialog>}
    {overlay && <Dialog title={{ sync: '设备与同步', auth: '引用课堂记录', policies: '协议与隐私', register: '注册演示', forgot: '找回密码', share: '分享资料', 'thread-menu': '会话设置', 'note-menu': editing ? '放弃编辑？' : '记录操作', delete: '删除记录？', 'assistant-history': '对话记录', 'assistant-settings': '对话设置', 'assistant-attachments': '添加内容', 'chat-attachments': '添加内容' }[overlay]} close={() => setOverlay(null)}>{error && <p className="ix-hint" role="alert">{error}</p>}
      {overlay === 'assistant-history' && renderAssistantHistory()}
      {overlay === 'assistant-attachments' && <><button className="ix-settings-row" onClick={() => setOverlay('auth')}><FileText />引用课堂记录<ChevronRight /></button><button className="ix-settings-row" onClick={() => pickPhoto('assistant')}><Camera />拍照或选图<ChevronRight /></button></>}
      {overlay === 'chat-attachments' && <><button className="ix-settings-row" onClick={() => { setShareId(state.notes[0]?.id || 'derivative'); setOverlay('share'); }}><FileText />分享记录<ChevronRight /></button><button className="ix-settings-row" onClick={() => pickPhoto('chat')}><Camera />拍照或选图<ChevronRight /></button></>}
      {overlay === 'assistant-settings' && <><label className="ix-field">对话名称<input aria-label="对话名称" maxLength={60} value={assistantEdit.title} onChange={e => setAssistantEdit({ ...assistantEdit, title: e.target.value })} /></label><label className="ix-field">标签<input aria-label="对话标签" placeholder="用逗号分隔" maxLength={100} value={assistantEdit.tags} onChange={e => setAssistantEdit({ ...assistantEdit, tags: e.target.value })} /></label><button className="ix-primary" disabled={!assistantEdit.title.trim()} onClick={() => { const tags = [...new Set(assistantEdit.tags.split(/[,，、]/).map(t => t.trim()).filter(Boolean))].slice(0, 4); if (commit(s => ({ ...s, assistantThreads: s.assistantThreads.map(t => t.id === s.activeAssistantId ? { ...t, title: assistantEdit.title.trim(), tags, updatedAt: new Date().toISOString() } : t) }))) setOverlay(null); }}>保存对话设置</button></>}
      {overlay === 'sync' && <><p>同步交互演示，资料均来自本机样例。</p><div className="ix-device"><FileText />桌面端<span>演示资料</span></div><div className="ix-device"><UserRound />本机<span>{state.notes.length} 条记录</span></div><button className="ix-primary" onClick={() => { setNotice('演示同步已完成 · 未连接服务器'); setOverlay(null); }}>模拟同步</button></>}
      {overlay === 'auth' && <>{state.notes.map(n => <button className="ix-list-row" key={n.id} onClick={() => { if (setAssistantContext({ id: n.id, title: n.title })) setOverlay(null); }}><FileText /><span>{n.title}</span><ChevronRight /></button>)}</>}
      {(overlay === 'policies' || overlay === 'register' || overlay === 'forgot') && <p>{overlay === 'policies' ? '这是本地交互原型，不连接真实账号、云同步、转写或 Agent 服务。密码不会保存。照片和输入仅保存在当前浏览器。正式协议将在服务接入时提供。' : overlay === 'register' ? '此处演示注册入口，尚未创建真实账号。返回后可使用测试邮箱进入体验。' : '此处演示找回密码入口，尚未发送邮件。'}</p>}
      {overlay === 'share' && <><label className="ix-field">选择资料<select aria-label="选择分享资料" value={shareId || ''} onChange={e => setShareId(e.target.value)}><option value="" disabled>请选择</option>{state.notes.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}{materials.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label><p className="ix-hint">仅演示分享，不会发送给他人。</p>{threads.map(t => <button className="ix-list-row" key={t.id} disabled={!shareId || state.blocked.includes(t.id)} onClick={() => share(t.id)}><MessageCircle /><span>{t.name}</span><Send /></button>)}</>}
      {overlay === 'thread-menu' && thread && <><button className="ix-settings-row" onClick={() => { if (commit(s => ({ ...s, blocked: s.blocked.includes(thread) ? s.blocked.filter(id => id !== thread) : [...s.blocked, thread] }))) setOverlay(null); }}>{state.blocked.includes(thread) ? '解除屏蔽' : '屏蔽会话'}</button><button className="ix-settings-row" onClick={() => { setNotice('举报流程演示 · 未提交'); setOverlay(null); }}>举报</button></>}
      {overlay === 'note-menu' && (editing ? <><p>未保存的修改将被放弃。</p><button className="ix-primary" onClick={() => { setEditing(null); setOverlay(null); }}>放弃修改</button><button className="ix-secondary" onClick={() => setOverlay(null)}>继续编辑</button></> : <><button className="ix-settings-row" onClick={() => { setShareId(note!.id); setOverlay('share'); }}>分享记录</button><button className="ix-settings-row ix-danger" onClick={() => setOverlay('delete')}>删除记录</button></>)}
      {overlay === 'delete' && <><p>删除「{note?.title}」？</p><button className="ix-primary" disabled={nativeBusy} onClick={() => void deleteNote()}>确认删除</button></>}
    </Dialog>}
  </div>;
}
