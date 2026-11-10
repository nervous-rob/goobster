'use strict';

/**
 * The third-party tools the bootstrap builds download (scripts/bootstrap-pins.json):
 * where a pinned file is fetched from, how a copy is checked, how a newer upstream
 * build is examined before it is proposed, and what the mirror release must hold.
 * Documentation: documentation/bootstrap_tools.md.
 *
 * The SHA-256 in the pins file is the authority on every path. A copy from the
 * mirror, from upstream, from a staging directory or from the tools cache is used
 * only when its hash equals the pin, so no source has to be trusted.
 *
 * Node built-ins only. Signature checks call the system `gpg`; nothing a build
 * runs needs it (builds check hashes), only `verify`, `refresh` and `publish` do.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { download } = require('./download');

const PINS_FILE = path.join(__dirname, '..', 'bootstrap-pins.json');
const PINS_VERSION = 2;
const RESERVED = new Set(['version', 'note', 'mirror', 'keys']);
const TRACKS = Object.freeze(['tag', 'versions']);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_TAG = /^v?(\d+(?:\.\d+)*)$/;
const API = 'https://api.github.com';

class BootstrapToolsError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BootstrapToolsError';
        this.code = code;
    }
}

function refuse(code, message) {
    return new BootstrapToolsError(code, message);
}

function readPins(file = PINS_FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function fileName(url) {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
}

// ------------------------------------------------------------------ the pins
function toolKeys(pins) {
    return Object.keys(pins).filter(key => !RESERVED.has(key) && pins[key] && typeof pins[key] === 'object');
}

/** The pinned files of one tool: the group itself when it carries the hash, else one per architecture. */
function variantsOf(group) {
    if (typeof group.sha256 === 'string') return [{ variant: null, pin: group }];
    return Object.keys(group)
        .filter(key => group[key] && typeof group[key] === 'object' && typeof group[key].sha256 === 'string')
        .map(key => ({ variant: key, pin: group[key] }));
}

/** Every pinned file, flat: `{ id, tool, variant, group, pin, file, url, sha256 }`. */
function listPins(pins) {
    const out = [];
    for (const tool of toolKeys(pins)) {
        for (const { variant, pin } of variantsOf(pins[tool])) {
            out.push({ id: variant ? `${tool}.${variant}` : tool, tool, variant, group: pins[tool], pin, file: fileName(pin.url), url: pin.url, sha256: pin.sha256 });
        }
    }
    return out;
}

/** The mirror asset of a pinned file. The name carries the hash, so an address never changes meaning. */
function mirrorAssetName(pin) {
    return `${fileName(pin.url)}.${pin.sha256}`;
}

function mirrorUrl(pins, pin) {
    const mirror = pins && pins.mirror;
    if (!mirror || !mirror.repository || !mirror.tag) return null;
    return `https://github.com/${mirror.repository}/releases/download/${encodeURIComponent(mirror.tag)}/${encodeURIComponent(mirrorAssetName(pin))}`;
}

/** Where a pinned file is fetched from, in order: Goobster's own copy, then upstream. */
function sourcesFor(pins, pin) {
    const sources = [];
    const mirror = mirrorUrl(pins, pin);
    if (mirror) sources.push({ name: 'mirror', url: mirror });
    sources.push({ name: 'upstream', url: pin.url });
    return sources;
}

/** @returns {string[]} what is wrong with the pins file (empty when nothing is) */
function pinProblems(pins, { keysDir = path.dirname(PINS_FILE), exists = fs.existsSync } = {}) {
    const problems = [];
    if (!pins || typeof pins !== 'object') return ['the pins file is not an object'];
    if (pins.version !== PINS_VERSION) problems.push(`version must be ${PINS_VERSION}`);
    const mirror = pins.mirror;
    if (!mirror || !REPOSITORY.test(String(mirror.repository || '')) || !SAFE_NAME.test(String(mirror.tag || ''))) {
        problems.push('mirror must name a repository (owner/name) and a release tag');
    }
    const keys = pins.keys && typeof pins.keys === 'object' ? pins.keys : {};
    for (const [name, key] of Object.entries(keys)) {
        if (!key || !FINGERPRINT.test(String(key.fingerprint || ''))) problems.push(`keys.${name}.fingerprint must be 40 upper-case hex characters`);
        if (!key || typeof key.file !== 'string' || key.file.includes('..') || path.isAbsolute(key.file)) problems.push(`keys.${name}.file must be a path under scripts/`);
        else if (!exists(path.join(keysDir, key.file))) problems.push(`keys.${name}.file does not exist`);
    }
    const tools = toolKeys(pins);
    if (tools.length === 0) problems.push('no tool is pinned');
    for (const tool of tools) {
        const group = pins[tool];
        const upstream = group.upstream;
        const variants = variantsOf(group);
        if (variants.length === 0) problems.push(`${tool} pins no file`);
        if (!upstream || typeof upstream !== 'object') {
            problems.push(`${tool}.upstream is missing`);
            continue;
        }
        if (!REPOSITORY.test(String(upstream.repository || ''))) problems.push(`${tool}.upstream.repository must be owner/name`);
        if (!TRACKS.includes(upstream.track)) problems.push(`${tool}.upstream.track must be one of ${TRACKS.join(', ')}`);
        if (typeof upstream.tag !== 'string' || !SAFE_NAME.test(upstream.tag)) problems.push(`${tool}.upstream.tag is missing`);
        if (!COMMIT.test(String(upstream.commit || ''))) problems.push(`${tool}.upstream.commit must be a full commit id`);
        if (upstream.track === 'versions' && !VERSION_TAG.test(String(upstream.tag || ''))) problems.push(`${tool}.upstream.tag is not a version, so its releases cannot be followed by version`);
        if (upstream.signingKey !== undefined && !keys[upstream.signingKey]) problems.push(`${tool}.upstream.signingKey names no key in keys`);
        for (const { variant, pin } of variants) {
            const id = variant ? `${tool}.${variant}` : tool;
            if (!SHA256.test(String(pin.sha256 || ''))) problems.push(`${id}.sha256 must be 64 lower-case hex characters`);
            const expected = `https://github.com/${upstream.repository}/releases/download/${upstream.tag}/`;
            if (typeof pin.url !== 'string' || !pin.url.startsWith(expected) || !SAFE_NAME.test(pin.url.slice(expected.length))) {
                problems.push(`${id}.url must be a file of the upstream release ${upstream.repository}@${upstream.tag}`);
            }
            if (upstream.signingKey !== undefined && !/^[A-Za-z0-9+/]+=*$/.test(String(pin.signature || ''))) problems.push(`${id}.signature must hold upstream's detached signature (base64)`);
        }
    }
    return problems;
}

function assertValidPins(pins, options) {
    const problems = pinProblems(pins, options);
    if (problems.length > 0) throw refuse('PINS_INVALID', `scripts/bootstrap-pins.json: ${problems.join('; ')}`);
    return pins;
}

// ------------------------------------------------------------- fetch a pin
function shortMessage(error) {
    return error && error.message ? String(error.message).slice(0, 160) : 'download failed';
}

/**
 * Fetch one pinned file into `destination`: the cached copy when it still matches, else each
 * source in order. A download is kept only when its SHA-256 equals the pin.
 *
 * @returns {Promise<{ ok: boolean, cached?: boolean, source?: string, reason?: 'UNAVAILABLE'|'HASH_MISMATCH', detail?: string, attempts: Object[] }>}
 */
async function fetchPinned({ pins, pin, destination, doDownload = download }) {
    if (fs.existsSync(destination) && sha256File(destination) === pin.sha256) return { ok: true, cached: true, source: 'cache', attempts: [] };
    const attempts = [];
    for (const source of sourcesFor(pins, pin)) {
        try {
            await doDownload(source.url, destination);
        } catch (error) {
            fs.rmSync(destination, { force: true });
            attempts.push({ source: source.name, outcome: 'UNAVAILABLE', detail: shortMessage(error) });
            continue;
        }
        if (sha256File(destination) !== pin.sha256) {
            fs.rmSync(destination, { force: true });
            attempts.push({ source: source.name, outcome: 'HASH_MISMATCH', detail: `the download of ${fileName(pin.url)} from ${source.name} does not match its pinned SHA-256` });
            continue;
        }
        attempts.push({ source: source.name, outcome: 'OK' });
        return { ok: true, cached: false, source: source.name, attempts };
    }
    const mismatch = attempts.find(attempt => attempt.outcome === 'HASH_MISMATCH');
    const last = attempts[attempts.length - 1];
    return { ok: false, reason: mismatch ? 'HASH_MISMATCH' : 'UNAVAILABLE', detail: (mismatch || last).detail, attempts };
}

/** A file under `dir` (a few levels deep) whose SHA-256 is `sha256`, or null. */
function findStaged(dir, sha256, depth = 3) {
    if (!dir || !fs.existsSync(dir)) return null;
    const pending = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && sha256File(full) === sha256) return full;
    }
    if (depth > 0) {
        for (const sub of pending) {
            const found = findStaged(sub, sha256, depth - 1);
            if (found) return found;
        }
    }
    return null;
}

// --------------------------------------------------------------- signatures
/**
 * Check a detached OpenPGP signature over `file` against one pinned key.
 * The key file must hold exactly the key with `fingerprint`, and the signature must be
 * good and made by that key. Runs `gpg` in a throwaway home; no agent, no keyserver.
 *
 * @returns {{ ok: boolean, code?: string, detail?: string, signedAt?: string }}
 */
function verifySignature({ file, signature, keyFile, fingerprint, run = childProcess.spawnSync }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gbt-gpg-'));
    try {
        fs.chmodSync(home, 0o700);
        const base = ['--homedir', home, '--batch', '--no-tty', '--quiet', '--no-autostart'];
        const gpg = (args) => run('gpg', [...base, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const imported = gpg(['--import', keyFile]);
        if (imported.error) return { ok: false, code: 'GPG_UNAVAILABLE', detail: 'gpg could not be run on this machine' };
        if (imported.status !== 0) return { ok: false, code: 'KEY_UNREADABLE', detail: 'the pinned public key could not be imported' };
        const listed = gpg(['--with-colons', '--fingerprint']);
        const lines = String(listed.stdout || '').split('\n');
        const primaries = lines.map((line, index) => (line.startsWith('pub:') ? (lines.slice(index + 1).find(next => next.startsWith('fpr:')) || '').split(':')[9] : null)).filter(Boolean);
        if (listed.status !== 0 || primaries.length !== 1 || primaries[0] !== fingerprint) {
            return { ok: false, code: 'KEY_MISMATCH', detail: 'the pinned key file does not hold exactly the key with the pinned fingerprint' };
        }
        const sigFile = path.join(home, 'detached.sig');
        fs.writeFileSync(sigFile, signature);
        const verified = gpg(['--status-fd', '1', '--verify', sigFile, file]);
        const status = String(verified.stdout || '').split('\n').filter(line => line.startsWith('[GNUPG:] ')).map(line => line.slice(9).split(' '));
        const valid = status.find(fields => fields[0] === 'VALIDSIG');
        const good = status.some(fields => fields[0] === 'GOODSIG');
        if (verified.status !== 0 || !good || !valid || valid[valid.length - 1] !== fingerprint) {
            return { ok: false, code: 'SIGNATURE_INVALID', detail: 'the signature is not a good signature by the pinned key' };
        }
        const seconds = Number(valid[3]);
        return { ok: true, signedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null };
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/** Does the binary name the commit it was built from (`github.com/<repository>/commit/<abbreviated id>`)? */
function embedsCommit(file, repository, commit) {
    const data = fs.readFileSync(file);
    const marker = Buffer.from(`github.com/${repository}/commit/`, 'latin1');
    for (let at = data.indexOf(marker); at !== -1; at = data.indexOf(marker, at + 1)) {
        const tail = data.subarray(at + marker.length, at + marker.length + 40).toString('latin1');
        const id = (/^[0-9a-f]+/.exec(tail) || [''])[0];
        if (id.length >= 7 && commit.startsWith(id)) return true;
    }
    return false;
}

/** The checks a copy must pass beyond its hash, wherever it came from. Returns the problems found. */
function copyProblems({ pins, entry, file, keysDir = path.dirname(PINS_FILE), verifySig = verifySignature }) {
    const problems = [];
    const upstream = entry.group.upstream || {};
    if (upstream.signingKey !== undefined) {
        const key = (pins.keys || {})[upstream.signingKey];
        const result = verifySig({ file, signature: Buffer.from(String(entry.pin.signature || ''), 'base64'), keyFile: path.join(keysDir, key.file), fingerprint: key.fingerprint });
        if (!result.ok) problems.push({ code: result.code, detail: `${entry.id}: ${result.detail}` });
    }
    if (upstream.embedsCommit && !embedsCommit(file, upstream.repository, upstream.commit)) {
        problems.push({ code: 'COMMIT_NOT_EMBEDDED', detail: `${entry.id}: the file does not name upstream commit ${upstream.commit.slice(0, 12)}` });
    }
    return problems;
}

// ------------------------------------------------------------------- GitHub
/** A small GitHub REST client: JSON reads and writes, and a release asset upload. */
function createGithub({ fetchImpl = globalThis.fetch, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '' } = {}) {
    async function request(method, url, { json, body, contentType } = {}) {
        const headers = { 'User-Agent': 'goobster-bootstrap-tools', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        if (contentType) headers['Content-Type'] = contentType;
        const response = await fetchImpl(url.startsWith('https://') ? url : `${API}${url}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
        if (!response.ok) {
            const error = new Error(`${method} ${url} -> HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.status === 204 ? null : response.json();
    }
    return {
        getJson: (url) => request('GET', url),
        postJson: (url, json) => request('POST', url, { json }),
        patchJson: (url, json) => request('PATCH', url, { json }),
        uploadAsset: ({ uploadUrl, name, file }) => request('POST', `${uploadUrl.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`, { body: fs.readFileSync(file), contentType: 'application/octet-stream' })
    };
}

async function getOrNull(github, url) {
    try {
        return await github.getJson(url);
    } catch (error) {
        if (error && error.status === 404) return null;
        throw error;
    }
}

function versionOf(tag) {
    const match = VERSION_TAG.exec(String(tag || ''));
    return match ? match[1].split('.').map(Number) : null;
}

function compareVersions(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** The upstream release a tool follows: its pinned tag (`tag`), or the highest published version (`versions`). */
async function followedRelease(github, upstream) {
    const repo = upstream.repository;
    let tag = upstream.tag;
    if (upstream.track === 'versions') {
        const releases = await github.getJson(`/repos/${repo}/releases?per_page=100`);
        let best = versionOf(tag);
        for (const release of Array.isArray(releases) ? releases : []) {
            const version = !release.draft && !release.prerelease ? versionOf(release.tag_name) : null;
            if (version && best && compareVersions(version, best) > 0) {
                best = version;
                tag = release.tag_name;
            }
        }
    }
    const release = await getOrNull(github, `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (!release || release.draft) throw refuse('UPSTREAM_RELEASE_MISSING', `${repo} has no published release ${tag}`);
    return release;
}

async function tagCommit(github, repo, tag) {
    const ref = await github.getJson(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref && ref.object;
    for (let hops = 0; object && object.type === 'tag' && hops < 3; hops++) {
        object = (await github.getJson(`/repos/${repo}/git/tags/${object.sha}`)).object;
    }
    if (!object || object.type !== 'commit' || !COMMIT.test(String(object.sha))) throw refuse('UPSTREAM_TAG_UNRESOLVED', `${repo}: tag ${tag} does not resolve to a commit`);
    return object.sha;
}

// ------------------------------------------------------------------ refresh
/**
 * Look for a newer upstream build of every pinned tool and verify it. Nothing is written:
 * the result holds the proposed pins, what changed, the evidence and the verified files.
 *
 * A new build is accepted only when every check its pin declares passes: the download equals
 * the digest GitHub records, the uploader is the pinned one, the detached signature is good
 * under the pinned key, the binary names the release's commit, and upstream's own build
 * workflow succeeded for that commit before the file was uploaded.
 *
 * @returns {Promise<{ changed: boolean, pins: Object, changes: Object[], files: { id: string, name: string, file: string }[] }>}
 */
async function refresh({ pins, github, workDir, doDownload = download, verifySig = verifySignature, keysDir = path.dirname(PINS_FILE), log = () => {} }) {
    assertValidPins(pins, { keysDir });
    const next = JSON.parse(JSON.stringify(pins));
    const changes = [];
    const files = [];
    fs.mkdirSync(workDir, { recursive: true });
    for (const tool of toolKeys(next)) {
        const group = next[tool];
        const upstream = group.upstream;
        const repo = upstream.repository;
        const before = JSON.parse(JSON.stringify(pins[tool]));
        const release = await followedRelease(github, upstream);
        const tag = release.tag_name;
        const commit = await tagCommit(github, repo, tag);
        const evidence = [];
        const updated = [];
        for (const { variant, pin } of variantsOf(group)) {
            const id = variant ? `${tool}.${variant}` : tool;
            const name = fileName(pin.url);
            const asset = (release.assets || []).find(item => item && item.name === name);
            if (!asset) throw refuse('UPSTREAM_ASSET_MISSING', `${id}: release ${tag} of ${repo} has no file ${name}`);
            const digest = /^sha256:[0-9a-f]{64}$/.test(String(asset.digest || '')) ? asset.digest.slice(7) : null;
            if (tag === upstream.tag && digest === pin.sha256) continue;
            const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
            const file = path.join(workDir, `${id}-${name}`);
            await doDownload(url, file);
            const sha256 = sha256File(file);
            if (digest && sha256 !== digest) throw refuse('UPSTREAM_DIGEST_MISMATCH', `${id}: the download of ${name} does not match the digest GitHub records for it`);
            if (tag === upstream.tag && sha256 === pin.sha256) {
                fs.rmSync(file, { force: true });
                continue;
            }
            log(`${id}: upstream ${repo}@${tag} now serves ${sha256}`);
            evidence.push(digest ? `\`${name}\`: the download equals the digest GitHub records for the release file.` : `\`${name}\`: GitHub records no digest for this release file; the hash was computed from the download.`);
            if (upstream.uploader !== undefined) {
                const uploader = asset.uploader && asset.uploader.login;
                if (uploader !== upstream.uploader) throw refuse('UPSTREAM_UPLOADER_CHANGED', `${id}: ${name} was uploaded by ${uploader || 'an unknown account'}, not ${upstream.uploader}`);
                evidence.push(`\`${name}\`: uploaded by \`${uploader}\` at ${asset.created_at}.`);
            }
            const proposed = { ...pin, url, sha256 };
            if (upstream.signingKey !== undefined) {
                const key = next.keys[upstream.signingKey];
                const sigAsset = (release.assets || []).find(item => item && item.name === `${name}.sig`);
                if (!sigAsset) throw refuse('UPSTREAM_SIGNATURE_MISSING', `${id}: release ${tag} of ${repo} has no ${name}.sig`);
                const sigFile = `${file}.sig`;
                await doDownload(`https://github.com/${repo}/releases/download/${tag}/${name}.sig`, sigFile);
                const signature = fs.readFileSync(sigFile);
                fs.rmSync(sigFile, { force: true });
                const result = verifySig({ file, signature, keyFile: path.join(keysDir, key.file), fingerprint: key.fingerprint });
                if (!result.ok) throw refuse(result.code, `${id}: ${result.detail}`);
                proposed.signature = signature.toString('base64');
                evidence.push(`\`${name}\`: good signature by the pinned key \`${key.fingerprint}\`${result.signedAt ? `, made ${result.signedAt}` : ''}.`);
            }
            if (upstream.embedsCommit) {
                if (!embedsCommit(file, repo, commit)) throw refuse('COMMIT_NOT_EMBEDDED', `${id}: ${name} does not name commit ${commit.slice(0, 12)}, the commit of ${tag}`);
                evidence.push(`\`${name}\`: the binary names commit \`${commit.slice(0, 12)}\`, the commit of \`${tag}\`.`);
            }
            updated.push({ id, variant, asset, proposed, file });
        }
        if (updated.length === 0) continue;
        if (upstream.workflow !== undefined) {
            const listing = await github.getJson(`/repos/${repo}/actions/runs?head_sha=${commit}&per_page=100`);
            const run = ((listing && listing.workflow_runs) || []).find(item => item.path === upstream.workflow && item.head_sha === commit && item.event === 'push' && item.conclusion === 'success');
            if (!run) throw refuse('UPSTREAM_BUILD_NOT_FOUND', `${tool}: ${repo} has no successful ${upstream.workflow} run for commit ${commit.slice(0, 12)}`);
            const started = Date.parse(run.run_started_at || run.created_at);
            for (const item of updated) {
                if (!(Date.parse(item.asset.created_at) >= started)) throw refuse('UPSTREAM_ASSET_PREDATES_BUILD', `${item.id}: the release file is older than the build run that should have produced it`);
            }
            upstream.run = run.id;
            evidence.push(`Upstream's \`${upstream.workflow}\` run [${run.id}](https://github.com/${repo}/actions/runs/${run.id}) succeeded for commit \`${commit.slice(0, 12)}\` and started before the files were uploaded.`);
        } else {
            delete upstream.run;
        }
        for (const item of updated) {
            if (item.variant) group[item.variant] = item.proposed;
            else Object.assign(group, item.proposed);
            files.push({ id: item.id, name: mirrorAssetName(item.proposed), file: item.file });
        }
        const sameTag = tag === upstream.tag;
        upstream.tag = tag;
        upstream.commit = commit;
        if (!sameTag) {
            group.source = `https://github.com/${repo}/releases/tag/${tag}`;
            if (group.version !== undefined && versionOf(tag)) group.version = versionOf(tag).join('.');
        }
        changes.push({
            tool,
            repository: repo,
            sameTag,
            from: { tag: before.upstream.tag, commit: before.upstream.commit, files: variantsOf(before).map(({ variant, pin }) => ({ variant, name: fileName(pin.url), sha256: pin.sha256 })) },
            to: { tag, commit, files: variantsOf(group).map(({ variant, pin }) => ({ variant, name: fileName(pin.url), sha256: pin.sha256 })) },
            note: group.note || null,
            evidence
        });
    }
    assertValidPins(next, { keysDir });
    return { changed: changes.length > 0, pins: next, changes, files };
}

/** The pull request text for a refresh result: what changed, what was verified, what the reviewer does. */
function renderRefreshReport(result) {
    const lines = ['A newer upstream build of a pinned bootstrap tool was found and verified. Nothing is published and nothing changes for builds until a person merges this pull request.', ''];
    for (const change of result.changes) {
        const compare = `https://github.com/${change.repository}/compare/${change.from.commit}...${change.to.commit}`;
        lines.push(`## \`${change.tool}\` (${change.repository})`, '');
        lines.push(change.sameTag
            ? `Upstream replaced the files under the tag \`${change.to.tag}\`.`
            : `Upstream published \`${change.to.tag}\`; the pin was at \`${change.from.tag}\`.`);
        lines.push(`Commit \`${change.from.commit.slice(0, 12)}\` to \`${change.to.commit.slice(0, 12)}\`: [what changed upstream](${compare}).`, '');
        lines.push('| File | SHA-256 before | SHA-256 after |', '| --- | --- | --- |');
        for (const file of change.to.files) {
            const old = change.from.files.find(item => item.variant === file.variant);
            lines.push(`| \`${file.name}\`${file.variant ? ` (${file.variant})` : ''} | \`${old ? old.sha256 : 'none'}\` | \`${file.sha256}\` |`);
        }
        lines.push('', 'Verified by the refresh run:', '');
        for (const item of change.evidence) lines.push(`- ${item}`);
        if (change.note) lines.push('', `Note on this pin: ${change.note}`);
        lines.push('');
    }
    lines.push('## Before merging', '');
    lines.push('- Read what changed upstream (the compare links above) and decide whether Goobster should take it.');
    lines.push('- Wait for the bootstrap workflows on this branch; they build with the proposed files.');
    lines.push('- Merging publishes the new files to the mirror release. To decline, close this pull request; the pins and the mirror stay as they are.');
    lines.push('', 'Procedure and rollback: `documentation/bootstrap_tools.md`.', '');
    return lines.join('\n');
}

// ------------------------------------------------------------------- verify
/**
 * Check every pinned file against each place it can come from. Fails (a row has problems) when
 * no source or staged copy has the pinned bytes, when the mirror serves different bytes, when a
 * copy fails its signature or commit check, or (requireMirror) when the mirror lacks the file.
 * Upstream serving something else is reported, not failed: that is what the mirror is for.
 *
 * @returns {Promise<{ ok: boolean, rows: Object[] }>}
 */
async function verifyPins({ pins, workDir, stagedDir = null, stageTo = null, requireMirror = false, doDownload = download, verifySig = verifySignature, keysDir = path.dirname(PINS_FILE) }) {
    assertValidPins(pins, { keysDir });
    fs.mkdirSync(workDir, { recursive: true });
    if (stageTo) fs.mkdirSync(stageTo, { recursive: true });
    const rows = [];
    for (const entry of listPins(pins)) {
        const row = { id: entry.id, file: entry.file, sha256: entry.sha256, mirror: 'absent', upstream: 'unavailable', staged: false, signed: false, problems: [] };
        let copy = null;
        for (const source of sourcesFor(pins, entry.pin)) {
            const file = path.join(workDir, `${entry.id}.${source.name}`);
            let state;
            try {
                await doDownload(source.url, file);
                state = sha256File(file) === entry.sha256 ? 'ok' : 'different';
            } catch (error) {
                state = error && error.statusCode === 404 ? 'absent' : 'unavailable';
            }
            row[source.name] = state;
            if (state === 'ok' && !copy) copy = file;
            else if (state !== 'ok') fs.rmSync(file, { force: true });
            if (source.name === 'mirror' && state === 'different') row.problems.push({ code: 'MIRROR_HASH_MISMATCH', detail: `${entry.id}: the mirror serves a file that does not match the pin` });
        }
        if (!copy && stagedDir) {
            copy = findStaged(stagedDir, entry.sha256);
            row.staged = Boolean(copy);
        }
        if (!copy) row.problems.push({ code: 'PIN_UNOBTAINABLE', detail: `${entry.id}: neither the mirror nor upstream serves the pinned file` });
        if (requireMirror && row.mirror !== 'ok') row.problems.push({ code: 'MIRROR_MISSING', detail: `${entry.id}: the mirror does not hold the pinned file (${row.mirror})` });
        if (copy) {
            row.problems.push(...copyProblems({ pins, entry, file: copy, keysDir, verifySig }));
            row.signed = (entry.group.upstream || {}).signingKey !== undefined;
            if (stageTo && row.problems.length === 0) fs.copyFileSync(copy, path.join(stageTo, mirrorAssetName(entry.pin)));
        }
        rows.push(row);
    }
    return { ok: rows.every(row => row.problems.length === 0), rows };
}

// ------------------------------------------------------------------ publish
const MIRROR_TITLE = 'Bootstrap build tools (mirror)';

function mirrorNotes(pins) {
    const lines = [
        'Goobster\'s own copies of the third-party tools its installer builds download, kept so that an upstream rebuild or a moved URL cannot break a build.',
        'This is not a Goobster release and holds nothing to install.',
        '',
        'Each file is named `<upstream file name>.<SHA-256>` and is published only after its pin was merged into `scripts/bootstrap-pins.json`.',
        'Files of earlier pins stay here so that reverting a pin keeps working. Procedure: `documentation/bootstrap_tools.md`.',
        '',
        '| Pin | File | Upstream | Commit |',
        '| --- | --- | --- | --- |'
    ];
    for (const entry of listPins(pins)) {
        lines.push(`| \`${entry.id}\` | \`${mirrorAssetName(entry.pin)}\` | ${entry.url} | \`${entry.group.upstream.commit}\` |`);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Bring the mirror release up to the pins: create the release when it does not exist, upload
 * every pinned file it lacks, and prove each one back from its public address. Never replaces
 * or deletes a file. A file is uploaded only after its hash, signature and commit checks pass,
 * taken from upstream or, when upstream has moved on, from the staged copies of a verify run.
 *
 * @returns {Promise<{ created: boolean, uploaded: string[], present: string[], dryRun: boolean }>}
 */
async function publish({ pins, github, workDir, stagedDir = null, target = null, dryRun = false, doDownload = download, verifySig = verifySignature, keysDir = path.dirname(PINS_FILE), log = () => {} }) {
    assertValidPins(pins, { keysDir });
    const { repository, tag } = pins.mirror;
    fs.mkdirSync(workDir, { recursive: true });
    let release = await getOrNull(github, `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
    const created = !release;
    const existing = new Map(((release && release.assets) || []).map(asset => [asset.name, asset]));
    const uploads = [];
    const present = [];
    for (const entry of listPins(pins)) {
        const name = mirrorAssetName(entry.pin);
        const asset = existing.get(name);
        if (asset) {
            let sha256 = /^sha256:[0-9a-f]{64}$/.test(String(asset.digest || '')) ? asset.digest.slice(7) : null;
            if (!sha256) {
                const file = path.join(workDir, `${entry.id}.mirror`);
                await doDownload(mirrorUrl(pins, entry.pin), file);
                sha256 = sha256File(file);
                fs.rmSync(file, { force: true });
            }
            if (sha256 !== entry.sha256) throw refuse('MIRROR_HASH_MISMATCH', `${entry.id}: the mirror already holds ${name} with different contents; it is never replaced`);
            present.push(name);
            continue;
        }
        const file = path.join(workDir, name);
        let from = 'upstream';
        try {
            await doDownload(entry.url, file);
        } catch (error) {
            fs.rmSync(file, { force: true });
        }
        if (!fs.existsSync(file) || sha256File(file) !== entry.sha256) {
            fs.rmSync(file, { force: true });
            const staged = findStaged(stagedDir, entry.sha256);
            if (!staged) throw refuse('PIN_UNOBTAINABLE', `${entry.id}: upstream no longer serves the pinned file and no staged copy of it was found; run the refresh to propose the build upstream serves now`);
            fs.copyFileSync(staged, file);
            from = 'staged copy';
        }
        const problems = copyProblems({ pins, entry, file, keysDir, verifySig });
        if (problems.length > 0) throw refuse(problems[0].code, problems[0].detail);
        uploads.push({ entry, name, file, from });
    }
    if (dryRun) {
        if (created) log(`would create the release ${tag} in ${repository} (prerelease, never "latest")`);
        for (const item of uploads) log(`would upload ${item.name} (${item.entry.id}, from ${item.from})`);
        return { created, uploaded: uploads.map(item => item.name), present, dryRun: true };
    }
    if (uploads.length === 0 && !created) return { created: false, uploaded: [], present, dryRun: false };
    if (!release) {
        const body = { tag_name: tag, name: MIRROR_TITLE, body: mirrorNotes(pins), prerelease: true, make_latest: 'false' };
        if (target) body.target_commitish = target;
        release = await github.postJson(`/repos/${repository}/releases`, body);
        log(`created the release ${tag} in ${repository}`);
    }
    for (const item of uploads) {
        await github.uploadAsset({ uploadUrl: release.upload_url, name: item.name, file: item.file });
        log(`uploaded ${item.name} (${item.entry.id}, from ${item.from})`);
    }
    for (const item of uploads) {
        const back = path.join(workDir, `${item.entry.id}.back`);
        await doDownload(mirrorUrl(pins, item.entry.pin), back);
        const same = sha256File(back) === item.entry.sha256;
        fs.rmSync(back, { force: true });
        if (!same) throw refuse('MIRROR_HASH_MISMATCH', `${item.entry.id}: the uploaded ${item.name} does not read back with the pinned hash`);
    }
    await github.patchJson(`/repos/${repository}/releases/${release.id}`, { body: mirrorNotes(pins), prerelease: true, make_latest: 'false' });
    const latest = await getOrNull(github, `/repos/${repository}/releases/latest`);
    if (latest && latest.tag_name === tag) throw refuse('MIRROR_IS_LATEST', `the mirror release ${tag} became the repository's latest release; mark another release as latest`);
    return { created, uploaded: uploads.map(item => item.name), present, dryRun: false };
}

module.exports = {
    PINS_FILE,
    PINS_VERSION,
    BootstrapToolsError,
    readPins,
    sha256File,
    fileName,
    toolKeys,
    variantsOf,
    listPins,
    mirrorAssetName,
    mirrorUrl,
    sourcesFor,
    pinProblems,
    assertValidPins,
    fetchPinned,
    findStaged,
    verifySignature,
    embedsCommit,
    copyProblems,
    createGithub,
    followedRelease,
    tagCommit,
    refresh,
    renderRefreshReport,
    verifyPins,
    publish,
    mirrorNotes
};
