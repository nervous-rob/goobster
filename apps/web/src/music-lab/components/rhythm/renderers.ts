import { clamp, updateCreaturePose, type Creature } from '@music-lab/lib/rhythmTheory';

/** Logical canvas dimensions; the canvases scale to fit while preserving these. */
export const WW = 800;
export const WH = 320;
export const WH_OVER = 220;

export const PALETTE = {
  sky: '#11161c',
  ground: '#1a1a1a',
  rail: '#4a4e54',
  tie: '#2d2d2d',
  boiler: '#2d2d2d',
  boilerD: '#1a1a1a',
  cab: '#2d2d2d',
  wheel: '#f59e0b',
  hub: '#111111',
  rim: '#4a4e54',
  rod: '#9ca3af',
  rodD: '#6b7280',
  brass: '#d97706',
  smoke: '#4b5563',
  met: '#2d2d2d',
  metB: '#f59e0b'
};

const P = PALETTE;

const CX_A = 320;
const CX_B = 410;
const CY = 200;
const WHEEL_R = 45;
const CRANK_R = 22;
const ROD_L = 110;

export interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  age: number;
  life: number;
}

export function spawnPuff(puffs: Puff[]): void {
  puffs.push({ x: 520, y: 80, vx: -25, vy: -35, r: 8, age: 0, life: 1.2 });
  if (puffs.length > 30) puffs.shift();
}

export function updatePuffs(puffs: Puff[], dt: number): void {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy *= 0.98;
    p.r += 18 * dt;
    p.age += dt;
    if (p.age > p.life) puffs.splice(i, 1);
  }
}

export interface VisualSnapshot {
  isPlaying: boolean;
  isFillActive: boolean;
  ghostMuted: boolean;
  phraseLength: number;
  currentMeasure: number;
  currentSway: number;
  polyRatio: number;
  polyPulse: number;
  theta: number;
  scrollX: number;
}

function roundRectCtx(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- Train renderer ---

function drawWheel(ctx: CanvasRenderingContext2D, cx: number, theta: number): void {
  ctx.save();
  ctx.strokeStyle = P.rim;
  ctx.fillStyle = P.wheel;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, CY, WHEEL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = P.rodD;
  ctx.lineWidth = 3;
  for (let k = 0; k < 8; k++) {
    const a = theta + (k * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(cx, CY);
    ctx.lineTo(cx + Math.cos(a) * (WHEEL_R - 6), CY + Math.sin(a) * (WHEEL_R - 6));
    ctx.stroke();
  }
  ctx.fillStyle = P.hub;
  ctx.beginPath();
  ctx.arc(cx, CY, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawLocomotive(ctx: CanvasRenderingContext2D, theta: number): void {
  const rock = 0.015 * Math.cos(theta);
  ctx.save();
  ctx.translate(400, 240);
  ctx.rotate(rock);
  ctx.translate(-400, -240);

  ctx.fillStyle = P.cab;
  roundRectCtx(ctx, 200, 90, 60, 90, 8);
  ctx.fill();
  ctx.fillStyle = P.sky;
  roundRectCtx(ctx, 210, 105, 35, 35, 4);
  ctx.fill();
  ctx.fillStyle = P.boiler;
  roundRectCtx(ctx, 245, 120, 310, 60, 12);
  ctx.fill();
  ctx.fillStyle = P.boilerD;
  ctx.beginPath();
  ctx.arc(555, 150, 32, -1.5, 1.5);
  ctx.fill();
  ctx.fillStyle = P.rodD;
  ctx.fillRect(200, 180, 390, 6);

  ctx.fillStyle = P.boilerD;
  roundRectCtx(ctx, 350, 100, 30, 25, 4);
  ctx.fill();
  ctx.fillStyle = P.brass;
  roundRectCtx(ctx, 355, 94, 20, 10, 3);
  ctx.fill();
  ctx.fillStyle = P.boilerD;
  ctx.fillRect(500, 85, 28, 40);
  ctx.fillStyle = P.brass;
  ctx.fillRect(496, 80, 36, 10);

  ctx.fillStyle = P.boilerD;
  ctx.beginPath();
  ctx.moveTo(590, 180);
  ctx.lineTo(630, 240);
  ctx.lineTo(590, 240);
  ctx.fill();
  drawWheel(ctx, CX_A, theta);
  drawWheel(ctx, CX_B, theta);

  const ax = CX_A + CRANK_R * Math.cos(theta);
  const ay = CY + CRANK_R * Math.sin(theta);
  const bx = CX_B + CRANK_R * Math.cos(theta);
  const by = CY + CRANK_R * Math.sin(theta);
  ctx.strokeStyle = P.rod;
  ctx.lineCap = 'round';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();

  const chX = CX_B + CRANK_R * Math.cos(theta) + Math.sqrt(ROD_L * ROD_L - Math.pow(CRANK_R * Math.sin(theta), 2));
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(chX, CY);
  ctx.stroke();

  ctx.fillStyle = P.rodD;
  roundRectCtx(ctx, chX - 8, CY - 8, 16, 16, 4);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(chX, CY);
  ctx.lineTo(570, CY);
  ctx.stroke();
  ctx.fillStyle = P.rim;
  roundRectCtx(ctx, 560, CY - 15, 30, 30, 6);
  ctx.fill();

  ctx.fillStyle = P.hub;
  ctx.beginPath();
  ctx.arc(ax, ay, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bx, by, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMetronome(ctx: CanvasRenderingContext2D, snapshot: VisualSnapshot): void {
  const ang = -0.45 * Math.cos(snapshot.theta);
  ctx.save();
  ctx.fillStyle = P.met;
  ctx.beginPath();
  ctx.moveTo(60, 240);
  ctx.lineTo(140, 240);
  ctx.lineTo(125, 170);
  ctx.lineTo(75, 170);
  ctx.fill();
  ctx.fillStyle = P.ground;
  ctx.fillRect(55, 238, 90, 8);

  const px = 100;
  const py = 205;
  const armLength = 130;
  const tx = px + Math.sin(ang) * armLength;
  const ty = py - Math.cos(ang) * armLength;
  ctx.strokeStyle = P.rodD;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  const bx = px + Math.sin(ang) * armLength * 0.65;
  const by = py - Math.cos(ang) * armLength * 0.65;
  ctx.fillStyle = snapshot.isFillActive && !snapshot.ghostMuted ? '#ef4444' : P.metB;
  roundRectCtx(ctx, bx - 9, by - 9, 18, 20, 4);
  ctx.fill();

  ctx.fillStyle = P.hub;
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function renderTrainScene(ctx: CanvasRenderingContext2D, snapshot: VisualSnapshot, puffs: Puff[]): void {
  drawMetronome(ctx, snapshot);
  drawLocomotive(ctx, snapshot.theta);
  for (const p of puffs) {
    const a = 1 - p.age / p.life;
    if (a <= 0) continue;
    ctx.globalAlpha = a * 0.6;
    ctx.fillStyle = snapshot.ghostMuted ? '#7c3aed' : snapshot.isFillActive ? '#d97706' : P.smoke;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;
}

// --- Creature renderer ---

function drawIKLimb(
  ctx: CanvasRenderingContext2D,
  hip: { x: number; y: number },
  foot: { x: number; y: number },
  lengthA: number,
  lengthB: number,
  isGhost: boolean,
  isActive: boolean
): void {
  const dx = foot.x - hip.x;
  const dy = foot.y - hip.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const clampedDist = Math.max(0.01, Math.min(dist, lengthA + lengthB - 0.01));
  const angle = Math.atan2(dy, dx);

  const cosKnee = (lengthA * lengthA + clampedDist * clampedDist - lengthB * lengthB) / (2 * lengthA * clampedDist);
  const kneeAngle = Math.acos(clamp(cosKnee, -1, 1));

  // "Bird leg" backward bending knee
  const knee = {
    x: hip.x + Math.cos(angle - kneeAngle) * lengthA,
    y: hip.y + Math.sin(angle - kneeAngle) * lengthA
  };

  if (isGhost) {
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = isActive ? '#4b5563' : '#374151';
    ctx.lineWidth = 6;
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(hip.x, hip.y);
  ctx.lineTo(knee.x, knee.y);
  ctx.lineTo(foot.x, foot.y);
  ctx.stroke();

  if (isGhost) {
    ctx.fillStyle = '#f3e8ff';
    ctx.beginPath();
    ctx.arc(hip.x, hip.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(knee.x, knee.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(foot.x, foot.y, 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.arc(knee.x, knee.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = isActive ? '#f59e0b' : '#1a1a1a';
    ctx.beginPath();
    ctx.arc(foot.x, foot.y, isActive ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function renderCreatureScene(
  ctx: CanvasRenderingContext2D,
  snapshot: VisualSnapshot,
  creature: Creature,
  dt: number,
  currentQuarterNote: number
): void {
  updateCreaturePose(creature, snapshot, dt, currentQuarterNote);

  ctx.save();
  ctx.translate(WW / 2, 200);

  const loop8th = (currentQuarterNote * 2) % creature.genome.total;
  const isGhost = snapshot.ghostMuted;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 40, 60 + creature.pose.compression * 2, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  if (isGhost) ctx.globalAlpha = 0.5;

  const spineNodes = creature.body.spine.map((seg, i) => {
    const phase = i / creature.body.spine.length;
    const bend = Math.sin(phase * Math.PI + creature.pose.breath) * 8;
    return {
      x: seg.baseX,
      y: seg.baseY + bend + creature.pose.compression + (phase - 0.5) * creature.pose.bodyLean,
      r: seg.radius
    };
  });

  if (creature.body.satellites.length > 0) {
    creature.body.satellites.forEach(sat => {
      sat.angle += 0.5 * dt;
      const px = Math.cos(sat.angle) * sat.radius;
      const py = Math.sin(sat.angle) * sat.radius - 20;

      const activePoly = snapshot.polyPulse === sat.pulseIndex && snapshot.isPlaying;
      ctx.fillStyle = activePoly ? '#f59e0b' : '#374151';
      ctx.beginPath();
      ctx.arc(px, py, activePoly ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  creature.body.limbs.forEach(limb => {
    const hipIndex = Math.floor(limb.phaseOffset * (spineNodes.length - 1));
    const hip = spineNodes[hipIndex] ?? spineNodes[0];

    const start = limb.startSubdivision;
    const dur = limb.strideDuration;
    const total = creature.genome.total;
    const t = (loop8th - start + total) % total;

    const reach = 30 + limb.force * 25;
    let fx: number;
    let fy: number;
    const groundY = 40;

    if (t < dur) {
      // In air swinging forward
      const phase = t / dur;
      fx = hip.x - reach + reach * 2 * phase;
      const height = 15 + limb.force * 20;
      fy = groundY - height * Math.sin(phase * Math.PI);
    } else {
      // Planted on ground
      const phase = (t - dur) / (total - dur);
      fx = hip.x + reach - reach * 2 * phase;
      fy = groundY;
    }

    drawIKLimb(ctx, hip, { x: fx, y: fy }, limb.length * 0.5, limb.length * 0.55, isGhost, t < dur);
  });

  if (isGhost) {
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    spineNodes.forEach((n, i) => {
      if (i === 0) ctx.moveTo(n.x, n.y);
      else ctx.lineTo(n.x, n.y);
    });
    ctx.stroke();

    // Pulsing heart
    const hr = 6 + Math.sin(currentQuarterNote * Math.PI * 4) * 2;
    const heart = spineNodes[Math.floor(spineNodes.length / 2)];
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(heart.x, heart.y, hr, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = snapshot.isFillActive ? '#f59e0b' : '#1a1a1a';
    ctx.lineWidth = spineNodes[0].r * 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    spineNodes.forEach((n, i) => {
      if (i === 0) ctx.moveTo(n.x, n.y);
      else ctx.lineTo(n.x, n.y);
    });
    ctx.stroke();

    if (creature.genome.drumsEnabled) {
      ctx.fillStyle = '#374151';
      spineNodes.forEach((n, i) => {
        if (i % 2 === 0) {
          ctx.beginPath();
          ctx.arc(n.x, n.y - n.r * 0.55, 4, 0, Math.PI);
          ctx.fill();
        }
      });
    }
  }

  const headNode = spineNodes[spineNodes.length - 1];
  if (isGhost) {
    ctx.strokeStyle = '#a855f7';
    ctx.strokeRect(headNode.x + 5, headNode.y - 8, 16, 16);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(headNode.x + 10, headNode.y - 4, 4, 4);
  } else {
    ctx.fillStyle = '#2d2d2d';
    ctx.beginPath();
    ctx.arc(headNode.x + 8, headNode.y + creature.pose.bodyLean * 0.2, creature.body.head.size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = snapshot.isFillActive ? '#ef4444' : '#f59e0b';
    for (let e = 0; e < creature.body.head.eyeCount; e++) {
      const ey = headNode.y - 4 + e * 4 - creature.body.head.eyeCount * 2;
      ctx.beginPath();
      ctx.arc(headNode.x + 12, ey, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (snapshot.isFillActive) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(headNode.x + 16, headNode.y + 4, 4 * creature.pose.flare, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tailRoot = spineNodes[0];
  const tailSegs = creature.body.tail.segments;
  ctx.strokeStyle = isGhost ? '#a855f7' : '#4b5563';
  ctx.lineWidth = isGhost ? 1 : 3;
  ctx.beginPath();
  ctx.moveTo(tailRoot.x, tailRoot.y);
  for (let i = 1; i <= tailSegs; i++) {
    const wag = Math.sin((currentQuarterNote * Math.PI) / tailSegs + i) * (10 + creature.body.tail.curl * 10);
    const flareY = snapshot.isFillActive && i === tailSegs ? -20 : 0;
    ctx.lineTo(tailRoot.x - i * 12, tailRoot.y + wag + flareY);
  }
  ctx.stroke();

  ctx.globalAlpha = 1.0;
  ctx.restore();
}

// --- Shared backdrop (ground + rails + ties) ---

export function renderBackdrop(ctx: CanvasRenderingContext2D, scrollX: number): void {
  ctx.fillStyle = P.ground;
  ctx.fillRect(0, 240, WW, WH - 240);
  ctx.strokeStyle = P.rail;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 242);
  ctx.lineTo(WW, 242);
  ctx.stroke();

  ctx.fillStyle = P.tie;
  const tieSpacing = 40;
  const off = ((scrollX % tieSpacing) + tieSpacing) % tieSpacing;
  for (let x = -off; x < WW; x += tieSpacing) {
    ctx.fillRect(x, 245, 14, 8);
  }
}

// --- Overhead telemetry ---

export function renderOverhead(ctx: CanvasRenderingContext2D, snapshot: VisualSnapshot, phase: number): void {
  const cx = WW / 2;
  const cy = WH_OVER / 2;
  const rx = WW / 2 - 80;
  const ry = WH_OVER / 2 - 40;

  ctx.strokeStyle = P.rail;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = P.tie;
  ctx.lineWidth = 4;
  for (let i = 0; i < 60; i++) {
    const a = (i * Math.PI * 2) / 60;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + cosA * (rx - 12), cy + sinA * (ry - 12));
    ctx.lineTo(cx + cosA * (rx + 12), cy + sinA * (ry + 12));
    ctx.stroke();
  }

  ctx.lineWidth = 6;
  for (let m = 0; m < snapshot.phraseLength; m++) {
    const a = -Math.PI / 2 + (m * Math.PI * 2) / snapshot.phraseLength;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    ctx.strokeStyle = m + 1 === snapshot.currentMeasure ? P.brass : '#ef4444';
    if (!snapshot.isPlaying) ctx.strokeStyle = P.rail;

    ctx.beginPath();
    ctx.moveTo(cx + cosA * (rx - 16), cy + sinA * (ry - 16));
    ctx.lineTo(cx + cosA * (rx + 16), cy + sinA * (ry + 16));
    ctx.stroke();

    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pad = 30;
    ctx.fillText(`M${m + 1}`, cx + cosA * (rx + pad), cy + sinA * (ry + pad));
  }

  if (snapshot.polyRatio > 0) {
    const innerRx = rx * 0.58;
    const innerRy = ry * 0.58;
    ctx.strokeStyle = 'rgba(245,158,11,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, innerRx, innerRy, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    for (let i = 0; i < snapshot.polyRatio; i++) {
      const a = -Math.PI / 2 + (i / snapshot.polyRatio) * Math.PI * 2;
      const active = snapshot.isPlaying && i === snapshot.polyPulse;
      ctx.fillStyle = active ? '#f59e0b' : '#111111';
      ctx.strokeStyle = active ? '#fbbf24' : '#6b7280';
      ctx.lineWidth = active ? 4 : 2;
      ctx.shadowColor = active ? '#f59e0b' : 'transparent';
      ctx.shadowBlur = active ? 14 : 0;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * innerRx, cy + Math.sin(a) * innerRy, active ? 8 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  const angle = phase * Math.PI * 2 - Math.PI / 2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  const dx = -rx * sinA;
  const dy = ry * cosA;
  const len = Math.sqrt(dx * dx + dy * dy);
  const txNorm = dx / len;
  const tyNorm = dy / len;

  const nx = -tyNorm;
  const ny = txNorm;

  const swayAmt = snapshot.currentSway * 14;
  const tx = cx + rx * cosA + nx * swayAmt;
  const ty = cy + ry * sinA + ny * swayAmt;
  const tangentAngle = Math.atan2(dy, dx);

  ctx.save();
  ctx.translate(tx, ty);
  ctx.rotate(tangentAngle);

  // Train chassis marker
  ctx.fillStyle = P.cab;
  roundRectCtx(ctx, -22, -14, 16, 28, 4);
  ctx.fill();
  ctx.fillStyle = P.boiler;
  ctx.fillRect(-6, -10, 32, 20);
  ctx.fillStyle = P.boilerD;
  roundRectCtx(ctx, 26, -8, 8, 16, 2);
  ctx.fill();

  if (snapshot.isFillActive && !snapshot.ghostMuted) {
    ctx.fillStyle = '#f59e0b';
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(32, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  ctx.restore();
}
