import React, { useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, RotateCcw } from 'lucide-react';
import type { NoteItem, ReviewMessage } from '../types';
import { ReviewChat } from './ReviewChat';
import { useReviewExitGuard } from './useReviewExitGuard';

const note: NoteItem = { id: 'review-exit-demo-note', title: '贝叶斯定理', noteType: 'knowledge',
  content: '用先验和似然修正判断，区分概率模型与直觉。', dueDates: [], tags: [], links: [], backlinks: [],
  createdAt: '2026-10-06', updatedAt: '2026-10-06' };
const messages: ReviewMessage[] = [{ id: 'tutor-0', role: 'tutor', content: '请用自己的话说明：看到新证据后，你会怎样更新原有判断？', timestamp: '2026-10-06T10:00:00Z' }];
const draft = { id: 'review-demo-saved-draft', content: '我会先区分原有判断和新证据。\n新证据能否改变结论，还要看它在不同假设下出现的可能性。', timestamp: '2026-10-06T10:02:00Z' };

/** Isolated UI fixture: all completion and recovery state stays in component memory. */
export const ReviewExitDemoPage: React.FC = () => {
  const [version, setVersion] = useState(0);
  const [failNext, setFailNext] = useState(true);
  const failRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const guard = useReviewExitGuard();
  const sessionRef = useRef<string | null>(null);
  const [navigationMessage, setNavigationMessage] = useState('');
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', color: 'var(--ln-text-primary)', background: 'var(--ln-bg-surface)' }}>
    <header style={{ flexShrink: 0, padding: '.65rem 1rem', borderBottom: '1px solid var(--ln-border)', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap', fontSize: '.7rem' }}>
      <span style={{ display: 'inline-flex', gap: '.35rem', alignItems: 'center', color: 'var(--ln-accent)' }}><FlaskConical size={16} />复习交互预览 · 不写入笔记库，不调用模型与语音</span>
      <label style={{ marginLeft: 'auto', display: 'inline-flex', gap: '.35rem', alignItems: 'center' }}><input type="checkbox" checked={failNext} disabled={saving} onChange={(event) => { failRef.current = event.target.checked; setFailNext(event.target.checked); }} />模拟下次保存失败</label>
      <button type="button" onClick={() => { if (guard.allowNavigation()) setNavigationMessage('当前可以切换页面。演示保留在本页。'); }} style={{ minHeight: 44, padding: '.4rem .7rem', border: '1px solid var(--ln-border)', borderRadius: 'var(--ln-radius-sm)', color: 'var(--ln-accent)' }}>尝试切换页面</button>
      <button type="button" disabled={saving} onClick={() => { if (sessionRef.current) guard.updateStatus('idle', sessionRef.current); setNavigationMessage(''); setSaved(false); setVersion((value) => value + 1); }} style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem', padding: '.4rem .7rem', minHeight: 44, borderRadius: 'var(--ln-radius-sm)', border: '1px solid var(--ln-border)', color: 'var(--ln-accent)', background: 'var(--ln-bg-surface)' }}><RotateCcw size={14} />重置演示</button>
    </header>
    <main style={{ flex: 1, minHeight: 0 }}>
      {saved ? <div role="status" style={{ padding: '3rem', display: 'flex', alignItems: 'center', gap: '.65rem', color: 'var(--ln-accent)' }}><CheckCircle2 size={22} /><span>保存成功后才退出复习。演示没有修改真实笔记。</span></div>
        : <ReviewChat key={version} noteId={note.id} noteTitle={note.title} questionText={messages[0].content} knowledgeContext={note.content} allNotes={[note]}
          previewOnly previewMessages={messages} previewSavedDraft={draft}
          onExitSaveStateChange={(phase, sessionId) => { sessionRef.current = sessionId; guard.updateStatus(phase, sessionId); }}
          onReviewComplete={async () => {
            setSaving(true);
            try {
              await new Promise((resolve) => setTimeout(resolve, 1500));
              if (failRef.current) { failRef.current = false; setFailNext(false); throw new Error('模拟磁盘保存失败，请重试。'); }
              setSaved(true);
            } finally { setSaving(false); }
          }} />}
    </main>
    {(guard.notice || navigationMessage) && <div role="status" className="scene-lock-notice">{guard.notice || navigationMessage}</div>}
  </div>;
};
