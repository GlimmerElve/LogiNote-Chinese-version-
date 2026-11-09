import { useMemo } from 'react';
import { MASTERY_SHADOW_VERDICT_LABELS } from '../../services/masteryShadow/types';
import { projectProgressiveReviewFeedback, type ProgressiveFeedbackEntry } from '../../services/progressiveLearning/reviewFeedback';
import type { ProgressiveAuxiliaryResult, ProgressiveReviewRecord } from '../../services/progressiveLearning/reviewTypes';
import './progressiveMasteryFeedback.css';

const LAYERS = { concept: '概念', judgment: '判断', reasoning: '推理' };
function Entry({ entry }: { entry: ProgressiveFeedbackEntry }) {
  return <details className="progressive-mastery-entry" open>
    <summary>{entry.label}{entry.status === 'failed' ? ' · 评价未完成' : entry.status === 'pending' ? ' · 待处理' : ''}</summary>
    {entry.status !== 'evaluated' ? <p role="status">{entry.error || '本项反馈尚未完成，不据此判定不掌握。'}</p> : <>
      {entry.summary && <p>{entry.summary}</p>}
      <dl className="progressive-mastery-layers">{entry.layers.map(layer => <div key={layer.layer}>
        <dt>{LAYERS[layer.layer]}</dt><dd>{layer.coverage === 'incidental' ? '本次仅附带提及' : MASTERY_SHADOW_VERDICT_LABELS[layer.verdict]}</dd>
      </div>)}</dl>
      <details className="progressive-mastery-evidence"><summary>查看评价依据与原话</summary>
        {entry.layers.map(layer => <section key={layer.layer} aria-label={`${LAYERS[layer.layer]}层评价依据`}>
          <h5>{LAYERS[layer.layer]}</h5>
          {layer.assessment?.criteria.length ? layer.assessment.criteria.map(criterion => <div className="progressive-mastery-criterion" key={criterion.id}>
            <strong>{criterion.label} · {criterion.state === 'not_applicable' ? '本次不适用' : MASTERY_SHADOW_VERDICT_LABELS[criterion.state]}</strong>
            <p>{criterion.reason}</p>
            {criterion.referenceQuotes?.map((reference, index) => <blockquote key={`${reference.referenceId}-${index}`}>
              <p>{reference.quote}</p><cite>{layer.assessment?.references.find(row => row.id === reference.referenceId)?.label || reference.referenceId}</cite>
            </blockquote>)}
          </div>) : <p>本层没有形成可核验的判据反馈。</p>}
          {!!layer.assessment?.evidence.length && <details><summary>本层引用的原话</summary>{layer.assessment.evidence.map(evidence => <blockquote key={evidence.id}>{evidence.quote}</blockquote>)}</details>}
        </section>)}
      </details>
    </>}
  </details>;
}

/** Receives the current hash-verified native auxiliary blob; never initiates analysis or writes. */
export function ProgressiveMasteryFeedback({ record, auxiliary }: { record: ProgressiveReviewRecord; auxiliary: ProgressiveAuxiliaryResult | null }) {
  const feedback = useMemo(() => projectProgressiveReviewFeedback(record, auxiliary), [record, auxiliary]);
  return <section className="progressive-mastery-feedback" aria-label="本次知识点掌握反馈">
    <h3>知识点掌握反馈</h3>
    <p className="progressive-mastery-note">以下是本次表现，不是累计掌握状态；未展示或依据不足不等于不会。</p>
    {(['flow_review', 'quick_check'] as const).map(source => {
      const groups = feedback.groups.filter(group => group.source === source);
      return groups.length ? <section className="progressive-mastery-source" aria-label={source === 'flow_review' ? '本次复述知识点反馈' : '页内答题知识点反馈'} key={source}>
        <h4>{source === 'flow_review' ? '本次复述' : '页内已保存答题'}</h4>
        {groups.map(group => <article className="progressive-mastery-card" key={group.key}>
          <h4>{group.title}</h4>{group.entries.map(entry => <Entry key={entry.id} entry={entry} />)}
        </article>)}
      </section> : null;
    })}
    {!feedback.groups.length && <p role="status">{!auxiliary ? '知识点反馈尚在准备，已保存的复盘报告可先查看。'
      : record.analysisSelection?.status === 'confirmed' && !record.analysisSelection.conceptKeys.length
        ? '本次未选择复述知识点，没有新增复述掌握评价。' : '本次没有形成可核验的知识点反馈，未补造掌握记录。'}</p>}
    {feedback.pendingKnowledge && <p className="progressive-mastery-note" role="status">部分知识点对象尚未就绪，对应评价待补充；已完成反馈仍保留。</p>}
    {!!feedback.warnings.length && <details className="progressive-mastery-evidence"><summary>部分反馈为何待核验</summary>{feedback.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
  </section>;
}
