import type { BrowserWindow, IpcMain } from 'electron';
import { getReviewQueue, queryLearnerProfile, queryMastery } from './agentQueries';
import { getVersion, setDataCenterChangeListener } from './store';
import type { AgentMasteryRequest } from './types';

export function registerDataCenterHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('agent:data-version', () => getVersion());
  ipcMain.handle('agent:query-profile', (_event, request: unknown) => queryLearnerProfile({ includeEvidence: !!request && typeof request === 'object' && (request as { includeEvidence?: unknown }).includeEvidence === true }));
  ipcMain.handle('agent:query-mastery', (_event, request: AgentMasteryRequest) => queryMastery(request));
  ipcMain.handle('agent:review-queue', () => getReviewQueue());
  setDataCenterChangeListener((payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('agent:data-changed', payload);
  });
}
