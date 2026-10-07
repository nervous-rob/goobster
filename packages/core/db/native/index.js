/**
 * Managed native PostgreSQL (documentation/native_postgres.md): the supported
 * distributions and their package tables, the pinned PGDG repositories, the
 * read-only inspection of what is already installed, and the naming and
 * storage rules. Nothing here changes the machine: the changes are the
 * privileged helper's (apps/manager/privileged), and the manager composes
 * both (apps/manager/native).
 */

const image = require('../docker/image');

module.exports = {
    NativeError: require('./errors').NativeError,
    distro: require('./distro'),
    pgdg: require('./pgdg'),
    packages: require('./packages'),
    names: require('./names'),
    mounts: require('./mounts'),
    scram: require('./scram'),
    runner: require('./runner'),
    inventory: require('./inventory'),
    MAJOR: require('./pgdg').MAJOR,
    parseClientMajor: image.parseClientMajor,
    backupCompatibility: image.backupCompatibility,
    planMajorChange: image.planMajorChange
};
