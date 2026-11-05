import type {DocumentChunk, StructuredDocument} from '../../types';
import type {DocumentGraphWindow} from '../../services/documentGraphTypes';
import {planContextWindows} from './argumentWindowContext';
import {argumentSentenceRanges} from './argumentWindowPlanner';

/** Views keep exact source spans. No model rewrite or semantic boundary guessing. */
export function documentGraphWindows(chunks:DocumentChunk[], source:StructuredDocument|null): {windows:DocumentGraphWindow[];limitations:string[]} {
  if (source) {
    const plan=planContextWindows(source);
    const limitations:string[]=[];
    const mapSpan=(start:number,end:number) => {
      const parts:DocumentGraphWindow['parts']=[];
      while(start<end){
        const c=chunks.filter(c=>typeof c.textStart==='number'&&typeof c.textEnd==='number'&&c.textStart<=start&&c.textEnd>start)
          .sort((a,b)=>b.textEnd!-a.textEnd!).find(c=>c.content.slice(start-c.textStart!,Math.min(end,c.textEnd!)-c.textStart!)===source.normalizedText.slice(start,Math.min(end,c.textEnd!)));
        if(!c) throw new Error('资料窗口无法回放到原文分块，请先重新索引资料');
        const stop=Math.min(end,c.textEnd!);parts.push({chunkId:c.id,start:start-c.textStart!,end:stop-c.textStart!});start=stop;
      }
      return parts;
    };
    const windows=plan.windows.filter(w=>w.core.some(u=>u.contentRole==='body')).map((w,i)=>{
      if(!w.readyForExtraction){
        // Names, dates, abstract labels and keyword lists need not end with a sentence mark.
        // These are completeness warnings, not token overflow. Keep all exact text and disclose
        // the missing bridge; do not silently discard frontmatter or certify its semantics.
        const warnings=new Set(['unfinished_sentence_or_non_body_text','incomplete_boundary_not_carried']);
        if(w.kind!=='paragraph'||w.core.some(u=>u.continuation)||w.gaps.some(g=>!warnings.has(g)))
          throw new Error(`窗口 ${i+1} 无法安全准备（${w.gaps.join('、')||w.kind}），需先检查原文或阅读窗口`);
        limitations.push(`W${i+1}：${w.gaps.join('、')}。原文完整保留，但句末或跨窗衔接未获确认；不能视为语义完整性认证。`);
      }
      const spans=[...w.before,...w.core,...w.after].flatMap(u=>u.segments);
      const notes=[...new Set(w.references.map(r=>r.noteId))].map(id=>plan.notes.find(n=>n.id===id)!);
      const unique=[...spans,...notes].filter((s,i,all)=>all.findIndex(t=>t.start===s.start&&t.end===s.end)===i);
      return {id:`W${i+1}`,section:w.sectionPath,parts:unique.flatMap(s=>mapSpan(s.start,s.end))};
    });
    if(plan.calls.some(c=>c.status!=='matched'))limitations.push('部分注释对应关系尚未确定；未猜测脚注归属。');
    return {windows,limitations};
  }
  // Legacy sources have no layout: preserve exact, complete sentences and disclose this fallback.
  const windows:DocumentGraphWindow[]=[];
  for(const c of chunks){
    let start=0,end=0;
    const flush=()=>{if(end>start)windows.push({id:`W${windows.length+1}`,section:c.sectionPath,parts:[{chunkId:c.id,start,end}]});};
    for(const s of argumentSentenceRanges(c.content)){
      if(s.end-start>3500&&end>start){flush();start=s.start;}
      end=s.end;
    }
    flush();
  }
  return {windows,limitations:['旧资料没有版面结构，使用既有分块中的完整句范围；请重新索引以获得章节、过渡句和脚注窗口。']};
}
