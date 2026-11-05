import type {UploadedDocument} from '../types';
import {ensureLlmSettingsLoaded} from './llmStorage';
import {callLLM,resolveProvider} from './llmService';
import {getKnowledgeSettings} from './knowledgeRagClient';
import {prepareDocumentArgumentV5,commitDocumentArgumentV5,recallDocumentArgumentV5Bridges,recordDocumentArgumentV5Response} from './documentRagClient';
import {documentArgumentV5NeedsWork,runDocumentArgumentV5Batch} from './documentArgumentV5Pipeline';
import {rebuildDocumentAndArguments} from './documentRebuildCoordinator';
import {retryDocument,listDocuments,subscribeDocumentChanges,resetDocumentArgumentGraph,documentProcessingContext} from './documentRagClient';
import { canProcessDocumentArgument } from './documentProcessingActions';

// Retry receipts stay in memory; separate response diagnostics never include credentials.
let receiptKey='',receipts=new Map<string,string>(),running=false;
const local=(url:string)=>{try{return ['localhost','127.0.0.1','::1','[::1]'].includes(new URL(url).hostname);}catch{return false;}};
export async function processNextDocumentGraphBatch(documents:UploadedDocument[],progress:(text:string)=>void,signal?:AbortSignal,options:{retryReview?:boolean;processingContext?:string}={}){
  if(running)throw new Error('资料图谱批次正在运行');running=true;
  try{
    await ensureLlmSettingsLoaded();const provider=resolveProvider('document-knowledge-extract');
    if(!provider)throw new Error('请先配置资料论证抽取模型');const captured=structuredClone(provider);
    const settings=await getKnowledgeSettings();
    const guard=async()=>{
      if(signal?.aborted)throw new DOMException('已停止；已保存批次不受影响','AbortError');
      if(options.processingContext!==undefined&&options.processingContext!==await documentProcessingContext())throw new Error('资料库环境变化，后台论证任务已停止');
      const now=await getKnowledgeSettings();
      if(!now.enabled||now.processingMode!==settings.processingMode)throw new Error('知识层权限已变化，已停止本批');
      if(now.processingMode==='local-only'&&(captured.apiType!=='ollama'||!local(captured.baseUrl)))throw new Error('仅本地模式不会发送资料到云端，请检查模型配置');
      if(JSON.stringify(resolveProvider('document-knowledge-extract'))!==JSON.stringify(captured))throw new Error('模型配置变化，已停止本批');
    };
    await guard();
    for(const doc of documents.filter(canProcessDocumentArgument)){
      const source=await prepareDocumentArgumentV5(doc.id);if(!documentArgumentV5NeedsWork(source))continue;
      const key=JSON.stringify([doc.id,source.sourceFingerprint,source.windowPlanFingerprint,source.previousRevision,source.environmentId,captured]);
      if(key!==receiptKey){receiptKey=key;receipts=new Map();}
      const recordResponse=(stage:'extract'|'bridge',raw:string,error?:string,requestText?:string)=>recordDocumentArgumentV5Response({
        docId:source.docId,sourceFingerprint:source.sourceFingerprint,windowPlanFingerprint:source.windowPlanFingerprint,
        promptHash:source.promptHash,previousRevision:source.previousRevision,stage,raw,error:error?.slice(0,10000),requestText,
      },source.environmentId!);
      const result=await runDocumentArgumentV5Batch(source,{
        prepare:prepareDocumentArgumentV5,commit:input=>commitDocumentArgumentV5(input,source.environmentId!),
        recall:input=>recallDocumentArgumentV5Bridges(input,source.environmentId!),guard,recordResponse,
        call:async(stage,prompt,input)=>{
          const response=await callLLM({providerId:captured.id,model:captured.selectedModel,workflow:'document-knowledge-extract',
            systemPromptOverride:prompt,userInput:JSON.stringify(input),maxTokensOverride:65536,
            temperatureOverride:0,timeoutMsOverride:stage==='extract'?900000:600000,
            skipMemoryInjection:true,skipProfileInjection:true,thinkingMode:stage==='extract'?'enabled':'disabled'}, {providerSnapshot:captured,signal});
          const finish=response.diagnostics?.finishReason;
          if(finish&&!['stop','end_turn','STOP','eos'].includes(finish))throw new Error(`模型未完整结束（${finish}），本批未保存`);
          if(!response.content?.trim())throw new Error('模型返回为空，本批未保存');return response.content;
        },
      },stage=>progress(`${doc.fileName}：${stage}`),receipts,options);
      return {...result,fileName:doc.fileName};
    }
    return {completed:0,total:0,done:0,requests:0,fileName:'',nodes:0,components:0,bridgePending:false,warning:''};
  }finally{running=false;}
}

export async function rebuildCompleteDocumentGraph(docId:string,progress:(text:string)=>void,signal?:AbortSignal,
  action:'all'|'regenerate'|'continue'='all',processingContext?:string){
  await ensureLlmSettingsLoaded();
  const provider=resolveProvider('document-knowledge-extract'),settings=await getKnowledgeSettings();
  if(!settings.enabled)throw new Error('请先选择“本机模型”或“云端模型”，再生成论证图。正文索引不需要此设置。');
  if(!provider)throw new Error('请先配置“资料·论证结构 v5.0”的模型。');
  if(settings.processingMode==='local-only'&&(provider.apiType!=='ollama'||!local(provider.baseUrl)))throw new Error('本机模型模式需要本机 Ollama；使用 DeepSeek 等云端模型请选择“云端模型”。');
  const pinned=JSON.stringify(provider);
  let firstBatch=true;
  return rebuildDocumentAndArguments(docId,{
    guard:async()=>{const now=await getKnowledgeSettings();if(processingContext!==undefined&&processingContext!==await documentProcessingContext())throw new Error('资料库环境变化，后台论证任务已停止');if(!now.enabled||now.processingMode!==settings.processingMode||JSON.stringify(resolveProvider('document-knowledge-extract'))!==pinned)throw new Error('模型配置或处理模式变化，已停止整份资料重建。');},
    retry:retryDocument,resetGraph:resetDocumentArgumentGraph,list:listDocuments,subscribe:subscribeDocumentChanges,
    process:doc=>{const retryReview=action==='continue'&&firstBatch;firstBatch=false;return processNextDocumentGraphBatch([doc],progress,signal,{retryReview,processingContext});},
  },progress,signal,{rebuildBody:action==='all',resetGraph:action!=='continue'});
}
