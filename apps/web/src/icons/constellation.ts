/**
 * Constellation: nodes joined by hairlines with one bright star per glyph,
 * the way the Observatory and the Knowledge map already draw. Lines and
 * nodes use `currentColor`; the star is always the accent.
 */
import { A, ALITE, gearPts, poly, ring, type Pt } from './shapes';
import type { GlyphName } from './names';

type Figure = { loops: Pt[][]; open?: boolean[]; star: Pt };

const heart: Pt[] = [[12, 20], [6, 15], [5, 10], [7.5, 7.5], [12, 9.5], [16.5, 7.5], [19, 10], [18, 15]];

export const CONSTELLATION: Record<GlyphName, Figure> = {
    home: { loops: [[[4, 11], [12, 4], [20, 11], [20, 20], [4, 20]]], star: [12, 4] },
    chat: { loops: [[[4, 5], [20, 5], [20, 15], [11, 15], [6, 19.5], [7, 15], [4, 15]]], star: [20, 5] },
    knowledge: { loops: [ring(12, 9.5, 6, 7, -Math.PI / 2), [[9.5, 18.5], [14.5, 18.5]], [[10.5, 21.5], [13.5, 21.5]]], open: [false, true, true], star: [12, 3.5] },
    projects: { loops: [[[4, 16], [19, 6]], [[11, 11.5], [7, 21]], [[11, 11.5], [15, 21]]], open: [true, true, true], star: [19, 6] },
    discussions: { loops: [[[3, 11], [5, 7], [19, 7], [21, 11], [21, 17], [3, 17]], [[12, 11], [12, 17]]], open: [false, true], star: [3, 17] },
    people: { loops: [ring(9, 8, 3.3, 6, -Math.PI / 2), [[3, 20], [6, 14.5], [12, 14.5], [15, 20]], ring(16.8, 8.8, 2.4, 5, -Math.PI / 2), [[17, 14.5], [21, 20]]], open: [false, true, false, true], star: [9, 4.7] },
    activity: { loops: [[[4, 13], [6, 5], [18, 5], [20, 13], [20, 20], [4, 20]], [[4, 13], [9, 13], [10.5, 15.5], [13.5, 15.5], [15, 13], [20, 13]]], open: [false, true], star: [20, 13] },
    tools: { loops: [[[3, 9], [21, 9], [21, 20], [3, 20]], [[9, 9], [9, 6], [15, 6], [15, 9]]], open: [false, true], star: [15, 6] },
    settings: { loops: [gearPts(12, 12, 9.6, 7, 8)], star: [12, 2.4] },
    music: { loops: [[[3, 6], [21, 6], [21, 18], [3, 18]], [[8, 6], [8, 13]], [[12, 6], [12, 13]], [[16, 6], [16, 13]]], open: [false, true, true, true], star: [21, 6] },
    trading: { loops: [[[4, 4], [4, 20], [20, 20]], [[7, 15], [11, 10], [14, 13], [19, 6]]], open: [true, true], star: [19, 6] },
    decks: { loops: [[[4, 8], [13, 8], [13, 21], [4, 21]], [[9, 4], [20, 4], [20, 17]]], open: [false, true], star: [20, 4] },
    usage: { loops: [[[4, 19], [9, 13], [13, 17], [20, 9]], [[15, 9], [20, 9], [20, 14]]], open: [true, true], star: [20, 9] },
    host: { loops: [ring(8, 14, 4.5, 6, -Math.PI / 2), [[11.2, 10.8], [20, 2]], [[17, 5], [19.5, 7.5]], [[14.5, 7.5], [17, 10]]], open: [false, true, true, true], star: [20, 2] },
    docs: { loops: [[[4, 3], [20, 3], [20, 21], [4, 21]], [[8, 3], [8, 21]], [[11.5, 8], [16.5, 8]], [[11.5, 12], [16.5, 12]]], open: [false, true, true, true], star: [20, 3] },
    share: { loops: [ring(8.5, 12, 4.5, 6, 0), ring(15.5, 12, 4.5, 6, Math.PI)], star: [12, 12] },
    notes: { loops: [[[4, 3], [20, 3], [20, 21], [4, 21]], [[8, 8], [16, 8]], [[8, 12], [16, 12]], [[8, 16], [13, 16]]], open: [false, true, true, true], star: [20, 3] },
    map: { loops: [[[12, 5], [5, 17.5], [19, 17.5]], [[12, 5], [12, 12.5]], [[12, 12.5], [5, 17.5]], [[12, 12.5], [19, 17.5]]], open: [false, true, true, true], star: [12, 12.5] },
    compass: { loops: [ring(12, 12, 9, 8, -Math.PI / 2), [[12, 7], [14.5, 12], [12, 17], [9.5, 12]]], star: [12, 7] },
    target: { loops: [ring(12, 12, 9, 8, -Math.PI / 2), ring(12, 12, 5, 5, -Math.PI / 2)], star: [12, 12] },
    folder: { loops: [[[3, 7], [9, 5], [11, 7], [21, 7], [21, 19], [3, 19]]], star: [11, 7] },
    puzzle: { loops: [[[4, 4], [10, 4], [12.5, 2], [15, 4], [20, 4], [20, 9], [22, 12], [20, 15], [20, 20], [15, 20], [12.5, 22], [10, 20], [4, 20], [4, 15], [2, 12], [4, 9]]], star: [12.5, 2] },
    play: { loops: [[[7, 4], [19, 12], [7, 20]]], star: [19, 12] },
    timer: { loops: [ring(12, 13, 8, 8, -Math.PI / 2), [[12, 9], [12, 13], [15, 15]], [[9, 2], [15, 2]]], open: [false, true, true], star: [12, 5] },
    heart: { loops: [heart], star: [12, 9.5] },
    mail: { loops: [[[3, 5], [21, 5], [21, 19], [3, 19]], [[3, 8], [12, 14], [21, 8]]], open: [false, true], star: [12, 14] },
    calendar: { loops: [[[3, 5], [21, 5], [21, 21], [3, 21]], [[3, 10], [21, 10]], [[8, 3], [8, 7]], [[16, 3], [16, 7]]], open: [false, true, true, true], star: [16, 3] },
    idcard: { loops: [[[2, 5], [22, 5], [22, 19], [2, 19]], ring(8, 11, 2.4, 5, -Math.PI / 2), [[14, 10], [19, 10]], [[14, 13.5], [19, 13.5]]], open: [false, false, true, true], star: [8, 8.6] },
    mic: { loops: [[[9, 6], [12, 3], [15, 6], [15, 11], [12, 14], [9, 11]], [[6, 11], [12, 17], [18, 11]], [[12, 17], [12, 21]], [[9, 21], [15, 21]]], open: [false, true, true, true], star: [12, 3] },
    palette: { loops: [ring(12, 12, 9, 9, -Math.PI / 2), [[7.5, 11], [10, 7.5], [14.5, 7.5], [17.5, 11]]], open: [false, true], star: [14.5, 7.5] },
    person: { loops: [ring(12, 8, 4, 6, -Math.PI / 2), [[4, 21], [7, 15], [17, 15], [20, 21]]], open: [false, true], star: [12, 4] },
    gradcap: { loops: [[[2, 9], [12, 4], [22, 9], [12, 14]], [[6, 11], [6, 16], [12, 19], [18, 16], [18, 11]], [[22, 9], [22, 15]]], open: [false, true, true], star: [12, 4] },
    moon: { loops: [[[14, 3], [8, 6], [5.5, 12], [8, 18], [14, 21], [19, 18], [15.5, 15], [13, 11], [14, 7]]], star: [19, 18] },
    sun: { loops: [ring(12, 12, 4, 6, -Math.PI / 2), ...ring(12, 12, 9, 8, -Math.PI / 2).map((p, i) => [ring(12, 12, 6.3, 8, -Math.PI / 2)[i], p])], open: [false, true, true, true, true, true, true, true, true], star: [12, 12] },
    plug: { loops: [[[6, 8], [18, 8], [17, 14], [12, 17], [7, 14]], [[9, 3], [9, 8]], [[15, 3], [15, 8]], [[12, 17], [12, 21]]], open: [false, true, true, true], star: [9, 3] },
    code: { loops: [[[8, 7], [3, 12], [8, 17]], [[16, 7], [21, 12], [16, 17]], [[14, 4], [10, 20]]], open: [true, true, true], star: [14, 4] },
    notebook: { loops: [[[7, 3], [20, 3], [20, 21], [7, 21]], [[11, 3], [11, 21]], [[4, 7.5], [8, 7.5]], [[4, 12], [8, 12]], [[4, 16.5], [8, 16.5]]], open: [false, true, true, true, true], star: [20, 3] }
};

export function constellationMarkup(name: GlyphName, uid: string): string {
    const fig = CONSTELLATION[name];
    let out = '';
    fig.loops.forEach((pts, i) => {
        const open = fig.open?.[i] ?? false;
        out += `<path d="${poly(pts, !open)}" fill="none" stroke="currentColor" stroke-width=".9" stroke-opacity=".55" stroke-linejoin="round"/>`;
        for (const p of pts) out += `<circle cx="${p[0]}" cy="${p[1]}" r="1.15" fill="currentColor"/>`;
    });
    const id = `star-${uid}`;
    out += `<defs><filter id="${id}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.3"/></filter></defs>`
        + `<circle cx="${fig.star[0]}" cy="${fig.star[1]}" r="2.6" fill="${A}" filter="url(#${id})" opacity=".8"/>`
        + `<circle cx="${fig.star[0]}" cy="${fig.star[1]}" r="1.7" fill="${ALITE}"/>`;
    return out;
}
