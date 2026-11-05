import type {UploadedDocument} from '../types';
import {createDocumentBackgroundQueue,documentJobActive,type DocumentBackgroundAction} from './documentBackgroundQueue';
import {createPersistentDocumentJobs} from './documentJobRuntime';
import {agentTaskScope,loadAgentTaskState,saveAgentTaskState} from './agent/taskStateClient';
import {ensureLlmSettingsLoaded} from './llmStorage';
import {resolveProvider} from './llmService';
import {getKnowledgeSettings} from './knowledgeRagClient';
import {documentProcessingContext,listDocuments} from './documentRagClient';
import {canProcessDocumentArgument} from './documentProcessingActions';
import {rendererExitPreparation} from './ui/applicationExit';
import {processNextDocumentGraphBatch,rebuildCompleteDocumentGraph} from './documentGraphExtractionService';

const syntheticQueue=createDocumentBackgroundQueue();
export const documentBackgroundJobs=typeof window==='undefined'?{...syntheticQueue,ensureReady:async()=> 'synthetic',getScopeId:()=> 'synthetic'}:createPersistentDocumentJobs({
  scope:agentTaskScope,load:async()=>{const loaded=await loadAgentTaskState();return {scopeId:loaded.scopeId,jobs:loaded.state.documents};},
  save:(scopeId,jobs)=>saveAgentTaskState(scopeId,{kind:'documents',jobs}),
});
if(typeof window!=='undefined')void documentBackgroundJobs.ensureReady().catch(error=>console.warn('[document-jobs] restore unavailable:',error));
export const documentJobSourceIdentity=(doc:UploadedDocument)=>JSON.stringify([doc.id,doc.fileName,doc.extension,doc.size,doc.uploadAt]);

export async function documentJobResumeSnapshot(jobId:string,allowCloud:boolean){
  const scopeId=await documentBackgroundJobs.ensureReady();
  const job=documentBackgroundJobs.getSnapshot().find(item=>item.id===jobId);
  if(!job||job.archivedAt||!['failed','cancelled','interrupted'].includes(job.status))throw new Error('请选择未归档、已中断或失败的真实资料任务');
  if(job.scopeId!==scopeId||!job.sourceIdentity)throw new Error('旧任务缺少可靠的资料库或来源绑定，请从资料页重新确认');
  if(documentBackgroundJobs.getSnapshot().some(item=>item.docId===job.docId&&documentJobActive(item)))throw new Error('该资料已有运行中的任务，不会重复提交');
  if(documentBackgroundJobs.getSnapshot().some(item=>item.resumeOf===job.id))throw new Error('此任务已有后续恢复记录，请查询并选择最新恢复任务');
  const doc=(await listDocuments()).find(item=>item.id===job.docId);
  if(!doc||documentJobSourceIdentity(doc)!==job.sourceIdentity)throw new Error('原资料已删除或来源发生变化，请从资料页重新检查');
  if(!canProcessDocumentArgument(doc)||doc.documentGraphProgress?.stale)throw new Error('原文尚未就绪或版本变化，请先在资料页检查；不会自动重建或清空旧图');
  const graph=doc.documentGraphProgress;
  if(graph?.published&&!graph.rebuilding&&graph.completedWindows>=graph.totalWindows&&!graph.bridgePending&&!graph.publicationPending)
    throw new Error('该资料论证图已完成，无需重跑已保存批次；如需重新生成请使用资料页的独立确认入口');
  await ensureLlmSettingsLoaded();
  const provider=resolveProvider('document-knowledge-extract'),settings=await getKnowledgeSettings();
  if(!settings.enabled||!provider)throw new Error('请先选择并配置论证抽取模型');
  if(settings.processingMode==='allow-cloud'&&!allowCloud)throw new Error('继续此任务可能向云端模型发送资料，需要明确同意云端处理');
  return {scopeId,job,doc,provider,settings,context:await documentProcessingContext()};
}
export async function resumeDocumentGraphBackgroundJob(jobId:string,allowCloud:boolean){
  const snapshot=await documentJobResumeSnapshot(jobId,allowCloud);
  // Resume is never regenerate/all: those reset graphs and require a separate workflow.
  return startDocumentGraphBackgroundJob(snapshot.doc,'continue',{resumeOf:jobId,expectedScope:snapshot.scopeId,
    expectedConfiguration:JSON.stringify([snapshot.provider,snapshot.settings]),expectedContext:snapshot.context});
}
export async function startDocumentGraphBackgroundJob(doc:UploadedDocument,action:DocumentBackgroundAction,options:{resumeOf?:string;expectedScope?:string;expectedConfiguration?:string;expectedContext?:string}={}){
  if(rendererExitPreparation.isStopping())throw new Error('应用正在退出，不再启动新的资料任务');
  doc=structuredClone(doc);
  const scopeId=await documentBackgroundJobs.ensureReady();
  if(options.expectedScope&&scopeId!==options.expectedScope)throw new Error('资料库已变化，请重新确认任务');
  await ensureLlmSettingsLoaded();
  const provider=resolveProvider('document-knowledge-extract'),settings=await getKnowledgeSettings();
  if(options.expectedConfiguration&&options.expectedConfiguration!==JSON.stringify([provider,settings]))throw new Error('模型或权限配置已改变，请重新确认；未开始恢复请求');
  if(!settings.enabled||!provider)throw new Error('请先选择并配置论证抽取模型。');
  if(settings.processingMode==='local-only'){
    let local=false;try{local=['localhost','127.0.0.1','::1','[::1]'].includes(new URL(provider.baseUrl).hostname);}catch{}
    if(provider.apiType!=='ollama'||!local)throw new Error('本机模型模式只能使用本机 Ollama；使用云端模型需先选择云端模式。');
  }
  const context=await documentProcessingContext(),pinned=JSON.stringify(provider),permission=JSON.stringify(settings);
  if(options.expectedContext!==undefined&&options.expectedContext!==context)throw new Error('资料处理环境已改变，请重新确认任务');
  if(rendererExitPreparation.isStopping())throw new Error('应用正在退出，不再启动新的资料任务');
  const job=documentBackgroundJobs.enqueue({docId:doc.id,fileName:doc.fileName,action,scopeId,sourceIdentity:documentJobSourceIdentity(doc),resumeOf:options.resumeOf},async(progress,signal)=>{
    if(context!==await documentProcessingContext()||pinned!==JSON.stringify(resolveProvider('document-knowledge-extract'))
      ||permission!==JSON.stringify(await getKnowledgeSettings()))throw new Error('排队期间资料库、模型或授权配置变化，请重新确认任务。');
    if(action==='next'){
      const result=await processNextDocumentGraphBatch([doc],progress,signal,{processingContext:context});
      progress(`${doc.fileName}：已保存${result.done}/${result.total}段、${result.nodes}节点；本次${result.requests}次请求。${result.warning||'本批处理完成。'}`);
      return result;
    }
    return rebuildCompleteDocumentGraph(doc.id,progress,signal,action,context);
  });
  await documentBackgroundJobs.flush();return job;
}
