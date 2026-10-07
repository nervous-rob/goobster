/**
 * The manager's extension registry: the route families and operation-kind
 * families beyond the #323 foundation, each in its own module so later
 * issues add one line here instead of editing server.js or manager.js.
 *
 *   routes  — `(api, helpers) => void`, see server.js `RouteHelpers`
 *   kinds   — `({ settings, fs, now, logger }) => OperationKind[]`
 *
 * Keep the list literal: a module that is missing is a startup error, not
 * a silently absent capability.
 */

/** @type {Array<(api: import('express').Router, helpers: import('./server').RouteHelpers) => void>} */
const routes = [
    require('./routes/config').createConfigMount(),
    require('./routes/lifecycle').mountLifecycleRoutes,
    require('./routes/maintenance').mountMaintenanceRoutes,
    require('./routes/reset').mountResetRoutes,
    require('./routes/config').createConfigMount(),
    require('./routes/migrate').mountMigrateRoutes,
    require('./routes/install').createInstallMount(),
    require('./routes/backup').mountBackupRoutes,
    require('./routes/database').mountDatabaseRoutes,
    require('./routes/docker').mountDockerRoutes,
    require('./routes/update').mountUpdateRoutes
];

/** @type {Array<(deps: { settings: Object, fs: Object, now: () => Date, logger: Object }) => import('./engine').OperationKind[]>} */
const kinds = [
    require('./engine/kinds/config').createKinds,
    require('./engine/kinds/defaults').createKinds,
    require('./engine/kinds/lifecycle').createLifecycleKinds,
    require('./engine/kinds/install').createKinds,
    require('./engine/kinds/maintenance').createMaintenanceKinds,
    require('./engine/kinds/reset').createKinds,
    require('./engine/kinds/migrate').createKinds,
    require('./engine/kinds/owner').createKinds,
    require('./engine/kinds/backup').createKinds,
    require('./engine/kinds/database').createKinds,
    require('./engine/kinds/dockerPostgres').createKinds,
    require('./engine/kinds/update').createKinds
];

module.exports = { routes, kinds };
