import { useEffect, useRef } from 'react';
import { GraphView } from '../renderers/graph.js';

export function GraphCanvas({
    data,
    onSelect,
    selectId
}: {
    data: { nodes?: unknown[]; edges?: unknown[] } | null;
    onSelect?: (node: unknown) => void;
    selectId?: string | number | null;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewRef = useRef<InstanceType<typeof GraphView> | null>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const view = new GraphView(canvas, { onSelect: onSelect || (() => {}) });
        viewRef.current = view;
        if (data) view.setData({ nodes: data.nodes || [], edges: data.edges || [] });
        return () => { view.stop(); viewRef.current = null; };
    }, [onSelect]);
    useEffect(() => {
        if (data) viewRef.current?.setData({ nodes: data.nodes || [], edges: data.edges || [] });
    }, [data]);
    useEffect(() => {
        if (selectId == null) return;
        viewRef.current?.selectById(selectId);
    }, [selectId, data]);
    return <canvas ref={canvasRef} className="graph-canvas" aria-label="Knowledge graph" />;
}
