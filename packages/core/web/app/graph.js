/**
 * Knowledge-graph visualization: a force-directed layout on canvas.
 * Pairwise repulsion for small graphs; a spatial grid when the node
 * count grows past a few hundred so a 2500-node spitball stays interactive.
 *
 * Tags are first-class hubs: stronger springs, distinct diamonds, cluster
 * hulls, and a soft third axis (z) so groups can clump without tangling
 * on the plane. Hierarchy comes from withTagLinks / graphClusters.
 */

const TYPE_COLORS = {
    concept: '#7c8cff',
    fact: '#59d18c',
    opinion: '#ffb454',
    experience: '#ff7ac8',
    person: '#54c2ff',
    place: '#b18aff',
    event: '#ffd166',
    thing: '#8fe388',
    artifact: '#c9a27a',
    tag: '#a78bfa'
};

const GRID_REPEL_THRESHOLD = 180;
const Z_SCALE = 0.16;

function clusterKey(node) {
    if (!node) return null;
    if (node.cluster) return String(node.cluster);
    if (node.type === 'tag') return String(node.rootTag || node.label || '').toLowerCase() || null;
    return null;
}

function clusterHue(name) {
    const text = String(name || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return hash % 360;
}

function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

export class GraphView {
    constructor(canvas, { onSelect, colors } = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.onSelect = onSelect || (() => {});
        this.colors = colors || TYPE_COLORS;
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
        const prev = new Map(this.nodes.map((node) => [node.id, node]));
        const selectedId = this.selected?.id;
        const byId = new Map();
        const clusters = [];
        const seenCluster = new Set();
        for (const node of nodes) {
            const key = clusterKey(node);
            if (key && !seenCluster.has(key)) {
                seenCluster.add(key);
                clusters.push(key);
            }
        }
        const clusterIndex = new Map(clusters.map((name, i) => [name, i]));
        const nC = Math.max(clusters.length, 1);
        const tagList = nodes.filter((node) => node.type === 'tag');
        const dense = nodes.length > 80 || tagList.some((node) => node.collapsedHub);
        this._dense = dense;
        const ring = 240 + Math.sqrt(nodes.length) * (dense ? 22 : 10) + tagList.length * 18;
        const hubHome = new Map();
        tagList.forEach((node, i) => {
            const angle = (i / Math.max(tagList.length, 1)) * Math.PI * 2;
            hubHome.set(node.id, {
                x: Math.cos(angle) * ring,
                y: Math.sin(angle) * ring
            });
        });

        this.nodes = nodes.map((node, i) => {
            const existing = prev.get(node.id);
            const cluster = clusterKey(node);
            const ci = cluster != null ? (clusterIndex.get(cluster) ?? i) : i;
            const isTag = node.type === 'tag';
            const home = hubHome.get(node.id);
            const parentHub = !isTag && cluster
                ? tagList.find((tag) => tag.cluster === cluster || tag.label === cluster)
                : null;
            const parentHome = parentHub ? hubHome.get(parentHub.id) : null;
            const angle = (ci / nC) * Math.PI * 2 + ((i % 7) * 0.18);
            const radius = isTag
                ? 120 + ci * 6
                : 170 + (i % 6) * 26 + Math.sqrt(nodes.length) * 8;
            let seedX = Math.cos(angle) * radius;
            let seedY = Math.sin(angle) * radius;
            if (home) {
                seedX = home.x;
                seedY = home.y;
            } else if (parentHome) {
                const jitter = (i % 14) * (Math.PI * 2 / 14);
                const rad = 50 + (i % 6) * 14;
                seedX = parentHome.x + Math.cos(jitter) * rad;
                seedY = parentHome.y + Math.sin(jitter) * rad;
            }
            const z0 = cluster != null ? (ci - (nC - 1) / 2) * 38 : 0;
            const memberCount = Number(node.memberCount) || 0;
            const n = {
                ...node,
                cluster,
                x: existing?.x ?? seedX,
                y: existing?.y ?? seedY,
                z: existing?.z ?? z0,
                z0,
                vx: existing?.vx ?? 0,
                vy: existing?.vy ?? 0,
                vz: existing?.vz ?? 0,
                r: isTag
                    ? 8 + Math.min(14, memberCount * 0.35) + (node.salience ?? 0.5) * 3
                    : 5 + (node.salience ?? 0.5) * 9,
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
        this.selected = selectedId != null
            ? this.nodes.find((node) => node.id === selectedId) || null
            : null;
        if (!prev.size) {
            const fit = Math.max(0.22, Math.min(1, 90 / Math.sqrt(Math.max(nodes.length, 1))));
            this.camera = { x: 0, y: 0, zoom: fit };
        }
        this._energy = 1;
        this._resize();
        this.start();
    }

    selectById(id) {
        const node = this.nodes.find((item) => item.id === id) || null;
        this.selected = node;
        if (node) {
            this.camera.x = node.x;
            this.camera.y = node.y;
            this.camera.zoom = Math.max(this.camera.zoom, 1);
        }
        this.onSelect(node);
        this._draw();
        return node;
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

    _isTagEdge(edge) {
        return edge.kind === 'tag' || edge.relation === 'tagged' || edge.viaTag;
    }

    _isHierarchyEdge(edge) {
        return edge.kind === 'hierarchy' || edge.relation === 'part_of';
    }

    _isOverlapEdge(edge) {
        return edge.kind === 'overlap' || edge.relation === 'overlaps';
    }

    /** One physics step; cools down over time, reheats on interaction. */
    _step() {
        if (this._energy < 0.005) return;
        const nodes = this.nodes;
        const damping = 0.85;

        if (nodes.length > GRID_REPEL_THRESHOLD) this._repelGrid(nodes);
        else this._repelPairwise(nodes);

        for (const edge of this.edges) {
            const { source, target } = edge;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dz = (target.z || 0) - (source.z || 0);
            const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz * 0.35), 1);
            const tagEdge = this._isTagEdge(edge);
            const hierarchy = this._isHierarchyEdge(edge);
            const overlap = this._isOverlapEdge(edge);
            const rest = tagEdge
                ? (this._dense ? 78 : 52)
                : hierarchy ? 110
                    : overlap ? 170
                        : 90;
            const k = tagEdge
                ? (this._dense ? 0.02 : 0.014) * (0.6 + (edge.weight ?? 0.8))
                : hierarchy
                    ? 0.006 * (0.5 + (edge.weight ?? 0.45))
                    : overlap
                        ? 0.007 * (0.5 + (edge.weight ?? 0.4))
                        : 0.004 * (0.5 + (edge.weight ?? 0.5));
            const force = (dist - rest) * k;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            const fz = (dz / dist) * force * 0.4;
            source.vx += fx; source.vy += fy; source.vz = (source.vz || 0) + fz;
            target.vx -= fx; target.vy -= fy; target.vz = (target.vz || 0) - fz;
        }

        const hubs = new Map();
        for (const node of nodes) {
            if (node.type === 'tag' && node.cluster) hubs.set(node.cluster, node);
        }

        let maxV = 0;
        for (const node of nodes) {
            node.vx -= node.x * (this._dense ? 0.0008 : 0.002);
            node.vy -= node.y * (this._dense ? 0.0008 : 0.002);
            const hub = node.type !== 'tag' && node.cluster ? hubs.get(node.cluster) : null;
            if (hub) {
                const pull = this._dense ? 0.008 : 0.0035;
                node.vx += (hub.x - node.x) * pull;
                node.vy += (hub.y - node.y) * pull;
            }
            const z0 = node.z0 || 0;
            node.vz = (node.vz || 0) - ((node.z || 0) - z0) * 0.02;
            node.vx *= damping;
            node.vy *= damping;
            node.vz *= damping;
            if (node !== this._dragNode) {
                node.x += node.vx * this._energy;
                node.y += node.vy * this._energy;
                node.z = (node.z || 0) + node.vz * this._energy;
            }
            maxV = Math.max(maxV, Math.abs(node.vx), Math.abs(node.vy), Math.abs(node.vz || 0));
        }
        this._energy = Math.max(this._energy * 0.995, maxV > 0.5 ? 0.4 : 0);
    }

    _applyRepulsion(a, b) {
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = (a.z || 0) - (b.z || 0);
        let distSq = dx * dx + dy * dy + dz * dz * 0.55;
        if (distSq < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            distSq = 1;
        }
        const different = a.cluster && b.cluster && a.cluster !== b.cluster;
        const bothHubs = a.type === 'tag' && b.type === 'tag';
        const force = (
            bothHubs ? (this._dense ? 7200 : 2800)
                : different ? (this._dense ? 3600 : 2100)
                    : 1400
        ) / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force * 0.35;
        a.vx += fx; a.vy += fy; a.vz = (a.vz || 0) + fz;
        b.vx -= fx; b.vy -= fy; b.vz = (b.vz || 0) - fz;
    }

    _repelPairwise(nodes) {
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                this._applyRepulsion(a, nodes[j]);
            }
        }
    }

    /**
     * Nearby-only repulsion via a uniform grid. Each node only pushes
     * against occupants of its cell and the eight neighbors — O(n) for
     * a reasonably spread graph instead of O(n²).
     */
    _repelGrid(nodes) {
        const cell = 90;
        const buckets = new Map();
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            node._i = i;
            const key = `${Math.floor(node.x / cell)},${Math.floor(node.y / cell)}`;
            const bucket = buckets.get(key);
            if (bucket) bucket.push(node);
            else buckets.set(key, [node]);
        }
        for (const node of nodes) {
            const cx = Math.floor(node.x / cell);
            const cy = Math.floor(node.y / cell);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const neighbors = buckets.get(`${cx + dx},${cy + dy}`);
                    if (!neighbors) continue;
                    for (const other of neighbors) {
                        if (other._i <= node._i) continue;
                        this._applyRepulsion(node, other);
                    }
                }
            }
        }
    }

    _project(node) {
        const z = node.z || 0;
        return {
            x: node.x + z * Z_SCALE,
            y: node.y + z * (Z_SCALE * 0.45)
        };
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

    _drawHulls(ctx) {
        const groups = new Map();
        for (const node of this.nodes) {
            if (!node.cluster || node.id === 'you' || node.cluster === '__other__') continue;
            const list = groups.get(node.cluster);
            const p = this._project(node);
            if (list) list.push(p);
            else groups.set(node.cluster, [p]);
        }
        const zoom = this.camera.zoom;
        if (zoom > 1.6) return;
        for (const [name, points] of groups) {
            if (points.length < 3) continue;
            const hull = convexHull(points);
            if (hull.length < 3) continue;
            ctx.beginPath();
            hull.forEach((p, i) => {
                const [x, y] = this._worldToScreen(p.x, p.y);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.closePath();
            const hue = clusterHue(name);
            ctx.fillStyle = `hsla(${hue}, 42%, 52%, 0.07)`;
            ctx.strokeStyle = `hsla(${hue}, 50%, 62%, 0.22)`;
            ctx.lineWidth = 1;
            ctx.fill();
            ctx.stroke();
        }
    }

    _drawTagDiamond(ctx, x, y, r) {
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
    }

    _draw() {
        const ctx = this.ctx;
        const dpr = this._dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

        this._drawHulls(ctx);

        const neighborIds = new Set();
        if (this.selected) {
            for (const edge of this.edges) {
                if (edge.source === this.selected) neighborIds.add(edge.target.id);
                if (edge.target === this.selected) neighborIds.add(edge.source.id);
            }
        }

        const zoom = this.camera.zoom;
        for (const edge of this.edges) {
            const a = this._project(edge.source);
            const b = this._project(edge.target);
            const [x1, y1] = this._worldToScreen(a.x, a.y);
            const [x2, y2] = this._worldToScreen(b.x, b.y);
            const highlighted = this.selected
                && (edge.source === this.selected || edge.target === this.selected);
            const tagEdge = this._isTagEdge(edge);
            const hierarchy = this._isHierarchyEdge(edge);
            const overlap = this._isOverlapEdge(edge);
            if (tagEdge && !highlighted && this.nodes.length > 100 && zoom < 0.9) continue;
            if (highlighted) {
                ctx.strokeStyle = tagEdge || overlap ? 'rgba(167, 139, 250, 0.85)' : 'rgba(124, 140, 255, 0.75)';
                ctx.lineWidth = 1.6;
                ctx.setLineDash([]);
            } else if (overlap) {
                ctx.strokeStyle = `rgba(167, 139, 250, ${0.2 + (edge.weight ?? 0.4) * 0.28})`;
                ctx.lineWidth = 1.35;
                ctx.setLineDash([]);
            } else if (tagEdge) {
                ctx.strokeStyle = `rgba(167, 139, 250, ${0.18 + (edge.weight ?? 0.7) * 0.22})`;
                ctx.lineWidth = 1.15;
                ctx.setLineDash([4, 3]);
            } else if (hierarchy) {
                ctx.strokeStyle = 'rgba(167, 139, 250, 0.22)';
                ctx.lineWidth = 1.05;
                ctx.setLineDash([2, 5]);
            } else {
                ctx.strokeStyle = `rgba(150, 160, 190, ${0.12 + (edge.weight ?? 0.5) * 0.2})`;
                ctx.lineWidth = 1;
                ctx.setLineDash([]);
            }
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        const crowded = this.nodes.length > 200;
        const tagCount = this.nodes.filter((item) => item.type === 'tag').length;
        const labelZoom = crowded ? 1.05 : 0.55;
        const labelSalience = crowded ? 0.55 : 0.25;
        const hideQuietNotes = zoom < (crowded ? 0.7 : 0.45) && this.nodes.length > 40;
        for (const node of this.nodes) {
            const isTag = node.type === 'tag';
            const quiet = hideQuietNotes && !isTag && node.id !== 'you'
                && (node.salience ?? 0.5) < 0.7
                && node !== this.selected
                && !neighborIds.has(node.id);
            const projected = this._project(node);
            const [x, y] = this._worldToScreen(projected.x, projected.y);
            const color = this.colors[node.type] || this.colors.concept || '#7c8cff';
            const dimmed = this.selected && node !== this.selected && !neighborIds.has(node.id);
            const r = node.r * Math.max(zoom, 0.5) * (quiet ? 0.55 : 1);

            ctx.globalAlpha = dimmed ? 0.22 : quiet ? 0.35 : 1;
            ctx.fillStyle = color;
            if (isTag) this._drawTagDiamond(ctx, x, y, r);
            else {
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            if (node === this.selected) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                if (isTag) {
                    this._drawTagDiamond(ctx, x, y, r);
                    ctx.stroke();
                } else {
                    ctx.stroke();
                }
            }

            const label = String(node.label || '');
            const largeHub = isTag && (
                node.collapsedHub
                || (!node.satellite && (node.memberCount || 0) >= 3)
                || tagCount <= 12
                || (node.satellite && zoom > 0.75)
            );
            const showLabel = node === this.selected
                || neighborIds.has(node.id)
                || (isTag && largeHub && (zoom > 0.28 || (node.memberCount || 0) >= 8))
                || (!isTag && !quiet && zoom > labelZoom && (node.salience ?? 0.5) > labelSalience);
            if (showLabel) {
                ctx.fillStyle = dimmed ? 'rgba(230,233,242,0.35)' : (isTag ? '#d4c6ff' : '#e6e9f2');
                ctx.font = `${isTag ? '600 ' : ''}${Math.max(11, 11 * zoom)}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                const text = label.length > 26 ? `${label.slice(0, 25)}…` : label;
                ctx.fillText(text, x, y + r + 13);
            }
            ctx.globalAlpha = 1;
        }
    }

    _nodeAt(sx, sy) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const node = this.nodes[i];
            const projected = this._project(node);
            const [x, y] = this._worldToScreen(projected.x, projected.y);
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
            this.camera.zoom = Math.min(Math.max(this.camera.zoom * factor, 0.15), 3.5);
            this._draw();
        }, { passive: false });
    }
}

export { TYPE_COLORS };
