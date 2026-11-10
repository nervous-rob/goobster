/**
 * The owner-only gate for the delegated assistant's later capabilities
 * (DA-12a; documentation/delegated_operations.md, "The pilot gate").
 *
 * The `assistant` feature is installation-wide, so on its own it cannot
 * keep a capability to one person. Everything added by DA-7 through DA-11
 * asks this service first: until the host records the pilot decision, only
 * the owner - an account with the operator role - gets it.
 *
 * One capability per increment, so a stage has one name to check at its
 * entry points and at dispatch:
 *
 *   conversation  DA-7   delegating and controlling by talking
 *   sources       DA-8   wider opportunity sources
 *   delivery      DA-9   live overview, interruption rule, digest, push
 *   feedback      DA-10  feedback that changes selection, timing, authority
 *   reach         DA-11  repository work, saved-note edits, connectors
 *
 * The decision is `instance_state.assistantPilot` (`{ scope, decidedAt }`);
 * who recorded it is in `operator_audit`. Unset means owner-only.
 */

const state = require('./instanceStateService');
const identityService = require('./identityService');

const KEY_PILOT = 'assistantPilot';
const SCOPES = ['owner', 'everyone'];
const CAPABILITIES = Object.freeze({
    conversation: 'DA-7',
    sources: 'DA-8',
    delivery: 'DA-9',
    feedback: 'DA-10',
    reach: 'DA-11'
});
/** Grant operations that belong to a gated capability. */
const OPERATION_CAPABILITY = Object.freeze({
    'kg.saved.propose': 'reach',
    'kg.saved.amend': 'reach',
    'kg.edge': 'reach',
    'kg.archive': 'reach',
    'repo.commit': 'reach',
    'repo.push': 'reach',
    'pr.create': 'reach',
    'external.write': 'reach'
});
const REFUSAL_CODE = 'PILOT_ONLY';

class AssistantAccessError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AssistantAccessError';
        this.code = code;
        this.status = status;
    }
}

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

class AssistantAccessService {
    constructor() {
        this.CAPABILITIES = CAPABILITIES;
        this.SCOPES = SCOPES;
        this.REFUSAL_CODE = REFUSAL_CODE;
    }

    /** @returns {Promise<{ scope: 'owner'|'everyone', decidedAt: string|null }>} */
    async decision() {
        const stored = await state.get(KEY_PILOT);
        if (stored && typeof stored === 'object' && SCOPES.includes(stored.scope)) {
            return { scope: stored.scope, decidedAt: stored.decidedAt ? String(stored.decidedAt) : null };
        }
        return { scope: 'owner', decidedAt: null };
    }

    /**
     * Record the pilot decision. `everyone` opens the gated capabilities to
     * every account; `owner` closes them again.
     * @returns {Promise<{ decision: Object, changed: boolean }>}
     */
    async recordDecision({ scope, now = new Date() }) {
        if (!SCOPES.includes(scope)) {
            throw new AssistantAccessError('BAD_SCOPE', `scope must be one of ${SCOPES.join(', ')}.`);
        }
        const current = await this.decision();
        if (current.scope === scope && current.decidedAt) return { decision: current, changed: false };
        const decision = { scope, decidedAt: utcText(now) };
        await state.set(KEY_PILOT, decision);
        return { decision, changed: true };
    }

    /** The owner: an active account holding the operator role. */
    async isOwner(userId) {
        if (!userId) return false;
        const account = await identityService.getAccount(String(userId));
        return Boolean(account && account.role === 'operator' && account.status === 'active');
    }

    /**
     * The capability a grant operation belongs to, or null when it is not
     * gated. Anything on an outside connector is `reach`, reads included
     * (DA-11d): the operation alone does not say, the resource kind does.
     */
    capabilityForOperation(operation, resourceKind = null) {
        if (Object.prototype.hasOwnProperty.call(OPERATION_CAPABILITY, operation)) return OPERATION_CAPABILITY[operation];
        return resourceKind === 'external' ? 'reach' : null;
    }

    /**
     * May this person use a gated capability? An unknown name is refused,
     * so a misspelt check fails closed.
     * @param {string} userId
     * @param {keyof CAPABILITIES} capability
     */
    async allows(userId, capability) {
        if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, capability)) return false;
        if ((await this.decision()).scope === 'everyone') return true;
        return this.isOwner(userId);
    }

    /** `allows` for a grant operation; an ungated operation is always allowed. */
    async allowsOperation(userId, operation, resourceKind = null) {
        const capability = this.capabilityForOperation(operation, resourceKind);
        if (!capability) return { ok: true, capability: null };
        return (await this.allows(userId, capability))
            ? { ok: true, capability }
            : { ok: false, code: REFUSAL_CODE, capability };
    }

    /** What one person has, for their own client. */
    async describe(userId) {
        const decision = await this.decision();
        const open = decision.scope === 'everyone' || await this.isOwner(userId);
        return {
            pilot: decision.scope,
            capabilities: Object.fromEntries(Object.keys(CAPABILITIES).map(name => [name, open])),
            gatedOperations: open ? [] : Object.keys(OPERATION_CAPABILITY)
        };
    }

    /** The gate as the host sees it. */
    async overview() {
        return {
            decision: await this.decision(),
            capabilities: Object.entries(CAPABILITIES).map(([name, increment]) => ({ name, increment })),
            gatedOperations: Object.keys(OPERATION_CAPABILITY)
        };
    }
}

module.exports = new AssistantAccessService();
module.exports.AssistantAccessService = AssistantAccessService;
module.exports.AssistantAccessError = AssistantAccessError;
module.exports.KEY_PILOT = KEY_PILOT;
module.exports.CAPABILITIES = CAPABILITIES;
module.exports.REFUSAL_CODE = REFUSAL_CODE;
