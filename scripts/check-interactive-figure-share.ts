import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { buildInteractiveFigureShare } from '../src/services/textbook/interactiveFigureShare';
import { interactiveFigureKey } from '../src/services/textbook/interactiveFigure';
import { findInteractiveFigureEntries } from '../src/services/textbook/interactiveFigureMarker';
import { renderStyledTextbookHtml } from '../src/services/textbook/styledTextbookHtml';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const first = '改变输入并观察平方函数。', second = '切换开关观察状态。';
const body = `# 教材\r\n\r\n\`\`\`md\r\n> **交互探索**\r\n> 不是真实图\r\n\`\`\`\r\n\r\n> **交互探索**\r\n>\r\n> ${first}\r\n\r\n正文 [L9]。\r\n\r\n> **交互探索**\r\n>\r\n> ${second}\r\n`;
assert.deepEqual(findInteractiveFigureEntries(body).map(item => item.brief), [first, second]);
const firstKey = await interactiveFigureKey('project', body, first), secondKey = await interactiveFigureKey('project', body, second);
let calls = 0;
const pack = await buildInteractiveFigureShare({ noteId: 'project', title: '合成:教材', body }, {
  read: async key => key === firstKey ? { status: 'ready', html: '<button>synthetic</button>' } : key === secondKey ? { status: 'failed' } : null,
  portable: async html => { calls++; assert.ok(html.includes('synthetic')); return { html: '<!doctype html><iframe sandbox="allow-scripts"></iframe>', license: 'MIT fixture' }; },
}, async (title, text) => renderStyledTextbookHtml(title, text));
assert.equal(calls, 1); assert.equal(pack.included, 1); assert.equal(pack.missing, 1); assert.equal(pack.name, '合成_教材-教材.zip');
const files = unzipSync(pack.bytes), markdown = strFromU8(files['教材.md']);
assert.ok(markdown.includes('[打开离线交互图](figures/figure-1.html)'));
assert.ok(markdown.includes('此交互图尚未生成或未能随包导出'));
assert.ok(markdown.includes('不是真实图') && !markdown.includes('[L9]'));
assert.ok(strFromU8(files['figures/figure-1.html']).includes('sandbox="allow-scripts"'));
assert.ok(strFromU8(files['教材.html']).includes('href="figures/figure-1.html"'));
assert.equal(strFromU8(files['figures/ANATOMY-LICENSE.txt']), 'MIT fixture');
assert.ok(!Object.keys(files).some(name => name.includes('profile') || name.includes('private')));
const fallback = await buildInteractiveFigureShare({ noteId: 'project', title: '合成教材', body }, {
  read: async () => null, portable: async () => { throw Error('unexpected'); },
}, async () => { throw Error('合成后台失败'); });
const fallbackFiles = unzipSync(fallback.bytes);
assert.ok(fallbackFiles['教材.md'] && !fallbackFiles['教材.html']);
assert.equal(fallback.htmlError, '合成后台失败');
assert.ok(strFromU8(fallbackFiles['说明.txt']).includes('合成后台失败'));
const selected = '选择输入并比较输出';
const manualKey = await interactiveFigureKey('project', body, selected);
const manualPack = await buildInteractiveFigureShare({ noteId: 'project', title: '教材', body, manualFigures: [{ brief: selected }] }, {
  read: async key => key === manualKey ? { status: 'ready', html: '<button>手动图</button>' } : null,
  portable: async () => ({ html: '<html>离线交互图</html>', license: '' }),
}, async (title, text) => renderStyledTextbookHtml(title, text));
const manualFiles = unzipSync(manualPack.bytes), manualMd = strFromU8(manualFiles['教材.md']);
assert.ok(manualMd.includes('补充交互探索') && manualMd.includes('选择输入并比较输出') && manualMd.includes('(figures/figure-1.html)'));
assert.ok(strFromU8(manualFiles['教材.html']).includes('href="figures/figure-1.html"'));
assert.equal(strFromU8(manualFiles['figures/figure-1.html']), '<html>离线交互图</html>');
const chemistryBrief='比较电解水产生的气体体积';
const chemistryBody=`# 合成化学\n\n> **交互探索**\n>\n> ${chemistryBrief}`;
const chemistryKey=await interactiveFigureKey('chemistry',chemistryBody,chemistryBrief);
const oldHtml='<div>旧交互图结果 2:1</div>';
let sharedHtml='',checked=0;
const chemicalShare=await buildInteractiveFigureShare({noteId:'chemistry',title:'电解水',body:chemistryBody},{
  read:async key=>key===chemistryKey?{status:'ready',html:oldHtml,design:{kind:'quantitative',renderer:'svg-2d',anchor:chemistryBrief,goal:chemistryBrief,action:'观察',observation:'比较',model:'示意',prediction:'气体比例是多少？',caveat:'同温同压',transfer:'迁移'}}:null,
  preflight:async html=>{checked++;assert.ok(html.includes('data-local-prediction-disclosure'))},
  portable:async html=>{sharedHtml=html;return {html,license:''}}
},async(title,text)=>renderStyledTextbookHtml(title,text));
assert.equal(chemicalShare.included,1);assert.equal(checked,1);assert.ok(sharedHtml.includes('气体比例是多少？'));assert.ok(sharedHtml.includes(oldHtml));
assert.ok(strFromU8(unzipSync(chemicalShare.bytes)['figures/figure-1.html']).includes('data-local-prediction-disclosure'));
const failedChemicalShare=await buildInteractiveFigureShare({noteId:'chemistry',title:'电解水',body:chemistryBody},{
  read:async()=>({status:'ready',html:oldHtml}),preflight:async()=>{throw Error('unsafe wrapper')},portable:async()=>{throw Error('must not export without gate')}
},async(title,text)=>renderStyledTextbookHtml(title,text));
assert.equal(failedChemicalShare.missing,1);assert.ok(!unzipSync(failedChemicalShare.bytes)['figures/figure-1.html']);
console.log('PASS figure share: Markdown/fences, ready and missing attachments, scoped export and relative links');
