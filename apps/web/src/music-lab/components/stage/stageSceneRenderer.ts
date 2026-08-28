import type { PerformerRole } from '@music-lab/lib/stageData';

/**
 * Shared stage canvas: the whole troupe performs together. Visual state is
 * keyed by performer id so the cast can grow and shrink; x-positions are
 * computed from cast order. Tonal creatures take their hue from their voice.
 */

export const SW = 800;
export const SH = 380;
const FLOOR_Y = 318;

interface CreatureVis {
  /** Trigger bounce 0..1, decays each frame. */
  spring: number;
  /** Smoothed pitch height 0..1 for single-note creatures. */
  pitch: number;
  pitchTarget: number;
}

export interface StageSceneState {
  creatures: Map<string, CreatureVis>;
}

export interface StagePerformerVisual {
  id: string;
  role: PerformerRole;
  enabled: boolean;
  mute: boolean;
  label: string;
  /** Voice hue for tonal creatures; drums use their fixed role hue. */
  hue?: number;
  /** Chord organisms: rib count from the active chord. */
  ribs?: number;
}

const DRUM_HUE: Record<'kick' | 'snare' | 'hihat', number> = {
  kick: 36,
  snare: 6,
  hihat: 52
};

function freshVis(): CreatureVis {
  return { spring: 0, pitch: 0.4, pitchTarget: 0.4 };
}

export function createStageScene(): StageSceneState {
  return { creatures: new Map() };
}

function visFor(state: StageSceneState, id: string): CreatureVis {
  let vis = state.creatures.get(id);
  if (!vis) {
    vis = freshVis();
    state.creatures.set(id, vis);
  }
  return vis;
}

export function triggerStageCreature(
  state: StageSceneState,
  id: string,
  role: PerformerRole,
  intensity: number,
  midi?: number
): void {
  const vis = visFor(state, id);
  vis.spring = Math.max(vis.spring, Math.min(1, intensity));
  if (midi !== undefined) {
    const range: [number, number] = role === 'bass' ? [26, 56] : [56, 96];
    vis.pitchTarget = Math.min(1, Math.max(0, (midi - range[0]) / (range[1] - range[0])));
  }
}

function advance(state: StageSceneState, dt: number): void {
  state.creatures.forEach(vis => {
    vis.spring = Math.max(0, vis.spring - dt * 2.6);
    vis.pitch += (vis.pitchTarget - vis.pitch) * Math.min(1, dt * 10);
  });
}

function hueFor(p: StagePerformerVisual): number {
  if (p.role === 'kick' || p.role === 'snare' || p.role === 'hihat') return DRUM_HUE[p.role];
  return p.hue ?? 165;
}

function drawSpotlight(ctx: CanvasRenderingContext2D, x: number, hue: number, energy: number): void {
  const grad = ctx.createRadialGradient(x, FLOOR_Y, 8, x, FLOOR_Y, 95);
  grad.addColorStop(0, `hsla(${hue}, 80%, 60%, ${0.12 + energy * 0.22})`);
  grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, FLOOR_Y, 95, 26, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawEyes(ctx: CanvasRenderingContext2D, x: number, y: number, spacing: number, size: number, alpha: number): void {
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.beginPath();
  ctx.arc(x - spacing, y, size, 0, Math.PI * 2);
  ctx.arc(x + spacing, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(17, 17, 17, ${alpha})`;
  ctx.beginPath();
  ctx.arc(x - spacing, y + size * 0.2, size * 0.45, 0, Math.PI * 2);
  ctx.arc(x + spacing, y + size * 0.2, size * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function bodyFill(hue: number, light: number, alpha: number): string {
  return `hsla(${hue}, 68%, ${light}%, ${alpha})`;
}

function drawStomper(ctx: CanvasRenderingContext2D, x: number, vis: CreatureVis, hue: number, alpha: number, t: number): void {
  const squash = vis.spring;
  const sx = 1 + squash * 0.32;
  const sy = 1 - squash * 0.34;
  const w = 58 * sx;
  const h = 50 * sy;
  const bob = Math.sin(t * 1.4) * 2;
  const cy = FLOOR_Y - h + bob * (1 - squash);

  ctx.fillStyle = bodyFill(hue, 28, alpha);
  ctx.beginPath();
  ctx.ellipse(x - w * 0.55, FLOOR_Y - 5, 17, 9, 0, 0, Math.PI * 2);
  ctx.ellipse(x + w * 0.55, FLOOR_Y - 5, 17, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = bodyFill(hue, 45 + squash * 18, alpha);
  ctx.beginPath();
  ctx.ellipse(x, cy, w, h, 0, 0, Math.PI * 2);
  ctx.fill();

  drawEyes(ctx, x, cy - h * 0.2, 16, 6.5, alpha);
}

function drawSnapper(ctx: CanvasRenderingContext2D, x: number, vis: CreatureVis, hue: number, alpha: number, t: number): void {
  const recoil = vis.spring;
  const tilt = -recoil * 0.22;
  const cy = FLOOR_Y - 42 + Math.sin(t * 1.8) * 2.5;

  ctx.save();
  ctx.translate(x, cy);
  ctx.rotate(tilt);

  ctx.fillStyle = bodyFill(hue, 48 + recoil * 16, alpha);
  ctx.beginPath();
  ctx.ellipse(0, 0, 40, 34, 0, 0, Math.PI * 2);
  ctx.fill();

  const jawOpen = recoil * 14;
  ctx.strokeStyle = bodyFill(hue, 70, alpha);
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(14, 10);
  ctx.lineTo(38, 10 - jawOpen);
  ctx.moveTo(14, 14);
  ctx.lineTo(38, 14 + jawOpen * 0.4);
  ctx.stroke();

  drawEyes(ctx, -4, -10, 11, 5.5, alpha);
  ctx.restore();
}

function drawSkitterer(ctx: CanvasRenderingContext2D, x0: number, vis: CreatureVis, hue: number, alpha: number, t: number): void {
  const jitter = Math.sin(t * 42) * 4 * vis.spring;
  const x = x0 + jitter;
  const cy = FLOOR_Y - 28 + Math.sin(t * 3.1) * 2;

  ctx.strokeStyle = bodyFill(hue, 40, alpha);
  ctx.lineWidth = 2.5;
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    const wiggle = Math.sin(t * 12 + i) * 3 * (0.4 + vis.spring);
    ctx.beginPath();
    ctx.moveTo(x + i * 7, cy + 12);
    ctx.lineTo(x + i * 11 + wiggle, FLOOR_Y - 2);
    ctx.stroke();
  }

  ctx.fillStyle = bodyFill(hue, 52 + vis.spring * 22, alpha);
  ctx.beginPath();
  ctx.ellipse(x, cy, 25, 19, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = bodyFill(hue, 68, alpha);
  for (let i = -1; i <= 1; i++) {
    const sx = x + i * 9;
    ctx.beginPath();
    ctx.moveTo(sx - 4, cy - 16);
    ctx.lineTo(sx, cy - 26 - vis.spring * 6);
    ctx.lineTo(sx + 4, cy - 16);
    ctx.closePath();
    ctx.fill();
  }

  drawEyes(ctx, x, cy - 4, 9, 4.5, alpha);
}

function drawOrganism(
  ctx: CanvasRenderingContext2D,
  x: number,
  vis: CreatureVis,
  hue: number,
  ribCount: number,
  alpha: number,
  t: number
): void {
  const breath = Math.sin(t * 1.6) * 0.04;
  const pulse = vis.spring;
  const scale = 1 + breath + pulse * 0.16;
  const wobble = Math.sin(t * 5) * pulse * 3;
  const ribs = Math.min(5, Math.max(3, ribCount));

  ctx.save();
  ctx.translate(x + wobble, FLOOR_Y);
  ctx.scale(scale, scale);

  for (let i = 0; i < ribs; i++) {
    const ribW = 56 - i * 9;
    const ribY = -16 - i * 22;
    const light = 36 + i * 7 + pulse * 18;
    ctx.fillStyle = `hsla(${hue}, 64%, ${light}%, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(0, ribY, ribW, 11.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const coreY = -16 - (ribs - 1) * 11;
  const grad = ctx.createRadialGradient(0, coreY, 2, 0, coreY, 40);
  grad.addColorStop(0, `hsla(${hue}, 90%, 70%, ${(0.25 + pulse * 0.45) * alpha})`);
  grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(-44, coreY - 44, 88, 88);

  drawEyes(ctx, 0, -16 - (ribs - 0.6) * 22, 12, 5.5, alpha);
  ctx.restore();
}

function drawSerpent(ctx: CanvasRenderingContext2D, x: number, vis: CreatureVis, hue: number, alpha: number, t: number): void {
  const headY = FLOOR_Y - 34 - vis.pitch * 64;
  const segs = 9;
  const span = 100;

  ctx.strokeStyle = bodyFill(hue, 46 + vis.spring * 18, alpha);
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const p = i / segs;
    const px = x - span / 2 + p * span;
    const undulate = Math.sin(t * 3 + p * Math.PI * 2.2) * (7 + vis.spring * 9) * (1 - p * 0.4);
    const py = FLOOR_Y - 10 + undulate - p * (FLOOR_Y - 10 - headY);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  const headX = x + span / 2;
  ctx.fillStyle = bodyFill(hue, 54 + vis.spring * 20, alpha);
  ctx.beginPath();
  ctx.ellipse(headX, headY, 15, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  drawEyes(ctx, headX + 2, headY - 3, 5, 3.5, alpha);
}

function drawWisp(ctx: CanvasRenderingContext2D, x0: number, vis: CreatureVis, hue: number, alpha: number, t: number): void {
  const x = x0 + Math.sin(t * 1.1) * 7;
  const y = FLOOR_Y - 70 - vis.pitch * 130 + Math.sin(t * 2.3) * 5;
  const r = 13 + vis.spring * 9;

  for (let i = 0; i < 4; i++) {
    const a = t * 2.4 + (i * Math.PI) / 2;
    const tx = x - 14 - i * 7 + Math.cos(a) * 5;
    const ty = y + Math.sin(a) * 9 + i * 4;
    ctx.fillStyle = `hsla(${hue}, 85%, 72%, ${(0.35 - i * 0.07) * alpha})`;
    ctx.beginPath();
    ctx.arc(tx, ty, 3.2 - i * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const grad = ctx.createRadialGradient(x, y, 2, x, y, r * 2.6);
  grad.addColorStop(0, `hsla(${hue}, 90%, 74%, ${(0.5 + vis.spring * 0.4) * alpha})`);
  grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);

  ctx.fillStyle = `hsla(${hue}, 75%, ${62 + vis.spring * 18}%, ${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  drawEyes(ctx, x, y - 2, 5.5, 3.2, alpha);
}

export function renderStageScene(
  ctx: CanvasRenderingContext2D,
  state: StageSceneState,
  performers: StagePerformerVisual[],
  t: number,
  dt: number
): void {
  advance(state, dt);

  const bg = ctx.createLinearGradient(0, 0, 0, SH);
  bg.addColorStop(0, '#0a0d13');
  bg.addColorStop(1, '#131820');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SW, SH);

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, FLOOR_Y, SW, SH - FLOOR_Y);
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(SW, FLOOR_Y);
  ctx.stroke();

  // Spread the cast evenly across the stage.
  const n = performers.length;
  const margin = 80;
  const step = n > 1 ? (SW - margin * 2) / (n - 1) : 0;

  performers.forEach((p, i) => {
    const x = n > 1 ? margin + i * step : SW / 2;
    const vis = visFor(state, p.id);
    const active = p.enabled && !p.mute;
    const alpha = active ? 1 : 0.22;
    const hue = hueFor(p);

    if (active) {
      drawSpotlight(ctx, x, hue, vis.spring);
    }

    switch (p.role) {
      case 'kick':
        drawStomper(ctx, x, vis, hue, alpha, t);
        break;
      case 'snare':
        drawSnapper(ctx, x, vis, hue, alpha, t);
        break;
      case 'hihat':
        drawSkitterer(ctx, x, vis, hue, alpha, t);
        break;
      case 'chords':
        drawOrganism(ctx, x, vis, hue, p.ribs ?? 3, alpha, t);
        break;
      case 'bass':
        drawSerpent(ctx, x, vis, hue, alpha, t);
        break;
      case 'melody':
        drawWisp(ctx, x, vis, hue, alpha, t);
        break;
    }

    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = active ? 'rgba(156, 163, 175, 0.85)' : 'rgba(107, 114, 128, 0.4)';
    ctx.fillText(p.label.toUpperCase(), x, FLOOR_Y + 22);
  });
}
