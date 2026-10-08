/**
 * Whether a directory's file system can hold a database that must survive a
 * reboot (documentation/native_postgres.md, "Storage"). The rules are a closed
 * list of refusals, not a list of file systems believed good: an unfamiliar
 * type is allowed with a note, a known-bad one is refused. The privileged
 * helper applies the same table before it creates or moves a cluster (it
 * carries its own copy; tests/nativePostgresAdapters.test.js keeps them equal).
 */

/** Gone after a reboot. */
const TRANSIENT = Object.freeze(['tmpfs', 'ramfs', 'devtmpfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'squashfs', 'iso9660', 'overlay-ro']);
/** No Unix ownership and modes, or locking a database cannot rely on. */
const UNSUITABLE = Object.freeze(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'vfat', 'exfat', 'msdos', 'ntfs', 'ntfs3', 'fuseblk', 'sshfs', 'fuse.sshfs', 'fuse.gvfsd-fuse', 'vboxsf']);

function parseFindmnt(text) {
    const line = String(text || '').split('\n').map(item => item.trim()).find(Boolean);
    if (!line) return null;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !parts[0].startsWith('/')) return null;
    return { target: parts[0], fstype: parts[1], options: (parts[2] || '').split(',').filter(Boolean) };
}

/** `/etc/fstab` text -> mount points listed in it. */
function fstabTargets(text) {
    const out = new Set();
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const fields = line.split(/\s+/);
        if (fields.length >= 2) out.add(fields[1].replace(/\\040/g, ' '));
    }
    return out;
}

/**
 * @param {{ target: string, fstype: string, options: string[] }|null} mount
 * @param {{ fstabTargets?: Set<string>|null }} [facts]
 * @returns {{ ok: boolean, issues: Array<{ code: string, severity: 'block'|'note' }> }}
 */
function classify(mount, { fstabTargets: listed = null } = {}) {
    const issues = [];
    if (!mount) return { ok: true, issues: [{ code: 'MOUNT_UNKNOWN', severity: 'note' }] };
    const type = String(mount.fstype || '').toLowerCase();
    if (TRANSIENT.includes(type)) issues.push({ code: 'MOUNT_NOT_PERSISTENT', severity: 'block' });
    else if (UNSUITABLE.includes(type) || type.startsWith('fuse.')) issues.push({ code: 'FILESYSTEM_UNSUPPORTED', severity: 'block' });
    if (mount.options.includes('ro')) issues.push({ code: 'MOUNT_READ_ONLY', severity: 'block' });
    if (type === 'overlay') issues.push({ code: 'FILESYSTEM_OVERLAY', severity: 'note' });
    if (mount.target !== '/' && !issues.some(item => item.severity === 'block') && listed && !listed.has(mount.target)) {
        issues.push({ code: 'MOUNT_NOT_IN_FSTAB', severity: 'block' });
    }
    return { ok: !issues.some(item => item.severity === 'block'), issues };
}

module.exports = { TRANSIENT, UNSUITABLE, parseFindmnt, fstabTargets, classify };
