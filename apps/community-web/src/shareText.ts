import {resourcePlainText} from './resourceText';

/** Plain text survives pasting into chat apps that do not generate link previews. */
export function formatShareText(title:string|undefined,url:string,body=''){
  const name=(title?.trim()||resourcePlainText(body).split('\n').find(line=>line.trim())||'LogiNote 分享')
    .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return `${name.length>160?name.slice(0,159)+'…':name}\n${url}`;
}
export function entryShareText(entry:{id:string;kind:string;title?:string;body:string;news?:boolean},href=location.href){
  const url=new URL(href);url.search='';url.hash=`/${entry.news?'news':entry.kind==='resource'?'resource':'discussion'}/${entry.id}`;
  return formatShareText(entry.title,url.href,entry.body);
}
