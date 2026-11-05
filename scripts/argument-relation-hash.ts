import { createHash } from 'node:crypto';

export const relationFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
