// ESM façade so Vite/TS named-import the CommonJS helpers.
import labels from './toolChipLabel.cjs';

export const toolLabel = labels.toolLabel as (name: string, done: boolean) => string;
export const parseArgsPreview = labels.parseArgsPreview as (preview?: string) => Record<string, unknown> | null;
export const describeToolChip = labels.describeToolChip as (
    name: string,
    argsPreview?: string,
    opts?: { done?: boolean }
) => { verb: string; context: string; header: string };
export const chipHoverTitle = labels.chipHoverTitle as (
    argsPreview?: string,
    resultPreview?: string
) => string | undefined;
