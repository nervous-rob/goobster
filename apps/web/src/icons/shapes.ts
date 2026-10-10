/**
 * Path-data helpers shared by the icon languages. Everything draws on a
 * 24×24 grid; the helpers return `d` strings so a glyph is a short list of
 * primitives rather than hand-typed coordinates.
 */

export type Pt = [number, number];

const n = (v: number) => +v.toFixed(2);

/** Rounded rectangle. */
export const rr = (x: number, y: number, w: number, h: number, r: number): string =>
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(h - 2 * r)}a${r} ${r} 0 0 1 -${r} ${r}h-${n(w - 2 * r)}a${r} ${r} 0 0 1 -${r} -${r}v-${n(h - 2 * r)}a${r} ${r} 0 0 1 ${r} -${r}z`;

/** Circle as two arcs (so it can live in a compound path). */
export const circ = (cx: number, cy: number, r: number): string =>
    `M${n(cx - r)} ${n(cy)}a${r} ${r} 0 1 0 ${n(2 * r)} 0a${r} ${r} 0 1 0 -${n(2 * r)} 0z`;

/** Polygon or polyline through points. */
export const poly = (pts: Pt[], close = true): string =>
    'M' + pts.map((p) => `${n(p[0])} ${n(p[1])}`).join('L') + (close ? 'z' : '');

/** `count` points evenly around a circle, starting at `offset` radians. */
export const ring = (cx: number, cy: number, r: number, count: number, offset = 0): Pt[] =>
    Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + offset;
        return [n(cx + r * Math.cos(a)), n(cy + r * Math.sin(a))];
    });

/** The outline of a gear: `teeth` tips at radius `R`, roots at `r`, first tip straight up. */
export const gearPts = (cx: number, cy: number, R: number, r: number, teeth: number): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < teeth * 2; i++) {
        const a = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
        const rad = i % 2 ? r : R;
        out.push([n(cx + rad * Math.cos(a)), n(cy + rad * Math.sin(a))]);
    }
    return out;
};

/** A filled path. */
export const fill = (d: string, color: string, extra = ''): string => `<path d="${d}" fill="${color}" ${extra}/>`;

/** A stroked path with round caps and joins. */
export const stroke = (d: string, color: string, width: number, extra = ''): string =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

/* Colour tokens. Icons never carry literal colours: everything derives from
   the painted accent (`--accent-rgb`), the surface, or `currentColor`, so a
   glyph follows theme, accent and surface changes live. */
export const A = 'rgb(var(--accent-rgb))';
/** The quieter second tone: the accent sunk most of the way into the surface. */
export const A2 = 'color-mix(in oklch, rgb(var(--accent-rgb)), var(--bg) 50%)';
export const ALITE = 'color-mix(in oklch, rgb(var(--accent-rgb)), white 32%)';
/** Negative space: whatever surface the icon sits on (`--ic-ink`, defaulting to the page). */
export const INK = 'var(--ic-ink, var(--bg))';
