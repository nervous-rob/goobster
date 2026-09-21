/**
 * The gateway for an installation with no Discord adapter (shared-instance
 * Increment C, spec §6). Same interface as LocalGateway/RemoteGateway so
 * every service keeps one code path:
 *
 *  - available() is false and every read throws GatewayDisabledError,
 *    which the existing `isGatewayUnavailable` degradation paths already
 *    accept (guild panes stay hidden, DM-scoped features keep working);
 *  - botUser() answers with the installation's assistant identity, so a
 *    chat turn never needs a Discord user id;
 *  - sendDm / sendToChannel report `{ ok: false, error: 'DISCORD_DISABLED' }`
 *    (never throw), so delivery code records the status and moves on.
 *
 * This is not "the bot is offline": that is a transient state of a
 * configured adapter. This is the adapter not existing.
 */

const { GatewayDisabledError } = require('./errors');
const { assistantUser } = require('../services/assistantIdentity');

class DisabledGateway {
    constructor() {
        this.isGoobsterGateway = true;
        this.kind = 'disabled';
    }

    async available() {
        return false;
    }

    async botUser() {
        const user = assistantUser();
        return { id: user.id, username: user.username };
    }

    _refuse() {
        throw new GatewayDisabledError();
    }

    async getGuildMember() { return this._refuse(); }
    async memberHasPermission() { return this._refuse(); }
    async listMutualGuilds() { return this._refuse(); }
    async getGuildMembers() { return this._refuse(); }
    async searchGuildMembers() { return this._refuse(); }
    async getUser() { return this._refuse(); }
    async resolveDmChannelId() { return this._refuse(); }
    async guildMeta() { return this._refuse(); }

    async sendDm() {
        return { ok: false, error: 'DISCORD_DISABLED' };
    }

    async sendToChannel() {
        return { ok: false, error: 'DISCORD_DISABLED' };
    }
}

module.exports = { DisabledGateway };
