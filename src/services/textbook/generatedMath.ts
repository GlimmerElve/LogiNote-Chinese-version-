import type { Root, PhrasingContent } from 'mdast';
import { decodeString } from 'micromark-util-decode-string';
import { generatedMathEnvironmentAt } from './generatedMathEnvironments';

export type GeneratedMathScope = 'all' | 'knowledge-section';
export interface GeneratedMathOptions { citationIds?: readonly string[]; source?: string }
type Token = { value: string; end: number };
type Expr = { tex: string; strong: boolean };
const functions = new Set(['sin','cos','tan','cot','sec','csc','arcsin','arccos','arctan','ln','log','exp']);
const words = new Set(['is','in','at','on','of','to','by','as','be','it','if','or','an','am','do','no','so','we','us','he','me']);
const symbols: Record<string,string> = { 'Δ':'\\Delta','δ':'\\delta','α':'\\alpha','β':'\\beta','γ':'\\gamma','θ':'\\theta','λ':'\\lambda','μ':'\\mu','π':'\\pi','ε':'\\varepsilon','∞':'\\infty', '→':'\\to','⇒':'\\Rightarrow','≤':'\\le','≥':'\\ge','≠':'\\ne','∈':'\\in','±':'\\pm','×':'\\times','·':'\\cdot','−':'-' };
const commands = new Set([...functions,'frac','dfrac','tfrac','sqrt','lim','sum','int',...Object.values(symbols).map(s=>s.slice(1)), 'to','le','ge','ne','in','cdot','times','pm','infty']);
const relation = new Set(['=','<','>','≤','≥','≠','→','⇒','∈','\\to','\\le','\\ge','\\ne','\\in']);
const render = (s:string) => symbols[s] || s;

/** Bounded notation parser, not a symbolic solver. It only adds presentation to
 * unambiguous expressions; it never changes numbers, signs or answer meaning. */
function expressionAt(source: string, start: number): { end:number; tex:string } | null {
  const tokens:Token[]=[]; let end=start, truncated=false;
  while(end<source.length && tokens.length<160 && end-start<700){
    const space=/^[ \t]+/u.exec(source.slice(end)); if(space){end+=space[0].length;continue;}
    const tail=source.slice(end);let value='';
    const command=/^\\([a-zA-Z]+)/u.exec(tail);
    if(command){if(!commands.has(command[1]))break;value=command[0];}
    else {
      const number=/^(?:\d+(?:\.\d+)?|\.\d+)/u.exec(tail);
      const word=/^[A-Za-z]+/u.exec(tail);
      if(number)value=number[0];
      else if(word){
        if(functions.has(word[0])||word[0]==='lim')value=word[0];
        else if(word[0].length<=2&&!words.has(word[0]))value=word[0][0];
        else break;
      }else if(/^[Δδαβγθλμπε∞Σ∫+\-−*/^_=<>≤≥≠→⇒∈±×·′'()\[\]{},|]/u.test(tail))value=tail[0];
      else break;
    }
    end+=value.length;tokens.push({value:value==='′'?"'":value,end});
  }
  if(tokens.length>=160||end-start>=700)truncated=true;
  if(!tokens.length||truncated)return null;
  let at=0;
  const peek=()=>tokens[at]?.value;
  const take=()=>{const token=tokens[at++];if(!token)throw Error('incomplete');return token.value;};
  const expect=(v:string)=>{if(take()!==v)throw Error('unbalanced');};
  const atomStart=(s:string|undefined)=>Boolean(s && (/^[A-Za-zΔδαβγθλμπε∞\d.]/u.test(s)||s.startsWith('\\')||['(','[','{','|','∫','Σ'].includes(s)));
  const combine=(a:Expr,b:Expr,op:string):Expr=>({tex:`${a.tex} ${render(op)} ${b.tex}`,strong:a.strong||b.strong||relation.has(op)||['±','×','·'].includes(op)});
  const group=():Expr=>{
    const open=take(),close=open==='('?')':open==='['?']':'}';
    const rows=[comparison()];while(peek()===','){take();rows.push(comparison());}expect(close);
    const inside=rows.map(row=>row.tex).join(',');
    return {tex:open==='{'?inside:`\\left${open}${inside}\\right${close}`,strong:rows.some(row=>row.strong)||rows.length>1};
  };
  const script=():Expr=>['{','(','['].includes(peek()||'')?group():primary();
  const primary=():Expr=>{
    const value=peek();if(!value)throw Error('incomplete');
    if(['(','[','{'].includes(value))return group();
    if(value==='|'){take();const inside=addition();expect('|');return{tex:`\\left|${inside.tex}\\right|`,strong:true};}
    if(['+','-','−'].includes(value)){take();const next=primary();return{tex:render(value)+next.tex,strong:next.strong};}
    take();const name=value.startsWith('\\')?value.slice(1):value;
    if(['lim','Σ','∫','sum','int'].includes(name)){
      let lower:Expr|undefined,upper:Expr|undefined;
      if(name==='lim'&&peek()==='('){lower=group();lower={...lower,tex:lower.tex.replace(/^\\left\(/u,'').replace(/\\right\)$/u,'')};}
      if(peek()==='_'){take();lower=script();}if(peek()==='^'){take();upper=script();}
      const body=atomStart(peek())?addition():{tex:'',strong:false};
      const op=name==='lim'?'\\lim':name==='Σ'||name==='sum'?'\\sum':'\\int';
      const tex=op+(lower?`_{${lower.tex}}`:'')+(upper?`^{${upper.tex}}`:'')+' '+body.tex;
      return{tex:op==='\\int'?tex.replace(/d ([a-z])$/u,'\\,\\mathrm{d}$1'):tex,strong:true};
    }
    if(['frac','dfrac','tfrac'].includes(name)){
      const a=script(),b=script();return{tex:`\\frac{${a.tex}}{${b.tex}}`,strong:true};
    }
    if(name==='sqrt'){const a=script();return{tex:`\\sqrt{${a.tex}}`,strong:true};}
    if((value==='Δ'||value==='\\Delta')&&/^[A-Za-z]$/u.test(peek()||'')){
      const variable=power();return{tex:`\\Delta ${variable.tex}`,strong:true};
    }
    if(functions.has(name)){
      if(!atomStart(peek()))return{tex:value,strong:false};
      const next=power();return{tex:`\\${name} ${next.tex}`,strong:true};
    }
    if(!/^(?:[A-Za-zΔδαβγθλμπε∞]|\\[A-Za-z]+|\d+(?:\.\d+)?|\.\d+)$/u.test(value))throw Error('not an atom');
    let out:Expr={tex:render(value),strong:Boolean(symbols[value])};
    // Common numbered coordinates (x0) are presentation subscripts, never a
    // rewrite of version identifiers such as v1.0.10 or citation IDs [L1].
    if(/^[A-Za-z]$/u.test(value)&&/^\d+$/u.test(peek()||'')&&tokens[at-1].end===tokens[at].end-tokens[at].value.length){
      const n=take();out={tex:`${value}_{${n}}`,strong:/^[xyzt]$/u.test(value)};
    }
    return out;
  };
  const power=():Expr=>{
    let left=primary();
    while(peek()==="'"||peek()==='_'||peek()==='^'||peek()==='('){
      const op=take();
      if(op==="'"){left={tex:left.tex+"'",strong:true};continue;}
      if(op==='('){at--;const arg=group();left={tex:left.tex+arg.tex,strong:true};continue;}
      const right=script();left={tex:`${left.tex}${op}{${right.tex}}`,strong:true};
    }return left;
  };
  const product=():Expr=>{
    let left=power();
    while(true){
      const op=peek();
      if(['*','/','×','·'].includes(op||'')){
        take();const right=power();left=op==='/'?{tex:`\\frac{${left.tex}}{${right.tex}}`,strong:true}:combine(left,right,op==='*'?'·':op!);
      }else if(atomStart(op)&&op!=='|'){
        const right=power();left={tex:left.tex+' '+right.tex,strong:left.strong||right.strong};
      }else break;
    }return left;
  };
  const addition=():Expr=>{let left=product();while(['+','-','−','±'].includes(peek()||'')){const op=take();left=combine(left,product(),op);}return left;};
  const comparison=():Expr=>{let left=addition();while(relation.has(peek()||'')){const op=take();left=combine(left,addition(),op);}return left;};
  try{
    const parsed=comparison();if(!parsed.strong||at!==tokens.length)return null;
    const finish=tokens[at-1].end;
    if(/[A-Za-z0-9_]/u.test(source[finish]||'')||source[finish]==='.'&&/[A-Za-z0-9]/u.test(source[finish+1]||''))return null;
    return{end:finish,tex:parsed.tex};
  }catch{return null;}
}

/** Existing explicit math/code/wiki targets and URLs are opaque. Only bare
 * generated notation is recovered; stored questions and hashes stay intact. */
export function generatedMathSpans(value:string,options:GeneratedMathOptions={}):Array<{start:number;end:number;tex:string}>{
  return generatedMathSpansWithCitations(value,new Set(options.citationIds || []));
}

/** Stop only at a trailing known citation after an independently complete
 * expression. In x=[8], x= is incomplete, so the single-element vector stays.
 * A marker followed by more math (x=[8]+1) remains part of that expression. */
function withoutTrailingCitations(value:string,start:number,found:{end:number;tex:string},ids:ReadonlySet<string>){
  let end=found.end,best=found;
  while(end>start){
    const prefix=value.slice(start,end).replace(/[ \t]+$/u,'');
    const marker=/\[([A-Za-z0-9_-]+)\]$/u.exec(prefix);
    if(!marker || !ids.has(marker[1]) && !/^[A-Za-z_][\w-]*$/u.test(marker[1]))break;
    const boundary=start+marker.index;
    const before=expressionAt(value.slice(0,boundary),start);
    if(before && !value.slice(before.end,boundary).trim())best=before;
    end=boundary;
  }
  return best;
}

/** A raw Markdown link is opaque in the string adapter too. The AST adapter
 * already skips link nodes; this bounded scan preserves their labels/targets. */
function markdownLinkEnd(value:string,start:number,ids:ReadonlySet<string>):number|undefined{
  let cursor=start+(value[start]==='!'?1:0);
  if(value[cursor]!=='[')return;
  let depth=0;
  for(;cursor<Math.min(value.length,start+16_000);cursor++){
    if(value[cursor]==='\\'){cursor++;continue;}
    if(value[cursor]==='[')depth++;
    else if(value[cursor]===']'&&!--depth){cursor++;break;}
  }
  if(depth)return;
  const open=value[cursor];
  if(open!== '('&&open!=='[')return;
  if(open==='['){const citation=/^\[([^\]\r\n]+)\]/u.exec(value.slice(cursor));if(citation&&(ids.has(citation[1])||/^[A-Z]\d+$/u.test(citation[1])))return;}
  const close=open==='('?')':']';depth=0;
  for(;cursor<Math.min(value.length,start+16_000);cursor++){
    if(value[cursor]==='\\'){cursor++;continue;}
    if(value[cursor]===open)depth++;
    else if(value[cursor]===close&&!--depth)return cursor+1;
  }
}

function generatedMathSpansWithCitations(value:string,ids:ReadonlySet<string>,recoverEnvironments=true):Array<{start:number;end:number;tex:string}>{
  const result:Array<{start:number;end:number;tex:string}>=[];
  const hasEnvironments=value.includes('\\begin');
  for(let i=0;i<value.length;){
    const tail=value.slice(i);
    const numericCitation=/^\[(\d+)\]/u.exec(tail);
    if(numericCitation&&ids.has(numericCitation[1])){i+=numericCitation[0].length;continue;}
    const protectedText=/^(?:https?:\/\/[^\s]+|\[\[[^\]\n]+\]\]|\[(?:[A-Z]\d+|[A-Za-z_][\w-]*)\]|`+[^`]*`+)/u.exec(tail);
    if(protectedText){i+=protectedText[0].length;continue;}
    if(value[i]==='['||value[i]==='!'){const linkEnd=markdownLinkEnd(value,i,ids);if(linkEnd){i=linkEnd;continue;}}
    // Explicit environment structure is stronger evidence than the bounded
    // scalar notation parser. Consume it whole, preserving every cases row.
    const environment=hasEnvironments?generatedMathEnvironmentAt(value,i,ids):undefined;
    if(environment){if(recoverEnvironments&&environment.recoverable)result.push({start:i,end:environment.end,tex:environment.tex});i=environment.end;continue;}
    // A broken/downgraded environment is opaque too: never turn its individual
    // rows into unrelated scalar formulas or guess missing TeX separators.
    const incompleteEnvironment=hasEnvironments?/^\\begin\s*\{([A-Za-z]+)\}/u.exec(tail):null;
    if(incompleteEnvironment){const close=`\\end{${incompleteEnvironment[1]}}`,end=value.indexOf(close,i+incompleteEnvironment[0].length);i=end<0?value.length:end+close.length;continue;}
    if(value[i]==='$'||tail.startsWith('\\(')||tail.startsWith('\\[')){
      const open=value[i]==='$'?(value[i+1]==='$'?'$$':'$'):tail.slice(0,2),close=open==='\\('? '\\)':open==='\\['?'\\]':open;
      const end=value.indexOf(close,i+open.length);if(end>=0){i=end+close.length;continue;}if(value[i]==='$')break;
    }
    if(/[A-Za-z0-9_\\]/u.test(value[i-1]||'')||!/[A-Za-z0-9ΔδαβγθλμπεΣ∫(\[|\\]/u.test(value[i])){i++;continue;}
    const found=expressionAt(value,i);
    if(found){const bounded=withoutTrailingCitations(value,i,found,ids);result.push({start:i,end:bounded.end,tex:bounded.tex});i=bounded.end;}
    else {const word=/^[A-Za-z]+/u.exec(tail);i+=word?.[0].length||1;}
  }return result;
}
export function generatedMathMarkdown(value:string,options:GeneratedMathOptions={}):string{
  let cursor=0,result='';for(const span of generatedMathSpans(value,options)){result+=value.slice(cursor,span.start)+'$'+span.tex+'$';cursor=span.end;}return result+value.slice(cursor);
}
export function recoverGeneratedMathTree(tree:Root,scope:GeneratedMathScope='knowledge-section',options:GeneratedMathOptions={}){
  // Build the lookup once per imported document, never once per text node or
  // from a scroll/input listener. Only the display tree changes.
  const ids=new Set(options.citationIds || []);
  const walk=(node:any)=>{
    if(!node.children||['code','inlineCode','math','inlineMath','link','linkReference','html'].includes(node.type))return;
    node.children=node.children.flatMap((child:any)=>{
      if(child.type!=='text'){walk(child);return[child];}
      let spans=generatedMathSpansWithCitations(child.value,ids,false);
      const start=child.position?.start.offset,end=child.position?.end.offset;
      if(options.source&&child.value.includes('\\begin')&&start!==undefined&&end!==undefined){
        const raw=options.source.slice(start,end),decode=(text:string)=>decodeString(text).replace(/\r\n?/gu,'\n');
        // CommonMark consumes one slash from each \\ separator. Only use
        // source coordinates when this exact text leaf still matches its raw
        // slice; preceding formatting transforms may create positionless nodes.
        let logical=raw;
        if(raw.includes('\\begin')&&decode(logical)!==child.value){
          // Continuation lines inside blockquotes/lists contain container
          // prefixes in the source range, but not in the text leaf. Accept a
          // projection only when the entire decoded leaf is exactly equal.
          const unquoted=raw.replace(/(\r?\n) {0,3}(?:>[ \t]?)+/gu,'$1');
          if(decode(unquoted)===child.value)logical=unquoted;
          else for(let indent=1;indent<=Math.min(32,(child.position?.start.column||1)-1);indent++){
            const projected=unquoted.replace(new RegExp(`(\\r?\\n) {1,${indent}}`,'gu'),'$1');
            if(decode(projected)===child.value){logical=projected;break;}
          }
        }
        if(raw.includes('\\begin')&&decode(logical)===child.value){
          const environments=generatedMathSpansWithCitations(logical,ids).filter(span=>span.tex.includes('\\begin'));
          if(environments.length){
            let rawCursor=0,decodedCursor=0;
            const recovered=environments.map(span=>{
              const start=decodedCursor+decode(logical.slice(rawCursor,span.start)).length;
              const end=start+decode(logical.slice(span.start,span.end)).length;
              rawCursor=span.end;decodedCursor=end;return{start,end,tex:span.tex};
            });
            spans=[...spans.filter(span=>!recovered.some(env=>span.start<env.end&&span.end>env.start)),...recovered].sort((a,b)=>a.start-b.start);
          }
        }
      }
      if(!spans.length)return[child];
      const rows:PhrasingContent[]=[];let cursor=0;
      for(const span of spans){
        if(span.start>cursor)rows.push({type:'text',value:child.value.slice(cursor,span.start)});
        rows.push({type:'inlineMath',value:span.tex,data:{hName:'code',hProperties:{className:['language-math','math-inline']},hChildren:[{type:'text',value:span.tex}]}});
        cursor=span.end;
      }
      if(cursor<child.value.length)rows.push({type:'text',value:child.value.slice(cursor)});return rows;
    });
  };
  let active=scope==='all';
  for(const node of tree.children){
    if(scope!=='all'&&node.type==='heading'&&node.depth<=3){active=node.depth===3&&node.children.map(n=>'value'in n?n.value:'').join('').trim()==='本项目需要掌握的知识点';continue;}
    if(active)walk(node);
  }
}
export function remarkGeneratedMath(options:GeneratedMathOptions&{scope?:GeneratedMathScope}={}){return(tree:Root,file?:{value?:unknown})=>recoverGeneratedMathTree(tree,options.scope,{...options,source:options.source??String(file?.value||'')});}
