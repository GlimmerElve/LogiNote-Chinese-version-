import type { LlmCallRequest, LlmCallResponse } from '../../src/types';
import type { S2CanvasDefinition, S2DesignBrief } from '../../src/types/sceneS2';
import type { interactS2Canvas } from '../../src/services/scene/sceneS2Canvas';
import { syntheticS2Business } from './s2-business-model';

/** Synthetic protocol fixture only, not an evaluator or a real semantic-acceptance result. */
export function s2DesignFixtureResponse(request: LlmCallRequest, definition: S2CanvasDefinition): LlmCallResponse {
  const data = JSON.parse(request.userInput);
  let value: unknown;
  if (data.stage === 'understand') {
    const brief: S2DesignBrief = { goal: definition.goal, requirements: [{ id: 'r1', description: 'Synthetic design requirement',
      source: 'task', quote: data.sources.task.slice(0, 500) }], userRole: 'Edit or ask for collaboration', agentRole: 'Help within approved scope', assumptions: [], openQuestions: [],
      delivery: { initial: 'Synthetic initial exercise', deferred: 'Synthetic later user interaction', source: 'task', quote: data.sources.task.slice(0, 500) } };
    value = brief;
  } else if (data.stage === 'assemble') value = { ...definition, business: definition.business ?? syntheticS2Business(definition, data.designBrief) };
  else if (data.stage === 'review') value = { verdict: 'accept', factChecks: [], coverage: data.designBrief.requirements.map((item: { id: string }) => ({
    requirementId: item.id, status: 'covered', evidencePaths: ['/instructions/response'], reason: 'Synthetic protocol coverage only',
  })), feedback: 'Synthetic protocol accepted, not a real-model evaluation' };
  else throw new Error('Unexpected S2 design fixture stage');
  return { content: JSON.stringify(value) } as LlmCallResponse;
}

/** Legacy action-parser regressions allow all three intent actions synthetically.
 * Real semantic-stage boundaries are tested separately in check-scene-s2-design.ts. */
export function s2TurnFixtureAdapter(interact: typeof interactS2Canvas): typeof interactS2Canvas {
  return (scene, document, query, selectedId, history, options = {}) => {
    const invoke = options.invoke;
    if (!invoke) throw new Error('Synthetic S2 turn fixture requires an explicit model stub');
    return interact(scene, document, query, selectedId, history, { ...options, invoke: async (request, callOptions) => {
      if (JSON.parse(request.userInput).stage === 'turn-proposal-review') {
        const data = JSON.parse(request.userInput), source = data.sources.find((source: { id: string }) => source.id === 'query');
        return { content: JSON.stringify({ verdict: 'accept', reason: 'Synthetic legacy action-parser fixture, NOT semantic review evidence',
          evidence: [{ sourceId: source.id, quote: source.text.slice(0, 500) }] }) } as LlmCallResponse;
      }
      if (JSON.parse(request.userInput).stage === 'turn-understand') return { content: JSON.stringify({
        understanding: 'Synthetic action-parser fixture', desiredOutcome: 'Exercise the downstream protocol parser',
        actions: ['reply', 'edit', 'execute'], constraints: [], questions: [],
      }) } as LlmCallResponse;
      return invoke(request, callOptions);
    } });
  };
}
