export interface CognitionConditionExcerpt {
  conditions?: string[];
  conditionsTotal?: number;
  /** Items can be omitted and individual items can be excerpts; never an edit baseline. */
  conditionsTruncated?: boolean;
}

/** Shared by QA and candidate lookup; exact target reads and stored data stay complete. */
export function projectCognitionConditions(conditions: string[] | undefined): CognitionConditionExcerpt {
  if (conditions === undefined) return {};
  let remaining = 640, shortened = false;
  const excerpts: string[] = [];
  for (const condition of conditions.slice(0, 8)) {
    if (remaining <= 0) break;
    const excerpt = condition.slice(0, Math.min(160, remaining));
    excerpts.push(excerpt); remaining -= excerpt.length;
    shortened ||= excerpt.length < condition.length;
  }
  return { conditions: excerpts, conditionsTotal: conditions.length, conditionsTruncated: shortened || excerpts.length < conditions.length };
}

/** Count serialized characters, including escaped identifiers, rather than just prose. */
export function appendCognitionReadItem<T>(response: object, list: T[], item: T, limit: number): boolean {
  list.push(item);
  // Reserve space for pagination cursors and final truncation notices.
  if (JSON.stringify(response).length <= limit - 512) return true;
  list.pop();
  return false;
}
