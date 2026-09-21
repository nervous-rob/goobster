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
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
const parlorService = require('@goobster/core/services/parlorService');
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
    const project = await observatory.createProject({ userId, name: C.PROJECT_NAME });
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

async function seed() {
    const observatory = makeObservatory();
    await seedExpedition(C.OWNER);
    await seedParlor(C.OWNER);
    await seedProject(observatory, C.OWNER);
    await seedAttention(C.OWNER);
    await seedInboxAndPeople();
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
        deps: { observatory }
    });

    const app = express();
    app.get('/health', (_req, res) => {
        res.json({ ok: true, db: DB_PATH });
    });
    app.get('/e2e/inbox-attachment.csv', (_req, res) => {
        res.type('text/csv').send('name,value\nkept attachment,42\n');
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
