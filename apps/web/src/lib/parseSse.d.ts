export function parseSseFrame(rawEvent: string): { event: string; data: unknown } | null;
export const HINT_TO_KEYS: Record<string, string[][]>;
export function queryKeysForInvalidation(hints?: string[]): string[][];
