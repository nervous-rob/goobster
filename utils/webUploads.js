/**
 * Disk storage for user-uploaded web chat images. Uploads arrive as data
 * URLs (vision attachments); persisting them under data/web-uploads/<userId>/
 * lets history re-serve them after a reload, exactly like the bot's
 * generated files (metadata.attachments + the owner-bound file route).
 *
 * Content-hash filenames make saves idempotent (re-sending the same image
 * stores one file). /forget-me removes the user's whole directory - the
 * files are message content, so they must not outlive the messages.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const UPLOADS_ROOT = path.join(__dirname, '..', 'data', 'web-uploads');

const EXTENSIONS = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' };

/** The user's upload directory (not created until something is saved). */
function userUploadDir(userId) {
    return path.join(UPLOADS_ROOT, String(userId));
}

/**
 * Persist one image data URL for a user.
 * @param {string} userId - Discord user snowflake
 * @param {string} dataUrl - validated image data URL (webChatService checks
 *   the pattern and size before calling)
 * @returns {{path: string, name: string}|null} null when the URL is not decodable
 */
function saveDataUrlImage(userId, dataUrl) {
    const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    const ext = EXTENSIONS[match[1].toLowerCase()] || 'png';
    let buffer;
    try {
        buffer = Buffer.from(match[2], 'base64');
    } catch {
        return null;
    }
    if (buffer.length === 0) return null;

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
    const dir = userUploadDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const name = `upload-${hash}.${ext}`;
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buffer);
    }
    return { path: filePath, name };
}

/**
 * Erase every upload a user ever made (the /forget-me path).
 * @returns {number} files removed
 */
function deleteUserUploads(userId) {
    const dir = userUploadDir(userId);
    let count = 0;
    try {
        count = fs.readdirSync(dir).length;
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // No directory = nothing ever uploaded
    }
    return count;
}

/** Files still on disk for a user (the post-erasure audit). */
function countUserUploads(userId) {
    try {
        return fs.readdirSync(userUploadDir(userId)).length;
    } catch {
        return 0;
    }
}

module.exports = { saveDataUrlImage, deleteUserUploads, countUserUploads, userUploadDir };
