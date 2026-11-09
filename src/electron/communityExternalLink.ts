/** Confirm leaving the configured community origin. Validation remains in the
 * host and the caller is checked again after asynchronous user interaction. */
export async function openCommunityExternalLink(
  checkedUrl:string,
  communityOrigin:string,
  actions:{confirm:(target:{host:string;url:string})=>Promise<boolean>;validateCaller:()=>void;open:(url:string)=>Promise<unknown>},
){
  const target=new URL(checkedUrl),origin=new URL(communityOrigin);
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw Error('链接格式不正确。');
  if(target.origin!==origin.origin&&!await actions.confirm({host:target.host,url:target.href}))return;
  actions.validateCaller();
  await actions.open(target.href);
}
