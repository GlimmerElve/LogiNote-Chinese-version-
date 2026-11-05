/** Put all generated results behind an optional first-thought step. */
export function gateChemistryPrediction(html: string, prediction: string): string {
  const escaped = prediction.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
  return `<section data-local-prediction-gate="true"><style>[data-local-prediction-disclosure]:not([open])>*:not(summary){display:none!important}</style><p><strong>先思考：</strong>${escaped}</p><details data-local-prediction-disclosure><summary>查看交互图（可跳过预测）</summary>${html}</details><script>(function(){var d=document.querySelector('[data-local-prediction-disclosure]');d.addEventListener('toggle',function(){if(d.open)window.dispatchEvent(new Event('resize'))})})();</script></section>`;
}

/** Apply the same display policy to saved and exported figures without rewriting them. */
export function chemistryPredictionForDisplay(html: string, lesson: string, brief: string, prediction?: string): string {
  if (!/(?:化学|电解|化学反应|反应物|生成物|氧化还原)/u.test(`${brief}\n${lesson}`)
    || /data-local-(?:function|gear|lru|threshold|probability)=["']true["']/u.test(html)
    || /data-local-prediction-gate=["']true["']/u.test(html)) return html;
  const wrapped = gateChemistryPrediction(html, prediction || brief);
  if (wrapped.length > 100_000) throw Error('交互图预测遮挡未能应用，请单独重试；教材正文不受影响。');
  return wrapped;
}
