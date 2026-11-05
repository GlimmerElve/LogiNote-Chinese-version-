import { loadLearningEpisodes } from '../memory/episodeStore';
import { readCurrentProfile } from './currentRead';
import { buildProfileEvidenceDetails, type ProfileEvidenceDetail } from './evidenceModel';
export { buildProfileEvidenceDetails, type ProfileEvidenceDetail, type ProfileEvidenceSampleDetail } from './evidenceModel';

/** 供后续画像证据页面调用的只读接口。 */
export async function loadProfileEvidenceDetails(): Promise<ProfileEvidenceDetail[]> {
  const [profile, episodes] = await Promise.all([readCurrentProfile(), loadLearningEpisodes()]);
  return buildProfileEvidenceDetails(profile, episodes);
}
