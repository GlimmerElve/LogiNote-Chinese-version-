import React, { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { clock, type Note } from './interaction-data';
import { getMobilePlatform } from './mobile-platform';

export function RecordingPlayer({ note, position, playing, speed, onPosition, onPlaying, onSpeed, onError }: {
  note: Note; position: number; playing: boolean; speed: number;
  onPosition: (value: number) => void; onPlaying: (value: boolean) => void; onSpeed: (value: number) => void; onError: (message: string) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(note.duration);
  useEffect(() => setDuration(note.duration), [note.id, note.duration]);
  const uri = note.audioUri ? getMobilePlatform().fileUrl?.(note.audioUri) || note.audioUri : undefined;
  useEffect(() => { const el = audio.current; if (!el) return; el.playbackRate = speed; }, [speed, uri]);
  useEffect(() => { const el = audio.current; if (!el || !Number.isFinite(el.duration)) return; if (Math.abs(el.currentTime - position) > .75) el.currentTime = Math.min(position, el.duration); }, [position, uri]);
  useEffect(() => { if (!playing) audio.current?.pause(); }, [playing]);
  function toggle() {
    if (!uri) { if (position >= note.duration) onPosition(0); onPlaying(!playing); return; }
    const el = audio.current!;
    if (!el.paused) { el.pause(); onPlaying(false); return; }
    if (el.ended) { el.currentTime = 0; onPosition(0); }
    void el.play().then(() => onPlaying(true)).catch(() => { onPlaying(false); onError('录音暂时无法回放，请保留原文件后重试。'); });
  }
  if (!uri && getMobilePlatform().isNative && note.recordingState) return <p className="ix-hint">录音文件暂不可用，已保留这条课堂记录。</p>;
  return <><div className="ix-player">
    {uri && <audio ref={audio} src={uri} preload="metadata" onLoadedMetadata={e => { if (Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0) setDuration(e.currentTarget.duration); }} onTimeUpdate={e => onPosition(e.currentTarget.currentTime)} onPause={() => onPlaying(false)} onEnded={() => onPlaying(false)} onError={() => { onPlaying(false); onError('无法读取这段录音，原文件仍保留在设备中。'); }} />}
    <button className="ix-icon" aria-label={uri ? playing ? '暂停录音' : '播放录音' : playing ? '暂停进度演示' : '播放进度演示'} onClick={toggle}>{playing ? <Pause /> : <Play />}</button>
    <input type="range" aria-label="录音位置" min={0} max={duration} step={.1} value={Math.min(position, duration)} onChange={e => { const next = +e.target.value; if (audio.current && Number.isFinite(audio.current.duration)) audio.current.currentTime = Math.min(next, audio.current.duration); onPosition(next); }} />
    <span>{clock(position)} / {clock(duration)}</span><select aria-label="播放速度" value={speed} onChange={e => onSpeed(+e.target.value)}>{[1, 1.5, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select>
  </div>{!uri && <p className="ix-hint">回听进度演示 · 未附真实音频</p>}{note.recordingState === 'interrupted' && <p className="ix-hint">录音曾中断，已保留可恢复文件。</p>}</>;
}
