declare const parseSse: {
    parseSseFrame: (rawEvent: string) => { event: string; data: unknown } | null;
    queryKeysForInvalidation: (hints?: string[]) => string[][];
    HINT_TO_KEYS: Record<string, string[][]>;
};
export default parseSse;
