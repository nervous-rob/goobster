/**
 * Parse a base64 image data URL into its mime type and payload.
 * Used by the AI providers so locally captured frames (e.g. screen-vision
 * companion screenshots) can ride the same `images` field as public URLs.
 *
 * @param {string} url
 * @returns {{ mimeType: string, data: string } | null}
 */
function parseImageDataUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('data:image/')) return null;
    const match = /^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
}

module.exports = { parseImageDataUrl };
