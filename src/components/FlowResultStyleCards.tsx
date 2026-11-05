import { Brain, MessageCircle } from 'lucide-react';
import type { FlowStylePresentation, FlowStyleObservation } from '../services/flowAnalysis/types';
import './FlowResultDetails.css';

function Evidence({ items }: { items: FlowStyleObservation[] }) {
  if (!items.length) return null;
  const unique = items.filter((item, index, all) => all.findIndex(other => other.reason === item.reason) === index);
  return <details className="flow-result-observation-evidence"><summary>查看原话依据</summary>
    {unique.map((item, index) => <div key={index}><p>{item.reason}</p>
      {item.quotes.map((quote, quoteIndex) => <blockquote key={quoteIndex}>{quote}</blockquote>)}</div>)}
  </details>;
}

export function FlowResultStyleCards({ presentation, cognitive, expression }: {
  presentation?: FlowStylePresentation; cognitive: string[]; expression: string[];
}) {
  return <>
    <section className="flow-result-report-card" aria-label="本次表达风格">
      <div className="flow-result-card-heading"><div><MessageCircle aria-hidden="true" /><strong>本次表达风格</strong></div><span>五维构成</span></div>
      <p>表达方式的相对构成，不是能力得分。</p>
      {presentation ? <div className="flow-result-style-list">
        {presentation.expression.map(item => <div key={item.key} className="flow-result-style-row">
          <div><span>{item.label}</span><strong>{item.share == null ? '暂无观察' : `${item.share}%`}</strong></div>
          <div className="flow-result-style-track" aria-hidden="true"><i style={{ width: `${item.share ?? 0}%` }} /></div>
        </div>)}
        <Evidence items={presentation.expression.flatMap(item => item.observations)} />
      </div> : expression.length ? expression.map((item, index) => <p key={index}>{item}</p>) : <p>本次暂无可展示的表达观察。</p>}
    </section>
    <section className="flow-result-report-card" aria-label="本次认知偏好">
      <div className="flow-result-card-heading"><div><Brain aria-hidden="true" /><strong>本次认知偏好</strong></div><span>本次表现</span></div>
      <p>呈现这次复盘的思考倾向，长期画像按历史证据平滑更新。</p>
      {presentation ? <div className="flow-result-style-list">
        {presentation.cognitive.map(item => <div className="flow-result-cognitive-row" key={item.key}>
          <div><span>{item.label}</span><strong>{item.directionLabel}</strong></div>
          <div className={`flow-result-bipolar-track${item.value == null ? ' is-unknown' : ''}`} aria-hidden="true">
            <i />{item.value != null && <b style={{ left: `${(item.value + 100) / 2}%` }} />}
          </div><div className="flow-result-poles"><span>{item.negative}</span><span>{item.positive}</span></div>
        </div>)}
        <Evidence items={presentation.cognitive.flatMap(item => item.observations)} />
      </div> : cognitive.length ? cognitive.map((item, index) => <p key={index}>{item}</p>) : <p>本次证据不足，暂不判断偏好方向。</p>}
    </section>
  </>;
}
