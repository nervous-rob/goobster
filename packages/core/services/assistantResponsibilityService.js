/**
 * Delegated responsibilities (DA-1a, ADR 0016): versioned grants of bounded
 * authority that later delegated work is checked against, one operation at
 * a time, at dispatch.
 *
 * A responsibility is inert until its owner activates it through an
 * authenticated action, and activation needs an enabled attention policy.
 * The model never creates, activates or widens one: there is no AI or MCP
 * tool for this service. `authorize()` is the single authority check; it
 * intersects the feature state, the grant's status/expiry/revision, the
 * acting principal, the granted operation and resource, the actor's current
 * access to that resource, and the owner's attention boundaries.
 *
 * Every edit is a compare-and-swap on `revision` and appends one snapshot to
 * assistant_responsibility_revisions. `authorityRevision` moves only when
 * authority or status changes, so a title edit does not invalidate work
 * running under the grant, while pause -> resume does.
 *
 * Erasure and counting live in services/dormantDataService.js so they reach
 * these rows even when this module is not in the payload.
 *
 * Spec: documentation/delegated_responsibilities.md
 */

const db = require('../db');
const { features } = require('../features/featureState');
const { unavailableResult } = require('../features/gate');
const attentionPolicyService = require('./attentionPolicyService');
const workFailureService = require('./workFailureService');
const { SCHEDULED_WORK } = require('./scheduledWorkRegistry');

const FEATURE_ID = 'assistant';

const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW', 'COMPLETED', 'REVOKED', 'EXPIRED', 'ARCHIVED'];
/** Statuses an expiry applies to (a terminal record keeps its outcome). */
const LIVE_STATUSES = new Set(['ACTIVE', 'PAUSED', 'NEEDS_REVIEW']);
/** Statuses whose authority fields may change (never ACTIVE). */
const EDITABLE_STATUSES = new Set(['DRAFT', 'PAUSED', 'NEEDS_REVIEW']);

/** action -> { from: statuses, to: status, changeKind }. */
const TRANSITIONS = {
    activate: { from: ['DRAFT'], to: 'ACTIVE', changeKind: 'activate' },
    pause: { from: ['ACTIVE'], to: 'PAUSED', changeKind: 'pause' },
    resume: { from: ['PAUSED', 'NEEDS_REVIEW'], to: 'ACTIVE', changeKind: 'resume' },
    request_review: { from: ['ACTIVE'], to: 'NEEDS_REVIEW', changeKind: 'review' },
    complete: { from: ['ACTIVE'], to: 'COMPLETED', changeKind: 'complete' },
    revoke: { from: ['DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW'], to: 'REVOKED', changeKind: 'revoke' },
    archive: { from: ['COMPLETED', 'REVOKED', 'EXPIRED'], to: 'ARCHIVED', changeKind: 'archive' }
};
/** Actions a person can take from the portal (request_review is the system's). */
const HUMAN_ACTIONS = ['activate', 'pause', 'resume', 'complete', 'revoke', 'archive'];

/**
 * The closed operation vocabulary. Each operation lists the resource kinds it
 * may be granted on, the attention category/action class it falls under
 * (null category = the resource kind's category), and the features it needs
 * beyond the resource kind's own.
 */
const OPERATIONS = {
    read: { kinds: ['knowledge', 'web', 'project', 'process', 'repository'], action: 'read', category: null, features: [] },
    research: { kinds: ['knowledge', 'web', 'project'], action: 'compute', category: 'research', features: ['expeditions'] },
    'kg.generated.add': { kinds: ['knowledge'], action: 'compute', category: 'knowledge', features: ['knowledge'] },
    'kg.generated.amend': { kinds: ['knowledge'], action: 'compute', category: 'knowledge', features: ['knowledge'] },
    'kg.saved.amend': { kinds: ['knowledge'], action: 'compute', category: 'knowledge', features: ['knowledge'] },
    'kg.edge': { kinds: ['knowledge'], action: 'compute', category: 'knowledge', features: ['knowledge'] },
    'kg.archive': { kinds: ['knowledge'], action: 'compute', category: 'knowledge', features: ['knowledge'] },
    'file.edit': { kinds: ['project'], action: 'compute', category: 'observatory', features: [] },
    'sandbox.run': { kinds: ['project'], action: 'compute', category: 'observatory', features: ['sandbox'] },
    'process.repair': { kinds: ['process'], action: 'compute', category: 'schedule', features: [] },
    'process.pause': { kinds: ['process'], action: 'compute', category: 'schedule', features: [] },
    'process.archive': { kinds: ['process'], action: 'compute', category: 'schedule', features: [] },
    'cleanup.exact': { kinds: ['process'], action: 'compute', category: 'schedule', features: [] },
    'repo.commit': { kinds: ['repository'], action: 'compute', category: 'github', features: [] },
    'repo.push': { kinds: ['repository'], action: 'write', category: 'github', features: ['github'] },
    'pr.create': { kinds: ['repository'], action: 'write', category: 'github', features: ['github'] },
    'external.write': { kinds: ['external'], action: 'write', category: 'general', features: [] }
};

/** Resource kinds: their attention category, features, and which constraint fields they take. */
const RESOURCE_KINDS = {
    knowledge: { category: 'knowledge', features: [], ids: 'scopes', fields: [] },
    web: { category: 'research', features: [], ids: 'none', fields: [] },
    project: { category: 'observatory', features: ['projects'], ids: 'required', fields: ['paths'] },
    process: { category: 'schedule', features: [], ids: 'required', fields: [] },
    repository: { category: 'github', features: ['projects'], ids: 'required', fields: ['projectId', 'branches'] },
    external: { category: 'general', features: [], ids: 'required', fields: [] }
};
/** DA-1a knowledge scopes: the person's own graph only. */
const KNOWLEDGE_SCOPES = ['personal'];
/** Process reference kinds `<kind>:<id>` and the table/owner column that proves access. */
const PROCESS_KINDS = {
    automation: { table: SCHEDULED_WORK.automation.table, owner: 'userId', feature: null },
    project_trigger: { table: SCHEDULED_WORK.project_trigger.table, owner: 'userId', feature: 'projects' },
    attention_watch: { table: SCHEDULED_WORK.attention_watch.table, owner: 'userId', feature: null },
    followed_source: { table: SCHEDULED_WORK.followed_source.table, owner: 'userId', feature: null }
};

const SOURCE_SCOPES = ['personal_chat', 'knowledge', 'project'];
const AUDIENCES = ['private', 'project'];
const BUDGET_KEYS = ['modelTokens', 'searches', 'computeSeconds', 'concurrentInitiatives', 'repairAttempts', 'externalOperations'];
const INTERRUPTIONS = ['immediate', 'digest', 'home'];

const LIMITS = {
    title: 200,
    outcome: 2000,
    stopCondition: 1000,
    idempotencyKey: 128,
    operations: 50,
    ids: 50,
    idLength: 200,
    paths: 20,
    branches: 20
};
const LIST_MAX = 100;

class AssistantResponsibilityError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssistantResponsibilityError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

const bad = (message, code = 'INVALID_RESPONSIBILITY') => new AssistantResponsibilityError(code, message, 400);
const notFound = () => new AssistantResponsibilityError('NOT_FOUND', 'No such responsibility.', 404);

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** ISO or `YYYY-MM-DD HH:MM:SS` (UTC) -> UTC text; null clears. */
function normalizeTimestamp(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) throw bad(`${field} must be a timestamp.`);
    return utcText(date);
}

function cleanText(value, field, max, { required = false } = {}) {
    if (value === null || value === undefined) {
        if (required) throw bad(`${field} is required.`);
        return null;
    }
    if (typeof value !== 'string') throw bad(`${field} must be text.`);
    const text = value.trim();
    if (!text) {
        if (required) throw bad(`${field} is required.`);
        return null;
    }
    if (text.length > max) throw bad(`${field} is longer than ${max} characters.`);
    return text;
}

function optionalId(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw bad(`${field} must be a positive integer id.`);
    return n;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(object, allowed, field) {
    for (const key of Object.keys(object)) {
        if (!allowed.includes(key)) throw bad(`${field} has an unknown field "${key}".`);
    }
}

function stringList(value, field, max, { pattern = null, code = 'INVALID_RESPONSIBILITY' } = {}) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw bad(`${field} must be a list.`, code);
    if (value.length > max) throw bad(`${field} has more than ${max} entries.`, code);
    const out = [];
    for (const raw of value) {
        const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
        if (typeof text !== 'string' || !text.trim()) throw bad(`${field} entries must be non-empty text.`, code);
        const clean = text.trim();
        if (clean.length > LIMITS.idLength) throw bad(`${field} entries are at most ${LIMITS.idLength} characters.`, code);
        if (pattern && !pattern.test(clean)) throw bad(`${field} has an invalid entry "${clean}".`, code);
        if (!out.includes(clean)) out.push(clean);
    }
    return out;
}

/** Workspace-relative path prefix: no absolute paths, no `..`, no backslashes. */
const PATH_PREFIX = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;
/** A branch name, optionally ending in `*` for a prefix match. */
const BRANCH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._/-]+\*?$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Repository writes that reach GitHub must name their branches. */
const BRANCH_REQUIRED = new Set(['repo.push', 'pr.create']);
const PROCESS_REF = new RegExp(`^(${Object.keys(PROCESS_KINDS).join('|')}):(\\d+)$`);

function normalizeResource(raw, operation, index) {
    const field = `operations[${index}].resource`;
    if (!isPlainObject(raw)) throw bad(`${field} is required.`, 'INVALID_RESOURCE');
    const kind = raw.kind;
    const spec = RESOURCE_KINDS[kind];
    if (!spec) throw bad(`${field}.kind must be one of ${Object.keys(RESOURCE_KINDS).join(', ')}.`, 'INVALID_RESOURCE');
    if (!OPERATIONS[operation].kinds.includes(kind)) {
        throw bad(`"${operation}" cannot be granted on a ${kind} resource.`, 'INVALID_RESOURCE');
    }
    rejectUnknownKeys(raw, ['kind', 'ids', ...spec.fields], field);
    const resource = { kind };
    if (spec.ids === 'scopes') {
        const ids = stringList(raw.ids === undefined ? ['personal'] : raw.ids, `${field}.ids`, LIMITS.ids, { code: 'INVALID_RESOURCE' });
        for (const id of ids) {
            if (!KNOWLEDGE_SCOPES.includes(id)) throw bad(`${field}.ids supports only: ${KNOWLEDGE_SCOPES.join(', ')}.`, 'INVALID_RESOURCE');
        }
        if (!ids.length) throw bad(`${field}.ids must name a knowledge scope.`, 'INVALID_RESOURCE');
        resource.ids = ids;
    } else if (spec.ids === 'required') {
        const pattern = kind === 'project' ? /^\d+$/
            : kind === 'process' ? PROCESS_REF
                : kind === 'repository' ? REPO_PATTERN : null;
        const ids = stringList(raw.ids, `${field}.ids`, LIMITS.ids, { pattern, code: 'INVALID_RESOURCE' });
        if (!ids.length) throw bad(`${field}.ids must name at least one ${kind}; there is no wildcard.`, 'INVALID_RESOURCE');
        resource.ids = kind === 'repository' ? ids.map(id => id.toLowerCase()) : ids;
    } else if (raw.ids !== undefined) {
        throw bad(`${field}.ids is not used for ${kind} resources.`, 'INVALID_RESOURCE');
    }
    if (spec.fields.includes('paths')) {
        const paths = stringList(raw.paths, `${field}.paths`, LIMITS.paths, { pattern: PATH_PREFIX, code: 'INVALID_RESOURCE' });
        if (paths.length) resource.paths = paths;
    }
    if (spec.fields.includes('projectId')) {
        const projectId = Number(raw.projectId);
        if (!Number.isSafeInteger(projectId) || projectId <= 0) {
            throw bad(`${field}.projectId (a positive integer id) is required for repositories.`, 'INVALID_RESOURCE');
        }
        resource.projectId = String(projectId);
    }
    if (spec.fields.includes('branches')) {
        const branches = stringList(raw.branches, `${field}.branches`, LIMITS.branches, { pattern: BRANCH_PATTERN, code: 'INVALID_RESOURCE' });
        if (branches.length) resource.branches = branches;
        // A write that leaves this installation names the branches it may
        // touch: an empty list would match every branch, the default one
        // included, which is the wildcard ADR 0016 rules out.
        if (BRANCH_REQUIRED.has(operation) && !branches.length) {
            throw bad(`${field}.branches must name the branch(es) "${operation}" may write; there is no wildcard.`, 'INVALID_RESOURCE');
        }
    }
    return resource;
}

function normalizeOperations(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw bad('operations must be a list.', 'INVALID_OPERATION');
    if (value.length > LIMITS.operations) throw bad(`operations has more than ${LIMITS.operations} entries.`, 'INVALID_OPERATION');
    return value.map((entry, index) => {
        if (!isPlainObject(entry)) throw bad(`operations[${index}] must be an object.`, 'INVALID_OPERATION');
        rejectUnknownKeys(entry, ['operation', 'resource'], `operations[${index}]`);
        const operation = entry.operation;
        if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(OPERATIONS, operation)) {
            throw bad(`operations[${index}].operation must be one of ${Object.keys(OPERATIONS).join(', ')}.`, 'INVALID_OPERATION');
        }
        return { operation, resource: normalizeResource(entry.resource, operation, index) };
    });
}

function normalizeScopes(value) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) throw bad('scopes must be an object.');
    rejectUnknownKeys(value, ['sources', 'audience'], 'scopes');
    const out = {};
    const sources = stringList(value.sources, 'scopes.sources', SOURCE_SCOPES.length);
    for (const source of sources) {
        if (!SOURCE_SCOPES.includes(source)) throw bad(`scopes.sources entries must be one of ${SOURCE_SCOPES.join(', ')}.`);
    }
    if (sources.length) out.sources = sources;
    if (value.audience !== undefined && value.audience !== null) {
        if (!AUDIENCES.includes(value.audience)) throw bad(`scopes.audience must be one of ${AUDIENCES.join(', ')}.`);
        out.audience = value.audience;
    }
    return out;
}

function normalizeBudgets(value) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) throw bad('budgets must be an object.');
    rejectUnknownKeys(value, BUDGET_KEYS, 'budgets');
    const out = {};
    for (const key of BUDGET_KEYS) {
        if (value[key] === undefined || value[key] === null) continue;
        const n = Number(value[key]);
        if (!Number.isSafeInteger(n) || n < 0) throw bad(`budgets.${key} must be a non-negative integer.`);
        out[key] = n;
    }
    return out;
}

function normalizeRules(value) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) throw bad('rules must be an object.');
    rejectUnknownKeys(value, ['interruption', 'stopCondition', 'autoStart'], 'rules');
    const out = {};
    // Proposed work is queued without waiting for the person (ADR 0018). Off
    // unless the person turns it on; like every rule it is part of the grant.
    if (value.autoStart !== undefined && value.autoStart !== null) {
        if (typeof value.autoStart !== 'boolean') throw bad('rules.autoStart must be true or false.');
        if (value.autoStart) out.autoStart = true;
    }
    if (value.interruption !== undefined && value.interruption !== null) {
        if (!INTERRUPTIONS.includes(value.interruption)) throw bad(`rules.interruption must be one of ${INTERRUPTIONS.join(', ')}.`);
        out.interruption = value.interruption;
    }
    const stop = cleanText(value.stopCondition, 'rules.stopCondition', LIMITS.stopCondition);
    if (stop) out.stopCondition = stop;
    return out;
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function conflict(currentRevision) {
    return new AssistantResponsibilityError('REVISION_CONFLICT',
        'This responsibility changed since you loaded it. Reload and try again.', 409,
        { revision: currentRevision == null ? null : Number(currentRevision) });
}

function assertRevision(row, expectedRevision) {
    const expected = Number(expectedRevision);
    if (expectedRevision === undefined || expectedRevision === null || !Number.isSafeInteger(expected)
        || Number(row.revision) !== expected) {
        throw conflict(row.revision);
    }
}

function isOverdue(row, nowText) {
    return Boolean(row.expiresAt) && LIVE_STATUSES.has(row.status) && row.expiresAt <= nowText;
}

/** Is `path` inside one of the granted prefixes? Both are workspace-relative. */
function pathAllowed(prefixes, path) {
    if (!prefixes || !prefixes.length) return true;
    if (typeof path !== 'string' || !path || !PATH_PREFIX.test(path)) return false;
    const target = path.replace(/^\.\//, '');
    return prefixes.some((prefix) => {
        const base = prefix.replace(/^\.\//, '').replace(/\/+$/, '');
        return target === base || target.startsWith(`${base}/`);
    });
}

function branchAllowed(patterns, branch) {
    if (!patterns || !patterns.length) return true;
    if (typeof branch !== 'string' || !branch) return false;
    return patterns.some(pattern => (pattern.endsWith('*')
        ? branch.startsWith(pattern.slice(0, -1))
        : branch === pattern));
}

class AssistantResponsibilityService {
    constructor() {
        this.FEATURE_ID = FEATURE_ID;
        this.STATUSES = STATUSES;
        this.OPERATIONS = Object.keys(OPERATIONS);
        this.RESOURCE_KINDS = Object.keys(RESOURCE_KINDS);
        this.BUDGET_KEYS = BUDGET_KEYS;
        this.HUMAN_ACTIONS = HUMAN_ACTIONS;
    }

    /** The public shape of a row. An overdue live grant reads as EXPIRED. */
    present(row, now = new Date()) {
        if (!row) return null;
        const nowText = utcText(now);
        const overdue = isOverdue(row, nowText);
        return {
            id: Number(row.id),
            ownerUserId: row.ownerUserId,
            authorizedBy: row.authorizedBy || null,
            actingUserId: row.actingUserId || null,
            payerUserId: row.payerUserId || null,
            revision: Number(row.revision),
            authorityRevision: Number(row.authorityRevision),
            status: overdue ? 'EXPIRED' : row.status,
            storedStatus: row.status,
            finalStatus: row.finalStatus || null,
            title: row.title,
            outcome: row.outcome || null,
            attentionItemId: row.attentionItemId == null ? null : Number(row.attentionItemId),
            projectId: row.projectId == null ? null : Number(row.projectId),
            planId: row.planId == null ? null : Number(row.planId),
            scopes: parseJson(row.scopesJson, {}),
            operations: parseJson(row.operationsJson, []),
            budgets: parseJson(row.budgetsJson, {}),
            rules: parseJson(row.rulesJson, {}),
            expiresAt: row.expiresAt || null,
            activatedAt: row.activatedAt || null,
            reviewedAt: row.reviewedAt || null,
            endedAt: row.endedAt || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }

    /** The vocabulary the portal and docs describe; data only. */
    vocabulary() {
        return {
            statuses: STATUSES,
            actions: HUMAN_ACTIONS,
            operations: Object.entries(OPERATIONS).map(([id, spec]) => ({ id, resourceKinds: [...spec.kinds], action: spec.action })),
            resourceKinds: Object.keys(RESOURCE_KINDS),
            knowledgeScopes: KNOWLEDGE_SCOPES,
            processKinds: Object.keys(PROCESS_KINDS),
            sourceScopes: SOURCE_SCOPES,
            audiences: AUDIENCES,
            budgetKeys: BUDGET_KEYS,
            interruptions: INTERRUPTIONS
        };
    }

    async _row(id, handle = db) {
        const rid = optionalId(id, 'id');
        if (!rid) return null;
        return handle.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: rid });
    }

    /** One of the owner's responsibilities; 404 for anyone else's (no existence leak). */
    async get({ userId, id, now = new Date() }) {
        const row = await this._row(id);
        if (!row || row.ownerUserId !== String(userId)) throw notFound();
        return this.present(row, now);
    }

    async list({ userId, status = null, limit = LIST_MAX, now = new Date() }) {
        if (!userId) throw bad('A user id is required.');
        const cap = Math.max(1, Math.min(LIST_MAX, Number(limit) || LIST_MAX));
        const rows = await db.all(
            `SELECT * FROM assistant_responsibilities WHERE ownerUserId = @userId
             ORDER BY id DESC LIMIT @limit`,
            { userId: String(userId), limit: cap }
        );
        const items = rows.map(row => this.present(row, now));
        if (status && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}.`);
        return { responsibilities: status ? items.filter(item => item.status === status) : items };
    }

    /** The revision history, oldest first. */
    async revisions({ userId, id }) {
        await this.get({ userId, id });
        const rows = await db.all(
            `SELECT revision, authorityRevision, changeKind, changedBy, snapshotJson, createdAt
             FROM assistant_responsibility_revisions WHERE responsibilityId = @id ORDER BY revision`,
            { id: Number(id) }
        );
        return {
            revisions: rows.map(row => ({
                revision: Number(row.revision),
                authorityRevision: Number(row.authorityRevision),
                changeKind: row.changeKind,
                changedBy: row.changedBy || null,
                snapshot: parseJson(row.snapshotJson, {}),
                createdAt: row.createdAt
            }))
        };
    }

    /** Validated authority/cosmetic fields from a create or edit body. Only keys present are returned. */
    _fields(body, { creating }) {
        if (!isPlainObject(body)) throw bad('A JSON body is required.');
        const fields = {};
        const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
        if (creating || has('title')) fields.title = cleanText(body.title, 'title', LIMITS.title, { required: true });
        if (has('outcome')) fields.outcome = cleanText(body.outcome, 'outcome', LIMITS.outcome);
        if (has('attentionItemId')) fields.attentionItemId = optionalId(body.attentionItemId, 'attentionItemId');
        if (has('projectId')) fields.projectId = optionalId(body.projectId, 'projectId');
        if (has('planId')) fields.planId = optionalId(body.planId, 'planId');
        if (has('scopes')) fields.scopesJson = JSON.stringify(normalizeScopes(body.scopes));
        if (has('operations')) fields.operationsJson = JSON.stringify(normalizeOperations(body.operations));
        if (has('budgets')) fields.budgetsJson = JSON.stringify(normalizeBudgets(body.budgets));
        if (has('rules')) fields.rulesJson = JSON.stringify(normalizeRules(body.rules));
        if (has('expiresAt')) fields.expiresAt = normalizeTimestamp(body.expiresAt, 'expiresAt');
        return fields;
    }

    /** Links must point at records the owner can reach; the error never names them. */
    async _validateLinks(record, userId) {
        if (record.attentionItemId) {
            const item = await db.get('SELECT userId FROM attention_items WHERE id = @id', { id: record.attentionItemId });
            if (!item || item.userId !== userId) throw bad('attentionItemId is not one of your attention items.', 'INVALID_LINK');
        }
        if (record.planId && !record.projectId) throw bad('planId needs its projectId.', 'INVALID_LINK');
        if (record.projectId) {
            if (features.enforcedOff('projects')) throw bad('Projects are not available on this installation.', 'INVALID_LINK');
            if (!(await this._projectAccess(userId, record.projectId))) throw bad('projectId is not a project you can reach.', 'INVALID_LINK');
        }
        if (record.planId) {
            const plan = await db.get('SELECT projectId FROM project_missions WHERE id = @id', { id: record.planId });
            if (!plan || Number(plan.projectId) !== Number(record.projectId)) throw bad('planId is not a plan of that project.', 'INVALID_LINK');
        }
        const scopes = parseJson(record.scopesJson, {});
        if ((scopes.audience === 'project' || (scopes.sources || []).includes('project')) && !record.projectId) {
            throw bad('A project source or audience needs projectId.', 'INVALID_LINK');
        }
    }

    async _projectAccess(userId, projectId) {
        const row = await db.get(
            `SELECT 1 AS ok FROM observatory_projects p
             WHERE p.id = @projectId
               AND (p.userId = @userId
                    OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @userId))`,
            { projectId: Number(projectId), userId: String(userId) }
        );
        return Boolean(row);
    }

    /**
     * Does `userId` still reach the granted resource ids? Returns the first
     * blocking feature id, `false` for lost access, or `true`.
     */
    async _resourceAccess(userId, resource, target = null) {
        for (const featureId of RESOURCE_KINDS[resource.kind].features) {
            if (features.enforcedOff(featureId)) return featureId;
        }
        const ids = target ? [target] : (resource.ids || []);
        switch (resource.kind) {
        case 'project':
            for (const id of ids) {
                if (!(await this._projectAccess(userId, id))) return false;
            }
            return true;
        case 'repository': {
            if (!(await this._projectAccess(userId, resource.projectId))) return false;
            for (const repo of ids) {
                const row = await db.get(
                    'SELECT 1 AS ok FROM project_repos WHERE projectId = @projectId AND LOWER(repo) = @repo',
                    { projectId: Number(resource.projectId), repo: String(repo).toLowerCase() }
                );
                if (!row) return false;
            }
            return true;
        }
        case 'process':
            for (const ref of ids) {
                const match = PROCESS_REF.exec(ref);
                if (!match) return false;
                const spec = PROCESS_KINDS[match[1]];
                if (spec.feature && features.enforcedOff(spec.feature)) return spec.feature;
                const row = await db.get(
                    `SELECT ${spec.owner} AS owner FROM ${spec.table} WHERE id = @id`,
                    { id: Number(match[2]) }
                );
                if (!row || row.owner !== String(userId)) return false;
            }
            return true;
        default:
            return true;
        }
    }

    /** Activation/resume re-validation: links and every granted resource, as the acting principal. */
    async _validateForActivation(row) {
        const acting = row.actingUserId;
        if (!acting || acting !== row.ownerUserId) {
            throw new AssistantResponsibilityError('ACTOR_MISMATCH', 'This responsibility has no acting principal that can use it.', 409);
        }
        await this._validateLinks(row, row.ownerUserId);
        const operations = parseJson(row.operationsJson, []);
        if (!operations.length) throw bad('Grant at least one operation before activating.', 'INVALID_OPERATION');
        for (const entry of operations) {
            for (const featureId of OPERATIONS[entry.operation]?.features || []) {
                if (features.enforcedOff(featureId)) {
                    throw new AssistantResponsibilityError('FEATURE_UNAVAILABLE', `"${entry.operation}" needs a feature that is not available.`, 409, { feature: featureId });
                }
            }
            const access = await this._resourceAccess(acting, entry.resource);
            if (access !== true) {
                throw new AssistantResponsibilityError(
                    typeof access === 'string' ? 'FEATURE_UNAVAILABLE' : 'RESOURCE_UNAVAILABLE',
                    `A granted ${entry.resource.kind} is not available to you.`, 409,
                    typeof access === 'string' ? { feature: access } : null
                );
            }
        }
        const policy = await attentionPolicyService.get(row.ownerUserId);
        if (!policy || !policy.enabled) {
            throw new AssistantResponsibilityError('ATTENTION_NOT_ENROLLED',
                'Turn on Attention (/attention enable or Settings) before activating a responsibility.', 409);
        }
        // Reaching a person outside the portal (a digest, a contact) is a
        // pilot capability (documentation/delegated_delivery.md).
        const interruption = parseJson(row.rulesJson, {})?.interruption;
        if (['digest', 'immediate'].includes(interruption)) {
            const access = require('./assistantAccessService');
            if (!(await access.allows(row.ownerUserId, 'delivery'))) {
                throw new AssistantResponsibilityError(access.REFUSAL_CODE,
                    'Digests and contacts for delegated work are limited to the installation\'s owner until the pilot decision is recorded. Keep updates on Home to activate.',
                    409, { capability: 'delivery' });
            }
        }
    }

    async _snapshot(row, changeKind, changedBy) {
        await db.insert(
            `INSERT INTO assistant_responsibility_revisions
                (responsibilityId, revision, authorityRevision, changeKind, changedBy, snapshotJson)
             VALUES (@id, @revision, @authorityRevision, @changeKind, @changedBy, @snapshot)`,
            {
                id: row.id,
                revision: row.revision,
                authorityRevision: row.authorityRevision,
                changeKind,
                changedBy: changedBy == null ? null : String(changedBy),
                snapshot: JSON.stringify(this.present(row))
            }
        );
        // Every stored revision is a change the owner's open pages show
        // (documentation/delegated_delivery.md, "Live updates").
        require('./assistantLiveService').changed(row.ownerUserId, 'initiative');
    }

    /**
     * Compare-and-swap write of `sets` (column -> value) against `expectedRevision`,
     * plus a revision snapshot. Must run inside a transaction.
     */
    async _write(row, expectedRevision, sets, { changeKind, changedBy, authority }) {
        assertRevision(row, expectedRevision);
        const expected = Number(expectedRevision);
        const params = { id: row.id, expected, now: utcText() };
        const assignments = [];
        for (const [column, value] of Object.entries(sets)) {
            assignments.push(`${column} = @set_${column}`);
            params[`set_${column}`] = value;
        }
        assignments.push('revision = revision + 1', 'updatedAt = @now');
        if (authority) assignments.push('authorityRevision = revision + 1');
        const result = await db.run(
            `UPDATE assistant_responsibilities SET ${assignments.join(', ')}
             WHERE id = @id AND revision = @expected`,
            params
        );
        if (result.changes !== 1) {
            const current = await this._row(row.id);
            throw conflict(current ? current.revision : null);
        }
        const updated = await this._row(row.id);
        await this._snapshot(updated, changeKind, changedBy);
        return updated;
    }

    /** Persist the EXPIRED transition of an overdue live row (inside a transaction). */
    async _persistExpiry(row, nowText) {
        if (!isOverdue(row, nowText)) return row;
        const result = await db.run(
            `UPDATE assistant_responsibilities
             SET status = 'EXPIRED', endedAt = @now, revision = revision + 1,
                 authorityRevision = revision + 1, updatedAt = @now
             WHERE id = @id AND revision = @revision`,
            { id: row.id, revision: row.revision, now: nowText }
        );
        const updated = await this._row(row.id);
        if (result.changes === 1) {
            await this._snapshot(updated, 'expire', null);
            await this._afterStatusChange(updated, 'expire');
        }
        return updated;
    }

    /**
     * Effects of a status change, inside its transaction: open initiatives
     * follow the grant, activation records the source baseline, and changes
     * the owner did not make themselves (a review request, an expiry) become
     * one canonical update with an Inbox envelope.
     */
    async _afterStatusChange(row, changeKind) {
        const initiatives = require('./assistantInitiativeService');
        const updates = require('./assistantUpdateService');
        await initiatives.onResponsibilityChanged(row);
        if (changeKind === 'activate') await initiatives.reconcileResponsibility(row.id);
        const audience = { userId: row.ownerUserId };
        const identityKey = `responsibility:${row.id}:status`;
        if (changeKind === 'review' || changeKind === 'expire') {
            await updates.publish({
                audience,
                identityKey,
                kind: 'responsibility',
                title: changeKind === 'review'
                    ? `"${row.title}" needs your review`
                    : `"${row.title}" expired`,
                summary: changeKind === 'review'
                    ? 'Delegated work under this responsibility stopped and asked for a human look. Resume or revoke it.'
                    : 'Its authority ended at its expiry time. Create a new responsibility to delegate again.',
                components: ['responsibilities'],
                responsibilityId: row.id,
                source: { kind: 'responsibility', id: row.id, revision: row.revision },
                actions: [{ kind: 'open_responsibility', id: row.id }],
                gate: changeKind === 'review' ? { kind: 'responsibility_review', id: row.id, occurrence: row.revision } : null,
                deliver: true,
                deliverNow: false
            });
        } else if (['resume', 'revoke', 'complete', 'archive'].includes(changeKind)) {
            await updates.resolveGate({ audience, identityKey });
        }
    }

    /**
     * Create a draft (or create-and-activate when `activate` is true). The
     * caller is the owner, authorizer, actor and payer: none of those come
     * from the body. `idempotencyKey` makes a retried create return the
     * first row.
     * @returns {Promise<{ responsibility: Object, created: boolean }>}
     */
    async create({ userId, body = {}, activate = false, idempotencyKey = null }) {
        if (!userId) throw bad('A user id is required.');
        const owner = String(userId);
        const key = cleanText(idempotencyKey ?? body?.idempotencyKey ?? null, 'idempotencyKey', LIMITS.idempotencyKey);
        const fields = this._fields(body, { creating: true });
        const replay = async () => {
            if (!key) return null;
            const existing = await db.get(
                'SELECT * FROM assistant_responsibilities WHERE ownerUserId = @owner AND idempotencyKey = @key',
                { owner, key }
            );
            return existing ? { responsibility: this.present(existing), created: false } : null;
        };
        const earlier = await replay();
        if (earlier) return earlier;
        await this._validateLinks(fields, owner);

        try {
            return await this._insert({ owner, fields, key, activate });
        } catch (error) {
            // A concurrent create with the same key won the unique index.
            if (key && String(error?.message || '').includes('UNIQUE')) {
                const winner = await replay();
                if (winner) return winner;
            }
            throw error;
        }
    }

    async _insert({ owner, fields, key, activate }) {
        return db.transaction(async () => {
            const id = await db.insert(
                `INSERT INTO assistant_responsibilities
                    (ownerUserId, authorizedBy, actingUserId, payerUserId, status, title, outcome,
                     attentionItemId, projectId, planId, scopesJson, operationsJson, budgetsJson, rulesJson,
                     idempotencyKey, expiresAt)
                 VALUES (@owner, @owner, @owner, @owner, 'DRAFT', @title, @outcome,
                     @attentionItemId, @projectId, @planId, @scopesJson, @operationsJson, @budgetsJson, @rulesJson,
                     @key, @expiresAt)`,
                {
                    owner,
                    title: fields.title,
                    outcome: fields.outcome ?? null,
                    attentionItemId: fields.attentionItemId ?? null,
                    projectId: fields.projectId ?? null,
                    planId: fields.planId ?? null,
                    scopesJson: fields.scopesJson ?? '{}',
                    operationsJson: fields.operationsJson ?? '[]',
                    budgetsJson: fields.budgetsJson ?? '{}',
                    rulesJson: fields.rulesJson ?? '{}',
                    key,
                    expiresAt: fields.expiresAt ?? null
                }
            );
            let row = await this._row(id);
            await this._snapshot(row, 'create', owner);
            if (activate === true) {
                row = await this._transition(row, 'activate', row.revision, owner);
            }
            return { responsibility: this.present(row), created: true };
        });
    }

    /**
     * Edit with `expectedRevision`. ACTIVE grants take a title change only;
     * authority fields need DRAFT, PAUSED or NEEDS_REVIEW. An edit never
     * changes the status.
     */
    async update({ userId, id, expectedRevision, body = {} }) {
        const fields = this._fields(body, { creating: false });
        if (!Object.keys(fields).length) throw bad('Nothing to change.');
        return db.transaction(async () => {
            let row = await this._row(id);
            if (!row || row.ownerUserId !== String(userId)) throw notFound();
            assertRevision(row, expectedRevision);
            if (isOverdue(row, utcText())) {
                throw new AssistantResponsibilityError('RESPONSIBILITY_EXPIRED', 'This responsibility has expired. Create a new one to delegate again.', 409);
            }
            const authorityChange = Object.keys(fields).some(key => key !== 'title');
            if (authorityChange && !EDITABLE_STATUSES.has(row.status)) {
                if (row.status === 'ACTIVE') {
                    throw new AssistantResponsibilityError('PAUSE_REQUIRED', 'Pause this responsibility before changing what it may do.', 409);
                }
                throw new AssistantResponsibilityError('INVALID_TRANSITION', `A ${row.status.toLowerCase()} responsibility cannot be changed.`, 409);
            }
            if (!authorityChange && ['REVOKED', 'EXPIRED', 'ARCHIVED'].includes(row.status)) {
                throw new AssistantResponsibilityError('INVALID_TRANSITION', `A ${row.status.toLowerCase()} responsibility cannot be changed.`, 409);
            }
            await this._validateLinks({ ...row, ...fields }, row.ownerUserId);
            const updated = await this._write(row, expectedRevision, fields, {
                changeKind: 'edit', changedBy: userId, authority: authorityChange
            });
            return { responsibility: this.present(updated) };
        });
    }

    /** The owner's lifecycle actions: activate | pause | resume | complete | revoke | archive. */
    async act({ userId, id, action, expectedRevision }) {
        if (!HUMAN_ACTIONS.includes(action)) throw bad(`action must be one of ${HUMAN_ACTIONS.join(', ')}.`, 'INVALID_ACTION');
        return this._act({ id, action, expectedRevision, owner: String(userId), changedBy: userId });
    }

    /**
     * ACTIVE -> NEEDS_REVIEW, for delegated work that finds it needs a human
     * look. Narrows authority only, so it is not an owner-only action;
     * `changedBy` is null when the system asks.
     */
    async requestReview({ id, expectedRevision, changedBy = null }) {
        return this._act({ id, action: 'request_review', expectedRevision, owner: null, changedBy });
    }

    async _act({ id, action, expectedRevision, owner, changedBy }) {
        const result = await db.transaction(async () => {
            const row = await this._row(id);
            if (!row || (owner !== null && row.ownerUserId !== owner)) throw notFound();
            const updated = await this._transition(row, action, expectedRevision, changedBy);
            return { responsibility: this.present(updated) };
        });
        await this._deliverOwed(result.responsibility.ownerUserId);
        return result;
    }

    /** Inbox envelopes owed by status changes, filed after their transaction committed. */
    async _deliverOwed(userId) {
        try {
            await require('./assistantUpdateService').deliverPending({ userId });
        } catch { /* retried by the steward's next pass */ }
    }

    async _transition(row, action, expectedRevision, changedBy) {
        const nowText = utcText();
        const spec = TRANSITIONS[action];
        assertRevision(row, expectedRevision);
        const current = await this._persistExpiry(row, nowText);
        if (current.status === 'EXPIRED' && row.status !== 'EXPIRED' && action !== 'archive') {
            throw new AssistantResponsibilityError('RESPONSIBILITY_EXPIRED', 'This responsibility has expired. Create a new one to delegate again.', 409);
        }
        if (!spec.from.includes(current.status)) {
            throw new AssistantResponsibilityError('INVALID_TRANSITION',
                `Cannot ${action.replace('_', ' ')} a ${current.status.toLowerCase().replace('_', ' ')} responsibility.`, 409,
                { status: current.status });
        }
        // The caller saw `row`; a lazy expiry persisted just now is not their conflict.
        const expected = current.revision;
        if (spec.to === 'ACTIVE') await this._validateForActivation(current);
        const sets = { status: spec.to };
        if (action === 'activate') sets.activatedAt = nowText;
        if (action === 'resume' && current.status === 'NEEDS_REVIEW') sets.reviewedAt = nowText;
        if (['COMPLETED', 'REVOKED'].includes(spec.to)) sets.endedAt = nowText;
        if (spec.to === 'ARCHIVED') sets.finalStatus = current.status;
        const updated = await this._write(current, expected, sets, { changeKind: spec.changeKind, changedBy, authority: true });
        await this._afterStatusChange(updated, spec.changeKind);
        return updated;
    }

    /**
     * Persist EXPIRED for every overdue live grant (for a later scheduler;
     * reads and authorize() already treat them as expired).
     * @returns {Promise<number>} rows expired
     */
    async expireDue({ now = new Date(), limit = 200 } = {}) {
        const nowText = utcText(now);
        const rows = await db.all(
            `SELECT * FROM assistant_responsibilities
             WHERE status IN ('ACTIVE', 'PAUSED', 'NEEDS_REVIEW') AND expiresAt IS NOT NULL AND expiresAt <= @now
             ORDER BY id LIMIT @limit`,
            { now: nowText, limit: Math.max(1, Math.min(1000, Number(limit) || 200)) }
        );
        let expired = 0;
        for (const row of rows) {
            const updated = await db.transaction(async () => this._persistExpiry(row, nowText));
            if (updated?.status === 'EXPIRED') {
                expired += 1;
                await this._deliverOwed(updated.ownerUserId);
            }
        }
        return expired;
    }

    /**
     * The dispatch-time authority check. Call it immediately before every
     * delegated side effect (and again after long I/O, before committing).
     *
     * @param {Object} params
     * @param {number} params.responsibilityId
     * @param {number} params.revision - the revision the work was planned under
     * @param {string} params.operation - one of OPERATIONS
     * @param {{ kind: string, id?: string, path?: string, branch?: string, projectId?: string }} params.resource
     * @param {string} params.actorUserId - who the work runs as
     * @returns {Promise<{ ok: true, responsibilityId, revision, operation } | { ok: false, code: string, feature?: string }>}
     */
    async authorize({ responsibilityId, revision, operation, resource, actorUserId, now = new Date() }) {
        const result = await this._authorize({ responsibilityId, revision, operation, resource, actorUserId, now });
        if (!result.ok) {
            await workFailureService.note({ phase: 'responsibility_authorize', code: result.code });
        }
        return result;
    }

    async _authorize({ responsibilityId, revision, operation, resource, actorUserId, now }) {
        if (features.enforcedOff(FEATURE_ID)) return unavailableResult(FEATURE_ID);
        const row = await this._row(responsibilityId);
        if (!row) return { ok: false, code: 'RESPONSIBILITY_NOT_FOUND' };

        const nowText = utcText(now);
        const status = isOverdue(row, nowText) ? 'EXPIRED' : row.status;
        if (status === 'REVOKED' || (status === 'ARCHIVED' && row.finalStatus === 'REVOKED')) return { ok: false, code: 'RESPONSIBILITY_REVOKED' };
        if (status === 'EXPIRED' || (status === 'ARCHIVED' && row.finalStatus === 'EXPIRED')) return { ok: false, code: 'RESPONSIBILITY_EXPIRED' };
        if (status !== 'ACTIVE') return { ok: false, code: 'RESPONSIBILITY_INACTIVE', status };

        const presented = Number(revision);
        if (!Number.isSafeInteger(presented) || presented < Number(row.authorityRevision) || presented > Number(row.revision)) {
            return { ok: false, code: 'REVISION_CONFLICT', revision: Number(row.revision) };
        }
        if (!actorUserId || !row.actingUserId || String(actorUserId) !== row.actingUserId) {
            return { ok: false, code: 'ACTOR_MISMATCH' };
        }

        const opSpec = Object.prototype.hasOwnProperty.call(OPERATIONS, operation) ? OPERATIONS[operation] : null;
        if (!opSpec || !isPlainObject(resource) || !RESOURCE_KINDS[resource.kind] || !opSpec.kinds.includes(resource.kind)) {
            return { ok: false, code: 'OPERATION_OUT_OF_SCOPE' };
        }
        for (const featureId of [...RESOURCE_KINDS[resource.kind].features, ...opSpec.features]) {
            if (features.enforcedOff(featureId)) return unavailableResult(featureId);
        }

        const grants = parseJson(row.operationsJson, []);
        const target = resource.id == null ? null : String(resource.id);
        const matching = grants.find(entry => this._grantMatches(entry, operation, resource, target));
        if (!matching) return { ok: false, code: 'OPERATION_OUT_OF_SCOPE' };

        const access = await this._resourceAccess(row.actingUserId, matching.resource, target);
        if (typeof access === 'string') return unavailableResult(access);
        if (access !== true) return { ok: false, code: 'RESOURCE_UNAVAILABLE' };

        const policy = await attentionPolicyService.get(row.ownerUserId);
        if (!policy || !policy.enabled) return { ok: false, code: 'ATTENTION_NOT_ENROLLED' };
        const category = opSpec.category || RESOURCE_KINDS[resource.kind].category;
        const allowed = attentionPolicyService.allows(policy, category, opSpec.action);
        if (allowed === 'confirm') return { ok: false, code: 'CONFIRMATION_REQUIRED' };
        if (allowed !== true) return { ok: false, code: 'ATTENTION_BOUNDARY', category, action: opSpec.action };

        return { ok: true, responsibilityId: Number(row.id), revision: Number(row.revision), operation };
    }

    _grantMatches(entry, operation, resource, target) {
        if (!entry || entry.operation !== operation || !entry.resource || entry.resource.kind !== resource.kind) return false;
        const granted = entry.resource;
        const spec = RESOURCE_KINDS[resource.kind];
        if (spec.ids !== 'none') {
            if (!target) return false;
            const wanted = resource.kind === 'repository' ? target.toLowerCase() : target;
            if (!(granted.ids || []).includes(wanted)) return false;
        }
        if (resource.kind === 'repository' && String(resource.projectId ?? '') !== granted.projectId) return false;
        if (spec.fields.includes('paths') && !pathAllowed(granted.paths, resource.path)) return false;
        if (spec.fields.includes('branches') && !branchAllowed(granted.branches, resource.branch)) return false;
        return true;
    }
}

module.exports = new AssistantResponsibilityService();
module.exports.AssistantResponsibilityService = AssistantResponsibilityService;
module.exports.AssistantResponsibilityError = AssistantResponsibilityError;
module.exports.OPERATIONS = OPERATIONS;
module.exports.RESOURCE_KINDS = RESOURCE_KINDS;
