/**
 * Sigils: abstract marks rather than pictures. Each destination gets a
 * simple sign (ripples for Spitball, an orbit for the Observatory, voices
 * around a table for the Parlor) in the accent and its quieter tone.
 */
import { A, A2, ALITE, INK, circ, fill as f, poly, ring, rr, stroke } from './shapes';
import type { GlyphName } from './names';

export const SIGILS: Record<GlyphName, () => string> = {
    home: () => f(rr(3, 3, 18, 18, 6), A2) + f(circ(12, 12, 3.4), A),
    chat: () => f(rr(3, 4, 13, 10, 5), A2) + f(rr(8, 10, 13, 10, 5), A),
    knowledge: () => stroke('M4 20a8 8 0 0 1 16 0', A2, 3) + stroke('M8 20a4 4 0 0 1 8 0', A, 3) + f(circ(12, 20, 1.6), A) + f(circ(12, 5, 2.2), A),
    projects: () => stroke(circ(11, 13, 7), A2, 3) + f(circ(18.5, 5.5, 2.8), A),
    discussions: () => f(rr(3, 5, 18, 4, 2), A) + f(rr(3, 10.5, 12, 4, 2), A2) + f(rr(8, 16, 13, 4, 2), A),
    people: () => f(circ(9, 12, 6.5), A2) + f(circ(15, 12, 6.5), A) + f('M12 6.6a6.5 6.5 0 0 1 0 10.8 6.5 6.5 0 0 1 0-10.8Z', ALITE),
    activity: () => f(rr(3, 4, 18, 4, 2), A) + f(rr(3, 10, 18, 4, 2), A2) + f(rr(3, 16, 18, 4, 2), A2),
    tools: () => f(poly(ring(12, 12, 10, 6, -Math.PI / 6)), A) + f(rr(9.5, 9.5, 5, 5, 1), INK),
    settings: () => f(ring(12, 12, 7.6, 6, -Math.PI / 2).map((p) => circ(p[0], p[1], 2)).join(''), A) + f(circ(12, 12, 2.6), A2),
    music: () => f(rr(3, 11, 4, 10, 2), A) + f(rr(10, 4, 4, 17, 2), A2) + f(rr(17, 8, 4, 13, 2), A),
    trading: () => f(circ(5, 18, 2.2), A2) + f(circ(10, 14, 2.2), A2) + f(circ(15, 10, 2.2), A2) + f(circ(20, 5, 3), A),
    decks: () => `<g transform="rotate(-10 10 13)">${f(rr(4, 6, 12, 14, 3), A2)}</g>` + f(rr(9, 4, 12, 14, 3), A),
    usage: () => stroke('M4 17a8 8 0 0 1 16 0', A2, 3) + f(circ(17.5, 11, 2.6), A),
    host: () => f(circ(12, 9, 5), A) + f(poly([[10, 12], [14, 12], [16, 20], [8, 20]]), A),
    docs: () => f(rr(4, 3, 11, 15, 2), A2) + f(rr(9, 6, 11, 15, 2), A),
    share: () => stroke('M6 12 18 6M6 12l12 6', A2, 2) + f(circ(6, 12, 3), A) + f(circ(18, 6, 3) + circ(18, 18, 3), A2),
    notes: () => f(poly([[4, 3], [15, 3], [20, 8], [20, 21], [4, 21]]), A2) + f(poly([[15, 3], [15, 8], [20, 8]]), A),
    map: () => stroke('M12 5 5 18h14Z', A2, 1.8) + f(circ(12, 5, 2.4) + circ(5, 18, 2.4) + circ(19, 18, 2.4), A),
    compass: () => f(circ(12, 12, 9.5), A2) + f(poly([[12, 4], [15, 12], [12, 20], [9, 12]]), A),
    target: () => f(circ(12, 12, 9.5), A2) + f(circ(12, 12, 4), A),
    folder: () => f(rr(3, 7, 18, 13, 3), A2) + f(rr(3, 4, 9, 5, 2.5), A),
    puzzle: () => f(rr(3, 3, 8, 8, 2) + rr(13, 3, 8, 8, 2) + rr(3, 13, 8, 8, 2), A2) + f(rr(14, 14, 8, 8, 2), A),
    play: () => f('M7 5.2c0-1.3 1.4-2.1 2.5-1.4l10 6.8c1 .7 1 2.1 0 2.8l-10 6.8C8.4 20.9 7 20.1 7 18.8Z', A),
    timer: () => f(circ(12, 12, 9.5), A2) + f('M12 12V2.5a9.5 9.5 0 0 1 9.5 9.5Z', A),
    heart: () => f(circ(8.5, 12, 5.5), A2) + f(circ(15.5, 12, 5.5), A),
    mail: () => f(rr(2, 5, 20, 14, 3), A2) + f(poly([[2, 8], [12, 15], [22, 8], [22, 11], [12, 18], [2, 11]]), A),
    calendar: () => f(circ(6, 7, 2.4) + circ(12, 7, 2.4) + circ(18, 7, 2.4) + circ(6, 17, 2.4) + circ(18, 17, 2.4), A2) + f(circ(12, 17, 3.2), A),
    idcard: () => f(rr(2, 5, 20, 14, 3), A2) + f(circ(8, 12, 3.2), A) + f(rr(13, 9, 7, 2, 1) + rr(13, 13, 7, 2, 1), A),
    mic: () => f(rr(8, 3, 8, 12, 4), A) + stroke('M5 12a7 7 0 0 0 14 0', A2, 2.5),
    palette: () => f(circ(7, 9, 3) + circ(14, 6, 3) + circ(18, 13, 3), A2) + f(circ(9, 17, 4.2), A),
    person: () => f(circ(12, 8, 4.5), A) + f('M4 21a8 8 0 0 1 16 0Z', A2),
    gradcap: () => f(poly([[2, 9], [12, 4], [22, 9], [12, 14]]), A) + f(rr(6, 13, 12, 5, 2.5), A2),
    moon: () => f('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z', A),
    sun: () => f(circ(12, 12, 5), A) + stroke(circ(12, 12, 9), A2, 2),
    plug: () => f(rr(8, 2, 3, 6, 1.5) + rr(13, 2, 3, 6, 1.5), A2) + f(rr(5, 8, 14, 10, 4), A) + f(rr(11, 17, 2, 5, 1), A2),
    code: () => stroke('M8 7l-5 5 5 5M16 7l5 5-5 5', A, 2.6) + stroke('M13.5 5l-3 14', A2, 2.2),
    notebook: () => f(rr(5, 3, 15, 18, 3), A2) + f(rr(5, 3, 5, 18, 2), A)
};
