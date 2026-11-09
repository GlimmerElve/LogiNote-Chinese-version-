import type { LlmProvider, LlmThinkingPreference } from '../types';
import { effectiveThinkingLevel, isGlm53ThinkingProvider } from './llmThinkingPolicy';

/** GLM-5.3 shares its output allowance with required reasoning. A response
 * budget gets bounded reasoning headroom; an already approved total remains
 * exact. This changes transport limits only, never prompts or saved settings. */
export function resolveLlmOutputBudget(
  provider: Pick<LlmProvider, 'apiType' | 'baseUrl'>,
  model: string,
  baseTokens: number,
  mode: 'response' | 'total' = 'response',
  preference: LlmThinkingPreference = 'default',
): number {
  if (mode !== 'response' || !Number.isSafeInteger(baseTokens) || baseTokens <= 0
    || baseTokens >= 32768) return baseTokens;
  const level = effectiveThinkingLevel(provider, model, preference);
  if (level === 'off') return baseTokens;
  if (level !== undefined) {
    const scale = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
    const minimum = level === 'high' ? 8192 : level === 'medium' ? 4096 : 2048;
    const reserve = Math.min(8192 * scale, Math.max(minimum, baseTokens * scale));
    return Math.min(32768, baseTokens + reserve);
  }
  if (!isGlm53ThinkingProvider(provider, model)) return baseTokens;
  const reserve = Math.min(8192, Math.max(2048, baseTokens));
  return Math.min(32768, baseTokens + reserve);
}
