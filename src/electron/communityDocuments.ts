import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {UploadedDocument} from '../types';
import {detectDocumentType} from './documentParsers';
import {readManifest,commitDocumentSourceImports,getDocumentsDir,withDocumentSourceSnapshot} from './ragIndex';
export function communityDocumentAdapter(queue:(id:string)=>void,changed:()=>void){
  return {
    async snapshotDocumentIds(isCurrent:()=>boolean){return withDocumentSourceSnapshot(async()=>{
      if(!isCurrent())throw Error('知识库已切换。');
      const documents=(await readManifest(true)).filter(doc=>doc.sourceReadOnly&&doc.communitySource?.kind==='snapshot'&&doc.extension==='.md'),directory=await getDocumentsDir(),ids:string[]=[];
      for(const document of documents){try{const stat=await fs.lstat(path.join(directory,document.id+document.extension));if(!stat.isFile()||stat.isSymbolicLink())throw Error('只读快照文件无效。');ids.push(document.id);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
      if(!isCurrent())throw Error('知识库已切换。');return ids;
    });},
    async importDocument(input:{id:string;name:string;sourcePath:string;bytes:number;hash:string;sourceUrl:string;communitySource?:UploadedDocument['communitySource']},isCurrent:()=>boolean):Promise<{id:string;status:'indexing'|'indexed'|'stored'}>{
      if(!isCurrent())throw Error('知识库已切换。');const previous=(await readManifest()).find(doc=>doc.id===input.id);
      if(previous){const file=path.join(await getDocumentsDir(),previous.id+previous.extension),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||createHash('sha256').update(await fs.readFile(file)).digest('hex')!==input.hash)throw Error('本地资料已修改，未覆盖原文件。');return {id:previous.id,status:previous.status==='ready'?'indexed':previous.status==='pending'||previous.status==='processing'?'indexing':'stored'};}
      const descriptor=detectDocumentType(input.name);if(!descriptor)throw Error('当前资料库不支持此文件，请先保存到电脑后手动处理。');
      const snapshot=input.communitySource?.kind==='snapshot';const document:UploadedDocument={id:input.id,fileName:input.name,fileType:descriptor.fileType,extension:descriptor.extension,indexable:descriptor.indexable&&!snapshot,sourceReadOnly:snapshot,size:input.bytes,status:descriptor.indexable&&!snapshot?'pending':'stored',chunkCount:0,totalChars:0,knowledgeStatus:'disabled',processingPolicy:'body_only',sourceUrl:input.sourceUrl,communitySource:input.communitySource,category:snapshot?'社区快照':'社区下载',uploadAt:new Date().toISOString()};
      await commitDocumentSourceImports([{document,sourcePath:input.sourcePath}],isCurrent,input.hash);if(document.indexable)queue(document.id);changed();return {id:document.id,status:document.indexable?'indexing':'stored'};
    },
    async readSnapshot(id:string,isCurrent:()=>boolean){if(!isCurrent())throw Error('知识库已切换。');const document=(await readManifest()).find(doc=>doc.id===id&&doc.sourceReadOnly&&doc.communitySource?.kind==='snapshot');if(!document||document.extension!=='.md')throw Error('只读快照不存在。');const file=path.join(await getDocumentsDir(),document.id+document.extension),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>20*1024*1024)throw Error('只读快照文件无效。');const body=await fs.readFile(file,'utf8');if(!isCurrent())throw Error('知识库已切换。');return body;},
    async documentStatus(id:string):Promise<'indexing'|'indexed'|'stored'>{const document=(await readManifest()).find(doc=>doc.id===id);return document?.status==='ready'?'indexed':document?.status==='pending'||document?.status==='processing'?'indexing':'stored';},
  };
}
