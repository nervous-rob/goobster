/**
 * Updater ownership. An instance has exactly one updater: the manager, or
 * (when the operator keeps it) `scripts/auto-update.sh` or PM2. Adopting an
 * instance for the manager must not leave a second one running:
 *
 * - a user cron line that runs auto-update.sh for this directory is
 *   commented out (`#goobster-manager-disabled: <line>`, reversible by
 *   removing the prefix);
 * - a systemd timer or a system cron file needs root: that is the
 *   `updater.disable` privileged operation (answers 501 until the
 *   bootstrappers implement it). Until then the guard in auto-update.sh -
 *   it exits when the manager store says `updater.kind` is `manager` - keeps
 *   the second updater from acting, but only when the script carries that
 *   guard; an older script without it is `UPDATER_CONFLICT`;
 * - a PM2 app with `watch` is `UPDATER_CONFLICT`: the manager does not edit
 *   PM2's process list.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');
const privileged = require('../privileged');

const GUARD_MARKER = 'goobster-manager-guard';
const DISABLED_PREFIX = '#goobster-manager-disabled: ';

function scriptHasGuard(codeRoot, fs = nodeFs) {
    try {
        return fs.readFileSync(path.join(codeRoot, 'scripts', 'auto-update.sh'), 'utf8').includes(GUARD_MARKER);
    } catch {
        return false;
    }
}

function defaultReadCrontab() {
    try {
        return childProcess.execFileSync('crontab', ['-l'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
}

function defaultWriteCrontab(text) {
    childProcess.execFileSync('crontab', ['-'], { input: text, timeout: 4000, stdio: ['pipe', 'ignore', 'ignore'] });
}

/**
 * What adopting would have to do about each updater that could also touch
 * `codeRoot`. Pure: no change.
 * @returns {{ items: Array<{ mechanism: string, unit: string|null, action: 'comment-cron-line'|'privileged:updater.disable'|'unsupported', guarded: boolean }>, conflicts: string[] }}
 */
function analyse({ updaters, codeRoot, fs = nodeFs, keep = false }) {
    if (keep) return { items: [], conflicts: [] };
    const guarded = scriptHasGuard(codeRoot, fs);
    const items = [];
    const conflicts = [];
    for (const entry of updaters || []) {
        if (entry.mechanism === 'cron') {
            items.push({ mechanism: 'cron', unit: null, action: 'comment-cron-line', guarded });
        } else if (entry.mechanism === 'systemd-timer') {
            items.push({ mechanism: 'systemd-timer', unit: entry.unit || null, action: 'privileged:updater.disable', guarded });
            if (!guarded) conflicts.push('systemd-timer');
        } else {
            items.push({ mechanism: entry.mechanism, unit: entry.unit || null, action: 'unsupported', guarded });
            conflicts.push(entry.mechanism);
        }
    }
    return { items, conflicts };
}

/**
 * Carry out `analyse()`'s items. Returns one outcome per item; throws
 * UPDATER_CONFLICT for an item that cannot be reconciled and is not guarded.
 */
function reconcile({ items, codeRoot, readCrontab = defaultReadCrontab, writeCrontab = defaultWriteCrontab }) {
    const outcomes = [];
    for (const item of items) {
        if (item.action === 'comment-cron-line') {
            const text = readCrontab();
            let changed = 0;
            if (text) {
                const lines = text.split('\n').map((line) => {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('auto-update.sh') && trimmed.includes(codeRoot)) {
                        changed++;
                        return `${DISABLED_PREFIX}${line}`;
                    }
                    return line;
                });
                if (changed > 0) writeCrontab(lines.join('\n'));
            }
            outcomes.push({ mechanism: 'cron', status: changed > 0 ? 'disabled' : 'already', lines: changed });
        } else if (item.action === 'privileged:updater.disable') {
            try {
                privileged.request('updater.disable');
                outcomes.push({ mechanism: item.mechanism, status: 'disabled' });
            } catch (error) {
                if (!(error instanceof ManagerError) || error.status !== 501) throw error;
                if (!item.guarded) {
                    throw new ManagerError(409, 'UPDATER_CONFLICT', 'An auto-update timer would also update this installation, and it cannot be disabled without the privileged helper.');
                }
                outcomes.push({ mechanism: item.mechanism, status: 'deferred', privileged: 'updater.disable', code: 'NOT_IMPLEMENTED', guard: true });
            }
        } else {
            throw new ManagerError(409, 'UPDATER_CONFLICT', 'Another updater would also update this installation and the manager cannot disable it; turn it off, or adopt with the updater kept.');
        }
    }
    return outcomes;
}

module.exports = { analyse, reconcile, scriptHasGuard, GUARD_MARKER, DISABLED_PREFIX };
