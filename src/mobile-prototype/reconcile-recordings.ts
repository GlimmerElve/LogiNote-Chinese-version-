import { type Note, type State } from './interaction-data';
import { type NativeRecording } from './mobile-platform';

/** The native recorder owns audio lifecycle; React owns titles, photos and annotations. */
export function reconcileRecordings(state: State, status: NativeRecording, recordings: NativeRecording[]): State {
  let notes = state.notes, session = state.session;
  const ended = recordings.filter(r => r.id && r.fileUri && (r.state === 'stopped' || r.state === 'interrupted') && !state.dismissedRecordingIds.includes(r.id));
  for (const recording of ended) {
    const previous = notes.find(n => n.id === recording.id);
    const pending = session?.id === recording.id ? session : undefined;
    if (previous) {
      if (previous.audioUri !== recording.fileUri || previous.recordingState !== recording.state) notes = notes.map(n => n.id === recording.id ? { ...n, audioUri: recording.fileUri, recordingState: recording.state as 'stopped' | 'interrupted', duration: Math.max(1, Math.floor(recording.durationMs / 1000)) } : n);
    } else {
      const note: Note = { id: recording.id!, title: pending?.title || recording.title || '恢复的课堂录音', at: pending?.at || new Date(Number.isFinite(recording.createdAt) ? recording.createdAt! : Date.now() - recording.durationMs).toISOString(), duration: Math.max(1, Math.floor(recording.durationMs / 1000)), kind: '课堂', photos: pending?.photos || [], segments: [], audioUri: recording.fileUri, recordingState: recording.state as 'stopped' | 'interrupted' };
      notes = [note, ...notes];
    }
  }
  if (status.id && (status.state === 'recording' || status.state === 'paused')) {
    const previous = session?.id === status.id ? session : undefined;
    session = { id: status.id, title: previous?.title || status.title || '课堂录音', at: previous?.at || new Date(Number.isFinite(status.createdAt) ? status.createdAt! : Date.now() - status.durationMs).toISOString(), elapsed: status.durationMs / 1000, started: status.state === 'recording' ? Date.now() : null, photos: previous?.photos || [], native: true };
  } else if (session?.native && !state.dismissedRecordingIds.includes(session.id)) {
    if (!notes.some(n => n.id === session!.id)) notes = [{ id: session.id, title: session.title, at: session.at, duration: Math.max(1, Math.floor(session.elapsed)), kind: '课堂', segments: [], photos: session.photos, recordingState: 'interrupted' }, ...notes];
    session = null;
  }
  return notes === state.notes && session === state.session ? state : { ...state, notes, session };
}
