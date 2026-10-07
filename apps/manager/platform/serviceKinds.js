/**
 * The service kinds the installer can register, one definition per operating
 * system service manager. `serviceLifecycle.js` (the `register-service` and
 * `unregister-service` steps) is written against this shape and nothing else:
 * a platform adds its kind here, in one line, and the steps, the ownership
 * record, the manual fallback and the bootstrap's closing message follow.
 *
 * A definition is a frozen object:
 *
 *   kind                 'systemd' | 'windows-service' | 'launchd' (serviceRecord.KINDS)
 *   platforms            the `process.platform` values it serves
 *   serviceName          the one name this installation registers under
 *   fallbackFileName     the definition written to `<manager store>/` when
 *                        registration falls back to the operator's hands
 *   installedFileName(name)   the file the service manager keeps for `name`
 *   installedPath(name, { roots })   that file's absolute path (the ownership record); a kind that keeps
 *                        its definition inside the installation (the manager store) reads the roots
 *   render(params)       the service definition text: { name, installationId,
 *                        runtimeUser, codeRoot, roots, layout, mode, nodePath }
 *   manualInstructions({ codeRoot, mode, nodePath, unitFile })
 *                        { foreground, boot: string[], unitFile } for an operator
 *   statusCommand        what to type to see whether it runs
 *   removeByHand         how to remove it when the uninstall cannot elevate
 *   account              { creatable, accepts(name), defaultFor({ invoking }), fallbackName }
 *                        creatable: `user.create` applies (a POSIX system account the helper
 *                        creates and hands the mutable roots to); a service manager that
 *                        assigns the identity itself (a Windows virtual account) says false
 *   registerInput(params)     the `service.register` request body (privileged/protocol.js shape) from
 *                        { name, layout, codeRoot, runtimeUser, installationId, roots, mode, nodePath,
 *                          invoking, elevated }; a kind with per-account services sets `scope: 'user'`
 *   unregisterInput({ name, installationId })   the `service.unregister` request body
 *
 * A platform with no definition registers nothing: the steps answer
 * `deferred` with NOT_IMPLEMENTED, as they did before any kind existed.
 */

const serviceRecord = require('./serviceRecord');

const DEFINITIONS = Object.freeze({
    systemd: require('./systemdService')
});

const REQUIRED = Object.freeze(['kind', 'platforms', 'serviceName', 'fallbackFileName', 'installedFileName', 'installedPath', 'render', 'manualInstructions', 'statusCommand', 'removeByHand', 'account', 'registerInput', 'unregisterInput']);

/** @throws {Error} when a definition does not implement the shape above */
function assertDefinition(definition) {
    for (const key of REQUIRED) {
        if (definition[key] === undefined || definition[key] === null) throw new Error(`the ${definition && definition.kind ? definition.kind : 'service'} kind lacks ${key}`);
    }
    if (!serviceRecord.KINDS.includes(definition.kind)) throw new Error(`${definition.kind} is not a service kind the record knows`);
    for (const fn of ['installedFileName', 'installedPath', 'render', 'manualInstructions', 'registerInput', 'unregisterInput']) {
        if (typeof definition[fn] !== 'function') throw new Error(`the ${definition.kind} kind's ${fn} is not a function`);
    }
    const account = definition.account;
    if (typeof account.creatable !== 'boolean' || typeof account.accepts !== 'function' || typeof account.defaultFor !== 'function' || typeof account.fallbackName !== 'string') {
        throw new Error(`the ${definition.kind} kind's account rules are incomplete`);
    }
    return definition;
}

for (const definition of Object.values(DEFINITIONS)) assertDefinition(definition);

/** The definition for a kind, or null when this version has none. */
function forKind(kind) {
    return DEFINITIONS[kind] || null;
}

/** The kind a platform registers; the name is fixed per platform whether or not a definition exists yet. */
function kindForPlatform(platform = process.platform) {
    if (platform === 'win32') return 'windows-service';
    if (platform === 'darwin') return 'launchd';
    return 'systemd';
}

/** The definition for a platform, or null. */
function forPlatform(platform = process.platform) {
    return forKind(kindForPlatform(platform));
}

module.exports = { DEFINITIONS, REQUIRED, assertDefinition, forKind, forPlatform, kindForPlatform };
