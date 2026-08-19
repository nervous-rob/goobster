import { useEffect, useRef } from 'react';
import { GraphView } from '../renderers/graph.js';

export function GraphCanvas({
    data,
    onSelect
}: {
    data: { nodes?: unknown[]; edges?: unknown[] } | null;
    onSelect?: (node: unknown) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewRef = useRef<InstanceType<typeof GraphView> | null>(null);
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const view = new GraphView(canvas, { onSelect: onSelect || (() => {}) });
        viewRef.current = view;
        if (data) view.setData({ nodes: data.nodes || [], edges: data.edges || [] });
        return () => { view.stop(); };
    }, [onSelect]);
    useEffect(() => {
        if (data) viewRef.current?.setData({ nodes: data.nodes || [], edges: data.edges || [] });
    }, [data]);
    return <canvas ref={canvasRef} className="graph-canvas" />;
}
