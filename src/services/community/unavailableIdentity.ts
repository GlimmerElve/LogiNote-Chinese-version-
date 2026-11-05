import type {
  CommunityAccessPort,
  CommunityIdentityPort,
  CommunityIdentityState,
  CommunityResult,
} from '../../../packages/community-contracts/src/index';

function unavailable(): CommunityResult<CommunityIdentityState> {
  return {
    ok: false,
    error: {
      code: 'not_configured',
      message: '社区账号服务尚未接入。',
      retryable: false,
    },
  };
}

/** No fake account, account store, network request or implicit local identity. */
export function createUnavailableCommunityIdentityPort(): CommunityIdentityPort {
  return Object.freeze({
    async getState(): Promise<CommunityIdentityState> {
      return { kind: 'unavailable', reason: 'not_configured' };
    },
    async requestAccountAction(): Promise<CommunityResult<CommunityIdentityState>> {
      return unavailable();
    },
    async signOut(): Promise<CommunityResult<CommunityIdentityState>> {
      return unavailable();
    },
  });
}

/** Disabled preflight only. A future server must authorize each actual operation. */
export function createUnavailableCommunityAccessPort(): CommunityAccessPort {
  return Object.freeze({
    async check() {
      return { allowed: false as const, reason: 'not_configured' as const };
    },
  });
}
