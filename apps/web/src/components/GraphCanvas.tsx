import { useEffect, useMemo, useRef } from 'react';
import { GraphView } from '../renderers/graph.js';

type GraphPayload = {
    nodes?: Array<{ id?: string | number; cluster?: string | null }>;
    edges?: unknown[];
};

function graphSignature(data: GraphPayload | null): string {
    if (!data) return '';
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    return [
        nodes.length,
        edges.length,
        nodes.map((node) => `${node.id}:${node.cluster || ''}`).join(','),
        edges.map((edge) => {
            const row = edge as { sourceId?: string | number; targetId?: string | number };
            return `${row.sourceId}>${row.targetId}`;
        }).join(',')
    ].join('|');
}

export function GraphCanvas({
    data,
    onSelect,
    selectId
}: {
    data: GraphPayload | null;
    onSelect?: (node: unknown) => void;
    selectId?: string | number | null;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewRef = useRef<InstanceType<typeof GraphView> | null>(null);
    const signature = useMemo(() => graphSignature(data), [data]);
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
    }, [signature, data]);
    useEffect(() => {
        if (selectId == null) return;
        viewRef.current?.selectById(selectId);
    }, [selectId, signature]);
    return <canvas ref={canvasRef} className="graph-canvas" aria-label="Knowledge graph" />;
}
