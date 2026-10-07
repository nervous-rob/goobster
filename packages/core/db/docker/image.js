/**
 * The one place the Postgres image of a manager-owned Docker instance is
 * pinned (documentation/docker_postgres.md).
 *
 * The image is referenced by digest, never by tag: `docker run pgvector/pgvector:pg17`
 * would follow whatever the maintainers push to the tag tomorrow, and a major
 * upgrade of a data directory is not an update (ADR 0013 decision 12). The tag
 * is recorded beside the digest for humans; the digest is the multi-platform
 * index (linux/amd64 and linux/arm64) that the tag pointed at on `RESOLVED_ON`.
 *
 * Moving the pin to a newer minor of the same major means resolving the tag
 * again (`docker buildx imagetools inspect pgvector/pgvector:pg17`), changing
 * `DIGEST` and `POSTGRES_MINOR` here and running the Docker CI job. Moving to
 * another major is `MAJOR_UPGRADE_IS_MANUAL`: `planMajorChange` refuses it.
 */

const { MIN_SERVER_VERSION, REQUIRED_EXTENSIONS } = require('../migration/inspect');

const REPOSITORY = 'pgvector/pgvector';
const TAG = 'pg17';
const DIGEST = 'sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d';
const RESOLVED_ON = '2026-10-07';
const POSTGRES_MAJOR = 17;
const POSTGRES_MINOR = '17.11';
const PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
/** Compressed size of the layers by platform; what a pull downloads. */
const PULL_BYTES = Object.freeze({ amd64: 160_545_628, arm64: 158_314_410 });
/** `PGDATA` inside the image: the volume or host path is mounted here. */
const DATA_DIRECTORY = '/var/lib/postgresql/data';
/** What the image carries: `vector` is pgvector's own, `citext` ships in PostgreSQL's contrib. */
const EXTENSIONS = Object.freeze({ vector: 'pgvector', citext: 'postgresql contrib' });

const UPGRADING_DOC = 'documentation/postgres_setup.md (section "Upgrading the server")';

const REFERENCE = `${REPOSITORY}@${DIGEST}`;
/** For humans and the plan: the same image by its tag. Never passed to `docker run`. */
const HUMAN_REFERENCE = `${REPOSITORY}:${TAG}`;

/** The pinned image as one object. */
function pinned() {
    return Object.freeze({
        repository: REPOSITORY,
        tag: TAG,
        digest: DIGEST,
        reference: REFERENCE,
        humanReference: HUMAN_REFERENCE,
        resolvedOn: RESOLVED_ON,
        postgresMajor: POSTGRES_MAJOR,
        postgresMinor: POSTGRES_MINOR,
        platforms: PLATFORMS,
        extensions: { ...EXTENSIONS },
        dataDirectory: DATA_DIRECTORY,
        minimumServerVersion: MIN_SERVER_VERSION
    });
}

/** The extension names Goobster requires, each with what provides it in this image. */
function extensionTable() {
    return REQUIRED_EXTENSIONS.map(name => ({ name, providedBy: EXTENSIONS[name] || null, inImage: Boolean(EXTENSIONS[name]) }));
}

/** Docker's `Architecture` (`uname -m` spelling) as the image's platform name, or null when no image is published for it. */
function platformOf(architecture, osType = 'linux') {
    const arch = ({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' })[String(architecture || '').toLowerCase()] || null;
    if (!arch || String(osType || 'linux').toLowerCase() !== 'linux') return null;
    return PLATFORMS.includes(`linux/${arch}`) ? { os: 'linux', arch, platform: `linux/${arch}`, pullBytes: PULL_BYTES[arch] } : null;
}

/** The major of a `pg_dump --version` line ("pg_dump (PostgreSQL) 17.2 (Debian ...)"), or null. */
function parseClientMajor(text) {
    const match = /(\d+)(?:\.(\d+))?/.exec(String(text || '').replace(/^.*?\(PostgreSQL\)\s*/i, ''));
    if (!match) return null;
    const major = Number(match[1]);
    return Number.isInteger(major) && major >= 7 && major < 100 ? major : null;
}

/**
 * Can the host's `pg_dump` back up the pinned server? `pg_dump` refuses a server
 * of a newer major version (backupService.js `TOOL_VERSION_MISMATCH`); an equal or newer
 * client is fine. A missing tool is not a block either: backups then fail with
 * `TOOL_MISSING` until it is installed, and the plan says so before provisioning.
 *
 * @returns {{ code: string, ok: boolean, serverMajor: number, clientMajor: number|null, remedy: string|null }}
 */
function backupCompatibility(clientMajor) {
    const serverMajor = POSTGRES_MAJOR;
    if (clientMajor === null || clientMajor === undefined) {
        return { code: 'BACKUP_TOOLS_MISSING', ok: false, serverMajor, clientMajor: null, remedy: `Install the PostgreSQL ${serverMajor} client tools (the package postgresql-client-${serverMajor}) so backups of this database work, or point GOOBSTER_PG_BIN at their bin directory.` };
    }
    if (clientMajor < serverMajor) {
        return { code: 'BACKUP_TOOLS_MISMATCH', ok: false, serverMajor, clientMajor, remedy: `The host's pg_dump is version ${clientMajor} and refuses a PostgreSQL ${serverMajor} server. Install postgresql-client-${serverMajor} (or newer) and put it first on PATH, or set GOOBSTER_PG_BIN to its bin directory.` };
    }
    return { code: 'BACKUP_TOOLS_OK', ok: true, serverMajor, clientMajor, remedy: null };
}

/**
 * Changing the major version of an instance this installer owns is never an update.
 * @returns {{ ok: true }|{ ok: false, code: 'MAJOR_UPGRADE_IS_MANUAL', message: string, from: number, to: number }}
 */
function planMajorChange({ currentMajor, wantedMajor = POSTGRES_MAJOR }) {
    if (currentMajor === null || currentMajor === undefined || Number(currentMajor) === Number(wantedMajor)) return { ok: true };
    return {
        ok: false,
        code: 'MAJOR_UPGRADE_IS_MANUAL',
        from: Number(currentMajor),
        to: Number(wantedMajor),
        message: `The instance runs PostgreSQL ${currentMajor} and this release pins ${wantedMajor}. A major upgrade is never applied by the installer: back the database up and follow ${UPGRADING_DOC}.`
    };
}

/** Goobster's own floor against the pinned image, and the pairing with a host client, as a table the docs and the UI render. */
function compatibilityTable() {
    return {
        image: HUMAN_REFERENCE,
        serverMajor: POSTGRES_MAJOR,
        goobsterMinimum: Math.floor(MIN_SERVER_VERSION / 10000),
        serverMeetsGoobster: POSTGRES_MAJOR * 10000 >= MIN_SERVER_VERSION,
        clientRule: `pg_dump and pg_restore must be version ${POSTGRES_MAJOR} or newer`,
        extensions: extensionTable()
    };
}

module.exports = {
    REPOSITORY, TAG, DIGEST, REFERENCE, HUMAN_REFERENCE, RESOLVED_ON, POSTGRES_MAJOR, POSTGRES_MINOR, PLATFORMS, PULL_BYTES,
    DATA_DIRECTORY, EXTENSIONS, UPGRADING_DOC,
    pinned, extensionTable, platformOf, parseClientMajor, backupCompatibility, planMajorChange, compatibilityTable
};
