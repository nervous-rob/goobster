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

const distIndex = path.join(ROOT, 'apps/web/dist/index.html');
if (!fs.existsSync(distIndex)) {
    console.error('The web client is not built. Run npm run build:web.');
    process.exit(1);
}

const C = require('./constants');
const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
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

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const observatory = await seed();

    const ctx = createWebAppContext({
        gateway: fakeGateway(),
        config: {
            clientId: '123',
            webapp: { enabled: true, devMode: true }
        },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { observatory, briefs: new ExpeditionBriefService({ ai: fakeBriefModel() }) }
    });

    const app = express();
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
