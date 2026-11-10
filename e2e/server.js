#!/usr/bin/env node
/**
 * Headless portal for Playwright. Mounts createWebAppApp in webapp.devMode
 * against a throwaway SQLite file and seeds the three cognitive-loop
 * fixtures the specs click through. No Discord token, no network, no AI.
 *
 *   GOOBSTER_E2E_PORT=4173 node e2e/server.js
 *
 * Requires `npm run build:web` first (apps/web/dist).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.GOOBSTER_E2E_PORT || process.env.PORT || 4173);
const DATA_DIR = process.env.GOOBSTER_DATA_DIR
    || fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-data-'));
const DB_PATH = process.env.GOOBSTER_DB_PATH
    || path.join(DATA_DIR, 'goobster-e2e.sqlite');

process.env.GOOBSTER_DATA_DIR = DATA_DIR;
process.env.GOOBSTER_DB_PATH = DB_PATH;
process.env.GOOBSTER_OBSERVATORY_ENABLED = process.env.GOOBSTER_OBSERVATORY_ENABLED || '1';
process.env.GOOBSTER_SANDBOX_ENABLED = process.env.GOOBSTER_SANDBOX_ENABLED || '1';

// GOOBSTER_E2E_WEB_DIST serves another built client, such as a payload's pruned copy.
const WEB_DIST = process.env.GOOBSTER_E2E_WEB_DIST || path.join(ROOT, 'apps/web/dist');
const distIndex = path.join(WEB_DIST, 'index.html');
if (!fs.existsSync(distIndex)) {
    console.error('The web client is not built. Run npm run build:web.');
    process.exit(1);
}

const C = require('./constants');
const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const { ObservatoryService } = require('@goobster/core/services/observatoryService');
const { ExpeditionBriefService } = require('@goobster/core/services/expeditionBriefService');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
const factsService = require('@goobster/core/services/factsService');
const parlorService = require('@goobster/core/services/parlorService');
const webChatService = require('@goobster/core/services/webChatService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const inboxService = require('@goobster/core/services/inboxService');
// Explicit fake-local capability for Inbox draft journeys; they never send.
require('@goobster/core/config/aiConfig').provider = 'ollama';
const identityService = require('@goobster/core/services/identityService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

function fakeGateway() {
    return {
        isGoobsterGateway: true,
        async available() { return true; },
        async botUser() { return { id: C.BOT_ID, username: 'Goobster' }; },
        async getGuildMember() { return { guild: null, member: null }; },
        async memberHasPermission() { return false; },
        async listMutualGuilds() { return []; },
        async getGuildMembers() { return {}; },
        async searchGuildMembers() { return []; },
        async getUser(userId) {
            if (String(userId) === C.MEMBER) {
                return { id: C.MEMBER, username: 'frieda', globalName: C.MEMBER_NAME, bot: false };
            }
            if (String(userId) === C.OWNER) {
                return { id: C.OWNER, username: 'rob', globalName: C.OWNER_NAME, bot: false };
            }
            return { id: String(userId), username: 'user', globalName: 'User', bot: false };
        },
        async sendDm() { return { ok: true, channelId: 'dm-1', messageId: 'm-1' }; },
        async sendToChannel() { return { ok: true, messageId: 'm-1' }; },
        async resolveDmChannelId() { return 'dm-1'; },
        async guildMeta() { return null; }
    };
}

function makeObservatory() {
    return new ObservatoryService({
        config: { ...observatoryConfig, enabled: true },
        sandbox: { enabled: true }
    });
}

/**
 * The research-brief model stand-in (#254): reads the evidence packet the
 * real service builds and answers in the brief shape, citing the seeded
 * claim. No network, no key; the rest of the pipeline is the real thing.
 */
function fakeBriefModel() {
    return {
        chat: async (messages) => {
            const packet = JSON.parse(messages[1].content);
            const claimIds = packet.claims.map((claim) => claim.id);
            return {
                content: JSON.stringify({
                    summary: C.BRIEF_SUMMARY,
                    summaryClaimIds: claimIds,
                    findings: [{ id: 'F1', text: C.BRIEF_FINDING, claimIds }],
                    limitations: [{ kind: 'weak_evidence', text: C.BRIEF_LIMITATION, claimIds }]
                })
            };
        }
    };
}

async function seedExpedition(userId) {
    const expedition = await expeditionService.createExpedition({
        userId,
        seed: C.EXPEDITION_SEED,
        lensId: 'mathematics',
        intent: C.EXPEDITION_INTENT,
        depth: 'focused'
    });
    await expeditionService.claimForRun(expedition.id);
    const cycle = await expeditionService.startCycle(expedition.id);
    const sourceId = await db.insert(
        `INSERT INTO research_sources
            (expeditionId, cycleId, userId, provider, sourceType, url, canonicalUrl, title, accepted)
         VALUES
            (@expeditionId, @cycleId, @userId, 'arxiv', 'preprint', @url, @url, @title, 1)`,
        {
            expeditionId: expedition.id,
            cycleId: cycle.id,
            userId,
            url: C.SOURCE_URL,
            title: C.SOURCE_TITLE
        }
    );
    const claimId = await db.insert(
        `INSERT INTO research_claims (sourceId, expeditionId, cycleId, text, kind, confidence)
         VALUES (@sourceId, @expeditionId, @cycleId, @text, 'factual', 0.91)`,
        {
            sourceId,
            expeditionId: expedition.id,
            cycleId: cycle.id,
            text: C.CLAIM_TEXT
        }
    );
    const guildId = dmScopeId(userId);
    const scopeKey = `USER:${userId}`;
    await knowledgeGraphService.applyMutations({
        guildId,
        scopeKey,
        source: 'research',
        limits: kgConfig.LIMITS.research,
        provenance: { sourceKind: 'expedition', sourceId: expedition.id },
        mutations: {
            upsert: [{
                type: 'concept',
                label: C.NOTE_LABEL,
                content: C.NOTE_CONTENT,
                claimIds: [claimId]
            }]
        }
    });
    await expeditionService.finishCycle(cycle.id, {
        status: 'COMPLETED',
        counters: {
            sourceCount: 1,
            sourcesAccepted: 1,
            claimsExtracted: 1,
            notesProposed: 1,
            notesCreated: 1
        },
        coverage: {
            summary: C.EXPEDITION_SUMMARY,
            coveredQuestions: ['What is the positive Grassmannian?'],
            unresolvedQuestions: [],
            searchGaps: [],
            majorNewConcepts: ['positroid cells'],
            conflicts: [],
            coverageScore: 0.6,
            noveltyScore: 0.8
        }
    });
    await expeditionService.completeExpedition(expedition.id, {
        stopReason: 'NO_LEADS',
        summary: C.EXPEDITION_SUMMARY
    });
    return expedition.id;
}

/**
 * Personal-memory and curation fixtures (documentation/knowledge_and_memory.md):
 * a distilled note and a mirrored fact (curation = memory, hidden from the
 * default Notes projection), a legacy tool row nothing has sorted
 * (unclassified, still listed with a Keep action), and one raw memory.
 */
async function seedPersonalMemory(userId) {
    const guildId = dmScopeId(userId);
    const scopeKey = `USER:${userId}`;
    await knowledgeGraphService.upsertNode({
        guildId,
        scopeKey,
        subjectType: 'USER',
        subjectId: userId,
        type: 'preference',
        label: C.DISTILLED_NOTE_LABEL,
        content: C.DISTILLED_NOTE_CONTENT,
        source: 'consolidation'
    });
    await knowledgeGraphService.upsertNode({
        guildId,
        scopeKey,
        subjectType: 'USER',
        subjectId: userId,
        type: 'concept',
        label: C.LEGACY_NOTE_LABEL,
        content: C.LEGACY_NOTE_CONTENT,
        source: 'tool'
    });
    await factsService.addFact({
        guildId,
        subjectType: 'USER',
        subjectId: userId,
        content: C.FACT_CONTENT,
        source: 'user'
    });
    await db.insert(
        `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model)
         VALUES (@guildId, 'web', @authorId, @authorName, @content, @embedding, 3, 'e2e-fixture')`,
        {
            guildId,
            authorId: userId,
            authorName: C.OWNER_NAME,
            content: C.MEMORY_CONTENT,
            embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer)
        }
    );
}

/**
 * A saved web chat, written the way the chat pipeline writes it (ADR 0010:
 * the answer -> note hop starts here). One question, one answer with a
 * heading, and a second answer carrying a generated app so the Save to
 * project… hop has a fence to act on.
 */
async function seedChat(userId) {
    const conversation = await webChatService.createConversation(userId);
    await webChatService.renameConversation({ userId, conversationId: conversation.id, title: C.CHAT_TITLE });
    const { channelId } = await db.get('SELECT channelId FROM web_conversations WHERE id = @id', { id: conversation.id });
    await db.run(
        `INSERT INTO users (discordUsername, discordId, username) VALUES (@name, @id, @name) ON CONFLICT DO NOTHING`,
        { id: userId, name: C.OWNER_NAME }
    );
    await db.run(
        `INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster') ON CONFLICT DO NOTHING`,
        { id: C.BOT_ID }
    );
    const human = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: userId })).id;
    const bot = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: C.BOT_ID })).id;
    const guildConvId = await db.insert(
        `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)`,
        { g: dmScopeId(userId), c: channelId, t: `channel-${channelId}` }
    );
    const conversationId = await db.insert(
        'INSERT INTO conversations (userId, guildConversationId) VALUES (@u, @g)', { u: human, g: guildConvId }
    );
    const app = `\`\`\`html\n<!doctype html><html><head><title>${C.CHAT_APP_TITLE}</title></head><body><h1>${C.CHAT_APP_TITLE}</h1><input type="range"></body></html>\n\`\`\``;
    const turns = [
        [human, 0, C.CHAT_QUESTION],
        [bot, 1, `## ${C.CHAT_ANSWER_HEADING}\n\n${C.CHAT_ANSWER_BODY}`],
        [human, 0, 'Build me a tiny dial for it.'],
        [bot, 1, `Here you go.\n\n${app}`]
    ];
    const ids = [];
    for (const [by, isBot, text] of turns) {
        ids.push(await db.insert(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@c, @g, @by, @m, @isBot)`,
            { c: conversationId, g: guildConvId, by, m: text, isBot }
        ));
    }
    return { conversationId: conversation.id, messageIds: ids };
}

async function seedParlor(userId) {
    const persona = await parlorService.createPersona({
        ownerId: userId,
        name: C.PERSONA_NAME,
        emoji: '🔬',
        color: '#54c2ff',
        charter: C.PERSONA_CHARTER
    });
    const conversation = await parlorService.createConversation({
        ownerId: userId,
        personaIds: [persona.id]
    });
    await db.run(
        `UPDATE parlor_conversations SET title = @title, lastMessageAt = datetime('now')
         WHERE id = @id`,
        { id: conversation.id, title: 'Salon on ingest' }
    );
    await db.insert(
        `INSERT INTO parlor_messages (conversationId, role, content, userId, userName)
         VALUES (@conversationId, 'user', @content, @userId, @userName)`,
        {
            conversationId: conversation.id,
            content: C.PARLOR_USER_MESSAGE,
            userId,
            userName: C.OWNER_NAME
        }
    );
    await db.insert(
        `INSERT INTO parlor_messages (conversationId, role, personaId, personaName, content)
         VALUES (@conversationId, 'persona', @personaId, @personaName, @content)`,
        {
            conversationId: conversation.id,
            personaId: persona.id,
            personaName: C.PERSONA_NAME,
            content: C.PARLOR_REPLY
        }
    );
    return conversation.id;
}

async function seedProject(observatory, userId) {
    const project = await observatory.createProject({ userId, name: C.PROJECT_NAME, description: C.PROJECT_GOAL });
    await observatory.writeWorkspaceFile({
        userId,
        slug: project.slug,
        relativePath: C.ARTIFACT_PATH,
        bytes: Buffer.from('{"ok":false}', 'utf8')
    });
    await observatory.writeWorkspaceFile({
        userId,
        slug: project.slug,
        relativePath: C.ARTIFACT_IMAGE,
        bytes: PNG_1X1
    });
    await db.insert(
        `INSERT INTO observatory_jobs
            (projectId, userId, language, code, status, exitCode, stderrTail, finishedAt, startedBy, lastHeartbeatAt)
         VALUES
            (@projectId, @userId, 'bash', 'echo boom >&2; exit 3', 'FAILED', 3, 'boom',
             datetime('now'), 'portal', datetime('now'))`,
        { projectId: project.id, userId }
    );

    const coords = {
        guildId: dmScopeId(userId),
        scopeKey: knowledgeGraphService.projectScopeKey(project.id)
    };
    await knowledgeGraphService.applyMutations({
        ...coords,
        subjectType: 'USER',
        subjectId: userId,
        source: 'tool',
        mutations: {
            upsert: [{
                type: 'concept',
                label: C.PROJECT_KNOWLEDGE_LABEL,
                content: C.PROJECT_KNOWLEDGE_CONTENT
            }]
        }
    });

    const parlor = await observatory.getProjectParlor({ userId, project: project.slug });
    const builtin = await parlorService.ensureBuiltinPersona(userId);
    await db.insert(
        `INSERT INTO parlor_messages (conversationId, role, content, userId, userName)
         VALUES (@conversationId, 'user', @content, @userId, @userName)`,
        {
            conversationId: parlor.conversation.id,
            content: C.PARLOR_USER_MESSAGE,
            userId,
            userName: C.OWNER_NAME
        }
    );
    await db.insert(
        `INSERT INTO parlor_messages (conversationId, role, personaId, personaName, content)
         VALUES (@conversationId, 'persona', @personaId, @personaName, @content)`,
        {
            conversationId: parlor.conversation.id,
            personaId: builtin.id,
            personaName: builtin.name,
            content: C.PARLOR_REPLY
        }
    );

    return { id: project.id, slug: project.slug, parlorId: parlor.conversation.id };
}

/**
 * The same-slug twin (E3): another owner's project with the same name,
 * shared with `memberId`, so one slug names two projects in that person's
 * list and only the owner-qualified address tells them apart.
 */
async function seedTwinProject(observatory, ownerId, memberId) {
    // The twin's owner has signed into the portal before, so project
    // payloads can name her rather than show a bare id.
    await identityService.ensureLegacyPrincipal({ discordId: ownerId, displayName: C.MEMBER_NAME });
    const twin = await observatory.createProject({ userId: ownerId, name: C.PROJECT_NAME, description: C.TWIN_PROJECT_GOAL });
    const { invite } = await observatory.invite({ userId: ownerId, project: twin.slug, inviteeId: memberId });
    await observatory.respondInvite({ userId: memberId, inviteId: invite.id, accept: true });
    return twin;
}

async function seedAttention(userId) {
    await policies.enroll({ userId, initiative: 'assist' });
    await attention._raiseNotice(userId, {
        key: 'e2e-job-failed',
        itemId: null,
        category: 'observatory',
        title: C.NOTICE_TITLE,
        detail: C.NOTICE_DETAIL,
        urgency: 0.7,
        importance: 0.8,
        confidence: 0.9,
        actionability: 0.8,
        interruptionCost: 0.1,
        score: 0.5,
        disposition: 'inbox',
        reason: C.NOTICE_REASON
    });
}

/**
 * Renderer harness for attachment specs: serves apps/web/src/renderers as
 * raw ES modules (the CommonJS Markdown parser gets a one-line wrapper) plus
 * a blank page, so a spec can drive `renderAttachments` directly - new
 * array instances, replaced files, disposal - outside the React tree.
 */
const RENDERERS_DIR = path.join(ROOT, 'apps/web/src/renderers');
const HARNESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>attachments harness</title>
<style>
  body { font: 14px system-ui; margin: 20px; }
  .file-card { border: 1px solid #999; border-radius: 10px; margin-top: 10px; overflow: hidden; max-width: 640px; }
  .file-card-body { max-height: 420px; overflow: auto; }
  .file-card.collapsed .file-card-body { max-height: 0; overflow: hidden; }
  .file-card-head { display: flex; justify-content: space-between; gap: 10px; padding: 6px 10px; border-bottom: 1px solid #ccc; }
  .file-card-actions { display: flex; gap: 6px; }
</style></head>
<body>
<div id="bubble" class="msg-bubble"><div id="attachments" class="msg-attachments"></div></div>
<script type="module">
  import * as att from '/e2e/renderers/attachments.js';
  window.__att = att;
  window.__container = document.getElementById('attachments');
  window.__ready = true;
</script>
</body></html>`;

function mountRendererHarness(app) {
    // Renderer modules share the real account lifetime implementation.
    // Serve its erased JS for this unbundled harness (the app uses Vite).
    app.get('/e2e/lib/browserAccount', (_req, res) => {
        const ts = require('typescript');
        const source = fs.readFileSync(path.join(RENDERERS_DIR, '../lib/browserAccount.ts'), 'utf8');
        res.type('application/javascript').send(ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
        }).outputText);
    });
    app.get('/e2e/renderers/:file', (req, res) => {
        const file = path.basename(req.params.file);
        const abs = path.join(RENDERERS_DIR, file);
        if (!/\.(c?js)$/.test(file) || !fs.existsSync(abs)) {
            res.status(404).end();
            return;
        }
        let source = fs.readFileSync(abs, 'utf8');
        if (file.endsWith('.cjs')) {
            source = `const module = { exports: {} };\n${source}\nexport default module.exports;\n`;
        }
        res.type('application/javascript').send(source);
    });
    app.get('/e2e/attachments-harness', (_req, res) => {
        res.type('html').send(HARNESS_HTML);
    });
}

async function seedInboxAndPeople() {
    await identityService.createNativePrincipal({ id: C.NATIVE_MEMBER, displayName: C.NATIVE_MEMBER_NAME });
    await identityService.grantAccount({ principalId: C.NATIVE_MEMBER, entitlement: 'invite', loginName: 'native-colleague' });
    await inboxService.deliver({ userId: C.OWNER, kind: 'task', title: C.INBOX_TITLE, body: C.INBOX_BODY });
    const askProject = await db.get('SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug', { userId: C.OWNER, slug: C.PROJECT_SLUG });
    const askJob = await db.insert("INSERT INTO observatory_jobs (projectId, userId, language, code, status) VALUES (@projectId, @userId, 'python', '# fictional', 'FAILED')", { projectId: askProject.id, userId: C.OWNER });
    await require('@goobster/core/services/workFailureService').notify({
        kind: 'job', workId: askJob, actor: C.OWNER, code: 'FITS_HEADER_REJECTED', reason: 'Non-ASCII header',
        title: 'JWST Atlas: run failed', body: 'The FITS inspector rejected a non-ASCII header.',
        link: `/projects/${C.OWNER}/${C.PROJECT_SLUG}/runs`
    });
    // A row stored under a pre-consolidation portal path: the client's
    // route aliases must still take it to Activity → Scheduled.
    await inboxService.deliver({
        userId: C.OWNER, kind: 'reminder', title: C.INBOX_LEGACY_LINK_TITLE,
        body: 'Its link still says /tasks.', link: '/tasks'
    });
    await inboxService.deliver({
        userId: C.OWNER, kind: 'task', title: C.INBOX_ATTACHMENT_TITLE,
        attachments: [{ url: '/e2e/inbox-attachment.csv', name: 'review.csv' }]
    });
    for (let i = 1; i <= 51; i++) {
        const { item } = await inboxService.deliver({
            userId: C.OWNER, kind: 'task', title: `Archived result ${i}`,
            body: `Archived details ${i}.`
        });
        await inboxService.archive({ userId: C.OWNER, itemId: item.id });
    }
}

/**
 * A real `_contact` delivery: three notices, one inbox row. Seeded after
 * the archive fixtures so the row is the newest item. Scores stay below
 * the quiet notice in `seedAttention`, which journeys.spec.js acts on.
 */
async function seedAttentionContact(userId) {
    const specs = [
        { key: 'e2e-contact-lead', title: C.CONTACT_LEAD, score: 0.2 },
        { key: 'e2e-contact-more-1', title: C.CONTACT_MORE_1, score: 0.15 },
        { key: 'e2e-contact-more-2', title: C.CONTACT_MORE_2, score: 0.1 }
    ];
    const notices = [];
    for (const spec of specs) {
        const notice = await attention._raiseNotice(userId, {
            key: spec.key,
            itemId: null,
            category: 'watch',
            title: spec.title,
            detail: C.CONTACT_BODY,
            urgency: 0.4,
            importance: 0.4,
            confidence: 0.6,
            actionability: 0.5,
            interruptionCost: 0.2,
            score: spec.score,
            disposition: 'dm',
            reason: 'a watch that fired'
        });
        if (!notice) throw new Error(`e2e contact notice ${spec.key} was not raised`);
        notices.push(notice);
    }
    const filed = await attention._contact({
        userId,
        gateway: null,
        notices,
        message: C.CONTACT_BODY,
        urgent: false
    });
    if (!filed) throw new Error('e2e attention contact did not file an inbox row');
}

async function seed() {
    const observatory = makeObservatory();
    await seedExpedition(C.OWNER);
    await seedPersonalMemory(C.OWNER);
    await seedChat(C.OWNER);
    await seedParlor(C.OWNER);
    await seedProject(observatory, C.OWNER);
    await seedTwinProject(observatory, C.MEMBER, C.OWNER);
    await seedAttention(C.OWNER);
    await seedInboxAndPeople();
    await seedAttentionContact(C.OWNER);
    return observatory;
}

/**
 * The fixtures stand for data that existed before a host turned a feature
 * off (featureAvailability.spec.js boots a second instance with a
 * `features.json` that disables projects, expeditions and music, then
 * expects the dormant rows to survive and come back). The services refuse
 * to *create* while enforced off, so the seed runs under a state with no
 * file and no override; the real state is restored before serving.
 */
async function seedBeforeDisabling() {
    const { features } = require('@goobster/core/features/featureState');
    features._resetForTests({ filePath: path.join(os.tmpdir(), 'goobster-e2e-no-features.json'), env: {} });
    try {
        return await seed();
    } finally {
        features._resetForTests({});
    }
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // GOOBSTER_E2E_KEEP_DB=1 restarts on an existing data dir without
    // re-seeding (featureAvailability.spec.js restarts a second instance).
    const observatory = process.env.GOOBSTER_E2E_KEEP_DB === '1' ? makeObservatory() : await seedBeforeDisabling();
    // Dedicated operator identities for safe Host tutorial journeys only.
    for (let mode = 0; mode < 3; mode++) {
        const principalId = `9900000000000039${mode}`;
        await identityService.ensureLegacyPrincipal({ discordId: principalId, displayName: 'Account learner' });
        await identityService.grantAccount({ principalId, entitlement: 'bootstrap', role: 'operator' });
    }

    // Source-following journeys use isolated accounts and an in-memory remote feed.
    let sourceNow = Date.now();
    let sourceVersion = 1;
    const { FollowedSourceService } = require('@goobster/core/services/followedSourceService');
    const followedSources = new FollowedSourceService({ now: () => sourceNow, fetch: async () => ({
        status: 200, headers: {}, text: `<rss><channel><item><guid>${sourceVersion}</guid><title>Observed source change ${sourceVersion}</title><link>https://example.org/paper/${sourceVersion}</link><description>A bounded fictional research result with provenance.</description></item></channel></rss>`
    }) });
    const ctx = createWebAppContext({
        gateway: fakeGateway(),
        config: {
            clientId: '123',
            webapp: { enabled: true, devMode: true }
        },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { observatory, followedSources, briefs: new ExpeditionBriefService({ ai: fakeBriefModel() }), webDistDir: WEB_DIST }
    });

    const app = express();
    // Express 4 does not catch a rejected async handler, and Node ends the
    // process on an unhandled rejection. One fixture that threw (a retried
    // journey seeding the same project twice) took this server down and every
    // later journey failed with a refused connection. Hand the error to
    // Express instead, so it is one failed request.
    for (const method of ['get', 'post']) {
        const register = app[method].bind(app);
        app[method] = (route, ...handlers) => register(route, ...handlers.map((handler) =>
            (handler.constructor.name === 'AsyncFunction'
                ? (req, res, next) => handler(req, res, next).catch(next)
                : handler)));
    }
    // A journey that is retried seeds again. Reuse the project the first attempt made.
    const ensureProject = async ({ userId, name }) => {
        try {
            return await observatory.createProject({ userId, name });
        } catch (err) {
            if (err?.code !== 'DUPLICATE_PROJECT') throw err;
            const existing = (await observatory.listProjects(userId)).find((project) => project.name === name);
            if (!existing) throw err;
            return existing;
        }
    };
    // For e2e/harness.spec.js: proof that a rejecting fixture is one failed request.
    app.post('/e2e/fixtures/rejects', async () => { throw new Error('This fixture rejects on purpose.'); });
    app.post('/e2e/fixtures/account-export', express.json(), async (req, res) => {
        const userId = String(req.body.userId);
        const project = await ensureProject({ userId, name: 'Portable account fixture' });
        await knowledgeGraphService.applyMutations({ guildId: dmScopeId(userId), scopeKey: `USER:${userId}`, subjectType: 'USER', subjectId: userId, source: 'user',
            mutations: { upsert: [{ type: 'concept', label: 'Portable evidence fixture', content: 'This saved knowledge belongs in the account archive.' }] } });
        const directory = path.join(DATA_DIR, 'sandbox', 'projects', userId, project.slug);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'result.csv'), 'observation,value\nfictional,42\n');
        res.json({ project });
    });
    app.post('/e2e/fixtures/followed-sources', express.json(), async (req, res) => {
        const userId = String(req.body.userId);
        if (req.body.advance) { sourceNow += 3600_000; sourceVersion++; res.json({ ok: true }); return; }
        await db.run('DELETE FROM followed_sources WHERE userId = @userId', { userId });
        // The journey prepares one research draft and asserts it is the only
        // one. A retried journey seeds again, so the first attempt's draft goes.
        await db.run('DELETE FROM spitball_expeditions WHERE userId = @userId', { userId });
        await policies.enroll({ userId, initiative: 'observe' });
        const project = await ensureProject({ userId, name: 'Source following fixture' });
        await knowledgeGraphService.applyMutations({ guildId: dmScopeId(userId), scopeKey: `USER:${userId}`, subjectType: 'USER', subjectId: userId, source: 'user', mutations: { upsert: [{ type: 'concept', label: 'Followed topic fixture', content: 'An explicitly kept research topic.' }] } });
        res.json({ project });
    });
    app.get('/health', (_req, res) => {
        res.json({ ok: true, db: DB_PATH });
    });
    app.get('/e2e/inbox-attachment.csv', (_req, res) => {
        res.type('text/csv').send('name,value\nkept attachment,42\n');
    });
    // The correlation spec archives the contact row to prove Attention
    // shows it, then puts the row back so the Archive pagination spec
    // still sees exactly the 51 seeded rows.
    app.post('/e2e/fixtures/unarchive-inbox', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || C.OWNER);
            const title = String(req.body?.title || '');
            if (!title) {
                res.status(400).json({ error: 'title required' });
                return;
            }
            await db.run(
                'UPDATE inbox_items SET archivedAt = NULL WHERE userId = @userId AND title = @title',
                { userId, title }
            );
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // A distilled row Goobster "inferred" (curation = memory), minted on
    // demand so the transfers spec can prove the picker refuses it without
    // depending on which memory rows an earlier spec has already deleted.
    app.post('/e2e/fixtures/distilled-note', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || C.OWNER);
            const node = await knowledgeGraphService.upsertNode({
                guildId: dmScopeId(userId),
                scopeKey: `USER:${userId}`,
                subjectType: 'USER',
                subjectId: userId,
                type: 'preference',
                label: String(req.body?.label || C.TRANSFER_MEMORY_LABEL),
                content: String(req.body?.content || C.TRANSFER_MEMORY_CONTENT),
                source: 'consolidation'
            });
            res.json({ id: node.id });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // Guild-facing schedules for the Host → Schedules journey: two daily
    // automations and a recurring reminder in a server, plus a private task
    // the panel must never show. Idempotent per call (clears the previous set).
    app.post('/e2e/fixtures/schedules', express.json(), async (_req, res) => {
        try {
            const guildId = '700000000000000001';
            const channelId = '700000000000000002';
            const tomorrow = new Date(Date.now() + 86_400_000);
            await db.run(`DELETE FROM automations WHERE userId = '700000000000000009'`);
            await db.run(`DELETE FROM followups WHERE userId = '700000000000000009'`);
            await db.run(`DELETE FROM inbox_items WHERE userId = '700000000000000009'`);
            for (const name of ['Daily Gloat', 'Morning Taunt']) {
                await db.run(
                    `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
                     VALUES ('700000000000000009', @guildId, @channelId, @name, 'never shown', '0 9 * * *', @nextRun)`,
                    { guildId, channelId, name, nextRun: tomorrow }
                );
            }
            await db.run(
                `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
                 VALUES ('700000000000000009', 'dm:700000000000000009', 'inbox:700000000000000009', 'Private digest', 'never shown', '0 9 * * *', @nextRun)`,
                { nextRun: tomorrow }
            );
            await db.run(
                `INSERT INTO followups (guildId, channelId, userId, note, dueAt, recurMinutes, recurrence)
                 VALUES (@guildId, @channelId, '700000000000000009', 'Stand-up in five', @dueAt, 1440, 'every day')`,
                { guildId, channelId, dueAt: tomorrow }
            );
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // The assistant-first Home journey (assistantHome.spec.js): a dedicated
    // person with Attention on, one informational finding, one open request
    // and a fresh steward pass. `reset` clears that person's assistant rows
    // so each test starts from "nothing delegated". No model, no network.
    app.post('/e2e/fixtures/assistant-home', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '');
            if (!/^\d{5,20}$/.test(userId)) return res.status(400).json({ error: 'userId' });
            const updates = require('@goobster/core/services/assistantUpdateService');
            const steward = require('@goobster/core/services/assistantStewardService');
            await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: req.body?.name || 'Delegator' });
            // The pilot gate: until the host decides otherwise only the owner is offered a
            // decision card. `owner` makes this person one; give them an id no other journey uses.
            if (req.body?.owner === true) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
            for (const [table, column] of [
                ['assistant_update_receipts', 'userId'], ['assistant_updates', 'audienceUserId'], ['assistant_initiatives', 'ownerUserId'],
                ['assistant_responsibilities', 'ownerUserId'], ['inbox_items', 'userId'], ['attention_policies', 'userId']
            ]) {
                await db.run(`DELETE FROM ${table} WHERE ${column} = @userId`, { userId });
            }
            if (req.body?.attention !== false) await policies.enroll({ userId, initiative: 'assist' });
            await require('@goobster/core/services/instanceStateService').set(steward.HEARTBEAT_KEY, { at: new Date().toISOString() });
            const out = {};
            if (req.body?.seed !== false) {
                out.finding = (await updates.publish({
                    audience: { userId }, identityKey: 'e2e:finding', kind: 'finding', title: 'The library now supports your platform',
                    summary: 'Two generated notes were updated.', components: ['research', 'knowledge'], deliver: true
                })).update.id;
                out.gate = (await updates.publish({
                    audience: { userId }, identityKey: 'e2e:gate', kind: 'question', title: 'Nightly import: review the proposed repair',
                    summary: 'The repair would change its source address.', components: ['processes'],
                    gate: { kind: 'process_repair', id: 'automation:5' }, deliver: true
                })).update.id;
            }
            res.json({ ok: true, ...out });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // A proposed piece of work under an active responsibility (no model call).
    app.post('/e2e/fixtures/assistant-home/initiative', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '');
            const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
            const { responsibility } = await responsibilities.create({
                userId, activate: true,
                body: { title: 'Keep my garden notes current', operations: [{ operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } }] }
            });
            const id = await db.insert(
                `INSERT INTO assistant_initiatives (responsibilityId, responsibilityRevision, ownerUserId, actingUserId,
                    sourceKind, sourceId, sourceRevision, dedupeKey, title, reason)
                 VALUES (@rid, @rev, @u, @u, 'attention_item', '1', 'r2', 'e2e', 'Your frost-date goal changed', 'The goal now names a deadline.')`,
                { rid: responsibility.id, rev: responsibility.revision, u: userId }
            );
            res.json({ ok: true, id });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // One runner pass with a scripted model: it looks in the person's notes,
    // tries a web search the grant does not cover, and reports. No provider.
    app.post('/e2e/fixtures/assistant-home/run', express.json(), async (_req, res) => {
        const aiService = require('@goobster/core/services/aiService');
        const original = aiService.chat;
        const rounds = [
            [{ id: 'e1', name: 'lookupNotes', arguments: JSON.stringify({ query: 'frost' }) },
                { id: 'e2', name: 'searchWeb', arguments: JSON.stringify({ query: 'frost date' }) }],
            [{ id: 'e3', name: 'finish', arguments: JSON.stringify({ outcome: 'finding', title: 'Your notes put the first frost on the 14th', summary: 'Web search is not part of this responsibility, so this is from your notes only.' }) }]
        ];
        aiService.chat = async () => ({ content: '', toolCalls: rounds.shift() || [] });
        try {
            const runner = require('@goobster/core/services/assistantRunnerService');
            res.json(await runner.tick({ wait: true }));
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        } finally {
            aiService.chat = original;
        }
    });
    // Host controls for delegated work (hostAssistant.spec.js): back to a
    // fresh installation's state - running, default caps, no pilot decision -
    // so a failed journey cannot leave every later spec's runs stopped.
    app.post('/e2e/fixtures/assistant-controls/reset', express.json(), async (_req, res) => {
        try {
            const control = require('@goobster/core/services/assistantControlService');
            const access = require('@goobster/core/services/assistantAccessService');
            const state = require('@goobster/core/services/instanceStateService');
            await control.resumeAll();
            for (const key of [control.KEY_CAPS, control.KEY_PAUSED, access.KEY_PILOT]) await state.remove(key);
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // Delegated plan steps (assistantPlanStep.spec.js, ADR 0019): a dedicated
    // person with Attention on, their own project, and a DRAFT plan holding
    // one assistant step. The person approves and starts the plan and
    // delegates in the browser; nothing here approves anything.
    app.post('/e2e/fixtures/assistant-plan-step', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '');
            if (!/^\d{5,20}$/.test(userId)) return res.status(400).json({ error: 'userId' });
            const missions = require('@goobster/core/services/projectMissionService');
            await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: req.body?.name || 'Planner' });
            for (const [table, column] of [
                ['assistant_update_receipts', 'userId'], ['assistant_updates', 'audienceUserId'], ['assistant_initiatives', 'ownerUserId'],
                ['assistant_responsibilities', 'ownerUserId'], ['inbox_items', 'userId'], ['attention_policies', 'userId'],
                ['observatory_projects', 'userId']
            ]) {
                await db.run(`DELETE FROM ${table} WHERE ${column} = @userId`, { userId });
            }
            await policies.enroll({ userId, initiative: 'assist' });
            const project = await observatory.createProject({ userId, name: String(req.body?.project || 'Charting choice') });
            await missions.create({
                userId, project: project.slug,
                title: 'Choose a charting library',
                objective: 'Decide between library X and library Y.',
                successCriteria: ['A written comparison exists'],
                steps: [{
                    kind: 'agent', title: 'Write the comparison',
                    actionParams: { instructions: 'Compare the two libraries from their documentation.', artifacts: ['docs/comparison.md'] }
                }]
            });
            res.json({ ok: true, projectId: project.id, slug: project.slug });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // One runner pass with a scripted model. `written: true` writes the file
    // the step requires before reporting; otherwise it only claims to have.
    app.post('/e2e/fixtures/assistant-plan-step/run', express.json(), async (req, res) => {
        const aiService = require('@goobster/core/services/aiService');
        const original = aiService.chat;
        const report = [{ id: 'p2', name: 'reportStepResult', arguments: JSON.stringify({
            outcome: 'done', title: 'Wrote the comparison of X and Y', summary: 'Compared both from their documentation.',
            artifacts: ['docs/comparison.md'], criteria: ['c1']
        }) }];
        const rounds = req.body?.written
            ? [[{ id: 'p1', name: 'writeProjectFile', arguments: JSON.stringify({ path: 'docs/comparison.md', content: '# Comparison\nLibrary X renders faster.\n' }) }], report]
            : [report];
        aiService.chat = async () => ({ content: '', toolCalls: rounds.shift() || [] });
        try {
            const runner = require('@goobster/core/services/assistantRunnerService');
            res.json(await runner.tick({ wait: true }));
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        } finally {
            aiService.chat = original;
        }
    });
    // Conversation requests and the project board (assistantConversation.spec.js,
    // ADR 0021): a dedicated person with Attention on, their own project
    // with its conversation, and a DRAFT plan waiting for their approval.
    // Safe to call again for the same person: it starts them over.
    app.post('/e2e/fixtures/assistant-conversation', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '');
            if (!/^\d{5,20}$/.test(userId)) return res.status(400).json({ error: 'userId' });
            const missions = require('@goobster/core/services/projectMissionService');
            const name = String(req.body?.name || 'Asker');
            await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
            // The pilot gate: only the owner is offered a decision card until the host
            // decides otherwise. `owner` makes this person one; give them an id no other journey uses.
            if (req.body?.owner === true) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
            for (const [table, column] of [
                ['assistant_update_receipts', 'userId'], ['assistant_updates', 'audienceUserId'], ['assistant_initiatives', 'ownerUserId'],
                ['assistant_responsibilities', 'ownerUserId'], ['inbox_items', 'userId'], ['attention_policies', 'userId'],
                ['parlor_conversations', 'ownerId'], ['observatory_projects', 'userId']
            ]) {
                await db.run(`DELETE FROM ${table} WHERE ${column} = @userId`, { userId });
            }
            await policies.enroll({ userId, initiative: 'assist' });
            const project = await observatory.createProject({ userId, name: String(req.body?.project || 'API choice') });
            const conversation = await parlorService.ensureProjectConversation({
                project: { id: project.id, ownerId: userId, name: project.name }, members: []
            });
            const mission = await missions.create({
                userId, project: project.slug,
                title: 'Choose a web framework',
                objective: 'Decide between framework X and framework Y.',
                successCriteria: ['A decision is written down'],
                steps: [{ kind: 'human', title: 'Pick the framework' }]
            });
            res.json({ ok: true, projectId: project.id, slug: project.slug, conversationId: conversation.id, missionId: mission.id });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // The person says something in a conversation (stored exactly as the
    // portal stores it; no persona answers), then the assistant takes its
    // next look at their responsibilities.
    app.post('/e2e/fixtures/assistant-conversation/say', express.json(), async (req, res) => {
        try {
            const userId = String(req.body?.userId || '');
            const message = await parlorService.postMessage({
                userId, userName: String(req.body?.name || 'Asker'), conversationId: Number(req.body?.conversationId),
                content: String(req.body?.text || ''), notify: false
            });
            const seen = await require('@goobster/core/services/assistantInitiativeService').reconcile({ userId });
            res.json({ ok: true, messageId: message.id, ...seen });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // One runner pass with a scripted model that reports a finding. No provider.
    app.post('/e2e/fixtures/assistant-conversation/run', express.json(), async (_req, res) => {
        const aiService = require('@goobster/core/services/aiService');
        const original = aiService.chat;
        const rounds = [[{ id: 'c1', name: 'finish', arguments: JSON.stringify({
            outcome: 'finding', title: 'Framework X and framework Y compared',
            summary: 'X is smaller and starts faster; Y has more plugins. Neither was chosen.'
        }) }]];
        aiService.chat = async () => ({ content: '', toolCalls: rounds.shift() || [] });
        try {
            res.json(await require('@goobster/core/services/assistantRunnerService').tick({ wait: true }));
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        } finally {
            aiService.chat = original;
        }
    });
    // Findings shared with a project's members (assistantProjectAudience.spec.js,
    // documentation/delegated_project_findings.md): the installation's owner
    // (an operator, with Attention on) with a project and its conversation, a
    // collaborator seated in both, and someone outside the project. The
    // pilot decision is cleared so the owner-only gate applies. Safe to call
    // again: it starts all three over.
    app.post('/e2e/fixtures/assistant-project-audience', express.json(), async (req, res) => {
        try {
            const ids = ['ownerId', 'memberId', 'outsiderId'].map(key => String(req.body?.[key] || ''));
            if (ids.some(id => !/^\d{5,20}$/.test(id))) return res.status(400).json({ error: 'ids' });
            const [ownerId, memberId, outsiderId] = ids;
            const names = { [ownerId]: 'Ada', [memberId]: 'Bo', [outsiderId]: 'Cy' };
            for (const userId of ids) {
                await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: names[userId] });
                const mine = await db.all('SELECT id FROM observatory_projects WHERE userId = @userId', { userId });
                for (const { id } of mine) await db.run('DELETE FROM project_members WHERE projectId = @id', { id });
                for (const [table, column] of [
                    ['assistant_update_receipts', 'userId'], ['assistant_updates', 'audienceUserId'], ['assistant_initiatives', 'ownerUserId'],
                    ['assistant_responsibilities', 'ownerUserId'], ['inbox_items', 'userId'], ['attention_policies', 'userId'],
                    ['parlor_conversations', 'ownerId'], ['observatory_projects', 'userId']
                ]) {
                    await db.run(`DELETE FROM ${table} WHERE ${column} = @userId`, { userId });
                }
            }
            await db.run("DELETE FROM assistant_updates WHERE audienceKind = 'project' AND producerUserId = @ownerId", { ownerId });
            await db.run("DELETE FROM instance_state WHERE key = 'assistantPilot'");
            await identityService.grantAccount({ principalId: ownerId, entitlement: 'bootstrap', role: 'operator' });
            await policies.enroll({ userId: ownerId, initiative: 'assist' });
            const project = await observatory.createProject({ userId: ownerId, name: String(req.body?.project || 'Shared lab') });
            await db.run(
                'INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@projectId, @userId, @userName, @ownerId)',
                { projectId: project.id, userId: memberId, userName: names[memberId], ownerId }
            );
            const conversation = await parlorService.ensureProjectConversation({
                project: { id: project.id, ownerId, name: project.name },
                members: [{ userId: memberId, userName: names[memberId] }]
            });
            res.json({ ok: true, projectId: project.id, slug: project.slug, conversationId: conversation.id });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // The pass that files a project's open requests in the person's Inbox.
    app.post('/e2e/fixtures/assistant-conversation/adopt', express.json(), async (req, res) => {
        try {
            const gates = require('@goobster/core/services/assistantGateService');
            res.json({ ok: true, ...(await gates.adoptProjectGates({ userId: String(req.body?.userId || '') })) });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // The domain resolving a request (what a repair approval would do).
    app.post('/e2e/fixtures/assistant-home/resolve', express.json(), async (req, res) => {
        try {
            const updates = require('@goobster/core/services/assistantUpdateService');
            res.json({ resolved: await updates.resolveGate({ audience: { userId: String(req.body?.userId) }, identityKey: 'e2e:gate' }) });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // A request the person can decide where it is shown (the decide-in-place
    // journey): somebody asks to be friends, and can take it back while the
    // card is still on screen. `step` is ask | withdraw.
    app.post('/e2e/fixtures/assistant-home/friend-request', express.json(), async (req, res) => {
        try {
            const friends = require('@goobster/core/services/friendService');
            const userId = String(req.body?.userId || '');
            const fromId = String(req.body?.fromId || '');
            if (!/^\d{5,20}$/.test(userId) || !/^\d{5,20}$/.test(fromId)) return res.status(400).json({ error: 'userId, fromId' });
            const pair = `(requesterId = @fromId AND addresseeId = @userId) OR (requesterId = @userId AND addresseeId = @fromId)`;
            if (req.body?.step === 'withdraw') {
                const row = await db.get(`SELECT id FROM friendships WHERE status = 'pending' AND (${pair})`, { userId, fromId });
                return res.json(await friends.cancel({ userId: fromId, requestId: row?.id }));
            }
            await identityService.ensureLegacyPrincipal({ discordId: fromId, displayName: req.body?.fromName || 'Ada' });
            await db.run(`DELETE FROM friendships WHERE ${pair}`, { userId, fromId });
            const { request } = await friends.request({ userId: fromId, userName: req.body?.fromName || 'Ada', targetId: userId });
            res.json({ ok: true, requestId: request.id });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // Delegating by conversation (assistantChatDelegation.spec.js): the owner,
    // with Attention on and nothing delegated, and a scripted model for the
    // person's next chat turns. Each entry of `rounds` is one round's tool
    // calls; when they run out the model says `reply`. The turn, the tools,
    // the cards and the confirmations are the real ones. No provider.
    let delegationModel = null;
    app.post('/e2e/fixtures/assistant-chat-delegation', express.json(), async (req, res) => {
        try {
            const aiService = require('@goobster/core/services/aiService');
            if (delegationModel) {
                aiService.chat = delegationModel.original;
                aiService.generateText = delegationModel.generateText;
                delegationModel = null;
            }
            if (req.body?.restore === true) return res.json({ ok: true });
            const userId = String(req.body?.userId || '');
            if (!/^\d{5,20}$/.test(userId)) return res.status(400).json({ error: 'userId' });
            await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: req.body?.name || 'Owner' });
            // The pilot gate: conversational delegation is the owner's until the host decides otherwise.
            if (req.body?.owner !== false) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
            for (const [table, column] of [
                ['assistant_confirmation_receipts', 'userId'], ['assistant_initiatives', 'ownerUserId'],
                ['assistant_responsibilities', 'ownerUserId'], ['inbox_items', 'userId'], ['attention_policies', 'userId']
            ]) {
                await db.run(`DELETE FROM ${table} WHERE ${column} = @userId`, { userId });
            }
            await policies.enroll({ userId, initiative: 'assist' });
            const rounds = Array.isArray(req.body?.rounds) ? req.body.rounds.map((round) => round.map((call, index) => ({
                id: `e2e-${Date.now()}-${index}`, name: String(call.name), arguments: call.arguments || {}
            }))) : [];
            // An argument of '$draft' is the person's newest responsibility when the
            // call is made, so a scripted attempt names the real draft whatever ids
            // an earlier spec or a retried journey left behind.
            const play = async (round) => {
                const newest = await db.get('SELECT MAX(id) AS id FROM assistant_responsibilities WHERE ownerUserId = @userId', { userId });
                return round.map((call) => ({
                    ...call,
                    arguments: JSON.stringify(Object.fromEntries(Object.entries(call.arguments)
                        .map(([key, value]) => [key, value === '$draft' ? Number(newest?.id) : value])))
                }));
            };
            const reply = String(req.body?.reply || 'Done.');
            delegationModel = { original: aiService.chat, generateText: aiService.generateText, rounds };
            // The local provider has no web search of its own, so the turn first asks
            // the model whether to search. With no model to ask, a keyword match
            // ("current", "find") decides instead and the turn becomes a search
            // approval. This model answers that one question: no.
            const { generateText } = delegationModel;
            aiService.generateText = async (prompt, ...rest) => (/requires a web search/.test(String(prompt))
                ? 'false'
                : generateText.call(aiService, prompt, ...rest));
            aiService.chat = async (_messages, options = {}) => {
                // A model call is never instant. When this answered at once,
                // a new chat's turn sometimes ended within milliseconds of the
                // chat being created and the room was left showing an empty
                // conversation (about one run in four here; none with the
                // pause). No provider is that fast, so the stand-in is not either.
                await new Promise((resolve) => setTimeout(resolve, 250));
                const offered = (options.functions || []).map((definition) => definition.name);
                const next = rounds[0];
                // Only the agent loop is scripted, and only with tools it was really offered.
                if (next && next.every((call) => offered.includes(call.name))) return { content: '', toolCalls: await play(rounds.shift()) };
                if (typeof options.onDelta === 'function') options.onDelta(reply);
                return { content: reply, toolCalls: [] };
            };
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // What the database holds for that person, for the spec's own assertions.
    app.get('/e2e/fixtures/assistant-chat-delegation/state', async (req, res) => {
        try {
            const userId = String(req.query.userId || '');
            res.json({
                // Scripted rounds the model has not played yet (0: every tool call was made).
                unplayed: delegationModel ? delegationModel.rounds.length : 0,
                responsibilities: await db.all(
                    'SELECT id, title, status, revision, proposedBy, proposalKeptAt, activatedAt FROM assistant_responsibilities WHERE ownerUserId = @userId ORDER BY id', { userId }),
                receipts: await db.all(
                    'SELECT subjectKind, action, surface, consumedAt FROM assistant_confirmation_receipts WHERE userId = @userId ORDER BY id', { userId })
            });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    // Seed tutorial progress for Settings Resume / Replay / Reset (F1).
    // Bypasses the event API so empty-step catalog tours can still show
    // paused/completed rows. Never calls a provider.
    app.post('/e2e/fixtures/tutorial-progress', express.json(), async (req, res) => {
        try {
            const tutorialService = require('@goobster/core/services/tutorialService');
            const userId = String(req.body?.userId || C.OWNER);
            const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
            for (const row of rows) {
                const tutorialId = String(row.tutorialId || '');
                const version = Number(row.version || 1);
                await db.run(
                    `INSERT INTO tutorial_progress (
                        accountId, tutorialId, version, generation, revision, status,
                        currentStepId, completedStepIdsJson, skippedStepIdsJson,
                        unavailableStepIdsJson, updatedAt
                     ) VALUES (
                        @accountId, @tutorialId, @version, @generation, @revision, @status,
                        @currentStepId, @completedStepIdsJson, @skippedStepIdsJson,
                        @unavailableStepIdsJson, datetime('now')
                     )
                     ON CONFLICT(accountId, tutorialId, version) DO UPDATE SET
                        generation = excluded.generation,
                        revision = excluded.revision,
                        status = excluded.status,
                        currentStepId = excluded.currentStepId,
                        completedStepIdsJson = excluded.completedStepIdsJson,
                        skippedStepIdsJson = excluded.skippedStepIdsJson,
                        unavailableStepIdsJson = excluded.unavailableStepIdsJson,
                        updatedAt = excluded.updatedAt`,
                    {
                        accountId: userId,
                        tutorialId,
                        version,
                        generation: Number(row.generation || 1),
                        revision: Number(row.revision || 1),
                        status: String(row.status || 'paused'),
                        currentStepId: row.currentStepId || null,
                        completedStepIdsJson: JSON.stringify(row.completedStepIds || []),
                        skippedStepIdsJson: JSON.stringify(row.skippedStepIds || []),
                        unavailableStepIdsJson: JSON.stringify(row.unavailableStepIds || [])
                    }
                );
            }
            if (req.body?.autoStart !== undefined) {
                await tutorialService.patchPreferences(userId, { autoStart: Boolean(req.body.autoStart) });
            } else {
                // Keep the offer from covering Settings during the walkthrough.
                await tutorialService.patchPreferences(userId, { autoStart: false });
            }
            // A note + a hidden tool prove Reset all does not touch them.
            if (req.body?.seedSideEffects) {
                const userSettings = require('@goobster/core/services/userSettingsService');
                await db.run(
                    `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content, curation, source)
                     VALUES (@guildId, @scopeKey, 'concept', @label, 'side effect', 'saved', 'user')
                     ON CONFLICT(guildId, scopeKey, label) DO NOTHING`,
                    {
                        guildId: dmScopeId(userId),
                        scopeKey: `USER:${userId}`,
                        label: C.TUTORIAL_SIDE_NOTE || 'Tutorial side-effect note'
                    }
                );
                await userSettings.updateSection({
                    userId,
                    section: 'appearance',
                    changes: { hiddenToolRooms: ['music'] }
                });
            }
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: String(error?.message || error) });
        }
    });
    mountRendererHarness(app);
    app.use(createWebAppApp(ctx));

    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.listen(PORT, '127.0.0.1', (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
    // Song Studio shared songs ride the same live WebSocket layer as Parlor.
    attachWebAppWebSocket(server, ctx);
    console.log(`e2e portal listening on http://127.0.0.1:${PORT}/app/`);

    const shutdown = async () => {
        await new Promise(resolve => server.close(resolve));
        try { await eventBusService.close(); } catch { /* already closed */ }
        try { await db.closeConnection(); } catch { /* already closed */ }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
