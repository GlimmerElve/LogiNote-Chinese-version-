import type {NoteItem} from '../../types';
import {inspectResource,validImage} from '../../../apps/community-api/src/resourceFormat';
import type { SharedProgressiveTeaching } from '../progressiveLearning/types';
import { sharedTeachingMarkdown, sharedTeachingBody } from '../progressiveLearning/share';
import { readTextbookBody } from '../textbook/noteContent';
export type SnapshotAsset={key:string;name:string;mime:string;bytes:Uint8Array};
export function exportCommunitySnapshot(note:NoteItem,teaching?:SharedProgressiveTeaching|null){
  const assets:SnapshotAsset[]=[];
  const textbook=note.textbook?readTextbookBody(note.content,note.textbook):undefined;
  if(note.textbook&&textbook===null)throw Error('教材边界异常，未把私人笔记作为教材分享。');
  let body=(teaching?sharedTeachingMarkdown(teaching):textbook!==undefined?sharedTeachingBody(textbook!):note.content).replace(/@due\(\d{4}-\d{2}-\d{2}\)/g,'').replace(/<!--\s*plan-task:[\s\S]*?-->/g,'').replace(/^([\s>*-]*)\[[xX]\]/gm,'$1[ ]');
  if(/(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(body))throw Error('所选正文含疑似密钥，请检查后再分享。');
  body=body.replace(/!\[([^\]]*)\]\(data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)\)/g,(_match,alt:string,extension:string,base64:string)=>{
    const bytes=Uint8Array.from(atob(base64),char=>char.charCodeAt(0)),mime=`image/${extension}`,key='snapshot_image_'+(assets.length+1);if(bytes.length>2*1024*1024||!validImage(bytes,mime))throw Error('快照图片须为 2 MB 以内的 PNG、JPEG 或 WebP。');assets.push({key,name:key+'.'+(extension==='jpeg'?'jpg':extension),mime,bytes});return `![${alt}](attachment:${key})`;
  }).replace(/!\[([^\]]*)\]\(https?:\/\/[^)]+\)/g,(_match,alt:string)=>`（外部图片：${alt}）`).replace(/\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,(_match,target:string,alias:string|undefined)=>alias||target);
  if(assets.length>7)throw Error('单篇快照最多包含 7 张图片。');inspectResource(new TextEncoder().encode(body),'snapshot.md','text/markdown');
  return {title:note.title,body,assets};
}
