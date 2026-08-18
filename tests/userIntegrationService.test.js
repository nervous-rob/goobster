/**
 * Unit tests for per-user platform integrations
 * (services/userIntegrationService.js): the catalog, token verification on
 * connect, storage/replacement, disconnect, token retrieval, and the
 * /forget-me erasure + audit coverage of user_integrations. Provider
 * verification is stubbed - no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-integrations-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/githubService', () => ({
    withToken: jest.fn(() => ({
        getViewer: jest.fn().mockResolvedValue({ login: 'octocat' })
    }))
}));
jest.mock('@goobster/core/services/notionService', () => ({
    getViewer: jest.fn().mockResolvedValue({ name: 'Goobster Bot', workspaceName: 'Rob HQ' })
}));

const db = require('@goobster/core/db');
const userIntegrationService = require('@goobster/core/services/userIntegrationService');
const githubService = require('@goobster/core/services/githubService');
const notionService = require('@goobster/core/services/notionService');
const privacyService = require('@goobster/core/services/privacyService');

const USER = '200000000000000001';
const OTHER = '200000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    db.run('DELETE FROM user_integrations');
});

describe('catalog and status', () => {
    test('list returns every provider, disconnected by default, never a token', () => {
        const catalog = userIntegrationService.list(USER);
        expect(catalog.map(item => item.provider).sort()).toEqual(['github', 'notion']);
        for (const item of catalog) {
            expect(item.connected).toBe(false);
            expect(item.account).toBeNull();
            expect(item.name).toBeTruthy();
            expect(item.docsUrl).toMatch(/^https:\/\//);
            expect(item).not.toHaveProperty('token');
        }
    });

    test('connectedProviders reflects stored rows without stamping lastUsedAt', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_valid_token' });
        expect(userIntegrationService.connectedProviders(USER)).toEqual({ github: true, notion: false });
        expect(userIntegrationService.connectedProviders(OTHER)).toEqual({ github: false, notion: false });
        const row = db.get(
            `SELECT lastUsedAt FROM user_integrations WHERE userId = @u AND provider = 'github'`,
            { u: USER }
        );
        expect(row.lastUsedAt).toBeNull();
    });
});

describe('connect', () => {
    test('verifies the token live and snapshots the account label', async () => {
        const item = await userIntegrationService.connect({
            userId: USER, provider: 'github', token: 'ghp_valid_token'
        });
        expect(item.connected).toBe(true);
        expect(item.account).toBe('@octocat');
        expect(githubService.withToken).toHaveBeenCalledWith('ghp_valid_token');

        const notion = await userIntegrationService.connect({
            userId: USER, provider: 'notion', token: 'ntn_valid_secret'
        });
        expect(notion.account).toBe('Goobster Bot · Rob HQ');
        expect(notionService.getViewer).toHaveBeenCalledWith('ntn_valid_secret');
    });

    test('rejects unknown providers and obviously malformed tokens without a network call', async () => {
        await expect(userIntegrationService.connect({ userId: USER, provider: 'slack', token: 'xoxb-123456789' }))
            .rejects.toMatchObject({ code: 'NO_SUCH_PROVIDER', status: 404 });
        await expect(userIntegrationService.connect({ userId: USER, provider: 'github', token: 'short' }))
            .rejects.toMatchObject({ code: 'BAD_TOKEN', status: 400 });
        await expect(userIntegrationService.connect({ userId: USER, provider: 'github', token: 'has spaces inside' }))
            .rejects.toMatchObject({ code: 'BAD_TOKEN', status: 400 });
        expect(githubService.withToken).not.toHaveBeenCalled();
    });

    test('a token the provider rejects is not stored', async () => {
        githubService.withToken.mockReturnValueOnce({
            getViewer: jest.fn().mockRejectedValue(new Error('Bad credentials'))
        });
        await expect(userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_revoked_token' }))
            .rejects.toMatchObject({ code: 'VERIFY_FAILED', status: 400 });
        expect(userIntegrationService.connectedProviders(USER).github).toBe(false);
    });

    test('reconnecting replaces the stored token in place', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_first_token' });
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_second_token' });
        expect(db.get('SELECT COUNT(*) AS c FROM user_integrations WHERE userId = @u', { u: USER }).c).toBe(1);
        expect(userIntegrationService.getToken(USER, 'github')).toBe('ghp_second_token');
    });
});

describe('getToken and disconnect', () => {
    test('getToken returns the stored token for the owner only and stamps lastUsedAt', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'notion', token: 'ntn_valid_secret' });
        expect(userIntegrationService.getToken(USER, 'notion')).toBe('ntn_valid_secret');
        expect(userIntegrationService.getToken(OTHER, 'notion')).toBeNull();
        const row = db.get(
            `SELECT lastUsedAt FROM user_integrations WHERE userId = @u AND provider = 'notion'`,
            { u: USER }
        );
        expect(row.lastUsedAt).not.toBeNull();
    });

    test('disconnect deletes the row and is idempotent', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_valid_token' });
        expect(userIntegrationService.disconnect({ userId: USER, provider: 'github' }))
            .toEqual({ disconnected: true });
        expect(userIntegrationService.disconnect({ userId: USER, provider: 'github' }))
            .toEqual({ disconnected: false });
        expect(userIntegrationService.getToken(USER, 'github')).toBeNull();
    });
});

describe('privacy coverage', () => {
    test('the transparency report names connected providers but never tokens', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_valid_token' });
        const report = privacyService.buildUserReport({ guildId: 'guild-1', userId: USER });
        expect(report.integrations).toEqual([
            expect.objectContaining({ provider: 'github', account: '@octocat' })
        ]);
        expect(JSON.stringify(report)).not.toContain('ghp_valid_token');
    });

    test('/forget-me deletes stored tokens and the audit proves zero rows remain', async () => {
        await userIntegrationService.connect({ userId: USER, provider: 'github', token: 'ghp_valid_token' });
        await userIntegrationService.connect({ userId: USER, provider: 'notion', token: 'ntn_valid_secret' });
        await userIntegrationService.connect({ userId: OTHER, provider: 'github', token: 'ghp_other_token' });

        const counts = privacyService.forgetUser({ userId: USER });
        expect(counts.integrations).toBe(2);

        const audit = privacyService.auditUser({ userId: USER });
        expect(audit.byTable.user_integrations).toBe(0);
        expect(audit.total).toBe(0);

        // Other users' integrations are untouched
        expect(userIntegrationService.getToken(OTHER, 'github')).toBe('ghp_other_token');
    });
});
