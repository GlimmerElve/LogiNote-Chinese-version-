import type { LlmCallRequest, LlmCallResponse } from '../src/types';

/** Test-driver cache of PAID synthetic responses, not a mock and not a model/host acceptance override. */
export function createS2ExactReplay(entries: Array<{ request: LlmCallRequest; response: LlmCallResponse }>) {
  const immutable = structuredClone(entries); let consumed = 0;
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as any)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable((value as any)[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return { get remaining() { return immutable.length - consumed; }, get consumed() { return consumed; },
    take(request: LlmCallRequest) {
      if (consumed >= immutable.length) throw new Error('S2_REPLAY_PREFIX_EXHAUSTED');
      if (stable(request) !== stable(immutable[consumed].request)) throw new Error(`S2_REPLAY_REQUEST_MISMATCH_${consumed + 1}`);
      return structuredClone(immutable[consumed++].response);
    } };
}
