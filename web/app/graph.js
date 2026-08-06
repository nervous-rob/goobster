/**
 * Knowledge-graph visualization: a small force-directed layout on canvas.
 * No dependencies - repulsion + edge springs + centering gravity is plenty
 * for the graph's bounded size (<= 300 nodes by design).
 */

const TYPE_COLORS = {
    concept: '#7c8cff',
    fact: '#59d18c',
    opinion: '#ffb454',
    experience: '#ff7ac8',
    person: '#54c2ff',
    place: '#b18aff',
    event: '#ffd166',
    thing: '#8fe388'
};

export class GraphView {
    constructor(canvas, { onSelect } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onSelect = onSelect || (() => {});
        this.nodes = [];
        this.edges = [];
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.selected = null;
        this._dragNode = null;
        this._panFrom = null;
        this._running = false;
        this._energy = 1;

        this._bindEvents();
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement);
    }

    setData({ nodes, edges }) {
        const byId = new Map();
        // Seed positions on a ring sized to the node count, deterministic-ish
        this.nodes = nodes.map((node, i) => {
            const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
            const radius = 80 + (i % 7) * 40 + Math.sqrt(nodes.length) * 18;
            const n = {
                ...node,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                vx: 0, vy: 0,
                r: 5 + (node.salience ?? 0.5) * 9,
                degree: 0
            };
            byId.set(node.id, n);
            return n;
        });
        this.edges = edges
            .filter(e => byId.has(e.sourceId) && byId.has(e.targetId))
            .map(e => ({ ...e, source: byId.get(e.sourceId), target: byId.get(e.targetId) }));
        for (const edge of this.edges) {
            edge.source.degree++;
            edge.target.degree++;
        }
        this.selected = null;
        this.camera = { x: 0, y: 0, zoom: 1 };
        this._energy = 1;
        this._resize();
        this.start();
    }

    start() {
        if (this._running) return;
        this._running = true;
        const tick = () => {
            if (!this._running) return;
            this._step();
            this._draw();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    stop() {
        this._running = false;
    }

    _resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = parent.clientWidth * dpr;
        this.canvas.height = parent.clientHeight * dpr;
        this._dpr = dpr;
        this._draw();
    }

    /** One physics step; cools down over time, reheats on interaction. */
    _step() {
        if (this._energy < 0.005) return;
        const nodes = this.nodes;
        const damping = 0.85;

        // Pairwise repulsion
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let distSq = dx * dx + dy * dy;
                if (distSq < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distSq = 1; }
                const force = 1400 / distSq;
                const dist = Math.sqrt(distSq);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx += fx; a.vy += fy;
                b.vx -= fx; b.vy -= fy;
            }
        }

        // Edge springs (heavier edges pull tighter)
        for (const edge of this.edges) {
            const { source, target } = edge;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const rest = 90;
            const k = 0.004 * (0.5 + (edge.weight ?? 0.5));
            const force = (dist - rest) * k;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            source.vx += fx; source.vy += fy;
            target.vx -= fx; target.vy -= fy;
        }

        // Gravity toward the origin + integration
        let maxV = 0;
        for (const node of nodes) {
            node.vx -= node.x * 0.002;
            node.vy -= node.y * 0.002;
            node.vx *= damping;
            node.vy *= damping;
            if (node !== this._dragNode) {
                node.x += node.vx * this._energy;
                node.y += node.vy * this._energy;
            }
            maxV = Math.max(maxV, Math.abs(node.vx), Math.abs(node.vy));
        }
        this._energy = Math.max(this._energy * 0.995, maxV > 0.5 ? 0.4 : 0);
    }

    _worldToScreen(x, y) {
        const cx = this.canvas.width / 2 / this._dpr;
        const cy = this.canvas.height / 2 / this._dpr;
        return [
            (x - this.camera.x) * this.camera.zoom + cx,
            (y - this.camera.y) * this.camera.zoom + cy
        ];
    }

    _screenToWorld(sx, sy) {
        const cx = this.canvas.width / 2 / this._dpr;
        const cy = this.canvas.height / 2 / this._dpr;
        return [
            (sx - cx) / this.camera.zoom + this.camera.x,
            (sy - cy) / this.camera.zoom + this.camera.y
        ];
    }

    _draw() {
        const ctx = this.ctx;
        const dpr = this._dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

        const neighborIds = new Set();
        if (this.selected) {
            for (const edge of this.edges) {
                if (edge.source === this.selected) neighborIds.add(edge.target.id);
                if (edge.target === this.selected) neighborIds.add(edge.source.id);
            }
        }

        // Edges
        for (const edge of this.edges) {
            const [x1, y1] = this._worldToScreen(edge.source.x, edge.source.y);
            const [x2, y2] = this._worldToScreen(edge.target.x, edge.target.y);
            const highlighted = this.selected
                && (edge.source === this.selected || edge.target === this.selected);
            ctx.strokeStyle = highlighted
                ? 'rgba(124, 140, 255, 0.75)'
                : `rgba(150, 160, 190, ${0.12 + (edge.weight ?? 0.5) * 0.2})`;
            ctx.lineWidth = highlighted ? 1.6 : 1;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        // Nodes + labels
        const zoom = this.camera.zoom;
        for (const node of this.nodes) {
            const [x, y] = this._worldToScreen(node.x, node.y);
            const color = TYPE_COLORS[node.type] || TYPE_COLORS.concept;
            const dimmed = this.selected && node !== this.selected && !neighborIds.has(node.id);

            ctx.globalAlpha = dimmed ? 0.25 : 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, node.r * Math.max(zoom, 0.5), 0, Math.PI * 2);
            ctx.fill();
            if (node === this.selected) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            const showLabel = zoom > 0.55 && (node.salience ?? 0.5) > 0.25 || node === this.selected || neighborIds.has(node.id);
            if (showLabel) {
                ctx.fillStyle = dimmed ? 'rgba(230,233,242,0.35)' : '#e6e9f2';
                ctx.font = `${Math.max(11, 11 * zoom)}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                const label = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
                ctx.fillText(label, x, y + node.r * Math.max(zoom, 0.5) + 13);
            }
            ctx.globalAlpha = 1;
        }
    }

    _nodeAt(sx, sy) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const [x, y] = this._worldToScreen(node.x, node.y);
            const r = Math.max(node.r * this.camera.zoom, 7) + 3;
            if ((sx - x) ** 2 + (sy - y) ** 2 <= r * r) return node;
        }
        return null;
    }

    _bindEvents() {
        const canvas = this.canvas;
        const pos = (event) => {
            const rect = canvas.getBoundingClientRect();
            return [event.clientX - rect.left, event.clientY - rect.top];
        };

        canvas.addEventListener('pointerdown', (event) => {
            const [sx, sy] = pos(event);
            const node = this._nodeAt(sx, sy);
            canvas.setPointerCapture(event.pointerId);
            canvas.classList.add('dragging');
            this._moved = false;
            if (node) {
                this._dragNode = node;
                this._energy = Math.max(this._energy, 0.3);
            } else {
                this._panFrom = { sx, sy, camX: this.camera.x, camY: this.camera.y };
            }
        });

        canvas.addEventListener('pointermove', (event) => {
            const [sx, sy] = pos(event);
            if (this._dragNode) {
                const [wx, wy] = this._screenToWorld(sx, sy);
                this._dragNode.x = wx;
                this._dragNode.y = wy;
                this._moved = true;
                this._energy = Math.max(this._energy, 0.2);
                this._draw();
            } else if (this._panFrom) {
                this.camera.x = this._panFrom.camX - (sx - this._panFrom.sx) / this.camera.zoom;
                this.camera.y = this._panFrom.camY - (sy - this._panFrom.sy) / this.camera.zoom;
                this._moved = true;
                this._draw();
            }
        });

        const release = (event) => {
            if (!this._moved) {
                const [sx, sy] = pos(event);
                const node = this._nodeAt(sx, sy);
                this.selected = node || null;
                this.onSelect(node || null);
                this._draw();
            }
            this._dragNode = null;
            this._panFrom = null;
            canvas.classList.remove('dragging');
        };
        canvas.addEventListener('pointerup', release);
        canvas.addEventListener('pointercancel', release);

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const factor = event.deltaY < 0 ? 1.12 : 0.9;
            this.camera.zoom = Math.min(Math.max(this.camera.zoom * factor, 0.2), 3.5);
            this._draw();
        }, { passive: false });
    }
}

export { TYPE_COLORS };
