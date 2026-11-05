import type {ElectronApi} from './preload.d.ts';

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}
