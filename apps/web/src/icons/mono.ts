/**
 * Monoline: rounded strokes on the 24 grid, no fills. Draws in
 * `currentColor`, so it is dim at rest and takes the accent when its row is
 * active. Neon reuses these paths behind a glow.
 */
import { circ, gearPts, poly, type Pt } from './shapes';
import type { GlyphName } from './names';

export const MONO: Record<GlyphName, string[]> = {
    home: ['M4 11 12 4l8 7v8.5A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5Z', 'M10 21v-6h4v6'],
    chat: ['M5 5h14a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 19 17h-7.5L7 20.5V17H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 5Z', 'M8 11h.01M12 11h.01M16 11h.01'],
    knowledge: ['M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1.1.9 1.8v.8h5.2v-.8c0-.7.3-1.4.9-1.8A6 6 0 0 0 12 3Z', 'M9.6 19.5h4.8M10.5 22h3'],
    projects: ['M3.4 13.9 17.1 6.3', 'M4.8 16.4 18.5 8.8', 'M3.4 13.9a1.4 1.4 0 0 0 1.4 2.5', 'M18.5 8.8a1.4 1.4 0 1 0-1.4-2.5', 'M20.6 5.6l.9 1.6', 'M10.5 15.4 7.4 21M11.9 14.6 15.2 21'],
    discussions: ['M5 11V9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2', 'M3 11h18a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z', 'M5 17v2M19 17v2M12 11v6'],
    people: ['M9 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z', 'M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6', 'M16.5 11a2.5 2.5 0 1 0 0-5', 'M17 14.5c2.3 0 4 2 4 5.5'],
    activity: ['M4 13l2.3-7.5h11.4L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'M4 13h4.5l1.5 2.5h4l1.5-2.5H20'],
    tools: ['M3 11a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 9V7a3 3 0 0 1 6 0v2', 'M3 13.5h18', 'M10.5 12h3v3h-3Z'],
    music: ['M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M8 6v8M12 6v8M16 6v8', 'M3 14h18'],
    trading: ['M4 4v16h16', 'M7 15l4-5 3 3 5-7'],
    decks: ['M4 8a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'M9 4h9a2 2 0 0 1 2 2v11'],
    usage: ['M4 19 9 13l4 4 7-8', 'M15 9h5v5'],
    settings: [poly(gearPts(12, 12, 9.6, 7.4, 8)), circ(12, 12, 2.6)],
    host: ['M8 18.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z', 'M11.2 10.8 20 2', 'M17 5l2.5 2.5M14.5 7.5 17 10'],
    docs: ['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'M8 3v18', 'M11.5 8h5M11.5 12h5'],
    share: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    notes: ['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'M8 8h8M8 12h8M8 16h5'],
    map: [circ(12, 5, 2), circ(5, 17.5, 2), circ(19, 17.5, 2), circ(12, 12.5, 2), 'M12 7v3.5M10.5 14l-4 2.2M13.5 14l4 2.2'],
    compass: [circ(12, 12, 9), poly([[12, 7], [14.5, 12], [12, 17], [9.5, 12]])],
    target: [circ(12, 12, 9), circ(12, 12, 5.5), circ(12, 12, 2)],
    folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
    puzzle: ['M4 9V4h6a2.5 2.5 0 0 1 5 0h5v5a2.5 2.5 0 0 0 0 5v6h-5a2.5 2.5 0 0 1-5 0H4v-6a2.5 2.5 0 0 1 0-5Z'],
    play: [poly([[7, 4], [19, 12], [7, 20]])],
    timer: [circ(12, 13, 8), 'M12 9v4l3 2', 'M9 2h6M12 2v3'],
    heart: ['M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z'],
    mail: ['M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 8l9 6 9-6'],
    calendar: ['M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 10h18M8 3v4M16 3v4'],
    idcard: ['M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z', circ(8, 11, 2.2), 'M5.5 16.5c0-1.6 1.1-2.8 2.5-2.8s2.5 1.2 2.5 2.8', 'M14 10h5M14 13.5h5'],
    mic: ['M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0Z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4M9 21h6'],
    palette: ['M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.4-.9-.4-1.3 0-1.1.9-2 2-2h2a4 4 0 0 0 4-4c0-4.4-4-7.3-9-7.3Z', 'M7.5 11h.01M10 7.5h.01M14.5 7.5h.01M17.5 11h.01'],
    person: [circ(12, 8, 4), 'M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5'],
    gradcap: ['M2 9l10-5 10 5-10 5Z', 'M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5', 'M22 9v6'],
    moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'],
    sun: [circ(12, 12, 4), 'M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8'],
    plug: ['M9 3v5M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0Z', 'M12 17v4'],
    code: ['M8 7l-5 5 5 5M16 7l5 5-5 5', 'M14 4l-4 16'],
    notebook: ['M7 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z', 'M4 7.5h4M4 12h4M4 16.5h4', 'M11 3v18']
};

/** Monoline as markup in `currentColor`. */
export function monoMarkup(name: GlyphName, width = 1.75, color = 'currentColor'): string {
    return MONO[name].map((d) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
}

export type { Pt };
