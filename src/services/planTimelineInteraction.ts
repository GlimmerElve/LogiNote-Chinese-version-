const DAY_MS = 86_400_000;

export const PLAN_COMPOSER_ZOOM_STOPS = [8, 12, 16, 20, 24, 32, 48, 72, 96, 144, 224, 320, 480];

export interface TimelineInterval {
  key: string;
  start: number;
  /** Exclusive calendar end, not the visual width of the card. */
  end: number;
}

export interface TimelinePackedRow {
  laneByKey: Map<string, number>;
  laneCount: number;
}

/** Adjacent days share a lane; only actual calendar overlaps need another lane. */
export function packTimelineIntervals(intervals: TimelineInterval[]): TimelinePackedRow {
  const laneEnds: number[] = [];
  const laneByKey = new Map<string, number>();
  [...intervals].sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key))
    .forEach((interval) => {
      let lane = laneEnds.findIndex((end) => interval.start >= end);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = interval.end;
      laneByKey.set(interval.key, lane);
    });
  return { laneByKey, laneCount: Math.max(1, laneEnds.length) };
}

/** Keep the time geometry exact even at overview zoom; never inflate a short task. */
export function getTimelineBlockWidth(durationDays: number, pixelsPerDay: number): number {
  return Math.max(1, durationDays) * pixelsPerDay - Math.min(4, pixelsPerDay * 0.2);
}

/** The solid preview snaps to days; this non-interactive outline follows sub-day travel. */
export function getTimelinePointerOutline(
  left: number, width: number, pixelRemainder: number, mode: 'move' | 'resize-start' | 'resize-end',
): { left: number; width: number } {
  return {
    left: left + (mode === 'resize-end' ? 0 : pixelRemainder),
    width: width + (mode === 'resize-end' ? pixelRemainder : mode === 'resize-start' ? -pixelRemainder : 0),
  };
}

/** Match the existing 60 Hz speed without accelerating on high-refresh displays. */
export function getTimelineAutoScrollDistance(velocityPerFrame: number, elapsedMs: number): number {
  return velocityPerFrame * Math.max(0, Math.min(32, elapsedMs)) / (1000 / 60);
}

/** Calendar length may grow to fill the viewport; anchor by day, not board percentage. */
export function getTimelineDayZoomScrollLeft(
  scrollLeft: number, viewportWidth: number, labelWidth: number,
  previousPixelsPerDay: number, pixelsPerDay: number, boardWidth: number,
): number {
  const anchor = Math.max(0, viewportWidth - labelWidth) / 2;
  const next = (scrollLeft + anchor) / Math.max(1, previousPixelsPerDay) * pixelsPerDay - anchor;
  return Math.max(0, Math.min(Math.max(0, boardWidth - viewportWidth), next));
}

/** Pointer travel includes scrolling and preserves where the user grabbed the block. */
export function getTimelineGestureDays(
  startClientX: number, clientX: number, pixelsPerDay: number,
  startScrollLeft: number, scrollLeft: number,
): number {
  return (clientX - startClientX + scrollLeft - startScrollLeft) / Math.max(1, pixelsPerDay);
}

export function resizeTimelineWindow(
  startDate: string, dueDate: string, dayDelta: number, edge: 'start' | 'end',
  minimumDate?: string, maximumDate?: string,
): { startDate: string; dueDate: string; appliedDays: number } {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${dueDate}T00:00:00Z`);
  const minimum = minimumDate ? Date.parse(`${minimumDate}T00:00:00Z`) : -Infinity;
  const maximum = maximumDate ? Date.parse(`${maximumDate}T00:00:00Z`) : Infinity;
  const delta = Math.round(dayDelta) * DAY_MS;
  const nextStart = edge === 'start' ? Math.max(minimum, Math.min(end, start + delta)) : start;
  const nextEnd = edge === 'end' ? Math.min(maximum, Math.max(start, end + delta)) : end;
  return {
    startDate: new Date(nextStart).toISOString().slice(0, 10),
    dueDate: new Date(nextEnd).toISOString().slice(0, 10),
    appliedDays: ((edge === 'start' ? nextStart - start : nextEnd - end)) / DAY_MS,
  };
}
