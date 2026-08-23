export const TYPE_COLORS: Record<string, string>;

export class GraphView {
    constructor(canvas: HTMLCanvasElement, opts?: {
        onSelect?: (node: unknown) => void;
        colors?: Record<string, string>;
    });
    setData(data: { nodes: unknown[]; edges: unknown[] }): void;
    selectById(id: string | number): unknown;
    stop(): void;
}
