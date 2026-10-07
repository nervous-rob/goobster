'use strict';

const steps = require('./steps');
const data = require('./dataSteps');
const inject = require('./injections');

/** The lifecycle, in order. A step that needs an earlier one is not run when that one failed. */
async function runLifecycle(cell) {
    const rec = cell.rec;
    await rec.step('install', (step) => cell.stepInstall(step));
    await rec.step('owner', (step) => cell.stepOwner(step), { needs: ['install'] });
    await rec.step('chat', (step) => cell.stepChat(step), { needs: ['install', 'owner'] });
    const needs = { needs: ['install', 'owner'] };
    const live = (fn) => async (step) => {
        await cell.ensureRunning();
        return fn(cell, step);
    };
    const check = (id, fn) => rec.injection(id, live(fn), needs);
    await check('unauthenticated-manager', inject.unauthenticatedManager);
    await check('recovery-not-remote', inject.recoveryNotRemote);
    await check('stale-setup-token', inject.staleSetupToken);
    await check('lost-manager-store', inject.lostManagerStore);
    await check('port-in-use', inject.portInUse);
    await check('storage-refusal', inject.storageRefusal);
    await rec.step('features', live(steps.stepFeatures), needs);
    await check('disabled-feature-route', inject.disabledFeatureRoute);
    await rec.step('defaults-keys', live(steps.stepDefaultsKeys), needs);
    await rec.step('boot-recovery', live(steps.stepBootRecovery), needs);
    await rec.step('update', live(steps.stepUpdate), needs);
    await check('update-interrupted', inject.updateInterrupted);
    await rec.step('repair', live(data.stepRepair), needs);
    await rec.step('backup-restore', live(data.stepBackupRestore), needs);
    await check('restore-interrupted', inject.restoreInterrupted);
    await rec.step('migrate', live(data.stepMigrate), needs);
    await rec.step('reset', live(data.stepReset), needs);
    await rec.step('uninstall-keep', live(data.stepUninstallKeep), needs);
    await rec.step('uninstall-full', live(data.stepUninstallFull), needs);
}

module.exports = { runLifecycle };
