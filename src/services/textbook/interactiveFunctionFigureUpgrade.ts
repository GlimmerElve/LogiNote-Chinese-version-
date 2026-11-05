/** Display-only migration for the exact first local-function template.
 * Unknown or changed documents are left untouched; saved attachments are never rewritten. */
import { fitStoredLocalFunctionViewport } from './localFunctionViewport';

export function upgradeLegacyFunctionReadout(html: string): string {
  let updated=upgradeReadout(html);
  if(updated.includes('data-local-function="true"')) updated=updated.replaceAll('fmtX=n=>Number(n.toPrecision(15)).toString()',"fmtX=n=>{const rounded=Number(n.toPrecision(7));return (Math.abs(n-rounded)>Math.max(1e-12,Math.abs(n)*1e-12)?'≈ ':'')+rounded}");
  if(updated.includes('data-local-function="true"')) updated=updated
    .replaceAll(' = <strong data-prediction-x>',' <span data-prediction-relation>=</span> <strong data-prediction-x>')
    .replaceAll('if(predictionXNode)predictionXNode.textContent=fmtX(d.predictionX);',"if(predictionXNode){const text=fmtX(d.predictionX);predictionXNode.textContent=text.replace(/^≈ /,'');const relation=root.querySelector('[data-prediction-relation]');if(relation)relation.textContent=text.startsWith('≈ ')?'≈':'=';}");
  return fitStoredLocalFunctionViewport(updated);
}
function upgradeReadout(html: string): string {
  const marker = 'data-local-function="true"';
  const oldReadout = '<p data-readout aria-live="polite"></p>';
  const oldBinding = ",out=root.querySelector('[data-readout]');const labels=";
  const oldUpdate = "out.textContent=labels.map((label,i)=>label+' = '+(row[i+1]===null?'未定义':fmt(row[i+1]))).join('；');";
  if (!html.includes(marker) || !html.includes(oldReadout) || !html.includes(oldBinding) || !html.includes(oldUpdate)) return html;
  const legend = /<div class="legend">([\s\S]*?)<\/div><svg\b/u.exec(html)?.[1];
  if (!legend) return html;
  const parts = [...legend.matchAll(/<span><i style="background:#[a-f0-9]{6}"><\/i>([\s\S]*?)<\/span>/giu)];
  if (!parts.length || parts.length > 4 || parts.map(part => part[0]).join('') !== legend) return html;
  const readouts = parts.map((part, i) => `${i ? '；' : ''}<span data-readout-entry>${part[1]} = <output data-readout-value></output></span>`).join('');
  return html.replace(oldReadout, `<p data-readout aria-live="polite">${readouts}</p>`)
    .replace(oldBinding, ",values=[...root.querySelectorAll('[data-readout-value]')];const labels=")
    .replace(oldUpdate, "values.forEach((value,i)=>{value.textContent=row[i+1]===null?'未定义':fmt(row[i+1])});");
}
