/**
 * One entry point: the inner SVG markup for a glyph in an icon style, or
 * null for the emoji style (the caller shows the emoji). Every style is
 * generated from the vocabularies in this folder; nothing is a bitmap or a
 * hand-exported file, so a glyph recolours with the accent and the theme.
 */
import { BLOCKS } from './blocks';
import { constellationMarkup } from './constellation';
import { monoMarkup } from './mono';
import { pixelMarkup } from './pixel';
import { SIGILS } from './sigils';
import { A, ALITE } from './shapes';
import type { GlyphName } from './names';
import type { IconStyle } from '../lib/appearance';

function neonMarkup(name: GlyphName, uid: string): string {
    const id = `glow-${uid}`;
    return `<defs><filter id="${id}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.5"/></filter></defs>`
        + `<g filter="url(#${id})" opacity=".85">${monoMarkup(name, 2.2, A)}</g>${monoMarkup(name, 1.4, ALITE)}`;
}

export function renderGlyph(style: IconStyle, name: GlyphName, uid: string): string | null {
    switch (style) {
        case 'mono': return monoMarkup(name);
        case 'blocks': return BLOCKS[name]();
        case 'sigils': return SIGILS[name]();
        case 'pixel': return pixelMarkup(name);
        case 'neon': return neonMarkup(name, uid);
        case 'constellation': return constellationMarkup(name, uid);
        default: return null;
    }
}
