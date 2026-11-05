export class ApiError extends Error {
  constructor(public readonly status:number,public readonly code:string,message:string,public readonly retryable=false,public readonly retryAfterSeconds?:number,public source?:'community'|'cloudbase'){super(message);this.name='ApiError';}
}
export function requireValue(condition:unknown,status:number,code:string,message:string):asserts condition {
  if(!condition)throw new ApiError(status,code,message);
}
export function object(value:unknown):Record<string,unknown>{
  requireValue(!!value&&typeof value==='object'&&!Array.isArray(value),400,'invalid_request','请求格式不正确。');return value as Record<string,unknown>;
}
export function text(value:unknown,label:string,max=4000):string {
  requireValue(typeof value==='string'&&value.trim().length>0&&value.length<=max,400,'invalid_request',`${label}不能为空或超过长度限制。`);return value.trim();
}
export function onlyKeys(value:Record<string,unknown>,allowed:readonly string[]):void {
  requireValue(Object.keys(value).every(key=>allowed.includes(key)),400,'invalid_request','请求包含不支持的字段。');
}
