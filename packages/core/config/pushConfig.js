require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtimePaths');
const requireOptional = require('../utils/optionalModule').forModule(module);

// config.json is optional (env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const webapp = fileConfig.webapp || {};
const push = webapp.push || {};

/** Where a self-generated VAPID key pair is kept (documentation/pwa.md). */
const KEY_FILE = path.join(dataDir, 'web-push-keys.json');

function flag(envName, fileValue, def) {
    const raw = process.env[envName];
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    if (fileValue === undefined || fileValue === null) return def;
    return Boolean(fileValue);
}

function str(envName, fileValue) {
    const raw = process.env[envName];
    if (raw !== undefined && String(raw).trim() !== '') return String(raw).trim();
    return typeof fileValue === 'string' && fileValue.trim() ? fileValue.trim() : null;
}

/** A VAPID subject must be a `mailto:` or an https URL the push service can contact. */
function defaultSubject() {
    const publicUrl = typeof webapp.publicUrl === 'string' ? webapp.publicUrl.trim() : '';
    if (publicUrl.startsWith('https://')) return publicUrl.replace(/\/+$/, '');
    return 'mailto:goobster@localhost';
}

let cached = null;

/**
 * Resolve the Web Push configuration once per process.
 *
 * Order: env (`GOOBSTER_VAPID_PUBLIC_KEY` / `GOOBSTER_VAPID_PRIVATE_KEY` /
 * `GOOBSTER_VAPID_SUBJECT`), then `webapp.push.*` in config.json, then a
 * key pair generated on first use and kept in `data/web-push-keys.json`
 * so the lite (single-process) deployment works with no configuration. A
 * split deployment must hand both processes the same pair through env or
 * config. When no pair can be resolved or persisted the feature is
 * disabled with a reason - never a crash.
 *
 * @returns {{ enabled: boolean, reason: string|null, publicKey: string|null, privateKey: string|null, subject: string }}
 */
function resolve() {
    if (cached) return cached;
    const subject = str('GOOBSTER_VAPID_SUBJECT', push.subject) || defaultSubject();
    if (!flag('GOOBSTER_WEB_PUSH_ENABLED', push.enabled, true)) {
        cached = { enabled: false, reason: 'disabled', publicKey: null, privateKey: null, subject };
        return cached;
    }
    let publicKey = str('GOOBSTER_VAPID_PUBLIC_KEY', push.vapidPublicKey);
    let privateKey = str('GOOBSTER_VAPID_PRIVATE_KEY', push.vapidPrivateKey);
    if ((publicKey && !privateKey) || (!publicKey && privateKey)) {
        cached = { enabled: false, reason: 'half-configured', publicKey: null, privateKey: null, subject };
        return cached;
    }
    if (!publicKey) {
        const stored = readKeyFile();
        if (stored) {
            ({ publicKey, privateKey } = stored);
        } else {
            const generated = generateKeyFile();
            if (!generated) {
                cached = { enabled: false, reason: 'no-keys', publicKey: null, privateKey: null, subject };
                return cached;
            }
            ({ publicKey, privateKey } = generated);
        }
    }
    cached = { enabled: true, reason: null, publicKey, privateKey, subject };
    return cached;
}

function readKeyFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
        if (typeof parsed?.publicKey === 'string' && typeof parsed?.privateKey === 'string') {
            return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
    } catch {
        // missing or unreadable: generate below
    }
    return null;
}

function generateKeyFile() {
    try {
        const webPush = requireOptional('web-push', { feature: 'push' });
        if (!webPush) return null;
        const keys = webPush.generateVAPIDKeys();
        fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
        fs.writeFileSync(KEY_FILE, JSON.stringify({
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            createdAt: new Date().toISOString(),
            note: 'VAPID key pair for Web Push. Deleting this file invalidates every push subscription.'
        }, null, 2), { mode: 0o600 });
        return keys;
    } catch {
        // No persistent home for the pair: a pair that dies with the process
        // would strand every subscription at the next restart.
        return null;
    }
}

/** Tests replace the resolved configuration; `null` clears the override. */
function _setForTests(value) {
    cached = value;
}

module.exports = {
    KEY_FILE,
    resolve,
    _setForTests,
    get enabled() {
        return resolve().enabled;
    },
    get publicKey() {
        return resolve().publicKey;
    },
    get subject() {
        return resolve().subject;
    }
};
