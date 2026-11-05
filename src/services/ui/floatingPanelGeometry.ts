export interface FloatingPanelBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FloatingPanelViewport {
  width: number;
  height: number;
}

export type FloatingPanelResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export const FLOATING_PANEL_MARGIN = 8;
export const FLOATING_PANEL_MIN_WIDTH = 320;
export const FLOATING_PANEL_MIN_HEIGHT = 360;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function clampFloatingPanelBounds(
  bounds: FloatingPanelBounds,
  viewport: FloatingPanelViewport,
  margin = FLOATING_PANEL_MARGIN,
): FloatingPanelBounds {
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const availableHeight = Math.max(1, viewport.height - margin * 2);
  const minWidth = Math.min(FLOATING_PANEL_MIN_WIDTH, availableWidth);
  const minHeight = Math.min(FLOATING_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(bounds.width, minWidth, availableWidth);
  const height = clamp(bounds.height, minHeight, availableHeight);
  return {
    left: clamp(bounds.left, margin, viewport.width - margin - width),
    top: clamp(bounds.top, margin, viewport.height - margin - height),
    width,
    height,
  };
}

export function moveFloatingPanel(
  start: FloatingPanelBounds,
  deltaX: number,
  deltaY: number,
  viewport: FloatingPanelViewport,
): FloatingPanelBounds {
  return clampFloatingPanelBounds({
    ...start,
    left: start.left + deltaX,
    top: start.top + deltaY,
  }, viewport);
}

export function resizeFloatingPanel(
  startBounds: FloatingPanelBounds,
  direction: FloatingPanelResizeDirection,
  deltaX: number,
  deltaY: number,
  viewport: FloatingPanelViewport,
): FloatingPanelBounds {
  const start = clampFloatingPanelBounds(startBounds, viewport);
  const margin = FLOATING_PANEL_MARGIN;
  const minWidth = Math.min(FLOATING_PANEL_MIN_WIDTH, viewport.width - margin * 2);
  const minHeight = Math.min(FLOATING_PANEL_MIN_HEIGHT, viewport.height - margin * 2);
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  let { left, top, width, height } = start;

  if (direction.includes('e')) {
    width = clamp(start.width + deltaX, minWidth, viewport.width - margin - start.left);
  }
  if (direction.includes('w')) {
    left = clamp(start.left + deltaX, margin, right - minWidth);
    width = right - left;
  }
  if (direction.includes('s')) {
    height = clamp(start.height + deltaY, minHeight, viewport.height - margin - start.top);
  }
  if (direction.includes('n')) {
    top = clamp(start.top + deltaY, margin, bottom - minHeight);
    height = bottom - top;
  }

  return clampFloatingPanelBounds({ left, top, width, height }, viewport);
}

export function centerFloatingPanel(
  viewport: FloatingPanelViewport,
  width: number,
  height: number,
): FloatingPanelBounds {
  return clampFloatingPanelBounds({
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  }, viewport);
}
