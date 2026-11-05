import { SHADOW_BEHAVIORS } from './rubric';
import type { ShadowBehavior, ShadowWarning } from './types';

/** New-request opt-in only. Absence is a coverage question, never proof of missing user ability. */
export function requiresAssessmentCoverageReview(promptId: string): boolean {
  return promptId === 'flow-shadow-assess-v4.3-light' || promptId === 'flow-shadow-assess-v4.4-light'
    || promptId === 'flow-shadow-assess-v4.5-light' || promptId === 'flow-shadow-assess-v4.6-light';
}

export function reviewShadowBehaviorCoverage(behaviors: readonly ShadowBehavior[]): ShadowWarning[] {
  return (['expression', 'strategy'] as const).flatMap(dimension => {
    const codes = new Set(SHADOW_BEHAVIORS.filter(b => b.dimension === dimension).map(b => b.code));
    return behaviors.some(b => codes.has(b.code)) ? [] : [{ code: 'behavior_domain_unreported', target: dimension,
      message: `模型未返回${dimension === 'expression' ? '表达' : '认知'}观察项，需核对是否遗漏；不等同于用户没有该表现，不补方向、不扣分。` }];
  });
}
