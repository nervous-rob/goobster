/**
 * The manager HTTP API, under /manager/api/*, JSON only.
 *
 *   GET  /status                       none                      every state
 *   POST /claim                        bootstrap credential      unclaimed
 *   POST /recovery/unlock              recovery credential, local claimed, recovery
 *   GET  /features                     assertion or session      claimed, recovery (recovery session)
 *   GET  /operations                   assertion or session      claimed, recovery (recovery session)
 *   GET  /operations/:id               assertion or session      claimed, recovery (recovery session)
 *   POST /operations                   assertion or session      per kind
 *   POST /operations/:id/validate      assertion or session      per kind
 *   POST /operations/:id/apply         assertion or session      per kind
 *   POST /privileged/:name             assertion or session      501 for the declared names
 *
 * Every request must be addressed to the manager (Host); a mutation with an
 * Origin must come from the manager's own origin. Bodies are at most 64 KB.
 * Errors are `{ error: { code, message, details? } }` with no stack, path or
 * value. Exported as a builder so tests construct it without listening.
 */

const express = require('express');
const { ManagerError } = require('./errors');
const { createTransportGuards } = require('./auth/transport');
const coreBridge = require('@goobster/core/web/managerBridge');
const privileged = require('./privileged');
const { LABEL_SHAPE } = require('./engine/kinds/installation');

const BODY_LIMIT = '64kb';
const ACTOR_FIELDS = ['actor', 'principalId', 'actorId'];
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 10;

function sendError(res, error) {
    const status = error instanceof ManagerError ? error.status : 500;
    const body = error instanceof ManagerError
        ? error.toJSON()
        : { code: 'INTERNAL', message: 'Something went wrong.' };
    res.status(status).json({ error: body });
}

/**
 * @typedef {Object} RouteHelpers
 * @property {(handler: Function) => Function} route JSON wrapper with error mapping
 * @property {(req: Object) => import('./engine').EngineAuth} authenticate assertion or session, nonce-checked for mutations
 * @property {(req: Object) => import('./engine').EngineAuth} readAuth `authenticate` plus the state rule for reads
 * @property {(req: Object, principal: string|null) => void} checkActor refuse a body naming another actor
 * @property {(kind: string) => void} throttle
 * @property {(kind: string) => void} noteFailure
 * @property {ReturnType<import('./auth/transport').createTransportGuards>} guards
 */

/**
 * @param {ReturnType<import('./manager').createManager>} manager
 * @param {{ logger?: Object, now?: () => Date, mounts?: Array<(api: import('express').Router, helpers: RouteHelpers) => void> }} [options]
 *   `mounts` add route families (one module each under ./routes/) after the
 *   core routes and before the 404; they share the guards and auth helpers.
 */
function createManagerApp(manager, { logger = console, now = () => new Date(), mounts = [] } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.set('etag', false);
    const guards = createTransportGuards(manager.settings);
    const failures = new Map();

    const route = (handler) => async (req, res) => {
        try {
            const out = await handler(req, res);
            if (!res.headersSent) res.json(out);
        } catch (error) {
            if (!(error instanceof ManagerError)) {
                logger.error?.(`[manager] ${req.method} ${req.path} failed: ${error && (error.code || error.name)}`);
            }
            sendError(res, error);
        }
    };

    function throttle(kind) {
        const t = now().getTime();
        const entry = failures.get(kind);
        if (entry && t - entry.since < FAILURE_WINDOW_MS && entry.count >= MAX_FAILURES) {
            throw new ManagerError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts; wait a minute.');
        }
    }

    function noteFailure(kind) {
        const t = now().getTime();
        const entry = failures.get(kind);
        if (!entry || t - entry.since >= FAILURE_WINDOW_MS) failures.set(kind, { since: t, count: 1 });
        else entry.count++;
    }

    /** Refuse a body that names an actor other than the authenticated one; strip the field. */
    function checkActor(req, principal) {
        const body = req.body;
        if (!body || typeof body !== 'object') return;
        for (const field of ACTOR_FIELDS) {
            if (body[field] === undefined) continue;
            if (String(body[field]) !== String(principal ?? '')) {
                throw new ManagerError(403, 'ACTOR_MISMATCH', 'The request names a different actor than the one authenticated.');
            }
            delete body[field];
        }
    }

    /**
     * Who is calling: a bridge assertion (portal, per request) or a local
     * session (after claim or recovery unlock). Mutations with a session
     * carry a fresh X-Goobster-Nonce.
     * @returns {import('./engine').EngineAuth}
     */
    function authenticate(req) {
        const state = manager.currentState();
        const assertion = req.headers[coreBridge.ASSERTION_HEADER];
        const authorization = req.headers.authorization;
        if (assertion !== undefined && authorization !== undefined) {
            throw new ManagerError(400, 'AMBIGUOUS_AUTH', 'Send either a manager assertion or a session, not both.');
        }
        if (assertion !== undefined) {
            if (state.state !== 'claimed') {
                throw new ManagerError(409, 'STATE_NOT_ALLOWED', `The portal bridge is not available in the ${state.state} state.`, { state: state.state });
            }
            const verified = manager.bridge.verify(String(assertion), {
                method: req.method,
                path: req.baseUrl + req.path,
                installationId: state.installation.installationId
            });
            return { principal: verified.principalId, via: 'bridge' };
        }
        const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(String(authorization || ''));
        if (!match) throw new ManagerError(401, 'UNAUTHENTICATED', 'Authenticate with a manager assertion or a local session.');
        const session = manager.sessions.authenticate(match[1]);
        if (!session) throw new ManagerError(401, 'SESSION_INVALID', 'The session is not valid or has expired.');
        if (!guards.isLocalRequest(req)) {
            throw new ManagerError(403, 'LOCAL_ONLY', 'Local sessions work only from this machine (use an SSH tunnel).');
        }
        if (req.method !== 'GET') {
            const nonce = req.headers['x-goobster-nonce'];
            if (nonce === undefined) throw new ManagerError(400, 'NONCE_REQUIRED', 'A mutation needs a fresh X-Goobster-Nonce header.');
            if (!manager.sessions.useNonce(session, String(nonce))) {
                throw new ManagerError(401, 'NONCE_REPLAYED', 'That nonce was already used, or is malformed.');
            }
        }
        return { principal: session.principal, via: session.kind };
    }

    function requireJson(req, _res, next) {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        const length = Number(req.headers['content-length'] || 0);
        const chunked = req.headers['transfer-encoding'] !== undefined;
        if ((length > 0 || chunked) && !req.is('application/json')) {
            next(new ManagerError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.'));
            return;
        }
        next();
    }

    const api = express.Router();
    api.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        next();
    });
    api.use(guards.hostGuard);
    api.use(guards.originGuard);
    api.use(requireJson);
    api.use(express.json({ limit: BODY_LIMIT, strict: true, type: 'application/json' }));
    api.use((req, _res, next) => {
        if (req.body === undefined || req.body === null) req.body = {};
        next();
    });

    api.get('/status', route(() => manager.status()));

    api.post('/claim', route(async (req) => {
        throttle('bootstrap');
        const { credential, label, ...rest } = req.body;
        checkActor({ body: rest }, null);
        if (Object.keys(rest).length > 0) throw new ManagerError(400, 'INVALID_INPUT', 'The request has a field claim does not accept.');
        if (typeof label !== 'string' || !LABEL_SHAPE.test(label.trim())) {
            throw new ManagerError(400, 'INVALID_INPUT', '"label" must be 1 to 80 letters, digits, spaces or ._\'@()- characters.');
        }
        try {
            manager.credentials.bootstrap.consume(credential);
        } catch (error) {
            noteFailure('bootstrap');
            throw error;
        }
        if (manager.currentState().state !== 'unclaimed') {
            manager.credentials.bootstrap.revoke();
            throw new ManagerError(409, 'ALREADY_CLAIMED', 'This installation already exists; first-time setup is closed. Use local recovery.');
        }
        const { operation, result } = await manager.engine.run('claim', { label }, { principal: null, via: 'bootstrap' });
        return {
            installationId: result.installationId,
            operationId: operation.id,
            session: { token: result.session.token, expiresAt: result.session.expiresAt, kind: 'setup' }
        };
    }));

    api.post('/recovery/unlock', route(async (req) => {
        if (!guards.isLocalRequest(req)) {
            throw new ManagerError(403, 'LOCAL_ONLY', 'Recovery works only from this machine (use an SSH tunnel).');
        }
        throttle('recovery');
        const state = manager.currentState();
        if (state.state === 'unclaimed') {
            throw new ManagerError(409, 'STATE_NOT_ALLOWED', 'There is nothing to recover; use first-time setup.', { state: state.state });
        }
        const { credential, ...rest } = req.body;
        checkActor({ body: rest }, null);
        if (Object.keys(rest).length > 0) throw new ManagerError(400, 'INVALID_INPUT', 'The request has a field unlock does not accept.');
        try {
            manager.credentials.recovery.consume(credential);
        } catch (error) {
            noteFailure('recovery');
            throw error;
        }
        const { operation, result } = await manager.engine.run('recovery.unlock', undefined, { principal: null, via: 'recovery-credential' });
        return {
            operationId: operation.id,
            session: { token: result.session.token, expiresAt: result.session.expiresAt, kind: 'recovery' }
        };
    }));

    function readAuth(req) {
        const auth = authenticate(req);
        const state = manager.currentState();
        if (state.state === 'unclaimed' || (state.state === 'recovery' && auth.via !== 'recovery')) {
            throw new ManagerError(409, 'STATE_NOT_ALLOWED', `Not available in the ${state.state} state with this authentication.`, { state: state.state });
        }
        return auth;
    }

    api.get('/features', route((req) => {
        readAuth(req);
        const state = manager.createFeatureState();
        return state.status();
    }));

    api.get('/operations', route((req) => {
        readAuth(req);
        return { operations: manager.engine.list() };
    }));

    api.get('/operations/:id', route((req) => {
        readAuth(req);
        return manager.engine.status(req.params.id);
    }));

    api.post('/operations', route(async (req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        const { kind, input, ...rest } = req.body;
        if (Object.keys(rest).length > 0) throw new ManagerError(400, 'INVALID_INPUT', 'The request has a field the operations API does not accept.');
        if (typeof kind !== 'string' || kind.length > 64) throw new ManagerError(400, 'UNKNOWN_KIND', 'Unknown operation kind.');
        if (privileged.isPrivileged(kind)) {
            throw new ManagerError(400, 'PRIVILEGED_OPERATION', 'Privileged operations are not operation kinds; see /manager/api/privileged.');
        }
        const operation = await manager.engine.plan(kind, input, auth);
        return { operation };
    }));

    api.post('/operations/:id/validate', route(async (req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        if (Object.keys(req.body).length > 0) throw new ManagerError(400, 'INVALID_INPUT', 'validate takes no body.');
        return { operation: await manager.engine.validate(req.params.id, auth) };
    }));

    api.post('/operations/:id/apply', route(async (req, res) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        const { revision, ...rest } = req.body;
        if (Object.keys(rest).length > 0) throw new ManagerError(400, 'INVALID_INPUT', 'apply takes only "revision".');
        if (revision !== undefined && revision !== null && !Number.isInteger(revision)) {
            throw new ManagerError(400, 'INVALID_INPUT', '"revision" must be an integer or null.');
        }
        try {
            const { operation, result } = await manager.engine.apply(req.params.id, { revision: revision ?? null }, auth);
            return { operation, result: result ?? null };
        } catch (error) {
            if (error instanceof ManagerError && error.operation) {
                res.status(error.status).json({ error: error.toJSON(), operation: error.operation });
                return undefined;
            }
            throw error;
        }
    }));

    api.post('/privileged/:name', route((req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        return privileged.request(req.params.name);
    }));

    const helpers = { route, authenticate, readAuth, checkActor, throttle, noteFailure, guards, manager, logger, now };
    for (const mount of mounts) mount(api, helpers);

    api.use((_req, _res, next) => next(new ManagerError(404, 'NOT_FOUND', 'No such manager route.')));

    api.use((error, _req, res, _next) => {
        if (error instanceof ManagerError) return sendError(res, error);
        if (error && error.type === 'entity.too.large') {
            return sendError(res, new ManagerError(413, 'PAYLOAD_TOO_LARGE', 'The request body is larger than 64 KB.'));
        }
        if (error && error.type === 'entity.parse.failed') {
            return sendError(res, new ManagerError(400, 'BAD_JSON', 'The request body is not valid JSON.'));
        }
        if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
            return sendError(res, new ManagerError(400, 'BAD_REQUEST', 'The request could not be read.'));
        }
        logger.error?.(`[manager] request failed: ${error && (error.code || error.name)}`);
        return sendError(res, error);
    });

    app.use('/manager/api', api);
    app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such manager route.' } }));
    return app;
}

module.exports = { createManagerApp, BODY_LIMIT };
