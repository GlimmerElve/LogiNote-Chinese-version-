// Keep these exact boundaries stable: only this module's own wrapper can be
// removed from an old figure. Never parse or rewrite model-authored HTML here.
const GATE_PREFIX = '<section data-local-prediction-gate="true"><style>[data-local-prediction-disclosure]:not([open])>*:not(summary){display:none!important}</style><p><strong>先思考：</strong>';
const GATE_BODY = '</p><details data-local-prediction-disclosure><summary>查看交互图（可跳过预测）</summary>';
const GATE_SUFFIX = '</details><script>(function(){var d=document.querySelector(\'[data-local-prediction-disclosure]\');d.addEventListener(\'toggle\',function(){if(d.open)window.dispatchEvent(new Event(\'resize\'))})})();</script></section>';
const CHEMISTRY_GOAL = /电解|电极|阳极|阴极|氧化还原|化学反应|反应物|生成物|化学平衡|反应速率|反应热|化学键|化学计量|物质的量|摩尔|配平|滴定|酸碱|酸与碱|溶解度|催化剂|离子反应|原电池|电化学|有机化学|无机化学|(?:氢气|氧气|二氧化碳).{0,12}(?:产生|生成|体积|比例)|(?:electrolysis|electrode|redox|chemical\s+(?:reaction|equilibrium|bond)|stoichiometry|titration|acid.base)/iu;
const NON_CHEMISTRY_GOAL = /心理|精神|思想|意识|心灵|观念|联想|认知|情感|人际|爱情|社会|团队|文学|修辞|哲学/u;
const FIGURATIVE = /类比|比喻|隐喻|好比|仿佛|如同|像.{0,24}一样/u;

function chemistryGoal(text: string): boolean {
  // “心理化学 / 精神化学” names historical theories, not chemical models.
  const literal = text.replace(/(?:心理|精神|思想|意识|心灵|观念|情感|人际|爱情|社会)(?:的)?化学(?:反应)?/gu, '')
    .replace(/(?:化学反应|氧化还原|化学)(?:式|般|的)?(?:比喻|类比|隐喻|修辞|意象)/gu, '');
  if (NON_CHEMISTRY_GOAL.test(literal) && FIGURATIVE.test(text)) return false;
  return CHEMISTRY_GOAL.test(literal) || /(?:^|[\s#：:])化学(?:课|实验|教材|教学|原理|基础|$)|\bchemistry\b/iu.test(literal);
}

/** Gate a chemical teaching goal, never a passing chemistry mention in a book. */
export function isChemistryFigureContext(brief: string, lesson: string): boolean {
  const goal = brief.trim().slice(0, 1200);
  if (chemistryGoal(goal)) return true;
  // A concrete selected goal owns its subject. Only a whole-page/default request
  // may inherit the page subject, and then only from the first heading/opening.
  if (goal && !/^(?:根据本页教材的核心内容生成交互图[。.!！]?|(?:本页[：:]?\s*)?(?:交互探索|交互图)|教材自动安排)$/u.test(goal)) return false;
  const opening = lesson.slice(0, 2000).replace(/^\uFEFF/u, '').trim();
  const heading = opening.match(/^#{1,3}\s+([^\n]{1,200})(?:\n|$)/u);
  if (heading) return chemistryGoal(heading[1]);
  return chemistryGoal(opening.split(/\n\s*\n/u, 1)[0].slice(0, 400));
}

function withoutOwnPredictionGate(html: string): string {
  if (html.length > 100_000 || !html.startsWith(GATE_PREFIX) || !html.endsWith(GATE_SUFFIX)) return html;
  const bodyAt = html.indexOf(GATE_BODY, GATE_PREFIX.length);
  // The wrapper escapes the prediction. Raw markup means this is not ours.
  if (bodyAt < 0 || html.slice(GATE_PREFIX.length, bodyAt).includes('<')) return html;
  return html.slice(bodyAt + GATE_BODY.length, -GATE_SUFFIX.length);
}

/** Put chemical results behind an optional first-thought step. */
export function gateChemistryPrediction(html: string, prediction: string): string {
  const escaped = prediction.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
  return `${GATE_PREFIX}${escaped}${GATE_BODY}${html}${GATE_SUFFIX}`;
}

/** Apply the same display policy to saved and exported figures without rewriting them. */
export function chemistryPredictionForDisplay(html: string, lesson: string, brief: string, prediction?: string): string {
  if (/\bdata-figure-mode\s*=\s*["'](?:dynamic|step|contrast)["']/iu.test(html)) return withoutOwnPredictionGate(html);
  if (!isChemistryFigureContext(brief, lesson)) return withoutOwnPredictionGate(html);
  if (/data-local-(?:function|gear|lru|threshold|probability)=["']true["']/u.test(html)
    || /data-local-prediction-gate=["']true["']/u.test(html)) return html;
  const wrapped = gateChemistryPrediction(html, prediction || brief);
  if (wrapped.length > 100_000) throw Error('交互图预测遮挡未能应用，请单独重试；教材正文不受影响。');
  return wrapped;
}
