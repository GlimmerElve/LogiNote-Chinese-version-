/** Layout-only reading view. No synonym resolution, punctuation rewrite or semantic inference. */
export function entityReadingView(raw:string){
  let text='';const starts:number[]=[],ends:number[]=[];
  for(let i=0;i<raw.length;){
    const begin=i;
    if(/\s/u.test(raw[i])){
      while(i<raw.length&&/\s/u.test(raw[i]))i++;
      if(!text||i===raw.length)continue;
      const run=raw.slice(begin,i);
      // PDF line breaks inside a Chinese word are not lexical spaces. English word
      // boundaries remain spaces; ordinary inline spaces and punctuation are preserved.
      if(/[\r\n]/u.test(run)&&/\p{Script=Han}/u.test(raw[begin-1])&&/\p{Script=Han}/u.test(raw[i]))continue;
      text+=' ';starts.push(begin);ends.push(i);
    }else{text+=raw[i];starts.push(i);ends.push(++i);}
  }
  return {text,starts,ends};
}
export const entityReadingLabel=(raw:string)=>entityReadingView(raw).text;
export interface EntityReadingFragment {id:string;nodeId:string;text:string;raw:string;nodeStart:number;starts:number[];ends:number[]}
export function makeEntityReadingFragments(nodes:Array<{id:string;quotes:string[]}>):EntityReadingFragment[]{
  return nodes.flatMap(node=>{
    let nodeStart=0;
    return node.quotes.map((raw,i)=>{const view=entityReadingView(raw),fragment={id:`${node.id}:F${i+1}`,nodeId:node.id,raw,nodeStart,...view};
      nodeStart+=raw.length+1;return fragment;});
  });
}
export function locateEntityMention(fragment:EntityReadingFragment,quote:string,occurrence?:number){
  const positions:number[]=[];
  if(quote)for(let at=fragment.text.indexOf(quote);at>=0;at=fragment.text.indexOf(quote,at+1))positions.push(at);
  if(!positions.length)return {status:'missing' as const,count:0};
  if(occurrence===undefined&&positions.length!==1)return {status:'ambiguous' as const,count:positions.length};
  if(occurrence!==undefined&&(!Number.isSafeInteger(occurrence)||occurrence<1||occurrence>positions.length))return {status:'invalid_occurrence' as const,count:positions.length};
  const at=positions[(occurrence||1)-1],start=fragment.starts[at],end=fragment.ends[at+quote.length-1];
  return {status:'matched' as const,count:positions.length,quote:fragment.raw.slice(start,end),
    source:{start:fragment.nodeStart+start,end:fragment.nodeStart+end}};
}
