import { createContext } from 'react';

export const InteractiveFigureContext = createContext<null | { open(brief: string): void }>(null);
