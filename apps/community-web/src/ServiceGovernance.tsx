import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,Check,ClipboardList,RefreshCw,ShieldCheck} from 'lucide-react';
import {serviceClient,ServiceApiError,type ServiceSession} from './serviceClient';
import './service-governance.css';

type Capability='write'|'send_message'|'create_group';
type Action='restrict_object'|'restore_object'|'restrict_account'|'restore_account'|'no_action';
type Category='copyright'|'harassment'|'knowledge_error'|'serious_risk'|'other';
type SuggestionOutcome='adopted'|'evaluating'|'duplicate'|'declined';
type Priority='normal'|'urgent';
type Target={targetType:'object'|'account';targetId:string;label?:string};
type Report={id:string;kind:'report'|'suggestion';category:Category;priority:Priority;nextFeedbackAt:string|null;targetType:Target['targetType'];targetId:string;status:string;version:number;createdAt:string;body?:string;assigneeAccountId?:string|null};
type Decision={id:string;action:Action;reason:string;capabilities:Capability[];expiresAt:string|null;createdAt:string};
type Appeal={id:string;decisionId:string;status:string;reviewReason:string|null;body?:string};
type SuggestionFeedback={id:string;outcome:SuggestionOutcome;reason:string;releaseVersion:string|null;createdAt:string};
type Detail=Report&{decisions:Decision[];appeals:Appeal[];suggestionFeedback?:SuggestionFeedback[]};
type Evidence={body:string;evidence:{id:string;body:string}[];appeals:{id:string;decisionId:string;body:string;status:string}[]};
type Audit={id:string;actorId:string;eventType:string;metadata:Record<string,unknown>;createdAt:string};
type AdminConfiguration={mail:string;storage:string;globalStorageLimitBytes:number;maxFileBytes:number;maxAccountStorageBytes:number;push:string;ordinaryAlertsDefault:boolean;showUnreadBadges:boolean;replayAfterFocus:boolean};
type GroupLimits={version:number;memberLimit:number;createdGroupLimit:number;joinedGroupLimit:number};
type Notice={kind:'success'|'error';text:string};
const statuses:Record<string,string>={submitted:'待受理',assigned:'核查中',decided:'已处理',appealed:'申诉复核中',closed:'已完成',pending:'待复核',upheld:'维持原处置',restored:'已恢复'};
const actions:Record<Action,string>={restrict_object:'限制内容展示',restore_object:'恢复内容展示',restrict_account:'限制账号操作',restore_account:'恢复账号操作',no_action:'不作处置并说明'};
const capabilities:Record<Capability,string>={write:'发布与修改',send_message:'发送消息',create_group:'创建群'};
const categories:Record<Category,string>={copyright:'版权与授权',harassment:'骚扰与垃圾内容',knowledge_error:'知识错误与学术分歧',serious_risk:'诈骗、泄露或威胁等严重风险',other:'其他问题'};
const suggestionOutcomes:Record<SuggestionOutcome,string>={adopted:'已采纳',evaluating:'待评估',duplicate:'重复建议',declined:'暂不采纳'};
const events:Record<string,string>={'report.submitted':'提交反馈','report.assigned':'分配案件','report.triaged':'调整分级与反馈排期','evidence.read':'读取案件证据','report.decided':'记录处置','appeal.submitted':'提交申诉','appeal.reviewed':'完成复核','suggestion.responded':'反馈建议处理结果'};
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const short=(value:string)=>value.slice(0,8);
const isUuid=(value:string)=>/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const localTime=(value:Date)=>new Date(value.getTime()-value.getTimezoneOffset()*60000).toISOString().slice(0,16);
const feedbackDate=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const shanghaiTime=(value:Date)=>new Date(value.getTime()+8*3600000).toISOString().slice(0,16);

/** Real service records only. No prototype identities or local ticket storage. */
export function ServiceGovernancePage({mode='member',target}:{mode?:'member'|'administrator';target?:Target}){
  const [session,setSession]=useState<ServiceSession>({kind:'guest'}),[sessionLoaded,setSessionLoaded]=useState(false);
  const [tab,setTab]=useState<'feedback'|'mine'|'queue'>(target?'feedback':mode==='administrator'?'queue':'mine');
  const [mine,setMine]=useState<Report[]>([]),[queue,setQueue]=useState<Report[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState<Notice|null>(null);
  const [selected,setSelected]=useState<Detail|null>(null),[adminView,setAdminView]=useState(false),[evidence,setEvidence]=useState<Evidence|null>(null),[audit,setAudit]=useState<Audit[]|null>(null);
  const [configuration,setConfiguration]=useState<AdminConfiguration|null>(null);
  const [kind,setKind]=useState<'report'|'suggestion'>(target?'report':'suggestion'),[category,setCategory]=useState<Category>('other'),[targetType,setTargetType]=useState<Target['targetType']>(target?.targetType||'object'),[targetId,setTargetId]=useState(target?.targetId||''),[body,setBody]=useState(''),[extra,setExtra]=useState(''),[appealBody,setAppealBody]=useState('');
  const retries=useRef(new Map<string,{payload:string;key:string}>());
  const current=session.kind==='authenticated'?session:null,adminReady=current?.role==='administrator'&&current.mfa==='verified';
  const fail=(error:unknown)=>{
    if(error instanceof ServiceApiError&&(error.status===401||error.code==='unauthenticated')){setSession({kind:'guest'});setSelected(null);setEvidence(null);setAudit(null);}
    setNotice({kind:'error',text:error instanceof ServiceApiError?error.message:'请求未能完成，请稍后重试。'});
  };
  useEffect(()=>{
    if(!serviceClient.configured){setSessionLoaded(true);return;}
    const controller=new AbortController();let active=true;
    serviceClient.getSession(controller.signal).then(value=>{if(active)setSession(value);}).catch(error=>{if(active&&!(error instanceof DOMException&&error.name==='AbortError'))fail(error);}).finally(()=>{if(active)setSessionLoaded(true);});
    return()=>{active=false;controller.abort();};
  },[]);
  useEffect(()=>{setTab(target?'feedback':mode==='administrator'?'queue':'mine');setSelected(null);setEvidence(null);setAudit(null);},[mode,target?.targetId]);
  useEffect(()=>{setCategory('other');if(target){setTargetType(target.targetType);setTargetId(target.targetId);setKind('report');}},[target?.targetId,target?.targetType]);
  useEffect(()=>{
    if(!current||tab==='feedback'||tab==='queue'&&!adminReady)return;
    const controller=new AbortController();let active=true;setLoading(true);
    serviceClient.request<Report[]>(tab==='queue'?'/admin/reports':'/me/reports',{authenticated:true,signal:controller.signal}).then(value=>{if(active)(tab==='queue'?setQueue:setMine)(value);}).catch(error=>{if(active&&!(error instanceof DOMException&&error.name==='AbortError'))fail(error);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;controller.abort();};
  },[current?.account.accountId,tab,adminReady]);
  const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setNotice(null);try{await work();}catch(error){fail(error);}finally{setBusy(false);}};
  const mutate=async<T,>(path:string,payload:unknown):Promise<T>=>{
    const encoded=JSON.stringify(payload),previous=retries.current.get(path),attempt=previous?.payload===encoded?previous:{payload:encoded,key:crypto.randomUUID()};
    retries.current.set(path,attempt);
    const result=await serviceClient.request<T>(path,{method:'POST',body:payload,authenticated:true,idempotencyKey:attempt.key});
    retries.current.delete(path);return result;
  };
  const refresh=async()=>{
    if(!current)return;
    if(tab==='queue'&&adminReady)setQueue(await serviceClient.request<Report[]>('/admin/reports',{authenticated:true}));
    else setMine(await serviceClient.request<Report[]>('/me/reports',{authenticated:true}));
  };
  const open=async(id:string,asAdmin=false)=>{
    setEvidence(null);setAudit(null);setAppealBody('');
    const detail=await serviceClient.request<Detail>(`/reports/${id}`,{authenticated:true});setSelected(detail);setAdminView(asAdmin);
  };
  const updated=async(id:string,message:string)=>{setNotice({kind:'success',text:message});await open(id,adminView);await refresh();};
  const changeTab=(next:typeof tab)=>{setTab(next);setSelected(null);setEvidence(null);setAudit(null);setNotice(null);};
  const submit=(event:FormEvent)=>{event.preventDefault();void run(async()=>{
    if(!current)return;
    const linked=targetId.trim(),chosen=target?{targetType:target.targetType,targetId:target.targetId}:linked?{targetType,targetId:linked}:{targetType:'account',targetId:current.account.accountId};
    if(kind==='report'&&!target&&!isUuid(linked)||linked&&!isUuid(linked))throw new ServiceApiError('invalid_request','请填写有效的相关内容或账号标识。');
    const report=await mutate<Report>('/reports',{kind,...chosen,body:body.trim(),...(kind==='report'&&category!=='other'?{category}:{}),...(extra.trim()?{evidence:extra.trim()}:{})});
    setBody('');setExtra('');setCategory('other');setNotice({kind:'success',text:'反馈已提交，可在我的工单查看处理进度。'});setTab('mine');await open(report.id);await refresh();
  });};
  const list=tab==='queue'?queue:mine;
  return <section className="service-governance reading-column" aria-label="服务工单">
    <header className="service-governance-heading"><span>LogiNote 社区</span><h1>{mode==='administrator'?'社区治理':'帮助与反馈'}</h1><p>记录具体问题，查看处理与复核进度。</p></header>
    {mode==='administrator'&&current?.role==='administrator'&&<p><a className="text-button" href="#/news/queue">资讯与投稿审核</a></p>}
    {notice&&<p className={`service-governance-notice ${notice.kind}`} role={notice.kind==='error'?'alert':'status'}>{notice.kind==='success'&&<Check size={16}/>}<span>{notice.text}</span></p>}
    {!serviceClient.configured?<div className="service-governance-card service-governance-empty"><ClipboardList size={26}/><h2>工单服务尚未接入</h2><p>{serviceClient.configuration.kind==='invalid'?serviceClient.configuration.message:'配置社区服务地址后，可以提交反馈并查看处理进度。'}</p></div>:!sessionLoaded?<p role="status">正在读取账号状态…</p>:!current?<div className="service-governance-card service-governance-empty"><h2>登录后提交与查看反馈</h2><p>工单将保存在你的社区账号中。</p><a className="primary" href="#/account">前往登录</a></div>:<>
      <nav className="service-governance-tabs" aria-label="工单操作"><button type="button" aria-current={tab==='feedback'?'page':undefined} disabled={busy} onClick={()=>changeTab('feedback')}>提交反馈</button><button type="button" aria-current={tab==='mine'?'page':undefined} disabled={busy} onClick={()=>changeTab('mine')}>我的工单</button>{current.role==='administrator'&&<button type="button" aria-current={tab==='queue'?'page':undefined} disabled={busy} onClick={()=>changeTab('queue')}><ShieldCheck size={15}/>管理员处理</button>}</nav>
      {tab==='queue'&&adminReady&&<details className="service-governance-optional service-governance-config"><summary>服务通道与默认提醒</summary><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>setConfiguration(await serviceClient.request<AdminConfiguration>('/admin/config',{authenticated:true})))}>读取当前配置</button>{configuration&&<dl><dt>邮件</dt><dd>{configuration.mail==='managed_by_cloudbase'?'由 CloudBase 托管（投递待联调）':configuration.mail==='configured'?'已配置':'未配置'}</dd><dt>私有文件</dt><dd>{configuration.storage==='local_private'?'已配置':'未配置'}</dd><dt>文件额度</dt><dd>单文件 {configuration.maxFileBytes/1048576} MB · 每账号 {configuration.maxAccountStorageBytes/1048576} MB · 全站 {configuration.globalStorageLimitBytes/1048576} MB</dd><dt>推送</dt><dd>{configuration.push==='not_configured'?'未配置':configuration.push}</dd><dt>普通提醒 / 未读标记 / 专注后补发</dt><dd>{[configuration.ordinaryAlertsDefault,configuration.showUnreadBadges,configuration.replayAfterFocus].map(value=>value?'开启':'关闭').join(' / ')}</dd></dl>}</details>}
      {tab==='queue'&&adminReady&&<GroupLimitSettings/>}
      {tab==='queue'&&!adminReady?<div className="service-governance-card"><h2>先完成管理验证</h2><p>平台管理员需通过本次多因素验证，才能分流、查看证据或处理案件。</p><a className="text-button" href="#/account">前往管理验证</a></div>:tab==='feedback'?<form className="service-governance-card service-governance-form" onSubmit={submit}>
        <fieldset className="service-governance-choice"><legend>反馈类型</legend>{(['suggestion','report'] as const).map(value=><label key={value}><input type="radio" name="feedback-kind" checked={kind===value} onChange={()=>setKind(value)} disabled={busy}/>{value==='suggestion'?'建议与体验反馈':'举报具体问题'}</label>)}</fieldset>
        {target?<p className="service-governance-target">相关{target.targetType==='object'?'内容':'账号'}：{target.label||short(target.targetId)}</p>:kind==='report'?<TargetFields type={targetType} id={targetId} onType={setTargetType} onId={setTargetId} disabled={busy}/>:<details className="service-governance-optional"><summary>关联内容或账号（可选）</summary><TargetFields type={targetType} id={targetId} onType={setTargetType} onId={setTargetId} disabled={busy}/></details>}
        <label>反馈内容<textarea aria-label="服务反馈内容" rows={5} maxLength={8000} required value={body} onChange={event=>setBody(event.target.value)} placeholder="描述遇到的问题，或希望改进的地方…" disabled={busy}/></label>
        <details className="service-governance-optional"><summary>{kind==='report'?'问题类型与补充证据（可选）':'补充证据（可选）'}</summary>{kind==='report'&&<label>问题类型<select aria-label="举报问题类型" value={category} onChange={event=>setCategory(event.target.value as Category)} disabled={busy}>{(Object.keys(categories) as Category[]).map(value=><option key={value} value={value}>{categories[value]}</option>)}</select></label>}<label>补充说明<textarea rows={3} maxLength={16000} value={extra} onChange={event=>setExtra(event.target.value)} placeholder="发生位置、复现方式或相关说明" disabled={busy}/></label></details>
        <button type="submit" className="primary" disabled={busy||!body.trim()||kind==='report'&&!isUuid(target?.targetId||targetId.trim())}>{busy?'正在提交…':'提交反馈'}</button>
      </form>:selected?<section className="service-governance-card service-governance-detail" aria-label="工单详情">
        <button type="button" className="text-button" disabled={busy} onClick={()=>{setSelected(null);setEvidence(null);setAudit(null);}}><ArrowLeft size={15}/>返回工单列表</button>
        <div className="service-governance-detail-heading"><h2>{selected.kind==='suggestion'?'建议与反馈':'举报处理'}</h2><span className="tag">{statuses[selected.status]||selected.status}</span></div>
        <p className="meta">工单 <code title={selected.id}>{short(selected.id)}</code> · {date(selected.createdAt)}</p>
        {selected.status!=='closed'&&<p className="meta">{selected.priority==='urgent'?'优先核查 · ':''}{selected.nextFeedbackAt?'预计下次反馈：'+feedbackDate(selected.nextFeedbackAt)+'（北京时间）':'反馈排期待确认'}</p>}
        {selected.status!=='closed'&&<details className="service-governance-optional"><summary>反馈排期说明</summary><p className="meta">举报默认按 2 个工作日、建议按 5 个工作日安排反馈目标；按北京时间周一至周五计算，节假日与调休需人工调整。这是预计反馈时间，核查进度可能使排期变化。</p></details>}
        {selected.kind==='report'&&<p className="meta">{categories[selected.category]||categories.other}</p>}
        {selected.body&&<p className="service-governance-body">{selected.body}</p>}
        <details className="service-governance-optional"><summary>相关对象</summary><p className="meta">{selected.targetType==='object'?'内容':'账号'}：<code>{selected.targetId}</code></p></details>
        {adminView&&adminReady&&selected.assigneeAccountId===current.account.accountId&&selected.status!=='closed'&&<TriageForm key={`triage:${selected.id}:${selected.version}`} report={selected} busy={busy} onSave={payload=>void run(async()=>{await mutate(`/admin/reports/${selected.id}/triage`,{...payload,expectedVersion:selected.version});await updated(selected.id,'工单分级与反馈排期已更新，并记入审计。');})}/>}
        {adminView&&<div className="service-governance-evidence"><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>{setEvidence(await serviceClient.request<Evidence>(`/admin/reports/${selected.id}/evidence`,{authenticated:true}));})}>查看案件证据（记入审计）</button>{evidence&&<div><h3>反馈与证据</h3><p className="service-governance-body">{evidence.body}</p>{evidence.evidence.map(item=><p className="service-governance-body" key={item.id}>{item.body}</p>)}{evidence.appeals.map(item=><article key={item.id}><h3>申诉说明 · {statuses[item.status]||item.status}</h3><p className="service-governance-body">{item.body}</p></article>)}</div>}</div>}
        {selected.decisions.length>0&&<section aria-label="处理结果"><h3>处理结果</h3>{selected.decisions.map(decision=><article className="service-governance-result" key={decision.id}><strong>{actions[decision.action]}</strong><p className="service-governance-body">{decision.reason}</p>{decision.capabilities.length>0&&<p className="meta">受限操作：{decision.capabilities.map(value=>capabilities[value]).join('、')}</p>}{decision.expiresAt&&<p className="meta">截止：{date(decision.expiresAt)}</p>}</article>)}</section>}
        {!!selected.suggestionFeedback?.length&&<section aria-label="建议处理结果"><h3>建议处理结果</h3>{selected.suggestionFeedback.map(feedback=><article className="service-governance-result" key={feedback.id}><strong>{suggestionOutcomes[feedback.outcome]}</strong><p className="service-governance-body">{feedback.reason}</p><p className="meta">{feedback.releaseVersion?'关联版本：'+feedback.releaseVersion+' · ':''}{date(feedback.createdAt)}</p></article>)}</section>}
        {selected.appeals.map(appeal=><article className="service-governance-result" key={appeal.id}><strong>{statuses[appeal.status]||appeal.status}</strong>{appeal.body&&<p className="service-governance-body">{appeal.body}</p>}{appeal.reviewReason&&<p className="service-governance-body">复核说明：{appeal.reviewReason}</p>}{adminView&&appeal.status==='pending'&&(evidence?<ReviewForm busy={busy} allowRestore={selected.decisions.some(decision=>decision.id===appeal.decisionId&&(decision.action==='restrict_account'||decision.action==='restrict_object'))} onReview={(outcome,reason)=>void run(async()=>{await mutate(`/admin/appeals/${appeal.id}/review`,{outcome,reason});await updated(selected.id,'申诉已复核，相关权限已同步更新。');})}/>:<p className="meta">查看案件证据后可复核申诉。</p>)}</article>)}
        {!adminView&&selected.status==='decided'&&<form className="service-governance-form service-governance-appeal" onSubmit={event=>{event.preventDefault();void run(async()=>{await mutate(`/reports/${selected.id}/appeals`,{body:appealBody.trim()});setAppealBody('');await updated(selected.id,'申诉已提交，复核结果会显示在此处。');});}}><label>申诉说明<textarea aria-label="服务申诉说明" rows={3} maxLength={8000} required value={appealBody} onChange={event=>setAppealBody(event.target.value)} disabled={busy}/></label><button className="primary" type="submit" disabled={busy||!appealBody.trim()}>提交申诉</button></form>}
        {adminView&&<>{selected.kind==='suggestion'?<SuggestionFeedbackForm key={`${selected.id}:${selected.version}`} report={selected} busy={busy} onRespond={payload=>void run(async()=>{await mutate(`/admin/reports/${selected.id}/suggestion-feedback`,{...payload,expectedVersion:selected.version});await updated(selected.id,'建议处理结果已反馈，并记入审计。');})}/>:<DecisionForm key={`${selected.id}:${selected.version}`} report={selected} busy={busy} onDecide={payload=>void run(async()=>{await mutate(`/admin/reports/${selected.id}/decisions`,{...payload,expectedVersion:selected.version});await updated(selected.id,'处理已生效，并记入审计。');})}/>}<details className="service-governance-optional"><summary>审计记录</summary><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>setAudit(await serviceClient.request<Audit[]>(`/admin/reports/${selected.id}/audit`,{authenticated:true})))}>读取审计记录</button>{audit&&<ol className="service-governance-audit">{audit.map(item=><li key={item.id}><strong>{events[item.eventType]||item.eventType}</strong><span>{date(item.createdAt)} · 操作账号 {short(item.actorId)}</span>{item.eventType==='report.triaged'&&<p>{item.metadata.priority==='urgent'?'优先核查':'常规核查'}{typeof item.metadata.nextFeedbackAt==='string'?' · 反馈目标 '+feedbackDate(item.metadata.nextFeedbackAt)+'（北京时间）':''}{typeof item.metadata.reason==='string'?' · '+item.metadata.reason:''}</p>}{typeof item.metadata.action==='string'&&item.metadata.action in actions&&<p>{actions[item.metadata.action as Action]}</p>}{typeof item.metadata.outcome==='string'&&<p>{item.metadata.outcome==='restore'?'恢复相关权限':item.metadata.outcome==='uphold'?'维持原处置':suggestionOutcomes[item.metadata.outcome as SuggestionOutcome]||item.metadata.outcome}</p>}</li>)}</ol>}</details></>}
      </section>:<section aria-label={tab==='queue'?'待处理工单':'我的服务工单'}><div className="service-governance-list-heading"><h2>{tab==='queue'?'待处理工单':'我的工单'}</h2><button type="button" className="text-button" aria-label="刷新工单" disabled={busy||loading} onClick={()=>void run(refresh)}><RefreshCw size={15}/>刷新</button></div>{loading?<p role="status">正在读取工单…</p>:list.length?list.map(report=><article className="service-governance-card service-governance-row" key={report.id}><div><span className="tag">{statuses[report.status]||report.status}</span><h3>{report.kind==='suggestion'?'建议与体验反馈':report.body?'举报反馈':'相关处置'}</h3>{report.body&&<p className="service-governance-excerpt">{report.body}</p>}<p className="meta">{short(report.id)}{report.priority==='urgent'?' · 优先核查':''}{report.nextFeedbackAt&&report.status!=='closed'?' · 预计 '+feedbackDate(report.nextFeedbackAt)+' 反馈':' · '+date(report.createdAt)}</p></div><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>{if(tab==='queue'){if(report.assigneeAccountId!==current.account.accountId)await mutate(`/admin/reports/${report.id}/assign`,{expectedVersion:report.version});await open(report.id,true);await refresh();}else await open(report.id);})}>{tab==='queue'?(report.assigneeAccountId===current.account.accountId?'查看与处理':'接手并查看'):'查看进度'}</button></article>):<div className="service-governance-card service-governance-empty"><ClipboardList size={24}/><p>{tab==='queue'?'当前没有待处理工单。':'还没有工单，可以先提交一条反馈。'}</p></div>}</section>}
    </>}
  </section>;
}

function TriageForm({report,busy,onSave}:{report:Detail;busy:boolean;onSave:(payload:Record<string,unknown>)=>void}){
  const [priority,setPriority]=useState<Priority>(report.priority),[until,setUntil]=useState(''),[reason,setReason]=useState('');
  return <details className="service-governance-optional"><summary>分级与反馈排期</summary><form className="service-governance-form" aria-label="工单分级与反馈排期" onSubmit={event=>{event.preventDefault();const target=until?new Date(until+':00+08:00'):null;if(target&&!Number.isFinite(target.getTime()))return;onSave({priority,...(target?{nextFeedbackAt:target.toISOString()}:{}),...(reason.trim()?{reason:reason.trim()}:{})});}}><label>处理优先级<select aria-label="工单处理优先级" value={priority} onChange={event=>setPriority(event.target.value as Priority)} disabled={busy}><option value="normal">常规核查</option><option value="urgent">优先核查</option></select></label><label>调整下次反馈时间（可选，北京时间）<input type="datetime-local" aria-label="下次反馈时间" value={until} min={shanghaiTime(new Date(Date.now()+60000))} max={shanghaiTime(new Date(Date.now()+365*86400000))} onChange={event=>setUntil(event.target.value)} disabled={busy}/></label><label>排期说明（可选）<input aria-label="反馈排期说明" maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} placeholder="需要调整时，简单说明原因" disabled={busy}/></label><button type="submit" className="primary" disabled={busy||priority===report.priority&&!until&&!reason.trim()}>保存排期</button></form></details>;
}
function TargetFields({type,id,onType,onId,disabled}:{type:Target['targetType'];id:string;onType:(value:Target['targetType'])=>void;onId:(value:string)=>void;disabled:boolean}){
  return <div className="service-governance-target-fields"><label>相关对象<select value={type} onChange={event=>onType(event.target.value as Target['targetType'])} disabled={disabled}><option value="object">内容</option><option value="account">账号</option></select></label><label>对象标识<input aria-label="相关对象标识" value={id} maxLength={36} onChange={event=>onId(event.target.value)} placeholder="相关内容或账号的 UUID" disabled={disabled}/></label></div>;
}
function GroupLimitSettings(){
  const [limits,setLimits]=useState<GroupLimits|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const retry=useRef<{encoded:string;key:string}|null>(null);
  const load=async()=>{setBusy(true);setMessage('');try{setLimits(await serviceClient.request<GroupLimits>('/admin/group-limits',{authenticated:true}));}catch(error){setMessage(error instanceof Error?error.message:'群容量配置读取失败。');}finally{setBusy(false);}};
  const save=async()=>{
    if(!limits||busy)return;setBusy(true);setMessage('');
    const input={expectedVersion:limits.version,memberLimit:limits.memberLimit,createdGroupLimit:limits.createdGroupLimit,joinedGroupLimit:limits.joinedGroupLimit},encoded=JSON.stringify(input);
    if(retry.current?.encoded!==encoded)retry.current={encoded,key:crypto.randomUUID()};
    try{setLimits(await serviceClient.request<GroupLimits>('/admin/group-limits',{method:'PUT',authenticated:true,body:input,idempotencyKey:retry.current.key}));retry.current=null;setMessage('群容量已保存。');}catch(error){setMessage(error instanceof Error?error.message:'群容量保存失败。');}finally{setBusy(false);}
  };
  return <details className="service-governance-optional service-governance-config"><summary>共学群容量与参与上限</summary><button className="text-button" type="button" disabled={busy} onClick={()=>void load()}>{limits?'重新读取配置':'读取当前配置'}</button>{limits&&<form className="service-governance-form service-group-limit-form" onSubmit={event=>{event.preventDefault();void save();}}><div className="service-group-limit-fields">{([['memberLimit','每群成员',2,500],['createdGroupLimit','每人创建活跃群',1,20],['joinedGroupLimit','每人参与或申请群',1,100]] as const).map(([key,label,min,max])=><label key={key}>{label}<input type="number" aria-label={label+'上限'} min={min} max={max} step={1} required value={limits[key]} disabled={busy} onChange={event=>setLimits({...limits,[key]:event.target.valueAsNumber})}/></label>)}</div><p className="meta">降低上限保留已有成员与群，新增加入、创建和转让按新上限检查。</p><button type="submit" className="primary" disabled={busy||!Number.isSafeInteger(limits.memberLimit)||!Number.isSafeInteger(limits.createdGroupLimit)||!Number.isSafeInteger(limits.joinedGroupLimit)||limits.createdGroupLimit>limits.joinedGroupLimit}>{busy?'正在保存…':'保存群容量'}</button></form>}{message&&<p className="meta" role="status">{message}</p>}</details>;
}
function DecisionForm({report,busy,onDecide}:{report:Detail;busy:boolean;onDecide:(payload:Record<string,unknown>)=>void}){
  const latest=report.decisions.at(-1),options:Action[]=report.status==='assigned'?['no_action',...(report.targetType==='object'?['restrict_object' as const]:[]),'restrict_account']:report.status==='decided'&&latest?.action==='restrict_object'?['restore_object']:report.status==='decided'&&latest?.action==='restrict_account'?['restore_account']:[];
  const [action,setAction]=useState<Action>(options[0]||'no_action'),[reason,setReason]=useState(''),[until,setUntil]=useState(''),[caps,setCaps]=useState<Capability[]>(['send_message']);
  if(!options.length)return null;
  const restricted=action==='restrict_object'||action==='restrict_account';
  return <form className="service-governance-form service-governance-decision" aria-label="案件处置" onSubmit={event=>{event.preventDefault();const expires=restricted?new Date(until):null;if(expires&&!Number.isFinite(expires.getTime()))return;onDecide({action,reason:reason.trim(),...(expires?{expiresAt:expires.toISOString()}:{}),...(action==='restrict_account'?{capabilities:caps}:{})});}}><h3>记录处理</h3><label>处理方式<select value={action} onChange={event=>setAction(event.target.value as Action)} disabled={busy}>{options.map(value=><option value={value} key={value}>{actions[value]}</option>)}</select></label>{action==='restrict_account'&&<fieldset className="service-governance-choice"><legend>受限操作</legend>{(Object.keys(capabilities) as Capability[]).map(value=><label key={value}><input type="checkbox" checked={caps.includes(value)} onChange={event=>setCaps(previous=>event.target.checked?[...previous,value]:previous.filter(item=>item!==value))} disabled={busy}/>{capabilities[value]}</label>)}</fieldset>}{restricted&&<label>限制截止时间<input aria-label="限制截止时间" type="datetime-local" required value={until} min={localTime(new Date(Date.now()+60000))} onChange={event=>setUntil(event.target.value)} disabled={busy}/></label>}<label>处理依据与反馈<textarea aria-label="服务处理依据" rows={3} maxLength={4000} required value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/></label><button type="submit" className="primary" disabled={busy||!reason.trim()||restricted&&!until||action==='restrict_account'&&!caps.length}>确认处理</button></form>;
}
function SuggestionFeedbackForm({report,busy,onRespond}:{report:Detail;busy:boolean;onRespond:(payload:Record<string,unknown>)=>void}){
  const [outcome,setOutcome]=useState<SuggestionOutcome>('evaluating'),[reason,setReason]=useState(''),[releaseVersion,setReleaseVersion]=useState('');
  if(!['assigned','decided'].includes(report.status))return null;
  return <form className="service-governance-form service-governance-decision" aria-label="建议反馈" onSubmit={event=>{event.preventDefault();onRespond({outcome,reason:reason.trim(),...(outcome==='adopted'&&releaseVersion.trim()?{releaseVersion:releaseVersion.trim()}:{})});}}><h3>反馈建议</h3><label>处理结果<select aria-label="建议处理结果" value={outcome} onChange={event=>setOutcome(event.target.value as SuggestionOutcome)} disabled={busy}>{(Object.keys(suggestionOutcomes) as SuggestionOutcome[]).map(value=><option key={value} value={value}>{suggestionOutcomes[value]}</option>)}</select></label><label>反馈说明<textarea aria-label="建议反馈说明" rows={3} required maxLength={4000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="说明采纳、评估或暂不采纳的原因…" disabled={busy}/></label>{outcome==='adopted'&&<details className="service-governance-optional"><summary>关联版本（可选）</summary><input aria-label="建议关联版本" maxLength={120} value={releaseVersion} onChange={event=>setReleaseVersion(event.target.value)} placeholder="例如：2026.10.1" disabled={busy}/></details>}<button className="primary" type="submit" disabled={busy||!reason.trim()}>反馈结果</button></form>;
}
function ReviewForm({busy,allowRestore,onReview}:{busy:boolean;allowRestore:boolean;onReview:(outcome:'restore'|'uphold',reason:string)=>void}){
  const [outcome,setOutcome]=useState<'restore'|'uphold'>('uphold'),[reason,setReason]=useState('');
  return <form className="service-governance-form service-governance-review" aria-label="申诉复核" onSubmit={event=>{event.preventDefault();onReview(outcome,reason.trim());}}><label>复核结果<select value={outcome} onChange={event=>setOutcome(event.target.value as 'restore'|'uphold')} disabled={busy}><option value="uphold">维持原处置</option>{allowRestore&&<option value="restore">恢复相关权限</option>}</select></label><label>复核说明<textarea aria-label="服务复核说明" rows={3} required maxLength={4000} value={reason} onChange={event=>setReason(event.target.value)} disabled={busy}/></label><button type="submit" className="primary" disabled={busy||!reason.trim()}>完成复核</button></form>;
}
