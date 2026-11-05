import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { generatedMathMarkdown, generatedMathSpans, recoverGeneratedMathTree } from '../src/services/textbook/generatedMath';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { prepareFormula } from '../src/services/textbook/formulaRenderer';
import { assessProgressiveAnswers } from '../src/services/progressiveLearning/assessment';
import type { ProgressiveAttempt, ProgressiveLessonPage } from '../src/services/progressiveLearning/types';

const samples=["f(x)=x^3-3x", "f'(0)=0", "[f(x0+Δx)-f(x0)]/Δx", "lim(Δx→0)[f(x0+Δx)-f(x0)]/Δx", "(x^n)'=nx^{n-1}",
  "(sin x)'=cos x", "(cos x)'=-sin x", "(ln x)'=1/x", "(u±v)'=u'±v'", "(uv)'=u'v+uv'", "(u/v)'=(u'v-uv')/v^2", "f(x)=|x|", "f(x)=x^{1/3}", "f'(x)<0", "(x0,f(x0))", "∫_a^b f(x)dx", "Σf(x_i)Δx", "2x cos x - x^2 sin x"];
for(const input of samples){const spans=generatedMathSpans(input);assert.equal(spans.length,1,input);assert.equal(spans[0].start,0,input);assert.equal(spans[0].end,input.length,input);assert.equal(prepareFormula(spans[0].tex).error,undefined,input);}
const slope=generatedMathSpans(samples[2])[0].tex;assert.ok(slope.endsWith('{\\Delta x}'),slope);
assert.equal(generatedMathMarkdown('$x^2$ 与 \\(x+1\\) 和 $$y=0$$'),'$x^2$ 与 \\(x+1\\) 和 $$y=0$$');
for(const input of ['版本1.0.10和v1.0.10','20 kg；API 文档、HTML 标签','https://example.test/?x=0','[[f(x)=x^2]]','`x=0` 与 [L1]','$未闭合 f(x)=0'])assert.equal(generatedMathMarkdown(input),input,input);
const source='人工说明 f(x)=x^2。\n\n### 本项目需要掌握的知识点\n\n[[导数]]：f\u0027(x)=3x^2-3。\n\n```js\nx=0\n```\n\n### 后记\n代码 x=0。';
const tree=fromMarkdown(source);recoverGeneratedMathTree(tree);
assert.equal(tree.children[0].type,'paragraph');assert.ok(!JSON.stringify(tree.children[0]).includes('inlineMath'));
assert.ok(JSON.stringify(tree.children[2]).includes('inlineMath'));assert.equal((tree.children[3] as any).value,'x=0');assert.ok(!JSON.stringify(tree.children.at(-1)).includes('inlineMath'));
assert.ok(JSON.stringify(toHast(tree)).includes('math-inline'),'recovered nodes retain math handlers for both foreground and worker readers');
let recovered=0;
for(const file of ['main-1','main-2','main-3','main-4']){
  const path='build/formula-fixture/'+file+'.json';if(!fs.existsSync(path))continue;
  const page=JSON.parse(fs.readFileSync(path,'utf8'));
  const fields=[...page.concepts.map((c:any)=>c.summary),...page.questions.flatMap((q:any)=>[q.prompt,q.referenceAnswer,q.explanation,...(q.options||[]).map((o:any)=>o.text)])];
  for(const value of fields)for(const span of generatedMathSpans(value)){assert.equal(prepareFormula(span.tex).error,undefined,span.tex);recovered++;}
}
// A model chooses an already validated citation ID; its own rewritten quote
// never replaces the real text or the original answer/question identity.
const page:ProgressiveLessonPage={id:'main-1',kind:'mainline',mainlineIndex:0,title:'一阶导数',body:'左正右负（先增后减）→ 极大值。',questions:[],concepts:[],createdAt:'a',updatedAt:'a',hook:null as any};
const question={id:'q3',kind:'application' as const,prompt:"设 f(x)=x^3-3x。",objective:'一阶导数判断',conceptKeys:[],focus:'calculation' as const,referenceQuote:'左正右负（先增后减）→ 极大值',referenceAnswer:'不作为标准答案直接照抄',explanation:'按符号判断'};
const attempt:ProgressiveAttempt={id:'attempt',submissionId:'submission',questionId:'q3',questionHash:'unchanged-question',pageHash:'unchanged-page',question,answer:{text:"合成作答 f'(x)=3x-3"},submittedAt:'a'};
const original=JSON.stringify(attempt);
const judge={outcome:'incorrect',errorKind:'calculation',explanation:"应为 $f'(x)=3x^2-3$。",referenceAnswer:'候选点为 $x=-1$ 和 $x=1$。'};
const rows=await assessProgressiveAnswers(page,[attempt],new AbortController().signal,async request=>{
  const input=JSON.parse(request.userInput);assert.equal(input.evidence[0].quote,question.referenceQuote);assert.equal(input.tasks[0].evidenceId,'E1');
  return {content:JSON.stringify({results:[{attemptId:'attempt',referenceId:'E1',judgment:judge}]})} as any;
});
assert.equal(rows[0].judgment.referenceQuote,question.referenceQuote);assert.equal(JSON.stringify(attempt),original);
await assert.rejects(assessProgressiveAnswers(page,[attempt],new AbortController().signal,async()=>({content:JSON.stringify({results:[{attemptId:'attempt',referenceId:'invented',judgment:judge}]})} as any)),/引用编号无效/u);
await assert.rejects(assessProgressiveAnswers(page,[attempt],new AbortController().signal,async()=>({content:JSON.stringify({results:[{attemptId:'attempt',judgment:{...judge,referenceQuote:'不是原文的公式'}}]})} as any)),/未匹配本页依据/u);
console.log(JSON.stringify({status:'passed',formulaPatterns:samples.length,existingTeachingFormulas:recovered,citation:'validated IDs; foreign evidence rejected; original attempt unchanged'}));
