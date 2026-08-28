import { clamp } from '@music-lab/lib/rhythmTheory';
import type { GravityMapView, HarmonyGenome } from '@music-lab/lib/harmonyTheory';

/** Logical canvas dimensions; canvases scale to fit while preserving these. */
export const HW = 800;
export const HH = 380;
export const HMAP_H = 300;

const GROUND_Y = 332;

interface OrganismParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  hue: number;
}

export interface OrganismState {
  particles: OrganismParticle[];
  pulse: number;
  flinch: number;
  glow: number;
  breath: number;
  spin: number;
  lastId: string | null;
}

export function createOrganismState(): OrganismState {
  return { particles: [], pulse: 0, flinch: 0, glow: 0, breath: 0, spin: 0, lastId: null };
}

export function pulseOrganism(state: OrganismState, amount = 1): void {
  state.pulse = Math.max(state.pulse, amount);
}

export function flinchOrganism(state: OrganismState): void {
  state.flinch = 1;
  for (let i = 0; i < 24; i++) {
    state.particles.push({
      x: HW / 2 + (Math.random() - 0.5) * 130,
      y: 200 + (Math.random() - 0.5) * 110,
      vx: (Math.random() - 0.5) * 170,
      vy: -30 - Math.random() * 90,
      age: 0,
      life: 0.9 + Math.random() * 0.6,
      size: 3 + Math.random() * 4,
      hue: 0
    });
  }
}

export function glowOrganism(state: OrganismState): void {
  state.glow = 1;
}

interface BodyTone {
  midi: number;
  rel: number;
}

function ribWidth(rel: number): number {
  switch (rel) {
    case 0:
      return 150;
    case 7:
      return 134;
    case 5:
      return 122;
    case 3:
    case 4:
      return 118;
    case 8:
      return 114;
    case 6:
      return 102;
    case 2:
      return 110;
    default:
      return 100;
  }
}

function roundedRib(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + r, y - h / 2);
  ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r);
  ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
  ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r);
  ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r);
  ctx.closePath();
}

function drawStarCore(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBody(
  ctx: CanvasRenderingContext2D,
  genome: HarmonyGenome,
  state: OrganismState,
  bodyTones: BodyTone[],
  t: number,
  hue: number,
  alpha: number,
  offsetX: number
): void {
  const tension = genome.tension;
  const sat = 50 + tension * 35;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(offsetX, 0);

  let prevY: number | null = null;
  let y = 0;
  const positions: { y: number; rel: number; midi: number }[] = [];
  bodyTones.forEach((tone, i) => {
    if (i === 0) {
      y = 0;
    } else {
      const gap = clamp((tone.midi - bodyTones[i - 1].midi) * 3, 16, 46);
      y = (prevY ?? 0) - gap;
    }
    prevY = y;
    positions.push({ y, rel: tone.rel, midi: tone.midi });
  });

  // Spine connecting the ribs
  if (positions.length > 1) {
    ctx.strokeStyle = `hsla(${hue}, ${sat}%, 60%, 0.5)`;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    positions.forEach((p, i) => {
      const sway = Math.sin(state.breath + i * 0.8) * 3;
      if (i === 0) ctx.moveTo(sway, p.y);
      else ctx.lineTo(sway, p.y);
    });
    ctx.stroke();
  }

  positions.forEach((p, i) => {
    const isRoot = p.rel === 0;
    const vib = Math.sin(t * 34 + i * 2.2) * tension * 4;
    const sway = Math.sin(state.breath + i * 0.8) * 3;
    const x = sway + vib;
    const w = ribWidth(p.rel) * (1 + Math.sin(state.breath * 0.9 + i) * 0.02);
    const h = 17 + (isRoot ? 5 : 0);
    const light = 38 + genome.brightness * 26 + (isRoot ? 8 : 0);

    ctx.save();
    if (tension > 0.5) {
      ctx.shadowColor = `rgba(239, 68, 68, ${(tension - 0.5) * 1.4})`;
      ctx.shadowBlur = 18;
    } else {
      ctx.shadowColor = `hsla(${hue}, ${sat}%, 55%, 0.5)`;
      ctx.shadowBlur = 10;
    }
    ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, 0.92)`;
    roundedRib(ctx, x, p.y, w, h);
    ctx.fill();
    ctx.strokeStyle = `hsla(${hue}, ${sat + 8}%, ${light + 18}%, 0.85)`;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();

    // Tension spikes along the rib edges
    if (tension > 0.45) {
      const spikeAlpha = clamp((tension - 0.45) * 1.8, 0, 1);
      const spikes = 6;
      ctx.fillStyle = `rgba(239, 68, 68, ${0.55 * spikeAlpha})`;
      for (let s = 0; s < spikes; s++) {
        const sx = x - w / 2 + (w / (spikes - 1)) * s;
        const dir = s % 2 === 0 ? -1 : 1;
        const len = 6 + tension * 8;
        ctx.beginPath();
        ctx.moveTo(sx - 3, p.y + dir * (h / 2));
        ctx.lineTo(sx, p.y + dir * (h / 2 + len));
        ctx.lineTo(sx + 3, p.y + dir * (h / 2));
        ctx.closePath();
        ctx.fill();
      }
    }

    if (isRoot) {
      drawStarCore(ctx, x, p.y, 9 + Math.sin(state.breath * 1.6) * 1.6, `hsla(${hue}, 90%, ${70 + genome.brightness * 18}%, 0.95)`);
    }

    if (p.rel === 6) {
      // Split magnet: the tritone rib visibly tears in two
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      const split = Math.sin(t * 9) * 3;
      ctx.moveTo(x - 6 + split, p.y - h / 2 - 2);
      ctx.lineTo(x + 6 - split, p.y + h / 2 + 2);
      ctx.stroke();
    }
  });

  // Eyes on the head rib
  const head = positions[positions.length - 1];
  if (head) {
    const eyeCount = genome.ambiguity > 0.45 ? 1 : genome.instability > 0.7 ? 3 : 2;
    const eyeY = head.y - 1;
    ctx.fillStyle = `hsla(${hue}, 30%, 92%, 0.95)`;
    for (let e = 0; e < eyeCount; e++) {
      const spreadX = (e - (eyeCount - 1) / 2) * 16;
      ctx.save();
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(spreadX, eyeY, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
}

export function renderOrganism(
  ctx: CanvasRenderingContext2D,
  genome: HarmonyGenome,
  state: OrganismState,
  t: number,
  dt: number
): void {
  // Advance internal clocks
  state.pulse = Math.max(0, state.pulse - dt * 1.7);
  state.flinch = Math.max(0, state.flinch - dt * 1.0);
  state.glow = Math.max(0, state.glow - dt * 0.55);
  state.breath += dt * (0.9 + genome.tension * 1.7);
  state.spin += dt * (0.25 + genome.instability * 1.9);
  if (state.lastId !== genome.id) {
    state.lastId = genome.id;
    state.pulse = Math.max(state.pulse, 0.65);
  }

  const hue = 260 - genome.brightness * 215;
  const sorted = [...genome.midi].sort((a, b) => a - b);
  const rootPc = genome.rootPc;
  const hasSeventh = genome.pitchClasses.includes(10) || genome.pitchClasses.includes(11);
  const tones: BodyTone[] = sorted.map(m => ({ midi: m, rel: (((m % 12) - rootPc) % 12 + 12) % 12 }));
  const isSatellite = (tone: BodyTone) =>
    tone.rel === 9 || tone.rel === 10 || tone.rel === 11 || (tone.rel === 2 && genome.quality !== 'sus2' && hasSeventh);
  const bodyTones = tones.filter(tone => !isSatellite(tone));
  const satTones = tones.filter(isSatellite);
  if (!bodyTones.length && tones.length) bodyTones.push(tones[0]);

  // Backdrop: gravity field rings
  const grad = ctx.createRadialGradient(HW / 2, 210, 30, HW / 2, 210, 420);
  grad.addColorStop(0, `hsla(${hue}, 45%, ${10 + genome.brightness * 7}%, 1)`);
  grad.addColorStop(1, '#0a0a12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, HW, HH);
  ctx.strokeStyle = `hsla(${hue}, 40%, 40%, 0.12)`;
  ctx.lineWidth = 1;
  for (let r = 70; r <= 330; r += 65) {
    ctx.beginPath();
    ctx.ellipse(HW / 2, 220, r * 1.35, r * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Ground shimmer
  const groundGrad = ctx.createLinearGradient(0, GROUND_Y - 8, 0, HH);
  groundGrad.addColorStop(0, `hsla(${hue}, 35%, 18%, 0.55)`);
  groundGrad.addColorStop(1, 'rgba(8, 8, 14, 0.9)');
  ctx.fillStyle = groundGrad;
  ctx.fillRect(0, GROUND_Y - 8, HW, HH - GROUND_Y + 8);

  // Bass gravitational anchor
  const anchorX = HW / 2 + clamp((sorted[0] - 57) * 5, -170, 170);
  ctx.save();
  ctx.strokeStyle = `hsla(${hue}, 60%, 55%, 0.35)`;
  ctx.lineWidth = 2;
  for (let r = 0; r < 3; r++) {
    const radius = 16 + r * 13 + ((t * 14) % 13);
    ctx.globalAlpha = 0.4 - r * 0.12;
    ctx.beginPath();
    ctx.ellipse(anchorX, GROUND_Y, radius, radius * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const lift = 24 + genome.brightness * 56;
  const bodyBaseY = GROUND_Y - lift;
  const wobble = Math.sin(state.spin * 2.1) * genome.instability * 0.16;
  const tilt = genome.inversion * 0.085 + wobble + Math.sin(t * 48) * state.flinch * 0.05;
  const pulseScale = 1 + state.pulse * 0.1;
  const shakeX = Math.sin(t * 56) * state.flinch * 13;

  // Body shadow on the ground
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.beginPath();
  ctx.ellipse(HW / 2 + shakeX, GROUND_Y + 4, 78 - genome.brightness * 18, 11, 0, 0, Math.PI * 2);
  ctx.fill();

  // Tether from the anchor up to the body root
  ctx.strokeStyle = `hsla(${hue}, 55%, 55%, 0.4)`;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 7]);
  ctx.lineDashOffset = -t * 26;
  ctx.beginPath();
  ctx.moveTo(anchorX, GROUND_Y - 2);
  ctx.quadraticCurveTo(anchorX, bodyBaseY + 26, HW / 2 + shakeX, bodyBaseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Glow aura (quiz streak reward)
  if (state.glow > 0.02) {
    const auraGrad = ctx.createRadialGradient(HW / 2, bodyBaseY - 60, 20, HW / 2, bodyBaseY - 60, 240);
    auraGrad.addColorStop(0, `rgba(250, 204, 21, ${0.42 * state.glow})`);
    auraGrad.addColorStop(1, 'rgba(250, 204, 21, 0)');
    ctx.fillStyle = auraGrad;
    ctx.fillRect(0, 0, HW, HH);
    // Expanding victory ring
    const ringR = 90 + (1 - state.glow) * 130;
    ctx.strokeStyle = `rgba(250, 204, 21, ${0.85 * state.glow})`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.ellipse(HW / 2, bodyBaseY - 50, ringR, ringR * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(HW / 2 + shakeX, bodyBaseY);
  ctx.rotate(tilt);
  ctx.scale(pulseScale, pulseScale);

  if (genome.ambiguity > 0.25) {
    const split = genome.ambiguity * 13;
    drawBody(ctx, genome, state, bodyTones, t, hue, 0.5, -split);
    drawBody(ctx, genome, state, bodyTones, t, hue + 14, 0.5, split);
  } else {
    drawBody(ctx, genome, state, bodyTones, t, hue, 1, 0);
  }

  // Extension satellites & halos orbit the crown
  const headY = bodyTones.length > 1 ? -(bodyTones.length - 1) * 30 - 28 : -46;
  satTones.forEach((tone, i) => {
    const isMaj7 = tone.rel === 11;
    const rx = 74 + i * 20;
    const ry = 24 + i * 9;
    const angle = state.spin * (0.8 + i * 0.22) + i * 2.4;
    ctx.strokeStyle = isMaj7 ? 'rgba(250, 204, 21, 0.4)' : `hsla(${hue}, 60%, 62%, 0.3)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(0, headY, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    const sx = Math.cos(angle) * rx;
    const sy = headY + Math.sin(angle) * ry;
    ctx.save();
    ctx.fillStyle = isMaj7 ? '#fde047' : `hsla(${hue + 18}, 80%, 70%, 0.95)`;
    ctx.shadowColor = isMaj7 ? '#fde047' : `hsla(${hue + 18}, 90%, 65%, 1)`;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(sx, sy, tone.rel === 10 ? 6 : 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  if (genome.pitchClasses.includes(11)) {
    // The maj7 "luminous unresolved halo"
    ctx.strokeStyle = `rgba(250, 204, 21, ${0.5 + Math.sin(t * 2.4) * 0.2})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(0, headY - 26, 34, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  // Particle leakage from unstable chords
  if (genome.instability > 0.3 && Math.random() < dt * (genome.instability - 0.2) * 26) {
    state.particles.push({
      x: HW / 2 + (Math.random() - 0.5) * 120,
      y: bodyBaseY - Math.random() * 90,
      vx: (Math.random() - 0.5) * 50,
      vy: -14 - Math.random() * 36,
      age: 0,
      life: 1.1 + Math.random() * 0.9,
      size: 1.6 + Math.random() * 2.6,
      hue
    });
  }
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.age += dt;
    if (p.age > p.life) {
      state.particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const a = 1 - p.age / p.life;
    ctx.fillStyle = p.hue === 0 ? `rgba(239, 68, 68, ${a * 0.8})` : `hsla(${p.hue}, 80%, 68%, ${a * 0.7})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.particles.length > 90) state.particles.splice(0, state.particles.length - 90);

  // Trigger shockwave
  if (state.pulse > 0.02) {
    const wave = 1 - state.pulse;
    ctx.strokeStyle = `hsla(${hue}, 80%, 65%, ${state.pulse * 0.5})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(HW / 2, bodyBaseY - 40, 40 + wave * 240, (40 + wave * 240) * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Flinch flash: red wash + hard warning border
  if (state.flinch > 0.02) {
    ctx.fillStyle = `rgba(239, 68, 68, ${state.flinch * 0.18})`;
    ctx.fillRect(0, 0, HW, HH);
    ctx.strokeStyle = `rgba(239, 68, 68, ${state.flinch * 0.9})`;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, HW - 10, HH - 10);
  }
}

// --- Functional gravity map ---

function arrowColor(kind: string): string {
  if (kind.includes('deceptive')) return '#f59e0b';
  if (kind.includes('authentic') || kind.includes('sharp') || kind.includes('gravity')) return '#a78bfa';
  if (kind.includes('plagal') || kind.includes('backdoor') || kind.includes('modal')) return '#34d399';
  return '#94a3b8';
}

export function renderGravityMap(ctx: CanvasRenderingContext2D, view: GravityMapView, t: number): void {
  ctx.fillStyle = '#0a0d13';
  ctx.fillRect(0, 0, HW, HMAP_H);

  const px = (n: { x: number; y: number }) => ({ x: n.x * HW, y: n.y * HMAP_H });
  const byKey = new Map(view.nodes.map(n => [n.key, n]));

  // Faint field rings around the tonic
  const tonic = view.nodes.find(n => n.pc === 0);
  if (tonic) {
    const c = px(tonic);
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.08)';
    ctx.lineWidth = 1;
    for (let r = 46; r <= 260; r += 52) {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r * 1.5, r * 0.62, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Resolution arrows
  view.arrows.forEach(arrow => {
    const from = byKey.get(arrow.fromKey);
    const to = byKey.get(arrow.toKey);
    if (!from || !to) return;
    const a = px(from);
    const b = px(to);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / dist;
    const ny = dx / dist;
    const cxp = mx + nx * dist * 0.18;
    const cyp = my + ny * dist * 0.18;
    const color = arrowColor(arrow.kind);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35 + arrow.strength * 0.6;
    ctx.lineWidth = 1.4 + arrow.strength * 4.2;
    ctx.setLineDash([9, 7]);
    ctx.lineDashOffset = -t * 36 * (0.4 + arrow.strength);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cxp, cyp, b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead just before the target node
    const tEnd = 0.88;
    const ex = (1 - tEnd) * (1 - tEnd) * a.x + 2 * (1 - tEnd) * tEnd * cxp + tEnd * tEnd * b.x;
    const ey = (1 - tEnd) * (1 - tEnd) * a.y + 2 * (1 - tEnd) * tEnd * cyp + tEnd * tEnd * b.y;
    const tx = 2 * (1 - tEnd) * (cxp - a.x) + 2 * tEnd * (b.x - cxp);
    const ty = 2 * (1 - tEnd) * (cyp - a.y) + 2 * tEnd * (b.y - cyp);
    const ang = Math.atan2(ty, tx);
    ctx.fillStyle = color;
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Strength label
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(arrow.strength * 100)}%`, cxp, cyp - 4);
    ctx.globalAlpha = 1;
  });

  // Nodes
  view.nodes.forEach(node => {
    const c = px(node);
    const isCurrent = node.isCurrent;
    const r = isCurrent ? 25 : 19;

    if (isCurrent) {
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r + 6 + Math.sin(t * 3.2) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.fillStyle = isCurrent ? 'rgba(139, 92, 246, 0.3)' : '#13131d';
    ctx.strokeStyle = isCurrent ? '#a78bfa' : '#2d2d3d';
    ctx.lineWidth = isCurrent ? 2.2 : 1.4;
    if (isCurrent) {
      ctx.shadowColor = '#8b5cf6';
      ctx.shadowBlur = 16;
    }
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = isCurrent ? '#ffffff' : '#9ca3af';
    ctx.font = `${isCurrent ? 'bold 13px' : '12px'} "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.numeral, c.x, c.y);
    ctx.fillStyle = isCurrent ? '#c4b5fd' : '#6b7280';
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(node.chordName, c.x, c.y + r + 11);
  });

  if (view.chromaticLabel) {
    ctx.fillStyle = 'rgba(10, 13, 19, 0.78)';
    ctx.fillRect(0, 0, HW, HMAP_H);
    ctx.fillStyle = '#c4b5fd';
    ctx.font = '13px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(view.chromaticLabel, HW / 2, HMAP_H / 2);
  }
}
