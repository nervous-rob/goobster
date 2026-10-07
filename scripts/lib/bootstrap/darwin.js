'use strict';

/**
 * What the macOS bootstrap packager builds besides the shared archive writer
 * (documentation/macos_install.md, "Building"): the pkg's Distribution, scripts
 * and resources tree, the per-user tar.gz's folder, and the calls to
 * `pkgbuild`, `productbuild`, `productsign` and `notarytool`. Node built-ins
 * only. Everything here runs on Linux except the Apple tools themselves, which
 * are found on PATH and never fetched: when they are absent the caller reports
 * PKG_SKIPPED and still has the tree.
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TEMPLATE_DIR = path.join(REPO, 'bootstrap', 'macos');
const HOST_ARCHITECTURES = Object.freeze({ arm64: 'arm64', x64: 'x86_64' });
const COMPONENT_IDENTIFIER = 'io.goobster.payload';
const COMPONENT_FILE = 'goobster-payload.pkg';
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._+/=-]*$/;
const PLACEHOLDER = /@([A-Z0-9_]+)@/g;

class DarwinPackagingError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DarwinPackagingError';
        this.code = code;
    }
}

function assertVersion(version) {
    if (typeof version !== 'string' || !SAFE_VERSION.test(version) || version.includes('..')) {
        throw new DarwinPackagingError('VERSION_INVALID', 'the release version holds a character a package path or shell value cannot carry');
    }
    return version;
}

function escapeMarkup(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Fill `@NAME@` placeholders. `shell` values must be plain (they land inside single-quoted shell assignments);
 * `markup` values are XML/HTML-escaped; `raw` values are inserted verbatim (they are built here, not supplied).
 */
function render(text, { shell = {}, markup = {}, raw = {} }) {
    return text.replace(PLACEHOLDER, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(shell, key)) {
            const value = String(shell[key]);
            if (!SAFE_VALUE.test(value)) throw new DarwinPackagingError('VALUE_INVALID', `the value for ${key} holds a character a shell assignment cannot carry`);
            return value;
        }
        if (Object.prototype.hasOwnProperty.call(markup, key)) return escapeMarkup(markup[key]);
        if (Object.prototype.hasOwnProperty.call(raw, key)) return String(raw[key]);
        throw new DarwinPackagingError('TEMPLATE_FIELD_MISSING', `a template needs a value for ${key}`);
    });
}

function readTemplate(...parts) {
    return fs.readFileSync(path.join(TEMPLATE_DIR, ...parts), 'utf8');
}

function noticeFor({ build, signed }) {
    if (build === 'release' && signed) return null;
    return 'This is an UNSIGNED DEVELOPMENT BUILD. Its payload carries no valid release signature; install it only into a development environment you trust. Do not use it for production.';
}

/**
 * Write the Distribution, scripts and resources the pkg is built from.
 * @returns {{ files: Array<{ path: string, mode: number }> }} relative to `dir`
 */
function writePkgTree({ dir, identity, arch, build, signed, publicKeyB64 = '', licenseFile = null }) {
    const version = assertVersion(identity.version);
    if (!HOST_ARCHITECTURES[arch]) throw new DarwinPackagingError('ARCH_UNKNOWN', `no macOS architecture named ${arch}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
    const files = [];
    const put = (rel, text, mode) => {
        fs.writeFileSync(path.join(dir, rel), text, { mode });
        fs.chmodSync(path.join(dir, rel), mode);
        files.push({ path: rel, mode });
    };

    const hasLicense = Boolean(licenseFile && fs.existsSync(licenseFile));
    const licenseLine = hasLicense ? '    <license file="license.txt" mime-type="text/plain"/>\n' : '';
    const distribution = render(readTemplate('Distribution.xml'), {
        markup: { VERSION: version, HOST_ARCHITECTURES: HOST_ARCHITECTURES[arch], COMPONENT: COMPONENT_FILE },
        raw: { LICENSE_LINE: licenseLine }
    }).replace(/\n\n/g, '\n');
    put('Distribution.xml', distribution, 0o644);

    const shell = {
        VERSION: version,
        TARGET: `darwin-${arch}`,
        PAYLOAD_DIGEST: identity.payloadDigest,
        SIGNED: signed ? '1' : '0',
        BUILD: build,
        PUBLIC_KEY_B64: publicKeyB64
    };
    put(path.join('scripts', 'postinstall'), render(readTemplate('scripts', 'postinstall'), { shell }), 0o755);

    const notice = noticeFor({ build, signed });
    const markup = {
        VERSION: version,
        ARCH: arch === 'x64' ? 'Intel' : 'Apple silicon'
    };
    const raw = { BUILD_NOTICE_HTML: notice ? `<p><b>${escapeMarkup(notice)}</b></p>` : '' };
    put(path.join('resources', 'welcome.html'), render(readTemplate('resources', 'welcome.html'), { markup, raw }), 0o644);
    put(path.join('resources', 'conclusion.html'), render(readTemplate('resources', 'conclusion.html'), { markup, raw }), 0o644);
    if (hasLicense) put(path.join('resources', 'license.txt'), fs.readFileSync(licenseFile, 'utf8'), 0o644);
    return { files };
}

/** `<out>/goobster-<version>-darwin-<arch>[-dev]/` for the tar.gz: install.command, README.txt, payload/, release-key.pem. */
function writeTarFolder({ dir, identity, arch, build, signed, payloadDir, publicKeyPem = null }) {
    const version = assertVersion(identity.version);
    fs.mkdirSync(dir, { recursive: true });
    const shell = {
        VERSION: version,
        TARGET: `darwin-${arch}`,
        ARCH: arch,
        PAYLOAD_DIGEST: identity.payloadDigest,
        SIGNED: signed ? '1' : '0',
        BUILD: build
    };
    fs.writeFileSync(path.join(dir, 'install.command'), render(readTemplate('install.command'), { shell }), { mode: 0o755 });
    fs.chmodSync(path.join(dir, 'install.command'), 0o755);
    const notice = noticeFor({ build, signed });
    const readme = [
        `Goobster ${version} for macOS (${arch === 'x64' ? 'Intel' : 'Apple silicon'}), install for your own account`,
        '',
        ...(notice ? [notice, ''] : []),
        '1. Open Terminal in this folder (or double-click install.command in Finder).',
        '2. Run ./install.command - as yourself, never with sudo.',
        '3. The install wizard opens in your browser at http://127.0.0.1:3400/manager/ (this Mac only).',
        '',
        'A browser-downloaded development build carries the quarantine mark; clear it for this folder first:',
        '    xattr -dr com.apple.quarantine .',
        '',
        'Documentation: documentation/macos_install.md',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'README.txt'), readme, { mode: 0o644 });
    if (publicKeyPem) fs.writeFileSync(path.join(dir, 'release-key.pem'), publicKeyPem, { mode: 0o644 });
    linkTree(payloadDir, path.join(dir, 'payload'));
}

/** A tree of hard links where the filesystem allows, copies where it does not; symlinks stay symlinks. */
function linkTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
        const source = path.join(from, name);
        const target = path.join(to, name);
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(source), target);
        } else if (stat.isDirectory()) {
            linkTree(source, target);
        } else if (stat.isFile()) {
            try {
                fs.linkSync(source, target);
            } catch {
                fs.copyFileSync(source, target);
                fs.chmodSync(target, stat.mode & 0o777);
            }
        } else {
            throw new DarwinPackagingError('PAYLOAD_SPECIAL_FILE', `the payload holds something that is not a file, directory or link: ${name}`);
        }
    }
}

/** The absolute path of an executable on PATH (never relative, never the current directory), or null. */
function findTool(name, env = process.env) {
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (!dir || !path.isAbsolute(dir)) continue;
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { }
    }
    return null;
}

function runTool(file, args, { env = process.env, cwd } = {}) {
    const result = childProcess.spawnSync(file, args, { env, cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return {
        ok: result.status === 0,
        status: result.status,
        detail: String(result.stderr || result.stdout || result.error && result.error.message || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)
    };
}

/**
 * pkgbuild + productbuild, and optionally productsign and notarytool. Returns the outcome; never throws for a tool that is
 * missing or fails (the caller reports it as PKG_SKIPPED).
 * @returns {{ built: boolean, file?: string, reason?: string, detail?: string, tools?: Object, signing?: Object }}
 */
function buildPkg({ treeDir, payloadDir, identity, outFile, workDir, env = process.env, productSignIdentity = null, notaryProfile = null }) {
    const version = assertVersion(identity.version);
    const pkgbuild = findTool('pkgbuild', env);
    const productbuild = findTool('productbuild', env);
    if (!pkgbuild || !productbuild) {
        const missing = [!pkgbuild && 'pkgbuild', !productbuild && 'productbuild'].filter(Boolean).join(' and ');
        return { built: false, reason: 'TOOL_MISSING', detail: `${missing} ${missing.includes(' and ') ? 'are' : 'is'} not on PATH (they ship with macOS and the Xcode command line tools)` };
    }
    const root = path.join(workDir, 'pkg-root');
    const stageDir = path.join(root, 'opt', 'goobster', 'stage', version);
    fs.rmSync(root, { recursive: true, force: true });
    linkTree(payloadDir, stageDir);
    const component = path.join(workDir, COMPONENT_FILE);
    const first = runTool(pkgbuild, [
        '--root', root,
        '--identifier', COMPONENT_IDENTIFIER,
        '--version', version,
        '--install-location', '/',
        '--ownership', 'recommended',
        '--scripts', path.join(treeDir, 'scripts'),
        component
    ], { env });
    if (!first.ok) return { built: false, reason: 'PKGBUILD_FAILED', detail: `pkgbuild exited ${first.status === null ? 'abnormally' : first.status}: ${first.detail}` };
    fs.rmSync(outFile, { force: true });
    const unsigned = path.join(workDir, 'product.pkg');
    const second = runTool(productbuild, [
        '--distribution', path.join(treeDir, 'Distribution.xml'),
        '--resources', path.join(treeDir, 'resources'),
        '--package-path', workDir,
        '--version', version,
        unsigned
    ], { env });
    if (!second.ok || !fs.existsSync(unsigned)) return { built: false, reason: 'PRODUCTBUILD_FAILED', detail: `productbuild exited ${second.status === null ? 'abnormally' : second.status}: ${second.detail}` };

    const signing = { productsign: { requested: Boolean(productSignIdentity), done: false }, notarization: { requested: Boolean(notaryProfile), done: false } };
    let finished = unsigned;
    if (productSignIdentity) {
        const productsign = findTool('productsign', env);
        if (!productsign) return { built: false, reason: 'TOOL_MISSING', detail: 'productsign is not on PATH' };
        const signed = path.join(workDir, 'product-signed.pkg');
        const result = runTool(productsign, ['--sign', productSignIdentity, unsigned, signed], { env });
        if (!result.ok) return { built: false, reason: 'PRODUCTSIGN_FAILED', detail: `productsign exited ${result.status === null ? 'abnormally' : result.status}: ${result.detail}` };
        finished = signed;
        signing.productsign.done = true;
    }
    fs.copyFileSync(finished, outFile);
    if (notaryProfile) {
        const xcrun = findTool('xcrun', env);
        if (!xcrun) return { built: false, reason: 'TOOL_MISSING', detail: 'xcrun is not on PATH (notarization needs the Xcode command line tools)' };
        const submit = runTool(xcrun, ['notarytool', 'submit', outFile, '--keychain-profile', notaryProfile, '--wait'], { env });
        if (!submit.ok) return { built: false, reason: 'NOTARIZATION_FAILED', detail: `notarytool exited ${submit.status === null ? 'abnormally' : submit.status}: ${submit.detail}` };
        const staple = runTool(xcrun, ['stapler', 'staple', outFile], { env });
        if (!staple.ok) return { built: false, reason: 'STAPLE_FAILED', detail: `stapler exited ${staple.status === null ? 'abnormally' : staple.status}: ${staple.detail}` };
        signing.notarization.done = true;
    }
    return { built: true, file: outFile, tools: { pkgbuild: path.basename(pkgbuild), productbuild: path.basename(productbuild) }, signing };
}

module.exports = {
    DarwinPackagingError,
    HOST_ARCHITECTURES,
    COMPONENT_FILE,
    COMPONENT_IDENTIFIER,
    TEMPLATE_DIR,
    assertVersion,
    render,
    noticeFor,
    writePkgTree,
    writeTarFolder,
    linkTree,
    findTool,
    buildPkg
};
