/** Shared pixel bounds for the renderer toolbar and Electron's native page view. */
export function resourceWorkbenchLayout(width: number, height: number, hasSearchTabs: boolean) {
  const sidebarWidth = width <= 1120 ? 340 : 390;
  const toolbarHeight = hasSearchTabs ? 176 : 64;
  return { sidebarWidth, toolbarHeight,
    page: { x: 0, y: toolbarHeight, width: Math.max(0, width - sidebarWidth), height: Math.max(0, height - toolbarHeight) },
  };
}
