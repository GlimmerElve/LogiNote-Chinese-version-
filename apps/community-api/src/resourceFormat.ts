import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {MAX_RESOURCE_FILE_BYTES,FILE_TOO_LARGE_MESSAGE} from './uploadLimits.js';
import type {ScenePackageSummary} from './scenePackageTypes.js';

export const RESOURCE_PACKAGE_FORMAT='loginote-resource';
export const RESOURCE_PACKAGE_VERSION=1;
export const MAX_RESOURCE_BYTES=MAX_RESOURCE_FILE_BYTES;
const MAX_PACKAGE_BYTES=10*1024*1024;
const MAX_EXPANDED_BYTES=20*1024*1024;
export type PackageNote={id:string;title:string;noteType:'project'|'knowledge';file:string;parentId?:string;links:string[];externalLinks:string[];tags:string[]};
export type PackagePlanNode={id:string;title:string;parentId?:string;minutes:number;dependencyIds:string[]};
export type ResourceManifest={format:typeof RESOURCE_PACKAGE_FORMAT;version:1;kind:'notes'|'plan';title:string;contentVersion:string;license:string;notes:PackageNote[];assets:{file:string;mime:'image/png'|'image/jpeg'|'image/webp';bytes:number}[];plan:PackagePlanNode[]};
export type ResourcePreview={format:'pdf'|'markdown'|'notes'|'plan'|'file'|'scene-pack'|'h5p';title:string;units:number;items:{id:string;title:string;parentId?:string;body?:string;minutes?:number}[];manifest?:ResourceManifest;scenePackage?:ScenePackageSummary};
function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const record=(value:unknown):Record<string,unknown>=>{check(!!value&&typeof value==='object'&&!Array.isArray(value),'资源清单格式不正确。');return value as Record<string,unknown>;};
function keys(value:Record<string,unknown>,allowed:string[]){check(Object.keys(value).every(key=>allowed.includes(key)),'资源包含未允许的字段，请通过 LogiNote 的分享入口重新导出。');}
function text(value:unknown,max=160){check(typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value),'资源文字格式不正确。');return value.trim();}
function id(value:unknown){const result=text(value,100);check(/^[a-zA-Z0-9_-]+$/.test(result),'资源条目标识不正确。');return result;}
function strings(value:unknown,max=50){check(Array.isArray(value)&&value.length<=max,'资源列表过长或格式不正确。');return value.map(item=>text(item,160));}
function safeBody(value:string){check(value.length<=500_000&&!value.includes('\0'),'资源正文过大或损坏。');check(!/(?:file:\/\/|(?:^|[\s("'=])[A-Z]:[\\/]|\\\\[^\s\\]+\\)/i.test(value),'正文包含本机文件路径，请移除或改为包内图片。');return value;}
function hierarchy(items:{id:string;parentId?:string}[]){const map=new Map(items.map(item=>[item.id,item]));check(map.size===items.length,'资源条目标识重复。');for(const item of items){const visited=new Set([item.id]);let parent=item.parentId;while(parent){check(map.has(parent)&&!visited.has(parent),'资源目录包含缺失父级或循环。');visited.add(parent);parent=map.get(parent)!.parentId;}}}
export function validateResourceManifest(value:unknown):ResourceManifest{
  const m=record(value);keys(m,['format','version','kind','title','contentVersion','license','notes','assets','plan']);
  check(m.format===RESOURCE_PACKAGE_FORMAT&&m.version===1&&['notes','plan'].includes(String(m.kind)),'不是受支持的 LogiNote 标准资源包。');
  check(Array.isArray(m.notes)&&m.notes.length<=100&&Array.isArray(m.assets)&&m.assets.length<=40&&Array.isArray(m.plan)&&m.plan.length<=200,'资源包条目超限。');
  const notes=m.notes.map(value=>{const n=record(value);keys(n,['id','title','noteType','file','parentId','links','externalLinks','tags']);const key=id(n.id);check(n.file===`notes/${key}.md`&&['project','knowledge'].includes(String(n.noteType)),'笔记文件或类型不正确。');return {id:key,title:text(n.title),noteType:n.noteType as PackageNote['noteType'],file:n.file as string,...(n.parentId?{parentId:id(n.parentId)}:{}),links:strings(n.links).map(id),externalLinks:strings(n.externalLinks),tags:strings(n.tags,12)};});
  hierarchy(notes);const noteIds=new Set(notes.map(note=>note.id));for(const note of notes)check(note.links.every(link=>noteIds.has(link)),'包内引用指向未包含的笔记。');
  const assets=m.assets.map(value=>{const a=record(value);keys(a,['file','mime','bytes']);check(typeof a.file==='string'&&/^assets\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(a.file)&&['image/png','image/jpeg','image/webp'].includes(String(a.mime))&&Number.isSafeInteger(a.bytes)&&Number(a.bytes)>0&&Number(a.bytes)<=2*1024*1024,'资源图片格式或大小不正确。');return {file:a.file,mime:a.mime as ResourceManifest['assets'][number]['mime'],bytes:Number(a.bytes)};});
  check(new Set(assets.map(asset=>asset.file)).size===assets.length,'资源图片重复。');
  const plan=m.plan.map(value=>{const p=record(value);keys(p,['id','title','parentId','minutes','dependencyIds']);check(Number.isInteger(p.minutes)&&Number(p.minutes)>=5&&Number(p.minutes)<=10080,'计划预计时长不正确。');return {id:id(p.id),title:text(p.title),...(p.parentId?{parentId:id(p.parentId)}:{}),minutes:Number(p.minutes),dependencyIds:strings(p.dependencyIds).map(id)};});
  hierarchy(plan);const byId=new Map(plan.map(item=>[item.id,item]));const done=new Set<string>(),visiting=new Set<string>();const visit=(key:string)=>{check(byId.has(key)&&!visiting.has(key),'计划依赖缺失或循环。');if(done.has(key))return;visiting.add(key);for(const dependency of byId.get(key)!.dependencyIds)visit(dependency);visiting.delete(key);done.add(key);};for(const item of plan)visit(item.id);
  check(m.kind==='notes'?notes.length>0&&plan.length===0:plan.length>0,'资源包内容为空或类型不匹配。');
  return {format:RESOURCE_PACKAGE_FORMAT,version:1,kind:m.kind as 'notes'|'plan',title:text(m.title),contentVersion:text(m.contentVersion,80),license:text(m.license,200),notes,assets,plan};
}
export function readResourcePackage(bytes:Uint8Array):{manifest:ResourceManifest;files:Record<string,Uint8Array>;preview:ResourcePreview}{
  check(bytes.byteLength>0&&bytes.byteLength<=MAX_PACKAGE_BYTES,'组合资源包不能超过 10 MB。');
  let total=0;const seen=new Set<string>();let files:Record<string,Uint8Array>;
  try{files=unzipSync(bytes,{filter:file=>{check(!seen.has(file.name)&&/^(manifest\.json|notes\/[a-zA-Z0-9_-]+\.md|assets\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp))$/.test(file.name),'资源包包含重复或越界文件。');seen.add(file.name);total+=file.originalSize;check(seen.size<=141&&file.originalSize<=MAX_EXPANDED_BYTES&&total<=MAX_EXPANDED_BYTES&&[0,8].includes(file.compression),'资源包展开大小、条目数或压缩方式不受支持。');return true;}});}catch(error){throw new Error(error instanceof Error?error.message:'资源包损坏。');}
  check(files['manifest.json']&&files['manifest.json'].length<=256*1024,'资源包缺少有效清单。');let value:unknown;try{value=JSON.parse(strFromU8(files['manifest.json']));}catch{throw new Error('资源清单无法解析。');}
  const manifest=validateResourceManifest(value),expected=new Set(['manifest.json',...manifest.notes.map(note=>note.file),...manifest.assets.map(asset=>asset.file)]);
  check(Object.keys(files).length===expected.size&&Object.keys(files).every(name=>expected.has(name)),'资源包文件与目录清单不一致。');
  for(const asset of manifest.assets){const data=files[asset.file];check(data&&data.byteLength===asset.bytes,'图片大小与清单不一致。');check(validImage(data,asset.mime),'资源图片内容与格式不一致。');}
  const noteItems=manifest.notes.map(note=>{const data=files[note.file];check(data,'资源包缺少笔记正文。');const body=safeBody(strFromU8(data));for(const match of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g))check(manifest.assets.some(asset=>match[1]===asset.file||match[1]===`../${asset.file}`),'笔记图片未包含在资源包中。');return {id:note.id,title:note.title,...(note.parentId?{parentId:note.parentId}:{}),body};});
  const items=manifest.kind==='notes'?noteItems:manifest.plan.map(item=>({id:item.id,title:item.title,...(item.parentId?{parentId:item.parentId}:{}),minutes:item.minutes}));
  return {manifest,files,preview:{format:manifest.kind,title:manifest.title,units:items.length,items,manifest}};
}
export function createResourcePackage(manifest:ResourceManifest,files:Record<string,Uint8Array>):Uint8Array{
  const checked=validateResourceManifest(manifest),encoded=zipSync({...files,'manifest.json':strToU8(JSON.stringify(checked))},{level:6});readResourcePackage(encoded);return encoded;
}
export function validImage(bytes:Uint8Array,mime:string){return mime==='image/png'?bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:mime==='image/webp'?strFromU8(bytes.slice(0,4))==='RIFF'&&strFromU8(bytes.slice(8,12))==='WEBP':false;}
export function inspectResource(bytes:Uint8Array,name:string,mime:string):ResourcePreview{
  check(bytes.byteLength>0&&bytes.byteLength<=MAX_RESOURCE_BYTES,FILE_TOO_LARGE_MESSAGE);const extension=name.toLowerCase().split('.').at(-1);
  if(extension==='lnresource')return readResourcePackage(bytes).preview;
  if(extension==='pdf'){check(strFromU8(bytes.slice(0,5))==='%PDF-','PDF 文件内容与扩展名不一致。');return {format:'pdf',title:name,units:1,items:[]};}
  if(extension==='md'||extension==='txt'){const body=safeBody(strFromU8(bytes));return {format:'markdown',title:name.replace(/\.(md|txt)$/i,''),units:1,items:[{id:'document',title:name,body}]};}
  // The browser only performs size/type preflight. Authoritative package checks
  // are asynchronous and live in the Node-only inspectSharedResource reader.
  if(extension==='h5p'||extension==='zip'){
    check(['application/zip','application/x-zip-compressed','application/x-h5p','application/vnd.h5p','application/octet-stream'].includes(mime),'场景包或 ZIP 的文件类型不正确。');
    return {format:'file',title:name,units:1,items:[]};
  }
  check(['pdf','application/pdf','text/markdown','text/plain','application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(mime)||mime.startsWith('image/')||['application/zip','application/octet-stream'].includes(mime),'当前不支持这种资源文件。');
  if(mime.startsWith('image/'))check(validImage(bytes,mime),'图片内容与格式不一致。');
  return {format:'file',title:name,units:1,items:[]};
}
