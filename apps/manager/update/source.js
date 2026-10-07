/**
 * Where a release comes from, and the download hook (`release.DOWNLOAD_HOOK`) behind it.
 *
 *   github-release  the GitHub Releases API of one repository, over `fetch`
 *   url             a base URL that serves release-index.json, release-index.sig and the artifacts
 *   directory       a local directory laid out the same way (an air-gapped copy, the proof, a test)
 *
 * A source does two things: put the signed index and its signature in a directory
 * (`fetchIndex`), and put one named artifact in a `.partial` file with its size and SHA-256
 * checked before it is renamed into place (`fetchArtifact`). It trusts nothing it fetches:
 * the caller verifies the index signature (install/release.js `verifyReleaseIndex`) before
 * it asks for an artifact, and the artifact's digest against that index.
 *
 * Nothing here logs, records or throws a URL or a path: a refusal is a ManagerError with a
 * stable code and no address.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ManagerError } = require('../errors');

const INDEX_FILE = 'release-index.json';
const SIGNATURE_FILE = 'release-index.sig';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const INDEX_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 60 * 60_000;
const GITHUB_HOSTS = [/(^|\.)github\.com$/, /(^|\.)githubusercontent\.com$/];
const FILE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/;

function refuse(code, message) {
    return new ManagerError(502, code, message);
}

function bareFile(name) {
    if (typeof name !== 'string' || !FILE_SHAPE.test(name) || name.includes('..')) {
        throw new ManagerError(409, 'ARTIFACT_NAME_INVALID', 'The release index names an artifact file that is not a plain file name.');
    }
    return name;
}

/** Count and cap the bytes passing through; hash them. */
function meter(limit) {
    const hash = crypto.createHash('sha256');
    const state = { bytes: 0, hash };
    const stream = new Transform({
        transform(chunk, encoding, callback) {
            state.bytes += chunk.length;
            if (state.bytes > limit) return callback(refuse('DOWNLOAD_TOO_LARGE', 'The download is larger than the release index says it is; it was stopped.'));
            hash.update(chunk);
            return callback(null, chunk);
        }
    });
    return { stream, state };
}

function removeQuietly(fs, file) {
    try { fs.rmSync(file, { force: true }); } catch { }
}

/**
 * Write `readable` to `<dest>` through a `.partial` sibling, checking `expect` before the rename.
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
async function landFile({ fs, readable, dest, limit, expect = null }) {
    const partial = `${dest}.partial`;
    removeQuietly(fs, partial);
    const { stream, state } = meter(limit);
    try {
        await pipeline(readable, stream, fs.createWriteStream(partial, { mode: 0o600 }));
        const sha256 = state.hash.digest('hex');
        if (expect && ((expect.size !== undefined && state.bytes !== expect.size) || (expect.sha256 !== undefined && sha256 !== expect.sha256))) {
            throw new ManagerError(409, 'ARTIFACT_DIGEST_MISMATCH', 'The downloaded file does not match the size and SHA-256 the signed release index records; it was discarded.');
        }
        const fd = fs.openSync(partial, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(partial, dest);
        return { bytes: state.bytes, sha256 };
    } catch (error) {
        removeQuietly(fs, partial);
        if (error instanceof ManagerError) throw error;
        throw refuse('DOWNLOAD_FAILED', 'The release could not be downloaded.');
    }
}

function createDirectorySource({ dir, fs }) {
    const inside = (file) => path.join(dir, bareFile(file));
    return {
        kind: 'directory',
        async fetchIndex(destDir) {
            for (const [name, limit] of [[INDEX_FILE, MAX_INDEX_BYTES], [SIGNATURE_FILE, MAX_SIGNATURE_BYTES]]) {
                const from = path.join(dir, name);
                let stat;
                try {
                    stat = fs.lstatSync(from);
                } catch {
                    if (name === SIGNATURE_FILE) continue;
                    throw new ManagerError(409, 'SOURCE_UNREACHABLE', 'The release source holds no release index.');
                }
                if (!stat.isFile()) throw new ManagerError(409, 'SOURCE_UNREACHABLE', 'The release source holds no release index.');
                await landFile({ fs, readable: fs.createReadStream(from), dest: path.join(destDir, name), limit });
            }
            return {};
        },
        async fetchArtifact(file, destFile, expect) {
            const from = inside(file);
            try {
                if (!fs.lstatSync(from).isFile()) throw new Error('not a file');
            } catch {
                throw new ManagerError(409, 'ARTIFACT_MISSING', 'The release source does not hold an artifact the index lists.');
            }
            return landFile({ fs, readable: fs.createReadStream(from), dest: destFile, limit: Math.min(expect.size, MAX_ARTIFACT_BYTES), expect });
        }
    };
}

function createRemoteSource({ resolveIndexUrls, fetchImpl, fs, allowHost }) {
    async function get(url, { timeoutMs, accept }) {
        let response;
        try {
            response = await fetchImpl(url, { redirect: 'follow', headers: { accept, 'user-agent': 'goobster-manager-update' }, signal: AbortSignal.timeout(timeoutMs) });
        } catch {
            throw refuse('SOURCE_UNREACHABLE', 'The release source could not be reached.');
        }
        if (response.url) {
            let host;
            try { host = new URL(response.url).hostname; } catch { host = ''; }
            if (!allowHost(host, response.url)) {
                try { await response.body?.cancel?.(); } catch { }
                throw refuse('SOURCE_REDIRECTED', 'The release source redirected somewhere it is not allowed to.');
            }
        }
        if (!response.ok || !response.body) {
            try { await response.body?.cancel?.(); } catch { }
            throw refuse('SOURCE_BAD_RESPONSE', `The release source answered with status ${Number(response.status) || 0}.`);
        }
        return response;
    }

    let urls = null;
    return {
        kind: 'remote',
        async fetchIndex(destDir) {
            urls = await resolveIndexUrls({ get });
            for (const [name, limit, required] of [[INDEX_FILE, MAX_INDEX_BYTES, true], [SIGNATURE_FILE, MAX_SIGNATURE_BYTES, false]]) {
                const url = urls.file(name);
                if (!url) {
                    if (required) throw refuse('SOURCE_BAD_RESPONSE', 'The release has no release index.');
                    continue;
                }
                let response;
                try {
                    response = await get(url, { timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/octet-stream, application/json' });
                } catch (error) {
                    if (!required && error instanceof ManagerError && error.code === 'SOURCE_BAD_RESPONSE') continue;
                    throw error;
                }
                await landFile({ fs, readable: Readable.fromWeb(response.body), dest: path.join(destDir, name), limit });
            }
            return { tag: urls.tag || null };
        },
        async fetchArtifact(file, destFile, expect) {
            const url = urls && urls.file(bareFile(file));
            if (!url) throw new ManagerError(409, 'ARTIFACT_MISSING', 'The release source does not offer an artifact the index lists.');
            const response = await get(url, { timeoutMs: ARTIFACT_TIMEOUT_MS, accept: 'application/octet-stream' });
            return landFile({ fs, readable: Readable.fromWeb(response.body), dest: destFile, limit: Math.min(expect.size, MAX_ARTIFACT_BYTES), expect });
        }
    };
}

function createGithubSource({ owner, repo, channel, fetchImpl, fs }) {
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=30`;
    return createRemoteSource({
        fetchImpl,
        fs,
        allowHost: (host) => GITHUB_HOSTS.some(pattern => pattern.test(host)),
        async resolveIndexUrls({ get }) {
            const response = await get(api, { timeoutMs: INDEX_TIMEOUT_MS, accept: 'application/vnd.github+json' });
            let releases;
            try {
                releases = await response.json();
            } catch {
                throw refuse('SOURCE_BAD_RESPONSE', 'The release list could not be read.');
            }
            if (!Array.isArray(releases)) throw refuse('SOURCE_BAD_RESPONSE', 'The release list could not be read.');
            const pick = releases.find(item => item && !item.draft && (channel === 'prerelease' || !item.prerelease) && Array.isArray(item.assets)
                && item.assets.some(asset => asset && asset.name === INDEX_FILE));
            if (!pick) throw new ManagerError(404, 'NO_RELEASE', `No ${channel} release with a release index is published.`);
            const byName = new Map(pick.assets.filter(asset => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string').map(asset => [asset.name, asset.browser_download_url]));
            return { tag: typeof pick.tag_name === 'string' ? pick.tag_name : null, file: (name) => byName.get(name) || null };
        }
    });
}

function createUrlSource({ base, fetchImpl, fs }) {
    const origin = new URL(base);
    return createRemoteSource({
        fetchImpl,
        fs,
        allowHost: (host) => host === origin.hostname,
        async resolveIndexUrls() {
            return { tag: null, file: (name) => `${base}/${encodeURIComponent(name)}` };
        }
    });
}

/**
 * @param {Object} params
 * @param {{ kind: string }} params.source the policy's source
 * @param {'stable'|'prerelease'} params.channel
 * @param {Function} [params.fetchImpl] default: the global fetch (Node 20+); tests inject one
 */
function createSource({ source, channel, fetchImpl = globalThis.fetch, fs = nodeFs }) {
    if (source.kind === 'directory') return createDirectorySource({ dir: source.dir, fs });
    if (typeof fetchImpl !== 'function') throw new ManagerError(409, 'SOURCE_UNREACHABLE', 'This Node.js has no fetch; use a directory source.');
    if (source.kind === 'github-release') return createGithubSource({ owner: source.owner, repo: source.repo, channel, fetchImpl, fs });
    if (source.kind === 'url') return createUrlSource({ base: source.base, fetchImpl, fs });
    throw new ManagerError(400, 'INVALID_INPUT', 'Unknown release source kind.');
}

module.exports = { createSource, landFile, bareFile, INDEX_FILE, SIGNATURE_FILE, MAX_ARTIFACT_BYTES };
