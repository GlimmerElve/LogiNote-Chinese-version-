import type { UserProfile } from '../../types.ts';

function hasGateEvidence(profile: UserProfile): boolean {
  return (profile.evidenceGate?.processedEpisodeIds.length || 0) > 0;
}

export function isProfileIndicatorTrusted(
  profile: UserProfile,
  dimension: 'ability' | 'cognitive_style',
  indicator: string,
): boolean {
  if (!hasGateEvidence(profile)) {
    return profile.ability.evidenceCount >= 2 && profile.ability.evidenceChars >= 300;
  }
  return profile.evidenceGate?.aggregates[`${dimension}:${indicator}`]?.status === 'trusted';
}

/** 新数据按分指标门控；旧画像没有门控记录时回退原有全局可信门槛。 */
export function isProfileTrusted(profile: UserProfile): boolean {
  if (!hasGateEvidence(profile)) {
    const ability = profile.ability;
    return ability.evidenceCount >= 2 && ability.evidenceChars >= 300;
  }
  return Object.values(profile.evidenceGate?.aggregates || {}).some(
    (aggregate) => aggregate.status === 'trusted'
      && (aggregate.dimension === 'ability' || aggregate.dimension === 'cognitive_style'),
  );
}
