/**
 * Harmonic Space canvas: 12 pitch-class stars on an orbitable 3-D ring.
 * Node targets (azimuth + brightness height) come from the engine; the scene
 * eases nodes toward them so arrangement morphs and helix lifts animate.
 * Projection is a simple perspective camera orbited by yaw/pitch.
 */

export const SPW = 800;
export const SPH = 520;

const CX = SPW / 2;
const CY = SPH / 2 + 14;
const RING_RADIUS = 168;
const FOCAL = 760;

export interface SpaceNodeView {
  pc: number;
  label: string;
  inScale: boolean;
  isTonic: boolean;
  /** 0-based scale degree when in scale. */
  degreeIndex: number | null;
  /** Target azimuth in radians (0 = top of the ring). */
  angle: number;
  /** Target world height (brightness axis, up positive). */
  height: number;
  hue: number;
}

export interface SpaceView {
  /** Indexed by pitch class 0..11. */
  nodes: SpaceNodeView[];
  /** Scale pitch classes ordered dark → bright, for the glowing arc. */
  scaleOrder: number[];
  chordPcs: number[] | null;
  chordHue: number;
  /** Interval beam target (beam starts at the tonic). */
  intervalPc: number | null;
  intervalHue: number;
  tonicPc: number;
}

interface NodeVis {
  angle: number;
  height: number;
  glow: number;
}

interface ProjectedNode {
  x: number;
  y: number;
  /** Screen position of the same azimuth at height 0 (for brightness stems). */
  floorX: number;
  floorY: number;
  depth: number;
  scale: number;
  radius: number;
}

export interface SpaceSceneState {
  nodes: NodeVis[] | null;
  yaw: number;
  pitch: number;
  zoom: number;
  projected: ProjectedNode[];
  stars: { x: number; y: number; r: number; phase: number }[];
}

export function createSpaceScene(): SpaceSceneState {
  const stars: SpaceSceneState['stars'] = [];
  let seed = 9;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 110; i++) {
    stars.push({ x: rand() * SPW, y: rand() * SPH, r: 0.4 + rand() * 1.1, phase: rand() * Math.PI * 2 });
  }
  return { nodes: null, yaw: -0.6, pitch: 0.46, zoom: 1, projected: [], stars };
}

export function orbitSpace(state: SpaceSceneState, dx: number, dy: number): void {
  state.yaw += dx * 0.006;
  state.pitch = Math.max(0.06, Math.min(1.25, state.pitch + dy * 0.005));
}

export function zoomSpace(state: SpaceSceneState, deltaY: number): void {
  state.zoom = Math.max(0.65, Math.min(1.6, state.zoom * (1 - deltaY * 0.0011)));
}

export function pulseSpaceNode(state: SpaceSceneState, pc: number, amount = 1): void {
  const vis = state.nodes?.[pc];
  if (vis) vis.glow = Math.max(vis.glow, Math.min(1.2, amount));
}

/** Picks the frontmost node within reach of a canvas-space point, or null. */
export function pickSpaceNode(state: SpaceSceneState, x: number, y: number): number | null {
  let best: number | null = null;
  let bestDepth = Infinity;
  state.projected.forEach((p, pc) => {
    const dist = Math.hypot(p.x - x, p.y - y);
    if (dist <= p.radius + 9 && p.depth < bestDepth) {
      best = pc;
      bestDepth = p.depth;
    }
  });
  return best;
}

function project(state: SpaceSceneState, azimuth: number, height: number): { x: number; y: number; depth: number; scale: number } {
  const az = azimuth + state.yaw;
  const px = RING_RADIUS * Math.sin(az);
  const pz = RING_RADIUS * Math.cos(az);
  const cosP = Math.cos(state.pitch);
  const sinP = Math.sin(state.pitch);
  const y2 = height * cosP - pz * sinP;
  const z2 = height * sinP + pz * cosP;
  const scale = (FOCAL / (FOCAL + z2)) * state.zoom;
  return { x: CX + px * scale, y: CY - y2 * scale, depth: z2, scale };
}

function shortestAngle(from: number, to: number): number {
  const TAU = Math.PI * 2;
  return ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function depthAlpha(depth: number, near = 0.95, far = 0.35): number {
  const f = (depth + RING_RADIUS) / (2 * RING_RADIUS); // 0 near .. 1 far
  return near + (far - near) * Math.max(0, Math.min(1, f));
}

function strokePath(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[], style: string, width: number): void {
  if (points.length < 2) return;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.stroke();
}

export function renderSpace(
  ctx: CanvasRenderingContext2D,
  view: SpaceView,
  state: SpaceSceneState,
  t: number,
  dt: number,
  autoSpin: boolean
): void {
  // --- Advance scene state toward targets ---
  if (!state.nodes) {
    state.nodes = view.nodes.map(n => ({ angle: n.angle, height: n.height, glow: 0 }));
  }
  const ease = Math.min(1, dt * 4.5);
  view.nodes.forEach((target, pc) => {
    const vis = state.nodes![pc];
    vis.angle += shortestAngle(vis.angle, target.angle) * ease;
    vis.height += (target.height - vis.height) * ease;
    vis.glow = Math.max(0, vis.glow - dt * 1.7);
  });
  if (autoSpin) state.yaw += dt * 0.1;

  // --- Project everything once ---
  state.projected = state.nodes.map(vis => {
    const p = project(state, vis.angle, vis.height);
    const floor = project(state, vis.angle, 0);
    return { x: p.x, y: p.y, floorX: floor.x, floorY: floor.y, depth: p.depth, scale: p.scale, radius: 0 };
  });

  // --- Background ---
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, SPW, SPH);
  state.stars.forEach(s => {
    const tw = 0.45 + 0.4 * Math.sin(t * 0.8 + s.phase);
    ctx.fillStyle = `rgba(190, 205, 235, ${0.12 + tw * 0.18})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
  const glow = ctx.createRadialGradient(CX, CY, 10, CX, CY, 260);
  glow.addColorStop(0, 'rgba(60, 90, 140, 0.16)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SPW, SPH);

  // --- Brightness axis (only meaningful once the helix has lift) ---
  const maxAbsHeight = Math.max(...state.nodes.map(n => Math.abs(n.height)));
  if (maxAbsHeight > 4) {
    // The axis runs through the ring's centre (radius 0), so only pitch
    // affects it: project the two endpoints directly.
    const cosP = Math.cos(state.pitch);
    const axisX = CX;
    const top = { y: CY - (maxAbsHeight + 26) * cosP * state.zoom };
    const bottom = { y: CY + (maxAbsHeight + 26) * cosP * state.zoom };
    const alpha = Math.min(0.3, maxAbsHeight / 320);
    ctx.strokeStyle = `rgba(150, 190, 230, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.moveTo(axisX, top.y);
    ctx.lineTo(axisX, bottom.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(170, 205, 240, ${alpha + 0.18})`;
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BRIGHTER', axisX, top.y - 6);
    ctx.fillText('DARKER', axisX, bottom.y + 13);
  }

  // --- Ring guide: neighbours by current azimuth, so it follows the morph ---
  const byAngle = state.projected
    .map((_p, pc) => ({ pc, az: ((state.nodes![pc].angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) }))
    .sort((a, b) => a.az - b.az);
  for (let i = 0; i < byAngle.length; i++) {
    const a = state.projected[byAngle[i].pc];
    const b = state.projected[byAngle[(i + 1) % byAngle.length].pc];
    const alpha = 0.16 * depthAlpha((a.depth + b.depth) / 2, 1, 0.4);
    strokePath(ctx, [a, b], `rgba(140, 165, 205, ${alpha})`, 1);
  }

  // --- Brightness stems for scale tones ---
  state.projected.forEach((p, pc) => {
    const node = view.nodes[pc];
    if (!node.inScale || Math.abs(state.nodes![pc].height) < 3) return;
    strokePath(
      ctx,
      [p, { x: p.floorX, y: p.floorY }],
      `hsla(${node.hue}, 70%, 70%, ${0.12 * depthAlpha(p.depth, 1, 0.4)})`,
      1
    );
  });

  // --- Scale arc: the run of consecutive fifths ---
  for (let i = 0; i < view.scaleOrder.length - 1; i++) {
    const a = state.projected[view.scaleOrder[i]];
    const b = state.projected[view.scaleOrder[i + 1]];
    const hue = (view.nodes[view.scaleOrder[i]].hue + view.nodes[view.scaleOrder[i + 1]].hue) / 2;
    const alpha = depthAlpha((a.depth + b.depth) / 2);
    strokePath(ctx, [a, b], `hsla(${hue}, 85%, 62%, ${0.18 * alpha})`, 6);
    strokePath(ctx, [a, b], `hsla(${hue}, 85%, 70%, ${0.75 * alpha})`, 1.8);
  }

  // --- Chord constellation triangle ---
  if (view.chordPcs && view.chordPcs.length >= 3) {
    const pts = view.chordPcs.map(pc => state.projected[pc]);
    const pulse = 0.1 + 0.05 * Math.sin(t * 2.4);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = `hsla(${view.chordHue}, 85%, 62%, ${pulse})`;
    ctx.fill();
    ctx.strokeStyle = `hsla(${view.chordHue}, 85%, 66%, 0.7)`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // --- Interval beam from home ---
  if (view.intervalPc !== null) {
    const a = state.projected[view.tonicPc];
    if (view.intervalPc === view.tonicPc) {
      // Unison / octave: the same star — breathe a halo instead of a beam.
      const r = 18 + 5 * Math.sin(t * 2.2);
      ctx.strokeStyle = `hsla(${view.intervalHue}, 85%, 70%, 0.55)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r * a.scale, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const b = state.projected[view.intervalPc];
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, 'rgba(235, 240, 250, 0.75)');
      grad.addColorStop(1, `hsla(${view.intervalHue}, 90%, 62%, 0.85)`);
      strokePath(ctx, [a, b], `hsla(${view.intervalHue}, 90%, 60%, 0.18)`, 7);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const frac = (t * 0.55) % 1;
      const px = a.x + (b.x - a.x) * frac;
      const py = a.y + (b.y - a.y) * frac;
      ctx.fillStyle = `hsla(${view.intervalHue}, 95%, 75%, 0.95)`;
      ctx.beginPath();
      ctx.arc(px, py, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- Nodes, far to near ---
  const order = state.projected.map((_, pc) => pc).sort((a, b) => state.projected[b].depth - state.projected[a].depth);
  ctx.textAlign = 'center';
  order.forEach(pc => {
    const node = view.nodes[pc];
    const vis = state.nodes![pc];
    const p = state.projected[pc];
    const baseR = node.isTonic ? 14.5 : node.inScale ? 11 : 7.5;
    const r = baseR * p.scale * (1 + vis.glow * 0.3);
    state.projected[pc].radius = r;
    const alpha = depthAlpha(p.depth);

    if (node.inScale) {
      const grad = ctx.createRadialGradient(p.x - r * 0.25, p.y - r * 0.3, r * 0.1, p.x, p.y, r);
      grad.addColorStop(0, `hsla(${node.hue}, 90%, 88%, ${alpha})`);
      grad.addColorStop(0.55, `hsla(${node.hue}, 85%, 60%, ${alpha})`);
      grad.addColorStop(1, `hsla(${node.hue}, 85%, 42%, ${alpha * 0.85})`);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = `hsla(225, 18%, 42%, ${alpha * 0.55})`;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    if (node.isTonic) {
      const haloR = r + 4.5 + 1.6 * Math.sin(t * 2.6);
      ctx.strokeStyle = `hsla(${node.hue}, 90%, 78%, ${0.7 * alpha})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (vis.glow > 0.02) {
      ctx.strokeStyle = `hsla(${node.hue}, 95%, 80%, ${Math.min(0.9, vis.glow)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 3 + (1 - vis.glow) * 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    const labelSize = Math.max(8, (node.inScale ? 11.5 : 9.5) * p.scale);
    ctx.font = `${node.isTonic ? 700 : 400} ${labelSize}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = node.inScale ? `rgba(235, 240, 250, ${alpha})` : `rgba(160, 172, 198, ${alpha * 0.55})`;
    ctx.fillText(node.label, p.x, p.y + r + labelSize + 2);
    if (node.degreeIndex !== null) {
      ctx.font = `${Math.max(7, 8.5 * p.scale)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillStyle = `hsla(${node.hue}, 80%, 80%, ${alpha * 0.85})`;
      ctx.fillText(node.isTonic ? '◆ 1' : String(node.degreeIndex + 1), p.x, p.y - r - 5);
    }
  });
}
