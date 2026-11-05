import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Check,KeyRound,Mail,ShieldCheck} from 'lucide-react';
import {ServiceApiError,serviceClient,type IdentityProvider,type MfaEnrollment,type ServiceSession} from './serviceClient';
import './service-account.css';

type Mode='login'|'register'|'recover'|'verify'|'reset';
type Notice={kind:'info'|'success'|'error';text:string};
type CodeStep={verificationId:string;expiresAt:string;email:string;purpose:'register'|'reset_password'|'login'};
function mailAction():{mode:'verify'|'reset';token:string}|null {
  const match=/^#\/account\/(verify|reset)~([A-Za-z0-9_-]{43})$/.exec(location.hash);
  return match?{mode:match[1] as 'verify'|'reset',token:match[2]}:null;
}
const deliveryNotice=(delivery:string,action:'verify'|'reset'):Notice=>delivery==='not_configured'?{kind:'info',text:'账号邮件通道尚未配置，邮件未发送。配置完成后可重新发送。'}:{kind:'success',text:action==='verify'?'如需验证此账号，验证链接已提交发送，请查看邮箱。':'如果此邮箱已注册，密码重置链接已提交发送，请查看邮箱。'};

/** This page connects only the real community account; prototype identities stay local. */
export function ServiceAccountPage({onAuthenticated,redirectAuthenticated=false}:{onAuthenticated?:()=>void;redirectAuthenticated?:boolean}){
  const [action,setAction]=useState(mailAction),[mode,setMode]=useState<Mode>(()=>mailAction()?.mode||'login');
  const [session,setSession]=useState<ServiceSession>({kind:'guest'}),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[displayName,setDisplayName]=useState(''),[code,setCode]=useState('');
  const [enrollment,setEnrollment]=useState<MfaEnrollment|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState<Notice|null>(null);
  const [provider,setProvider]=useState<IdentityProvider|null>(null),[loadVersion,setLoadVersion]=useState(0),[loadFailed,setLoadFailed]=useState(false);
  const [codeStep,setCodeStep]=useState<CodeStep|null>(null),[resendAt,setResendAt]=useState(0),[now,setNow]=useState(Date.now);
  const [loginNeedsVerification,setLoginNeedsVerification]=useState(false);
  const codeInput=useRef<HTMLInputElement>(null);
  const cooldowns=useRef(new Map<string,number>());
  const cooldownKey=(value:string)=>value.trim().toLowerCase();
  const configuration=serviceClient.configuration;
  const isCloudBase=provider?.provider==='cloudbase',codeFlow=isCloudBase&&(mode==='register'||mode==='recover'||mode==='login'&&loginNeedsVerification);
  const resendSeconds=Math.max(0,Math.ceil((resendAt-now)/1000));
  const passwordMin=provider?.passwordMinLength??12,passwordMax=provider?.passwordMaxLength??128;
  const acceptSession=(value:ServiceSession)=>{setSession(value);if(isCloudBase&&value.kind==='authenticated'&&value.role==='member')onAuthenticated?.();};
  useEffect(()=>{
    if(action)history.replaceState(history.state,'',`${location.pathname}${location.search}#/account`);
  },[]);
  useEffect(()=>{
    if(!serviceClient.configured)return;
    const controller=new AbortController();let active=true;setBusy(true);setLoadFailed(false);
    Promise.all([serviceClient.getIdentityProvider(controller.signal),serviceClient.getSession(controller.signal)]).then(([identity,value])=>{if(active){setProvider(identity);setSession(value);if(identity.provider==='cloudbase'&&value.kind==='authenticated'&&value.role==='member'&&redirectAuthenticated)onAuthenticated?.();if(identity.provider==='cloudbase'&&action){setAction(null);setMode('login');setNotice({kind:'info',text:'当前账号使用邮箱验证码，请在此登录或找回密码。'});}}}).catch(error=>{if(active&&!(error instanceof DOMException&&error.name==='AbortError')){setLoadFailed(true);setNotice({kind:'error',text:error instanceof Error?error.message:'暂时无法读取账号状态。'});}}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;controller.abort();};
  },[loadVersion]);
  useEffect(()=>{if(resendAt<=Date.now())return;const timer=window.setInterval(()=>{const time=Date.now();setNow(time);if(time>=resendAt)window.clearInterval(timer);},1000);return()=>window.clearInterval(timer);},[resendAt]);
  useEffect(()=>{if(codeStep)codeInput.current?.focus();},[codeStep]);
  const clearCode=()=>{setCodeStep(null);setCode('');};
  const switchMode=(next:Mode)=>{setMode(next);setPassword('');clearCode();setLoginNeedsVerification(false);setResendAt(cooldowns.current.get(cooldownKey(email))||0);setNow(Date.now());setEnrollment(null);setNotice(null);};
  const changeEmail=(value:string)=>{setEmail(value);setResendAt(cooldowns.current.get(cooldownKey(value))||0);setNow(Date.now());setNotice(null);if(codeStep||loginNeedsVerification){clearCode();setLoginNeedsVerification(false);}};
  const run=async(work:()=>Promise<void>)=>{
    if(busy)return;setBusy(true);setNotice(null);
    try{await work();}catch(error){
      if(error instanceof ServiceApiError&&error.code==='unauthenticated'){setSession({kind:'guest'});setEnrollment(null);}
      if(isCloudBase&&mode==='login'&&error instanceof ServiceApiError&&error.code==='email_verification_required'){setLoginNeedsVerification(true);clearCode();setResendAt(cooldowns.current.get(cooldownKey(email))||0);}
      setNotice({kind:'error',text:error instanceof ServiceApiError?error.message:'请求暂时未能完成，请稍后重试。'});
    }finally{setBusy(false);}
  };
  const sendCode=async()=>{
    if(resendSeconds>0)return;
    const purpose=mode==='register'?'register':mode==='login'?'login':'reset_password';
    let result;
    try{result=await serviceClient.sendEmailCode(email,purpose);}
    catch(error){
      if(error instanceof ServiceApiError&&error.status===429){
        const time=Date.now(),until=time+(error.retryAfterSeconds??provider?.resendAfterSeconds??60)*1000;
        cooldowns.current.set(cooldownKey(email),until);setNow(time);setResendAt(until);
      }
      throw error;
    }
    if(result.delivery!=='sent'||!result.verificationId||!result.expiresAt){setNotice({kind:'info',text:'账号邮件通道尚未配置，验证码未发送。'});return;}
    setCode('');setCodeStep({verificationId:result.verificationId,expiresAt:result.expiresAt,email,purpose});
    const sentAt=Date.now(),until=sentAt+result.resendAfterSeconds*1000;cooldowns.current.set(cooldownKey(email),until);setNow(sentAt);setResendAt(until);
    setNotice({kind:'success',text:'验证码已发送，请查看邮箱。'});
  };
  const submit=(event:FormEvent)=>{event.preventDefault();void run(async()=>{
    if(!provider?.configured)throw new ServiceApiError('not_configured','账号认证尚未配置。');
    if(codeFlow){
      if(!codeStep){await sendCode();return;}
      if(codeStep.email!==email||codeStep.purpose!==(mode==='register'?'register':mode==='login'?'login':'reset_password'))throw new ServiceApiError('invalid_request','邮箱已变化，请重新发送验证码。');
      if(Date.parse(codeStep.expiresAt)<=Date.now())throw new ServiceApiError('verification_expired','验证码已过期，请重新发送。');
      const input={email,password,code,verificationId:codeStep.verificationId};
      if(mode==='register'){acceptSession(await serviceClient.registerCloudBase({...input,...(displayName.trim()?{displayName:displayName.trim()}:{})}));setPassword('');clearCode();setNotice({kind:'success',text:'邮箱已验证，已登录社区账号。'});}
      else if(mode==='login'){acceptSession(await serviceClient.login(input));setPassword('');clearCode();setLoginNeedsVerification(false);setNotice({kind:'success',text:'邮箱已验证，已登录社区账号。'});}
      else{await serviceClient.resetPasswordCloudBase(input);setPassword('');clearCode();setMode('login');setSession({kind:'guest'});setNotice({kind:'success',text:'密码已更新，请使用新密码登录。'});}
    }
    else if(mode==='login'){acceptSession(await serviceClient.login({email,password}));setPassword('');setNotice({kind:'success',text:'已登录社区账号。'});}
    else if(mode==='register'){const result=await serviceClient.register({email,password,...(displayName.trim()?{displayName:displayName.trim()}:{})});setPassword('');setNotice(deliveryNotice(result.delivery,'verify'));}
    else if(mode==='recover'){const result=await serviceClient.recover(email);setNotice(deliveryNotice(result.delivery,'reset'));}
    else if(mode==='verify'){
      if(!action||action.mode!=='verify')throw new ServiceApiError('invalid_token','验证链接无效，请重新发送验证邮件。');
      await serviceClient.verifyEmail(action.token);setAction(null);setMode('login');setNotice({kind:'success',text:'邮箱已验证，现在可以登录。'});
    }else{
      if(!action||action.mode!=='reset')throw new ServiceApiError('invalid_token','重置链接无效，请重新申请。');
      await serviceClient.resetPassword(action.token,password);setAction(null);setMode('login');setPassword('');setSession({kind:'guest'});setNotice({kind:'success',text:'密码已更新，原有登录会话已退出。请使用新密码登录。'});
    }
  });};
  const current=session.kind==='authenticated'?session:null;
  return <section className="service-account reading-column">
    <header className="service-account-heading"><span className="service-account-kicker">LogiNote 社区</span><h1>社区账号</h1><p>用邮箱验证身份，在自己的节奏里参与。</p></header>
    <div className="service-account-card">
      {configuration.kind!=='configured'?<div className="service-account-unavailable"><Mail size={25}/><h2>{configuration.kind==='invalid'?'服务地址需要调整':'社区账号服务尚未接入'}</h2><p>{configuration.kind==='invalid'?configuration.message:'配置社区服务地址后，即可使用邮箱注册、验证和登录。'}</p><p className="meta">当前本机原型仍可使用，展示人物与真实账号保持独立。</p></div>:<>
        {notice&&<p className={`service-account-notice ${notice.kind}`} role={notice.kind==='error'?'alert':'status'}>{notice.kind==='success'&&<Check size={16}/>}<span>{notice.text}</span></p>}
        {loadFailed?<div className="service-account-unavailable"><h2>暂时无法读取账号服务</h2><button type="button" className="text-button" disabled={busy} onClick={()=>setLoadVersion(value=>value+1)}>重新连接</button></div>:!provider?<p className="meta" role="status">正在读取账号状态…</p>:!provider.configured?<div className="service-account-unavailable"><Mail size={25}/><h2>账号认证尚未配置</h2><p>{isCloudBase?'CloudBase 账号服务配置完成后，即可使用邮箱注册和登录。':'账号认证服务配置完成后即可使用。'}</p></div>:current&&mode!=='verify'&&mode!=='reset'?<>
          <div className="service-account-signed-in"><span className="service-account-status"><Check size={15}/>已登录</span><h2>{current.account.displayName}</h2>{current.account.email&&<p>{current.account.email}</p>}<span className="meta">{current.role==='administrator'?'平台管理员':'社区成员'}</span></div>
          {current.role==='administrator'&&<section className="service-account-mfa" aria-label="管理员身份验证"><h3><ShieldCheck size={19}/>管理验证</h3>
            {current.mfa==='enrollment_required'&&!enrollment&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{setEnrollment(await serviceClient.enrollMfa(password));setPassword('');setCode('');});}}><p>先把一次性验证码添加到你的验证器，再确认设置。</p><label>当前密码<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={event=>setPassword(event.target.value)} disabled={busy}/></label><button type="submit" className="primary" disabled={busy}>生成验证密钥</button></form>}
            {enrollment&&<><div className="service-account-secret"><span>本次设置密钥</span><code>{enrollment.secret}</code><p>仅在本次设置中展示，请保存到验证器。</p><a className="text-button" href={enrollment.otpauthUri}>添加到验证器</a></div><form onSubmit={event=>{event.preventDefault();void run(async()=>{setSession(await serviceClient.confirmMfa(code));setEnrollment(null);setCode('');setNotice({kind:'success',text:'管理验证已启用，本次验证在 10 分钟内有效。'});});}}><label>验证器中的六位验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} disabled={busy}/></label><button type="submit" className="primary" disabled={busy||code.length!==6}>确认设置</button></form></>}
            {current.mfa==='challenge_required'&&!enrollment&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{setSession(await serviceClient.challengeMfa(code));setCode('');setNotice({kind:'success',text:'管理验证已通过，本次验证在 10 分钟内有效。'});});}}><p>进行管理操作前，验证你的身份。</p><label>验证器中的六位验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} disabled={busy}/></label><button type="submit" className="primary" disabled={busy||code.length!==6}>验证身份</button></form>}
            {current.mfa==='verified'&&<p className="service-account-mfa-ready"><ShieldCheck size={18}/>本次管理验证已通过，有效期为 10 分钟。</p>}
          </section>}
          <button type="button" className="text-button service-account-sign-out" disabled={busy} onClick={()=>void run(async()=>{await serviceClient.signOut();setSession({kind:'guest'});setEnrollment(null);setPassword('');setCode('');setNotice({kind:'success',text:'已退出社区账号。'});})}>退出登录</button>
        </>:<>
          <nav className="service-account-modes" aria-label="账号操作">{(['login','register','recover'] as const).map(value=><button type="button" key={value} aria-pressed={mode===value} disabled={busy} onClick={()=>switchMode(value)}>{value==='login'?'登录':value==='register'?'注册':'找回密码'}</button>)}</nav>
          <form className="service-account-form" onSubmit={submit}>
            {(mode==='verify'||mode==='reset')&&<h2>{mode==='verify'?'验证邮箱':'设置新密码'}</h2>}
            {['login','register','recover'].includes(mode)&&<label>邮箱<input type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" value={email} onChange={event=>changeEmail(event.target.value)} disabled={busy}/></label>}
            {(['login','register','reset'].includes(mode)||codeFlow&&mode==='recover')&&<label>{mode==='reset'||mode==='recover'?'新密码':'密码'}<input type="password" autoComplete={mode==='login'?'current-password':'new-password'} required={!codeFlow||!!codeStep} minLength={mode==='login'||codeFlow&&!codeStep?undefined:passwordMin} maxLength={passwordMax} placeholder={mode==='login'?'输入密码':`${passwordMin} 至 ${passwordMax} 个字符`} value={password} onChange={event=>setPassword(event.target.value)} disabled={busy}/></label>}
            {mode==='register'&&<details className="service-account-optional"><summary>添加昵称（可选）</summary><label>昵称<input autoComplete="nickname" maxLength={80} value={displayName} onChange={event=>setDisplayName(event.target.value)} disabled={busy}/></label></details>}
            {codeFlow&&codeStep&&<div className="service-account-code-step"><label>邮箱验证码<input ref={codeInput} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required placeholder="输入六位验证码" value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,'').slice(0,6))} disabled={busy}/></label><button type="button" className="text-button service-account-code-resend" disabled={busy||resendSeconds>0} onClick={()=>void run(sendCode)}>{resendSeconds>0?`${resendSeconds} 秒后可重发`:'重新发送验证码'}</button></div>}
            {mode==='verify'&&<p>确认你可以使用收到此链接的邮箱。</p>}
            {mode==='recover'&&!isCloudBase&&<p className="meta">如果此邮箱已注册，我们会发送一个限时有效的密码重置链接。</p>}
            <button type="submit" className="primary service-account-submit" disabled={busy||codeFlow&&!codeStep&&resendSeconds>0}>{busy?'请稍候…':codeFlow?codeStep?(mode==='register'?'验证并注册':mode==='login'?'验证并登录':'更新密码'):resendSeconds>0?`${resendSeconds} 秒后重试`:'发送验证码':mode==='login'?'登录':mode==='register'?'注册并验证邮箱':mode==='recover'?'发送重置链接':mode==='verify'?'验证邮箱':'更新密码'}</button>
          </form>
          {!isCloudBase&&(mode==='login'||mode==='register')&&<button type="button" className="text-button service-account-resend" disabled={busy||!email.trim()} onClick={()=>void run(async()=>{const result=await serviceClient.resendVerification(email);setNotice(deliveryNotice(result.delivery,'verify'));})}>重新发送验证邮件</button>}
        </>}
      </>}
    </div>
    <p className="service-account-separation"><KeyRound size={14}/>本机演示人物和私密资料不会随登录同步或绑定。</p>
  </section>;
}
