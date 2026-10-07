'use strict';

const { notApplicable } = require('./evidence');

/** The lifecycle, in order. A step that needs an earlier one is not run when that one failed. */
async function runLifecycle(cell) {
    const rec = cell.rec;
    await rec.step('install', (step) => cell.stepInstall(step));
    await rec.step('owner', (step) => cell.stepOwner(step), { needs: ['install'] });
    await rec.step('chat', (step) => cell.stepChat(step), { needs: ['install', 'owner'] });
    for (const id of ['features', 'defaults-keys', 'boot-recovery', 'update', 'repair', 'backup-restore', 'migrate', 'reset', 'uninstall-keep', 'uninstall-full']) {
        await rec.step(id, () => notApplicable('not implemented yet'));
    }
}

module.exports = { runLifecycle };
