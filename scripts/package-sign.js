#!/usr/bin/env node
'use strict';

/**
 * Sign a payload's release manifest, or make a development signing key
 * (documentation/packaging.md, issue #328).
 *
 * Usage:
 *   node scripts/package-sign.js --key <private.pem> <payload-dir> [--out <file>]
 *   node scripts/package-sign.js --gen-dev-key <dir>
 *
 *   --key          Ed25519 private key (PKCS#8 PEM). The manifest gains
 *                  `signing: { algorithm: 'ed25519', keyId }` and is rewritten
 *                  in canonical form; the base64 signature over those bytes is
 *                  written to <payload-dir>/payload-manifest.sig (or --out).
 *   --gen-dev-key  write payload-dev-key.pem (0600) and payload-dev-key.pub.pem
 *                  into <dir>, which must be outside the repository. Development
 *                  only: production keys and their pinning come from #341.
 *
 * Nothing here prints or records a private key.
 */

const fs = require('node:fs');
const path = require('node:path');

const stage = require('./lib/payloadStage');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const options = { positional: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            i += 1;
            if (i >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[i];
        };
        if (arg === '--key') options.key = path.resolve(value());
        else if (arg === '--out') options.out = path.resolve(value());
        else if (arg === '--gen-dev-key') options.genDevKey = path.resolve(value());
        else if (arg === '-h' || arg === '--help') options.help = true;
        else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
        else options.positional.push(path.resolve(arg));
    }
    return options;
}

function insideRepo(target) {
    const relative = path.relative(REPO_ROOT, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function help() {
    const source = fs.readFileSync(__filename, 'utf8');
    const match = source.match(/\/\*\*([\s\S]*?)\*\//);
    process.stdout.write(`${match[1].replace(/^ ?\* ?/gm, '').trim()}\n`);
}

/** Sign `payloadDir`'s manifest with the key at `keyPath`; returns `{ keyId, signature: <file> }`. */
function signPayload(payloadDir, keyPath, out = null) {
    const manifestPath = path.join(payloadDir, stage.MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) throw new Error(`${stage.MANIFEST_FILE} not found in ${payloadDir}`);
    const manifest = stage.validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (process.platform !== 'win32' && (fs.statSync(keyPath).mode & 0o077)) {
        process.stderr.write('[package-sign] warning: the private key file is readable by other accounts; chmod 600 it\n');
    }
    const unsigned = { ...manifest };
    delete unsigned.signing;
    const signed = stage.signManifest(unsigned, fs.readFileSync(keyPath, 'utf8'));
    fs.writeFileSync(manifestPath, stage.canonicalJson(signed.manifest));
    const signaturePath = out || path.join(payloadDir, stage.SIGNATURE_FILE);
    fs.writeFileSync(signaturePath, `${signed.signature}\n`);
    return { keyId: signed.manifest.signing.keyId, signature: signaturePath };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return help();
    if (options.genDevKey) {
        if (insideRepo(options.genDevKey)) throw new Error('refusing to write a signing key inside the repository; pick a directory outside it');
        const made = stage.generateDevKeyPair(options.genDevKey);
        process.stdout.write(`[package-sign] development key ${made.keyId}: public key ${made.publicKeyPath} (the private key is beside it, mode 0600)\n`);
        return undefined;
    }
    if (!options.key || options.positional.length !== 1) throw new Error('usage: package-sign.js --key <private.pem> <payload-dir> [--out <file>] | --gen-dev-key <dir>');
    const result = signPayload(options.positional[0], options.key, options.out);
    process.stdout.write(`[package-sign] signed with key ${result.keyId}; signature ${result.signature}\n`);
    return undefined;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`[package-sign] ERROR: ${error.message}\n`);
        process.exit(1);
    }
}

module.exports = { parseArgs, signPayload };
