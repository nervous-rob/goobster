type ToolChipDescription = { verb: string; context: string; header: string };

declare const labels: {
    TOOL_LABELS: Record<string, [string, string]>;
    toolLabel: (name: string, done: boolean) => string;
    parseArgsPreview: (preview?: string) => Record<string, unknown> | null;
    describeToolChip: (
        name: string,
        argsPreview?: string,
        opts?: { done?: boolean }
    ) => ToolChipDescription;
    chipHoverTitle: (argsPreview?: string, resultPreview?: string) => string | undefined;
};
export default labels;
