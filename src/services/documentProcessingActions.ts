import type {UploadedDocument} from '../types';

export type DocumentProcessingAction='generate'|'regenerate'|'body'|'all';
export const DOCUMENT_PROCESSING_LABELS:Record<DocumentProcessingAction,string>={
  generate:'生成论证图',regenerate:'重新生成论证图',body:'重建正文索引',all:'全部重建',
};
export const canProcessDocumentArgument = (doc: UploadedDocument) => doc.indexable
  && (doc.parseStatus === 'ready' || (doc.status === 'ready' && doc.parseStatus === undefined));
export function documentGraphAction(doc:UploadedDocument){
  const g=doc.documentGraphProgress;
  if(!canProcessDocumentArgument(doc))return {label:'等待原文解析',action:null,view:false};
  if(g?.stale)return {label:'重新生成论证图',action:'regenerate' as const,view:false};
  if(!g||g.version!=='v5.0')return {label:'生成论证图',action:'generate' as const,view:false};
  if(g.published&&!g.rebuilding&&g.completedWindows>=g.totalWindows&&!g.publicationPending)
    return {label:'查看论证图',action:null,view:true};
  if(g.rebuilding||g.completedWindows<g.totalWindows||g.bridgePending||g.publicationPending)
    return {label:'继续生成论证图',action:'generate' as const,view:g.nodes>0||!!g.published};
  return {label:'查看论证图',action:null,view:true};
}
export function documentGraphStatus(doc:UploadedDocument){
  const g=doc.documentGraphProgress;
  if(g?.stale)return '论证图：待更新（正文版本变化或图文件不可读）';
  if(!g||g.version!=='v5.0')return '论证图：未生成'+(doc.knowledgeArgumentCount?'（保留旧版索引）':'');
  return `论证图：${g.rebuilding?'重建中':g.completedWindows<g.totalWindows?'部分完成':g.published&&(g.bridgeReviewRequired||g.bridgePending)?'已生成（有待核对问题）':g.bridgeReviewRequired?'待语义确认':g.bridgePending?'待局部补链':g.publicationPending?'待发布':'已完成'} · ${g.completedWindows}/${g.totalWindows}段 · ${g.nodes}节点${g.rebuilding&&g.published?' · 旧版仍可检索':''}`;
}
export function documentProcessingDescription(action:DocumentProcessingAction,mode:'local-only'|'allow-cloud'){
  if(action==='body')return '仅在本地重新解析、预处理、正文分块和向量化，不调用论证抽取模型。成功后整套覆盖该资料原有正文分块及向量，不追加第二份。正文版本变化时，旧论证图标为待更新，不与新版正文混用。';
  const model=mode==='allow-cloud'?'云端模型':'本机 Ollama 模型';
  const prefix=action==='all'?'先重新解析并建立正文索引，再':action==='regenerate'?'复用当前预处理正文，重新':'复用当前预处理正文，生成或继续';
  return `${prefix}分批生成整份论证图。使用${model}，每批提供本资料正文及必要的前文交接节点。可停止并继续，无自动重试。关系校验仅记录告警，不阻止生成；全文处理并保存后覆盖旧图及其论证块、向量，清理旧版论证索引，仅一份生效。不表示论证已证实。请求或存储失败不先删除旧图。${action==='all'?'正文分块及向量也整套覆盖。':''}`;
}
