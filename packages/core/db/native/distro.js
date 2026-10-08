/**
 * Which distribution this is and whether a native PostgreSQL install is
 * supported on it (documentation/native_postgres.md, "Supported hosts").
 *
 * Supported: Debian 12 (bookworm), Raspberry Pi OS Bookworm (which reports
 * itself as Debian 12), Ubuntu 22.04 and later, and AlmaLinux / Rocky Linux 9,
 * on x86-64 and 64-bit ARM. Everything else is refused with a reason that names
 * the way out (an existing server, or the Docker option). Pure functions over
 * the text of `/etc/os-release`; nothing here runs a command.
 */

const nodeFs = require('node:fs');
const os = require('node:os');

const OS_RELEASE_FILES = Object.freeze(['/etc/os-release', '/usr/lib/os-release']);
const RPI_ISSUE = '/etc/rpi-issue';
const UBUNTU_CODENAMES = Object.freeze({ '22.04': 'jammy', '24.04': 'noble' });

/** @returns {Record<string, string>} KEY=value lines, quotes stripped */
function parseOsRelease(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        out[match[1]] = value;
    }
    return out;
}

function architectureOf(raw) {
    const arch = String(raw || '').toLowerCase();
    if (['x64', 'x86_64', 'amd64'].includes(arch)) return 'x64';
    if (['arm64', 'aarch64'].includes(arch)) return 'arm64';
    return null;
}

const compareVersions = (left, right) => {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
};

/**
 * @param {Object} params
 * @param {Record<string,string>} params.release  parsed os-release
 * @param {string} [params.arch]                  `os.arch()` / `uname -m` spelling
 * @param {boolean} [params.raspberryPi]
 */
function classify({ release, arch = os.arch(), raspberryPi = false }) {
    const id = String(release.ID || '').toLowerCase();
    const like = String(release.ID_LIKE || '').toLowerCase().split(/\s+/).filter(Boolean);
    const versionId = String(release.VERSION_ID || '');
    const out = {
        id: id || null,
        like,
        versionId: versionId || null,
        codename: release.VERSION_CODENAME ? String(release.VERSION_CODENAME).toLowerCase() : null,
        prettyName: release.PRETTY_NAME || null,
        arch: architectureOf(arch),
        rawArch: String(arch || '') || null,
        raspberryPi: Boolean(raspberryPi),
        family: null,
        supported: false,
        tested: false,
        reason: null,
        label: null
    };
    out.label = `${out.prettyName || out.id || 'unknown Linux'}${out.arch ? ` (${out.arch === 'x64' ? 'x86-64' : 'arm64'})` : ''}`;
    if (id === 'debian' || id === 'raspbian') {
        out.family = 'debian';
        if (id === 'raspbian' || (out.arch === null && /^arm|^armv/.test(out.rawArch || ''))) {
            out.reason = 'ARCH_UNSUPPORTED';
        } else if (versionId.split('.')[0] !== '12') {
            out.reason = 'DISTRO_VERSION_UNSUPPORTED';
        } else {
            out.codename = 'bookworm';
            out.tested = true;
        }
    } else if (id === 'ubuntu') {
        out.family = 'debian';
        if (compareVersions(versionId, '22.04') < 0) {
            out.reason = 'DISTRO_VERSION_UNSUPPORTED';
        } else {
            out.codename = out.codename || UBUNTU_CODENAMES[versionId] || null;
            out.tested = Boolean(UBUNTU_CODENAMES[versionId]);
            if (!out.codename) out.reason = 'DISTRO_VERSION_UNSUPPORTED';
        }
    } else if (id === 'almalinux' || id === 'rocky') {
        out.family = 'rhel';
        if (versionId.split('.')[0] !== '9') out.reason = 'DISTRO_VERSION_UNSUPPORTED';
        else out.tested = true;
    } else {
        out.reason = 'DISTRO_UNSUPPORTED';
    }
    if (!out.reason && out.arch === null) out.reason = 'ARCH_UNSUPPORTED';
    out.supported = out.reason === null;
    return out;
}

const REASONS = Object.freeze({
    DISTRO_UNSUPPORTED: 'A managed native PostgreSQL is supported on Debian 12, Raspberry Pi OS Bookworm, Ubuntu 22.04 and later, and AlmaLinux or Rocky Linux 9. Use an existing PostgreSQL server, the Docker option, or SQLite on this machine.',
    DISTRO_VERSION_UNSUPPORTED: 'This version of the distribution is not supported for a managed native PostgreSQL (Debian 12, Ubuntu 22.04 or later, AlmaLinux or Rocky Linux 9 are). Use an existing PostgreSQL server, the Docker option, or SQLite.',
    ARCH_UNSUPPORTED: 'The PostgreSQL project publishes packages for 64-bit x86 and 64-bit ARM only. A 32-bit Raspberry Pi OS cannot install them; use SQLite, an existing server, or a 64-bit image.',
    OS_UNSUPPORTED: 'A managed native PostgreSQL is available on Linux only. On Windows and macOS use an existing server or the Docker option.'
});

/**
 * Read the host's facts. Never throws: an unreadable os-release is "unsupported".
 * @param {Object} [options]
 * @param {Object} [options.fs]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 */
function detect({ fs = nodeFs, platform = process.platform, arch = os.arch(), release = null } = {}) {
    if (platform !== 'linux') {
        return { id: null, like: [], versionId: null, codename: null, prettyName: null, arch: architectureOf(arch), rawArch: String(arch), raspberryPi: false, family: null, supported: false, tested: false, reason: 'OS_UNSUPPORTED', label: platform, remedy: REASONS.OS_UNSUPPORTED };
    }
    let parsed = release;
    if (!parsed) {
        parsed = {};
        for (const file of OS_RELEASE_FILES) {
            try {
                parsed = parseOsRelease(fs.readFileSync(file, 'utf8'));
                break;
            } catch { /* try the next location */ }
        }
    }
    let raspberryPi = false;
    try { raspberryPi = fs.existsSync(RPI_ISSUE); } catch { /* not a Pi */ }
    const result = classify({ release: parsed, arch, raspberryPi });
    return { ...result, remedy: result.reason ? REASONS[result.reason] : null };
}

module.exports = { OS_RELEASE_FILES, REASONS, parseOsRelease, architectureOf, classify, detect };
