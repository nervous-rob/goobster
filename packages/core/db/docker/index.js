/**
 * Docker-managed PostgreSQL (documentation/docker_postgres.md): the pinned
 * image, resource naming and ownership, the daemon check and container
 * management over the plain `docker` CLI. Nothing here knows about the manager,
 * the installation record or an operation; the manager composes it
 * (apps/manager/docker).
 */

module.exports = {
    image: require('./image'),
    names: require('./names'),
    ...require('./image'),
    ...require('./names'),
    ...require('./daemon'),
    ...require('./containers'),
    ...require('./runner'),
    DockerError: require('./errors').DockerError
};
