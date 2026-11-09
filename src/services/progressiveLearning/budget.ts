import type { ProgressiveCourse, ProgressivePageSummary } from './types';

/** Explicit user supplements do not spend the automatic course allowance.
 * Legacy pages have no marker and retain their original budget treatment. */
export function progressiveBudgetedPageCount(pages: readonly Pick<ProgressivePageSummary, 'kind' | 'manualExpansion'>[] = []): number {
  return pages.reduce((count, page) => count + (page.kind === 'expansion' && page.manualExpansion === true ? 0 : 1), 0);
}

/** Reserve every missing mainline page before allowing an automatic detour. */
export function progressiveAutomaticExpansionAvailable(course: Pick<ProgressiveCourse, 'pages' | 'plan' | 'budget'>): boolean {
  const remaining = course.plan?.pages.filter(page => !course.pages?.some(saved => saved.id === page.id)).length || 0;
  return progressiveBudgetedPageCount(course.pages) + remaining < course.budget.totalPageLimit;
}
