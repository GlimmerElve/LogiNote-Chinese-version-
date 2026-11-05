import { createMermaidRenderQueue } from './mermaidRenderQueue';
/** One queue for every DOM-based graphics runtime, including browser previews. */
export const textbookVisualRenderQueue = createMermaidRenderQueue();
