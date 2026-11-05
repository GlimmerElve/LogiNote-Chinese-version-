import assert from 'node:assert/strict';
import { toHast } from 'mdast-util-to-hast';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { recoverGeneratedFormattingTree } from '../src/services/textbook/generatedFormatting';
import { prepareReadingDocument } from '../src/services/textbook/readingDocument';
import { writeTextbookRegion } from '../src/services/textbook/noteContent';
import { assessProgressiveAnswers, localProgressiveJudgment } from '../src/services/progressiveLearning/assessment';
import { validateProgressiveQuestions, projectProgressiveQuestion } from '../src/services/progressiveLearning/validation';
import { progressiveQuestionHash } from '../src/electron/progressiveStudy';
import type { NoteItem } from '../src/types';
import type { ProgressiveAttempt, ProgressiveLessonPage } from '../src/services/progressiveLearning/types';

const labels=['指令（instruction）','上下文（context）','约束（constraint）','输出格式（output format）'];
const source=labels.map(label=>`**${label} **回答一个不同的问题。`).join('\n\n');
const tree=parseTextbookMarkdown(source);recoverGeneratedFormattingTree(tree,source);
assert.deepEqual(tree.children.map((n:any)=>n.children[0].children[0].value),labels);
assert.ok(tree.children.every((n:any)=>n.children[0].type==='strong'));
for(const literal of ['`**示例 **`','```md\n**示例 **\n```',String.raw`\*\*示例 \*\*`,'$x ** y **$','**正确加粗**','**未闭合','***组合强调 ***']) {
  const ast=parseTextbookMarkdown(literal),before=JSON.stringify(ast);recoverGeneratedFormattingTree(ast,literal);assert.equal(JSON.stringify(ast),before,literal);
}
const scoped='人工说明 **保留 **。\n\n### 本项目需要掌握的知识点\n\n**指令 **：做什么。\n\n### 后记\n**保留 **';
const ast=parseTextbookMarkdown(scoped);recoverGeneratedFormattingTree(ast,scoped,'knowledge-section');
assert.equal((ast.children[0] as any).children[0].type,'text');assert.equal((ast.children[2] as any).children[0].type,'strong');assert.equal((ast.children.at(-1) as any).children[0].type,'text');
assert.ok(JSON.stringify(toHast(tree)).includes('strong'));
const manifest:any={schemaVersion:1,textbookId:'format',projectNoteId:'format',rootProjectId:'root',revisionId:'r1',regionId:'region',createdAt:'a',updatedAt:'a'};
const note=writeTextbookRegion({id:'format',noteType:'project',content:'',tags:[],links:[],backlinks:[],dueDates:[]} as unknown as NoteItem,source,manifest);
const storedSource=note.content;
const reading=prepareReadingDocument({content:note.content,manifest});
assert.equal(JSON.stringify(reading.pages).match(/"tagName":"strong"/gu)?.length,4);
assert.equal(note.content,storedSource,'display recovery never rewrites the published Markdown');

const page:ProgressiveLessonPage={id:'main-1',kind:'mainline',mainlineIndex:0,title:'四种成分',body:source,questions:[],concepts:[],createdAt:'a',updatedAt:'a',hook:{id:'h',kind:'reflection',prompt:'分别解决什么问题？'}};
const question:any={id:'q1',kind:'application',prompt:'指令与约束有何差别？',objective:'区分四类问题',conceptKeys:[],focus:'concept',referenceQuote:'这是对规则的概括，不是逐字引文',referenceAnswer:'分别回答做什么与必须满足什么',explanation:'比较职责'};
validateProgressiveQuestions([question],page.body);const before=progressiveQuestionHash(question);
const attempt={id:'a',submissionId:'s',questionId:'q1',questionHash:before,pageHash:'p',question:projectProgressiveQuestion(question),answer:{text:'合成作答：指令规定任务，约束规定限制。'},submittedAt:'a'} as ProgressiveAttempt;
const results=await assessProgressiveAnswers(page,[attempt],new AbortController().signal,async request=>{
  const input=JSON.parse(request.userInput);assert.equal(input.tasks[0].evidenceId,undefined);assert.equal(input.teaching.map((p:any)=>p.quote).join(''),page.body);
  return{content:JSON.stringify({results:[{attemptId:'a',referenceId:'T1',judgment:{outcome:'correct',errorKind:'none',explanation:'已核对本页四种职责',referenceAnswer:'指令规定任务，约束限定边界'}}]})} as any;
});
assert.equal(results[0].judgment.referenceQuote,page.body);assert.equal(progressiveQuestionHash(question),before);
const closed={...question,kind:'choice',options:[{id:'A',text:'任务'},{id:'B',text:'背景'}],correctOptionId:'A'};delete closed.referenceQuote;
validateProgressiveQuestions([closed],page.body);
assert.equal(localProgressiveJudgment({...attempt,question:closed,answer:{text:'',optionId:'A'}},page.body)?.outcome,'correct');
assert.equal(localProgressiveJudgment({...attempt,question:closed,answer:{text:'',optionId:'A'}},page.body)?.referenceQuote,undefined);
console.log('PASS screenshot labels render bold; code/math/escapes stay literal; foreground/worker source unchanged; optional teaching hints publish and independent grading uses real page text');
