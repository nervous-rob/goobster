/**
 * Activity WS membership gate (Phase 5e): goes through DiscordGateway,
 * never discord.js cache/fetch.
 */
const { assertActivityGuildAccess } = require('@goobster/bot/web/activityApi');
const { GatewayUnavailableError } = require('@goobster/core/gateway');

describe('assertActivityGuildAccess', () => {
    test('dev mode skips the membership check', async () => {
        expect(await assertActivityGuildAccess({
            gateway: null, guildId: '1', userId: '2', devMode: true
        })).toEqual({ ok: true });
    });

    test('unknown guild when the bot is not in the server', async () => {
        const gateway = {
            getGuildMember: jest.fn(async () => ({ guild: null, member: null }))
        };
        expect(await assertActivityGuildAccess({
            gateway, guildId: 'g', userId: 'u'
        })).toEqual({
            ok: false, code: 'UNKNOWN_GUILD', message: 'Goobster is not in that server.'
        });
    });

    test('not a member when the guild exists but the user does not', async () => {
        const gateway = {
            getGuildMember: jest.fn(async () => ({
                guild: { id: 'g', name: 'Server' },
                member: null
            }))
        };
        expect(await assertActivityGuildAccess({
            gateway, guildId: 'g', userId: 'u'
        })).toEqual({
            ok: false, code: 'NOT_A_MEMBER', message: 'You are not a member of that server.'
        });
    });

    test('ok when the gateway returns both guild and member', async () => {
        const gateway = {
            getGuildMember: jest.fn(async () => ({
                guild: { id: 'g' },
                member: { id: 'u' }
            }))
        };
        expect(await assertActivityGuildAccess({
            gateway, guildId: 'g', userId: 'u'
        })).toEqual({ ok: true });
        expect(gateway.getGuildMember).toHaveBeenCalledWith('g', 'u');
    });

    test('unreachable gateway maps to UNKNOWN_GUILD', async () => {
        const gateway = {
            getGuildMember: jest.fn(async () => { throw new GatewayUnavailableError(); })
        };
        expect(await assertActivityGuildAccess({
            gateway, guildId: 'g', userId: 'u'
        })).toMatchObject({ ok: false, code: 'UNKNOWN_GUILD' });
    });
});
