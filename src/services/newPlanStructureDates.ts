/** New projects start now (or when their parent starts), never at a stale parent start. */
export function newPlanStructureDates(today: string, parent?: { startDate?: string; dueDate?: string }): {
  startDate: string; dueDate: string;
} {
  const startDate = parent?.startDate && parent.startDate > today ? parent.startDate : today;
  if (parent?.dueDate && parent.dueDate < startDate) return { startDate: '', dueDate: '' };
  const end = new Date(`${startDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 13);
  const candidateEnd = end.toISOString().slice(0, 10);
  return { startDate, dueDate: parent?.dueDate && parent.dueDate < candidateEnd ? parent.dueDate : candidateEnd };
}
