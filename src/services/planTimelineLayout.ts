import type { PlanWorkspaceMilestone, PlanWorkspaceStructureNode } from './planViewModel';

/** Keep each hierarchy depth below its parent, packing overlapping siblings into separate rows. */
export function layoutStructureNodes(nodes: PlanWorkspaceStructureNode[]) {
  const positioned: Array<{ node: PlanWorkspaceStructureNode; row: number }> = [];
  let rowCount = 0;
  const depths = [...new Set(nodes.map((node) => node.depth))].sort((a, b) => a - b);
  for (const depth of depths) {
    const rowEnds: number[] = [];
    const siblings = nodes.filter((node) => node.depth === depth)
      .sort((a, b) => a.leftPercent - b.leftPercent || b.widthPercent - a.widthPercent);
    for (const node of siblings) {
      let localRow = rowEnds.findIndex((end) => node.leftPercent >= end - 0.001);
      if (localRow === -1) localRow = rowEnds.length;
      rowEnds[localRow] = node.leftPercent + node.widthPercent;
      positioned.push({ node, row: rowCount + localRow });
    }
    rowCount += rowEnds.length;
  }
  return { positioned, rowCount: Math.max(1, rowCount) };
}

export interface TimelineMilestoneGroup {
  date: string;
  milestones: PlanWorkspaceMilestone[];
  leftPercent: number;
}

export function groupTimelineMilestones(milestones: PlanWorkspaceMilestone[]): TimelineMilestoneGroup[] {
  const groups = new Map<string, TimelineMilestoneGroup>();
  for (const milestone of milestones) {
    const group = groups.get(milestone.dueDate);
    if (group) group.milestones.push(milestone);
    else groups.set(milestone.dueDate, { date: milestone.dueDate, milestones: [milestone], leftPercent: milestone.leftPercent });
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Reserve icon space first; show a measured label only if it fits before the next marker. */
export function layoutTimelineMilestones(groups: TimelineMilestoneGroup[], trackWidth: number, labelWidths: Record<string, number>) {
  const rowEnds: number[] = [];
  const markers = groups.map((group) => {
    const x = Math.max(12, Math.min(Math.max(12, trackWidth - 12), group.leftPercent * trackWidth / 100));
    let row = rowEnds.findIndex((end) => x - 12 >= end + 6);
    if (row === -1) row = rowEnds.length;
    rowEnds[row] = x + 12;
    return { group, x, row, showLabel: false };
  });
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const next = markers.slice(index + 1).find((candidate) => candidate.row === marker.row);
    const availableEnd = next ? next.x - 18 : trackWidth - 8;
    const labelWidth = labelWidths[marker.group.date];
    marker.showLabel = Boolean(labelWidth && marker.x + 18 + labelWidth <= availableEnd);
  }
  return { markers, height: groups.length ? rowEnds.length * 32 + 10 : 8 };
}
