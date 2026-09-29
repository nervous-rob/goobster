#!/usr/bin/env node
/**
 * Render the Goobster mark in every accent palette.
 *
 * `apps/web/public/icons/goobster.svg` is the hand-authored master (the
 * Blueberry berry). For each accent in legacy.css (`html[data-accent]`,
 * the same ids as ACCENTS in packages/core/config/userSettingsSchema.js)
 * this re-tints the master's berry colours in OKLCH: every stop keeps the
 * lightness relationship it has in the master and takes the accent's hue,
 * with chroma scaled the way the master's stops relate to Blueberry's own
 * accent. Output: `apps/web/public/icons/berry/<accent>.svg`; the portal
 * shows whichever matches the selected accent (`src/lib/berry.ts`).
 *
 *   node scripts/generate-berry-icons.js          # write the files
 *   node scripts/generate-berry-icons.js --check  # exit 1 if any is stale
 *
 * The leaf, the sheen and the calyx stroke's shadow are not accent colours
 * and stay as the master draws them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'apps/web/public/icons/goobster.svg');
const OUT_DIR = path.join(ROOT, 'apps/web/public/icons/berry');
const STYLESHEET = path.join(ROOT, 'apps/web/src/legacy.css');

/* The master's berry colours and the role each plays. `l` is the OKLCH
   lightness the stop keeps; `chroma` scales the accent's chroma. Blueberry's
   own accent is (124, 140, 255), so rendering it reproduces the master. */
const STOPS = [
    { hex: '#a6b0ff', role: 'highlight' },
    { hex: '#6f7cf2', role: 'mid' },
    { hex: '#2f2686', role: 'deep' },
    { hex: '#c9d0ff', role: 'rim' },
    { hex: '#241d63', role: 'calyx' },
    { hex: '#4c42ad', role: 'calyxDot' }
];
const BLUEBERRY_RGB = [124, 140, 255];

/* ---- colour math (sRGB <-> OKLCH), from Björn Ottosson's reference ---- */

function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v) {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
}
function rgbToOklch([r8, g8, b8]) {
    const r = srgbToLinear(r8), g = srgbToLinear(g8), b = srgbToLinear(b8);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}
function oklchToRgb({ L, C, h }) {
    const a = C * Math.cos((h * Math.PI) / 180), bb = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
}
function inGamut(lin) {
    return lin.every((v) => v >= -0.0005 && v <= 1.0005);
}
/** Lower chroma until the colour fits in sRGB, then quantise to hex. */
function oklchToHex(lch) {
    let { C } = lch;
    let lin = oklchToRgb({ ...lch, C });
    while (!inGamut(lin) && C > 0.001) {
        C -= 0.004;
        lin = oklchToRgb({ ...lch, C });
    }
    return '#' + lin.map(linearToSrgb).map((v) => v.toString(16).padStart(2, '0')).join('');
}

/* ---- the palette, from the stylesheet ---- */

function readAccents(css = fs.readFileSync(STYLESHEET, 'utf8')) {
    const accents = {};
    const blocks = css.matchAll(/html\[data-accent="([a-z]+)"\][^{]*\{([^}]*)\}/g);
    for (const [, id, body] of blocks) {
        const m = body.match(/--accent-rgb-dark:\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) accents[id] = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    return accents;
}

/* ---- rendering ---- */

/** Map each master stop onto the accent: same lightness, the stop's hue
    drift from Blueberry's accent (the deep stops lean purple-ward) carried
    over to the new hue, and chroma scaled the way the stop's relates to it. */
function berryColours(accentRgb) {
    const base = rgbToOklch(BLUEBERRY_RGB);
    const accent = rgbToOklch(accentRgb);
    const out = {};
    for (const stop of STOPS) {
        const master = rgbToOklch(hexToRgb(stop.hex));
        const chroma = accent.C * (master.C / base.C);
        const h = (accent.h + (master.h - base.h) + 360) % 360;
        out[stop.hex] = oklchToHex({ L: master.L, C: chroma, h });
    }
    return out;
}
function hexToRgb(hex) {
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function renderBerry(id, accentRgb, master = fs.readFileSync(MASTER, 'utf8')) {
    const colours = berryColours(accentRgb);
    let svg = master;
    for (const [from, to] of Object.entries(colours)) {
        svg = svg.split(from).join(to);
    }
    const header = `<!--
  The Goobster mark in the "${id}" accent. Generated from goobster.svg by
  scripts/generate-berry-icons.js - edit the master or the script, not this
  file, then re-run the script (CI checks the set is current).
-->\n`;
    return svg.replace(/^<!--[\s\S]*?-->\n/, header);
}

function main(argv) {
    const check = argv.includes('--check');
    const accents = readAccents();
    if (!accents.blueberry) throw new Error('legacy.css has no html[data-accent="blueberry"] palette');
    const master = fs.readFileSync(MASTER, 'utf8');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let stale = 0;
    for (const [id, rgb] of Object.entries(accents)) {
        const file = path.join(OUT_DIR, `${id}.svg`);
        const svg = renderBerry(id, rgb, master);
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (current === svg) continue;
        stale += 1;
        if (check) {
            console.error(`stale: ${path.relative(ROOT, file)}`);
        } else {
            fs.writeFileSync(file, svg);
            console.log(`wrote ${path.relative(ROOT, file)}`);
        }
    }
    if (check && stale) {
        console.error(`${stale} berry icon(s) out of date - run: node scripts/generate-berry-icons.js`);
        process.exit(1);
    }
    if (!stale) console.log(`berry icons current (${Object.keys(accents).length} accents)`);
}

module.exports = { readAccents, berryColours, renderBerry, rgbToOklch, oklchToHex, STOPS, OUT_DIR, MASTER };

if (require.main === module) {
    main(process.argv.slice(2));
}
