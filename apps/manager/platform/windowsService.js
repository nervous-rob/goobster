/**
 * The Windows service kind (documentation/windows_install.md, "The service"):
 * what `serviceLifecycle.js` needs to know about the Windows service manager
 * that it must not know about systemd or launchd. The definition text itself
 * is `windowsServiceXml.js` (Node built-ins only, because the privileged
 * helper loads it elevated); this module is the manager's side.
 *
 * The service runs as the virtual account `NT SERVICE\goobster`: Windows
 * creates and owns it, so the kind creates no account (`user.create` is not
 * implemented on Windows) and accepts exactly one runtime user name.
 *
 * See `serviceKinds.js` for the shape every kind implements.
 */

const path = require('node:path');
const xml = require('./windowsServiceXml');

const KIND = 'windows-service';
const SERVICE_NAME = xml.SERVICE_ID;
const FALLBACK_FILE_NAME = xml.XML_FILE_NAME;

const q = (value) => `"${value}"`;

/**
 * What an operator types to run the supervisor in the foreground, and to
 * register it by hand from an administrator prompt (cmd.exe). The foreground
 * line is the wrapper the installer leaves beside the code root, which reads
 * the installation's roots from `goobster.env`.
 */
function manualInstructions({ codeRoot, unitFile }) {
    const store = path.win32.dirname(unitFile);
    const serviceDir = path.win32.join(store, xml.SERVICE_DIR_NAME);
    const host = path.win32.join(serviceDir, xml.HOST_FILE_NAME);
    return {
        foreground: `${q(path.win32.join(codeRoot, 'goobster-manager.cmd'))} --supervise`,
        boot: [
            `mkdir ${q(serviceDir)}`,
            `copy ${q(`<path to WinSW.NET4.exe v${xml.WINSW.version}>`)} ${q(host)}`,
            `copy ${q(unitFile)} ${q(path.win32.join(serviceDir, xml.XML_FILE_NAME))}`,
            `${q(host)} install`,
            `${q(host)} start`
        ],
        unitFile
    };
}

module.exports = Object.freeze({
    kind: KIND,
    platforms: Object.freeze(['win32']),
    serviceName: SERVICE_NAME,
    fallbackFileName: FALLBACK_FILE_NAME,
    installedFileName: () => xml.XML_FILE_NAME,
    installedPath: (name, { roots }) => xml.servicePaths(roots).xml,
    render: ({ name, installationId, runtimeUser, codeRoot, roots, layout }) => xml.renderXml({ name, installationId, runtimeUser, codeRoot, roots, layout }),
    manualInstructions,
    statusCommand: `sc.exe query ${SERVICE_NAME}`,
    removeByHand: `sc.exe stop ${SERVICE_NAME}, then sc.exe delete ${SERVICE_NAME}, then delete the service folder in the manager store`,
    account: Object.freeze({
        creatable: false,
        accepts: (name) => name === xml.ACCOUNT_NAME,
        defaultFor: () => xml.ACCOUNT_NAME,
        fallbackName: xml.ACCOUNT_NAME
    }),
    registerInput: ({ name, layout, codeRoot, runtimeUser, installationId, roots, mode }) => ({
        kind: KIND,
        name,
        layout,
        codeRoot,
        runtimeUser,
        installationId,
        roots,
        mode
    }),
    unregisterInput: ({ name, installationId }) => ({ kind: KIND, name, registeredBy: 'installer', installationId })
});
