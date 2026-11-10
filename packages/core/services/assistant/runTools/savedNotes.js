/**
 * Run capability: delegated knowledge work on the person's own notes
 * (DA-11b, ADR 0027; documentation/delegated_knowledge.md).
 *
 *   findNotes / listNoteLinks   read (the ids and revisions the writes need)
 *   proposeNoteChange           kg.saved.propose   file a diff for the person to apply
 *   amendSavedNote              kg.saved.amend     change a saved note directly
 *   linkNotes / retractNoteLink kg.edge            connect, or retract a connection, with evidence
 *   archiveNote                 kg.archive         take a note out of retrieval (restorable)
 *   confirmNote                 kg.generated.amend add a run's confirmation to a note a run wrote
 *
 * A saved note is the person's own words. By default a run may only PROPOSE
 * a change: the proposal is filed and shown as a diff, and applying it is the
 * person's action on an authenticated surface (the gate registry), never a
 * tool. Direct editing exists only for a responsibility whose grant names
 * `kg.saved.amend`, and every direct edit is kept with its before and after
 * so it can be reverted. A run can archive only what the person has not
 * saved. Every write is atomic with its journal row and checks the revision
 * the run read.
 *
 * All of it is behind the owner-only pilot gate (assistantAccessService,
 * capability `reach`): the tool is not offered to anyone outside the pilot,
 * and each call asks again before it runs.
 */

const access = require('../../assistantAccessService');
const { clip } = require('./shared');

const CAPABILITY = 'reach';
const KNOWLEDGE = { kind: 'knowledge', id: 'personal' };

/** Offered when knowledge is on, the owner is in the pilot, and the grant names one of the operations. */
function offeredFor(...operations) {
    return ({ features, grants, capabilities }) => !features.enforcedOff('knowledge')
        && Boolean(capabilities?.[CAPABILITY])
        && (grants || []).some(entry => operations.includes(entry?.operation));
}

const WRITE_OPERATIONS = ['kg.saved.propose', 'kg.saved.amend', 'kg.edge', 'kg.archive', 'kg.generated.amend'];

/** Asked after authorize() allowed the call: the pilot decision, read now. */
async function pilotGuard(_args, ctx) {
    return (await access.allows(ctx.run.ownerUserId, CAPABILITY)) ? null : access.REFUSAL_CODE;
}

const runOf = (ctx) => ({
    id: ctx.run.id,
    responsibilityId: ctx.run.responsibilityId,
    responsibilityRevision: ctx.run.responsibilityRevision,
    initiativeId: ctx.run.initiativeId
});
const changeSets = () => require('../../knowledgeChangeSetService');
const graph = () => require('../../knowledgeGraphService');

const state = (note) => {
    const kind = note.curation === 'saved' ? 'saved' : note.generated ? 'generated' : note.curation === 'memory' ? 'memory' : 'unclassified';
    const claim = note.claimStatus && note.claimStatus !== 'current' ? `, ${note.claimStatus}` : '';
    return `${kind}${claim}`;
};

const NOT_PROPOSED = {
    NOT_FOUND: 'Not proposed: no such note.',
    ARCHIVED: 'Not proposed: that note is archived.',
    NOT_SAVED: 'Not proposed: only a note the person saved needs a proposal. A note you generated can be amended directly with amendGeneratedNote.',
    REVISION_CONFLICT: 'Not proposed: the note changed since you read it. Read it again with findNotes before deciding.',
    NO_CHANGE: 'Not proposed: that would not change the note.',
    BAD_REQUEST: 'Not proposed: give the note id, the revision you read, and either new content or a reason it is disputed.',
    RUN_LIMIT: 'Not proposed: this task has already filed as many changes as it may. Say the rest in your report.',
    TOO_MANY_OPEN: 'Not proposed: this responsibility already has as many proposals waiting for the person as it may. Do not file more until they decide.'
};

module.exports = {
    findNotes: {
        effect: 'read',
        source: 'private',
        available: offeredFor(...WRITE_OPERATIONS),
        definition: {
            name: 'findNotes',
            description: 'Find the person\'s own notes by a word in the title or text, with each note\'s id, revision and state (saved, generated, memory). Use the ids and revisions in the note tools.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'A word or phrase to look for. Empty lists the most recent notes.' } }
            }
        },
        needs: () => ({ operation: 'read', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ query }, ctx) {
            const notes = await graph().findPersonalNotes({ guildId: ctx.scope, userId: ctx.actor, query: query || '' });
            return notes.length
                ? notes.map(note => `#${note.id} (revision ${note.revision}, ${state(note)}) ${note.label}: ${clip(note.content || '', 300)}`).join('\n')
                : 'No notes match.';
        }
    },
    listNoteLinks: {
        effect: 'read',
        source: 'private',
        available: offeredFor('kg.edge'),
        definition: {
            name: 'listNoteLinks',
            description: 'List the live connections of one note, with each connection\'s id and revision, so one can be retracted.',
            parameters: { type: 'object', properties: { id: { type: 'integer', description: 'The note id.' } }, required: ['id'] }
        },
        needs: () => ({ operation: 'read', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ id }, ctx) {
            const edges = await graph().listPersonalEdges({ guildId: ctx.scope, userId: ctx.actor, nodeId: id });
            return edges.length
                ? edges.map(edge => `connection ${edge.id} (revision ${edge.revision}): #${edge.sourceId} "${edge.sourceLabel}" -${edge.relation}-> #${edge.targetId} "${edge.targetLabel}"`).join('\n')
                : 'That note has no live connections.';
        }
    },
    proposeNoteChange: {
        effect: 'write',
        atomic: true,
        proposes: true,
        component: 'knowledge',
        available: offeredFor('kg.saved.propose'),
        definition: {
            name: 'proposeNoteChange',
            description: 'Suggest a change to a note the person saved. Nothing is changed: the person sees the difference and decides. Give new full text, or mark the note as disputed with the reason (the text stays), or both. Say where the evidence came from in the rationale.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    revision: { type: 'integer', description: 'The revision you read with findNotes.' },
                    content: { type: 'string', description: 'The full new text of the note.' },
                    disputeReason: { type: 'string', description: 'Why the note\'s claim is contradicted by evidence you found.' },
                    rationale: { type: 'string', description: 'Why, and where it came from.' }
                },
                required: ['id', 'revision', 'rationale']
            }
        },
        needs: () => ({ operation: 'kg.saved.propose', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ id, revision, content, disputeReason, rationale }, ctx) {
            const filed = await changeSets().propose({
                guildId: ctx.scope, userId: ctx.actor, run: runOf(ctx), nodeId: id, expectedRevision: revision,
                content, disputeReason, rationale
            });
            if (!filed.ok) return NOT_PROPOSED[filed.code] || 'Not proposed.';
            return filed.existing
                ? `Not proposed again: proposal ${filed.id} for note #${id} is already waiting for the person.`
                : `Proposed a change to note #${id} for the person to apply (proposal ${filed.id}). Nothing was changed.`;
        }
    },
    amendSavedNote: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        available: offeredFor('kg.saved.amend'),
        definition: {
            name: 'amendSavedNote',
            description: 'Change the text of a note the person saved, directly. Use only when the person clearly delegated editing; otherwise propose with proposeNoteChange. The previous text is kept and the person can revert it.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    revision: { type: 'integer', description: 'The revision you read with findNotes.' },
                    content: { type: 'string', description: 'The full new text.' },
                    rationale: { type: 'string', description: 'Why, and where it came from.' }
                },
                required: ['id', 'revision', 'content', 'rationale']
            }
        },
        needs: () => ({ operation: 'kg.saved.amend', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ id, revision, content, rationale }, ctx) {
            const done = await changeSets().recordDirect({
                guildId: ctx.scope, userId: ctx.actor, run: runOf(ctx), nodeId: id, expectedRevision: revision, content, rationale
            });
            if (!done.ok) {
                return ({
                    NOT_FOUND: 'Not amended: no such note.',
                    ARCHIVED: 'Not amended: that note is archived.',
                    NOT_SAVED: 'Not amended: that is not a note the person saved.',
                    REVISION_CONFLICT: 'Not amended: the note changed since you read it. Read it again before deciding.',
                    NO_CHANGE: 'Not amended: that would not change the note.',
                    BAD_REQUEST: 'Not amended: give the note id, the revision you read and the new text.',
                    RUN_LIMIT: 'Not amended: this task has already changed as much as it may.'
                })[done.code] || 'Not amended.';
            }
            return `Changed saved note #${id}; the previous text is kept and can be reverted (change ${done.id}).`;
        }
    },
    linkNotes: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        available: offeredFor('kg.edge'),
        definition: {
            name: 'linkNotes',
            description: 'Connect two of the person\'s notes with a named relationship. The connection records this task as its evidence, or a third note you name as the evidence. A connection the person removed is not brought back.',
            parameters: {
                type: 'object',
                properties: {
                    sourceId: { type: 'integer' },
                    sourceRevision: { type: 'integer', description: 'The source note\'s revision, from findNotes.' },
                    targetId: { type: 'integer' },
                    targetRevision: { type: 'integer', description: 'The target note\'s revision, from findNotes.' },
                    relation: { type: 'string', description: 'A short verb phrase, e.g. "supports", "part of", "caused".' },
                    evidenceNoteId: { type: 'integer', description: 'Optional: a note that is the evidence for the connection.' }
                },
                required: ['sourceId', 'sourceRevision', 'targetId', 'targetRevision', 'relation']
            }
        },
        needs: () => ({ operation: 'kg.edge', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run(args, ctx) {
            const kg = graph();
            let evidenceKind = 'run';
            let evidenceId = ctx.run.id;
            if (args.evidenceNoteId != null) {
                const evidence = await kg.getPersonalNote({ guildId: ctx.scope, userId: ctx.actor, nodeId: args.evidenceNoteId });
                if (!evidence || evidence.archivedAt) return 'Not linked: the evidence note was not found.';
                evidenceKind = 'note';
                evidenceId = evidence.id;
            }
            const linked = await kg.linkNotes({
                guildId: ctx.scope, userId: ctx.actor, sourceId: args.sourceId, targetId: args.targetId, relation: args.relation,
                expectedSourceRevision: args.sourceRevision, expectedTargetRevision: args.targetRevision,
                evidenceKind, evidenceId, originRunId: ctx.run.id
            });
            if (!linked.ok) {
                return ({
                    NOT_FOUND: 'Not linked: one of those notes was not found.',
                    ARCHIVED: 'Not linked: one of those notes is archived.',
                    REVISION_CONFLICT: 'Not linked: one of the notes changed since you read it. Read them again before deciding.',
                    RETRACTED_BY_USER: 'Not linked: the person removed that connection. Do not bring it back.',
                    BAD_REQUEST: 'Not linked: give two different notes and a relationship.'
                })[linked.code] || 'Not linked.';
            }
            if (linked.existing) return `Not linked: #${args.sourceId} and #${args.targetId} are already connected that way.`;
            return `Connected #${args.sourceId} -${String(args.relation).trim().slice(0, 60)}-> #${args.targetId} (connection ${linked.id}).`;
        }
    },
    retractNoteLink: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        available: offeredFor('kg.edge'),
        definition: {
            name: 'retractNoteLink',
            description: 'Retract one connection between notes. It is kept, not deleted, and the person can restore it. Use ids and revisions from listNoteLinks.',
            parameters: {
                type: 'object',
                properties: { edgeId: { type: 'integer' }, revision: { type: 'integer', description: 'The connection\'s revision, from listNoteLinks.' } },
                required: ['edgeId', 'revision']
            }
        },
        needs: () => ({ operation: 'kg.edge', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ edgeId, revision }, ctx) {
            const done = await graph().retractEdge({
                guildId: ctx.scope, userId: ctx.actor, edgeId, expectedRevision: revision, by: 'run'
            });
            if (!done.ok) {
                return ({
                    NOT_FOUND: 'Not retracted: no such connection.',
                    ALREADY_RETRACTED: 'Not retracted: that connection is already retracted.',
                    REVISION_CONFLICT: 'Not retracted: the connection changed since you read it. List it again before deciding.'
                })[done.code] || 'Not retracted.';
            }
            return `Retracted connection ${edgeId}; it is kept and can be restored.`;
        }
    },
    archiveNote: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        available: offeredFor('kg.archive'),
        definition: {
            name: 'archiveNote',
            description: 'Archive a note you or the system wrote and that the person did not save: it leaves retrieval but is kept and the person can restore it with its connections. A note the person saved cannot be archived by you.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'integer' }, revision: { type: 'integer', description: 'The revision you read with findNotes.' } },
                required: ['id', 'revision']
            }
        },
        needs: () => ({ operation: 'kg.archive', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ id, revision }, ctx) {
            const done = await graph().archiveNote({
                guildId: ctx.scope, userId: ctx.actor, nodeId: id, expectedRevision: revision, by: 'run'
            });
            if (!done.ok) {
                return ({
                    NOT_FOUND: 'Not archived: no such note.',
                    ALREADY_ARCHIVED: 'Not archived: that note is already archived.',
                    SAVED_NOTE: 'Not archived: the person saved that note, so it is theirs. Suggest it in your report instead.',
                    REVISION_CONFLICT: 'Not archived: the note changed since you read it. Read it again before deciding.'
                })[done.code] || 'Not archived.';
            }
            return `Archived note #${id}; it is kept and can be restored with its connections.`;
        }
    },
    confirmNote: {
        effect: 'write',
        atomic: true,
        quiet: true,
        available: offeredFor('kg.generated.amend'),
        definition: {
            name: 'confirmNote',
            description: 'Record that your findings independently confirm a note a task wrote earlier. It adds your confirmation to the note\'s evidence once and raises its confidence a little; it adds no note and tells the person nothing. A task cannot confirm its own earlier finding.',
            parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
        },
        needs: () => ({ operation: 'kg.generated.amend', resource: KNOWLEDGE }),
        guard: pilotGuard,
        async run({ id }, ctx) {
            const done = await graph().confirmGeneratedNote({
                guildId: ctx.scope, userId: ctx.actor, nodeId: id, runId: ctx.run.id, responsibilityId: ctx.run.responsibilityId
            });
            if (!done.ok) {
                return ({
                    NOT_FOUND: 'Not confirmed: no such note.',
                    ARCHIVED: 'Not confirmed: that note is archived.',
                    NOT_GENERATED: 'Not confirmed: that note is the person\'s own; leave it as it is.',
                    ALREADY_COUNTED: 'Not confirmed: this task already confirmed that note.',
                    SELF_CORROBORATION: 'Not confirmed: this responsibility wrote that finding, and a finding cannot confirm itself.'
                })[done.code] || 'Not confirmed.';
            }
            return `Noted: note #${id} now has ${done.sources} confirming source${done.sources === 1 ? '' : 's'}.`;
        }
    }
};
