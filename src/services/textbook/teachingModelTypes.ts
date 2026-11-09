export const TEACHING_MODEL_TYPES = ['area', 'oscillator', 'lru', 'grouping', 'reaction', 'knapsack', 'attention'] as const;
export type TeachingModelType = typeof TEACHING_MODEL_TYPES[number];
export function isTeachingModelType(value: unknown): value is TeachingModelType {
  return typeof value === 'string' && (TEACHING_MODEL_TYPES as readonly string[]).includes(value);
}
