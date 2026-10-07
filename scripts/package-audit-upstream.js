#!/usr/bin/env node
'use strict';

/**
 * N1 helper (documentation/packaging_proof.md): for every promised target,
 * does each native dependency have a prebuilt binary upstream, and what do
 * the binary headers say it needs?
 *
 * Downloads the exact assets the install scripts fetch (versions read from
 * package-lock.json; npm tarballs are checked against the lockfile's
 * integrity), inspects ELF / Mach-O / PE headers with
 * scripts/lib/nativeBinaryInfo.js, and prints one JSON document.
 *
 * THIS IS STATIC ANALYSIS. Binaries for a platform other than the host are
 * read, never executed: "an asset exists and its headers say X" is not
 * evidence that it runs. Execution evidence comes only from package-smoke.js
 * on a host of that target.
 *
 * Usage: node scripts/package-audit-upstream.js [--out file.json] [--cache dir]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { download } = require('./lib/download');
const { inspectBinary, looksLikeBinary, compareVersions } = require('./lib/nativeBinaryInfo');
const rules = require('./lib/packageRules');

const lock = require('../package-lock.json');

const NODE_ABI = rules.pins.moduleVersion;

/** Per target: names each upstream uses for the same platform. */
const NAMES = {
    'linux-x64': { sqliteVec: 'sqlite-vec-linux-x64', canvas: '@napi-rs/canvas-linux-x64-gnu', davey: '@snazzah/davey-linux-x64-gnu', libvips: 'linux-x64' },
    'linux-arm64': { sqliteVec: 'sqlite-vec-linux-arm64', canvas: '@napi-rs/canvas-linux-arm64-gnu', davey: '@snazzah/davey-linux-arm64-gnu', libvips: 'linux-arm64v8' },
    'darwin-x64': { sqliteVec: 'sqlite-vec-darwin-x64', canvas: '@napi-rs/canvas-darwin-x64', davey: '@snazzah/davey-darwin-x64', libvips: 'darwin-x64' },
    'darwin-arm64': { sqliteVec: 'sqlite-vec-darwin-arm64', canvas: '@napi-rs/canvas-darwin-arm64', davey: '@snazzah/davey-darwin-arm64', libvips: 'darwin-arm64v8' },
    'win32-x64': { sqliteVec: 'sqlite-vec-windows-x64', canvas: '@napi-rs/canvas-win32-x64-msvc', davey: '@snazzah/davey-win32-x64-msvc', libvips: 'win32-x64' }
};

function version(name) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry) throw new Error(`${name} is not in package-lock.json`);
    return entry;
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') options.out = path.resolve(argv[++i]);
        else if (argv[i] === '--cache') options.cache = path.resolve(argv[++i]);
        else throw new Error(`Unknown option: ${argv[i]}`);
    }
    return options;
}

async function fetchAsset(url, cacheDir, integrity) {
    const file = path.join(cacheDir, url.replace(/[^A-Za-z0-9._-]+/g, '_'));
    if (!fs.existsSync(file)) {
        try {
            await download(url, file);
        } catch (error) {
            return { available: false, status: error.statusCode || null, error: error.message };
        }
    }
    if (integrity) {
        const [algorithm, expected] = integrity.split('-');
        const actual = crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('base64');
        if (actual !== expected) throw new Error(`integrity mismatch for ${url}`);
    }
    return { available: true, file, bytes: fs.statSync(file).size, integrityChecked: Boolean(integrity) };
}

function extract(archive, into) {
    fs.rmSync(into, { recursive: true, force: true });
    fs.mkdirSync(into, { recursive: true });
    const attempts = archive.endsWith('.zip')
        ? [['tar', ['-xf', archive, '-C', into]], ['unzip', ['-q', archive, '-d', into]], ['python3', ['-m', 'zipfile', '-e', archive, into]]]
        : [['tar', ['-xzf', archive, '-C', into]]];
    for (const [command, args] of attempts) {
        const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });
        if (result.status === 0) return;
    }
    throw new Error(`could not extract ${archive}`);
}

function walkFiles(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) out.push(...walkFiles(full));
        else if (stat.isFile()) out.push(full);
    }
    return out;
}

function summarize(dir, filter = () => true) {
    const binaries = walkFiles(dir).filter(file => looksLikeBinary(file) && filter(file))
        .map(file => ({ file: path.relative(dir, file), info: inspectBinary(file) }))
        .filter(entry => entry.info.format !== 'unknown');
    const max = (key) => binaries.reduce((best, { info }) => (info[key] && (!best || compareVersions(info[key], best) > 0) ? info[key] : best), null);
    const imports = new Set();
    for (const { info } of binaries) if (info.format === 'pe') for (const name of info.needed) imports.add(name.toLowerCase());
    return {
        binaries: binaries.length,
        format: [...new Set(binaries.map(entry => entry.info.format))],
        arch: [...new Set(binaries.flatMap(entry => entry.info.arch))],
        glibcMin: max('glibcMin'),
        glibcxxMin: max('glibcxxMin'),
        minMacos: max('minMacos'),
        windowsImports: imports.size ? [...imports].sort() : undefined,
        files: binaries.map(entry => entry.file).sort()
    };
}

async function auditTarget(targetId, work) {
    const [platform, arch] = targetId.split('-');
    const names = NAMES[targetId];
    const dir = path.join(work, targetId);
    fs.mkdirSync(dir, { recursive: true });
    const result = {};

    const bs3 = version('better-sqlite3').version;
    const bs3Url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bs3}/better-sqlite3-v${bs3}-node-v${NODE_ABI}-${platform}-${arch}.tar.gz`;
    result['better-sqlite3'] = await probe(bs3Url, dir, 'better-sqlite3');

    const sharp = version('sharp').version;
    const sharpUrl = `https://github.com/lovell/sharp/releases/download/v${sharp}/sharp-v${sharp}-napi-v7-${platform}-${arch}.tar.gz`;
    result.sharp = await probe(sharpUrl, dir, 'sharp');
    // sharp pins its libvips build in its own package.json ("config.libvips"), which the lockfile does not carry.
    const libvipsVersion = require('sharp/package.json').config.libvips;
    const libvipsUrl = `https://github.com/lovell/sharp-libvips/releases/download/v${libvipsVersion}/libvips-${libvipsVersion}-${names.libvips}.tar.gz`;
    result['sharp-libvips'] = await probe(libvipsUrl, dir, 'sharp-libvips');

    for (const [label, name] of [['sqlite-vec', names.sqliteVec], ['@napi-rs/canvas', names.canvas], ['@snazzah/davey', names.davey]]) {
        const entry = lock.packages[`node_modules/${name}`];
        if (!entry) { result[label] = { available: false, error: `${name} is not in package-lock.json` }; continue; }
        result[label] = await probe(entry.resolved, dir, label, entry.integrity, name);
    }

    // The pinned runtime itself: its minimum OS is the floor for everything else.
    const nodeAsset = rules.nodeDownload(rules.resolveTarget(targetId));
    const nodeDir = path.join(dir, 'x-node');
    const nodeFile = path.join(dir, nodeAsset.file);
    if (!fs.existsSync(nodeFile)) await download(nodeAsset.url, nodeFile);
    const nodeSha = crypto.createHash('sha256').update(fs.readFileSync(nodeFile)).digest('hex');
    if (nodeSha !== nodeAsset.sha256) throw new Error(`pinned checksum mismatch for ${nodeAsset.file}`);
    extract(nodeFile, nodeDir);
    const nodeBinary = path.join(nodeDir, nodeAsset.topDir, ...rules.TARGETS[targetId].nodeBin.split('/'));
    const nodeInfo = inspectBinary(nodeBinary);
    result[`node ${rules.pins.nodeVersion}`] = {
        asset: nodeAsset.url.replace(/^https:\/\//, ''),
        available: true,
        checksumVerifiedAgainstPin: true,
        format: [nodeInfo.format],
        arch: nodeInfo.arch,
        glibcMin: nodeInfo.glibcMin || null,
        glibcxxMin: nodeInfo.glibcxxMin || null,
        minMacos: nodeInfo.minMacos || null,
        windowsImports: nodeInfo.format === 'pe' ? nodeInfo.needed.map(name => name.toLowerCase()).sort() : undefined
    };

    const sodium = version('sodium-native');
    const sodiumResult = await probe(sodium.resolved, dir, 'sodium-native', sodium.integrity, null, file => file.includes(`${path.sep}prebuilds${path.sep}${platform}-${arch}${path.sep}`));
    result['sodium-native'] = sodiumResult;
    return { target: targetId, modules: result };
}

async function probe(url, dir, label, integrity, packageName, filter) {
    const asset = await fetchAsset(url, dir, integrity);
    const entry = { asset: url.replace(/^https:\/\//, ''), available: asset.available };
    if (!asset.available) return { ...entry, status: asset.status, error: asset.error };
    const into = path.join(dir, `x-${label.replace(/[^A-Za-z0-9]+/g, '_')}`);
    extract(asset.file, into);
    return { ...entry, bytes: asset.bytes, integrityChecked: asset.integrityChecked, ...summarize(into, filter), packageName: packageName || undefined };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const cache = options.cache || path.join(os.tmpdir(), 'goobster-audit-upstream');
    fs.mkdirSync(cache, { recursive: true });
    const targets = [];
    for (const targetId of Object.keys(NAMES)) targets.push(await auditTarget(targetId, cache));
    const report = {
        schema: 1,
        kind: 'static-header-analysis (binaries of other platforms are read, never executed)',
        nodeAbi: NODE_ABI,
        versions: {
            'better-sqlite3': version('better-sqlite3').version,
            sharp: version('sharp').version,
            'sodium-native': version('sodium-native').version,
            'sqlite-vec': version('sqlite-vec').version,
            '@napi-rs/canvas': version('@napi-rs/canvas').version,
            '@snazzah/davey': version('@snazzah/davey').version
        },
        targets
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) fs.writeFileSync(options.out, text);
    process.stdout.write(text);
}

main().catch((error) => {
    process.stderr.write(`[package-audit-upstream] ${error.stack || error}\n`);
    process.exit(1);
});
