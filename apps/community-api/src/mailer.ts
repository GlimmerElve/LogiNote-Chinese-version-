import nodemailer from 'nodemailer';
import type { ApiConfig } from './config.js';
import { ApiError } from './errors.js';
export function createMailer(config:ApiConfig){
  const transport=config.smtp?nodemailer.createTransport({host:config.smtp.host,port:config.smtp.port,secure:config.smtp.secure,requireTLS:!config.smtp.secure,auth:config.smtp.user?{user:config.smtp.user,pass:config.smtp.password}:undefined,tls:{rejectUnauthorized:true},logger:false,debug:false,connectionTimeout:10000,socketTimeout:15000}):undefined;
  return {configured:!!transport,async send(request:{to:string;purpose:'verify_email'|'reset_password';token:string;expiresAt:Date}):Promise<'sent'|'not_configured'>{
    if(!transport||!config.smtp)return 'not_configured';
    const action=request.purpose==='verify_email'?'verify':'reset',url=`${config.webOrigin}/#/account/${action}~${encodeURIComponent(request.token)}`;
    try{await transport.sendMail({from:config.smtp.from,to:request.to,subject:request.purpose==='verify_email'?'验证你的 LogiNote 邮箱':'重置你的 LogiNote 密码',text:`${request.purpose==='verify_email'?'请验证你的邮箱':'如需重置密码，请打开'}：\n${url}\n\n有效期至 ${request.expiresAt.toISOString()}。如非本人操作，请忽略本邮件。`});return 'sent';}
    catch{throw new ApiError(503,'temporarily_unavailable','验证邮件暂时无法提交发送，请稍后重试。',true);}
  }};
}
