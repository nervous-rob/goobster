/**
 * Connecting Goobster to an existing Postgres server (documentation/database_connection.md):
 * the settings and their URL, the read-only probe, the schema comparison and
 * the explicit provisioning. Built on the migration preflight's inspector
 * (`../migration/inspect`); nothing here opens the application database
 * facade, bootstraps a schema or persists a URL.
 */

module.exports = {
    ...require('./settings'),
    ...require('./probe'),
    ...require('./provisioning'),
    ...require('./schemaState'),
    ConnectionError: require('./errors').ConnectionError
};
