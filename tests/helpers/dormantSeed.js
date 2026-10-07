/**
 * Two-account per-feature seed shared by the dormant-data specs: the Jest
 * regression (#322) and the reduced-payload child probe (#328), which runs it
 * in a tree where the feature modules are not even on disk. Only the database
 * facade it is handed is used; no feature module is required.
 */
'use strict';

const fs = require('node:fs');

const A = '610000000000000001';
const B = '610000000000000002';
const GUILD = '610000000000000100';
const CHANNEL = '610000000000000200';

/**
 * One row per account in each of these (B has none of the shared-market rows).
 * `kept` tables are guild-wide: erasure removes the person's attribution and
 * keeps the row; every other table loses the row.
 */
const TABLES = [
    { feature: 'economy', table: 'economy_wallets', column: 'userId' },
    { feature: 'economy', table: 'economy_transactions', column: 'userId' },
    { feature: 'exchange', table: 'stock_holdings', column: 'userId' },
    { feature: 'exchange', table: 'stock_trades', column: 'userId' },
    { feature: 'exchange', table: 'exchange_accounts', column: 'userId' },
    { feature: 'exchange', table: 'short_positions', column: 'userId' },
    { feature: 'exchange', table: 'option_positions', column: 'userId' },
    { feature: 'exchange', table: 'option_trades', column: 'userId' },
    { feature: 'exchange', table: 'exchange_orders', column: 'userId' },
    { feature: 'exchange', table: 'exchange_events', column: 'userId' },
    { feature: 'exchange', table: 'perp_positions', column: 'userId' },
    { feature: 'exchange', table: 'exchange_optins', column: 'userId' },
    { feature: 'gambling', table: 'prediction_positions', column: 'userId' },
    { feature: 'gambling', table: 'prediction_markets', column: 'createdBy', kept: true, audit: 'prediction_markets_attributed', accounts: { A: 1, B: 0 } },
    { feature: 'tavern', table: 'tavern_characters', column: 'userId' },
    { feature: 'tavern', table: 'tavern_party_members', column: 'userId' },
    { feature: 'tavern', table: 'tavern_npc_relationships', column: 'userId' },
    { feature: 'tavern', table: 'tavern_rooms', column: 'userId' },
    { feature: 'tavern', table: 'tavern_adventure_log', column: 'userId', kept: true },
    { feature: 'tavern', table: 'tavern_adventures', column: 'createdBy', kept: true, audit: 'tavern_adventures_attributed' },
    { feature: 'music', table: 'studio_songs', column: 'ownerId' },
    { feature: 'music', table: 'studio_song_members', column: 'userId' },
    { feature: 'push', table: 'push_subscriptions', column: 'userId' },
    { feature: 'sandbox', table: 'sandbox_requests', column: 'userId' },
    { feature: 'sandbox', table: 'sandbox_packages', column: 'requestedBy', kept: true, audit: 'sandbox_packages_attributed' },
    { feature: 'cursor', table: 'agent_runs', column: 'userId' },
    { feature: 'github', table: 'pending_integration_actions', column: 'requestedBy' },
    { feature: 'github', table: 'integration_audit', column: 'userId', kept: true },
    { feature: 'github', table: 'repo_watches', column: 'createdBy', kept: true },
    { feature: 'core', table: 'user_integrations', column: 'userId' },
    { feature: 'screenVision', table: 'screen_vision_clients', column: 'userId' },
    { feature: 'mcp', table: 'mcp_tokens', column: 'userId' },
    { feature: 'projects', table: 'observatory_projects', column: 'userId' },
    { feature: 'projects', table: 'project_assets', column: 'userId' },
    { feature: 'projects', table: 'observatory_share_links', column: 'userId' },
    { feature: 'observatory', table: 'observatory_jobs', column: 'userId' },
    { feature: 'expeditions', table: 'spitball_expeditions', column: 'userId' },
    { feature: 'expeditions', table: 'expedition_briefs', column: 'userId' },
    { feature: 'expeditions', table: 'research_sources', column: 'userId' }
];

/** Credentials the seed stores: never in a report, an audit or an export. */
const SECRETS = ['hash-secret', 'ghp-secret', 'mcp-hash', 'p256dh-secret', 'auth-secret'];
/** The person's own content: in their export, never in the report. */
const CONTENT = ['refactor the parser'];

function utc(offsetMs = 0) {
    return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function expectedRows(entry, userId) {
    return userId === A ? entry.accounts?.A ?? 1 : entry.accounts?.B ?? 1;
}

function createDormantSeed(db) {
    async function seedAccount(u, name) {
        const tag = name.toLowerCase();
        await db.run('INSERT INTO users (discordUsername, discordId, username) VALUES (@name, @u, @name)', { u, name: `person-${tag}` });

        await db.run('INSERT INTO economy_wallets (guildId, userId, balance) VALUES (@g, @u, 750)', { g: GUILD, u });
        await db.run("INSERT INTO economy_transactions (guildId, userId, amount, balanceAfter, type) VALUES (@g, @u, 750, 750, 'starting-balance')", { g: GUILD, u });
        await db.run("INSERT INTO stock_holdings (guildId, userId, symbol, units, costBasis) VALUES (@g, @u, 'AAPL', 2, 400)", { g: GUILD, u });
        await db.run("INSERT INTO stock_trades (guildId, userId, symbol, side, units, price, points) VALUES (@g, @u, 'AAPL', 'BUY', 2, 200, 400)", { g: GUILD, u });
        await db.run('INSERT INTO exchange_accounts (guildId, userId) VALUES (@g, @u)', { g: GUILD, u });
        await db.run("INSERT INTO short_positions (guildId, userId, symbol, units, avgPrice) VALUES (@g, @u, 'TSLA', 1, 100)", { g: GUILD, u });
        await db.run(`INSERT INTO option_positions (guildId, userId, underlying, optionType, strike, expiry, contracts, openPremium, costBasis)
            VALUES (@g, @u, 'AAPL', 'CALL', 200, '2030-01-01', 1, 5, 500)`, { g: GUILD, u });
        await db.run(`INSERT INTO option_trades (guildId, userId, underlying, optionType, strike, expiry, action, contracts, premium)
            VALUES (@g, @u, 'AAPL', 'CALL', 200, '2030-01-01', 'BUY_TO_OPEN', 1, 5)`, { g: GUILD, u });
        await db.run("INSERT INTO exchange_orders (guildId, userId, symbol, side, orderType, units) VALUES (@g, @u, 'AAPL', 'BUY', 'LIMIT', 1)", { g: GUILD, u });
        await db.run("INSERT INTO exchange_events (guildId, userId, eventType) VALUES (@g, @u, 'margin_call')", { g: GUILD, u });
        await db.run(`INSERT INTO perp_positions (guildId, userId, symbol, direction, units, entryPrice, margin, leverage, liquidationPrice)
            VALUES (@g, @u, 'AAPL', 'LONG', 1, 100, 50, 2, 60)`, { g: GUILD, u });
        await db.run('INSERT INTO exchange_optins (guildId, userId) VALUES (@g, @u)', { g: GUILD, u });

        let marketId;
        if (tag === 'a') {
            marketId = await db.insert(
                `INSERT INTO prediction_markets (guildId, question, symbol, comparator, threshold, closesAt, resolvesAt, createdBy)
                 VALUES (@g, 'Will AAPL close above 300?', 'AAPL', 'ABOVE', 300, '2030-01-01 00:00:00', '2030-01-02 00:00:00', @u)`,
                { g: GUILD, u }
            );
        } else {
            marketId = (await db.get('SELECT id FROM prediction_markets WHERE guildId = @g', { g: GUILD })).id;
        }
        await db.run(`INSERT INTO prediction_positions (marketId, guildId, userId, side, contracts, avgPrice, cost)
            VALUES (@marketId, @g, @u, 'YES', 3, 0.4, 1.2)`, { marketId, g: GUILD, u });

        const adventureId = await db.insert(
            `INSERT INTO tavern_adventures (guildId, channelId, questId, createdBy, state) VALUES (@g, @c, 'quest-${tag}', @u, '{}')`,
            { g: GUILD, c: `${CHANNEL}${tag === 'a' ? 1 : 2}`, u }
        );
        const characterId = await db.insert(
            `INSERT INTO tavern_characters (guildId, userId, name, origin, calling, complication)
             VALUES (@g, @u, 'Hero ${tag}', 'wanderer', 'bard', 'owes money')`,
            { g: GUILD, u }
        );
        await db.run('INSERT INTO tavern_party_members (adventureId, userId, characterId) VALUES (@adventureId, @u, @characterId)', { adventureId, u, characterId });
        await db.run("INSERT INTO tavern_npc_relationships (guildId, npcKey, userId, score) VALUES (@g, 'innkeeper', @u, 3)", { g: GUILD, u });
        await db.run("INSERT INTO tavern_rooms (guildId, userId, description) VALUES (@g, @u, 'a quiet attic')", { g: GUILD, u });
        await db.run("INSERT INTO tavern_adventure_log (adventureId, kind, userId, content) VALUES (@adventureId, 'ACTION', @u, 'opened the door')", { adventureId, u });

        const songId = `song-${tag}`;
        await db.run("INSERT INTO studio_songs (id, ownerId, name, projectJson) VALUES (@songId, @u, 'Song ' || @tag, '{}')", { songId, u, tag });
        await db.run("INSERT INTO studio_song_members (songId, userId, userName, role) VALUES (@songId, @u, 'member', 'owner')", { songId, u });

        await db.run(`INSERT INTO push_subscriptions (userId, endpoint, p256dh, auth)
            VALUES (@u, @endpoint, 'p256dh-secret', 'auth-secret')`, { u, endpoint: `https://push.example.test/${tag}` });

        await db.run("INSERT INTO sandbox_requests (type, userId, payload) VALUES ('package-install', @u, '{\"packages\":[\"numpy\"]}')", { u });
        await db.run(`INSERT INTO sandbox_packages (pip, version, requirement, requestedBy)
            VALUES (@pip, '1.0', @requirement, @u)`, { pip: `pkg-${tag}`, requirement: `pkg-${tag}==1.0`, u });

        await db.run(`INSERT INTO agent_runs (agentId, runId, guildId, channelId, userId, repo, prompt, status)
            VALUES (@agent, @run, @g, @c, @u, 'org/repo', 'refactor the parser', 'RUNNING')`, { agent: `agent-${tag}`, run: `run-${tag}`, g: GUILD, c: CHANNEL, u });
        await db.run(`INSERT INTO pending_integration_actions (type, guildId, channelId, requestedBy, payload)
            VALUES ('github-issue', @g, @c, @u, '{"title":"queued"}')`, { g: GUILD, c: CHANNEL, u });
        await db.run("INSERT INTO integration_audit (guildId, userId, action) VALUES (@g, @u, 'issue.create')", { g: GUILD, u });
        await db.run("INSERT INTO repo_watches (guildId, channelId, repo, createdBy) VALUES (@g, @c, @repo, @u)", { g: GUILD, c: CHANNEL, repo: `org/watch-${tag}`, u });
        await db.run("INSERT INTO user_integrations (userId, provider, token, accountLabel) VALUES (@u, 'github', @token, 'octo')", { u, token: `ghp-secret-${tag}` });
        await db.run("INSERT INTO screen_vision_clients (userId, tokenHash, label) VALUES (@u, @hash, 'desk')", { u, hash: `hash-secret-${tag}` });
        await db.run("INSERT INTO mcp_tokens (tokenHash, userId, label, tokenPrefix) VALUES (@hash, @u, 'cli', @prefix)", { hash: `mcp-hash-${tag}`, u, prefix: `gb_${tag}` });

        const projectId = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab ' || @tag)", { u, tag });
        await db.run("INSERT INTO project_assets (projectId, userId, slug, name, kind) VALUES (@projectId, @u, 'dash', 'Dash', 'app')", { projectId, u });
        await db.run('INSERT INTO observatory_share_links (userId, projectId, token) VALUES (@u, @projectId, @token)', { u, projectId, token: `share-${tag}` });
        await db.run("INSERT INTO observatory_jobs (projectId, userId, language, code) VALUES (@projectId, @u, 'python', 'print(1)')", { projectId, u });

        const expeditionId = await db.insert("INSERT INTO spitball_expeditions (userId, guildId, seed) VALUES (@u, @g, 'topic ' || @tag)", { u, g: GUILD, tag });
        await db.run("INSERT INTO expedition_briefs (expeditionId, userId, status) VALUES (@expeditionId, @u, 'READY')", { expeditionId, u });
        await db.run("INSERT INTO research_sources (expeditionId, userId, title) VALUES (@expeditionId, @u, 'Source ' || @tag)", { expeditionId, u, tag });

        await db.run(`INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
            VALUES (@g, @c, @u, @name, @content, @embedding, 4, 'test/mock')`,
        { g: GUILD, c: CHANNEL, u, name: `person-${tag}`, content: `memory ${tag}`, embedding: Buffer.from(Float32Array.from([tag === 'a' ? 1 : 0, tag === 'a' ? 0 : 1, 0, 0.05]).buffer) });

        await db.run("INSERT INTO resource_events (kind, quantity, provider, actor, createdAt) VALUES ('sandbox_run', 1, 'sandbox', @u, @old)", { u, old: '2020-01-01 00:00:00' });
        await db.run("INSERT INTO resource_events (kind, quantity, provider, actor, createdAt) VALUES ('sandbox_run', 1, 'sandbox', @u, @now)", { u, now: utc() });
    }

    async function rowsOf(table, column, userId) {
        const rows = await db.all(`SELECT * FROM ${table} WHERE ${column} = @userId`, { userId });
        return rows.map(row => JSON.stringify(row, Object.keys(row).sort())).sort();
    }

    async function countOf(table, column, userId) {
        return Number((await db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = @userId`, { userId })).c);
    }

    async function totalOf(table) {
        return Number((await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c);
    }

    async function captureFor(userId) {
        const out = {};
        for (const { table, column } of TABLES) out[table] = await rowsOf(table, column, userId);
        return out;
    }

    async function vecOrphans() {
        const indexed = Number((await db.get('SELECT COUNT(*) AS c FROM memory_vec_4'))?.c ?? 0);
        const stored = Number((await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE dims = 4')).c);
        return { indexed, stored };
    }

    return { seedAccount, rowsOf, countOf, totalOf, captureFor, vecOrphans };
}

async function unpackTarGz(file) {
    const { createGunzip } = require('node:zlib');
    const { pipeline } = require('node:stream/promises');
    const tar = require('tar-stream');
    const extract = tar.extract();
    const files = new Map();
    extract.on('entry', (header, stream, next) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { files.set(header.name, Buffer.concat(chunks)); next(); });
        stream.resume();
    });
    await pipeline(fs.createReadStream(file), createGunzip(), extract);
    return files;
}

module.exports = { A, B, GUILD, CHANNEL, TABLES, SECRETS, CONTENT, utc, expectedRows, createDormantSeed, unpackTarGz };
