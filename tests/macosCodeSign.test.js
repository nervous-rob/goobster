const fs = require('node:fs');
const { signBinaries } = require('../scripts/lib/macosCodeSign');

const binaries = ['runtime/bin/node', 'app/node_modules/addon.node', 'app/node_modules/lib.dylib'].map(rel => ({ rel, info: { format: 'macho' } }));

test('signs and strictly verifies all Mach-O files, giving JIT exceptions only to Node', () => {
    const calls = [];
    const result = signBinaries({ root: '/payload', binaries, platform: 'darwin', identity: 'Developer ID Application: Example', run(file, args) {
        const i = args.indexOf('--entitlements');
        calls.push({ file, args, plist: i < 0 ? null : fs.readFileSync(args[i + 1], 'utf8') });
    } });
    expect(result.mode).toBe('developer-id');
    expect(calls).toHaveLength(6);
    const signing = calls.filter(call => call.args.includes('--sign'));
    expect(signing.at(-1).args.at(-1)).toBe('/payload/runtime/bin/node');
    expect(signing.filter(call => call.plist)).toHaveLength(1);
    expect(signing.at(-1).plist).toContain('allow-jit');
    expect(signing.at(-1).plist).not.toContain('disable-library-validation');
    for (const call of signing) expect(call.args).toContain('--timestamp');
    expect(calls.filter(call => call.args.includes('--verify')).every(call => call.args.includes('--strict'))).toBe(true);
});

test('ad-hoc signing requires the explicit development mode and cannot be used on another OS', () => {
    expect(() => signBinaries({ root: '/payload', binaries, platform: 'darwin', identity: '-' })).toThrow(/development/);
    expect(() => signBinaries({ root: '/payload', binaries, platform: 'linux', identity: 'certificate' })).toThrow(/macOS/);
});

test('verification failure stops the build and cleans temporary entitlements', () => {
    let plist;
    expect(() => signBinaries({ root: '/payload', binaries: [binaries[0]], platform: 'darwin', identity: '-', development: true, run(file, args) {
        const i = args.indexOf('--entitlements');
        if (i >= 0) { plist = args[i + 1]; expect(fs.readFileSync(plist, 'utf8')).toContain('disable-library-validation'); }
        if (args.includes('--verify')) throw new Error('bad signature');
    } })).toThrow('bad signature');
    expect(fs.existsSync(plist)).toBe(false);
});
