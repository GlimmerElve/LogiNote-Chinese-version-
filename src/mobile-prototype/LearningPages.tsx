import React, { useDeferredValue, useState } from 'react';
import { ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, NotebookPen, Plus, Search, X, XCircle } from 'lucide-react';
import { questions, readings, type Capture } from './data';
import './learning-pages.css';

type PracticePageProps = {
  questionIndex: number;
  selected: number | null;
  answers: Record<string, number>;
  onSelect: (index: number) => void;
  onQuestionChange: (index: number) => void;
  onSubmit: () => void;
  onOpenSource: (sourceId: string) => void;
};

export function PracticePage({ questionIndex, selected, answers, onSelect, onQuestionChange, onSubmit, onOpenSource }: PracticePageProps) {
  const index = Math.max(0, Math.min(questionIndex, questions.length - 1));
  const question = questions[index];
  const answered = Object.hasOwn(answers, question.id);
  const answer = answered ? answers[question.id] : selected;
  const correct = answered && answers[question.id] === question.correct;
  const source = readings.find(reading => reading.id === question.source);

  return <section className="lp-practice" aria-label="简测练习">
    <header className="lp-page-head"><h1>练习</h1><span className="lp-position">{index + 1}<i> / {questions.length}</i></span></header>
    <nav className="lp-question-nav" aria-label="题目导航">
      {questions.map((item, itemIndex) => <button key={item.id} type="button" aria-label={`第 ${itemIndex + 1} 题`}
        aria-current={itemIndex === index ? 'step' : undefined}
        data-complete={Object.hasOwn(answers, item.id) || undefined}
        onClick={() => onQuestionChange(itemIndex)}><span /></button>)}
    </nav>
    <article className="lp-question-card mp-question">
      <span className="lp-topic">{question.title}</span>
      <h2>{question.prompt}</h2>
      <div className="lp-options mp-options" role="group" aria-label="选择答案">
        {question.options.map((option, optionIndex) => <button type="button" key={option}
          disabled={answered} aria-pressed={answer === optionIndex}
          data-correct={answered && optionIndex === question.correct || undefined}
          data-incorrect={answered && answer === optionIndex && optionIndex !== question.correct || undefined}
          onClick={() => onSelect(optionIndex)}>
          <span className="lp-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
          <span className="lp-option-text">{option}</span>
          {answered && optionIndex === question.correct && <Check size={18} className="lp-option-check" />}
          {answered && answer === optionIndex && optionIndex !== question.correct && <X size={17} className="lp-option-check" />}
        </button>)}
      </div>
      {answered ? <div className="lp-answer mp-answer" aria-live="polite">
        <div className="lp-answer-title">{correct ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<strong>{correct ? '回答正确' : '再想一想'}</strong></div>
        <p>{question.explanation}</p>
      </div> : null}
      <div className="lp-practice-actions">
        {answered ? <>
          <button type="button" className="lp-source-button" aria-label="查看来源资料" title={source?.title} onClick={() => onOpenSource(question.source)}><BookOpen size={20} /></button>
          <button type="button" className="mp-primary lp-next" onClick={() => onQuestionChange((index + 1) % questions.length)} aria-label={index < questions.length - 1 ? '下一题' : '回看题目'}>{index < questions.length - 1 ? '下一题' : '回看'}<ArrowRight size={18} /></button>
        </> : <button type="button" className="mp-primary lp-submit" disabled={selected === null} onClick={onSubmit}>提交作答<ArrowRight size={18} /></button>}
      </div>
    </article>
  </section>;
}

type RecordsPageProps = {
  records: Capture[];
  draftText: string;
  onCreate: () => void;
  onResume: () => void;
  onOpen: (record: Capture) => void;
};

function localDay(date: Date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
function dayLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '更早';
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (localDay(date) === localDay(today)) return '今天';
  if (localDay(date) === localDay(yesterday)) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}
function clockLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

export function RecordsPage({ records, draftText, onCreate, onResume, onOpen }: RecordsPageProps) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const filtered = records.filter(record => !deferredQuery || `${record.text} ${record.kind}`.toLocaleLowerCase().includes(deferredQuery))
    .slice().sort((a, b) => b.at.localeCompare(a.at));
  const groups = new Map<string, Capture[]>();
  for (const record of filtered) {
    const label = dayLabel(record.at);
    const rows = groups.get(label) || [];
    rows.push(record); groups.set(label, rows);
  }

  return <section className="lp-records" aria-label="个人记录">
    <header className="lp-page-head"><h1>记录</h1><button type="button" className="lp-add" aria-label="写一条" onClick={onCreate}><Plus size={22} /></button></header>
    <label className="lp-record-search"><Search size={18} /><input aria-label="搜索记录" placeholder="搜索记录" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除记录搜索" onClick={() => setQuery('')}><X size={17} /></button>}</label>
    {draftText.trim() && <button type="button" className="lp-draft" onClick={onResume} aria-label="继续草稿"><NotebookPen size={18} /><span><strong>草稿</strong><small>{draftText}</small></span><ChevronRight size={17} /></button>}
    {groups.size ? [...groups].map(([label, rows]) => <section className="lp-record-group" key={label} aria-label={label}>
      <h2>{label}</h2>
      <div className="lp-record-list">{rows.map(record => <button type="button" className="lp-record-row" data-record-id={record.id} key={record.id} onClick={() => onOpen(record)} aria-label={`查看记录：${record.text.slice(0, 36)}`}>
        <div className="lp-record-meta"><span>{record.kind}</span><time dateTime={record.at}>{clockLabel(record.at)}</time></div>
        <p>{record.text}</p>
        <ChevronRight size={16} className="lp-record-arrow" />
      </button>)}</div>
    </section>) : <div className="lp-record-empty"><NotebookPen size={29} strokeWidth={1.3} /><p>{deferredQuery ? '没有匹配的记录' : '还没有记录'}</p>{!deferredQuery && <button type="button" className="mp-primary" aria-label="创建第一条记录" onClick={onCreate}><Plus size={17} />写一条</button>}</div>}
  </section>;
}
