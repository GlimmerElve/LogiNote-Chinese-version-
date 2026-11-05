import type { LlmConversationMessage } from '../../types';
import type { PostToolReviewState } from './postToolReview';
import type { AgentRunState } from './runtime/types';
import type { AgentRuntimeMetrics, AgentToolStep } from './types';
import type { AgentExecutionMode } from '../../types';

/** Same-run continuation, ephemeral and never saved as long-term memory. */
export interface AgentRunRecovery {
  state: AgentRunState;
  messages: LlmConversationMessage[];
  trace: AgentToolStep[];
  roundsUsed: number;
  executionMode: AgentExecutionMode;
  toolCallLimit?: number;
  metrics: AgentRuntimeMetrics;
  reviews: PostToolReviewState;
  planDraftId?: string;
  resourceDraftId?: string;
}

export class AgentRunFailure extends Error {
  constructor(cause: unknown, readonly recovery: AgentRunRecovery) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AgentRunFailure';
  }
}
