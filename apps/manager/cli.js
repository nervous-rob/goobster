#!/usr/bin/env node
/**
 * The headless CLI over the setup engine (documentation/manager_install.md):
 *
 *   goobster-manager install|adopt|reconfigure|repair|uninstall [options]
 *   goobster-manager plan <command> [options]      same as --dry-run
 *   goobster-manager reset --scope instance|feature [--feature <id>] [--dry-run] [--confirm <text>]
 *                                                 empty the installation's data (documentation/data_reset.md)
 *   goobster-manager release [--force] [--acknowledge-mutation]
 *                                                 lift a maintenance barrier a reset left up
 *   goobster-manager status | discover | schema
 *
 *   --answers <file>   the operation's input as JSON (apps/manager/install/answers.schema.json);
 *                      the file may hold secrets and must be mode 0600
 *   --dry-run          plan and run preflight; write nothing, not even an operation record
 *   --yes              answer "yes" to the non-destructive confirmation (never to a deletion)
 *   --delete-data --confirm <installationId>   uninstall: also remove the owned data roots
 *   --json             one JSON document on stdout instead of text
 *
 * Without --answers the CLI asks the questions it needs on stdin (secret
 * values are read without echo). A secret is never accepted on the command
 * line. Progress goes to stderr, redacted; the result to stdout.
 *
 * It runs the same kinds through the same engine, in this process, with
 * `via: 'local'`: whoever can write the manager store can do this, which is
 * the guarantee the recovery credential gives the portal.
 *
 * Exit codes: 0 ok, 2 invalid input or a preflight block, 3 refused (lock,
 * tampered ownership, conflict, wrong state), 4 interrupted (run it again to
 * resume), 5 applied but a step needs the privileged helper, 1 unexpected.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { ManagerError } = require('./errors');
const { resolveSettings } = require('./settings');
const { createManager } = require('./manager');
const { createStore } = require('./store/installation');
const { createJournal } = require('./store/journal');
const { existingInstallEvidence } = require('./appDatabase');
const { scrub, SECRET_KEY, MARK } = require('./engine/redact');
const { validate: validateSchema } = require('./install/schema');
const { readTombstone } = require('./install/tombstone');
const { discover } = require('./install/discover');
const { lazy } = require('./lazy');

const fieldCatalog = lazy('@goobster/core/config/fieldCatalog');

const EXIT = Object.freeze({ OK: 0, UNEXPECTED: 1, INVALID: 2, REFUSED: 3, INTERRUPTED: 4, PRIVILEGE: 5 });
const KIND_OF = Object.freeze({ install: 'install.new', adopt: 'adopt', reconfigure: 'install.reconfigure', repair: 'install.repair', uninstall: 'install.uninstall' });
const COMMANDS = Object.freeze([...Object.keys(KIND_OF), 'reset', 'release', 'plan', 'status', 'discover', 'schema', 'help']);
const LOCAL_AUTH = Object.freeze({ principal: 'local:cli', via: 'local' });
const MAX_ANSWERS_BYTES = 256 * 1024;
const SCHEMA_FILE = path.join(__dirname, 'install', 'answers.schema.json');

const INVALID_CODES = new Set([
    'INVALID_INPUT', 'INVALID_VALUE', 'MASK_IS_NOT_A_VALUE', 'PREFLIGHT_FAILED', 'CONFIRMATION_REQUIRED', 'UNKNOWN_FEATURE', 'SOURCE_MISSING',
    'PUBLIC_KEY_UNREADABLE', 'ROOT_NOT_MOVABLE', 'REPAIR_SOURCE_REQUIRED', 'NOT_AN_INSTALLATION', 'CANDIDATE_NOT_FOUND', 'RELEASE_MISMATCH',
    'MANIFEST_MISSING', 'MANIFEST_INVALID', 'SIGNATURE_MISSING', 'SIGNATURE_INVALID', 'UNSIGNED_DEV_ONLY', 'PATH_TRAVERSAL', 'LINK_ESCAPES_ROOT',
    'TARGET_MISMATCH', 'ABI_MISMATCH', 'INCOMPLETE', 'EXTRA_FILE', 'VERSION_INCOMPATIBLE', 'SELECTION_UNAVAILABLE', 'NOTHING_TO_ADOPT',
    'ANSWERS_INVALID', 'ANSWERS_PERMISSIONS', 'ANSWERS_UNREADABLE', 'SECRET_ON_ARGV', 'USAGE', 'INPUT_ENDED',
    'BACKUP_REQUIRED', 'PASSPHRASE_REQUIRED', 'CORE_NOT_PURGEABLE'
]);
const REFUSED_CODES = new Set([
    'OPERATION_IN_PROGRESS', 'OWNERSHIP_TAMPERED', 'UNKNOWN_SERVICE_OWNER', 'UPDATER_CONFLICT', 'STATE_NOT_ALLOWED', 'ALREADY_INSTALLED',
    'EXISTING_INSTALLATION', 'NOT_INSTALLED', 'NOT_MANAGED', 'PATH_ESCAPE', 'WORKERS_RUNNING', 'REVISION_CONFLICT', 'STORE_UNUSABLE',
    'ADOPT_NEEDS_CONFIRMATION', 'CONFIG_UNREADABLE', 'PLAN_EXPIRED',
    'MAINTENANCE_NOT_HELD', 'MAINTENANCE_ACTIVE', 'STALE_MAINTENANCE', 'RESTART_PENDING', 'WRITER_UNACKNOWLEDGED', 'WRITER_UNFENCEABLE',
    'FOREIGN_TARGET', 'FEATURE_ACTIVE', 'BACKUP_UNVERIFIED', 'BACKUP_FAILED', 'BACKUP_DESTINATION_UNSAFE', 'FILE_SET_UNSAFE',
    'INSTANCE_RESET_REQUIRES_LOCAL', 'MUTATION_NOT_COMPLETE', 'FENCE_MISMATCH', 'MAINTENANCE_NOT_ACTIVE'
]);

class CliError extends Error {
    constructor(code, message, exit = EXIT.INVALID) {
        super(message);
        this.name = 'CliError';
        this.code = code;
        this.exit = exit;
    }
}

// ---------------------------------------------------------------- arguments
const VALUE_FLAGS = new Map([['--answers', 'answers'], ['--confirm', 'confirm'], ['--scope', 'scope'], ['--feature', 'feature'], ['--backup-dir', 'backupDir']]);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--yes', '-y', '--delete-data', '--json', '--help', '-h', '--force', '--acknowledge-mutation']);

function parseArgs(argv) {
    const flags = {
        answers: null, dryRun: false, yes: false, deleteData: false, confirm: null, json: false, help: false,
        scope: null, feature: null, backupDir: null, force: false, acknowledgeMutation: false
    };
    const positional = [];
    for (let index = 0; index < argv.length; index++) {
        const arg = String(argv[index]);
        if (!arg.startsWith('-')) {
            positional.push(arg);
            continue;
        }
        const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
        if (SECRET_KEY.test(name)) {
            throw new CliError('SECRET_ON_ARGV', `${name} is not accepted: a secret on the command line is visible to other users and in shell history. Put it in an answers file (mode 0600, --answers) or enter it at the prompt.`);
        }
        if (VALUE_FLAGS.has(name)) {
            const value = inline !== undefined ? inline : argv[++index];
            if (value === undefined || String(value).startsWith('--')) throw new CliError('USAGE', `${name} needs a value.`);
            flags[VALUE_FLAGS.get(name)] = String(value);
        } else if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
            if (name === '--dry-run') flags.dryRun = true;
            else if (name === '--yes' || name === '-y') flags.yes = true;
            else if (name === '--delete-data') flags.deleteData = true;
            else if (name === '--json') flags.json = true;
            else if (name === '--force') flags.force = true;
            else if (name === '--acknowledge-mutation') flags.acknowledgeMutation = true;
            else flags.help = true;
        } else {
            throw new CliError('USAGE', `Unknown option ${name}. Try "help".`);
        }
    }
    let command = positional.shift() || 'help';
    if (command === 'plan') {
        flags.dryRun = true;
        command = positional.shift() || '';
        if (!KIND_OF[command] && command !== 'reset') throw new CliError('USAGE', 'plan needs a command: install, adopt, reconfigure, repair, uninstall or reset.');
    }
    if (!COMMANDS.includes(command)) throw new CliError('USAGE', `Unknown command "${command}". Try "help".`);
    if (positional.length) throw new CliError('USAGE', 'Unexpected argument; values go in --answers or at the prompt.');
    if (flags.confirm && !flags.deleteData && command !== 'reset') throw new CliError('USAGE', '--confirm belongs to --delete-data or reset.');
    if ((flags.scope || flags.feature || flags.backupDir) && command !== 'reset') throw new CliError('USAGE', '--scope, --feature and --backup-dir belong to reset.');
    if ((flags.force || flags.acknowledgeMutation) && command !== 'release') throw new CliError('USAGE', '--force and --acknowledge-mutation belong to release.');
    if (flags.deleteData && command !== 'uninstall') throw new CliError('USAGE', '--delete-data only applies to uninstall.');
    return { command, flags };
}

// ------------------------------------------------------------ answers file
function loadAnswers(file, fs) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch {
        throw new CliError('ANSWERS_UNREADABLE', 'The answers file does not exist or cannot be read.');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new CliError('ANSWERS_UNREADABLE', 'The answers path must be a regular file, not a link or directory.');
    if (process.platform !== 'win32') {
        if ((stat.mode & 0o077) !== 0) {
            throw new CliError('ANSWERS_PERMISSIONS', `The answers file may hold secrets and must be readable by its owner only (chmod 600); it is mode ${(stat.mode & 0o777).toString(8)}.`);
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new CliError('ANSWERS_PERMISSIONS', 'The answers file belongs to another user.');
        }
    }
    if (stat.size > MAX_ANSWERS_BYTES) throw new CliError('ANSWERS_INVALID', 'The answers file is too large.');
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new CliError('ANSWERS_INVALID', 'The answers file is not valid JSON.');
    }
    return doc;
}

function shipSchema(fs) {
    return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

/** The kind's input from a validated answers document; `command` and `$schema` are metadata. */
function answersInput(doc, command, fs) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new CliError('ANSWERS_INVALID', 'The answers file must hold one JSON object.');
    if (doc.command !== undefined && doc.command !== command) throw new CliError('ANSWERS_INVALID', `The answers file is for "${String(doc.command).slice(0, 20)}", not "${command}".`);
    const problems = validateSchema(shipSchema(fs), doc, { definition: command });
    if (problems.length) {
        const listed = problems.slice(0, 8).map(item => `${item.pointer || '/'} (${item.rule})`).join(', ');
        throw new CliError('ANSWERS_INVALID', `The answers file does not match the schema: ${listed}${problems.length > 8 ? ', ...' : ''}.`);
    }
    const input = { ...doc };
    delete input.command;
    delete input.$schema;
    return input;
}

/** Every secret value an input will carry, so output can be scrubbed of them verbatim. */
function secretsIn(input) {
    const out = [];
    if (!input || !Array.isArray(input.config)) return out;
    for (const change of input.config) {
        let secret = SECRET_KEY.test(String(change && change.id));
        try {
            const field = change && typeof change.id === 'string' ? fieldCatalog.get(change.id) : null;
            secret = secret || Boolean(field && field.type === 'secret');
        } catch { }
        if (secret && typeof change.value === 'string' && change.value.length >= 4) out.push(change.value);
    }
    return out;
}

// ------------------------------------------------------------------ prompts
function createPrompter({ input, output }) {
    let muted = false;
    const sink = new Writable({
        write(chunk, _encoding, done) {
            if (!muted) output.write(chunk);
            done();
        }
    });
    const rl = readline.createInterface({ input, output: sink, terminal: false });
    const lines = [];
    const waiting = [];
    let ended = false;
    rl.on('line', (line) => {
        if (waiting.length) waiting.shift()(line);
        else lines.push(line);
    });
    rl.on('close', () => {
        ended = true;
        while (waiting.length) waiting.shift()(null);
    });
    return {
        async ask(question, { hidden = false, fallback = '' } = {}) {
            output.write(question);
            muted = hidden;
            const line = lines.length ? lines.shift() : (ended ? null : await new Promise(resolve => waiting.push(resolve)));
            muted = false;
            if (hidden) output.write('\n');
            if (line === null) throw new CliError('INPUT_ENDED', 'The input ended before every question was answered.');
            const answer = line.trim();
            return answer === '' ? fallback : answer;
        },
        close() {
            rl.close();
        }
    };
}

const yes = (answer) => /^(y|yes)$/i.test(String(answer).trim());

async function promptInstall(prompter) {
    const input = { source: await prompter.ask('Release source (a verified payload directory): ') };
    const label = await prompter.ask('Owner label [Goobster]: ', { fallback: 'Goobster' });
    input.ownerLabel = label;
    input.layout = await prompter.ask('Layout (lite, standalone) [lite]: ', { fallback: 'lite' });
    const features = await prompter.ask('Features (comma separated; blank = everything the source carries): ');
    if (features) input.features = features.split(',').map(item => item.trim()).filter(Boolean);
    if (yes(await prompter.ask('Accept an unsigned (development) payload? [y/N]: '))) input.release = { allowUnsigned: true };
    const config = [];
    for (;;) {
        const id = await prompter.ask('Setting to write to config.json (field id, blank to finish): ');
        if (!id) break;
        let secret = SECRET_KEY.test(id);
        try {
            const field = fieldCatalog.get(id);
            secret = secret || Boolean(field && field.type === 'secret');
        } catch { }
        const value = await prompter.ask(`Value for ${id}${secret ? ' (hidden)' : ''}: `, { hidden: secret });
        config.push({ id, value });
    }
    if (config.length) input.config = config;
    return input;
}

async function promptAdopt(prompter, candidates, output) {
    if (!candidates.length) throw new CliError('NOT_AN_INSTALLATION', 'Discovery found no existing installation on this host.');
    candidates.forEach((item, index) => output.write(`  ${index + 1}. ${item.kind} at ${item.roots.code} (${item.layout}, ${item.dbEngine}; id ${item.id})\n`));
    const pick = Number(await prompter.ask('Adopt which one? [1]: ', { fallback: '1' }));
    const chosen = candidates[pick - 1];
    if (!chosen) throw new CliError('INVALID_INPUT', 'That is not one of the listed installations.');
    const label = await prompter.ask('Owner label [Goobster]: ', { fallback: 'Goobster' });
    const input = { label, candidateId: chosen.id };
    if (chosen.updaters.length && yes(await prompter.ask('Keep the existing auto-update running (the manager then does not update it)? [y/N]: '))) input.keepUpdater = true;
    return input;
}

async function promptSimple(prompter, command) {
    if (command === 'repair') {
        const source = await prompter.ask('Payload source to repair from (blank = use what is installed): ');
        return source ? { source } : {};
    }
    if (command === 'reconfigure') {
        const input = {};
        const layout = await prompter.ask('New layout (blank = keep): ');
        if (layout) input.layout = layout;
        const code = await prompter.ask('New code root (blank = keep): ');
        if (code) input.roots = { code };
        return input;
    }
    return {};
}

// ------------------------------------------------------------------- output
function describePlan(plan, kind, { dryRun }) {
    const lines = [`${kind}${dryRun ? ' (dry run: nothing is written)' : ''}`];
    const target = plan.target;
    if (target) {
        lines.push(`  layout     ${target.layout}`);
        if (target.roots) lines.push(`  roots      ${Object.entries(target.roots).map(([role, value]) => `${role}=${value}`).join('  ')}`);
        if (target.release) lines.push(`  release    ${target.release.releaseId} ${target.release.version} (${(target.release.features || []).join(', ')})`);
        if (target.database) lines.push(`  database   ${target.database.engine}${target.database.external ? ' (external; never deleted)' : ''}`);
        if (target.candidateId) lines.push(`  instance   ${target.kind} ${target.candidateId}`);
    }
    if (plan.installationId) lines.push(`  instance   ${plan.installationId}`);
    if (plan.noop) lines.push('  nothing to change');
    if (plan.resumeOf) lines.push(`  resumes    operation ${plan.resumeOf.operationId} from ${plan.resumeOf.resumeFrom || 'the end'}`);
    if (plan.steps) lines.push(`  steps      ${plan.steps.map(step => step.name + (step.privileged ? `*` : '')).join(' > ')}`);
    lines.push(`  downloads  ${(plan.downloads || []).length ? plan.downloads.length : 'none'}`);
    if (plan.services) lines.push(`  services   ${plan.services.length ? plan.services.map(item => `${item.action} ${item.kind} ${item.name}${item.privileged ? ` (needs ${item.privileged})` : ''}`).join('; ') : 'none'}`);
    if (plan.updaterReconcile && plan.updaterReconcile.length) lines.push(`  updaters   ${plan.updaterReconcile.map(item => `${item.mechanism}: ${item.action}`).join('; ')}`);
    if (plan.retainedData) lines.push(`  retained   ${(plan.retainedData.roots || []).length ? plan.retainedData.roots.join(', ') : 'nothing'}`);
    if (plan.removes) lines.push(`  removes    ${plan.removes.length ? plan.removes.map(item => `${item.role}: ${item.path}`).join('; ') : 'nothing'}`);
    if (plan.database && plan.database.action) lines.push(`  database   ${plan.database.action}`);
    if (plan.confirmation && plan.confirmation.required) lines.push(`  confirm    ${plan.confirmation.satisfied ? 'given' : `required: --delete-data --confirm ${plan.installationId}`}`);
    if (plan.tombstone) lines.push('  tombstone  written, so the host is not reopened to a remote first claim');
    if (plan.privilegedSteps && plan.privilegedSteps.length) lines.push(`  privileged ${plan.privilegedSteps.map(item => `${item.step} -> ${item.operation} (${item.status}: not implemented in this version)`).join('; ')}`);
    if (plan.preflight) {
        const blocks = plan.preflight.findings.filter(item => item.severity === 'block');
        const warns = plan.preflight.findings.filter(item => item.severity === 'warn');
        lines.push(`  preflight  ${plan.preflight.ok ? 'ok' : `BLOCKED (${blocks.length})`}${warns.length ? `, ${warns.length} warning${warns.length === 1 ? '' : 's'}` : ''}`);
        for (const finding of plan.preflight.findings) lines.push(`    ${finding.severity === 'block' ? 'block' : 'warn '} ${finding.code}: ${finding.detail}`);
    }
    return lines;
}

function exitFor(error) {
    if (error instanceof CliError) return error.exit;
    const code = error && error.code;
    if (INVALID_CODES.has(code)) return EXIT.INVALID;
    if (REFUSED_CODES.has(code)) return EXIT.REFUSED;
    if (error && error.operation) return EXIT.INTERRUPTED;
    if (error instanceof ManagerError && error.status >= 400 && error.status < 500) return EXIT.INVALID;
    return EXIT.UNEXPECTED;
}

// --------------------------------------------------------------------- main
function overlayRoots(env, roots) {
    const out = { ...env };
    if (!roots) return out;
    if (roots.code) out.GOOBSTER_WORKSPACE_ROOT = roots.code;
    if (roots.data) out.GOOBSTER_DATA_DIR = roots.data;
    if (roots.config) out.GOOBSTER_CONFIG_PATH = roots.config;
    if (roots.managerStore) out.GOOBSTER_MANAGER_STATE_DIR = roots.managerStore;
    if (roots.cache) out.GOOBSTER_CACHE_DIR = roots.cache;
    if (roots.logs) out.GOOBSTER_LOG_DIR = roots.logs;
    return out;
}

/**
 * @param {string[]} argv
 * @param {Object} [io]
 * @returns {Promise<number>} the exit code
 */
async function run(argv, io = {}) {
    const fs = io.fs || nodeFs;
    const stdin = io.stdin || process.stdin;
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    const baseEnv = io.env || process.env;
    const secrets = [];
    const clean = (text) => secrets.reduce((value, secret) => value.split(secret).join(MARK), String(text));
    const out = (text) => stdout.write(`${clean(text)}\n`);
    const progress = (text) => stderr.write(`${clean(text)}\n`);
    let json = false;
    const report = { ok: false, command: null, exitCode: EXIT.UNEXPECTED };
    let prompter = null;
    const finish = (code, extra = {}) => {
        report.exitCode = code;
        report.ok = code === EXIT.OK || code === EXIT.PRIVILEGE;
        if (json) stdout.write(`${clean(JSON.stringify(scrub({ ...report, ...extra }), null, 2))}\n`);
        return code;
    };

    try {
        const parsed = parseArgs(argv);
        const { command, flags } = parsed;
        json = flags.json;
        report.command = command;

        if (command === 'help' || flags.help) {
            out(usage());
            return finish(EXIT.OK, { usage: true });
        }
        if (command === 'schema') {
            out(JSON.stringify(shipSchema(fs), null, 2));
            return EXIT.OK;
        }

        if (command === 'reset' || command === 'release') {
            return await require('./cliReset').run({
                command,
                flags,
                io,
                fs,
                baseEnv,
                stdin,
                stderr,
                stdinIsInteractive: Boolean(stdin && stdin.isTTY) || Boolean(io.stdin),
                out,
                progress,
                finish,
                report,
                secrets,
                json,
                prompter: null,
                setPrompter: (value) => { prompter = value; },
                cli: { CliError, EXIT, LOCAL_AUTH, loadAnswers, answersInput, createPrompter }
            });
        }

        // ---------- input
        let input = null;
        if (KIND_OF[command]) {
            if (flags.answers) input = answersInput(loadAnswers(flags.answers, fs), command, fs);
            secrets.push(...secretsIn(input));
        }

        const deps = io.installDeps || {};
        const discoverNow = (envForDiscovery) => (deps.discover || discover)({ fs, env: envForDiscovery, home: deps.home, exec: deps.exec });

        if (command === 'discover') {
            const found = discoverNow(baseEnv);
            if (json) report.candidates = found.candidates;
            else if (!found.candidates.length) out('No existing installation was found. Nothing was changed.');
            else for (const item of found.candidates) out(`${item.id}  ${item.kind}  ${item.layout}  ${item.dbEngine}  ${item.roots.code}  [${item.evidence.join(', ')}]`);
            return finish(EXIT.OK, { candidates: found.candidates });
        }

        if (KIND_OF[command] && !input) {
            prompter = createPrompter({ input: stdin, output: stderr });
            if (command === 'install') input = await promptInstall(prompter);
            else if (command === 'adopt') {
                input = await promptAdopt(prompter, discoverNow(baseEnv).candidates, stderr);
            } else input = await promptSimple(prompter, command);
            secrets.push(...secretsIn(input));
        }
        if (command === 'uninstall') {
            if (flags.deleteData) {
                if (!flags.confirm) throw new CliError('CONFIRMATION_REQUIRED', '--delete-data needs --confirm <installationId>; nothing was removed.');
                input = { ...input, keepData: false, confirm: flags.confirm };
            } else if (input && input.keepData === false && !input.confirm) {
                throw new CliError('CONFIRMATION_REQUIRED', 'keepData: false needs "confirm": the installation id; nothing was removed.');
            }
        }

        // ---------- settings: the roots the answers name decide where the manager looks
        let env = overlayRoots(baseEnv, input && input.roots);
        if (command === 'adopt' && input && input.candidateId && !(input.roots && input.roots.code)) {
            const candidate = discoverNow(baseEnv).candidates.find(item => item.id === input.candidateId);
            if (candidate) env = overlayRoots(env, { code: candidate.roots.code });
        }
        const settings = resolveSettings(env);
        settings.installDeps = deps;

        if (command === 'status') {
            return finish(EXIT.OK, statusReport(settings, fs, out, json));
        }

        const kindName = KIND_OF[command];
        const dryRun = flags.dryRun;

        // ---------- dry run: the kind's own plan(), no manager, no journal, no store directory
        if (dryRun) {
            const preview = await previewPlan(kindName, input, settings, fs, io.now);
            report.plan = preview.plan;
            if (!json) for (const line of describePlan(preview.plan, kindName, { dryRun: true })) out(line);
            return finish(preview.plan.preflight && !preview.plan.preflight.ok ? EXIT.INVALID : EXIT.OK, { plan: preview.plan, dryRun: true });
        }

        // ---------- apply
        const manager = createManager({
            settings,
            fs,
            logger: { info() {}, warn() {}, error() {} },
            extraKinds: require('./extensions').kinds,
            ...(io.now ? { now: io.now } : {}),
            hooks: { beforeStep: ({ kind, step }) => progress(`[${kind}] ${step} ...`) }
        });
        if (!manager.storeReady) throw new CliError('STORE_UNUSABLE', 'The manager store cannot be created or written here.', EXIT.REFUSED);
        await manager.engine.recoverInterrupted();
        const planned = await manager.engine.plan(kindName, input, LOCAL_AUTH, { internal: true });
        report.plan = planned.plan;
        if (!json) for (const line of describePlan(planned.plan, kindName, { dryRun: false })) progress(line);

        if (!flags.yes && prompter && !(command === 'uninstall' && flags.deleteData) && !planned.plan.noop) {
            const answer = await prompter.ask('Proceed? [y/N]: ');
            if (!yes(answer)) {
                progress('Cancelled; nothing was changed.');
                return finish(EXIT.OK, { cancelled: true, plan: planned.plan });
            }
        }
        const validated = await manager.engine.validate(planned.id, LOCAL_AUTH);
        const applied = await manager.engine.apply(validated.id, { revision: validated.revision }, LOCAL_AUTH);
        const record = manager.journal.read(applied.operation.id).record;
        const ledger = Array.isArray(record && record.progress) ? record.progress : [];
        const deferred = ledger.filter(item => item.status === 'deferred').map(item => item.name);
        const steps = ledger.map(item => ({ name: item.name, status: item.status, ...(item.code ? { code: item.code } : {}) }));
        if (!json) {
            out(`${kindName}: ${applied.operation.status}${planned.plan.noop ? ' (nothing to change)' : ''}`);
            for (const item of steps) out(`  ${item.status.padEnd(8)} ${item.name}${item.code ? ` (${item.code})` : ''}`);
            if (applied.result && applied.result.restartRequired) out('Restart the manager and the application workers for the change to take effect.');
            if (deferred.length) out(`Applied. ${deferred.length} step${deferred.length === 1 ? '' : 's'} (${deferred.join(', ')}) need the privileged helper, which is not available in this version; nothing was registered with the operating system.`);
        }
        return finish(deferred.length ? EXIT.PRIVILEGE : EXIT.OK, {
            operation: { id: applied.operation.id, kind: kindName, status: applied.operation.status },
            steps,
            deferred,
            result: scrub(applied.result || {})
        });
    } catch (error) {
        const code = exitFor(error);
        const view = { code: error && error.code ? String(error.code) : 'UNEXPECTED', message: error instanceof CliError || error instanceof ManagerError ? error.message : 'The operation failed unexpectedly.' };
        if (error && error.details && error.details.findings) view.findings = error.details.findings;
        if (error && error.operation) view.operationId = error.operation.id;
        if (!json) {
            progress(`${view.code}: ${view.message}`);
            for (const finding of view.findings || []) progress(`  ${finding.code}: ${finding.detail}`);
        }
        const resetNotice = report.command === 'reset' ? require('./cliReset').failureNotice(error) : null;
        if (resetNotice) progress(resetNotice);
        else if (code === EXIT.INTERRUPTED) progress('The operation stopped part way. Run the same command again to resume; finished steps are skipped.');
        return finish(code, { error: view });
    } finally {
        if (prompter) prompter.close();
    }
}

async function previewPlan(kindName, input, settings, fs, now = () => new Date()) {
    const { createKinds } = require('./engine/kinds/install');
    const { createAdoptKind } = require('./engine/kinds/installation');
    const spec = kindName === 'adopt'
        ? createAdoptKind({ settings, fs, now, logger: console })
        : createKinds({ settings, fs, now, logger: console }).find(item => item.kind === kindName);
    const store = createStore({ root: settings.storeDir, fs, now });
    const ctx = { store, journal: createJournal({ store, fs, now }), evidence: () => existingInstallEvidence(settings, fs), bridge: null };
    const planned = await spec.plan(input, ctx);
    return { plan: { ...planned.plan, preflight: planned.plan.preflight || null } };
}

function statusReport(settings, fs, out, json) {
    const store = createStore({ root: settings.storeDir, fs });
    const read = store.readInstallation();
    const tombstone = readTombstone(settings.storeDir, fs);
    const evidence = existingInstallEvidence(settings, fs);
    const seal = read.status === 'ok' ? store.verifySeal() : { state: read.status };
    const doc = read.doc;
    const summary = {
        state: read.status === 'ok' ? 'claimed' : (read.status === 'missing' && !tombstone.present && evidence.length === 0 ? 'unclaimed' : 'recovery'),
        record: read.status,
        ownership: seal.state,
        tombstone: tombstone.present,
        installation: doc ? {
            installationId: doc.installationId,
            origin: doc.origin,
            layout: doc.layout,
            roots: doc.roots,
            release: doc.release,
            updater: doc.updater,
            database: doc.database,
            services: doc.owned ? doc.owned.services : []
        } : null,
        operations: createJournal({ store, fs }).list().slice(0, 5).map(item => ({ id: item.id, kind: item.kind, status: item.status }))
    };
    if (!json) {
        out(`state       ${summary.state}${tombstone.present ? ' (tombstoned: an installation was removed here; only the local flow can install again)' : ''}`);
        out(`record      ${summary.record}, ownership ${summary.ownership}`);
        if (summary.installation) {
            const item = summary.installation;
            out(`installation ${item.installationId} (${item.origin}${item.layout ? `, ${item.layout}` : ''})`);
            if (item.release) out(`release     ${item.release.releaseId} ${item.release.version}: ${item.release.features.join(', ')}`);
            if (item.updater) out(`updater     ${item.updater.kind}`);
        }
        for (const item of summary.operations) out(`operation   ${item.id} ${item.kind} ${item.status}`);
    }
    return { status: summary };
}

function usage() {
    return [
        'goobster-manager <command> [options]',
        '',
        'Commands',
        '  install      install a verified release payload (a local directory)',
        '  adopt        adopt one existing installation found by "discover" (or named by roots)',
        '  reconfigure  change the layout, the code/cache/logs/uploads roots or settings',
        '  repair       put the recorded release back at the recorded roots; data and config are kept',
        '  uninstall    remove the code; data is kept unless --delete-data --confirm <installationId>',
        '  plan <cmd>   the same as <cmd> --dry-run',
        '  reset        empty the installation\'s data: --scope instance, or --scope feature --feature <id> (a dormant feature)',
        '               --dry-run shows the exact scope; --confirm <installationId[:feature]>; --backup-dir <dir>; the backup passphrase',
        '               comes from the answers file or a hidden prompt',
        '  release      lift a maintenance barrier a reset left up: --force --acknowledge-mutation',
        '  status       what the manager store says (read only)',
        '  discover     list existing installations on this host (read only)',
        '  schema       print the answers-file JSON schema',
        '',
        'Options',
        '  --answers <file>   JSON answers (mode 0600; may hold secrets); without it the CLI asks',
        '  --dry-run          plan and preflight only; nothing is written',
        '  --yes              skip the "Proceed?" question (never a deletion)',
        '  --delete-data --confirm <id>   uninstall: also remove the owned data roots',
        '  --json             machine-readable output',
        '',
        'Secrets are never accepted on the command line.',
        'Exit codes: 0 ok, 2 invalid input or preflight block, 3 refused, 4 interrupted (run again to resume),',
        '            5 applied but a step needs the privileged helper, 1 unexpected.'
    ].join('\n');
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}

module.exports = { run, parseArgs, loadAnswers, answersInput, describePlan, exitFor, EXIT, KIND_OF, SCHEMA_FILE, CliError };
