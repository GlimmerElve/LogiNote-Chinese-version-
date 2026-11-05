/** Portable community boundaries. No local vault types, credentials or platform SDKs. */
export const COMMUNITY_CONTRACT_VERSION = 1 as const;

export interface CommunityAccountSummary {
  readonly accountId: string;
  readonly displayName: string;
}

/** A UI snapshot, never proof of permission to the server. */
export type CommunityIdentityState =
  | { readonly kind: 'unavailable'; readonly reason: 'not_configured' }
  | { readonly kind: 'guest' }
  | {
    readonly kind: 'authenticated';
    readonly account: CommunityAccountSummary;
    readonly expiresAt: string;
  };

export type CommunityErrorCode =
  | 'not_configured'
  | 'authentication_required'
  | 'forbidden'
  | 'conflict'
  | 'quota_exceeded'
  | 'unsupported_version'
  | 'temporarily_unavailable';

export type CommunityResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: CommunityErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    };
  };

/** Account UI/service integration is supplied later; no provider is assumed here. */
export interface CommunityIdentityPort {
  getState(): Promise<CommunityIdentityState>;
  requestAccountAction(request: {
    readonly action: 'sign_in' | 'sign_up' | 'recover_account';
    /** Internal route only; a future adapter must validate it before navigation. */
    readonly returnPath?: string;
  }): Promise<CommunityResult<CommunityIdentityState>>;
  signOut(): Promise<CommunityResult<CommunityIdentityState>>;
}

export type CommunityVisibility =
  | { readonly kind: 'public' }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'direct'; readonly recipientAccountIds: readonly string[] };

export const COMMUNITY_RESOURCE_KINDS = [
  'note', 'textbook', 'plan', 'exercise', 'scene', 'argument', 'link', 'experience',
] as const;
export type CommunityResourceKind = (typeof COMMUNITY_RESOURCE_KINDS)[number];
export type CommunityClientPlatform = 'desktop' | 'web' | 'ios' | 'android';

/** Public/group catalogue metadata; not a serialization of NoteItem or UserProfile. */
export interface CommunityResourceSummary {
  readonly resourceId: string;
  readonly revisionId: string;
  readonly kind: CommunityResourceKind;
  readonly title: string;
  readonly summary?: string;
  readonly level?: 'beginner' | 'intermediate' | 'advanced';
  readonly author: CommunityAccountSummary;
  readonly visibility: CommunityVisibility;
  readonly updatedAt: string;
}

export interface CommunityPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface CommunityQuestionCreateInput {
  readonly body: string;
  readonly context?: { readonly kind: 'topic' | 'group'; readonly id: string };
}

/** The service resolves the actor from its verified session, not from this request. */
export interface CommunityAccessRequest {
  readonly action:
    | 'read_resource'
    | 'publish_resource'
    | 'import_resource'
    | 'post_question'
    | 'send_message'
    | 'join_group'
    | 'submit_report'
    | 'manage_community';
  readonly target?: {
    readonly kind: 'resource' | 'question' | 'group' | 'conversation' | 'report';
    readonly id: string;
  };
}

/** A display/preflight result; the actual operation must be authorized again. */
export type CommunityAccessDecision =
  | { readonly allowed: true }
  | {
    readonly allowed: false;
    readonly reason: 'not_configured' | 'authentication_required' | 'forbidden';
  };

export interface CommunityAccessPort {
  check(request: CommunityAccessRequest): Promise<CommunityAccessDecision>;
}

/** Reserved preferences, not an installed notification or presence service. */
export interface CommunityAttentionPreferences {
  readonly ordinaryAlertsEnabled: boolean;
  readonly systemPushEnabled: boolean;
  readonly soundEnabled: boolean;
  readonly vibrationEnabled: boolean;
  readonly showUnreadBadges: false;
  readonly replayAfterFocus: false;
}

export interface CommunityAttentionState {
  readonly mode: 'quiet' | 'focus';
  readonly preferences: CommunityAttentionPreferences;
}
