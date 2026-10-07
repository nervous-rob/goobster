/**
 * The systemd service kind (documentation/linux_install.md, "The service"):
 * what `serviceLifecycle.js` needs to know about systemd that it must not
 * know about launchd or the Windows service manager. The unit text itself is
 * `systemdUnit.js` (Node built-ins only, because the privileged helper loads
 * it as root); this module is the manager's side and may use the manager's
 * own modules.
 *
 * See `serviceKinds.js` for the shape every kind implements.
 */

const path = require('node:path');
const unitText = require('./systemdUnit');

const KIND = 'systemd';
const SERVICE_NAME = 'goobster';
const FALLBACK_FILE_NAME = 'goobster.service';

function shellQuote(value) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** What an operator types to run the supervisor in the foreground, and to start it at boot by hand. */
function manualInstructions({ codeRoot, mode, nodePath, unitFile }) {
    const foreground = mode === 'payload'
        ? `${shellQuote(`${codeRoot}/current/bin/goobster-manager`)} --supervise`
        : `${shellQuote(nodePath)} ${shellQuote(`${codeRoot}/apps/manager/index.js`)} --supervise`;
    return {
        foreground,
        boot: [
            `sudo install -m 0644 ${shellQuote(unitFile)} /etc/systemd/system/${FALLBACK_FILE_NAME}`,
            'sudo systemctl daemon-reload',
            `sudo systemctl enable --now ${FALLBACK_FILE_NAME}`
        ],
        unitFile
    };
}

module.exports = Object.freeze({
    kind: KIND,
    platforms: Object.freeze(['linux']),
    serviceName: SERVICE_NAME,
    fallbackFileName: FALLBACK_FILE_NAME,
    installedFileName: (name) => unitText.unitFileName(name),
    installedPath: (name) => path.posix.join(unitText.UNIT_DIR, unitText.unitFileName(name)),
    render: ({ name, installationId, runtimeUser, codeRoot, roots, layout, mode, nodePath }) => unitText.renderUnit({ name, installationId, runtimeUser, codeRoot, roots, layout, mode, nodePath }),
    manualInstructions,
    statusCommand: `systemctl status ${SERVICE_NAME}`,
    removeByHand: `systemctl disable --now ${SERVICE_NAME}, delete its unit file`,
    account: Object.freeze({
        creatable: true,
        accepts: (name) => Boolean(name) && name !== 'root' && unitText.RUNTIME_USER.test(name),
        defaultFor: ({ invoking }) => invoking || null,
        fallbackName: SERVICE_NAME
    }),
    registerInput: ({ name, layout, codeRoot, runtimeUser, installationId, roots, mode, nodePath }) => ({
        kind: KIND,
        name,
        layout,
        codeRoot,
        runtimeUser,
        installationId,
        roots,
        mode,
        ...(mode === 'checkout' ? { nodePath } : {})
    }),
    unregisterInput: ({ name, installationId }) => ({ kind: KIND, name, registeredBy: 'installer', installationId })
});
