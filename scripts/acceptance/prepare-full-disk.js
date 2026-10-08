'use strict';

// Only a newly mounted, tiny tmpfs may be filled. Never fill a host filesystem.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
assert.equal(process.platform, 'linux', 'this proof requires a Linux tmpfs');
assert.ok(root && path.isAbsolute(root), 'an absolute mount path is required');
const stat = fs.statfsSync(root);
assert.equal(stat.type, 0x01021994, 'refusing to fill anything other than tmpfs');
assert.ok(stat.blocks * stat.bsize <= 2 * 1024 * 1024, 'refusing a filesystem larger than 2 MiB');
assert.deepEqual(fs.readdirSync(root), [], 'the proof mount must be empty');
const file = path.join(root, 'capacity-fixture');
const fd = fs.openSync(file, 'wx');
let written = 0;
let full = false;
try {
    for (let i = 0; i <= 512; i++) {
        try { written += fs.writeSync(fd, Buffer.alloc(4096)); }
        catch (error) { if (error.code !== 'ENOSPC') throw error; full = true; break; }
    }
    assert.ok(full && written >= 65536, 'the bounded volume must reach a real ENOSPC');
    // Leave room for the installer's writeability probe; payload capacity must
    // still be refused before copying any release files.
    fs.ftruncateSync(fd, written - 65536);
} finally { fs.closeSync(fd); }
fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify({ observed: 'ENOSPC', bytesAtLimit: written }));
console.log('PASS: dedicated bounded tmpfs reached ENOSPC; 64 KiB reserved for preflight probes');
