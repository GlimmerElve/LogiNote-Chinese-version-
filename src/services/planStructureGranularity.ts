export interface PlanStructureGranularityIssue {
  code: 'day-project-has-children';
  title: string;
  path: string[];
  date: string;
  childCount: number;
  message: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

/**
 * Structural projects may be arbitrarily deep, but a project scheduled to a
 * single calendar day is the minimum structural unit. Its within-day actions
 * belong to the leaf note rather than another project-note layer.
 *
 * Sibling leaves may still share the same day: each leaf is validated
 * independently, so genuinely separate deliverables remain representable.
 */
export function findPlanStructureGranularityIssues(value: unknown): PlanStructureGranularityIssue[] {
  const roots = Array.isArray(value) ? value : [value];
  const issues: PlanStructureGranularityIssue[] = [];

  const visit = (raw: unknown, parentPath: string[]) => {
    const node = asRecord(raw);
    if (!node) return;
    const title = typeof node.title === 'string' && node.title.trim() ? node.title.trim() : '未命名项目';
    const path = [...parentPath, title];
    const startDate = typeof node.startDate === 'string' ? node.startDate.trim() : '';
    const dueDate = typeof node.dueDate === 'string' ? node.dueDate.trim() : '';
    const children = Array.isArray(node.children) ? node.children : [];

    if (startDate && dueDate && startDate === dueDate && children.length > 0) {
      issues.push({
        code: 'day-project-has-children',
        title,
        path,
        date: startDate,
        childCount: children.length,
        message: `一天范围的结构项目“${title}”不能继续拆分子项目；请移除其结构子项目，或扩大该项目的时间范围。`,
      });
    }

    children.forEach((child) => visit(child, path));
  };

  roots.forEach((root) => visit(root, []));
  return issues;
}

export function assertPlanStructureGranularity(value: unknown): void {
  const issue = findPlanStructureGranularityIssues(value)[0];
  if (issue) throw new Error(issue.message);
}
