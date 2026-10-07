/**
 * The closed package-name tables of a native install (documentation/native_postgres.md).
 *
 * A name leaves this table only through `installNames`, and the privileged
 * helper accepts only names in the same table (it carries its own copy; see
 * pgdg.js for why, and tests/nativePostgresAdapters.test.js for the check that
 * keeps them equal). Nothing else is ever handed to `apt-get` or `dnf`.
 *
 * Roles of a package:
 *   server     the PostgreSQL server and the tooling that creates clusters
 *   client     psql, pg_dump, pg_restore of the SAME major as the server
 *              (backups refuse a server newer than the tool)
 *   pgvector   the `vector` extension
 *   contrib    the contrib extensions (`citext`); on Debian they ship inside
 *              the server package, on the RPM side in `postgresql17-contrib`
 *   prerequisites  what adding the PGDG repository needs on a bare host
 */

const { MAJOR } = require('./pgdg');

const FAMILIES = Object.freeze({
    debian: Object.freeze({
        manager: 'apt',
        prerequisites: Object.freeze(['ca-certificates', 'curl', 'gnupg']),
        server: Object.freeze([`postgresql-${MAJOR}`, 'postgresql-common']),
        client: Object.freeze([`postgresql-client-${MAJOR}`]),
        pgvector: Object.freeze([`postgresql-${MAJOR}-pgvector`]),
        contrib: Object.freeze([]),
        selinux: Object.freeze([])
    }),
    rhel: Object.freeze({
        manager: 'dnf',
        prerequisites: Object.freeze(['gnupg2']),
        server: Object.freeze([`postgresql${MAJOR}-server`]),
        client: Object.freeze([`postgresql${MAJOR}`]),
        pgvector: Object.freeze([`pgvector_${MAJOR}`]),
        contrib: Object.freeze([`postgresql${MAJOR}-contrib`]),
        selinux: Object.freeze(['policycoreutils-python-utils'])
    })
});

const ROLES = Object.freeze(['prerequisites', 'server', 'client', 'pgvector', 'contrib']);

function table(family) {
    const entry = FAMILIES[family];
    if (!entry) throw new Error('unknown distribution family');
    return entry;
}

/** Every name the helper may install on a family, in install order. */
function allNames(family) {
    const entry = table(family);
    return [...entry.prerequisites, ...entry.server, ...entry.client, ...entry.pgvector, ...entry.contrib, ...entry.selinux];
}

/** The names a provisioning needs (everything the table lists for the roles), for a family. */
function installNames(family, { selinux = false } = {}) {
    const entry = table(family);
    return [...entry.server, ...entry.client, ...entry.pgvector, ...entry.contrib, ...(selinux ? entry.selinux : [])];
}

/** Where a family's PostgreSQL binaries and extension files are. */
function layoutFor(family) {
    if (family === 'debian') {
        return { binDir: `/usr/lib/postgresql/${MAJOR}/bin`, shareDir: `/usr/share/postgresql/${MAJOR}`, extensionDir: `/usr/share/postgresql/${MAJOR}/extension`, socketDir: '/var/run/postgresql', defaultDataParent: `/var/lib/postgresql/${MAJOR}`, mainDataRoot: '/var/lib/postgresql', configRoot: '/etc/postgresql' };
    }
    return { binDir: `/usr/pgsql-${MAJOR}/bin`, shareDir: `/usr/pgsql-${MAJOR}/share`, extensionDir: `/usr/pgsql-${MAJOR}/share/extension`, socketDir: '/run/postgresql', defaultDataParent: `/var/lib/pgsql/${MAJOR}`, mainDataRoot: '/var/lib/pgsql', configRoot: null };
}

module.exports = { MAJOR, FAMILIES, ROLES, table, allNames, installNames, layoutFor };
