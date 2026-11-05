/** Shared, escaped UI fragments for locally generated teaching figures. */
import { generatedMathMarkdown } from './generatedMath';
export const escapeTeachingText = (s: string): string => s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const teachingContent = (text:string, math:boolean) => escapeTeachingText(math ? generatedMathMarkdown(text) : text);
export function renderTeachingGoal(text:string, math=false):string { return `<p><strong>观察目标：</strong>${teachingContent(text,math)}</p>`; }
export function renderTeachingCaveat(text:string, options?:{prefix?:string; suffix?:string; math?:boolean}):string {
  return `<p class="note">${escapeTeachingText(options?.prefix || '')}${teachingContent(text,!!options?.math)}${escapeTeachingText(options?.suffix || '')}</p>`;
}
export function renderTeachingExplanation(model:string, observation:string, math=false):string {
  return `<details class="panel"><summary>查看解释</summary><p>${teachingContent(model,math)}</p><p>${teachingContent(observation,math)}</p></details>`;
}
export function renderTeachingBaseStyle(root:'local-threshold'|'local-probability'|'local-gear'|'local-lru'|'local-function-figure'):string {
  return `<style>.${root}{max-width:850px;margin:auto;color:#243d32;line-height:1.65}.${root} h2{color:#244a38}.${root} .panel{padding:14px;margin:12px 0;background:#fff;border:1px solid #cbded1;border-radius:10px}.${root} .prompt{background:#eaf5ee}.${root} .note{font-size:.9em;color:#526d5c}</style>`;
}
export function renderTeachingPrediction(question: string, options: ReadonlyArray<{value:string; label:string}>, ariaLabel?:string): string {
  const choices=options.map(option=>`<option value="${escapeTeachingText(option.value)}">${escapeTeachingText(option.label)}</option>`).join('');
  return `<div class="panel prompt"><label>${escapeTeachingText(question)}<br><select data-figure="prediction"${ariaLabel ? ` aria-label="${escapeTeachingText(ariaLabel)}"` : ''}><option value="">请选择</option>${choices}</select></label><button type="button" data-figure="check">检查预测</button><p data-feedback aria-live="polite"></p></div>`;
}
export function renderTeachingNumericPrediction(question:string, ariaLabel:string):string {
  return `<div class="panel prompt"><label>${escapeTeachingText(question)}<br><input type="number" step="any" data-figure="prediction" aria-label="${escapeTeachingText(ariaLabel)}"></label><button type="button" data-figure="check">检查预测</button><p data-feedback aria-live="polite"></p></div>`;
}
export function renderTeachingSelect(input:{label:string; marker:'data-sample-size'|'data-parameter-choice'; options:ReadonlyArray<{value:string; label:string}>}):string {
  if (!['data-sample-size','data-parameter-choice'].includes(input.marker) || !input.options.length || input.options.length>100
    || input.options.some(option=>!option.value || !option.label) || new Set(input.options.map(option=>option.value)).size!==input.options.length) throw Error('交互选项无效');
  const options=input.options.map(option=>`<option value="${escapeTeachingText(option.value)}">${escapeTeachingText(option.label)}</option>`).join('');
  return `<label>${escapeTeachingText(input.label)}<select ${input.marker}>${options}</select></label>`;
}
/** The public marker is restricted to trusted, existing local figure contracts. */
export function renderTeachingRange(input:{label:string; ariaLabel:string; marker:'data-driver'|'data-threshold'|'data-x'; min:number; max:number; step:number; value:number; initialText?:string; suffix?:string}):string {
  if (!['data-driver','data-threshold','data-x'].includes(input.marker) || ![input.min,input.max,input.step,input.value].every(Number.isFinite)
    || input.min >= input.max || input.step <= 0 || input.value < input.min || input.value > input.max) throw Error('交互滑块范围无效');
  return `<label>${escapeTeachingText(input.label)}<output ${input.marker}>${escapeTeachingText(input.initialText ?? '')}</output>${escapeTeachingText(input.suffix ?? '')}<input type="range" min="${input.min}" max="${input.max}" step="${input.step}" value="${input.value}" aria-label="${escapeTeachingText(input.ariaLabel)}"></label>`;
}
/** Render generated notation while escaping every model-provided text fragment. */
export function renderTeachingFormulaText(value:string, expression:string):string {
  if (value.includes('$') || value.includes('\\(')) return escapeTeachingText(value);
  if (expression.length < 2) return escapeTeachingText(generatedMathMarkdown(value));
  const index=value.indexOf(expression);
  return index<0 ? escapeTeachingText(generatedMathMarkdown(value)) : `${escapeTeachingText(generatedMathMarkdown(value.slice(0,index)))}\\(${escapeTeachingText(expression)}\\)${escapeTeachingText(generatedMathMarkdown(value.slice(index+expression.length)))}`;
}
export function renderTeachingFunctionPrediction(variable:string, label:string, expression:string, notice?:string):string {
  return `<div class="panel prompt">${notice ? `<p class="note">${escapeTeachingText(notice)}</p>` : ''}<label>先预测：当 ${escapeTeachingText(variable)} <span data-prediction-relation>=</span> <strong data-prediction-x></strong> 时，${renderTeachingFormulaText(label,expression)} 的值是多少？<br><input type="number" step="any" data-figure="prediction" aria-label="输入预测值"></label><button type="button" data-figure="check">检查预测</button><p data-feedback aria-live="polite"></p></div>`;
}
export function renderTeachingReset(): string { return '<button type="button" data-figure="reset">重置</button>'; }
export function renderTeachingTransfer(text:string, note?:string, math=false):string { return `<div class="panel"><strong>迁移思考：</strong><span data-figure="transfer">${teachingContent(text,math)}</span>${note ? `<p class="note">${escapeTeachingText(note)}</p>` : ''}</div>`; }
