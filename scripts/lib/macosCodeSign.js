'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Sign each inspected Mach-O before its final bytes enter the payload manifest. */
function signBinaries({ root, binaries, identity, development = false, platform = process.platform,
    run = (file, args) => execFileSync(file, args, { stdio: 'pipe' }) }) {
    if (platform !== 'darwin') throw new Error('Mach-O signing requires a macOS build host');
    if (!identity || (identity === '-' && !development)) throw new Error('ad-hoc signing is allowed only for a development payload');
    const files = binaries.filter(binary => binary.info.format === 'macho').map(binary => binary.rel)
        .sort((a, b) => Number(a === 'runtime/bin/node') - Number(b === 'runtime/bin/node') || a.localeCompare(b));
    if (!files.includes('runtime/bin/node')) throw new Error('the inspected payload has no Mach-O Node runtime');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-codesign-'));
    const entitlements = path.join(temp, 'node.plist');
    // Intel V8 can allocate executable memory without MAP_JIT. Only the Node
    // executable receives these JIT exceptions; dylibs and addons receive none.
    const keys = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'];
    // Ad-hoc signatures have no Team ID. Production signs all code with the
    // same Developer ID and retains library validation.
    if (identity === '-') keys.push('com.apple.security.cs.disable-library-validation');
    fs.writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${keys.map(key => `<key>${key}</key><true/>`).join('')}</dict></plist>`);
    try {
        for (const rel of files) {
            const args = ['--force', '--sign', identity, '--options', 'runtime', identity === '-' ? '--timestamp=none' : '--timestamp'];
            if (rel === 'runtime/bin/node') args.push('--entitlements', entitlements);
            args.push(path.join(root, rel));
            run('/usr/bin/codesign', args);
            run('/usr/bin/codesign', ['--verify', '--strict', path.join(root, rel)]);
        }
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    return { mode: identity === '-' ? 'ad-hoc-development' : 'developer-id', files };
}

module.exports = { signBinaries };
