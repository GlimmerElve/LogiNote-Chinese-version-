/** Read-only original-text coverage. Coverage is NOT semantic correctness or truth. */
export interface AuditWindow {id: string; section: string; text: string}
export interface AuditNode {id: string; source: Array<{window: string; quote: string}>}
export interface MaterialAnchor {id: string; window: string; quote: string; purpose: string}
interface Span {start: number; end: number; nodeId: string}
const nonWhitespaceLength = (s: string) => s.replace(/\s/gu, '').length;
function uniqueSpan(text: string, quote: string): {start: number; end: number} | null {
  const start = text.indexOf(quote);
  return quote && start >= 0 && text.indexOf(quote, start + 1) < 0 ? {start, end: start + quote.length} : null;
}
function merge(spans: Array<{start: number; end: number}>) {
  const out: Array<{start: number; end: number}> = [];
  for (const s of [...spans].sort((a,b)=>a.start-b.start || a.end-b.end)) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end,s.end);
    else out.push({...s});
  }
  return out;
}
export function auditNodeMaterials(windows: AuditWindow[], nodes: AuditNode[], anchors: MaterialAnchor[]) {
  const wm = new Map(windows.map(w=>[w.id,w]));
  if (wm.size !== windows.length || new Set(nodes.map(n=>n.id)).size !== nodes.length || new Set(anchors.map(a=>a.id)).size !== anchors.length) throw new Error('material_audit_duplicate_id');
  const spans = new Map<string,Span[]>(), sourceIssues: Array<{nodeId:string;window:string;code:string}> = [];
  for (const n of nodes) {
    if (!n.source.length) sourceIssues.push({nodeId:n.id,window:'',code:'empty_source'});
    for (const s of n.source) {
      const w = wm.get(s.window), span = w && uniqueSpan(w.text,s.quote);
      if (!span) {sourceIssues.push({nodeId:n.id,window:s.window,code:w?'source_not_unique_or_not_exact':'unknown_window'});continue;}
      const list = spans.get(s.window) || [];list.push({...span,nodeId:n.id});spans.set(s.window,list);
    }
  }
  const windowCoverage = windows.map(w=>{
    const covered = merge(spans.get(w.id)||[]), uncovered: Array<{start:number;end:number;text:string}> = [];
    let cursor=0;
    for (const s of [...covered,{start:w.text.length,end:w.text.length}]) {
      const text = w.text.slice(cursor,s.start);
      if (nonWhitespaceLength(text)) uncovered.push({start:cursor,end:s.start,text});
      cursor=Math.max(cursor,s.end);
    }
    const total = nonWhitespaceLength(w.text), coveredCharacters = covered.reduce((sum,s)=>sum+nonWhitespaceLength(w.text.slice(s.start,s.end)),0);
    return {window:w.id,section:w.section,totalNonWhitespaceCharacters:total,coveredNonWhitespaceCharacters:coveredCharacters,
      characterCoverage:total?coveredCharacters/total:null,uncovered};
  });
  const anchorCoverage = anchors.map(a=>{
    const w=wm.get(a.window), target=w&&uniqueSpan(w.text,a.quote);
    if (!target) throw new Error('material_audit_invalid_anchor:'+a.id);
    const hits=(spans.get(a.window)||[]).filter(s=>s.end>target.start&&s.start<target.end);
    const parts=merge(hits.map(s=>({start:Math.max(s.start,target.start),end:Math.min(s.end,target.end)})));
    const missing: Array<{start:number;end:number;text:string}> = [];let cursor=target.start;
    for(const s of [...parts,{start:target.end,end:target.end}]){const text=w!.text.slice(cursor,s.start);if(nonWhitespaceLength(text))missing.push({start:cursor,end:s.start,text});cursor=Math.max(cursor,s.end);}
    const byNode=new Map<string,Span[]>();for(const s of hits){const list=byNode.get(s.nodeId)||[];list.push(s);byNode.set(s.nodeId,list);}
    const containingNodeIds=[...byNode].filter(([,list])=>merge(list).some(s=>s.start<=target.start&&s.end>=target.end)).map(([id])=>id);
    return {...a,...target,status:missing.length?'missing':containingNodeIds.length?'covered':'fragmented',
      containingNodeIds,overlappingNodeIds:[...byNode.keys()],missing};
  });
  const total=windowCoverage.reduce((s,w)=>s+w.totalNonWhitespaceCharacters,0),covered=windowCoverage.reduce((s,w)=>s+w.coveredNonWhitespaceCharacters,0);
  return {sourceIssues,windowCoverage,anchorCoverage,summary:{windows:windows.length,nodes:nodes.length,anchors:anchors.length,
    missingAnchors:anchorCoverage.filter(a=>a.status==='missing').length,fragmentedAnchors:anchorCoverage.filter(a=>a.status==='fragmented').length,
    sourceIssueCount:sourceIssues.length,characterCoverage:total?covered/total:null},
    boundary:'Only exact source-span containment is checked. Complete coverage does not certify coherent chunks, semantic types, relations, retrieval delivery or answer correctness. Uncovered text is not automatically a missing argument.'};
}
