const sharp = require('sharp');

const WIDTH = 800;
const HEIGHT = 400;
const PAD = { top: 48, right: 24, bottom: 44, left: 72 };

const SPARK_BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Escape a string for embedding into SVG text nodes.
 */
function escapeXml(value) {
    return String(value).replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    })[c]);
}

function formatPrice(value) {
    return value >= 1000
        ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
        : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Render a historical price line chart as a PNG buffer (Discord-dark theme).
 * @param {Object} params
 * @param {string} params.symbol - ticker, used in the title
 * @param {string} [params.name] - company name
 * @param {Array<{date: string, close: number}>} params.points - ordered daily closes
 * @param {string} [params.rangeLabel] - e.g. "3mo"
 * @returns {Promise<Buffer>} PNG image data
 */
async function renderPriceChart({ symbol, name, points, rangeLabel }) {
    if (!Array.isArray(points) || points.length < 2) {
        throw new Error('Need at least 2 data points to draw a chart');
    }

    const closes = points.map(p => p.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || max * 0.01 || 1;
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const x = i => PAD.left + (i / (points.length - 1)) * plotW;
    const y = v => PAD.top + (1 - (v - min) / span) * plotH;

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${PAD.left},${(PAD.top + plotH).toFixed(1)} Z`;

    const first = points[0];
    const last = points[points.length - 1];
    const change = last.close - first.close;
    const changePct = (change / first.close) * 100;
    const up = change >= 0;
    const lineColor = up ? '#3ba55d' : '#ed4245';

    // Horizontal gridlines at quartiles
    const gridLines = [0.25, 0.5, 0.75].map(f => {
        const gy = (PAD.top + f * plotH).toFixed(1);
        return `<line x1="${PAD.left}" y1="${gy}" x2="${WIDTH - PAD.right}" y2="${gy}" stroke="#3f4248" stroke-width="1" stroke-dasharray="4 4"/>`;
    }).join('');

    const title = `${escapeXml(symbol)}${name ? ` - ${escapeXml(name)}` : ''}`;
    const subtitle = `${up ? '+' : ''}${formatPrice(change)} (${up ? '+' : ''}${changePct.toFixed(2)}%)${rangeLabel ? ` over ${escapeXml(rangeLabel)}` : ''}`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#2b2d31"/>
  <text x="${PAD.left}" y="24" font-family="sans-serif" font-size="18" font-weight="bold" fill="#f2f3f5">${title}</text>
  <text x="${PAD.left}" y="42" font-family="sans-serif" font-size="13" fill="${lineColor}">$${formatPrice(last.close)}  ${subtitle}</text>
  ${gridLines}
  <path d="${areaPath}" fill="${lineColor}" opacity="0.15"/>
  <path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round"/>
  <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.close).toFixed(1)}" r="4" fill="${lineColor}"/>
  <text x="${PAD.left - 8}" y="${(y(max) + 4).toFixed(1)}" font-family="sans-serif" font-size="12" fill="#b5bac1" text-anchor="end">$${formatPrice(max)}</text>
  <text x="${PAD.left - 8}" y="${(y(min) + 4).toFixed(1)}" font-family="sans-serif" font-size="12" fill="#b5bac1" text-anchor="end">$${formatPrice(min)}</text>
  <text x="${PAD.left}" y="${HEIGHT - 16}" font-family="sans-serif" font-size="12" fill="#b5bac1">${escapeXml(first.date)}</text>
  <text x="${WIDTH - PAD.right}" y="${HEIGHT - 16}" font-family="sans-serif" font-size="12" fill="#b5bac1" text-anchor="end">${escapeXml(last.date)}</text>
</svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Unicode sparkline fallback (used when sharp can't render), e.g. "▁▂▅▇█".
 * @param {number[]} values
 * @param {number} [buckets] - max characters
 * @returns {string}
 */
function sparkline(values, buckets = 24) {
    if (!Array.isArray(values) || values.length === 0) return '';
    // Downsample to at most `buckets` evenly spaced values
    const sampled = values.length <= buckets
        ? values
        : Array.from({ length: buckets }, (_, i) => values[Math.round(i * (values.length - 1) / (buckets - 1))]);
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const span = max - min || 1;
    return sampled
        .map(v => SPARK_BLOCKS[Math.min(SPARK_BLOCKS.length - 1, Math.floor(((v - min) / span) * SPARK_BLOCKS.length))])
        .join('');
}

module.exports = { renderPriceChart, sparkline };
