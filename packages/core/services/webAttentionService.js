/**
 * The Assistant Inbox, portal side: one shape for everything the Noticed
 * pane renders, plus the writes that make dismissal a feedback signal rather
 * than a delete.
 *
 * Read-only enrollment is deliberate here — the pane can turn attention on
 * and tune it, but it cannot create open loops. Loops come from evidence
 * (a conversation, a reflection pass, a tool call Goobster made), never from
 * a form: the whole point of a ledger of *beliefs* is that they are traceable
 * to something that happened.
 *
 * Errors follow the PanelError status+code contract, so the route wrappers in
 * web/appApi.js map them without knowing anything about attention.
 */

const attentionService = require('./attentionService');
const attentionLedgerService = require('./attentionLedgerService');
const attentionPolicyService = require('./attentionPolicyService');
const attentionWatchService = require('./attentionWatchService');
const config = require('../config/attentionConfig');

class WebAttentionError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebAttentionError';
        this.status = status;
        this.code = code;
    }
}

class WebAttentionService {
    /**
     * Everything the pane shows: the policy, the inbox, the ledger, armed
     * watches, and the current per-category calibration.
     * @param {Object} params - { userId }
     */
    async getOverview({ userId }) {
        const policy = await attentionPolicyService.get(userId);
        if (!policy) {
            // Not enrolled is a first-class state, not an error: the pane
            // renders the explanation and the opt-in button.
            return {
                enrolled: false,
                policy: null,
                notices: [],
                items: [],
                watches: [],
                calibration: [],
                initiativeLevels: config.INITIATIVE_LEVELS,
                categories: config.CATEGORIES
            };
        }
        const [notices, items, watches, calibration] = await Promise.all([
            attentionService.listNotices({ userId, limit: 60 }),
            attentionLedgerService.listItems({ userId, limit: 60 }),
            attentionWatchService.list({ userId, statuses: ['ARMED', 'FIRED', 'FAILED'], limit: 25 }),
            attentionService.getCalibration(userId)
        ]);
        return {
            enrolled: policy.enabled,
            policy,
            notices,
            items,
            watches,
            calibration,
            boundaries: Object.fromEntries(
                config.CATEGORIES.map(category =>
                    [category, attentionPolicyService.boundariesFor(policy, category)])
            ),
            initiativeLevels: config.INITIATIVE_LEVELS,
            categories: config.CATEGORIES
        };
    }

    /**
     * Turn attention on (or back on), optionally setting the level.
     * @param {Object} params - { userId, initiative }
     */
    async enroll({ userId, initiative = null }) {
        try {
            return initiative
                ? { policy: await attentionPolicyService.setInitiative(userId, initiative) }
                : { policy: await attentionPolicyService.enroll({ userId }) };
        } catch (error) {
            throw new WebAttentionError(400, error.code || 'BAD_REQUEST', error.message);
        }
    }

    /**
     * Stop proactive attention. The ledger and settings survive, so this is
     * a pause rather than an erasure (/forget-me is the erasure).
     * @param {Object} params - { userId }
     */
    async disable({ userId }) {
        return { disabled: await attentionPolicyService.disable(userId) };
    }

    /**
     * Tune the policy: level, contact budget, quiet hours, or one category
     * boundary. Every field is optional; only what is sent changes.
     * @param {Object} params
     */
    async updatePolicy({
        userId,
        initiative = null,
        maxContactsPerDay = null,
        contactCooldownMinutes = null,
        quietStartMinute,
        quietEndMinute,
        boundary = null
    }) {
        const existing = await attentionPolicyService.get(userId);
        if (!existing) {
            throw new WebAttentionError(409, 'NOT_ENROLLED',
                'Turn on proactive attention first.');
        }
        try {
            if (initiative) await attentionPolicyService.setInitiative(userId, initiative);
            if (maxContactsPerDay !== null || contactCooldownMinutes !== null) {
                await attentionPolicyService.setBudget({
                    userId, maxContactsPerDay, contactCooldownMinutes
                });
            }
            if (quietStartMinute !== undefined || quietEndMinute !== undefined) {
                await attentionPolicyService.setQuietHours({
                    userId,
                    startMinute: quietStartMinute ?? null,
                    endMinute: quietEndMinute ?? null
                });
            }
            if (boundary?.category) {
                await attentionPolicyService.setBoundary({ userId, ...boundary });
            }
        } catch (error) {
            throw new WebAttentionError(400, error.code || 'BAD_REQUEST', error.message);
        }
        return { policy: await attentionPolicyService.get(userId) };
    }

    /**
     * React to a notice. Dismissing is the feedback that raises the bar for
     * that category next time, which is why the pane has no plain delete.
     * @param {Object} params - { userId, noticeId, action, snoozeHours }
     */
    async actOnNotice({ userId, noticeId, action, snoozeHours = null }) {
        const notice = await attentionService.actOnNotice({
            userId,
            noticeId,
            action,
            snoozeHours: snoozeHours ?? 24
        });
        if (!notice) {
            throw new WebAttentionError(404, 'NOT_FOUND',
                'No such notice, or that is not something you can do to it.');
        }
        return { notice };
    }

    /**
     * Close or drop one open loop. Resolving a loop is the user telling
     * Goobster he can stop watching it, which is genuinely useful signal.
     * @param {Object} params - { userId, itemId, state }
     */
    async resolveItem({ userId, itemId, state = 'resolved' }) {
        const item = await attentionLedgerService.getItem(itemId);
        if (!item || item.userId !== userId) {
            throw new WebAttentionError(404, 'NOT_FOUND', 'No such open loop.');
        }
        if (state !== 'resolved' && state !== 'abandoned') {
            throw new WebAttentionError(400, 'BAD_STATE',
                'A loop can be resolved (finished) or abandoned (stopped mattering).');
        }
        await attentionLedgerService.setState(item.id, state);
        return { item: await attentionLedgerService.getItem(item.id) };
    }

    /**
     * Why a loop is believed - the provenance trail behind one item.
     * @param {Object} params - { userId, itemId }
     */
    async getItemProvenance({ userId, itemId }) {
        const item = await attentionLedgerService.getItem(itemId);
        if (!item || item.userId !== userId) {
            throw new WebAttentionError(404, 'NOT_FOUND', 'No such open loop.');
        }
        return { item, provenance: await attentionLedgerService.getProvenance(item.id) };
    }

    /**
     * Disarm a watch.
     * @param {Object} params - { userId, watchId }
     */
    async cancelWatch({ userId, watchId }) {
        const cancelled = await attentionWatchService.cancel({ userId, id: watchId });
        if (!cancelled) {
            throw new WebAttentionError(404, 'NOT_FOUND', 'No such armed watch.');
        }
        return { cancelled: true };
    }
}

module.exports = new WebAttentionService();
module.exports.WebAttentionService = WebAttentionService;
module.exports.WebAttentionError = WebAttentionError;
