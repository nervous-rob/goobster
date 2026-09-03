/**
 * Phase 2: one-time (idempotent) migration of Workshop pins into versioned
 * project assets, plus the user-driven "Promote to project" path.
 *
 * Each user who has `web_applets` rows gets a default project (slug
 * `workshop`, name "Workshop") that does not count against
 * maxProjectsPerUser. Each pin becomes an `app` asset with one version,
 * origin='migration', grants and chat provenance copied. Pins stay in
 * `web_applets` for the deprecation window; `migratedAssetId` is the
 * per-pin marker the Workshop inbox uses for the "migrated" badge.
 *
 * Slug collisions (two titles that slugify the same) get a -2, -3, …
 * suffix — they do not become versions of one asset.
 *
 * Safe to re-run: pins whose linked asset still exists are skipped;
 * orphans (deleted project/asset) are remigrated. Wrapped in a singleton
 * lock so bot + api in the full profile do not double-write.
 */

const db = require('../db');
const logger = require('../utils/logger');
const observatoryService = require('./observatoryService');
const projectAssetService = require('./projectAssetService');
const { slugify, ProjectAssetError } = projectAssetService;
const { WORKSHOP_SLUG } = observatoryService;

const MIGRATION_KEY = 'workshop_pins_v1';
const SLUG_MAX_LENGTH = 48;

function parseGrantsJson(raw) {
    if (!raw) return { observatoryRead: [] };
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return { observatoryRead: [] };
    }
}

function slugFromTitle(title) {
    try {
        return slugify(title);
    } catch {
        return 'applet';
    }
}

/**
 * Next unused slug in a project. `taken` is mutated so a single pass
 * never hands the same slug to two pins.
 * @param {Set<string>} taken
 * @param {string} base
 */
function allocateSlug(taken, base) {
    const root = base || 'applet';
    let candidate = root;
    let n = 2;
    while (taken.has(candidate)) {
        const suffix = `-${n}`;
        candidate = `${root.slice(0, Math.max(1, SLUG_MAX_LENGTH - suffix.length))}${suffix}`;
        n += 1;
    }
    taken.add(candidate);
    return candidate;
}

async function loadTakenSlugs(projectId) {
    const rows = await db.all(
        'SELECT slug FROM project_assets WHERE projectId = @projectId',
        { projectId }
    );
    return new Set(rows.map(row => row.slug));
}

async function markMigrated(userId, appletId, assetId) {
    await db.run(
        `UPDATE web_applets SET migratedAssetId = @assetId
         WHERE id = @appletId AND userId = @userId`,
        { assetId, appletId, userId }
    );
}

/**
 * Pins that still need an asset: never migrated, or the linked asset
 * was deleted (CASCADE from the project).
 */
async function listUnmigratedPins() {
    return await db.all(
        `SELECT a.id, a.userId, a.contentHash, a.title, a.language, a.source,
                a.conversationId, a.messageId, a.grantsJson, a.migratedAssetId
         FROM web_applets a
         LEFT JOIN project_assets pa ON pa.id = a.migratedAssetId
         WHERE a.migratedAssetId IS NULL OR pa.id IS NULL
         ORDER BY a.userId ASC, a.id ASC`
    );
}

async function findAssetByHash(projectId, contentHash) {
    return await db.get(
        `SELECT a.id, a.slug FROM project_assets a
         JOIN project_asset_versions v ON v.id = a.currentVersionId
         WHERE a.projectId = @projectId AND v.contentHash = @contentHash`,
        { projectId, contentHash }
    );
}

async function recordMarker() {
    await db.run(
        `INSERT INTO data_migrations (key, appliedAt)
         VALUES (@key, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET appliedAt = datetime('now')`,
        { key: MIGRATION_KEY }
    );
}

/**
 * Import every outstanding pin into its owner's workshop project.
 * @returns {Promise<{users: number, migrated: number, linked: number, skipped: number}>}
 */
async function migrateAll() {
    const pins = await listUnmigratedPins();
    if (pins.length === 0) {
        await recordMarker();
        return { users: 0, migrated: 0, linked: 0, skipped: 0 };
    }

    const byUser = new Map();
    for (const pin of pins) {
        const list = byUser.get(pin.userId) || [];
        list.push(pin);
        byUser.set(pin.userId, list);
    }

    let migrated = 0;
    let linked = 0;
    let skipped = 0;

    for (const [userId, userPins] of byUser) {
        let project;
        try {
            project = await observatoryService.ensureWorkshopProject(userId);
        } catch (error) {
            logger.warn?.(`Workshop pin migration: could not ensure workshop for ${userId}: ${error.message}`);
            skipped += userPins.length;
            continue;
        }
        const taken = await loadTakenSlugs(project.id);

        for (const pin of userPins) {
            try {
                const existing = await findAssetByHash(project.id, pin.contentHash);
                if (existing) {
                    taken.add(existing.slug);
                    await markMigrated(userId, pin.id, existing.id);
                    linked += 1;
                    continue;
                }
                const slug = allocateSlug(taken, slugFromTitle(pin.title));
                const saved = await projectAssetService.save({
                    userId,
                    project: project.slug,
                    slug,
                    name: pin.title,
                    kind: 'app',
                    language: pin.language,
                    source: pin.source,
                    origin: 'migration',
                    conversationId: pin.conversationId,
                    messageId: pin.messageId,
                    grants: parseGrantsJson(pin.grantsJson),
                    ignoreAssetCap: true
                });
                await markMigrated(userId, pin.id, saved.id);
                migrated += 1;
            } catch (error) {
                skipped += 1;
                logger.warn?.(`Workshop pin migration: pin ${pin.id} for ${userId} failed: ${error.message}`);
            }
        }
    }

    await recordMarker();
    return { users: byUser.size, migrated, linked, skipped };
}

/**
 * Startup entry: singleton-locked so bot + api don't race.
 * @returns {Promise<{acquired: boolean, users?: number, migrated?: number, linked?: number, skipped?: number}>}
 */
async function runOnStartup() {
    const lock = await db.withSingletonLock('workshop_pin_migration', migrateAll);
    if (!lock.acquired) return { acquired: false };
    return { acquired: true, ...lock.result };
}

/**
 * User-driven promote (Workshop inbox). Creates/appends an app asset
 * in the chosen project (default: workshop) and, for a pinned applet,
 * stamps migratedAssetId if it was empty.
 *
 * @param {Object} params
 */
async function promoteToProject({
    userId,
    appletId = null,
    project = null,
    name = null,
    slug = null,
    language = null,
    source = null,
    conversationId = null,
    messageId = null,
    grants = undefined,
    origin = 'portal'
}) {
    const webAppletService = require('./webAppletService');
    let pin = null;
    if (appletId !== null && appletId !== undefined && appletId !== '') {
        pin = await webAppletService.get({ userId, appletId });
    }

    const body = String(source || pin?.source || '');
    const lang = String(language || pin?.language || '').toLowerCase();
    if (!body.trim()) {
        throw new ProjectAssetError(400, 'BAD_SOURCE', 'Nothing to promote — missing applet source.');
    }
    if (lang !== 'html' && lang !== 'svg') {
        throw new ProjectAssetError(400, 'BAD_LANGUAGE', 'Promoted apps must be html or svg.');
    }

    let projectRef = String(project || '').trim();
    if (!projectRef || projectRef.toLowerCase() === WORKSHOP_SLUG) {
        const workshop = await observatoryService.ensureWorkshopProject(userId);
        projectRef = workshop.slug;
    }

    const saved = await projectAssetService.save({
        userId,
        project: projectRef,
        slug: slug || undefined,
        name: String(name || pin?.title || '').trim() || 'Untitled applet',
        kind: 'app',
        language: lang,
        source: body,
        origin,
        conversationId: conversationId ?? pin?.conversationId ?? null,
        messageId: messageId ?? pin?.messageId ?? null,
        grants: grants !== undefined ? grants : pin?.grants
    });

    if (pin && !pin.migrated) {
        await markMigrated(userId, pin.id, saved.id);
    }

    const applet = pin
        ? await webAppletService.get({ userId, appletId: pin.id })
        : null;
    return { asset: saved, applet };
}

module.exports = {
    migrateAll,
    runOnStartup,
    promoteToProject,
    allocateSlug,
    slugFromTitle,
    MIGRATION_KEY,
    WORKSHOP_SLUG
};
