export interface Actor {accountId:string;role:'member'|'administrator';mfaVerified:boolean}
export type Clock=()=>Date;
export const systemClock:Clock=()=>new Date();
