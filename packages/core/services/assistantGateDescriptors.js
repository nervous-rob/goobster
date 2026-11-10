/**
 * The built-in gate decision descriptors (DA-7a; documentation/assistant_home.md,
 * "Deciding a request where it is shown").
 *
 * One descriptor per gate kind, registered once in `assistantGateService`.
 * Home, the Inbox and (later) a chat card render what `describe` returns and
 * dispatch through `assistantGateService.decide`, so every surface reaches
 * the same domain operation. A descriptor never writes an outcome itself:
 *
 *   describe(gate, viewer) -> null when this person may not act on it, else
 *     { state: 'open'|'resolved', title, detail, outcome, revision,
 *       options: [{ id, label, effect, danger? }] }
 *   decide(gate, viewer, optionId, { occurrence, revision, surface, gateway })
 *     -> { message }   after calling the owning domain service
 *   settle(gate, viewer)   optional: reconcile the canonical update afterwards
 *   staleCodes             domain error codes that mean "this changed under you"
 *   inboxSourceType        for a request that lives on its own Inbox item
 *
 * `state`, `revision` and the options come from the domain record, read now.
 * `revision` names the state the options were derived from: a decision that
 * carries another one is refused as stale before the domain is called.
 */

const { features } = require('../features/featureState');
const requireOptional = require('../utils/optionalModule').forModule(module);

/** Thrown by a descriptor when the domain moved between describe and decide. */
function stale() {
    return Object.assign(new Error('This request changed.'), { status: 409, code: 'STALE_GATE' });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// --- Mission plan approval and start (gate kind `project_approve`) ----------

const MISSION_OUTCOME = {
    DRAFT: 'The plan changed and is waiting for approval again.',
    APPROVED: 'The plan is approved and waiting to be started.',
    ACTIVE: 'The mission has started.',
    BLOCKED: 'The mission has started and is blocked.',
    REVIEW: 'The mission is waiting for review.',
    COMPLETED: 'The mission is complete.',
    CANCELLED: 'The mission was cancelled.'
};

/** `approve:<missionId>` or `start:<missionId>`, in the project the update links to. */
function missionTarget(gate) {
    const match = /^(approve|start):(\d+)$/.exec(String(gate.id));
    const link = (gate.actions || []).find(action => action.kind === 'open_project');
    const [owner, project] = String(link?.id || '').split('/');
    if (!match || !owner || !project) return null;
    return { step: match[1], missionId: Number(match[2]), owner, project };
}

const missionService = () => (features.enforcedOff('projects')
    ? null
    : requireOptional('./projectMissionService', { feature: 'projects' }));

const projectApprove = {
    staleCodes: ['BAD_STATUS', 'NEEDS_APPROVAL', 'NO_MISSION', 'HUMAN_ONLY'],

    async describe(gate, viewer) {
        const missions = missionService();
        const target = missionTarget(gate);
        if (!missions || !target) return null;
        let mission;
        try {
            mission = await missions.get({
                userId: viewer.userId, project: target.project, owner: target.owner, missionId: target.missionId
            });
        } catch (error) {
            // Gone, or not this person's to see: there is nothing to offer.
            if (error?.status && error.status < 500) return null;
            throw error;
        }
        const approving = target.step === 'approve';
        const open = mission.status === (approving ? 'DRAFT' : 'APPROVED');
        const steps = plural((mission.steps || []).length, 'step');
        return {
            state: open ? 'open' : 'resolved',
            title: `${mission.projectName}: ${approving ? 'approve the plan for' : 'start'} "${mission.title}"`,
            detail: approving
                ? `Approving accepts revision ${mission.planRevision} of the plan as written (${steps}). Nothing runs until the mission is started, and a later change to the plan needs approval again.`
                : `Starting runs the approved plan (revision ${mission.planRevision}, ${steps}): its steps begin within the mission's budget.`,
            outcome: open ? null : (MISSION_OUTCOME[mission.status] || 'This request is no longer open.'),
            revision: `plan:${mission.planRevision}`,
            options: approving
                ? [{ id: 'approve', label: 'Approve plan', effect: `Approves revision ${mission.planRevision} of the plan. Nothing starts.` }]
                : [{ id: 'start', label: 'Start mission', effect: 'The mission becomes active and its steps begin.' }]
        };
    },

    async decide(gate, viewer, optionId, { revision }) {
        const missions = missionService();
        const target = missionTarget(gate);
        if (!missions || !target || optionId !== target.step) throw stale();
        const args = { userId: viewer.userId, project: target.project, owner: target.owner, missionId: target.missionId };
        if (target.step === 'start') {
            const started = await missions.start(args);
            return { message: `Started "${started.title}".` };
        }
        // The receipt is minted here, on a human surface, and is bound to the
        // plan revision. It must be the revision the person was shown.
        const receipt = await missions.mintApprovalReceipt({ ...args, origin: 'portal' });
        if (`plan:${receipt.planRevision}` !== String(revision)) throw stale();
        const approved = await missions.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
        return { message: `Approved the plan for "${approved.title}". Nothing runs until you start it.` };
    },

    /** The project owns the gate; the adopted update follows it now rather than at the next pass. */
    async settle(gate) {
        if (gate.audienceUserId) await require('./assistantGateService').adoptProjectGates({ userId: gate.audienceUserId });
    }
};

// --- Friend request (its own Inbox item) --------------------------------------

const FRIEND_OUTCOME = {
    accepted: 'You accepted this request.',
    declined: 'You declined this request.',
    cancelled: 'They withdrew this request.'
};

const friendRequest = {
    inboxSourceType: 'friend_request',
    staleCodes: ['REQUEST_SETTLED', 'NO_SUCH_REQUEST'],

    async describe(gate, viewer) {
        const friends = require('./friendService');
        const found = await friends.describeForRows([{ sourceType: friends.SOURCE_TYPE, sourceId: gate.id }]);
        const request = found.get(String(gate.id));
        // Only the person it is addressed to may answer it.
        if (!request || request.addresseeId !== String(viewer.userId)) return null;
        const open = request.status === 'pending';
        return {
            state: open ? 'open' : 'resolved',
            title: `${request.requesterName} wants to be friends`,
            detail: 'Friends see when each other is in the portal and can message each other. Declining is not announced to them.',
            outcome: open ? null : (FRIEND_OUTCOME[request.status] || 'This request is no longer open.'),
            // The row is reused when the same person asks again; each ask is its own request.
            revision: request.createdAt,
            options: [
                { id: 'accept', label: 'Accept', effect: `You and ${request.requesterName} become friends.` },
                { id: 'decline', label: 'Decline', effect: 'The request closes. They are not told.' }
            ]
        };
    },

    async decide(gate, viewer, optionId, { gateway }) {
        const friends = require('./friendService');
        const accept = optionId === 'accept';
        const { request } = await friends.respond({
            userId: viewer.userId, userName: viewer.userName || null, requestId: gate.id, accept, gateway
        });
        return { message: accept ? `You and ${request.requesterName} are friends now.` : 'Declined - they are not told.' };
    }
};

// --- Request to join the installation (the host's own Inbox item) -------------

async function isActiveOperator(userId) {
    const account = await require('./identityService').getAccount(String(userId));
    return Boolean(account && account.role === 'operator' && account.status === 'active');
}

const accessRequest = {
    inboxSourceType: 'access_request',
    staleCodes: ['ALREADY_RESOLVED', 'NOT_FOUND'],

    async describe(gate, viewer) {
        const requests = require('./accessRequestService');
        // The role is read now, never taken from the card: a former operator's item offers nothing.
        if (!await isActiveOperator(viewer.userId)) return null;
        let request;
        try {
            request = await requests.get(gate.id);
        } catch (error) {
            if (error?.code === 'NOT_FOUND') return null;
            throw error;
        }
        if (request.principalId === String(viewer.userId)) return null;
        const name = request.displayName || 'This person';
        const open = request.status === 'pending';
        return {
            state: open ? 'open' : 'resolved',
            title: `${name} is asking to join`,
            detail: 'Approve grants a member account; their Discord history stays theirs. Decline tells them the host did not let them in this time.',
            outcome: open ? null
                : `${request.status === 'approved' ? 'Approved' : 'Declined'}${request.resolvedByName ? ` by ${request.resolvedByName}` : ''}.`,
            revision: request.createdAt,
            options: [
                { id: 'approve', label: 'Approve', effect: `${name} gets a member account.` },
                { id: 'decline', label: 'Decline', effect: `${name} is told the host did not let them in this time.` }
            ]
        };
    },

    async decide(gate, viewer, optionId, { gateway, surface }) {
        const requests = require('./accessRequestService');
        const approve = optionId === 'approve';
        const args = { id: gate.id, resolvedBy: viewer.userId, gateway, via: surface };
        let request;
        try {
            request = approve ? await requests.approve(args) : await requests.decline(args);
        } catch (error) {
            if (error?.code !== 'DAILY_CAP_REQUIRED') throw error;
            // The cap gate refused the grant: nothing was decided and the request stays open.
            throw Object.assign(new Error(`${error.message} Then approve again - the request stays open.`, { cause: error }), {
                status: error.status || 409, code: error.code, details: error.details || null
            });
        }
        // Two operators can answer at once; the request keeps the first answer.
        if (request.status !== (approve ? 'approved' : 'declined')) throw stale();
        return {
            message: approve
                ? `${request.displayName || 'They'} now has an account.`
                : `Declined - ${request.displayName || 'they'} has been told.`
        };
    }
};

module.exports = {
    project_approve: projectApprove,
    friend_request: friendRequest,
    access_request: accessRequest
};
