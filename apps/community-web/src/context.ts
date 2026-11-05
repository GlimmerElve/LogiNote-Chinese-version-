import { createContext, useContext } from 'react';
import type { DemoState, Page } from './model';

export type Panel =
  | {kind:'composeMenu';anchor:DOMRect}
  | {kind:'resource'|'messageImage';id:string}
  | {kind:'privacy'|'edit'|'account'|'reports'|'prototype'|'drafts'|'createGroup'|'manageFollowing'}
  | {kind:'groupInfo'|'schedule'|'invite';groupId?:string}
  | {kind:'feedback';target:string}
  | {kind:'friend';anchor:DOMRect}
  | {kind:'share';id:string;anchor?:DOMRect}
  | {kind:'moderate';id:string};
export type Scenario='正常'|'加载中'|'空内容'|'加载失败'|'无权限';
export type MarketView={query:string;topic:string;kind?:string;limit:number};
export type Context={
  marketView:MarketView;setMarketView:(v:MarketView)=>void;
  state:DemoState;patch:(s:Partial<DemoState>)=>void;page:Page;go:(p:Page,id?:string)=>void;
  open:(p:Panel)=>void;close:()=>void;bookmark:(id:string)=>void;
  deletePost:(id:string)=>void;
  notice:string;setNotice:(s:string)=>void;
  scenario:Scenario;setScenario:(s:Scenario)=>void;resourceId:string;
};
export const AppContext=createContext<Context>(null!);
export const useApp=()=>useContext(AppContext);
