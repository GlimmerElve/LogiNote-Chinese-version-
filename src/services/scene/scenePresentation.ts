/** Presentation compatibility only. Never normalize interaction, tool, grading, scope or state authority here. */
export const SCENE_PRESENTATION_TEXT_RULE = '所有展示文本必须是JSON字符串：meta.name/subject/goal、task、situation、userRole、openingNarrative、role.name及属性key/value、metrics的name/description/unit、events.description、extras各值。task是一段完整任务文字，不是对象、步骤对象或数组；有结构的任务用字符串内换行/Markdown表达。meta.knowledgePoints、resources、rules、evaluationDimensions必须是字符串数组，不放对象。';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Preserve every serialized field of historical structured text, including nested arrays and long content. */
export function scenePresentationText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized === 'string') return serialized;
  } catch { /* Invalid non-JSON local objects must not be silently truncated or replaced. */ }
  throw new Error('场景展示字段无法转换为完整文本，请修正场景内容后重试。');
}

function strings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(item => scenePresentationText(item));
}

/**
 * Copy only display text containers. All protocol, permission, budget and grading objects retain their values/references.
 * This also repairs existing JSON scenes without rewriting their files; the conversion is lossless and idempotent.
 */
export function normalizeScenePresentation<T extends object>(scene: T): T {
  const value = scene as Record<string, unknown>, meta = object(value.meta), role = object(value.role);
  const result: Record<string, unknown> = { ...value,
    meta: { ...meta, name: scenePresentationText(meta.name, '未命名场景'),
      subject: scenePresentationText(meta.subject), goal: scenePresentationText(meta.goal), knowledgePoints: strings(meta.knowledgePoints) },
    role: { ...role, name: scenePresentationText(role.name, 'NPC'),
      attributes: Array.isArray(role.attributes) ? role.attributes.map(raw => {
        const attribute = object(raw);
        return { ...attribute, key: scenePresentationText(attribute.key), value: scenePresentationText(attribute.value) };
      }) : [] },
    userRole: scenePresentationText(value.userRole), situation: scenePresentationText(value.situation),
    task: scenePresentationText(value.task), openingNarrative: scenePresentationText(value.openingNarrative),
    resources: strings(value.resources), rules: strings(value.rules), evaluationDimensions: strings(value.evaluationDimensions),
  };
  if (Array.isArray(value.metrics)) result.metrics = value.metrics.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const metric = raw as Record<string, unknown>;
    return { ...metric, name: scenePresentationText(metric.name), description: scenePresentationText(metric.description),
      ...(metric.unit === undefined ? {} : { unit: scenePresentationText(metric.unit) }) };
  });
  if (Array.isArray(value.events)) result.events = value.events.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const event = raw as Record<string, unknown>;
    return { ...event, description: scenePresentationText(event.description) };
  });
  if (value.extras && typeof value.extras === 'object' && !Array.isArray(value.extras)) {
    result.extras = Object.fromEntries(Object.entries(value.extras).map(([key, text]) => [key, scenePresentationText(text)]));
  }
  return result as T;
}
