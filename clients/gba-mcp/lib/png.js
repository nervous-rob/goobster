/**
 * Minimal zero-dependency PNG codec, just enough for mGBA screenshots.
 *
 * mGBA writes standard non-interlaced 8-bit RGB/RGBA PNGs (240x160 for
 * GBA). GBA screens are tiny, and vision models read them far better
 * upscaled, so the MCP server decodes, nearest-neighbor upscales, and
 * re-encodes without pulling in native image libraries (the repo's
 * clients/ apps stay dependency-free so they run anywhere Node runs).
 *
 * Supported input: bit depth 8, color type 2 (RGB) or 6 (RGBA),
 * no interlacing. Output: color type 6 (RGBA), filter 0 rows.
 */

const zlib = require('node:zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Standard CRC-32 (as used by PNG), table computed once.
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Decode a PNG buffer into raw RGBA pixels.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function decodePng(buffer) {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Not a PNG file');
    }
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idatParts = [];

    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idatParts.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length; // length + type + data + crc
    }

    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
    }

    const channels = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    const stride = width * channels;
    const rgba = Buffer.alloc(width * height * 4);
    const prior = Buffer.alloc(stride);

    let pos = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        const row = raw.subarray(pos, pos + stride);
        pos += stride;
        // Un-filter in place (row is a view into raw).
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? row[x - channels] : 0;
            const up = prior[x];
            const upLeft = x >= channels ? prior[x - channels] : 0;
            switch (filter) {
                case 0: break;
                case 1: row[x] = (row[x] + left) & 0xff; break;
                case 2: row[x] = (row[x] + up) & 0xff; break;
                case 3: row[x] = (row[x] + ((left + up) >> 1)) & 0xff; break;
                case 4: row[x] = (row[x] + paethPredictor(left, up, upLeft)) & 0xff; break;
                default: throw new Error(`Unsupported PNG filter type ${filter}`);
            }
        }
        row.copy(prior);
        // Expand to RGBA.
        for (let x = 0; x < width; x++) {
            const src = x * channels;
            const dst = (y * width + x) * 4;
            rgba[dst] = row[src];
            rgba[dst + 1] = row[src + 1];
            rgba[dst + 2] = row[src + 2];
            rgba[dst + 3] = channels === 4 ? row[src + 3] : 0xff;
        }
    }

    return { width, height, rgba };
}

/**
 * Encode raw RGBA pixels as a PNG buffer (color type 6, filter 0).
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @returns {Buffer}
 */
function encodePng({ width, height, rgba }) {
    if (rgba.length !== width * height * 4) {
        throw new Error('rgba buffer size does not match dimensions');
    }
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: None
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const chunks = [
        PNG_SIGNATURE,
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', zlib.deflateSync(raw)),
        makeChunk('IEND', Buffer.alloc(0))
    ];
    return Buffer.concat(chunks);
}

function makeChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 'ascii');
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    return chunk;
}

/**
 * Nearest-neighbor integer upscale.
 * @param {{ width: number, height: number, rgba: Buffer }} image
 * @param {number} factor integer >= 1
 * @returns {{ width: number, height: number, rgba: Buffer }}
 */
function upscaleNearest({ width, height, rgba }, factor) {
    if (!Number.isInteger(factor) || factor < 1) {
        throw new Error('Upscale factor must be a positive integer');
    }
    if (factor === 1) return { width, height, rgba };
    const outWidth = width * factor;
    const outHeight = height * factor;
    const out = Buffer.alloc(outWidth * outHeight * 4);
    for (let y = 0; y < outHeight; y++) {
        const srcY = (y / factor) | 0;
        for (let x = 0; x < outWidth; x++) {
            const srcX = (x / factor) | 0;
            const src = (srcY * width + srcX) * 4;
            const dst = (y * outWidth + x) * 4;
            out[dst] = rgba[src];
            out[dst + 1] = rgba[src + 1];
            out[dst + 2] = rgba[src + 2];
            out[dst + 3] = rgba[src + 3];
        }
    }
    return { width: outWidth, height: outHeight, rgba: out };
}

/**
 * Upscale a PNG buffer by an integer factor (decode → scale → encode).
 * Factor 1 returns the input untouched.
 * @param {Buffer} pngBuffer
 * @param {number} factor
 * @returns {Buffer}
 */
function upscalePng(pngBuffer, factor) {
    if (factor === 1) return pngBuffer;
    return encodePng(upscaleNearest(decodePng(pngBuffer), factor));
}

module.exports = { decodePng, encodePng, upscaleNearest, upscalePng, crc32 };
