/**
 * Versioned project assets (apps, scripts, notes) owned by an Observatory
 * project. An asset is a stable identity; a version is an immutable
 * snapshot. "Editing" inserts a new version and moves the head pointer;
 * rollback moves the pointer back. Source lives in the database (never
 * the workspace) so the portal and the split-deployment api can render
 * without touching the bot's disk.
 *
 * Caps, hash dedupe, and grant legalization are deterministic. The model
 * proposes; this service decides.
 */

const crypto = require('node:crypto');
const db = require('../db');
const observatoryConfig = require('../config/observatoryConfig');
const { legalizeObservatoryGrants } = require('../utils/appletCapabilities');

const MAX_SOURCE = 200_000;
const MAX_NAME = 80;
const MAX_NOTE = 240;
const SLUG_MAX_LENGTH = 48;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(['app', 'script', 'note']);
const ORIGINS = new Set(['chat', 'portal', 'agent', 'migration']);
const LANGUAGES_BY_KIND = {
    app: new Set(['html', 'svg']),
    script: new Set(['python', 'javascript']),
    note: new Set(['markdown'])
};
const DEFAULT_LANGUAGE = {
    app: 'html',
    script: 'python',
    note: 'markdown'
};

class ProjectAssetError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ProjectAssetError';
        this.status = status;
        this.code = code;
    }
}

function contentHash(language, source) {
    return crypto.createHash('sha256').update(`${language}\n${source}`).digest('hex');
}

function parseGrantsJson(raw) {
    if (!raw) return { observatoryRead: [] };
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return { observatoryRead: [] };
    }
}

function slugify(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX_LENGTH)
        .replace(/-+$/g, '');
    if (!SLUG_PATTERN.test(slug)) {
        throw new ProjectAssetError(400, 'BAD_SLUG',
            'Asset names need at least one letter or digit.');
    }
    return slug;
}

class ProjectAssetService {
    constructor({ config = observatoryConfig } = {}) {
        this.config = config;
    }

    /**
     * Resolve a project the user owns by slug (or exact name), or 404.
     * Does not require the Observatory to be enabled — assets are data.
     */
    async _requireProject(userId, projectRef) {
        const ref = String(projectRef ?? '').trim();
        if (!ref) {
            throw new ProjectAssetError(400, 'BAD_PROJECT',
                'Which project? Give its name or slug.');
        }
        const row = await db.get(
            `SELECT id, slug, name FROM observatory_projects
             WHERE userId = @userId AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
            { userId, slugRef: ref.toLowerCase(), ref }
        );
        if (!row) {
            throw new ProjectAssetError(404, 'NO_SUCH_PROJECT',
                `No project called "${ref}".`);
        }
        return row;
    }

    async _requireAsset(userId, projectRow, assetRef) {
        const ref = String(assetRef ?? '').trim();
        if (!ref) {
            throw new ProjectAssetError(400, 'BAD_ASSET',
                'Which asset? Give its name or slug.');
        }
        const row = await db.get(
            `SELECT id, projectId, userId, slug, name, kind, currentVersionId,
                    grantsJson, createdAt, updatedAt
             FROM project_assets
             WHERE projectId = @projectId AND userId = @userId
               AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
            { projectId: projectRow.id, userId, slugRef: ref.toLowerCase(), ref }
        );
        if (!row) {
            throw new ProjectAssetError(404, 'NO_SUCH_ASSET',
                `No asset called "${ref}" in "${projectRow.slug}".`);
        }
        return row;
    }

    _normalizeKind(kind) {
        const value = String(kind || '').trim().toLowerCase();
        if (!KINDS.has(value)) {
            throw new ProjectAssetError(400, 'BAD_KIND',
                'Asset kind must be app, script, or note.');
        }
        return value;
    }

    _normalizeLanguage(kind, language) {
        const allowed = LANGUAGES_BY_KIND[kind];
        const value = String(language || DEFAULT_LANGUAGE[kind] || '').trim().toLowerCase();
        if (!allowed.has(value)) {
            const options = [...allowed].join(', ');
            throw new ProjectAssetError(400, 'BAD_LANGUAGE',
                `A ${kind} asset must be ${options}.`);
        }
        return value;
    }

    _normalizeSource(source) {
        const body = String(source || '');
        if (!body.trim()) {
            throw new ProjectAssetError(400, 'BAD_SOURCE', 'Asset source is empty.');
        }
        if (Buffer.byteLength(body, 'utf8') > MAX_SOURCE) {
            throw new ProjectAssetError(400, 'SOURCE_TOO_LARGE',
                `Asset source is too large (${MAX_SOURCE} byte cap).`);
        }
        return body;
    }

    _normalizeOrigin(origin) {
        const value = String(origin || 'chat').trim().toLowerCase();
        if (!ORIGINS.has(value)) {
            throw new ProjectAssetError(400, 'BAD_ORIGIN',
                'Origin must be chat, portal, agent, or migration.');
        }
        return value;
    }

    _normalizeNote(note) {
        if (note === undefined || note === null || note === '') return null;
        return String(note).trim().slice(0, MAX_NOTE) || null;
    }

    async _serialize(assetRow, versionRow, projectSlug, extras = {}) {
        const grants = legalizeObservatoryGrants(
            versionRow.source,
            parseGrantsJson(assetRow.grantsJson)
        );
        return {
            id: assetRow.id,
            project: projectSlug,
            slug: assetRow.slug,
            name: assetRow.name,
            kind: assetRow.kind,
            currentVersionId: assetRow.currentVersionId,
            currentVersion: extras.currentVersion
                ?? (versionRow.id === assetRow.currentVersionId ? versionRow.version : null),
            versionId: versionRow.id,
            version: versionRow.version,
            language: versionRow.language,
            source: extras.includeSource === false ? undefined : versionRow.source,
            contentHash: versionRow.contentHash,
            note: versionRow.note || null,
            origin: versionRow.origin,
            conversationId: versionRow.conversationId ?? null,
            messageId: versionRow.messageId ?? null,
            grants,
            createdAt: assetRow.createdAt,
            updatedAt: assetRow.updatedAt,
            versionCreatedAt: versionRow.createdAt,
            ...('deduped' in extras ? { deduped: extras.deduped } : {})
        };
    }

    async _loadVersion(assetId, versionId) {
        return await db.get(
            `SELECT id, assetId, userId, version, language, source, contentHash,
                    note, origin, conversationId, messageId, createdAt
             FROM project_asset_versions
             WHERE id = @id AND assetId = @assetId`,
            { id: versionId, assetId }
        );
    }

    async _headVersion(assetRow) {
        if (!assetRow.currentVersionId) return null;
        return await this._loadVersion(assetRow.id, assetRow.currentVersionId);
    }

    /**
     * Create an asset or append a version. Identical source against the
     * head is a no-op that returns the head (no empty versions).
     * @param {Object} params
     */
    async save({
        userId,
        project,
        slug,
        name,
        kind,
        language,
        source,
        note = null,
        origin = 'chat',
        conversationId = null,
        messageId = null,
        grants = undefined,
        ignoreAssetCap = false
    }) {
        const projectRow = await this._requireProject(userId, project);
        const cleanKind = this._normalizeKind(kind);
        const cleanLanguage = this._normalizeLanguage(cleanKind, language);
        const body = this._normalizeSource(source);
        const hash = contentHash(cleanLanguage, body);
        const cleanOrigin = this._normalizeOrigin(origin);
        const cleanNote = this._normalizeNote(note);
        const cleanName = String(name || slug || '').trim().slice(0, MAX_NAME);
        const assetSlug = slugify(slug || cleanName);
        if (!cleanName) {
            throw new ProjectAssetError(400, 'BAD_NAME', 'An asset needs a name.');
        }

        const legalGrants = legalizeObservatoryGrants(body, grants);

        const saved = await db.transaction(async (tx) => {
            const existing = await tx.get(
                `SELECT id, projectId, userId, slug, name, kind, currentVersionId,
                        grantsJson, createdAt, updatedAt
                 FROM project_assets
                 WHERE projectId = @projectId AND slug = @slug`,
                { projectId: projectRow.id, slug: assetSlug }
            );

            if (existing) {
                if (existing.kind !== cleanKind) {
                    throw new ProjectAssetError(409, 'KIND_MISMATCH',
                        `"${assetSlug}" is a ${existing.kind}, not a ${cleanKind}.`);
                }
                const head = existing.currentVersionId
                    ? await tx.get(
                        `SELECT id, assetId, userId, version, language, source, contentHash,
                                note, origin, conversationId, messageId, createdAt
                         FROM project_asset_versions
                         WHERE id = @id AND assetId = @assetId`,
                        { id: existing.currentVersionId, assetId: existing.id }
                    )
                    : null;
                if (head && head.contentHash === hash) {
                    return await this._serialize(existing, head, projectRow.slug, {
                        currentVersion: head.version,
                        deduped: true
                    });
                }

                const last = await tx.get(
                    `SELECT MAX(version) AS v FROM project_asset_versions
                     WHERE assetId = @assetId`,
                    { assetId: existing.id }
                );
                const nextVersion = (last?.v || 0) + 1;
                const versionId = await tx.insert(
                    `INSERT INTO project_asset_versions
                        (assetId, userId, version, language, source, contentHash,
                         note, origin, conversationId, messageId)
                     VALUES (@assetId, @userId, @version, @language, @source, @contentHash,
                             @note, @origin, @conversationId, @messageId)`,
                    {
                        assetId: existing.id,
                        userId,
                        version: nextVersion,
                        language: cleanLanguage,
                        source: body,
                        contentHash: hash,
                        note: cleanNote,
                        origin: cleanOrigin,
                        conversationId: conversationId ? Number(conversationId) : null,
                        messageId: messageId ? Number(messageId) : null
                    }
                );
                const grantsJson = grants !== undefined
                    ? JSON.stringify(legalGrants)
                    : existing.grantsJson;
                await tx.run(
                    `UPDATE project_assets
                     SET currentVersionId = @versionId,
                         name = @name,
                         grantsJson = @grantsJson,
                         updatedAt = datetime('now')
                     WHERE id = @id`,
                    {
                        versionId,
                        name: cleanName || existing.name,
                        grantsJson,
                        id: existing.id
                    }
                );
                await this._pruneVersions(tx, existing.id, versionId);
                const updated = await tx.get(
                    `SELECT id, projectId, userId, slug, name, kind, currentVersionId,
                            grantsJson, createdAt, updatedAt
                     FROM project_assets WHERE id = @id`,
                    { id: existing.id }
                );
                const versionRow = await tx.get(
                    `SELECT id, assetId, userId, version, language, source, contentHash,
                            note, origin, conversationId, messageId, createdAt
                     FROM project_asset_versions WHERE id = @id`,
                    { id: versionId }
                );
                return await this._serialize(updated, versionRow, projectRow.slug, {
                    currentVersion: versionRow.version,
                    deduped: false
                });
            }

            const count = await tx.get(
                `SELECT COUNT(*) AS c FROM project_assets WHERE projectId = @projectId`,
                { projectId: projectRow.id }
            );
            if (!ignoreAssetCap && (count?.c || 0) >= this.config.maxAssetsPerProject) {
                throw new ProjectAssetError(400, 'TOO_MANY_ASSETS',
                    `At most ${this.config.maxAssetsPerProject} assets per project — delete one first.`);
            }

            const assetId = await tx.insert(
                `INSERT INTO project_assets
                    (projectId, userId, slug, name, kind, grantsJson)
                 VALUES (@projectId, @userId, @slug, @name, @kind, @grantsJson)`,
                {
                    projectId: projectRow.id,
                    userId,
                    slug: assetSlug,
                    name: cleanName,
                    kind: cleanKind,
                    grantsJson: JSON.stringify(legalGrants)
                }
            );
            const versionId = await tx.insert(
                `INSERT INTO project_asset_versions
                    (assetId, userId, version, language, source, contentHash,
                     note, origin, conversationId, messageId)
                 VALUES (@assetId, @userId, 1, @language, @source, @contentHash,
                         @note, @origin, @conversationId, @messageId)`,
                {
                    assetId,
                    userId,
                    language: cleanLanguage,
                    source: body,
                    contentHash: hash,
                    note: cleanNote,
                    origin: cleanOrigin,
                    conversationId: conversationId ? Number(conversationId) : null,
                    messageId: messageId ? Number(messageId) : null
                }
            );
            await tx.run(
                `UPDATE project_assets
                 SET currentVersionId = @versionId, updatedAt = datetime('now')
                 WHERE id = @id`,
                { versionId, id: assetId }
            );
            const created = await tx.get(
                `SELECT id, projectId, userId, slug, name, kind, currentVersionId,
                        grantsJson, createdAt, updatedAt
                 FROM project_assets WHERE id = @id`,
                { id: assetId }
            );
            const versionRow = await tx.get(
                `SELECT id, assetId, userId, version, language, source, contentHash,
                        note, origin, conversationId, messageId, createdAt
                 FROM project_asset_versions WHERE id = @id`,
                { id: versionId }
            );
            return await this._serialize(created, versionRow, projectRow.slug, {
                currentVersion: 1,
                deduped: false
            });
        });
        if (!saved.deduped) {
            require('./eventBusService').publishProjectChange({
                userId, slug: projectRow.slug, reason: 'asset'
            });
        }
        return saved;
    }

    /**
     * Drop oldest non-head versions once the asset is over the cap.
     * The head is never pruned.
     */
    async _pruneVersions(tx, assetId, headId) {
        const cap = this.config.maxVersionsPerAsset;
        const rows = await tx.all(
            `SELECT id FROM project_asset_versions
             WHERE assetId = @assetId AND id != @headId
             ORDER BY version ASC, id ASC`,
            { assetId, headId }
        );
        // Head + remaining must fit in the cap.
        const allowedOthers = Math.max(0, cap - 1);
        if (rows.length <= allowedOthers) return 0;
        const doomed = rows.slice(0, rows.length - allowedOthers);
        for (const row of doomed) {
            await tx.run(
                'DELETE FROM project_asset_versions WHERE id = @id AND assetId = @assetId',
                { id: row.id, assetId }
            );
        }
        return doomed.length;
    }

    /**
     * Assets in a project, optionally filtered by kind. Head metadata only
     * (no source) — use get() for the body.
     */
    async list({ userId, project, kind = null }) {
        const projectRow = await this._requireProject(userId, project);
        const cleanKind = kind ? this._normalizeKind(kind) : null;
        // Bind kind only when filtering. `(@kind IS NULL OR a.kind = @kind)`
        // is untyped on Postgres — node-pg cannot infer $n used both as
        // IS NULL and as a comparison (dialect.js only casts a param whose
        // sole use is IS NULL).
        const params = { projectId: projectRow.id, userId };
        const kindFilter = cleanKind ? 'AND a.kind = @kind' : '';
        if (cleanKind) params.kind = cleanKind;
        const rows = await db.all(
            `SELECT a.id, a.slug, a.name, a.kind, a.currentVersionId, a.grantsJson,
                    a.createdAt, a.updatedAt,
                    v.version, v.language, v.contentHash, v.note, v.origin, v.createdAt AS versionCreatedAt
             FROM project_assets a
             LEFT JOIN project_asset_versions v ON v.id = a.currentVersionId
             WHERE a.projectId = @projectId AND a.userId = @userId
               ${kindFilter}
             ORDER BY a.updatedAt DESC, a.id DESC`,
            params
        );
        return rows.map(row => ({
            id: row.id,
            project: projectRow.slug,
            slug: row.slug,
            name: row.name,
            kind: row.kind,
            currentVersionId: row.currentVersionId,
            currentVersion: row.version ?? null,
            language: row.language || null,
            contentHash: row.contentHash || null,
            note: row.note || null,
            origin: row.origin || null,
            grants: parseGrantsJson(row.grantsJson),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            versionCreatedAt: row.versionCreatedAt || null
        }));
    }

    /**
     * One asset: the head, or a specific version number.
     */
    async get({ userId, project, asset, version = null }) {
        const projectRow = await this._requireProject(userId, project);
        const assetRow = await this._requireAsset(userId, projectRow, asset);
        let versionRow;
        if (version === undefined || version === null || version === '') {
            versionRow = await this._headVersion(assetRow);
        } else {
            const n = Number(version);
            if (!Number.isInteger(n) || n < 1) {
                throw new ProjectAssetError(400, 'BAD_VERSION',
                    'Version must be a positive integer.');
            }
            versionRow = await db.get(
                `SELECT id, assetId, userId, version, language, source, contentHash,
                        note, origin, conversationId, messageId, createdAt
                 FROM project_asset_versions
                 WHERE assetId = @assetId AND version = @version`,
                { assetId: assetRow.id, version: n }
            );
        }
        if (!versionRow) {
            throw new ProjectAssetError(404, 'NO_SUCH_VERSION',
                version == null
                    ? `"${assetRow.slug}" has no versions yet.`
                    : `"${assetRow.slug}" has no version ${version}.`);
        }
        const head = versionRow.id === assetRow.currentVersionId
            ? versionRow
            : await this._headVersion(assetRow);
        return await this._serialize(assetRow, versionRow, projectRow.slug, {
            currentVersion: head?.version ?? null
        });
    }

    /**
     * Version history for one asset (no source bodies).
     */
    async listVersions({ userId, project, asset }) {
        const projectRow = await this._requireProject(userId, project);
        const assetRow = await this._requireAsset(userId, projectRow, asset);
        const rows = await db.all(
            `SELECT id, version, language, contentHash, note, origin,
                    conversationId, messageId, createdAt
             FROM project_asset_versions
             WHERE assetId = @assetId
             ORDER BY version DESC, id DESC`,
            { assetId: assetRow.id }
        );
        return {
            asset: {
                id: assetRow.id,
                slug: assetRow.slug,
                name: assetRow.name,
                kind: assetRow.kind,
                currentVersionId: assetRow.currentVersionId
            },
            versions: rows.map(row => ({
                id: row.id,
                version: row.version,
                language: row.language,
                contentHash: row.contentHash,
                note: row.note || null,
                origin: row.origin,
                conversationId: row.conversationId ?? null,
                messageId: row.messageId ?? null,
                createdAt: row.createdAt,
                isHead: row.id === assetRow.currentVersionId
            }))
        };
    }

    /**
     * Rename or replace grants. Source is immutable (save a new version).
     */
    async update({ userId, project, asset, name = undefined, grants = undefined }) {
        const projectRow = await this._requireProject(userId, project);
        const existing = await this._requireAsset(userId, projectRow, asset);
        const fields = [];
        const params = { id: existing.id, userId };
        if (name !== undefined) {
            const clean = String(name || '').trim().slice(0, MAX_NAME);
            if (!clean) {
                throw new ProjectAssetError(400, 'BAD_NAME', 'Name cannot be empty.');
            }
            fields.push('name = @name');
            params.name = clean;
        }
        if (grants !== undefined) {
            const head = await this._headVersion(existing);
            fields.push('grantsJson = @grantsJson');
            params.grantsJson = JSON.stringify(
                legalizeObservatoryGrants(head?.source || '', grants)
            );
        }
        if (fields.length === 0) {
            return await this.get({ userId, project: projectRow.slug, asset: existing.slug });
        }
        fields.push("updatedAt = datetime('now')");
        await db.run(
            `UPDATE project_assets SET ${fields.join(', ')}
             WHERE id = @id AND userId = @userId`,
            params
        );
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'asset'
        });
        return await this.get({ userId, project: projectRow.slug, asset: existing.slug });
    }

    /**
     * Delete an asset and every version (CASCADE).
     */
    async delete({ userId, project, asset }) {
        const projectRow = await this._requireProject(userId, project);
        const existing = await this._requireAsset(userId, projectRow, asset);
        await db.run(
            'DELETE FROM project_asset_versions WHERE assetId = @assetId AND userId = @userId',
            { assetId: existing.id, userId }
        );
        const result = await db.run(
            'DELETE FROM project_assets WHERE id = @id AND userId = @userId',
            { id: existing.id, userId }
        );
        if (result.changes === 0) {
            throw new ProjectAssetError(404, 'NO_SUCH_ASSET',
                `No asset called "${existing.slug}" in "${projectRow.slug}".`);
        }
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'asset'
        });
        return { deleted: true, slug: existing.slug };
    }

    /**
     * Point the head at an existing version. Does not delete history.
     */
    async rollback({ userId, project, asset, version }) {
        const n = Number(version);
        if (!Number.isInteger(n) || n < 1) {
            throw new ProjectAssetError(400, 'BAD_VERSION',
                'Version must be a positive integer.');
        }
        const projectRow = await this._requireProject(userId, project);
        const assetRow = await this._requireAsset(userId, projectRow, asset);
        const target = await db.get(
            `SELECT id, assetId, userId, version, language, source, contentHash,
                    note, origin, conversationId, messageId, createdAt
             FROM project_asset_versions
             WHERE assetId = @assetId AND version = @version`,
            { assetId: assetRow.id, version: n }
        );
        if (!target) {
            throw new ProjectAssetError(404, 'NO_SUCH_VERSION',
                `"${assetRow.slug}" has no version ${n}.`);
        }
        await db.run(
            `UPDATE project_assets
             SET currentVersionId = @versionId, updatedAt = datetime('now')
             WHERE id = @id AND userId = @userId`,
            { versionId: target.id, id: assetRow.id, userId }
        );
        const updated = await db.get(
            `SELECT id, projectId, userId, slug, name, kind, currentVersionId,
                    grantsJson, createdAt, updatedAt
             FROM project_assets WHERE id = @id`,
            { id: assetRow.id }
        );
        const serialized = await this._serialize(updated, target, projectRow.slug, {
            currentVersion: target.version
        });
        require('./eventBusService').publishProjectChange({
            userId, slug: projectRow.slug, reason: 'asset'
        });
        return serialized;
    }

    /** /forget-me: every asset and version belonging to the user. */
    async forgetUser(userId) {
        const versions = (await db.run(
            'DELETE FROM project_asset_versions WHERE userId = @userId',
            { userId }
        )).changes;
        const assets = (await db.run(
            'DELETE FROM project_assets WHERE userId = @userId',
            { userId }
        )).changes;
        return { assets, versions };
    }

    async countUser(userId) {
        const assets = (await db.get(
            'SELECT COUNT(*) AS c FROM project_assets WHERE userId = @userId',
            { userId }
        ))?.c || 0;
        const versions = (await db.get(
            'SELECT COUNT(*) AS c FROM project_asset_versions WHERE userId = @userId',
            { userId }
        ))?.c || 0;
        return { assets, versions };
    }
}

module.exports = new ProjectAssetService();
module.exports.ProjectAssetService = ProjectAssetService;
module.exports.ProjectAssetError = ProjectAssetError;
module.exports.contentHash = contentHash;
module.exports.slugify = slugify;
module.exports.MAX_SOURCE = MAX_SOURCE;
