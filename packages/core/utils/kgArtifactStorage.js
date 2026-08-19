/**
 * Disk storage for knowledge-graph artifacts.
 * Files live under data/kg-artifacts/<guildId>/<authorId>/ with content-hash
 * dedupe. relativePath is stored in kg_artifacts (portable across machines).
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { dataDir } = require('../runtimePaths');
const { sanitizeFilename } = require('../config/kgArtifactConfig');

const ARTIFACTS_ROOT = process.env.GOOBSTER_KG_ARTIFACTS_DIR
    || path.join(dataDir, 'kg-artifacts');

function scopeDir(guildId, authorId) {
    return path.join(ARTIFACTS_ROOT, String(guildId), String(authorId));
}

function toRelativePath(absolutePath) {
    const rel = path.relative(dataDir, absolutePath);
    if (rel.startsWith('..')) return null;
    return rel.split(path.sep).join('/');
}

function resolveRelativePath(relativePath) {
    const abs = path.resolve(dataDir, String(relativePath || '').replace(/\//g, path.sep));
    if (!abs.startsWith(path.resolve(dataDir))) return null;
    return abs;
}

/**
 * Persist bytes for a KG artifact.
 * @returns {{ relativePath: string, contentHash: string, sizeBytes: number, absolutePath: string }}
 */
function saveBuffer({ guildId, authorId, originalName, buffer }) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
    const safeName = sanitizeFilename(originalName);
    const dir = scopeDir(guildId, authorId);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${hash}-${safeName}`;
    const absolutePath = path.join(dir, fileName);
    if (!fs.existsSync(absolutePath)) {
        fs.writeFileSync(absolutePath, buffer);
    }
    const relativePath = toRelativePath(absolutePath);
    if (!relativePath) throw new Error('Artifact path escaped data directory');
    return {
        relativePath,
        contentHash: hash,
        sizeBytes: buffer.length,
        absolutePath
    };
}

function readBuffer(relativePath) {
    const absolutePath = resolveRelativePath(relativePath);
    if (!absolutePath || !fs.existsSync(absolutePath)) return null;
    return fs.readFileSync(absolutePath);
}

function deleteRelativePath(relativePath) {
    const absolutePath = resolveRelativePath(relativePath);
    if (!absolutePath || !fs.existsSync(absolutePath)) return false;
    fs.unlinkSync(absolutePath);
    return true;
}

function deleteAuthorArtifacts(guildId, authorId) {
    const dir = scopeDir(guildId, authorId);
    let count = 0;
    try {
        count = fs.readdirSync(dir).length;
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // no directory
    }
    return count;
}

function deleteGuildArtifacts(guildId) {
    const dir = path.join(ARTIFACTS_ROOT, String(guildId));
    let count = 0;
    try {
        for (const author of fs.readdirSync(dir)) {
            const sub = path.join(dir, author);
            count += fs.readdirSync(sub).length;
            fs.rmSync(sub, { recursive: true, force: true });
        }
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // no directory
    }
    return count;
}

function countAuthorArtifacts(guildId, authorId) {
    try {
        return fs.readdirSync(scopeDir(guildId, authorId)).length;
    } catch {
        return 0;
    }
}

module.exports = {
    ARTIFACTS_ROOT,
    saveBuffer,
    readBuffer,
    deleteRelativePath,
    deleteAuthorArtifacts,
    deleteGuildArtifacts,
    countAuthorArtifacts,
    resolveRelativePath,
    toRelativePath
};
