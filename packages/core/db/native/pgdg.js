/**
 * The one place the PostgreSQL Global Development Group (PGDG) repositories
 * are pinned (documentation/native_postgres.md).
 *
 * PostgreSQL 17 is in none of the supported distributions' own repositories
 * (Debian 12 ships 15, Ubuntu 22.04 ships 14, 24.04 ships 16, Alma/Rocky 9
 * ship 15 and 16 as module streams), so a native install adds the PGDG
 * repository. It is added only from what is pinned here: the signing key's
 * URL AND its full fingerprint. The helper downloads the key, refuses it
 * unless `gpg` reports exactly this fingerprint, and only then writes the
 * repository definition with the key as its only trusted signer. A key that
 * changed upstream is a refusal, not a silent trust.
 *
 * The fingerprints were checked on `RESOLVED_ON` against the signatures of
 * the repository metadata (`repomd.xml.asc` for the rpm repositories, the
 * `Release` file for apt). Moving a pin means repeating that check.
 *
 * apps/manager/privileged/linux.js carries the same values: the helper runs
 * as root and may load nothing outside its hashed files, so it cannot import
 * this module. tests/nativePostgresAdapters.test.js keeps the two equal.
 */

const RESOLVED_ON = '2026-10-07';
const MAJOR = 17;

const APT = Object.freeze({
    keyUrl: 'https://www.postgresql.org/media/keys/ACCC4CF8.asc',
    fingerprint: 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8',
    repositoryUrl: 'https://apt.postgresql.org/pub/repos/apt',
    component: 'main',
    keyFile: '/etc/apt/keyrings/goobster-pgdg.asc',
    sourcesFile: '/etc/apt/sources.list.d/goobster-pgdg.sources',
    architectures: Object.freeze({ x64: 'amd64', arm64: 'arm64' })
});

const RPM = Object.freeze({
    baseUrl: `https://download.postgresql.org/pub/repos/yum/${MAJOR}/redhat/rhel-9-`,
    keys: Object.freeze({
        x64: Object.freeze({ url: 'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-RHEL', fingerprint: 'D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20', basearch: 'x86_64' }),
        arm64: Object.freeze({ url: 'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-AARCH64-RHEL', fingerprint: 'B031F89FC983E98262906B6E177B343BB9738825', basearch: 'aarch64' })
    }),
    keyFile: '/etc/pki/rpm-gpg/goobster-PGDG-RPM-GPG-KEY',
    repoFile: '/etc/yum.repos.d/goobster-pgdg17.repo',
    repoId: 'goobster-pgdg17'
});

/** The repository the planner shows an operator before anything is added. */
function describe(family, { codename = null, arch = 'x64' } = {}) {
    if (family === 'debian') {
        return { family, url: APT.repositoryUrl, suite: codename ? `${codename}-pgdg` : null, component: APT.component, keyUrl: APT.keyUrl, fingerprint: APT.fingerprint };
    }
    const key = RPM.keys[arch];
    return { family, url: key ? `${RPM.baseUrl}${key.basearch}` : null, suite: null, component: null, keyUrl: key ? key.url : null, fingerprint: key ? key.fingerprint : null };
}

module.exports = { RESOLVED_ON, MAJOR, APT, RPM, describe };
