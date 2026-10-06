/** Stream a portable tar.gz; archive paths are generated, local reads are confined. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-stream');
const yaml = require('yaml');
const { dataDir } = require('../runtimePaths');
const { extractCreateTableForeignKeys } = require('../db/dialect');
const safeName = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
const json = value => JSON.stringify(value, null, 2) + '\n';
const parsed = (value, fallback = {}) => { try { return JSON.parse(value) || fallback; } catch { return fallback; } };
const inside = (root, file) => file.startsWith(root + path.sep);

async function safeOpen(root, file) {
    root = path.resolve(root); file = path.resolve(file);
    if (!inside(root, file)) throw Object.assign(new Error('File outside allowed root.'), { code: 'UNSAFE_FILE' });
    const realRoot = await fsp.realpath(root);
    if (realRoot !== root) throw Object.assign(new Error('Symlink root refused.'), { code: 'UNSAFE_FILE' });
    let cursor = root;
    for (const part of path.relative(root, file).split(path.sep)) {
        cursor = path.join(cursor, part);
        if ((await fsp.lstat(cursor)).isSymbolicLink()) throw Object.assign(new Error('Symlink refused.'), { code: 'UNSAFE_FILE' });
    }
    const real = await fsp.realpath(file);
    if (!inside(realRoot, real)) throw Object.assign(new Error('File outside allowed root.'), { code: 'UNSAFE_FILE' });
    const before = await fsp.lstat(file);
    if (!before.isFile() || before.nlink > 1) throw Object.assign(new Error('Not an ordinary file.'), { code: 'UNSAFE_FILE' });
    const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink > 1) throw Object.assign(new Error('Not an ordinary file.'), { code: 'UNSAFE_FILE' });
        if (process.platform === 'linux' && !inside(realRoot, await fsp.realpath(`/proc/self/fd/${handle.fd}`))) {
            throw Object.assign(new Error('File moved outside root.'), { code: 'UNSAFE_FILE' });
        }
        return { handle, stat };
    } catch (error) { await handle.close(); throw error; }
}
class Archive {
    constructor(destination, { maxBytes = 5 * 1024 ** 3, maxFiles = 50000, signal } = {}) {
        this.pack = tar.pack(); this.files = []; this.names = new Set(); this.warnings = []; this.bytes = 0; this.visited = 0;
        this.maxBytes = maxBytes; this.maxFiles = maxFiles; this.signal = signal;
        this.completion = pipeline(this.pack, createGzip(), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
        this.completion.catch(() => {});
    }
    reserve(name, size) {
        this.signal?.throwIfAborted();
        if (!name || name.startsWith('/') || name.split('/').some(p => !p || p === '..' || p === '.') || name.includes('\\')) throw new Error('Invalid archive path');
        if (this.names.has(name)) throw new Error('Duplicate archive path');
        this.names.add(name);
        if (this.files.length >= this.maxFiles || (this.bytes += size) > this.maxBytes) throw Object.assign(new Error('Export exceeds archive limit.'), { code: 'EXPORT_LIMIT' });
    }
    async text(name, value) {
        const content = Buffer.from(value); this.reserve(name, content.length);
        await new Promise((resolve, reject) => this.pack.entry({ name, size: content.length, mode: 0o600, mtime: new Date(0) }, content, e => e ? reject(e) : resolve()));
        this.files.push({ path: name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
        return name;
    }
    async file(name, root, file, reference) {
        let opened;
        try { opened = await safeOpen(root, file); }
        catch (e) {
            if (!['ENOENT', 'ENOTDIR', 'UNSAFE_FILE', 'ELOOP'].includes(e.code)) throw e;
            this.warnings.push({ reference, reason: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'File is no longer available.' : 'Unsafe file path or file type was excluded.' });
            return null;
        }
        const { handle, stat } = opened;
        try {
            this.reserve(name, stat.size);
            const hash = createHash('sha256');
            const input = handle.createReadStream({ autoClose: false });
            input.on('data', chunk => hash.update(chunk));
            const entry = this.pack.entry({ name, size: stat.size, mode: 0o600, mtime: stat.mtime });
            await pipeline(input, entry, { signal: this.signal });
            const after = await handle.stat();
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Object.assign(new Error('File changed during export.'), { code: 'EXPORT_CHANGED' });
            this.files.push({ path: name, size: stat.size, sha256: hash.digest('hex'), reference });
            return name;
        } finally { await handle.close(); }
    }
    async tree(root, directory, prefix, reference) {
        let entries;
        try {
            if ((await fsp.lstat(directory)).isSymbolicLink()) { this.warnings.push({ reference, reason: 'Symbolic link directory excluded.' }); return; }
            entries = await fsp.readdir(directory, { withFileTypes: true });
        } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        for (const item of entries) {
            if (++this.visited > this.maxFiles) throw Object.assign(new Error('Too many workspace entries.'), { code: 'EXPORT_LIMIT' });
            const source = path.join(directory, item.name), destination = `${prefix}/${encodeURIComponent(item.name)}`;
            if (item.isDirectory()) await this.tree(root, source, destination, reference);
            else await this.file(destination, root, source, reference);
        }
    }
    async finish(manifest) {
        await this.text('manifest.json', json({ ...manifest, files: [...this.files], warnings: this.warnings }));
        this.pack.finalize(); await this.completion;
        return { fileCount: this.files.length, warningCount: this.warnings.length };
    }
    async abort() { this.pack.destroy(); await this.completion.catch(() => {}); }
}

async function buildArchive({ userId, data, settings, destination, signal, limits = {} }) {
    const archive = new Archive(destination, { ...limits, signal });
    const records = {};
    // Build each index once; exports can contain tens of thousands of records.
    const indexes = new Map();
    function matching(table, column, value) {
        const key = `${table}:${column}`;
        if (!indexes.has(key)) {
            const index = new Map();
            for (const row of data[table] || []) {
                if (!index.has(row[column])) index.set(row[column], []);
                index.get(row[column]).push(row);
            }
            indexes.set(key, index);
        }
        return indexes.get(key).get(value) || [];
    }
    const position = new Map(Object.values(data).flatMap(rows => rows.map((row, i) => [row, i])));
    const fileCopies = new Map();
    const projectRoot = require('../services/projectService').PROJECTS_ROOT;
    const uploadRoot = require('./webUploads').userUploadDir(userId);
    const artifactRoot = require('./kgArtifactStorage').ARTIFACTS_ROOT;
    const projects = data.observatory_projects;
    // Shared generated-output roots still require a reference in an owned transcript.
    const roots = [uploadRoot, path.join(dataDir, 'images'), path.join(dataDir, 'sandbox', 'runs'),
        ...projects.map(p => path.join(projectRoot, userId, p.slug))];
    async function copyAttachment(file, ref) {
        if (!file || typeof file.path !== 'string') return { name: file?.name || 'Attachment', status: 'external', url: /^https?:\/\//.test(file?.url || '') ? file.url : undefined };
        const absolute = path.resolve(file.path);
        if (fileCopies.has(absolute)) return fileCopies.get(absolute);
        const root = roots.find(r => inside(path.resolve(r), absolute));
        let archivePath = null;
        if (root) archivePath = await archive.file(`attachments/${fileCopies.size}-${safeName(file.name || path.basename(absolute))}`, root, absolute, ref);
        else archive.warnings.push({ reference: ref, reason: 'Attachment is outside the exportable file roots.' });
        const result = { name: file.name || path.basename(absolute), archivePath, status: archivePath ? 'included' : 'unavailable' };
        fileCopies.set(absolute, result); return result;
    }
    try {
        for (const [table, rows] of Object.entries(data)) {
            records[table] = rows.map((row, index) => ({ id: row.id ?? null, index, path: `data/${table}.json`, pointer: `/${index}` }));
        }
        for (const row of data.messages) {
            const meta = parsed(row.metadata);
            if (Array.isArray(meta.attachments)) {
                const copies = [];
                for (const [index, file] of meta.attachments.entries()) copies.push(await copyAttachment(file, `messages:${row.id}:${index}`));
                meta.attachments = copies;
            }
            row.metadata = meta;
        }
        for (const row of data.parlor_messages) {
            const files = parsed(row.attachments, []);
            row.attachments = [];
            for (const [index, file] of files.entries()) row.attachments.push(await copyAttachment(typeof file === 'string' ? { path: file } : file, `parlor_messages:${row.id}:${index}`));
        }
        for (const row of data.inbox_items) {
            const files = parsed(row.attachmentsJson, []); row.attachmentsJson = [];
            for (const [index, file] of files.entries()) {
                const ref = file.file;
                row.attachmentsJson.push(await copyAttachment(ref?.userId === userId ? { ...file, path: ref.path } : file, `inbox_items:${row.id}:${index}`));
            }
        }
        for (const item of data.kg_artifacts) {
            const ref = `kg_artifacts:${item.id}`;
            const scopeRoot = /^[a-zA-Z0-9:_-]+$/.test(item.guildId) && /^[a-zA-Z0-9_-]+$/.test(item.authorId)
                ? path.join(artifactRoot, item.guildId, item.authorId) : path.join(artifactRoot, 'invalid');
            item.archivePath = await archive.file(`attachments/knowledge-${item.id}-${safeName(item.originalName)}`, scopeRoot, path.resolve(dataDir, item.relativePath), ref);
            delete item.relativePath;
        }
        for (const project of projects) {
            const directory = path.join(projectRoot, userId, project.slug);
            if (!inside(path.join(projectRoot, userId), directory)) throw new Error('Invalid project directory');
            await archive.tree(directory, directory, `projects/${project.id}/files`, `observatory_projects:${project.id}`);
            const plans = matching('project_missions', 'projectId', project.id);
            let markdown = `# ${project.name}\n\n${project.description || ''}\n`;
            for (const plan of plans) {
                markdown += `\n## ${plan.title}\n\n${plan.objective}\n\nStatus: ${plan.status}\n`;
                for (const step of matching('project_mission_steps', 'missionId', plan.id)) markdown += `\n- ${step.title} (${step.status}): ${step.description || ''}\n`;
            }
            await archive.text(`projects/${project.id}/plan.md`, markdown);
        }
        for (const version of data.project_asset_versions) {
            const asset = matching('project_assets', 'id', version.assetId)[0];
            const extension = { html: 'html', svg: 'svg', python: 'py', javascript: 'js', markdown: 'md' }[version.language] || 'txt';
            await archive.text(`projects/${asset.projectId}/assets/${asset.id}/v${version.version}.${extension}`, version.source);
        }
        for (const note of data.kg_nodes) {
            const tags = matching('kg_node_tags', 'nodeId', note.id).map(t => matching('kg_tags', 'id', t.tagId)[0]).filter(Boolean);
            const provenance = matching('kg_provenance', 'nodeId', note.id);
            const publication = matching('knowledge_transfers', 'copyNodeId', note.id)[0];
            const edges = [...new Set([...matching('kg_edges', 'sourceId', note.id), ...matching('kg_edges', 'targetId', note.id)])];
            let md = `---\n${yaml.stringify({ id: note.id, title: note.label, tags: tags.map(t => t.name), curation: note.curation, source: note.source, scope: note.scopeKey, provenance, publishedBy: publication?.userId || null })}---\n\n# ${note.label}\n\n${note.content || ''}\n`;
            const noteFiles = require('./noteAttachments');
            for (const reference of noteFiles.references(note.content)) {
                const filePath = noteFiles.locate(userId, reference.filename);
                if (!filePath) {
                    archive.warnings.push({ reference: `kg_nodes:${note.id}`, reason: 'Note attachment is unavailable to this account.' });
                    continue;
                }
                const copied = await copyAttachment({ path: filePath, name: reference.filename.slice(33) }, `kg_nodes:${note.id}`);
                if (copied.archivePath) md = md.replaceAll(reference.url, `../${copied.archivePath}`);
            }
            for (const edge of edges) {
                const other = matching('kg_nodes', 'id', edge.sourceId === note.id ? edge.targetId : edge.sourceId)[0];
                md += `\n- ${edge.relation}: [${other.label.replace(/[[\]\\]/g, '')}](./${other.id}.md)\n`;
            }
            for (const tag of tags) md += `\n[${safeName(tag.name)}](../tags/${tag.id}.md)\n`;
            const file = matching('kg_artifacts', 'nodeId', note.id)[0];
            if (file?.archivePath) md += `\n[${safeName(file.originalName)}](../${file.archivePath})\n`;
            await archive.text(`notes/${note.id}.md`, md);
        }
        for (const tag of data.kg_tags) {
            const notes = matching('kg_node_tags', 'tagId', tag.id).map(t => matching('kg_nodes', 'id', t.nodeId)[0]);
            await archive.text(`tags/${tag.id}.md`, `# ${tag.name}\n\n${notes.map(n => `- [${n.label.replace(/[[\]\\]/g, '')}](../notes/${n.id}.md)`).join('\n')}\n`);
        }
        for (const chat of data.guild_conversations) {
            const web = matching('web_conversations', 'channelId', chat.channelId)[0];
            const messages = matching('messages', 'guildConversationId', chat.id);
            let md = `# ${web?.title || 'Private chat'}\n`;
            for (const message of messages) {
                md += `\n## ${message.isBot ? 'Goobster' : 'You'} · ${message.createdAt}\n\n${message.message}\n`;
                for (const file of message.metadata?.attachments || []) if (file.archivePath) md += `\n[${safeName(file.name)}](../${file.archivePath})\n`;
            }
            await archive.text(`chats/private-${chat.id}.md`, md);
        }
        for (const chat of data.parlor_conversations) {
            let md = `# ${chat.title || 'Discussion'}\n\nOwner: ${chat.ownerId}\n`;
            for (const message of matching('parlor_messages', 'conversationId', chat.id)) {
                md += `\n## ${message.role === 'persona' ? message.personaName : message.userName || message.userId || chat.ownerId} · ${message.createdAt}\n\n${message.content}\n`;
                for (const file of message.attachments) if (file.archivePath) md += `\n[${safeName(file.name)}](../${file.archivePath})\n`;
            }
            await archive.text(`chats/discussion-${chat.id}.md`, md);
        }
        for (const chat of data.conversations.filter(c => c.guildConversationId == null)) {
            const messages = matching('messages', 'conversationId', chat.id).filter(m => m.guildConversationId == null);
            let md = '# Private conversation\n';
            for (const message of messages) {
                md += `\n## ${message.isBot ? 'Goobster' : 'You'} · ${message.createdAt}\n\n${message.message}\n`;
                for (const file of message.metadata?.attachments || []) if (file.archivePath) md += `\n[${safeName(file.name)}](../${file.archivePath})\n`;
            }
            await archive.text(`chats/legacy-${chat.id}.md`, md);
        }
        for (const brief of data.expedition_briefs.filter(b => b.status === 'READY')) {
            const generated = parsed(brief.generatedJson);
            const expedition = matching('spitball_expeditions', 'id', brief.expeditionId)[0];
            await archive.text(`research/brief-${brief.id}.md`, require('./expeditionBrief').exportMarkdown({ brief, expedition, generated,
                overlay: parsed(brief.overlayJson), review: parsed(brief.reviewJson) }));
        }
        for (const [table, rows] of Object.entries(data)) await archive.text(`data/${table}.json`, json(rows));
        await archive.text('settings-and-report.json', json(settings));
        await archive.text('README.md', '# Goobster account export\n\nOpen notes/, chats/ and projects/ for readable content. data/ contains the complete selected records. manifest.json records IDs, relationships, file hashes and unavailable files. Files are unencrypted; keep this archive private. This is an account export, not an instance backup or an import package.\n\nPrivate data and owned projects/discussions are included. Shared content retains author/publisher attribution. Joined projects, other accounts’ private sources, credentials, session/share tokens, server transcripts, caches, vector indexes and optional game/trading/deck stores are excluded. External resources are recorded but never downloaded. Database records use a consistent snapshot; files are copied afterwards and changing files cause a visible failure. Missing or unsafe files are listed in the manifest, never silently dropped.\n');
        const ddl = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
        const relationships = [];
        for (const fk of extractCreateTableForeignKeys(ddl).fks) {
            for (const row of data[fk.table] || []) {
                const id = row[fk.column]; if (id == null) continue;
                const target = matching(fk.refTable, fk.refColumn, id)[0];
                relationships.push({ from: { table: fk.table, id: row.id, column: fk.column, path: `data/${fk.table}.json`, pointer: `/${position.get(row)}` }, to: { table: fk.refTable, id },
                    ...(target ? { path: `data/${fk.refTable}.json`, pointer: `/${position.get(target)}` } : { status: 'outside_export' }) });
            }
        }
        const provenanceTables = { memory: 'memory_embeddings', fact: 'facts', research_claim: 'research_claims', research_source: 'research_sources',
            expedition: 'spitball_expeditions', parlor_conversation: 'parlor_conversations', artifact: 'kg_artifacts' };
        for (const row of data.kg_provenance) {
            const table = provenanceTables[row.sourceKind]; if (!table || row.sourceId == null) continue;
            const target = matching(table, 'id', Number(row.sourceId))[0] || matching(table, 'id', row.sourceId)[0];
            const index = target ? position.get(target) : -1;
            relationships.push({ from: { table: 'kg_provenance', id: row.id, column: 'sourceId', path: 'data/kg_provenance.json', pointer: `/${position.get(row)}` }, to: { table, id: row.sourceId },
                ...(index >= 0 ? { path: `data/${table}.json`, pointer: `/${index}` } : { status: 'outside_export' }) });
        }
        return await archive.finish({ format: 'goobster-account', version: 1, userId, exportedAt: new Date().toISOString(), records, relationships });
    } catch (e) { await archive.abort(); throw e; }
}
module.exports = { buildArchive, safeOpen };
