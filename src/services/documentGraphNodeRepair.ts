import {parseNodeEnvelope,parseNodes,demand,type ExtractionWindow} from './documentGraphProtocol';
import {entityReadingView,entityReadingLabel} from './documentGraphEntityReading';

export interface NodeQuoteCandidate {start:number;end:number;quote:string;method:'layout'|'single_edit'}
export interface NodeQuoteIssue {nodeId:string;sourceIndex:number;window:string;quote:string;reason:'missing_window'|'ambiguous'|'missing_quote';candidates:NodeQuoteCandidate[]}
export interface NodeSourceRepairProposal {issues:NodeQuoteIssue[];nodeCount:number;validNodeCount:number;canConfirm:boolean}
export interface NodeSourceRepairAudit {nodeId:string;sourceIndex:number;window:string;before:string;after:string;start:number;end:number;method:NodeQuoteCandidate['method'];confirmed:true}

function oneEdit(a:string,b:string){
  if(Math.abs(a.length-b.length)>1||a===b)return false;
  let i=0;while(i<Math.min(a.length,b.length)&&a[i]===b[i])i++;
  if(a.length===b.length)return a.slice(i+1)===b.slice(i+1);
  return a.length>b.length?a.slice(i+1)===b.slice(i):a.slice(i)===b.slice(i+1);
}
/** Bounded local candidates, not semantic corrections. Every change needs explicit confirmation. */
function candidates(text:string,quote:string):NodeQuoteCandidate[]{
  const view=entityReadingView(text),label=entityReadingLabel(quote),layout:NodeQuoteCandidate[]=[];
  for(let at=view.text.indexOf(label);label&&at>=0;at=view.text.indexOf(label,at+1)){
    const start=view.starts[at],end=view.ends[at+label.length-1];
    layout.push({start,end,quote:text.slice(start,end),method:'layout'});if(layout.length===2)return layout;
  }
  if(layout.length)return layout;
  // Short phrases are too easy to confuse. Long quotes may suggest one-character
  // insertions/deletions/substitutions, including negation/numbers, but NEVER auto-apply.
  if(quote.length<40)return [];
  const starts=new Set<number>();let hits=0;
  for(const offset of [0,quote.length-16]){
    const anchor=quote.slice(offset,offset+16);
    for(let at=text.indexOf(anchor);at>=0;at=text.indexOf(anchor,at+1)){
      if(++hits>64)return [];for(const delta of [-1,0,1])if(at-offset+delta>=0)starts.add(at-offset+delta);
    }
  }
  const found:NodeQuoteCandidate[]=[];
  for(const start of starts)for(const length of [quote.length-1,quote.length,quote.length+1]){
    const end=start+length;if(end>text.length)continue;const original=text.slice(start,end);
    if(oneEdit(quote,original)){found.push({start,end,quote:original,method:'single_edit'});if(found.length===2)return found;}
  }
  return found;
}
export function inspectNodeSources(raw:string,windows:ExtractionWindow[]):NodeSourceRepairProposal{
  const nodes=parseNodeEnvelope(raw),map=new Map(windows.map(w=>[w.id,w.text])),issues:NodeQuoteIssue[]=[];
  for(const node of nodes)for(const [sourceIndex,source] of node.source.entries()){
    const text=map.get(source.window),at=text?.indexOf(source.quote)??-1;
    if(text!==undefined&&at>=0&&text.indexOf(source.quote,at+1)<0)continue;
    const reason=text===undefined?'missing_window':at>=0?'ambiguous':'missing_quote';
    issues.push({nodeId:node.id,sourceIndex,window:source.window,quote:source.quote,reason,
      candidates:reason==='missing_quote'?candidates(text!,source.quote):[]});
  }
  return {issues,nodeCount:nodes.length,validNodeCount:nodes.length-new Set(issues.map(i=>i.nodeId)).size,
    canConfirm:issues.length>0&&issues.length<=8&&issues.every(i=>i.candidates.length===1)};
}
/** Recompute from immutable raw/source inputs; never trust a callback-supplied quote. */
export function confirmNodeSources(raw:string,windows:ExtractionWindow[],confirmed:boolean){
  demand(confirmed,'引文修订尚未确认');const proposal=inspectNodeSources(raw,windows);
  demand(proposal.canConfirm,'引文候选缺失、歧义或超出修订预算');const nodes=parseNodeEnvelope(raw),audit:NodeSourceRepairAudit[]=[];
  for(const issue of proposal.issues){const c=issue.candidates[0],source=nodes.find(n=>n.id===issue.nodeId)!.source[issue.sourceIndex];
    source.quote=c.quote;audit.push({nodeId:issue.nodeId,sourceIndex:issue.sourceIndex,window:issue.window,before:issue.quote,after:c.quote,
      start:c.start,end:c.end,method:c.method,confirmed:true});
  }
  const correctedRaw=JSON.stringify({nodes});parseNodes(correctedRaw,windows); // Includes cross-node overlap protection.
  return {correctedRaw,audit};
}
export class NodeSourceRepairRequired extends Error {
  constructor(public readonly proposal:NodeSourceRepairProposal){
    super(`已保留本批 ${proposal.nodeCount} 个节点的原始响应；${proposal.issues.length} 处引文待核对。${proposal.canConfirm?'确认原文修订后可继续，无需重发初抽。':'候选不唯一或无法安全定位，未自动修改或重新请求。'}`);
    this.name='NodeSourceRepairRequired';
  }
}
