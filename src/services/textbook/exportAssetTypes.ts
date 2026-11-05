export interface StyledExportAssets { visuals?: Record<string, string>; images?: Record<string, string>; sourceIds?: string[] }
export const exportVisualKey = (language: string, code: string) => `${language}\u0000${code}`;
