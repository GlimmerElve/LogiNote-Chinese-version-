export const PLAN_TIMELINE_BASE_WEEK_WIDTH = 140;
export const PLAN_TIMELINE_MIN_ZOOM = 100;
export const PLAN_TIMELINE_MAX_ZOOM = 2400;
export const PLAN_TIMELINE_ZOOM_STEP = 25;
export const PLAN_TIMELINE_ZOOM_STOPS = [100, 150, 200, 300, 450, 600, 900, 1200, 1600, 2400];

function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  return Math.max(0, finiteOr(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fit uses the exact viewport; zoom scales calendar columns, not the fixed label. */
export function getTimelineBoardWidth(viewportWidth: number, labelWidth: number, weekCount: number, zoom: number | null): number {
  const viewport = nonNegative(viewportWidth);
  if (zoom === null) return viewport;
  const weeks = Math.max(1, Math.floor(finiteOr(weekCount, 1)));
  const scale = clamp(finiteOr(zoom, PLAN_TIMELINE_MIN_ZOOM), PLAN_TIMELINE_MIN_ZOOM, PLAN_TIMELINE_MAX_ZOOM) / 100;
  return Math.max(viewport, nonNegative(labelWidth) + weeks * PLAN_TIMELINE_BASE_WEEK_WIDTH * scale);
}

export interface TimelineVisibleColumn {
  index: number;
  span: number;
}

/** Render just the visible dates, grouping labels when a whole plan is fitted. */
export function getTimelineVisibleColumns({
  columnCount, boardWidth, viewportWidth, labelWidth, scrollLeft, minLabelWidth = 72,
}: {
  columnCount: number;
  boardWidth: number;
  viewportWidth: number;
  labelWidth: number;
  scrollLeft: number;
  minLabelWidth?: number;
}): TimelineVisibleColumn[] {
  const count = Math.max(0, Math.floor(finiteOr(columnCount)));
  const label = nonNegative(labelWidth);
  const viewport = Math.max(0, nonNegative(viewportWidth) - label);
  const calendar = Math.max(0, nonNegative(boardWidth) - label);
  if (!count || !viewport || !calendar) return [];
  const width = calendar / count;
  const stride = Math.max(1, Math.ceil(nonNegative(minLabelWidth) / width));
  const scroll = clamp(finiteOr(scrollLeft), 0, Math.max(0, calendar - viewport));
  // One group of overscan on either side keeps scrolling smooth without a
  // DOM node for every day/week in a multi-year plan.
  const first = Math.max(0, (Math.floor(scroll / width / stride) - 1) * stride);
  const last = Math.min(count, (Math.ceil((scroll + viewport) / width / stride) + 1) * stride);
  const columns: TimelineVisibleColumn[] = [];
  for (let index = first; index < last; index += stride) {
    columns.push({ index, span: Math.min(stride, count - index) });
  }
  return columns;
}

export interface TimelineZoomScrollOptions {
  scrollLeft: number;
  viewportWidth: number;
  labelWidth: number;
  previousBoardWidth: number;
  nextBoardWidth: number;
  anchorRatio?: number;
}

/** Preserve the date under the chosen point of the visible calendar area. */
export function getTimelineZoomScrollLeft({
  scrollLeft, viewportWidth, labelWidth, previousBoardWidth, nextBoardWidth, anchorRatio = 0.5,
}: TimelineZoomScrollOptions): number {
  const viewport = nonNegative(viewportWidth);
  const label = nonNegative(labelWidth);
  const previousBoard = nonNegative(previousBoardWidth);
  const nextBoard = nonNegative(nextBoardWidth);
  const previousCalendarWidth = Math.max(0, previousBoard - label);
  if (previousCalendarWidth === 0) return 0;
  const anchor = Math.max(0, viewport - label) * clamp(finiteOr(anchorRatio, 0.5), 0, 1);
  const previousScroll = clamp(finiteOr(scrollLeft), 0, Math.max(0, previousBoard - viewport));
  const dateRatio = clamp((previousScroll + anchor) / previousCalendarWidth, 0, 1);
  return clamp(dateRatio * Math.max(0, nextBoard - label) - anchor, 0, Math.max(0, nextBoard - viewport));
}

export interface TimelineDateScrollOptions {
  datePercent: number;
  boardWidth: number;
  viewportWidth: number;
  labelWidth: number;
}

/** Center a date within the visible calendar area, respecting both scroll edges. */
export function getTimelineDateScrollLeft({ datePercent, boardWidth, viewportWidth, labelWidth }: TimelineDateScrollOptions): number {
  const board = nonNegative(boardWidth);
  const viewport = nonNegative(viewportWidth);
  const label = nonNegative(labelWidth);
  const dateRatio = clamp(finiteOr(datePercent), 0, 100) / 100;
  const calendarWidth = Math.max(0, board - label);
  const visibleCalendarWidth = Math.max(0, viewport - label);
  return clamp(dateRatio * calendarWidth - visibleCalendarWidth / 2, 0, Math.max(0, board - viewport));
}
