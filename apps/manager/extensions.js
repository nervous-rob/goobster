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
    require('./routes/maintenance').mountMaintenanceRoutes
];

/** @type {Array<(deps: { settings: Object, fs: Object, now: () => Date, logger: Object }) => import('./engine').OperationKind[]>} */
const kinds = [
    require('./engine/kinds/config').createKinds,
    require('./engine/kinds/defaults').createKinds,
    require('./engine/kinds/lifecycle').createLifecycleKinds,
    require('./engine/kinds/install').createKinds,
    require('./engine/kinds/maintenance').createMaintenanceKinds
];

module.exports = { routes, kinds };
