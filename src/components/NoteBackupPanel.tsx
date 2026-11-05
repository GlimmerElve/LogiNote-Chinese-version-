import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import type { NoteItem } from '../types';
import { MAX_NOTE_BACKUP_BYTES, noteBackupPreview, parseNoteJsonBackup,
  type NoteBackupRestoreMode, type NoteBackupRestoreRequest, type NoteBackupRestoreResult } from '../services/noteJsonBackup';
import { useDialog } from './useDialog';

export interface NoteBackupPanelProps {
  notes: NoteItem[];
  onRestore?: (request: NoteBackupRestoreRequest) => Promise<NoteBackupRestoreResult>;
}
const button = 'min-h-11 px-4 py-2 rounded-xl text-xs font-semibold border border-[var(--ln-border)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]';
const primary = `${button} bg-[var(--ln-accent)] text-[var(--ln-bg-surface)]`;
export function NoteBackupPanel({ notes, onRestore }: NoteBackupPanelProps) {
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ name: string; notes: NoteItem[]; expected: NoteItem[] } | null>(null);
  const [mode, setMode] = useState<NoteBackupRestoreMode>('missing');
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const operation = useRef(false), mounted = useRef(true), readSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readSequence.current++; }; }, []);
  const close = () => { if (!operation.current) { setPreview(null); setError(''); } };
  useDialog(Boolean(preview), dialog, busy ? undefined : close, 65);
  const counts = preview ? noteBackupPreview(preview.expected, preview.notes) : { added: 0, existing: 0 };
  const affected = counts.added + (mode === 'replace' ? counts.existing : 0);

  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `LogiNote_Vault_Backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    // Keep the blob alive while Chromium starts the download.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const readBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file || operation.current) return;
    const sequence = ++readSequence.current;
    setReading(true); setError(''); setMessage('');
    try {
      if (file.size > MAX_NOTE_BACKUP_BYTES) throw new Error('笔记备份超过 50 MB，请拆分后恢复');
      const incoming = parseNoteJsonBackup(await file.text());
      if (!mounted.current || sequence !== readSequence.current) return;
      setMode('missing'); setPreview({ name: file.name, notes: incoming, expected: notes });
    } catch (failure) {
      if (mounted.current && sequence === readSequence.current) setError(failure instanceof Error ? failure.message : '读取备份失败');
    } finally { if (mounted.current && sequence === readSequence.current) setReading(false); }
  };
  const restore = async () => {
    if (!preview || !onRestore || operation.current || !affected) return;
    operation.current = true; setBusy(true); setError('');
    try {
      const result = await onRestore({ notes: preview.notes, expected: preview.expected, mode });
      if (mounted.current) {
        setPreview(null);
        setMessage(`恢复完成：新增 ${result.added} 篇，恢复同编号笔记 ${result.replaced} 篇，跳过同编号笔记 ${result.skipped} 篇。`);
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '恢复失败，备份预览已保留，可重试'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  return <>
    <section inert={preview ? true : undefined} className="p-4 sm:p-5 rounded-2xl bg-[var(--ln-bg-surface)] border border-[var(--ln-border)] shadow-sm space-y-3" aria-labelledby="settings-export-title">
      <h2 id="settings-export-title" className="text-sm font-semibold text-[var(--ln-text-primary)]">笔记备份与恢复</h2>
      <p className="text-xs leading-relaxed">导出全部 {notes.length} 篇笔记为 JSON，也可选择以前导出的 JSON 恢复笔记。文件包含正文、标签、计划和附带的复习记录；完整备份仍需复制数据目录，包括上传资料、模型配置和独立学习档案。</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={exportJson} className={primary}><Download className="inline w-4 h-4 mr-2" />导出全部笔记 (JSON)</button>
        <button type="button" onClick={() => input.current?.click()} disabled={!onRestore || reading || busy} className={button}><Upload className="inline w-4 h-4 mr-2" />{reading ? '正在读取备份…' : '从 JSON 恢复笔记'}</button>
        <input ref={input} type="file" accept=".json,application/json" aria-label="选择笔记 JSON 备份" className="hidden" onChange={readBackup} disabled={reading || busy} />
      </div>
      <p className="text-xs leading-relaxed">恢复前会显示预览，默认只补回缺失笔记；支持本软件旧版本导出的笔记数组，单个文件最多 50 MB。</p>
      {message && <p role="status" className="text-xs text-[var(--ln-accent)]">{message}</p>}
      {!preview && error && <p role="alert" className="text-xs text-[var(--ln-danger)]">{error}</p>}
    </section>
    {preview && <div className="fixed inset-0 z-[85] bg-black/50 flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="note-backup-title" aria-describedby="note-backup-description" aria-busy={busy} tabIndex={-1}
        className="w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl bg-[var(--ln-bg-surface)] text-[var(--ln-text-primary)] border border-[var(--ln-border)] shadow-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3"><h2 id="note-backup-title" className="font-semibold">恢复笔记预览</h2><button type="button" aria-label="关闭恢复预览" onClick={close} disabled={busy} className={button}><X className="w-4 h-4" /></button></div>
        <p id="note-backup-description" className="text-sm break-all">{preview.name}：共 {preview.notes.length} 篇，缺失 {counts.added} 篇，同编号 {counts.existing} 篇。</p>
        <fieldset disabled={busy} className="space-y-3 text-sm"><legend className="mb-2 font-semibold">恢复方式</legend>
          <label className="flex items-start gap-2"><input type="radio" name="note-backup-mode" checked={mode === 'missing'} onChange={() => setMode('missing')} /><span>仅补回缺失笔记，保留同编号笔记（推荐）</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="note-backup-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /><span>同时用备份恢复同编号笔记</span></label>
        </fieldset>
        <p className={`text-xs leading-relaxed ${mode === 'replace' && counts.existing ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-text-secondary)]'}`}>
          {mode === 'replace' ? `将新增 ${counts.added} 篇，并用备份中的内容和随附状态替换 ${counts.existing} 篇现有笔记。其它笔记保留。` : `将新增 ${counts.added} 篇，并跳过 ${counts.existing} 篇同编号笔记。`}
        </p>
        {affected === 0 && <p role="status" className="text-xs">这些笔记均已存在；如需恢复旧内容，请选择“同时用备份恢复同编号笔记”。</p>}
        {error && <p role="alert" className="text-xs text-[var(--ln-danger)]">{error}</p>}
        <div className="flex justify-end gap-3"><button type="button" onClick={close} disabled={busy} className={button}>取消</button><button type="button" onClick={restore} disabled={busy || !affected || !onRestore} className={primary}>{busy ? '正在恢复…' : error ? '重试恢复' : `确认恢复 ${affected} 篇笔记`}</button></div>
      </div>
    </div>}
  </>;
}
