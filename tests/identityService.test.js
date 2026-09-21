/**
 * Application identity (shared-instance Increment A): principals, external
 * identity mapping, the account entitlement, actor context, the legacy
 * migration report/backfill, and the privacy erasure path - plus the
 * portal seams that consume them (dev session, /me, requireAuth gate).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-identity-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const webSessionService = require('@goobster/core/services/webSessionService');
const privacyService = require('@goobster/core/services/privacyService');
const webDashboardService = require('@goobster/core/services/webDashboardService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { getOrCreateUser } = require('@goobster/core/utils/chat/chatDb');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');

const ROB = '100000000000000001';
const SAM = '100000000000000002';
const IDENTITY_TABLES = ['web_sessions', 'auth_identities', 'app_accounts', 'principals', 'users',
    'UserPreferences', 'automations', 'observatory_projects', 'parlor_personas'];

let server;
let port;
let webContext;

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function devSession(userId, name = 'someone') {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session='));
    return { res, cookie: setCookie ? setCookie.split(';')[0] : null };
}

beforeAll((done) => {
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    webContext = ctx;
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    identityConfig.requireAccount = false;
    for (const table of IDENTITY_TABLES) await db.run(`DELETE FROM ${table}`);
});

describe('id shapes', () => {
    test('snowflakes and usr_<uuid> are principal ids; anything else is not', () => {
        expect(identityService.isSnowflake(ROB)).toBe(true);
        expect(identityService.isNativeId(ROB)).toBe(false);
        const native = identityService.newNativeId();
        expect(native).toMatch(/^usr_[0-9a-f-]{36}$/);
        expect(identityService.isNativeId(native)).toBe(true);
        expect(identityService.isPrincipalId(native)).toBe(true);
        expect(identityService.isPrincipalId('bob')).toBe(false);
        expect(identityService.isPrincipalId('usr_not-a-uuid')).toBe(false);
        expect(identityService.newNativeId()).not.toBe(native);
    });
});

describe('legacy principals', () => {
    test('ensureLegacyPrincipal is idempotent and links the discord identity', async () => {
        const first = await identityService.ensureLegacyPrincipal({ discordId: ROB, displayName: 'rob' });
        expect(first).toEqual({ id: ROB, created: true });
        const second = await identityService.ensureLegacyPrincipal({ discordId: ROB, displayName: 'rob' });
        expect(second).toEqual({ id: ROB, created: false });

        expect((await db.get('SELECT COUNT(*) AS c FROM principals')).c).toBe(1);
        expect(await identityService.listExternal(ROB)).toMatchObject([{ provider: 'discord', issuer: '', subject: ROB }]);
        expect(await identityService.resolveExternal({ subject: ROB })).toBe(ROB);
        expect(await identityService.getAccount(ROB)).toBeNull();
    });

    test('a display name learned later fills an empty one but never overwrites', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        await identityService.ensureLegacyPrincipal({ discordId: ROB, displayName: 'rob' });
        await identityService.ensureLegacyPrincipal({ discordId: ROB, displayName: 'robert' });
        expect((await identityService.getPrincipal(ROB)).displayName).toBe('rob');
    });

    test('rejects non-snowflake ids', async () => {
        await expect(identityService.ensureLegacyPrincipal({ discordId: 'bob' }))
            .rejects.toMatchObject({ code: 'BAD_PRINCIPAL', status: 400 });
    });

    test('first contact through chatDb provisions the principal', async () => {
        await getOrCreateUser(SAM, 'sam');
        expect(await identityService.getPrincipal(SAM)).toMatchObject({ id: SAM, displayName: 'sam' });
        expect(await identityService.getAccount(SAM)).toBeNull();
    });
});

describe('native principals and external links', () => {
    test('createNativePrincipal makes a usr_ id with no account', async () => {
        const p = await identityService.createNativePrincipal({ displayName: 'Nat' });
        expect(identityService.isNativeId(p.id)).toBe(true);
        expect(await identityService.getPrincipal(p.id)).toMatchObject({ id: p.id, displayName: 'Nat' });
        expect(await identityService.getAccount(p.id)).toBeNull();
        expect(await identityService.isEntitled(p.id)).toBe(false);
    });

    test('linkExternal binds a subject once and refuses to move it', async () => {
        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        const other = await identityService.createNativePrincipal({ displayName: 'Other' });
        expect(await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM }))
            .toEqual({ linked: true, principalId: nat.id });
        expect(await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM }))
            .toEqual({ linked: false, principalId: nat.id });
        await expect(identityService.linkExternal({ principalId: other.id, provider: 'discord', subject: SAM }))
            .rejects.toMatchObject({ code: 'IDENTITY_CONFLICT', status: 409 });
        expect(await identityService.resolveExternal({ subject: SAM })).toBe(nat.id);
        await expect(identityService.linkExternal({ principalId: identityService.newNativeId(), provider: 'discord', subject: ROB }))
            .rejects.toMatchObject({ code: 'PRINCIPAL_NOT_FOUND' });
    });
});

describe('accounts (the entitlement)', () => {
    test('grantAccount is explicit, idempotent, and validated', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        const granted = await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        expect(granted.created).toBe(true);
        expect(granted.account).toMatchObject({ principalId: ROB, status: 'active', role: 'member', entitlement: 'migration' });
        const again = await identityService.grantAccount({ principalId: ROB, entitlement: 'invite', role: 'operator' });
        expect(again.created).toBe(false);
        expect(again.account.role).toBe('member');
        expect(await identityService.isEntitled(ROB)).toBe(true);

        await expect(identityService.grantAccount({ principalId: ROB, entitlement: 'guess' }))
            .rejects.toMatchObject({ code: 'BAD_ENTITLEMENT' });
        await expect(identityService.grantAccount({ principalId: SAM, entitlement: 'invite' }))
            .rejects.toMatchObject({ code: 'PRINCIPAL_NOT_FOUND' });
    });

    test('disabling an account bumps the session version and drops live sessions', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        const { token } = await webSessionService.create({ userId: ROB });
        const disabled = await identityService.setAccountStatus(ROB, 'disabled');
        expect(disabled).toMatchObject({ status: 'disabled', sessionVersion: 2 });
        expect(await webSessionService.get(token)).toBeNull();
        expect(await identityService.isEntitled(ROB)).toBe(false);
        await expect(identityService.setAccountStatus(SAM, 'disabled')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    });

    test('bootstrapOperators grants, promotes, leaves alone, and rejects bad ids', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: SAM });
        await identityService.grantAccount({ principalId: SAM, entitlement: 'migration' });
        const first = await identityService.bootstrapOperators([ROB, SAM, 'nope']);
        expect(first).toEqual({ granted: [ROB], promoted: [SAM], unchanged: [], rejected: ['nope'] });
        expect(await identityService.getAccount(ROB)).toMatchObject({ role: 'operator', entitlement: 'bootstrap' });
        expect(await identityService.getAccount(SAM)).toMatchObject({ role: 'operator', entitlement: 'migration' });
        const second = await identityService.bootstrapOperators([ROB, SAM]);
        expect(second).toEqual({ granted: [], promoted: [], unchanged: [ROB, SAM], rejected: [] });
        expect(await identityService.bootstrapOperators([])).toEqual({ granted: [], promoted: [], unchanged: [], rejected: [] });
    });
});

describe('actor context', () => {
    test('a legacy principal is its own discord subject; a native one carries its link or nothing', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        const legacy = await identityService.resolveActor({ principalId: ROB, surface: 'web', sessionId: '7' });
        expect(legacy).toEqual({
            actorId: ROB,
            installationId: identityConfig.installationId,
            surface: 'web',
            sessionId: '7',
            externalActor: { provider: 'discord', subject: ROB },
            account: null
        });
        expect(identityService.discordSubjectFor(legacy)).toBe(ROB);

        const nat = await identityService.createNativePrincipal({ displayName: 'Nat' });
        const unlinked = await identityService.resolveActor({ principalId: nat.id, surface: 'automation' });
        expect(unlinked.externalActor).toBeNull();
        expect(identityService.discordSubjectFor(unlinked)).toBeNull();

        await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM });
        const linked = await identityService.resolveActor({ principalId: nat.id, surface: 'web' });
        expect(linked.externalActor).toEqual({ provider: 'discord', subject: SAM });
        expect(identityService.discordSubjectFor(linked)).toBe(SAM);
    });

    test('rejects bad shapes and surfaces; disabled accounts are refused even with the gate off', async () => {
        await expect(identityService.resolveActor({ principalId: 'bob', surface: 'web' }))
            .rejects.toMatchObject({ code: 'BAD_PRINCIPAL' });
        await expect(identityService.resolveActor({ principalId: ROB, surface: 'phone' }))
            .rejects.toMatchObject({ code: 'BAD_SURFACE' });
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        await identityService.setAccountStatus(ROB, 'disabled');
        await expect(identityService.resolveActor({ principalId: ROB, surface: 'web' }))
            .rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', status: 403 });
    });

    test('the release gate requires an active account', async () => {
        await identityService.ensureLegacyPrincipal({ discordId: ROB });
        await expect(identityService.resolveActor({ principalId: ROB, surface: 'web', requireAccount: true }))
            .rejects.toMatchObject({ code: 'NO_ACCOUNT', status: 403 });
        await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        const actor = await identityService.resolveActor({ principalId: ROB, surface: 'web', requireAccount: true });
        expect(actor.account).toEqual({ role: 'member', status: 'active', entitlement: 'migration', sessionVersion: 1 });
    });

    test('discordActor is synchronous and keeps the subject', () => {
        expect(identityService.discordActor(ROB)).toMatchObject({
            actorId: ROB, surface: 'discord', externalActor: { provider: 'discord', subject: ROB }
        });
        expect(() => identityService.discordActor('bob')).toThrow(identityService.IdentityError);
    });
});

describe('web sessions accept principal ids', () => {
    test('a snowflake login provisions the legacy principal', async () => {
        await webSessionService.create({ userId: ROB, userName: 'rob' });
        expect(await identityService.getPrincipal(ROB)).toMatchObject({ id: ROB, displayName: 'rob' });
    });

    test('a native id must already exist', async () => {
        await expect(webSessionService.create({ userId: identityService.newNativeId() })).rejects.toThrow(/Unknown principal/);
        const nat = await identityService.createNativePrincipal();
        const { token } = await webSessionService.create({ userId: nat.id, userName: 'Nat' });
        expect(await webSessionService.get(token)).toMatchObject({ userId: nat.id, userName: 'Nat' });
    });

    test('garbage is still refused', async () => {
        await expect(webSessionService.create({ userId: 'bob' })).rejects.toThrow(/principal id/);
    });
});

describe('portal seams', () => {
    test('dev session mints a native principal and /me reports identity without Discord', async () => {
        const nativeId = identityService.newNativeId();
        const { res, cookie } = await devSession(nativeId, 'Nat');
        expect(res.status).toBe(200);
        expect(res.json.user.id).toBe(nativeId);
        expect(await identityService.getPrincipal(nativeId)).toMatchObject({ displayName: 'Nat' });

        const me = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(me.status).toBe(200);
        expect(me.json.user).toEqual({ id: nativeId, name: 'Nat', avatar: null });
        expect(me.json.identity).toEqual({
            installationId: identityConfig.installationId,
            installationName: identityConfig.installationName,
            account: null,
            discordLinked: false,
            operator: false,
            nativeLogin: false,
            registration: 'invite',
            mail: false
        });
        // Only the private scope: guild membership is never asked for a
        // principal with no Discord identity.
        expect(me.json.scopes).toEqual([expect.objectContaining({ id: `dm:${nativeId}`, kind: 'dm' })]);
    });

    test('dev session rejects ids that are neither snowflake nor native', async () => {
        const { res } = await devSession('bob');
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('BAD_USER_ID');
    });

    test('a legacy login still works with the gate off and reports discordLinked', async () => {
        const { cookie } = await devSession(ROB, 'rob');
        const me = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(me.status).toBe(200);
        expect(me.json.identity).toMatchObject({ account: null, discordLinked: true });
    });

    test('requireAccount gates every authenticated route until an account is granted', async () => {
        const { cookie } = await devSession(ROB, 'rob');
        identityConfig.requireAccount = true;
        const denied = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(denied.status).toBe(403);
        expect(denied.json.error.code).toBe('NO_ACCOUNT');

        await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        const allowed = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(allowed.status).toBe(200);
        expect(allowed.json.identity.account).toEqual({ role: 'member', status: 'active', entitlement: 'migration' });

        await identityService.setAccountStatus(ROB, 'disabled');
        const disabled = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(disabled.status).toBe(401);
    });

    test('listScopes skips guild lookups without a Discord subject and asks with it when present', async () => {
        const calls = [];
        const gateway = {
            isGoobsterGateway: true,
            listMutualGuilds: async (id) => { calls.push(id); return [{ id: '555', name: 'Guild', manageGuild: false }]; }
        };
        const nat = await identityService.createNativePrincipal();
        const native = await webDashboardService.listScopes({ gateway, userId: nat.id, discordUserId: null });
        expect(native.map(s => s.kind)).toEqual(['dm']);
        const linked = await webDashboardService.listScopes({ gateway, userId: nat.id, discordUserId: SAM });
        expect(linked.map(s => s.id)).toEqual([`dm:${nat.id}`, '555']);
        expect(calls).toEqual([SAM]);
    });
});

describe('legacy migration report and backfill', () => {
    async function seedLegacyOwners() {
        await db.run("INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')", { id: ROB });
        await db.run('INSERT INTO UserPreferences (userId) VALUES (@id)', { id: SAM });
        await db.run(`INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule)
                      VALUES (@id, 'dm:${ROB}', 'c', 'n', 'p', '0 9 * * *')`, { id: ROB });
        await db.run("INSERT INTO parlor_personas (ownerId, name, charter) VALUES ('legacy-import', 'ghost', 'c')");
    }

    test('the report counts owners per table and flags unresolved ids', async () => {
        await seedLegacyOwners();
        const report = await identityService.migrationReport();
        expect(report.owners).toEqual({ total: 3, snowflake: 2, native: 0, unresolved: 1, withPrincipal: 0, withAccount: 0 });
        expect(report.unresolved).toEqual([
            { id: 'legacy-import', rows: 1, tables: ['parlor_personas.ownerId'] }
        ]);
        expect(report.tables.find(t => t.table === 'users')).toMatchObject({ rows: 1, owners: 1 });
        expect(report.tables.find(t => t.table === 'automations')).toMatchObject({ rows: 1, owners: 1 });
        expect(report.tables.every(t => !t.error)).toBe(true);
        expect(report.principals.total).toBe(0);
        expect(report.accounts).toEqual({ total: 0, active: 0, disabled: 0, operators: 0 });
    });

    test('backfill is idempotent, names principals from users, and grants no accounts', async () => {
        await seedLegacyOwners();
        const first = await identityService.backfillPrincipals();
        expect(first).toEqual({ scanned: 3, created: 2, existing: 0, skipped: 1 });
        const second = await identityService.backfillPrincipals();
        expect(second).toEqual({ scanned: 3, created: 0, existing: 2, skipped: 1 });

        expect(await identityService.getPrincipal(ROB)).toMatchObject({ displayName: 'rob' });
        expect(await identityService.getPrincipal(SAM)).toMatchObject({ displayName: null });
        expect(await identityService.resolveExternal({ subject: SAM })).toBe(SAM);
        expect((await db.get('SELECT COUNT(*) AS c FROM app_accounts')).c).toBe(0);

        const report = await identityService.migrationReport();
        expect(report.owners).toMatchObject({ withPrincipal: 2, withAccount: 0 });
        expect(report.principals.total).toBe(2);
    });
});

describe('privacy erasure', () => {
    test('/forget-me removes the principal, identities, and account and audits clean', async () => {
        const nat = await identityService.createNativePrincipal();
        await identityService.linkExternal({ principalId: nat.id, provider: 'discord', subject: SAM });
        await identityService.ensureLegacyPrincipal({ discordId: ROB, displayName: 'rob' });
        await identityService.grantAccount({ principalId: ROB, entitlement: 'migration' });
        await webSessionService.create({ userId: ROB });

        const before = await privacyService.buildUserReport({ userId: ROB, guildId: `dm:${ROB}` });
        expect(before.identity).toEqual({
            principal: expect.objectContaining({ id: ROB, displayName: 'rob' }),
            account: expect.objectContaining({ status: 'active', role: 'member', entitlement: 'migration' }),
            linkedIdentities: [{ provider: 'discord', subject: ROB }],
            nativeSignIn: {
                hasPassword: false,
                passwordUpdatedAt: null,
                openRecoveryLinks: 0,
                invitesIssued: 0,
                joinedByInviteAt: null
            },
            email: null
        });

        const counts = await privacyService.forgetUser({ userId: ROB });
        expect(counts).toMatchObject({ principals: 1, authIdentities: 1, appAccounts: 1, webSessions: 1 });

        const audit = await privacyService.auditUser({ userId: ROB });
        expect(audit.byTable).toMatchObject({ principals: 0, auth_identities: 0, app_accounts: 0 });
        expect(audit.total).toBe(0);

        // The other principal and its link are untouched.
        expect(await identityService.getPrincipal(nat.id)).toBeTruthy();
        expect(await identityService.resolveExternal({ subject: SAM })).toBe(nat.id);

        const after = await privacyService.buildUserReport({ userId: ROB, guildId: `dm:${ROB}` });
        expect(after.identity).toMatchObject({ principal: null, account: null, linkedIdentities: [], nativeSignIn: { hasPassword: false } });
    });
});


describe('linked native dashboard scopes', () => {
    test('portal guild routes use the linked subject while private ownership stays native', async () => {
        const guildId = '100000000000000099';
        const native = await identityService.createNativePrincipal({ displayName: 'Native member' });
        await identityService.grantAccount({ principalId: native.id, entitlement: 'invite' });
        await identityService.linkExternal({ principalId: native.id, provider: 'discord', subject: SAM });
        const { cookie } = await devSession(native.id);
        const headers = { cookie };
        const priorGateway = webContext.gateway;
        const gateway = {
            isGoobsterGateway: true,
            listMutualGuilds: jest.fn(async () => [{ id: guildId, name: 'Linked guild', manageGuild: true }]),
            getGuildMember: jest.fn(async (id, subject) => ({
                guild: { id }, member: { id: subject, permissions: ['ManageGuild'] }
            })),
            memberHasPermission: jest.fn(async () => true)
        };
        webContext.gateway = gateway;
        try {
            const me = await request({ reqPath: '/api/app/me', headers });
            expect(me.json.scopes.map(scope => scope.id)).toContain(guildId);
            for (const reqPath of [
                `/api/app/memory/report?scope=${guildId}`,
                `/api/app/memory/memories?scope=${guildId}`,
                `/api/app/memory/facts?scope=${guildId}`,
                `/api/app/memory/constellation?scope=${guildId}`,
                `/api/app/memory/reflection?scope=${guildId}&target=guild`,
                `/api/app/graph?guildId=${guildId}`,
                `/api/app/spitball/notes?scope=${guildId}`
            ]) {
                const response = await request({ reqPath, headers });
                expect({ reqPath, status: response.status, error: response.json?.error }).toEqual({ reqPath, status: 200 });
            }
            expect(gateway.getGuildMember).toHaveBeenCalledWith(guildId, SAM);
            expect(gateway.getGuildMember.mock.calls.every(([, id]) => id === SAM)).toBe(true);
            expect(gateway.memberHasPermission).toHaveBeenCalledWith(guildId, SAM, 'ManageGuild');

            const report = await request({ reqPath: `/api/app/memory/report?scope=${guildId}`, headers });
            expect(report.json.identity.principal.id).toBe(native.id);
            const own = await request({ reqPath: `/api/app/memory/report?scope=dm:${native.id}`, headers });
            expect(own.status).toBe(200);
            for (const id of [SAM, ROB]) {
                const other = await request({ reqPath: `/api/app/memory/report?scope=dm:${id}`, headers });
                expect(other.status).toBe(403);
                expect(other.json.error.code).toBe('FORBIDDEN');
            }

            gateway.memberHasPermission.mockResolvedValue(false);
            expect((await request({ reqPath: `/api/app/graph?guildId=${guildId}`, headers })).status).toBe(403);
            gateway.getGuildMember.mockResolvedValue({ guild: { id: guildId }, member: null });
            const removed = await request({ reqPath: `/api/app/memory/report?scope=${guildId}`, headers });
            expect(removed.json.error.code).toBe('NOT_A_MEMBER');

            await identityService.unlinkExternal({ principalId: native.id, provider: 'discord' });
            gateway.getGuildMember.mockClear();
            const unlinked = await request({
                reqPath: `/api/app/memory/report?scope=${guildId}&discordUserId=${SAM}`, headers
            });
            expect(unlinked.status).toBe(403);
            expect(unlinked.json.error.code).toBe('NO_DISCORD_IDENTITY');
            expect(gateway.getGuildMember).not.toHaveBeenCalled();
        } finally {
            webContext.gateway = priorGateway;
        }
    });
});
