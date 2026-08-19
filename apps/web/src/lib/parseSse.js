// ESM façade over the CommonJS parser so Vite/TS named-import it.
import parseSse from './parseSse.cjs';

export const parseSseFrame = parseSse.parseSseFrame;
export const queryKeysForInvalidation = parseSse.queryKeysForInvalidation;
export const HINT_TO_KEYS = parseSse.HINT_TO_KEYS;
