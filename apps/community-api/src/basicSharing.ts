export type BasicDelivery={kind:'snapshot'|'file'|'link'|'video-link'|'package'|'unsupported';url?:string};
export function publicResourceUrl(value:string):string|null{
  if(/[\u0000-\u001f\u007f]/.test(value))return null;
  try{const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');const local=/^(localhost|.*\.localhost|.*\.local)$/.test(host)||/^127\.|^10\.|^0\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)||host.startsWith('[');return ['http:','https:'].includes(url.protocol)&&!!host&&!local&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function basicResourceDelivery(value:{body:string;resourceType?:string|null;preview:{format:string};files:{name:string;role:string}[]}):BasicDelivery{
  const main=value.files.find(file=>file.role==='main');
  if(['scene-pack','h5p'].includes(value.preview.format)||main&&/\.h5p$/i.test(main.name))return {kind:'package'};
  if(['notes','plan'].includes(value.preview.format)||main&&/\.(lnresource|lnsnapshot|mp4|webm|mov|mkv|avi)$/i.test(main.name)||['route','exercise'].includes(value.resourceType||''))return {kind:'unsupported'};
  if(main)return {kind:value.preview.format==='markdown'?'snapshot':'file'};
  const body=value.body.trim(),markdown=body.match(/^\[[^\]]+\]\((https?:\/\/[^\s)]+)\)$/),candidate=markdown?.[1]||(/^https?:\/\/\S+$/.test(body)?body:value.resourceType==='link'?body.match(/https?:\/\/[^\s<>\])]+/)?.[0]:undefined),url=candidate&&publicResourceUrl(candidate);
  if(url){const parsed=new URL(url),video=/(^|\.)(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|vimeo\.com|youku\.com|ixigua\.com)$/.test(parsed.hostname)||/\.(mp4|webm|mov)$/i.test(parsed.pathname);return {kind:video?'video-link':'link',url};}
  return {kind:'snapshot'};
}
