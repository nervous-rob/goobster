/**
 * Declared output contracts for Observatory run_script triggers.
 *
 * A trigger may declare the workspace files a job must leave behind
 * (`actionParams.requiredOutputs`). The contract is resolved when the
 * trigger fires — template variables substituted, paths legalized — and
 * frozen onto the job row, so editing the trigger while a job runs cannot
 * change what that job is judged against. At settlement an exit-0 job
 * only becomes COMPLETED when every declared output validates; otherwise
 * it settles FAILED with errorCode OUTPUT_CONTRACT_FAILED.
 *
 * Checks are deliberately limited to safe built-ins (regular file exists,
 * minimum byte count, parses as JSON). No validator commands, no
 * user-supplied code. Path handling reuses the Observatory workspace
 * legalizer (workspace-relative, traversal and symlink refusal).
 */

'use strict';

const fs = require('node:fs');

const MAX_REQUIRED_OUTPUTS = 20;
const MAX_TEMPLATE_PATH_LENGTH = 512;
/** Largest file the json check will read; bigger files fail the check. */
const MAX_JSON_PARSE_BYTES = 16 * 1024 * 1024;
const OUTPUT_TYPES = new Set(['file', 'json']);
const TEMPLATE_VARIABLES = new Set(['utc_date']);
const TEMPLATE_PATTERN = /\{([^{}]*)\}/g;
/** Placeholder used to legalize a template's shape before it is resolved. */
const SAMPLE_VALUES = { utc_date: '2000-01-01' };

const OUTPUT_CONTRACT_FAILED = 'OUTPUT_CONTRACT_FAILED';

class OutputContractError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OutputContractError';
        this.status = 400;
        this.code = 'BAD_OUTPUT_CONTRACT';
    }
}

function projectService() {
    // Lazy: projectService requires this module's consumers at load time.
    return require('../services/projectService');
}

/**
 * Substitute the supported template variables. Unknown variables throw.
 * @param {string} template
 * @param {Record<string, string>} values
 */
function substituteTemplate(template, values) {
    return String(template).replace(TEMPLATE_PATTERN, (whole, name) => {
        const key = String(name).trim();
        if (!TEMPLATE_VARIABLES.has(key)) {
            throw new OutputContractError(
                `Unsupported template variable "{${key}}" in requiredOutputs path (supported: `
                + `${[...TEMPLATE_VARIABLES].map(v => `{${v}}`).join(', ')}).`
            );
        }
        return values[key];
    });
}

function normalizeOne(entry, index) {
    const label = `requiredOutputs[${index}]`;
    const raw = typeof entry === 'string' ? { path: entry } : entry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new OutputContractError(`${label} must be an object with a "path".`);
    }
    const template = String(raw.path ?? '').trim();
    if (!template) {
        throw new OutputContractError(`${label} needs a workspace-relative "path".`);
    }
    if (template.length > MAX_TEMPLATE_PATH_LENGTH) {
        throw new OutputContractError(`${label}.path is too long (max ${MAX_TEMPLATE_PATH_LENGTH}).`);
    }
    if (/[{}]/.test(template.replace(TEMPLATE_PATTERN, ''))) {
        throw new OutputContractError(`${label}.path has an unbalanced template brace.`);
    }
    // The legalizer's string step on a sample substitution rejects absolute
    // paths, traversal, and empty segments before anything is stored.
    const sample = substituteTemplate(template, SAMPLE_VALUES);
    try {
        projectService().normalizeWorkspaceRelPath(sample);
    } catch (error) {
        throw new OutputContractError(`${label}.path: ${error.message}`);
    }

    const type = raw.type === undefined || raw.type === null || raw.type === ''
        ? 'file'
        : String(raw.type).trim().toLowerCase();
    if (!OUTPUT_TYPES.has(type)) {
        throw new OutputContractError(`${label}.type must be "file" or "json".`);
    }

    const normalized = { path: template, type };
    if (raw.minBytes !== undefined && raw.minBytes !== null && raw.minBytes !== '') {
        const minBytes = Number(raw.minBytes);
        if (!Number.isInteger(minBytes) || minBytes < 0) {
            throw new OutputContractError(`${label}.minBytes must be a non-negative integer.`);
        }
        normalized.minBytes = minBytes;
    }
    return normalized;
}

/**
 * Validate and normalize a trigger's declared outputs at write time.
 * Accepts an array (or a JSON string of one). Returns null when nothing
 * is declared so callers can drop the key.
 * @param {unknown} raw
 * @returns {Array<{ path: string, type: 'file'|'json', minBytes?: number }>|null}
 */
function normalizeRequiredOutputs(raw) {
    let list = raw;
    if (list === undefined || list === null || list === '') return null;
    if (typeof list === 'string') {
        try {
            list = JSON.parse(list);
        } catch {
            throw new OutputContractError('requiredOutputs must be a JSON array of { path, type?, minBytes? }.');
        }
    }
    if (!Array.isArray(list)) {
        throw new OutputContractError('requiredOutputs must be an array of { path, type?, minBytes? }.');
    }
    if (list.length === 0) return null;
    if (list.length > MAX_REQUIRED_OUTPUTS) {
        throw new OutputContractError(`requiredOutputs lists too many files (max ${MAX_REQUIRED_OUTPUTS}).`);
    }
    const seen = new Set();
    const normalized = list.map((entry, index) => normalizeOne(entry, index));
    for (const entry of normalized) {
        if (seen.has(entry.path)) {
            throw new OutputContractError(`requiredOutputs lists "${entry.path}" twice.`);
        }
        seen.add(entry.path);
    }
    return normalized;
}

/**
 * Resolve a normalized contract into the frozen form stored on a job:
 * template variables substituted with values captured now.
 * @param {ReturnType<typeof normalizeRequiredOutputs>} requiredOutputs
 * @param {{ now?: Date }} [opts]
 * @returns {{ resolvedAt: string, variables: Record<string, string>, outputs: Array<{ path: string, type: string, minBytes?: number }> }|null}
 */
function resolveOutputContract(requiredOutputs, { now = new Date() } = {}) {
    const normalized = normalizeRequiredOutputs(requiredOutputs);
    if (!normalized) return null;
    const at = new Date(now);
    const variables = { utc_date: at.toISOString().slice(0, 10) };
    const outputs = normalized.map(entry => {
        const resolved = projectService().normalizeWorkspaceRelPath(
            substituteTemplate(entry.path, variables)
        );
        const out = { path: resolved, type: entry.type };
        if (entry.minBytes !== undefined) out.minBytes = entry.minBytes;
        return out;
    });
    return {
        resolvedAt: at.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
        variables,
        outputs
    };
}

/**
 * Accept an already-frozen contract handed to observatory.run(). Every
 * path must be fully resolved (no template braces) and legal.
 * @param {unknown} raw
 */
function normalizeFrozenContract(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    let contract = raw;
    if (typeof contract === 'string') {
        try {
            contract = JSON.parse(contract);
        } catch {
            throw new OutputContractError('outputContract must be a resolved contract object.');
        }
    }
    const list = Array.isArray(contract) ? contract : contract?.outputs;
    if (!Array.isArray(list)) {
        throw new OutputContractError('outputContract needs an outputs array.');
    }
    if (list.length === 0) return null;
    if (list.length > MAX_REQUIRED_OUTPUTS) {
        throw new OutputContractError(`outputContract lists too many files (max ${MAX_REQUIRED_OUTPUTS}).`);
    }
    const outputs = list.map((raw, index) => {
        const entry = typeof raw === 'string' ? { path: raw } : raw;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new OutputContractError(`outputContract.outputs[${index}] must be an object with a "path".`);
        }
        const rel = String(entry.path ?? '');
        if (/[{}]/.test(rel)) {
            throw new OutputContractError(`outputContract.outputs[${index}].path is not resolved.`);
        }
        const normalized = normalizeOne({ ...entry, path: rel }, index);
        normalized.path = projectService().normalizeWorkspaceRelPath(rel);
        return normalized;
    });
    return {
        resolvedAt: typeof contract.resolvedAt === 'string' ? contract.resolvedAt : null,
        variables: contract.variables && typeof contract.variables === 'object' ? contract.variables : {},
        outputs
    };
}

function checkOne(workspaceDir, output) {
    const check = { path: output.path, type: output.type, ok: false, reason: null, sizeBytes: null };
    if (output.minBytes !== undefined) check.minBytes = output.minBytes;
    let absolutePath;
    try {
        ({ absolutePath } = projectService().legalizeWorkspacePath(workspaceDir, output.path));
    } catch (error) {
        check.reason = /symbolic link/i.test(error.message) ? 'symlink' : 'illegal_path';
        return check;
    }
    let stat;
    try {
        stat = fs.lstatSync(absolutePath);
    } catch {
        check.reason = 'missing';
        return check;
    }
    if (stat.isSymbolicLink()) {
        check.reason = 'symlink';
        return check;
    }
    if (!stat.isFile()) {
        check.reason = stat.isDirectory() ? 'directory' : 'not_a_file';
        return check;
    }
    check.sizeBytes = stat.size;
    if (output.minBytes !== undefined && stat.size < output.minBytes) {
        check.reason = 'too_small';
        return check;
    }
    if (output.type === 'json') {
        if (stat.size > MAX_JSON_PARSE_BYTES) {
            check.reason = 'too_large';
            return check;
        }
        try {
            JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        } catch {
            check.reason = 'invalid_json';
            return check;
        }
    }
    check.ok = true;
    return check;
}

/**
 * Evaluate a frozen contract against a workspace. Never throws: a path
 * the legalizer refuses is a failed check, not an exception.
 * @param {{ outputs: Array<{ path: string, type: string, minBytes?: number }> }} contract
 * @param {{ workspaceDir: string, now?: Date }} opts
 * @returns {{ ok: boolean, checkedAt: string, checks: Array<object> }}
 */
function evaluateOutputContract(contract, { workspaceDir, now = new Date() }) {
    const outputs = Array.isArray(contract?.outputs) ? contract.outputs : [];
    const checks = outputs.map(output => checkOne(workspaceDir, output));
    return {
        ok: checks.every(c => c.ok),
        checkedAt: new Date(now).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
        checks
    };
}

const REASON_LABELS = {
    missing: 'missing',
    too_small: 'too small',
    invalid_json: 'invalid json',
    directory: 'is a directory',
    not_a_file: 'not a regular file',
    symlink: 'symlink refused',
    illegal_path: 'illegal path',
    too_large: 'too large to validate'
};

/**
 * One concise line for job.error / trigger.lastOutcome / notices, e.g.
 * "output contract failed — missing pipeline/fetch_manifest_2026-09-18.json".
 * Never dumps the whole report.
 * @param {{ checks: Array<object> }} result
 * @param {{ maxItems?: number }} [opts]
 */
function summarizeContractFailure(result, { maxItems = 3 } = {}) {
    const failed = (result?.checks || []).filter(c => !c.ok);
    if (!failed.length) return 'output contract failed';
    const shown = failed.slice(0, maxItems)
        .map(c => `${REASON_LABELS[c.reason] || c.reason || 'failed'} ${c.path}`);
    const more = failed.length > shown.length ? `, +${failed.length - shown.length} more` : '';
    return `output contract failed — ${shown.join(', ')}${more}`;
}

/** Parse a stored JSON column defensively. */
function parseStoredJson(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

module.exports = {
    OUTPUT_CONTRACT_FAILED,
    OutputContractError,
    MAX_REQUIRED_OUTPUTS,
    TEMPLATE_VARIABLES,
    normalizeRequiredOutputs,
    resolveOutputContract,
    normalizeFrozenContract,
    evaluateOutputContract,
    summarizeContractFailure,
    parseStoredJson
};
