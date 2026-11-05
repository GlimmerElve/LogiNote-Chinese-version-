/** Whitespace-only display views. Original source and its non-whitespace offsets remain authoritative. */
export interface CleanupWindow {id:string;section:string;text:string;sourceOffsets:Array<number|null>}
export interface CleanupSpan {cleanStart:number;cleanEnd:number;sourceStart:number;sourceEnd:number}
const white=(s:string)=>/\s/u.test(s);
const fail=(reason:string):never=>{throw new Error(`window_cleanup_${reason}`);};
function exact(value:any,keys:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('shape');
}
export function mapWhitespaceOnlyView(original:CleanupWindow,cleaned:string){
  if(typeof cleaned!=='string'||cleaned.length>Math.max(100,original.text.length*2))return fail('output_budget');
  if(original.sourceOffsets.length!==original.text.length)return fail('source_map_length');
  const input:number[]=[],output:number[]=[];
  for(let i=0;i<original.text.length;i++)if(!white(original.text[i]))input.push(i);
  for(let i=0;i<cleaned.length;i++)if(!white(cleaned[i]))output.push(i);
  if(input.length!==output.length)return fail('non_whitespace_changed');
  const spans:CleanupSpan[]=[],cleanToSource:Array<number|null>=Array(cleaned.length).fill(null);
  for(let i=0;i<input.length;i++){
    const source=original.sourceOffsets[input[i]],at=output[i];
    if(original.text[input[i]]!==cleaned[at])return fail('non_whitespace_changed');
    if(!Number.isSafeInteger(source)||source!<0)return fail('unmapped_source_character');
    cleanToSource[at]=source;
    const last=spans.at(-1);
    if(last&&last.cleanEnd===at&&last.sourceEnd===source){last.cleanEnd++;last.sourceEnd++;}
    else spans.push({cleanStart:at,cleanEnd:at+1,sourceStart:source!,sourceEnd:source!+1});
  }
  return{originalText:original.text,cleanedText:cleaned,cleanToSource,spans,
    changed:original.text!==cleaned,nonWhitespaceCharacters:input.length,sourceIntegrityAccepted:true as const,
    // Whitespace changes can still alter English/numeric meaning; identity is not semantic approval.
    semanticAccepted:false,requiresReadabilityReview:true};
}
export function validateWindowWhitespaceCleanup(raw:unknown,windows:CleanupWindow[]){
  exact(raw,['windows']);const rows=(raw as any).windows;
  if(!Array.isArray(rows)||rows.length!==windows.length||windows.length>8||!windows.length)return fail('window_scope');
  if(new Set(windows.map(w=>w.id)).size!==windows.length)return fail('duplicate_input_window');
  const results=windows.map((w,i)=>{
    const row=rows[i];exact(row,['id','text']);if(row.id!==w.id)return fail('window_identity_or_order');
    try{return{id:w.id,section:w.section,accepted:true,...mapWhitespaceOnlyView(w,row.text),proposedText:row.text,error:null};}
    catch(error){return{id:w.id,section:w.section,accepted:false,...mapWhitespaceOnlyView(w,w.text),sourceIntegrityAccepted:false,
      proposedText:row.text,error:error instanceof Error?error.message:'window_cleanup_invalid',changed:false};}
  });
  return{windows:results,sourceIntegrityAccepted:results.every(w=>w.accepted),acceptedWindows:results.filter(w=>w.accepted).length,
    semanticAccepted:false,productionWrites:0,automaticRetries:0,sourceUnchanged:true,
    policy:'cleaned_view_only_original_source_is_authoritative'};
}
/** Bind a later selection from the cleaned view back to original non-whitespace source runs. */
export function cleanupSourceSpans(view:ReturnType<typeof mapWhitespaceOnlyView>,start:number,end:number):CleanupSpan[]{
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>view.cleanedText.length)return fail('selection_range');
  return view.spans.flatMap(s=>{
    const left=Math.max(start,s.cleanStart),right=Math.min(end,s.cleanEnd);
    return left<right?[{cleanStart:left,cleanEnd:right,sourceStart:s.sourceStart+left-s.cleanStart,sourceEnd:s.sourceStart+right-s.cleanStart}]:[];
  });
}
