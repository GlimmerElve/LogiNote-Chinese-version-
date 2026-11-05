import type {CompactInheritedGraph,DocumentArgumentWindow} from './documentArgumentV5Types';
// Freeze the historical A/B experiment independently of production prompt upgrades.
import {DOCUMENT_ARGUMENT_V5_LEGACY_BATCH_TEXT_PROMPT as DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT} from '../workflows/documentArgumentV5LegacyPrompt';

const FLAT_INPUT='- `text`：本批完整正文字符串，已按原文顺序预处理，保留标题和段落；不含页码、页眉、期刊元数据、DOI、URL、参考文献列表。本批不再划分编号窗口。';
const WINDOW_INPUT='- `windows`：按原文顺序排列的数组，每项只含 `id`和`text`。`text`是预处理后的完整语义段落；`id`只标记顺序和边界，不表示章节、角色或关系。按数组顺序连续阅读，不得把各窗口当成互不相关的独立任务。';

/** Experimental prompt only. It changes input presentation, not the production
 * prompt hash or graph protocol. No section labels or semantic annotations are added. */
export const DOCUMENT_ARGUMENT_V5_WINDOWED_ATTENTION_PROMPT=DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT
  .replace(FLAT_INPUT,WINDOW_INPUT)
  .replace('每段 quote 须为 text 内可唯一定位的连续原文',
    '每段 quote 须为某一项 windows[i].text 内可唯一定位的连续原文');

const heading=(text:string)=>text.trim().length<=120&&/^(?:#{1,6}\s+|\d+(?:\.\d+)*\.?\s+\S|第[一二三四五六七八九十\d]+[章节]|[一二三四五六七八九十]+、)/u.test(text.trim());
const terminal=(text:string)=>/[。！？.!?;；][”"’'）)\]]*\s*$/u.test(text);
const listItem=(text:string)=>/^\s*(?:[-*•]\s+|\d+[)）]|[（(]\d+[)）]|[一二三四五六七八九十]+[)）、])/u.test(text);
const dependentShort=(text:string)=>[...text].length<=100&&(
  /^(?:YES|NO|N\s*=|M\s*=|SD\s*=|F\s*=|p\s*[<=>]|表\s*\d|图\s*\d)/iu.test(text.trim())
  ||/^(?:但|而|因此|所以|同时|其中|上述|以上|该|此|这(?:一|些|种|表明|说明))/u.test(text.trim())
  ||!terminal(text));

/** Turn layout paragraphs into neutral attention windows without changing text.
 * Headings stay with their first body paragraph and short result fragments stay
 * with the preceding scenario. Size limits are soft because paragraphs are never split. */
export function buildNeutralAttentionWindows(paragraphs:DocumentArgumentWindow[],target=550,max=800){
  const units:Array<{texts:string[];startsWithHeading:boolean}>=[];
  for(const paragraph of paragraphs){
    const text=paragraph.text;
    if(!units.length){units.push({texts:[text],startsWithHeading:heading(text)});continue;}
    const previous=units.at(-1)!;
    const previousText=previous.texts.at(-1)!;
    const attach=heading(previousText)||!terminal(previousText)||/[:：]\s*$/u.test(previousText)||listItem(text)||dependentShort(text);
    if(attach)previous.texts.push(text);else units.push({texts:[text],startsWithHeading:heading(text)});
  }
  const groups:string[][]=[];let current:string[]=[];
  const size=(parts:string[])=>[...parts.join('\n\n')].length;
  for(const unit of units){
    const unitText=unit.texts.join('\n\n');
    if(current.length&&(unit.startsWithHeading||size([...current,unitText])>max||size(current)>=target)){
      groups.push(current);current=[];
    }
    current.push(unitText);
  }
  if(current.length)groups.push(current);
  return groups.map((parts,index)=>({id:`P${index+1}`,text:parts.join('\n\n')}));
}

export function buildDocumentArgumentInputShapeAb(paragraphs:DocumentArgumentWindow[],inherited:CompactInheritedGraph){
  const windows=buildNeutralAttentionWindows(paragraphs);
  const text=windows.map(window=>window.text).join('\n\n');
  if(!paragraphs.length||!text)throw new Error('document_argument_ab_empty_batch');
  return{
    flat:{prompt:DOCUMENT_ARGUMENT_V5_BATCH_TEXT_PROMPT,input:{text,inherited_graph:inherited}},
    windowed:{prompt:DOCUMENT_ARGUMENT_V5_WINDOWED_ATTENTION_PROMPT,input:{windows,inherited_graph:inherited}},
    parity:{sameText:text===windows.map(window=>window.text).join('\n\n'),characters:[...text].length,windows:windows.length,
      sourceParagraphs:paragraphs.length,hasSectionMetadata:false,hasSemanticLabels:false},
  };
}
