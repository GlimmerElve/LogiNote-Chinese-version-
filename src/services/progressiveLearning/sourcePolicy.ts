import type { ProgressiveSourcePacket } from './types';
const stop=new Set(['学习','能够','理解','说明','梳理','掌握','识别','解释','分析','探讨','辨认','区分','判断','比较','认识','了解','回顾','练习','检验','验证','观察','核对','确定','本页','本章','本项目','一个','什么','如何','为什么','及其','以及','其中','进行','实际','没有','可以','不能','是否','之间','相关','知识','概念','目标','要求','用于','依据','需要','分别','必须','这种','情况','the','of','and','with','from','how']);
export function progressiveMaterialTerms(query:string):string[]{
  const terms=new Set<string>();
  const words=(query.toLowerCase().match(/[a-z][a-z0-9'-]{1,35}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(word=>/^[a-z]/u.test(word)?[word]:word.split(/[的了是在与和及其从对为于把有等或]/u).filter(part=>part.length>=2));
  for(const word of words){
    if(/^[a-z]/u.test(word)){if(!stop.has(word))terms.add(word);continue;}
    if(word.length<=6&&!stop.has(word))terms.add(word);
    for(let i=0;i<word.length-1;i++){const term=word.slice(i,i+2);if(!stop.has(term))terms.add(term);}
    for(let i=0;i<word.length-2;i++){const term=word.slice(i,i+3);if(!stop.has(term))terms.add(term);}
  }
  return [...terms].slice(0,120);
}
/** A page's first meaningful word retains its concrete topic (e.g. 荷马),
 * rather than letting a shared surname elsewhere in a book dominate recall. */
export function progressiveTopicAnchor(topic:string):string|undefined{
  const ignored=new Set([...stop,'第一','第二','第三','第四','第五','基础','入门','内容','介绍','本节','核心','关系','基本','主要','原理']);
  const Segmenter=(Intl as any).Segmenter;
  if(Segmenter){for(const word of new Segmenter('zh',{granularity:'word'}).segment(topic))if(word.isWordLike&&word.segment.length>=2&&!ignored.has(word.segment))return word.segment.toLowerCase();}
  return progressiveMaterialTerms(topic)[0];
}

/** Metadata/front matter is not evidence for teaching claims. Match section
 * names, not arbitrary occurrences of these words inside real teaching text. */
export function isMaterialFrontMatter(path: string): boolean {
  return path.split(/\s*(?:>|›|\/|／)\s*/u).some(part => {
    const name=part.replace(/^\s*(?:#{1,6}\s*|[0-9一二三四五六七八九十]+[.、．]\s*)/u,'').trim();
    return /^(?:版权(?:信息|声明|页)?|出版信息|书名页|封面|目\s*录(?:页|总览)?|本书赞誉|推荐(?:序|语)|作者序|译者(?:序|的话)|编者(?:序|按)|序言|前言|导读(?:[\s：:].*)?|致谢|参考(?:文献|书目)|索引|copyright(?:\s+page)?|table\s+of\s+contents|contents|index|acknowledg(?:e)?ments)$/iu.test(name);
  });
}
export function usableProgressiveSource(source: ProgressiveSourcePacket): boolean {
  if(source.kind==='model_knowledge'||!source.text.trim())return false;
  const section=source.locator?.split(' / ').slice(1).join(' / ')||'';
  if(isMaterialFrontMatter(section))return false;
  const heading=/^\s*#{1,6}\s+([^\n]+)/u.exec(source.text)?.[1];
  if(heading&&isMaterialFrontMatter(heading))return false;
  return !(/ISBN\s*[:：]?\s*[\d-]+/iu.test(source.text)&&/(?:出版社|版权所有|copyright)/iu.test(source.text)&&source.text.length<800);
}
/** Counts provided context and the model's markers, never claims semantic
 * verification or a percentage of the book actually read. Old pages stay intact. */
export function progressiveProvenance(sources: ProgressiveSourcePacket[],body:string){
  const usable=sources.filter(usableProgressiveSource);
  const ids=new Set(usable.map(s=>s.id));
  const markers=[...body.matchAll(/\[(S\d+)\]/gu)].map(m=>m[1]);
  return {sources:usable,characters:usable.reduce((n,s)=>n+s.text.length,0),markers:markers.filter(id=>ids.has(id)).length,
    invalidMarkers:markers.filter(id=>!ids.has(id)).length,excluded:sources.filter(s=>s.kind!=='model_knowledge').length-usable.length};
}
