/** Render the saved synthetic request captures. No runtime, settings or network. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'output/scene-s2-interaction-context-inspection');
const report = JSON.parse(await readFile(path.join(folder, 'comparison.json'), 'utf8'));
async function capture(directory, label, response) {
  const system = await readFile(path.join(folder, directory, 'system-prompt.txt'), 'utf8');
  const input = await readFile(path.join(folder, directory, 'input.compact.json'), 'utf8');
  JSON.parse(input);
  return { label, system, input, ...(response ? { response } : {}), systemChars: system.length, inputChars: input.length, totalChars: system.length + input.length };
}
const modes = [
  { label: '当前：解释，不补读', note: '任务：解释当前画布。一次回应只使用结构与索引。', calls: [await capture('after/normal', '首轮：结构与索引')] },
  { label: '当前：同一句话，补读正文', note: '任务仍为：解释当前画布。合成选择只读取 Prompt.content 正文，不需要参数编辑规则。', calls: [
    await capture('after/explanation-read-call-1', '首轮：结构与索引', report.explanationRead?.readRequest),
    await capture('after/explanation-read-call-2', '第二轮：补读指定正文'),
  ] },
  { label: '当前：修改内容，补读规则', note: '这是独立任务：把 Prompt 的内容改成指定文字。只读取 content 参数的完整规则，并随读提供匹配的动作格式，无需原正文或其他端口。', calls: [
    await capture('after/editing-call-1', '首轮：结构与索引', { read: { interfaces: [{ componentId: 'content', parameters: ['content'] }] } }),
    await capture('after/editing-call-2', '第二轮：补读单字段规则'),
  ] },
  { label: '当前：仅回复 scope', note: '同场景、同一句解释任务，scope仅reply；不与普通完整scope的计数混加。', calls: [await capture('after/scope-reply-only', '仅回复首轮')] },
  { label: '当前：编辑但不可执行 scope', note: '同场景，scope为reply/edit；不提供run/cancel说明。', calls: [await capture('after/scope-edit-only', '编辑范围首轮')] },
  { label: '初始版本：解释', note: '相同五块、四条连线、目标及两条历史。真实冻结请求：系统840、输入6058。', calls: [await capture('before', '初始版本首轮')] },
];
const slimBefore = JSON.parse(await readFile(path.join(root, 'scripts/fixtures/s2-interaction-system-before-slim.json'), 'utf8'));
for (const [name, label, note] of [
  ['prompt995', '精简前：公开995字符版本', '此前已向用户展示的实际请求：系统995、输入1943，未追加后续重复读取提醒。'],
  ['beforeSystemSlim', '精简前：即时1052字符源码', '压缩前的实际首轮源码捕获。此时并行工作已增加57字符提醒，不能将它与995字符版本混为同一请求。'],
]) {
  const previous = slimBefore[name], input = JSON.stringify(previous.input), system = previous.system;
  modes.push({ label, note, calls: [{ label: '历史实际首轮', system, input, systemChars: system.length, inputChars: input.length, totalChars: system.length + input.length }] });
}
const scopedBefore = JSON.parse(await readFile(path.join(root, 'scripts/fixtures/s2-interaction-context-before-scoped.json'), 'utf8'));
for (const [capture, label, note] of [
  [scopedBefore.saved634.normal, '按scope裁剪前：历史634版本', '上一轮公开的634字符系统提示原文。该历史输入没有后续加入的执行能力标志。'],
  [scopedBefore.immediateBefore.normal.requests[0], '按scope裁剪前：即时701版本', '本轮开始时捕获的实际源码，系统701、输入1967。不是把更早676或634版本重建为当前版本。'],
]) {
  const system = capture.system, input = capture.rawInput;
  modes.push({ label, note, calls: [{ label: '裁剪前实际首轮', system, input, systemChars: system.length, inputChars: input.length, totalChars: system.length + input.length }] });
}
try {
  modes.push({ label: '中间版本：解释', note: '历史中间阶段：系统572、输入1865；仍预先提供当前实例的参数正文。', calls: [await capture('progressive-v1/normal', '中间版本首轮')] });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const mode of modes) mode.cumulative = mode.calls.reduce((sum, call) => ({ systemChars: sum.systemChars + call.systemChars, inputChars: sum.inputChars + call.inputChars,
  totalChars: sum.totalChars + call.totalChars }), { systemChars: 0, inputChars: 0, totalChars: 0 });
const payload = JSON.stringify({ report, modes }).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>S2 交互 Agent：请求原文与字符数</title><style>
:root{color-scheme:light dark;--bg:#f5f6f7;--surface:#fff;--text:#20262c;--muted:#5e6872;--line:#d7dde2;--accent:#205d76}
@media(prefers-color-scheme:dark){:root{--bg:#15191d;--surface:#1d2329;--text:#e5e9ed;--muted:#a3afba;--line:#3c4650;--accent:#95cddd}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:23px;margin:0 0 8px}h2{font-size:17px;margin:0}p{margin:8px 0}.muted{color:var(--muted)}.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:18px 0 10px}select,button{font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:7px 12px}button{cursor:pointer}button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);font-weight:600}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;border-block:1px solid var(--line);padding:14px 0;margin:16px 0}.metric strong{display:block;font-size:23px}.panes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:16px}.pane{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:16px}.pane header{display:flex;align-items:center;justify-content:space-between;gap:10px}.pane pre{font:13px/1.75 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto;margin:12px 0 0}.hint{font-size:13px;color:var(--muted)}#rounds{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}#responseBox{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}#response{white-space:pre-wrap}.download{color:var(--accent);font-size:13px}footer{margin-top:18px;color:var(--muted);font-size:12px}@media(max-width:850px){.panes{grid-template-columns:1fr}.stats{gap:10px}main{padding:16px}.metric strong{font-size:20px}}
</style><main><h1>S2 交互 Agent：实际请求原文与字符数</h1>
<p class="muted">固定五个块、四条连线及两条短历史。来自当前源码的真实请求组装过程，模型返回由合成数据控制；未调用真实模型。</p>
<div class="controls"><label>场景任务 <select id="mode"></select></label><label><input id="pretty" type="checkbox" checked> 格式化展示 JSON</label></div><p id="note"></p>
<div id="rounds"></div><div class="stats"><div class="metric">本轮系统提示词<strong id="systemCount"></strong></div><div class="metric">本轮输入上下文<strong id="inputCount"></strong></div><div class="metric">本轮合计<strong id="totalCount"></strong></div></div>
<p id="cumulative"></p><p class="hint">字符口径：UTF-16 string.length。输入按实际紧凑 JSON 计数，展示缩进不计入。累计包含每轮重复发送的系统、任务、索引及历史；不含模型输出、HTTP 封装，也不是 token 数。</p>
<div class="panes"><section class="pane"><header><h2>系统提示词：完整原文</h2><a id="systemDownload" class="download" download="system-prompt.txt">下载</a></header><pre id="system"></pre></section>
<section class="pane"><header><h2>输入上下文：完整原文</h2><a id="inputDownload" class="download" download="input.compact.json">下载紧凑 JSON</a></header><pre id="input"></pre></section></div>
<section id="responseBox" hidden><h2>该轮之后的合成模型返回</h2><p class="hint">这是模型返回的补读选择，交给本地程序执行，不属于上方输入上下文。</p><pre id="response"></pre></section>
<footer>当前首轮系统 <span id="systemTotal"></span> 字符；实际段落计数：<span id="paragraphCounts"></span>，段间换行已计入总数。保存时间：<span id="time"></span>。修改任务的旧版本6927字符由冻结输入仅替换 task 重建，未运行旧引擎。</footer></main>
<script type="application/json" id="data">${payload}</script><script>
const data=JSON.parse(document.getElementById('data').textContent);let selected=0,round=0;const el=id=>document.getElementById(id);const fmt=n=>n.toLocaleString('zh-CN')+' 字符';
data.modes.forEach((mode,index)=>{const option=document.createElement('option');option.value=index;option.textContent=mode.label;el('mode').append(option)});
function render(){const mode=data.modes[selected],call=mode.calls[round];el('note').textContent=mode.note;el('rounds').replaceChildren();mode.calls.forEach((value,index)=>{const button=document.createElement('button');button.textContent=value.label;button.setAttribute('aria-pressed',String(index===round));button.onclick=()=>{round=index;render()};el('rounds').append(button)});el('systemCount').textContent=fmt(call.systemChars);el('inputCount').textContent=fmt(call.inputChars);el('totalCount').textContent=fmt(call.totalChars);const sum=mode.cumulative;el('cumulative').textContent='全部 '+mode.calls.length+' 轮累计：系统 '+fmt(sum.systemChars)+' + 输入 '+fmt(sum.inputChars)+' = '+fmt(sum.totalChars);el('system').textContent=call.system;el('input').textContent=el('pretty').checked?JSON.stringify(JSON.parse(call.input),null,2):call.input;el('systemDownload').href='data:text/plain;charset=utf-8,'+encodeURIComponent(call.system);el('inputDownload').href='data:application/json;charset=utf-8,'+encodeURIComponent(call.input);el('responseBox').hidden=!call.response;el('response').textContent=call.response?JSON.stringify(call.response,null,2):'';}
el('mode').onchange=()=>{selected=Number(el('mode').value);round=0;render()};el('pretty').onchange=render;const parts=data.report.systemComposition;el('systemTotal').textContent=parts.totalChars??data.report.normal.after.systemChars;el('paragraphCounts').textContent=Array.isArray(parts.paragraphs)?parts.paragraphs.map(part=>part.chars).join(' + '):'历史报告：以完整原文为准';el('time').textContent=data.report.measuredAt;render();
</script></html>`;
const destination = path.join(folder, 'inspect.html');
await writeFile(destination, html, 'utf8');
console.log(JSON.stringify({ destination, scenarios: modes.map(mode => ({ label: mode.label, calls: mode.calls.length, cumulative: mode.cumulative })) }, null, 2));
