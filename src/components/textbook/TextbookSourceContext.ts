import { createContext } from 'react';
import type { SourceReferenceProps } from './SourceReference';

// Citation data can refresh without reparsing/repainting the diagram that owns
// the citation. Explicit source props still take precedence in other readers.
export const TextbookSourceContext = createContext<Omit<SourceReferenceProps, 'sourceId' | 'manifest'> | null>(null);
