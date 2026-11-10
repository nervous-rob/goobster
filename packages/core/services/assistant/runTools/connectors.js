/**
 * Run capability: outside connectors (DA-11d, ADR 0028;
 * documentation/delegated_connectors.md).
 *
 * Three tools over the connector registry, none of them specific to any
 * service:
 *  - `listConnectors` tells the run which connector resources its grant
 *    names and what each can read and write. It reads only the grant.
 *  - `readConnector` runs a manifest read on a granted resource. Needs
 *    `read` on that `external` resource. What it returns is the person's
 *    own data from outside, so it is a private source: a run that used it
 *    can never write outside this installation or into a shared project.
 *  - `writeConnector` runs a manifest write. Needs `external.write` on that
 *    resource, counts against `externalOperations`, is never allowed after
 *    a private read, says it cannot be undone, and after a crash is
 *    reconciled with the outside service (or stops for review when the
 *    manifest cannot say) before anything is tried again.
 *
 * Both are offered only to a run whose responsibility grants the operation
 * on an `external` resource and whose owner is in the pilot
 * (assistantAccessService, capability `reach`). Each call checks that again
 * in its guard, with the connector's feature and the person's credential.
 * The credential is read from `user_integrations` for the one call and
 * handed to the adapter; it is never in a result, a journal row or a log.
 */

const db = require('../../../db');
const access = require('../../assistantAccessService');
const connectorService = require('../../assistantConnectorService');
const registry = require('../connectors/registry');
const integrations = require('../../userIntegrationService');
const { features } = require('../../../features/featureState');
const { clip } = require('./shared');

const CAPABILITY = 'reach';
const DETAIL_CHARS = 300;
const operationId = (ctx) => `${ctx.run.id}:${ctx.opId}`;

const refOf = (args) => registry.refOf(String(args?.connector ?? '').trim(), String(args?.resource ?? '').trim());

/** The connector, operation and resource a call names, or a refusal code. */
function resolve(kind, args) {
    const connector = registry.get(String(args?.connector ?? '').trim());
    if (!connector) return { refuse: 'NO_SUCH_CONNECTOR' };
    const operation = registry.operationOf(connector, kind, String(args?.operation ?? '').trim());
    if (!operation) return { refuse: 'NO_SUCH_OPERATION' };
    const resource = String(args?.resource ?? '').trim();
    if (!registry.validResource(connector, resource)) return { refuse: 'BAD_RESOURCE' };
    const problem = registry.inputProblem(operation, args?.input);
    if (problem) return { refuse: problem };
    return { connector, operation, resource, input: args?.input && typeof args.input === 'object' ? args.input : {} };
}

/** What authorize() must allow: the operation on this connector's named resource. */
function needsFor(kind) {
    return (args) => {
        const found = resolve(kind, args);
        if (found.refuse) return { refuse: found.refuse };
        return { operation: kind === 'write' ? 'external.write' : 'read', resource: { kind: 'external', id: refOf(args) } };
    };
}

/**
 * Asked after authorize() allowed the call: the pilot gate, the
 * connector's feature and the person's credential, each checked again
 * where the call is dispatched. Returns a refusal code, or null.
 */
async function guard(args, ctx) {
    if (!(await access.allows(ctx.run.ownerUserId, CAPABILITY))) return access.REFUSAL_CODE;
    const connector = registry.get(String(args?.connector ?? '').trim());
    if (!connector) return 'NO_SUCH_CONNECTOR';
    if (connector.feature && features.enforcedOff(connector.feature)) return 'FEATURE_UNAVAILABLE';
    if (!(await connectorService.connected(ctx.actor, connector))) return 'NO_CREDENTIAL';
    return null;
}

/** Offered when the grant names the operation on an external resource and the owner is in the pilot. */
function offeredFor(...operations) {
    return ({ grants, capabilities }) => Boolean(capabilities?.[CAPABILITY]) && registry.list().length > 0
        && (grants || []).some(entry => operations.includes(entry?.operation) && entry.resource?.kind === 'external');
}

const unwrap = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const detailOf = (text) => clip(unwrap(text), DETAIL_CHARS).replace(/[.\s]+$/, '');

const declinedText = (verb, error) => `Not ${verb} (${error.code}): ${detailOf(error.message) || 'the outside service did not do it'}.`;

const PARAMS = {
    connector: { type: 'string', description: 'The connector id, as listConnectors names it.' },
    resource: { type: 'string', description: 'The named resource, as listConnectors names it (the part after the colon).' },
    operation: { type: 'string', description: 'One of the connector\'s operations for this kind of call.' },
    input: { type: 'object', description: 'What the operation takes; see its description in listConnectors.' }
};

module.exports = {
    listConnectors: {
        effect: 'read',
        available: offeredFor('read', 'external.write'),
        definition: {
            name: 'listConnectors',
            description: 'List the outside connector resources this task may use, and for each what it can read and write. Writes cannot be undone from here.',
            parameters: { type: 'object', properties: {} }
        },
        needs: () => null,
        async guard(args, ctx) {
            return (await access.allows(ctx.run.ownerUserId, CAPABILITY)) ? null : access.REFUSAL_CODE;
        },
        async run(args, ctx) {
            const row = await db.get('SELECT operationsJson FROM assistant_responsibilities WHERE id = @id', { id: ctx.run.responsibilityId });
            let grants;
            try { grants = JSON.parse(row?.operationsJson || '[]'); } catch { grants = []; }
            const lines = [];
            for (const entry of grants) {
                if (entry?.resource?.kind !== 'external') continue;
                const canRead = entry.operation === 'read';
                const canWrite = entry.operation === 'external.write';
                if (!canRead && !canWrite) continue;
                for (const id of entry.resource.ids || []) {
                    const parsed = registry.parseRef(id);
                    if (!parsed) continue;
                    const { connector, resource } = parsed;
                    const ops = (canRead ? connector.reads : connector.writes)
                        .map(op => `${op.operation} (${op.describe})`).join('; ');
                    lines.push(`${connector.id} / ${resource}: ${connector.name}, ${canRead ? 'read' : 'write'}: ${ops || 'nothing'}`);
                }
            }
            return lines.length ? lines.join('\n') : 'No connector resource is available to this task.';
        }
    },
    readConnector: {
        effect: 'read',
        // What comes back is the person's own data from outside: never copied outward or into a shared project.
        source: 'private',
        available: offeredFor('read'),
        definition: {
            name: 'readConnector',
            description: 'Read from an outside connector resource the task was granted, as the person. Reading changes nothing outside. What it returns is the person\'s own data, so after reading you cannot write outside this installation.',
            parameters: { type: 'object', properties: PARAMS, required: ['connector', 'resource', 'operation'] }
        },
        needs: needsFor('read'),
        guard,
        async run(args, ctx) {
            const found = resolve('read', args);
            if (found.refuse) return `Not read (${found.refuse}).`;
            try {
                return clip(String(await invoke(found, null, ctx)), 12_000);
            } catch (error) {
                if (error?.declined === true) return declinedText('read', error);
                throw error;
            }
        }
    },
    writeConnector: {
        effect: 'write',
        budget: 'externalOperations',
        component: 'responsibilities',
        publishes: 'external',
        available: offeredFor('external.write'),
        definition: {
            name: 'writeConnector',
            description: 'Write to an outside connector resource the task was granted, as the person. It cannot be undone from here and counts against a small daily budget of outside operations. If it is refused or its outcome is unknown, report that; never try it again another way.',
            parameters: { type: 'object', properties: PARAMS, required: ['connector', 'resource', 'operation'] }
        },
        needs: needsFor('write'),
        guard,
        _text: (connector, resource, detail) => `Wrote to ${connector.name} (${resource}): ${detailOf(detail) || 'done'}. That cannot be undone from here.`,
        /**
         * After a crash: ask the outside service by this operation's identity.
         * A manifest write without `reconcile`, or one that cannot be asked,
         * is unknown, which stops the work for review and is never retried.
         */
        async reconcile(args, ctx) {
            const found = resolve('write', args);
            if (found.refuse || !found.operation.reconcile) return { state: 'unknown' };
            if (!(await connectorService.connected(ctx.actor, found.connector))) return { state: 'unknown' };
            const token = await integrations.getToken(ctx.actor, found.connector.credential.provider);
            if (!token) return { state: 'unknown' };
            const verdict = await found.operation.reconcile({
                resource: found.resource, input: found.input, token, operationId: operationId(ctx)
            });
            if (verdict?.state === 'done') return { state: 'done', result: this._text(found.connector, found.resource, verdict.result) };
            return { state: verdict?.state === 'absent' ? 'absent' : 'unknown' };
        },
        async run(args, ctx) {
            const found = resolve('write', args);
            if (found.refuse) return `Not written (${found.refuse}).`;
            try {
                return this._text(found.connector, found.resource, await invoke(found, operationId(ctx), ctx));
            } catch (error) {
                // Certainly nothing changed: a result, not a failure. Anything else may have happened.
                if (error?.declined === true) return declinedText('written', error);
                throw error;
            }
        }
    }
};

/** Run one manifest operation with the acting person's own credential. */
async function invoke(found, opId, ctx) {
    const token = await integrations.getToken(ctx.actor, found.connector.credential.provider);
    if (!token) throw registry.declined('NO_CREDENTIAL', 'no credential is connected for that service');
    return found.operation.run({ resource: found.resource, input: found.input, token, ...(opId ? { operationId: opId } : {}) });
}
