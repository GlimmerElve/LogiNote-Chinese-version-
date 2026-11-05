/** Presentation-only migration of our serialized local-function template.
 * Data is parsed as JSON; authored scripts are never executed here. */
export function fitStoredLocalFunctionViewport(html: string): string {
  if (!html.includes('data-local-function="true"')) return html;
  let result=html;
  const matches=[...html.matchAll(/const d=(\{[^\n]+?\}),root=document\.currentScript\.previousElementSibling/gu)].reverse();
  for(const match of matches){
    try {
      const data=JSON.parse(match[1]), start=match.index!, svgStart=result.lastIndexOf('<svg viewBox="0 0 780 385"',start), svgEnd=result.indexOf('</svg>',svgStart)+6;
      if(svgStart<0||svgEnd<=svgStart||svgEnd>start||data.fixedYRange || ![data.xmin,data.xmax,data.ymin,data.ymax,data.left,data.right,data.top,data.bottom].every(Number.isFinite)
        || data.left!==68||data.right!==738||data.top!==24||data.bottom!==346||data.xmin>=data.xmax||data.ymin>=data.ymax)continue;
      const rows=data.samples;
      if(!Array.isArray(rows)||rows.length<2||rows.length>1001||!rows.every((row:unknown)=>Array.isArray(row)&&row.length>=2&&row.length<=5&&row.every(value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e6)))continue;
      const ys=rows.flatMap((row:number[])=>row.slice(1)),low=Math.min(data.ymin,...ys),high=Math.max(data.ymax,...ys);
      if(low===data.ymin&&high===data.ymax)continue;
      // A steep jump may be a pole between samples. Keep its chosen window.
      const deltas=rows.slice(1).flatMap((row:number[],i:number)=>row.slice(1).map((y,j)=>Math.abs(y-rows[i][j+1]))).sort((a:number,b:number)=>a-b);
      if(deltas.at(-1)>Math.max(1e-9,deltas[Math.floor(deltas.length/2)])*40)continue;
      const padding=(high-low)*.04,ymin=Math.max(-1e6,low-padding),ymax=Math.min(1e6,high+padding),Y=(y:number)=>346-(y-ymin)/(ymax-ymin)*322;
      let svg=result.slice(svgStart,svgEnd);
      if(!svg.includes('data-local-curve=')||!svg.includes('<g class="grid">'))continue;
      const n=(value:number)=>Number(value.toPrecision(8)).toString();
      svg=svg.replace(/(<path\b[^>]*\bdata-local-curve="[^"]+"[^>]*\bd=")([^"]+)(")/gu,(_all,open:string,d:string,close:string)=>{
        if(!/^(?:[ML]-?[\d.e+-]+ -?[\d.e+-]+\s*)+$/u.test(d))throw Error('unknown path');
        return open+d.replace(/([ML])(-?[\d.e+-]+) (-?[\d.e+-]+)/gu,(_point,command:string,x:string,y:string)=>`${command}${x} ${n(Y(data.ymin+(346-Number(y))/322*(data.ymax-data.ymin)))}`)+close;
      });
      const ticks=(from:number,to:number)=>{const raw=(to-from)/5,power=10**Math.floor(Math.log10(raw)),scaled=raw/power,step=(scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;const values:number[]=[];for(let i=Math.ceil(from/step);i<=Math.floor(to/step)&&values.length<20;i++)values.push(Number((i*step).toPrecision(12)));return values};
      const grid=ticks(data.xmin,data.xmax).map(x=>{const at=68+(x-data.xmin)/(data.xmax-data.xmin)*670;return `<line x1="${n(at)}" y1="24" x2="${n(at)}" y2="346"/><text x="${n(at)}" y="366" text-anchor="middle">${x}</text>`}).join('')
        +ticks(ymin,ymax).map(y=>`<line x1="68" y1="${n(Y(y))}" x2="738" y2="${n(Y(y))}"/><text x="60" y="${n(Y(y)+4)}" text-anchor="end">${y}</text>`).join('');
      svg=svg.replace(/<g class="grid">[\s\S]*?<\/g>/u,`<g class="grid">${grid}</g>`)
        .replace(/<line class="axis" x1="68" y1="[^"]+" x2="738" y2="[^"]+"\/>/u,`<line class="axis" x1="68" y1="${n(Math.max(24,Math.min(346,Y(0))))}" x2="738" y2="${n(Math.max(24,Math.min(346,Y(0))))}"/>`);
      const json=JSON.stringify({...data,ymin,ymax}).replace(/</gu,'\\u003c').replace(/&/gu,'\\u0026');
      result=result.slice(0,start)+result.slice(start).replace(match[0],`const d=${json},root=document.currentScript.previousElementSibling`);
      result=result.slice(0,svgStart)+svg+result.slice(svgEnd);
    }catch{/* Unknown templates retain their original document. */}
  }
  return result.length<=100_000?result:html;
}
