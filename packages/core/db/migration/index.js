/**
 * SQLite -> Postgres migration operations (documentation/db_migration.md):
 * read-only inspection, the table copy and the verification. The manager's
 * `db.migrate` kinds and scripts/migrate-to-postgres.js are both built on
 * these; nothing here holds the maintenance barrier, takes a backup or
 * switches configuration - that is the operation's job.
 */

const inspect = require('./inspect');
const copy = require('./copy');
const verify = require('./verify');
const source = require('./source');
const target = require('./target');
const schemaModel = require('./schemaModel');
const attachments = require('./attachments');
const { MigrationError } = require('./errors');
const { ROLLBACK_LIMIT } = require('./rollbackLimit');

module.exports = {
    ROLLBACK_LIMIT,
    MigrationError,
    inspect,
    copy,
    verify,
    source,
    target,
    schemaModel,
    attachments,
    ...inspect,
    ...copy,
    ...verify,
    openSource: source.openSource,
    hashSource: source.hashSource,
    describeTarget: target.describeTarget
};
