export type CommunityDesktopState={configured:boolean;connected:boolean;displayName?:string;accountId?:string;libraryLabel:string;persistent?:boolean;pairing?:{code:string;expiresAt:string};lastStatus?:string};
export type CommunityCatalogItem={id:string;title:string;noteType:'project'|'knowledge';parentId?:string;hasPlan:boolean};
export type CommunityPreparedResource={selectionId:string;name:string;title:string;body:string;bytes:number;units:number;kind:'notes'|'plan'|'pdf'|'markdown'|'file'|'link'|'video-link';images?:Record<string,string>;items:{id:string;title:string;parentId?:string}[]};
export type CommunityLocalTemplate={id:string;title:string;state:'inactive'|'active';units:number;entryId:string;version:number;createdAt:string};
export interface CommunityDesktopApi{
  state():Promise<CommunityDesktopState>;
  connect():Promise<CommunityDesktopState>;
  disconnect():Promise<void>;
  setFocus(enabled:boolean):Promise<void>;
  catalog():Promise<CommunityCatalogItem[]>;
  prepare(input:{noteIds:string[];kind:'notes'|'plan';includeDescendants:boolean}):Promise<CommunityPreparedResource>;
  chooseFile():Promise<CommunityPreparedResource|null>;
  prepareLink(url:string):Promise<CommunityPreparedResource>;
  openLink(url:string):Promise<void>;
  publish(input:{selectionId:string;title:string;body:string;scope:'public'|'self'}):Promise<{id:string}>;
  receiveNow():Promise<CommunityDesktopState>;
  references():Promise<CommunitySavedResource[]>;
  snapshot(id:string):Promise<{title:string;body:string;sourceUrl:string;version:number}>;
  templates():Promise<CommunityLocalTemplate[]>;
  activateTemplate(input:{id:string;startDate:string;dailyMinutes:number;weekdays?:number[];allowOverlap?:boolean}):Promise<{localIds:string[]}>;
}

export type CommunitySavedResource={id:string;kind:'snapshot'|'link'|'video-link';title:string;entryId:string;version:number;sourceUrl:string;url?:string;documentId?:string;createdAt:string};
