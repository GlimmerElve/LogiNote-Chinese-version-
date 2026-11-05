import { useState } from 'react';
import { MASTERY_SHADOW_LAYERS, MASTERY_SHADOW_STATE_LABELS, MASTERY_SHADOW_STATE_MARKERS, MASTERY_SHADOW_VERDICT_LABELS,
  type MasteryShadowLayer, type MasteryShadowPresentation } from '../services/masteryShadow/types';
import './KnowledgeMasteryDetails.css';
import { MasteryReferenceContext } from './MasteryReferenceContext';

const LAYER_LABELS = { concept: '概念', judgment: '判断', reasoning: '推理' };

export function KnowledgeMasteryStateGuide() {
  return <details className="mastery-state-guide">
    <summary>累计状态分为 4 种 · 查看说明</summary>
    <dl>
      <dt>未评估</dt><dd>还没有足够证据确定这一层的掌握状态，不代表不掌握。</dd>
      <dt>待确认</dt><dd>已有通过证据，尚需进一步确认。</dd>
      <dt>已确认</dt><dd>累计证据已满足当前确认条件，不代表以后不会出错。</dd>
      <dt>待复核</dt><dd>有据的问题已触发复核，需要重新检验这一层。</dd>
    </dl>
    <p>本次表现单独显示：通过、部分满足、发现问题、未展示或依据不足。未展开、只带过或资料不足，不降低原有状态。</p>
  </details>;
}

export function KnowledgeMasteryDetails({ result, showOverview = true }: { result: MasteryShadowPresentation; showOverview?: boolean }) {
  const [selected, setSelected] = useState<MasteryShadowLayer>('concept');
  const layer = result.layers[selected];
  const details = layer.assessment;
  const reasons = layer.reason.split(/[；;]/u).map(reason => reason.trim()).filter(Boolean);

  return <>
    {showOverview && result.overview && <div className="knowledge-mastery-status" aria-label={result.status === 'failed' ? '已有累计掌握情况' : '本次更新后的整体掌握情况'}>
      <strong>{result.overview.label}</strong><p>{result.overview.summary}</p><small>下一步：{result.overview.nextAction}</small>
    </div>}
    <div className="mastery-layer-table" role="table" aria-label="累计掌握状态与本次表现">
      <div role="row" className="mastery-layer-table-heading">
        <span role="columnheader">层次</span><span role="columnheader">累计状态</span><span role="columnheader">本次表现</span>
      </div>
      {MASTERY_SHADOW_LAYERS.map(key => <div role="row" key={key}>
        <span role="rowheader">{LAYER_LABELS[key]}</span>
        <strong role="cell" className={`mastery-state is-${result.layers[key].state}`}><span aria-hidden="true">{MASTERY_SHADOW_STATE_MARKERS[result.layers[key].state]} </span>{MASTERY_SHADOW_STATE_LABELS[result.layers[key].state]}</strong>
        <span role="cell">{result.status === 'failed' ? '本次未形成结论'
          : result.layers[key].coverage === 'incidental' ? '本次仅附带提及' : MASTERY_SHADOW_VERDICT_LABELS[result.layers[key].verdict]}</span>
      </div>)}
    </div>
    <details className="mastery-evaluation-details">
      <summary>查看评价依据</summary>
      <div className="mastery-layer-selector" role="group" aria-label="选择评价层次">
        {MASTERY_SHADOW_LAYERS.map(key => <button type="button" key={key} aria-pressed={selected === key}
          onClick={() => setSelected(key)}>{LAYER_LABELS[key]}</button>)}
      </div>
      <div className="mastery-layer-explanation" role="region" aria-label={`${LAYER_LABELS[selected]}层评价依据`}>
        <p className="mastery-layer-verdict">本次结论：{MASTERY_SHADOW_VERDICT_LABELS[layer.verdict].replace(/^本次/u, '')}</p>
        {details?.criteria.length ? <ul className="mastery-criterion-list">
          {details.criteria.map(criterion => <li key={criterion.id}>
            <div><strong>{criterion.label}</strong><span>{criterion.state === 'not_applicable' ? '本次不适用'
              : MASTERY_SHADOW_VERDICT_LABELS[criterion.state].replace(/^本次/u, '')}</span></div>
            <p>{criterion.reason}</p>
            {criterion.referenceQuotes?.map((excerpt, index) => <blockquote className="mastery-criterion-reference"
              aria-label={`${criterion.label}的参考依据`} key={`${excerpt.referenceId}-${index}`}>
              <p>{excerpt.quote}</p>
              <cite>{details.references.find(reference => reference.id === excerpt.referenceId)?.label || excerpt.referenceId}</cite>
            </blockquote>)}
          </li>)}
        </ul> : <ul className="mastery-legacy-reasons">{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        {details && <details className="mastery-source-details">
          <summary>核对原话与参考资料</summary>
          <h4>本次引用的原话</h4>
          {details.evidence.length ? details.evidence.map(evidence => <blockquote key={evidence.id}>{evidence.quote}</blockquote>)
            : <p>该层没有可引用的作答片段，不据此判定不掌握。</p>}
          <h4>本次使用的参考片段</h4>
          {!!details.references.length && <p className="mastery-reference-hint">以下为上下文阅读预览，不代表模型逐句标注；具体判断见上方评价理由。</p>}
          {details.references.length ? details.references.map(reference => <MasteryReferenceContext reference={reference} key={reference.id} />)
            : <p>未使用可核对的参考片段；不据此确认事实正确。</p>}
        </details>}
      </div>
    </details>
  </>;
}
