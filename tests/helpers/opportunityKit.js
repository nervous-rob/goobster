/**
 * Fixtures for the DA-8 opportunity-source specs (ADR 0026): a person's
 * portal chats, followed sources, failed project runs and CI watches, plus
 * delegated responsibilities that name those sources. Everything is seeded
 * with plain rows against a throwaway database; no provider, no network.
 *
 * A spec sets `GOOBSTER_DB_PATH` first and only then requires this module.
 */
'use strict';

const db = require('@goobster/core/db');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runner = require('@goobster/core/services/assistantRunnerService');
const control = require('@goobster/core/services/assistantControlService');
const access = require('@goobster/core/services/assistantAccessService');
const policies = require('@goobster/core/services/attentionPolicyService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const { useState } = require('./featureFixtures');

/** The installation's owner (operator account) and two ordinary people. */
const OWNER = '780000000000000001';
const A = '780000000000000002';
const B = '780000000000000003';

const TABLES = [
    'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
    'assistant_proposal_counters', 'assistant_message_labels',
    'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
    'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures', 'operator_audit',
    'memory_channel_exclusions', 'messages', 'conversations', 'guild_conversations', 'web_conversations', 'users',
    'followed_source_entries', 'followed_sources', 'project_ci_watches', 'project_repos', 'observatory_jobs',
    'project_members', 'observatory_projects'
];

/** Back to a fresh installation: pilot not opened, A and B ordinary, OWNER the operator. */
async function reset() {
    useState();
    runner._reset();
    initiatives.stopListening();
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    await db.run('DELETE FROM user_settings WHERE userId IN (@a, @b, @o)', { a: A, b: B, o: OWNER });
    for (const key of [control.KEY_CAPS, control.KEY_PAUSED, access.KEY_PILOT]) await instanceState.remove(key);
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b, @o)', { a: A, b: B, o: OWNER });
    await identityService.ensureLegacyPrincipal({ discordId: OWNER, displayName: 'owner' });
    await identityService.grantAccount({ principalId: OWNER, entitlement: 'bootstrap', role: 'operator' });
}

const openPilot = () => access.recordDecision({ scope: 'everyone' });

/** UTC `YYYY-MM-DD HH:MM:SS` for `date`. */
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

/* ------------------------------------------------------------------ */
/* Portal chats                                                        */
/* ------------------------------------------------------------------ */

let nextChat = 0;
/** One of `userId`'s own portal conversations. */
async function chat(userId, { title = null } = {}) {
    nextChat += 1;
    const channelId = `web:${userId}:kit${process.pid}x${nextChat}`;
    const conversationId = await db.insert(
        'INSERT INTO web_conversations (userId, channelId, title) VALUES (@userId, @channelId, @title)', { userId, channelId, title }
    );
    await db.run(
        "INSERT INTO users (discordUsername, discordId, username) VALUES ('kit', @id, 'kit') ON CONFLICT DO NOTHING", { id: userId }
    );
    await db.run(
        "INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', 'kit-bot', 'Goobster') ON CONFLICT DO NOTHING", {}
    );
    const human = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: userId })).id;
    const bot = (await db.get("SELECT id FROM users WHERE discordId = 'kit-bot'", {})).id;
    const guildConversationId = await db.insert(
        'INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)',
        { g: dmScopeId(userId), c: channelId, t: `thread-${channelId}` }
    );
    const personal = await db.insert('INSERT INTO conversations (userId, guildConversationId) VALUES (@u, @g)', { u: human, g: guildConversationId });
    return { id: conversationId, channelId, guildConversationId, personal, human, bot };
}

/** A line in a chat: the person's, or (`bot`) Goobster's reply. */
async function say(conversation, text, { bot = false, createdAt = null } = {}) {
    return db.insert(
        `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot${createdAt ? ', createdAt' : ''})
         VALUES (@c, @g, @by, @m, @bot${createdAt ? ', @at' : ''})`,
        {
            c: conversation.personal, g: conversation.guildConversationId, by: bot ? conversation.bot : conversation.human,
            m: text, bot: bot ? 1 : 0, at: createdAt
        }
    );
}

/* ------------------------------------------------------------------ */
/* Projects, followed sources, jobs, CI watches                        */
/* ------------------------------------------------------------------ */

async function project({ owner = A, slug = 'lab', members = [] } = {}) {
    const id = await db.insert('INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, @slug, @name)', { u: owner, slug, name: `Project ${slug}` });
    for (const member of members) {
        await db.run('INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, @u, @owner)', { pid: id, u: member, owner });
    }
    return id;
}

async function followed({ userId = A, projectId, label = 'Research feed', url = 'https://example.org/feed' } = {}) {
    return db.insert(
        "INSERT INTO followed_sources (userId, projectId, url, label, kind, initialized) VALUES (@u, @p, @url, @label, 'feed', 1)",
        { u: userId, p: projectId, url, label }
    );
}

let entryNo = 0;
async function entry(sourceId, { title = 'A new result', text = 'The finding in full.', kept = 0, url = 'https://example.org/item', retrievedAt = null } = {}) {
    entryNo += 1;
    return db.insert(
        `INSERT INTO followed_source_entries (sourceId, entryKey, url, title, contentHash, extractedText, isChange, kept${retrievedAt ? ', retrievedAt' : ''})
         VALUES (@s, @key, @url, @title, @hash, @text, 1, @kept${retrievedAt ? ', @at' : ''})`,
        { s: sourceId, key: `k${entryNo}`, url, title, hash: `hash-${entryNo}-${title}`, text, kept, at: retrievedAt }
    );
}
const keep = (entryId, kept = 1) => db.run('UPDATE followed_source_entries SET kept = @kept WHERE id = @id', { id: entryId, kept });

async function job(projectId, { userId = A, status = 'FAILED', language = 'python', exitCode = 1, stderr = null, startedBy = null, createdAt = null } = {}) {
    return db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, exitCode, stderrTail, startedBy, finishedAt${createdAt ? ', createdAt' : ''})
         VALUES (@p, @u, @lang, 'print(1)', @status, @exit, @stderr, @by, ${status === 'RUNNING' ? 'NULL' : "datetime('now')"}${createdAt ? ', @at' : ''})`,
        { p: projectId, u: userId, lang: language, status, exit: exitCode, stderr, by: startedBy, at: createdAt }
    );
}

/** A Python traceback whose own file is `file` and whose exception is `kind`; `line` varies without changing the cause. */
const trace = ({ kind = 'KeyError', file = '/workspace/analysis/load.py', line = 12, detail = "'price'" } = {}) => [
    'Traceback (most recent call last):',
    `  File "${file}", line ${line}, in <module>`,
    '    row["price"]',
    '  File "/usr/lib/python3/site-packages/pandas/core/frame.py", line 3761, in __getitem__',
    `${kind}: ${detail}`
].join('\n');

async function repo(projectId, { userId = A, name = 'widgets', full = 'acme/widgets' } = {}) {
    return db.insert(
        "INSERT INTO project_repos (projectId, userId, name, repo, branch) VALUES (@p, @u, @name, @full, 'main')",
        { p: projectId, u: userId, name, full }
    );
}

async function watch({ repoId, projectId, userId = A, branch = 'main', mode = 'notify', sha = 'aaaaaaa1', state = 'success' }) {
    return db.insert(
        'INSERT INTO project_ci_watches (repoId, projectId, userId, branch, mode, lastSha, lastState) VALUES (@r, @p, @u, @b, @mode, @sha, @state)',
        { r: repoId, p: projectId, u: userId, b: branch, mode, sha, state }
    );
}
const settle = (watchId, sha, state) => db.run('UPDATE project_ci_watches SET lastSha = @sha, lastState = @state WHERE id = @id', { id: watchId, sha, state });

/* ------------------------------------------------------------------ */
/* Delegating                                                          */
/* ------------------------------------------------------------------ */

/** An active responsibility of `userId` that names `sources` and holds `operations`. */
async function delegate({ userId = A, projectId = null, sources, operations = null, body = {} }) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({
        userId,
        body: {
            title: 'Keep an eye on my work',
            ...(projectId ? { projectId } : {}),
            scopes: { sources },
            operations: operations || (projectId
                ? [{ operation: 'read', resource: { kind: 'project', ids: [String(projectId)] } }]
                : [{ operation: 'read', resource: { kind: 'knowledge' } }]),
            ...body
        }
    });
    const act = (action, current) => responsibilities.act({ userId, id: responsibility.id, action, expectedRevision: current.revision });
    return (await act('activate', responsibility)).responsibility;
}

/** Create the grant, activate it (taking its baseline), and return it. */
const fresh = (id) => db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: Number(id) });

const look = (grant, now = new Date(Date.now() + 10_000)) => initiatives.reconcileResponsibility(grant.id, { now });
const rows = (where = '1 = 1') => db.all(`SELECT * FROM assistant_initiatives WHERE ${where} ORDER BY id`, {});
const row = (id) => db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id });
const queue = async (userId, id) => {
    const current = await initiatives.get({ userId, id });
    return (await initiatives.act({ userId, id, action: 'queue', expectedRevision: current.revision })).initiative;
};

module.exports = {
    OWNER, A, B, TABLES, reset, openPilot, utc,
    chat, say, project, followed, entry, keep, job, trace, repo, watch, settle,
    delegate, fresh, look, rows, row, queue
};
