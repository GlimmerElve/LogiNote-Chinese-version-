import type { LlmConversationMessage } from '../../types';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDay(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(year, month - 1, date + offset, 12, 0, 0, 0);
  return localDateString(shifted);
}

export function buildAgentTemporalContext(now = new Date()): string {
  const today = localDateString(now);
  const tomorrow = shiftDay(today, 1);
  const dayAfterTomorrow = shiftDay(today, 2);
  let timeZone = '系统本地时区';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone; } catch { /* use fallback */ }
  return `【当前时间基准】\n- 当前本地日期：${today}\n- 明天：${tomorrow}\n- 后天：${dayAfterTomorrow}\n- 本地时区：${timeZone}\n用户使用“今天、明天、后天、下周”等相对日期时，必须先换算成绝对 YYYY-MM-DD。用户明确指定计划起点时，计划、项目、任务和里程碑不得安排在该起点之前。`;
}

function normalizeExplicitDate(raw: string, today: string): string | undefined {
  const value = raw.trim();
  if (value === '今天') return today;
  if (value === '明天') return shiftDay(today, 1);
  if (value === '后天') return shiftDay(today, 2);
  const full = value.match(/^(\d{4})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?$/u);
  const short = value.match(/^(\d{1,2})[月\/.\-](\d{1,2})日?$/u);
  const year = full ? Number(full[1]) : Number(today.slice(0, 4));
  const month = Number(full?.[2] || short?.[1]);
  const day = Number(full?.[3] || short?.[2]);
  if (!month || !day) return undefined;
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  const parsed = new Date(`${candidate}T12:00:00`);
  if (Number.isNaN(parsed.getTime()) || localDateString(parsed) !== candidate) return undefined;
  return candidate;
}

function dateFromText(text: string, today: string): string | undefined {
  const dateToken = '(今天|明天|后天|\\d{4}[年\\/.\\-]\\d{1,2}[月\\/.\\-]\\d{1,2}日?|\\d{1,2}[月\\/.\\-]\\d{1,2}日?)';
  const bareReply = text.trim().match(new RegExp(`^(?:就)?(?:从|自)?\\s*${dateToken}\\s*(?:开始|起)?[。.!！]?$`, 'u'));
  if (bareReply?.[1]) return normalizeExplicitDate(bareReply[1], today);
  const patterns = [
    new RegExp(`(?:计划|学习|项目|任务)?(?:从|自|于)?\\s*${dateToken}\\s*(?:开始|起|启动)`, 'u'),
    new RegExp(`(?:开始|起始)(?:日期|时间)?\\s*(?:为|是|定在|于|：|:)?\\s*${dateToken}`, 'u'),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeExplicitDate(match[1], today);
  }
  return undefined;
}

/** Resolve only a user-authored start constraint; assistant text is never trusted. */
export function resolveRequestedPlanStartDate(
  userText: string,
  history: LlmConversationMessage[],
  today: string,
): string | undefined {
  if (!ISO_DAY.test(today)) return undefined;
  const current = dateFromText(userText, today);
  if (current) return current;
  const priorUserMessages = history.filter((message) => message.role === 'user');
  for (let index = priorUserMessages.length - 1; index >= 0; index -= 1) {
    const resolved = dateFromText(priorUserMessages[index].content, today);
    if (resolved) return resolved;
  }
  return undefined;
}

function collectPlanDates(value: unknown, path: string, output: Array<{ path: string; value: string }>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlanDates(item, `${path}[${index}]`, output));
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    const nextPath = path ? `${path}.${key}` : key;
    if (['startDate', 'dueDate', 'targetDate'].includes(key) && typeof item === 'string' && ISO_DAY.test(item)) {
      output.push({ path: nextPath, value: item });
    }
    if (key === 'recurrence') return;
    collectPlanDates(item, nextPath, output);
  });
}

/** Returns a retryable model-facing error before a bad plan reaches approval. */
export function validateCreatePlanDatesForRequest(input: {
  args: Record<string, unknown>;
  userText: string;
  history: LlmConversationMessage[];
  today: string;
}): string | undefined {
  const requestedStart = resolveRequestedPlanStartDate(input.userText, input.history, input.today);
  if (!requestedStart) return undefined;
  const planMeta = input.args.planMeta && typeof input.args.planMeta === 'object' && !Array.isArray(input.args.planMeta)
    ? input.args.planMeta as Record<string, unknown>
    : undefined;
  if (planMeta?.startDate !== requestedStart) {
    return `用户明确要求从 ${requestedStart} 开始，但 planMeta.startDate 为 ${String(planMeta?.startDate || '缺失')}。请修正后重新调用 create_project_plan。`;
  }
  const dates: Array<{ path: string; value: string }> = [];
  collectPlanDates(input.args.root, 'root', dates);
  collectPlanDates(planMeta, 'planMeta', dates);
  const invalid = dates.filter((item) => item.value < requestedStart);
  if (!invalid.length) return undefined;
  const sample = invalid.slice(0, 5).map((item) => `${item.path}=${item.value}`).join('，');
  return `用户明确要求从 ${requestedStart} 开始，但计划中存在更早日期：${sample}。所有项目、任务和里程碑都必须从该日期或之后开始，请重新生成工具参数。`;
}
