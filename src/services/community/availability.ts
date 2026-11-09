import {resolveCommunityWebConfiguration} from './deployment';
export {resolveCommunityWebsiteUrl} from './deployment';
export const COMMUNITY_UNAVAILABLE_MESSAGE = '社区正在建设中，暂未开放。';

function configuration(){return resolveCommunityWebConfiguration({release:import.meta.env.MODE==='release',development:import.meta.env.DEV,developmentWebsiteUrl:import.meta.env.DEV?'http://127.0.0.1:5174':'',websiteOverride:import.meta.env.VITE_COMMUNITY_WEB_URL,releaseEnabledOverride:import.meta.env.VITE_COMMUNITY_RELEASE_ENABLED,desktopExchangeOverride:import.meta.env.VITE_COMMUNITY_DESKTOP_EXCHANGE_ENABLED,explicitWebsiteOverride:true});}

export function communityWebsiteUrl(): string | null {
  return configuration().websiteUrl;
}
export function communityDesktopExchangeEnabled():boolean{return configuration().desktopExchangeEnabled;}
