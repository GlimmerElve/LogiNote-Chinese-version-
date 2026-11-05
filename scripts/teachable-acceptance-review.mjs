import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/** The editable human worksheet never changes the automatic JSON report. */
export async function writeTeachingReview(reportFile) {
  const folder=path.dirname(path.resolve(reportFile));
  const report=JSON.parse(await readFile(reportFile,'utf8'));
  const fixtureText=await readFile('scripts/fixtures/teachable-acceptance-cases.json','utf8');
  if(report.fixtureSha256 && createHash('sha256').update(fixtureText).digest('hex')!==report.fixtureSha256) throw Error('验收案例已变化，不能用当前案例重建旧报告评审表');
  const fixture=JSON.parse(fixtureText);
  const safe=text=>String(text).replace(/[\r\n]+/gu,' ').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
  const lines=['# 交互教材验收评审','',`自动验收：${safe(report.status)}。本表均初始为未评审；请依据实际操作和画面逐项填写。`,'',
    '本表使用合成材料。自动生成成功不代表教学正确；学习效果需要真实参与者任务验证。','','[自动结果](report.json)',''];
  for(const item of fixture.cases){
    const live=report.liveResults.find(value=>value.caseId===item.id);
    lines.push(`## ${safe(item.discipline)} · ${safe(item.id)}`,'',`**目标：**${safe(item.goal)}`, '',`**材料：**${safe(item.lesson)}`,'',`**自动生成：**${live ? safe(live.status) : '本次未运行模型生成'}`);
    if(live?.safePreview){const rel=path.relative(folder,live.safePreview).split(path.sep).join('/');lines.push('',`[打开隔离离线预览](<${rel}>)`);}
    lines.push('','**核对要点：**','',...item.checks.map(check=>`- ${safe(check)}`),'',
      '- [ ] 教学目标、预测、反馈与迁移已审阅','- [ ] 数值、图形、来源和边界已审阅','- [ ] 浅色、深色、窄屏与键盘已审阅','- [ ] 保存、重新打开及离线分享已审阅','','结果与问题：未评审','');
  }
  const output=path.join(folder,'review.md');await writeFile(output,lines.join('\n'),{encoding:'utf8',flag:'wx'});return output;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw Error('请提供验收报告路径');console.log(await writeTeachingReview(process.argv[2]));
}
