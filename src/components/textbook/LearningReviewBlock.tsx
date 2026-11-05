import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LearningReviewPatch, LearningReviewRecord } from '../../services/textbook/types';
import './learningReview.css';
import { readFlowReviewIndexStatus } from '../../services/cognition/flowReviewStatus';
import { useEditorInputLeave } from '../useEditorInputLeave';

interface Props {
  record: LearningReviewRecord;
  onPatch?: (patch: LearningReviewPatch) => void | Promise<void>;
  children?: React.ReactNode;
}

const STATUS_LABELS = {
  pending_analysis: '待复盘分析', text_only: '已保存复述', analysis_failed: '分析未完成',
  analyzed: '待保存结构图', completed: '复盘已保存',
};

/** 使用原生 disclosure 保留 Enter/Space 和读屏语义，不在 summary 内嵌编辑输入。 */
export function LearningReviewBlock({ record, onPatch, children }: Props) {
  const [editing, setEditing] = useState<'title' | 'text' | null>(null);
  const [title, setTitle] = useState(record.title);
  const [text, setText] = useState(record.editedRestatement);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [indexNotice, setIndexNotice] = useState('');
  useEffect(() => {
    setIndexNotice('');
    if (!record.expanded || !record.argumentDocIds.length) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, attempts = 0;
    const read = async () => {
      try {
        const status = await readFlowReviewIndexStatus(record.projectNoteId);
        if (cancelled) return;
        const present = status && record.argumentDocIds.every(id => status.graphIds.includes(id));
        setIndexNotice(!status ? '个人素材索引状态暂不可查；桌面端更新后可确认。'
          : status.processing ? '个人素材索引正在后台更新，可以离开本页。'
          : !present ? '结构图已保存，个人素材索引尚未就绪。'
          : status.vectorStatus === 'ready' ? '结构图已进入个人素材检索；立场未确认，不作为事实依据。'
          : '结构图已进入个人素材检索；向量暂不可用，当前可按词项和关系查找。');
        if (status?.processing && ++attempts < 6) timer = setTimeout(read, 2000);
      } catch { if (!cancelled) setIndexNotice('结构图已保存，个人素材索引状态读取失败；可重新展开查看。'); }
    };
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [record.id, record.projectNoteId, record.expanded, record.updatedAt, record.argumentDocIds.join('|')]);
  const lock = useRef(false);
  const mounted = useRef(false);
  const owner = useRef(record.id);
  const generation = useRef(0);
  const section = useRef<HTMLElement>(null);
  const input = useRef({ mode: null as 'title' | 'text' | null, title: record.title, text: record.editedRestatement });
  const latestRecord = useRef(record); latestRecord.current = record;
  const leave = useEditorInputLeave(() => lock.current ? '复盘修改正在保存，请等待结果返回后再离开。'
    : (input.current.mode === 'title' && input.current.title !== latestRecord.current.title
      || input.current.mode === 'text' && input.current.text !== latestRecord.current.editedRestatement)
      ? '复盘标题或复述有未保存的修改，请先保存修改或取消编辑，再离开。' : null, section, Boolean(editing || saving));
  const editButtons = useRef<Partial<Record<'title' | 'text', HTMLButtonElement | null>>>({});
  const retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useLayoutEffect(() => {
    owner.current = record.id; generation.current++;
    input.current = { mode: null, title: record.title, text: record.editedRestatement };
    setEditing(null); setTitle(record.title); setText(record.editedRestatement); setError(''); setNotice('');
  }, [record.id]);
  useEffect(() => {
    if (editing !== 'title') { input.current.title = record.title; setTitle(record.title); }
    if (editing !== 'text') { input.current.text = record.editedRestatement; setText(record.editedRestatement); }
  }, [record.id, record.title, record.editedRestatement, editing]);
  useEffect(() => {
    if (error && editing && !saving && document.activeElement === document.body) {
      retryButton.current?.focus({ preventScroll: true });
    }
  }, [error, editing, saving]);
  const update = async (patch: LearningReviewPatch) => {
    if (!onPatch || lock.current || owner.current !== record.id) return;
    lock.current = true;
    const version = generation.current;
    const mode = editing;
    const current = () => mounted.current && version === generation.current && owner.current === record.id;
    setSaving(true); setError(''); setNotice('');
    try {
      await onPatch(patch);
      if (!current()) return;
      if (patch.title !== undefined || patch.editedRestatement !== undefined) {
        input.current.mode = null; leave.clearNotice();
        setEditing(null); setNotice('修改已保存');
        // Restore only if focus was lost by disabling the submitted form.
        requestAnimationFrame(() => {
          if (current() && mode && (document.activeElement === document.body || section.current?.contains(document.activeElement))) {
            editButtons.current[mode]?.focus({ preventScroll: true });
          }
        });
      }
    } catch {
      if (current()) setError('保存未成功，编辑内容已保留，请重试保存。');
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const edit = (mode: 'title' | 'text') => {
    if (lock.current || editing !== null || owner.current !== record.id) return;
    input.current.mode = mode; setEditing(mode); setError(''); setNotice(''); leave.clearNotice();
  };
  return (
    <section ref={section} className="learning-review-block" contentEditable={false} data-review-record-id={record.id} aria-busy={saving}>
      <details open={record.expanded === true} onToggle={(event) => {
        const expanded = event.currentTarget.open;
        if (expanded !== (record.expanded === true)) void update({ expanded });
      }}>
        <summary aria-disabled={saving} onClick={(event) => { if (lock.current) event.preventDefault(); }} onKeyDownCapture={(event) => {
          // Lexical 的空格快捷键不能吞掉原生 disclosure 的默认操作。
          if (event.key === ' ' || event.key === 'Enter') { event.stopPropagation(); if (lock.current) event.preventDefault(); }
        }}><span className="learning-review-title">{record.title}</span>
          <span className="learning-review-status">{STATUS_LABELS[record.status]}</span></summary>
        <div className="learning-review-body">
          <div className="learning-review-actions">
            <span>个人学习记录 · 与教材分开保存</span>
            {onPatch && <><button type="button" ref={element => { editButtons.current.title = element; }} disabled={saving || editing !== null} onClick={() => edit('title')}>修改标题</button>
              <button type="button" ref={element => { editButtons.current.text = element; }} disabled={saving || editing !== null} onClick={() => edit('text')}>编辑复述</button></>}
          </div>
          {editing && <form onSubmit={(event) => {
            event.preventDefault();
            if (lock.current) return;
            if (editing === 'title' && !title.trim()) { setError('标题不能为空'); return; }
            void update(editing === 'title' ? { title } : { editedRestatement: text });
          }}>
            <label>{editing === 'title' ? '学习记录标题' : '本次复述'}
              {editing === 'title' ? <input autoFocus disabled={saving} value={title} onChange={(event) => { if (!lock.current) { input.current.title = event.target.value; setTitle(event.target.value); } }} maxLength={300} />
                : <textarea autoFocus disabled={saving} rows={7} value={text} onChange={(event) => { if (!lock.current) { input.current.text = event.target.value; setText(event.target.value); } }} />}</label>
            <div className="learning-review-actions"><button ref={retryButton} type="submit" disabled={saving}>{saving ? '正在保存…' : error ? '重试保存' : '保存修改'}</button>
              <button type="button" onClick={() => { if (!lock.current) { input.current.mode = null; setEditing(null); setError(''); leave.clearNotice(); } }} disabled={saving}>取消</button></div>
          </form>}
          {saving && <p role="status" className="learning-review-notice">正在保存，请稍候…</p>}
          {notice && <p role="status" className="learning-review-notice">{notice}</p>}
          {error && <p role="alert" className="learning-review-error">{error}</p>}
          <div className="learning-review-restatement"><ReactMarkdown remarkPlugins={[remarkGfm]}>
            {record.editedRestatement || '本次没有记录复述文本。'}
          </ReactMarkdown></div>
          {record.summary && <p className="learning-review-summary">本次总结：{record.summary}</p>}
          {record.analysisSummary && <p className="learning-review-summary">分析摘要：{record.analysisSummary}</p>}
          {indexNotice && <p className="learning-review-summary" role="status" aria-live="polite">{indexNotice}</p>}
          {record.error && <p className="learning-review-error">{record.error}；复述已保留，可稍后重试。</p>}
          {children}
          {record.rawRestatement !== record.editedRestatement && <details className="learning-review-raw">
            <summary>查看原始记录</summary><pre>{record.rawRestatement}</pre></details>}
        </div>
      </details>
      {leave.notice && <p role="status" className="learning-review-notice">{leave.notice}</p>}
    </section>
  );
}
