/** Human-readable catalogue text; internal image references never enter summaries. */
export function resourcePlainText(body:string):string {
  return body.replace(/!\[([^\]\n]*)\]\([^)]*\)/g,'')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm,'')
    .replace(/[*_`]/g,'').trim();
}
export function resourceTitle(body:string):string {
  return resourcePlainText(body).split('\n').find(line=>line.trim())?.trim().slice(0,60)||'图文资源';
}
