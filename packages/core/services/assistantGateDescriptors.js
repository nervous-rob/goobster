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

// --- Delegated knowledge work (DA-11b, ADR 0027) ------------------------------
//
// Both kinds are decided by the person who owns the notes. `apply` here is the
// person's own click: the run that proposed it has no way to reach this.

const changeSets = () => require('./knowledgeChangeSetService');

const PROPOSAL_OUTCOME = {
    APPLIED: 'You applied this change. You can revert it from Knowledge changes.',
    REJECTED: 'You dismissed this suggestion. The note was not changed.',
    STALE: 'The note changed after this was suggested, so nothing was applied.',
    REVERTED: 'You applied this change and then reverted it.'
};
const RETRACTION_OUTCOME = {
    APPLIED: 'You marked those notes as disputed. You can revert it from Knowledge changes.',
    REJECTED: 'You left your notes as they are.',
    STALE: 'Those notes changed since the review, so nothing was changed.',
    REVERTED: 'You marked those notes as disputed and then reverted it.'
};

async function ownChangeSet(gate, viewer, kind) {
    const row = await changeSets().forPerson(gate.id, viewer.userId);
    return row && row.kind === kind ? row : null;
}

const noteProposal = {
    staleCodes: ['REVISION_CONFLICT', 'NOT_OPEN'],

    async describe(gate, viewer) {
        const row = await ownChangeSet(gate, viewer, 'saved_note_edit');
        if (!row) return null;
        const service = changeSets();
        const shown = service.present(row);
        const open = row.status === 'PROPOSED';
        // The note may have moved since the run read it: say so, and offer only to dismiss.
        const node = open ? await require('./knowledgeGraphService').getPersonalNote({
            guildId: row.guildId, userId: row.userId, nodeId: row.nodeId
        }) : null;
        const moved = open && (!node || node.archivedAt || Number(node.revision) !== Number(row.expectedRevision));
        const changes = [
            shown.operations.some(op => op.op === 'amend') ? 'replaces the text' : null,
            shown.claimStatus ? 'marks the note as disputed' : null
        ].filter(Boolean).join(' and ');
        return {
            state: open ? 'open' : 'resolved',
            title: `Suggested change to "${shown.label || 'a note'}"`,
            detail: moved
                ? 'The note changed after this was suggested, so it cannot be applied. Dismiss it; the next pass may suggest again from what is there now.'
                : `${shown.rationale ? `${shown.rationale} ` : ''}Applying ${changes || 'this'}; nothing changes until you do.`,
            diff: shown.diff,
            outcome: open ? null : (PROPOSAL_OUTCOME[row.status] || 'This request is no longer open.'),
            revision: `cs:${row.id}:${row.updatedAt}:${node ? node.revision : 'x'}`,
            options: [
                ...(moved ? [] : [{ id: 'apply', label: 'Apply change', effect: `Applies the change to your note${changes ? ` (it ${changes})` : ''}. You can revert it afterwards.` }]),
                { id: 'reject', label: 'Dismiss', effect: 'Leaves the note exactly as it is.' }
            ]
        };
    },

    async decide(gate, viewer, optionId) {
        const service = changeSets();
        try {
            return optionId === 'apply'
                ? await service.apply({ id: gate.id, userId: viewer.userId })
                : await service.reject({ id: gate.id, userId: viewer.userId });
        } catch (error) {
            if (error?.code === 'NOT_FOUND') throw stale();
            throw error;
        }
    }
};

const sourceRetraction = {
    staleCodes: ['REVISION_CONFLICT', 'NOT_OPEN'],

    async describe(gate, viewer) {
        const row = await ownChangeSet(gate, viewer, 'source_retraction');
        if (!row) return null;
        const shown = changeSets().present(row);
        const open = row.status === 'PROPOSED';
        const notes = shown.impact?.notes || [];
        const total = notes.length + (shown.impact?.moreNotes || 0);
        const assumptions = shown.impact?.assumptions || [];
        const names = notes.slice(0, 4).map(note => `"${note.label}"`).join(', ');
        return {
            state: open ? 'open' : 'resolved',
            title: `A source was withdrawn: ${shown.impact?.source?.label || 'a source'}`,
            detail: [
                `${plural(total, 'note')} cite${total === 1 ? 's' : ''} it${names ? `: ${names}${total > 4 ? ', and more' : ''}` : ''}.`,
                assumptions.length ? `${plural(assumptions.length, 'open project assumption')} rest${assumptions.length === 1 ? 's' : ''} on it.` : '',
                'The source being gone makes its claims unverifiable, not false. Nothing was deleted.'
            ].filter(Boolean).join(' '),
            outcome: open ? null : (RETRACTION_OUTCOME[row.status] || 'This request is no longer open.'),
            revision: `cs:${row.id}:${row.updatedAt}`,
            options: [
                ...(notes.length ? [{ id: 'apply', label: 'Mark as disputed', effect: 'Labels these notes as disputed. Their text stays; you can revert it.' }] : []),
                { id: 'reject', label: 'Keep as they are', effect: 'Leaves your notes exactly as they are.' }
            ]
        };
    },

    decide: noteProposal.decide
};

module.exports = {
    project_approve: projectApprove,
    friend_request: friendRequest,
    access_request: accessRequest,
    note_proposal: noteProposal,
    source_retraction: sourceRetraction
};
