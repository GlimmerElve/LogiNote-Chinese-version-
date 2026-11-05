/** Trusted runtime for an isolated model-authored figure. Applied only to
 * text with insufficient contrast in an explicitly theme-aware dark figure.
 * It changes presentation, never the stored HTML or semantic values. */
export const INTERACTIVE_FIGURE_CONTRAST = String.raw`(function(){
  const saved=new Map(); let timer=0;
  function rgb(value){const m=String(value).match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);return m?[Number(m[1]),Number(m[2]),Number(m[3]),m[4]===undefined?1:Number(m[4])]:null}
  function lum(c){const a=c.slice(0,3).map(v=>{v=Math.max(0,Math.min(255,v))/255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*a[0]+.7152*a[1]+.0722*a[2]}
  function ratio(a,b){const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
  function background(node){for(let n=node;n;n=n.parentElement){const c=rgb(getComputedStyle(n).backgroundColor);if(c&&c[3]>=.99)return c}return null}
  function restore(node,entry){if(node.style.getPropertyValue(entry.prop)===entry.applied){if(entry.value)node.style.setProperty(entry.prop,entry.value,entry.priority);else node.style.removeProperty(entry.prop)}}
  function run(){timer=0;const dark=document.documentElement.dataset.theme==='dark';
    for(const [node,entry] of saved){if(!dark||!node.isConnected){restore(node,entry);saved.delete(node)}}
    if(!dark)return;
    const nodes=document.querySelectorAll('[data-figure-theme-aware="true"] p,[data-figure-theme-aware="true"] span,[data-figure-theme-aware="true"] div,[data-figure-theme-aware="true"] label,[data-figure-theme-aware="true"] strong,[data-figure-theme-aware="true"] h1,[data-figure-theme-aware="true"] h2,[data-figure-theme-aware="true"] h3,[data-figure-theme-aware="true"] output,[data-figure-theme-aware="true"] svg text');
    for(const node of Array.from(nodes).slice(0,800)){
      if(!Array.from(node.childNodes).some(n=>n.nodeType===3&&n.nodeValue.trim()))continue;
      const prop=node.namespaceURI==='http://www.w3.org/2000/svg'?'fill':'color';
      const prior=saved.get(node);if(prior&&node.style.getPropertyValue(prop)!==prior.applied)saved.delete(node);
      const fg=rgb(getComputedStyle(node).getPropertyValue(prop)),bg=background(node);
      if(prior&&bg&&lum(bg)>.25){restore(node,prior);saved.delete(node);continue}
      if(!fg||fg[3]<.99||!bg||lum(bg)>.25||ratio(fg,bg)>=4.5)continue;
      let next=fg;for(let i=1;i<=20;i++){const t=i/20;next=fg.slice(0,3).map(v=>Math.round(v+(255-v)*t));if(ratio(next,bg)>=4.5)break}
      const entry=saved.get(node)||{prop,value:node.style.getPropertyValue(prop),priority:node.style.getPropertyPriority(prop),applied:''};
      node.style.setProperty(prop,'rgb('+next.join(', ')+')','important');entry.applied=node.style.getPropertyValue(prop);saved.set(node,entry);
    }
  }
  function schedule(){if(!timer)timer=setTimeout(run,180)}
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  new MutationObserver(()=>{if(document.documentElement.dataset.theme==='dark')schedule()}).observe(document.body,{subtree:true,childList:true,characterData:true});
  schedule();
})();`;
