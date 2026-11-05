export type TextbookVisualKind = 'mermaid' | 'function-plot' | 'chart' | 'molecule';
export interface TextbookVisualInput { id: string; code: string; dark: boolean; visualKind?: TextbookVisualKind; width?: number }
export const validTextbookVisualKind = (kind: unknown) => kind === undefined || ['mermaid', 'function-plot', 'chart', 'molecule'].includes(kind as string);
