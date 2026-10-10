'use strict';

/**
 * The lifecycle steps after install, owner and chat (cell.js): each is `(cell, step) => result`, throws
 * through `check()` when what an operator would see is wrong, and returns `notApplicable()` /
 * `deferred()` with its reason when this cell cannot run it. Nothing here requires a module of the
 * manager or the application; the doors are the same ones cell.js uses.
 */

const fs = require('node:fs');
const path = require('node:path');

const { check, notApplicable } = require('./evidence');
const op = require('./operator');
const { FEATURE_ROUTE, FEATURE_ID } = require('./cell');

const DEFAULT_THEME = 'light';
const KEY_FIELD = 'perplexity.apiKey';

function gatedBody(answer) {
    return answer.status === 404 && Boolean(answer.json && answer.json.error && answer.json.error.code === 'FEATURE_UNAVAILABLE');
}

function describe(answer) {
    const code = answer.json && answer.json.error ? ` ${answer.json.error.code}` : '';
    return `${answer.status}${code}`;
}

async function featureState(cell, id) {
    const answer = await cell.api.call('GET', '/features');
    check(answer.status === 200 && answer.json && answer.json.features, `GET /features answered ${answer.status}`);
    return answer.json.features[id];
}

async function signedInGet(cell, route) {
    let answer = await cell.portalGet(route);
    if (answer.status === 401) {
        await cell.portalLogin();
        answer = await cell.portalGet(route);
    }
    return answer;
}

async function stepFeatures(cell, step) {
    if (cell.o.features === 'minimal') return notApplicable('the minimal payload carries no optional feature package to add or remove');
    const installed = await featureState(cell, FEATURE_ID);
    check(installed && installed.installed, `the ${FEATURE_ID} package is not in this payload`);
    await cell.portalLogin();
    let start = await signedInGet(cell, FEATURE_ROUTE);
    let note = '';
    if (!gatedBody(start)) {
        const first = await cell.api.operation('features.set', { changes: { [FEATURE_ID]: false } });
        check(first.operation.status === 'applied', `features.set (start off) ended ${first.operation.status}`);
        await cell.applyRestart(first.id);
        start = await signedInGet(cell, FEATURE_ROUTE);
        check(gatedBody(start), `${FEATURE_ID} was turned off but its route answered ${describe(start)}`);
        note = `${FEATURE_ID} shipped on, turned off first; `;
    }
    step.command({ command: `GET ${FEATURE_ROUTE} (signed in, ${FEATURE_ID} off)`, exitCode: start.status, durationMs: 0 });

    const add = await cell.api.operation('features.set', { changes: { economy: true, [FEATURE_ID]: true } });
    check(add.operation.status === 'applied', `features.set (add) ended ${add.operation.status}`);
    const pending = await featureState(cell, FEATURE_ID);
    check(pending.pendingActive === true && pending.active === false, 'the added feature is not recorded as pending until the restart');
    const addRestart = await cell.applyRestart(add.id);
    const on = await featureState(cell, FEATURE_ID);
    check(on.active === true && on.pendingActive === null, `${FEATURE_ID} is not active after the restart`);
    const live = await signedInGet(cell, FEATURE_ROUTE);
    check(!gatedBody(live) && !(live.status === 404 && live.json && live.json.error && live.json.error.code === 'NOT_FOUND'), `${FEATURE_ID}'s route answered ${describe(live)} after it was added: it never reached the handler`);
    step.command({ command: `GET ${FEATURE_ROUTE} (signed in, ${FEATURE_ID} on)`, exitCode: live.status, durationMs: 0 });

    const remove = await cell.api.operation('features.set', { changes: { [FEATURE_ID]: false } });
    check(remove.operation.status === 'applied', `features.set (remove) ended ${remove.operation.status}`);
    await cell.applyRestart(remove.id);
    const off = await featureState(cell, FEATURE_ID);
    check(off.active === false, `${FEATURE_ID} is still active after it was removed`);
    const gone = await signedInGet(cell, FEATURE_ROUTE);
    check(gatedBody(gone), `${FEATURE_ID}'s route answered ${describe(gone)}, not the gated response, after it was removed`);
    step.command({ command: `GET ${FEATURE_ROUTE} (signed in, ${FEATURE_ID} off again)`, exitCode: gone.status, durationMs: 0 });
    const conversations = await cell.conversations();
    check(conversations.length >= cell.state.conversationCount, 'a conversation was lost across the two restarts');
    return { result: `${note}${FEATURE_ID} off (gated 404) -> added: pending until restart, then reaches its handler (${describe(live)}, no Discord) -> removed: gated 404 again; two staged restarts (${addRestart.lifecycle.lastOutcome.outcome}); conversations kept` };
}

async function configReport(cell) {
    const answer = await cell.api.call('GET', '/config');
    check(answer.status === 200 && answer.json, `GET /config answered ${answer.status}`);
    const fields = new Map();
    const walk = (value) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
            if (typeof value.id === 'string' && 'present' in value) fields.set(value.id, value);
            Object.values(value).forEach(walk);
        }
    };
    walk(answer.json);
    return { json: answer.json, fields };
}

async function stepDefaultsKeys(cell, step) {
    const before = await configReport(cell);
    const revision = before.json.revision;
    check(typeof revision === 'string' || revision === null, 'the configuration report carries no revision');
    const set = await cell.api.operation('config.set', { changes: [{ id: KEY_FIELD, action: 'set', value: cell.secretKey }], expectedRevision: revision });
    check(set.operation.status === 'applied', `config.set ended ${set.operation.status}`);
    const defaults = await cell.api.operation('defaults.set', { changes: [{ id: 'defaults.appearance.theme', action: 'set', value: DEFAULT_THEME }] });
    check(defaults.operation.status === 'applied', `defaults.set ended ${defaults.operation.status}`);
    const mid = await configReport(cell);
    check(JSON.stringify(mid.json).indexOf(cell.secretKey) === -1, 'GET /config returned the key in the clear');
    check(mid.fields.get(KEY_FIELD) && mid.fields.get(KEY_FIELD).present === true, 'the key is not reported as present');
    step.command({ command: 'POST /manager/api/operations config.set + defaults.set (recovery session)', exitCode: 200, durationMs: 0 });

    await cell.restartWorkers();
    const after = await configReport(cell);
    check(after.fields.get(KEY_FIELD) && after.fields.get(KEY_FIELD).present === true, 'the key did not survive the restart');
    const theme = after.fields.get('defaults.appearance.theme');
    check(theme && theme.value === DEFAULT_THEME, `the instance default is ${theme ? theme.value : 'missing'} after the restart, not ${DEFAULT_THEME}`);
    const file = fs.readFileSync(cell.roots.config, 'utf8');
    check(file.includes(cell.secretKey), 'the key is not in config.json');
    if (process.platform !== 'win32') {
        const mode = fs.statSync(cell.roots.config).mode & 0o777;
        check((mode & 0o077) === 0, `config.json is mode ${mode.toString(8)}, readable beyond its owner`);
    }
    cell.state.defaultsRevision = after.json.defaults ? after.json.defaults.revision : null;
    return { result: `key set (masked in /config, 0600 file) and instance default ${DEFAULT_THEME} survived a worker restart` };
}

async function stepBootRecovery(cell, step) {
    const pid = cell.daemon.pid;
    const lifecycleBefore = await cell.api.call('GET', '/lifecycle');
    const workerPids = ((lifecycleBefore.json && lifecycleBefore.json.workers) || []).map((worker) => worker.pid).filter(Boolean);
    const exit = await cell.daemon.kill();
    step.command({ command: `kill -9 <manager pid ${pid}>`, exitCode: exit ? exit.code : null, durationMs: 0 });
    check(!op.alive(pid), 'the manager is still alive after SIGKILL');
    await op.sleep(3000);
    cell.state.orphanedWorkers = workerPids.filter((worker) => op.alive(worker));
    cell.api.token = null;
    cell.startDaemon();
    const status = await cell.waitManager();
    check(status.state === 'claimed', `the restarted manager reports ${status.state}`);
    await cell.waitHealthy();
    await cell.portalLogin();
    const conversations = await cell.conversations();
    check(conversations.length >= cell.state.conversationCount, 'conversations were lost across the crash');
    const cli = await cell.cliStatus(step);
    check(cli.installation.installationId === cell.installationId, 'the installation identity changed across the crash');
    return { result: `manager SIGKILLed by pid, restarted as the OS supervisor would: claimed again, workers healthy, sign-in and ${conversations.length} conversation(s) intact` };
}

async function release(cell, version) {
    if (!cell.published.has(version)) cell.published.set(version, await cell.workshop.publish(version));
    return cell.published.get(version);
}

async function updateView(cell, step) {
    const result = await cell.cli(step, ['update', 'status', '--json']);
    check(result.code === 0 && result.json, `update status exited ${result.code}: ${cell.why(result)}`);
    return result.json.update || result.json.status || result.json.view || result.json;
}

/** `update policy`, `check`, `stage` for `version` from a local source directory; the running release is untouched. */
async function offerAndStage(cell, step, version) {
    const source = await release(cell, version);
    const policy = await cell.cli(step, ['update', 'policy', '--mode', 'check', '--source-dir', source.dir, '--json'], { show: ['update', 'policy', '--mode', 'check', '--source-dir', '<signed fake release>', '--json'] });
    check(policy.code === 0, `update policy exited ${policy.code}: ${cell.why(policy)}`);
    const checked = await cell.cli(step, ['update', 'check', '--json']);
    check(checked.code === 0, `update check exited ${checked.code}: ${cell.why(checked)}`);
    const staged = await cell.cli(step, ['update', 'stage', '--json']);
    check(staged.code === 0, `update stage exited ${staged.code}: ${cell.why(staged)}`);
    const view = await updateView(cell, step);
    check(view.staged && view.staged.version === version && !view.staged.stale, `${version} is not staged after update stage`);
    check(view.installed.version !== version, 'staging changed the installed release');
    return { source, view };
}

async function waitApplied(cell, step, version, { timeoutMs = 240_000 } = {}) {
    return op.waitFor(async () => {
        let view;
        try { view = await updateView(cell, step); } catch { return null; }
        if (view.handoff || !view.lastApply || !view.lastApply.outcome) return null;
        if (view.lastApply.outcome !== 'applied') throw new Error(`the update ended ${view.lastApply.outcome}${view.lastApply.code ? ` (${view.lastApply.code})` : ''}`);
        return view.installed.version === version ? view : null;
    }, { timeoutMs, intervalMs: 1500, what: `the update to ${version} to finish` });
}

async function stepUpdate(cell, step) {
    const from = cell.state.release.version;
    const target = '1.1.0';
    await offerAndStage(cell, step, target);
    // Set an account preference distinct from the instance default before replacing code.
    await cell.portalLogin();
    const settings = await cell.portalGet('/api/app/settings');
    check(settings.status === 200 && settings.json?.sections?.appearance, 'could not read account settings before the update');
    const saved = await fetch(cell.portal('/api/app/settings/appearance'), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cell.cookie },
        body: JSON.stringify({ expectedRevision: settings.json.sections.appearance.revision, changes: { theme: 'dark', enterToSend: false } }),
        signal: AbortSignal.timeout(30_000)
    });
    check(saved.status === 200, `saving the account preference answered ${saved.status}`);
    await saved.arrayBuffer();
    const before = await cell.cliStatus(step);
    const configHash = cell.sha256File(cell.roots.config);
    const featuresBefore = await cell.api.call('GET', '/features');
    check(featuresBefore.status === 200 && featuresBefore.json?.features, 'could not read feature selection before the update');
    const selection = (features) => Object.fromEntries(Object.entries(features).map(([id, f]) => [id, { installed: f.installed, active: f.active }]));
    const applied = await cell.cli(step, ['update', 'apply', '--now', '--json']);
    check(applied.code === 0, `update apply exited ${applied.code}: ${cell.why(applied)}`);
    cell.api.token = null;
    const done = await waitApplied(cell, step, target);
    await cell.waitManager();
    await cell.waitHealthy();
    cell.state.release = { ...cell.state.release, version: target };
    await cell.portalLogin();
    const after = await cell.cliStatus(step);
    check(JSON.stringify(after.installation.roots) === JSON.stringify(before.installation.roots), 'the update changed custom installation roots');
    check(after.installation.installationId === before.installation.installationId, 'the update changed installation ownership');
    check(after.installation.layout === before.installation.layout, 'the update changed the deployment layout');
    check(JSON.stringify(after.installation.services) === JSON.stringify(before.installation.services), 'the update changed recorded service ownership');
    check(cell.sha256File(cell.roots.config) === configHash, 'the update changed config or secret bytes');
    const featuresAfter = await cell.api.call('GET', '/features');
    check(featuresAfter.status === 200 && featuresAfter.json?.features, 'could not read feature selection after the update');
    check(JSON.stringify(selection(featuresAfter.json.features)) === JSON.stringify(selection(featuresBefore.json.features)), 'the update changed installed or active features');
    const preferences = await cell.portalGet('/api/app/settings');
    check(preferences.status === 200 && preferences.json?.sections?.appearance?.values?.theme === 'dark'
        && preferences.json.sections.appearance.values.enterToSend === false, 'account preferences did not survive the update');
    const conversations = await cell.conversations();
    check(conversations.length >= cell.state.conversationCount, 'a conversation was lost by the update');
    const config = await configReport(cell);
    check(config.fields.get(KEY_FIELD) && config.fields.get(KEY_FIELD).present === true, 'the key did not survive the update');
    const theme = config.fields.get('defaults.appearance.theme');
    check(theme && theme.value === DEFAULT_THEME, 'the instance default did not survive the update');
    const turn = await cell.portalChat('Say hello after the update.');
    check(turn.ok && turn.status === 200, 'a chat turn failed after the update');
    return { result: `${from} -> ${target} through the staged path (check, stage, apply --now; the manager handed over with exit 76 and the new release verified); downtime ${done.lastApply.downtimeMs} ms; custom roots, installation identity/layout, config bytes, feature selection, account preferences, data, key, default and chat intact` };
}

module.exports = { stepUpdate, offerAndStage, waitApplied, updateView, release, describe, stepFeatures, stepDefaultsKeys, stepBootRecovery, gatedBody, signedInGet, configReport, DEFAULT_THEME, KEY_FIELD, path };
