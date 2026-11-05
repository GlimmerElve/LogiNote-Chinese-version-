import type { UserProfile } from '../../types';
import { getUserProfile, getDefaultUserProfile, waitProfilePersistence } from './profileStore';
import { flushProfileStateWrites } from '../electronUserState';
import { partitionFlowProfileEvidence } from './evidenceGateCore';

/** Fresh authoritative read; page refresh never rewrites scores or falls back after desktop IO failure. */
export async function readCurrentProfile(): Promise<UserProfile> {
  const desktop = typeof window === 'undefined' ? undefined : (window as unknown as {
    electronAPI?: { isElectron?: boolean; userState?: { loadProfile?: (strict?: boolean) => Promise<unknown> } };
  }).electronAPI;
  if (!desktop) return partitionFlowProfileEvidence(getUserProfile());
  if (!desktop.userState?.loadProfile) throw new Error('画像读取接口不可用');
  await waitProfilePersistence();
  await flushProfileStateWrites();
  const value = await desktop.userState.loadProfile(true) as { profile?: UserProfile } | null;
  if (value === null) return getDefaultUserProfile(); // A genuine missing file is not a stale cache or an IO error.
  if (!value?.profile || !value.profile.ability || !value.profile.cognitiveStyle) throw new Error('画像文件无效');
  return partitionFlowProfileEvidence(value.profile);
}
