import {registerTool} from '../toolRegistry';
import {canonicalAgentValue} from '../approvalBinding';
import {documentBackgroundJobs,documentJobResumeSnapshot,resumeDocumentGraphBackgroundJob} from '../../documentBackgroundJobs';
import {documentJobActive} from '../../documentBackgroundQueue';

export function registerDocumentJobRecoveryTools(){
  const previews=new Map<string,{title:string;cloud:boolean;model:string}>();
  registerTool({name:'resume_document_job',description:'经确认继续失败、取消或重启中断的资料论证任务。必须使用查询返回的原 jobId；保留已保存批次及旧图，从模块检查点继续，不重新解析或清空重建。先核对资料库、原资料和模型配置，页面切换不改目标。allowCloud 仅在用户明确同意云端处理时为 true；未保存的请求可能需要重新消耗，不能保证零重复 token。',
    parameters:{type:'object',required:['jobId'],additionalProperties:false,properties:{jobId:{type:'string'},allowCloud:{type:'boolean'}}},
    location:'renderer',permission:'write',requiresConfirmation:true,
    approvalSnapshot:async args=>{
      if(typeof args.jobId!=='string'||args.allowCloud!==undefined&&typeof args.allowCloud!=='boolean')throw new Error('请提供真实任务 ID 和明确的云端许可');
      const state=await documentJobResumeSnapshot(args.jobId,args.allowCloud===true);
      if(previews.size>128)previews.clear();
      previews.set(canonicalAgentValue(args),{title:state.doc.fileName,cloud:state.settings.processingMode==='allow-cloud',model:state.provider!.selectedModel});
      // Provider/permission are hashed by the approval layer, not returned as tool output or persisted credentials.
      return state;
    },
    confirmation:args=>{
      const preview=previews.get(canonicalAgentValue(args));
      return {title:`继续资料任务《${preview?.title||args.jobId}》`,description:`任务 ${args.jobId}；${preview?.cloud?'云端模型':'本机模型'} ${preview?.model||''}。继续已保存批次之后的工作，不清空旧图。`,
        impacts:['可能重新发送上次未保存或待复核的批次并产生模型用量；没有自动重试。','保留原资料、旧图与已保存批次；切换后的笔记不会变成任务目标。']};
    },
    execute:async args=>{const job=await resumeDocumentGraphBackgroundJob(String(args.jobId),args.allowCloud===true);return {jobId:job.id,resumeOf:args.jobId,status:job.status,savedBatchesRetained:true,automaticReplay:false};},
  });
  const target=(args:Record<string,unknown>)=>{
    if(typeof args.jobId!=='string'||typeof args.archived!=='boolean')throw new Error('请明确真实资料任务和归档/恢复操作');
    const job=documentBackgroundJobs.getSnapshot().find(item=>item.id===args.jobId);
    if(!job||documentJobActive(job))throw new Error('运行中的资料任务不能直接归档，请先查询或停止');return job;
  };
  registerTool({name:'archive_document_job',description:'确认后归档或恢复资料后台任务记录。archived=true 隐藏已结束任务，false 恢复可见；保留资料、图谱和已保存批次，不调用模型、不自动继续、不永久删除。运行中拒绝归档。',
    parameters:{type:'object',required:['jobId','archived'],additionalProperties:false,properties:{jobId:{type:'string'},archived:{type:'boolean'}}},location:'renderer',permission:'write',requiresConfirmation:true,
    approvalSnapshot:async args=>{await documentBackgroundJobs.ensureReady();return target(args);},
    confirmation:args=>({title:args.archived?'归档资料任务记录（可恢复）':'恢复资料任务记录',description:`只处理任务 ${args.jobId}，不删除资料或图谱，也不开始模型请求。`}),
    execute:async args=>{await documentBackgroundJobs.ensureReady();const before=target(args);const job=documentBackgroundJobs.archive(before.id,args.archived===true);await documentBackgroundJobs.flush();return {jobId:job.id,status:job.archivedAt?'archived':'restored',modelCalled:false,savedBatchesRetained:true};},
  });
}
