/**
 * Run capability: the linked project's workspace files. Listing and reading
 * need `read` on that `project`; writing needs `file.edit` (within the
 * grant's `paths`). Offered only when the responsibility links a project.
 */

const requireOptional = require('../../../utils/optionalModule').forModule(module);
const { sha, clip } = require('./shared');

const FILE_CHARS = 12_000;
const WRITE_CHARS = 200_000;

const linked = ({ project }) => Boolean(project);

module.exports = {
    listProjectFiles: {
        effect: 'read',
        available: linked,
        definition: {
            name: 'listProjectFiles',
            description: 'List one folder of the linked project\'s workspace ("" is the top folder).',
            parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Workspace-relative folder.' } } }
        },
        needs: ({ dir }, ctx) => (ctx.project
            ? { operation: 'read', resource: { kind: 'project', id: String(ctx.project.id), path: String(dir || '').replace(/\/+$/, '') || undefined } }
            : { refuse: 'NO_PROJECT' }),
        async run({ dir }, ctx) {
            const projects = requireOptional('../../projectService', { feature: 'projects' });
            if (!projects) return 'Projects are not available on this installation.';
            const listing = await projects.listFiles({
                userId: ctx.actor, project: ctx.project.slug, owner: ctx.project.ownerId, path: String(dir || '')
            });
            const entries = (listing.files || listing.entries || []).slice(0, 200);
            return entries.length
                ? entries.map(entry => `${entry.kind === 'directory' ? 'dir ' : 'file'} ${entry.path}${entry.kind === 'directory' ? '/' : ` (${entry.size} bytes)`}`).join('\n')
                : 'That folder is empty.';
        }
    },
    readProjectFile: {
        effect: 'read',
        available: linked,
        definition: {
            name: 'readProjectFile',
            description: 'Read one text file from the linked project\'s workspace.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'] }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'read', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        async run({ path }, ctx) {
            const projects = requireOptional('../../projectService', { feature: 'projects' });
            if (!projects) return 'Projects are not available on this installation.';
            const file = await projects.readWorkspaceFile({
                userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), purpose: 'portal'
            });
            ctx.fileHashes.set(String(path), sha(file.bytes));
            if (!/^text\/|json|xml|yaml|javascript|markdown/.test(file.mime)) return `That file is ${file.mime}, not text (${file.size} bytes).`;
            return clip(file.bytes.toString('utf8'), FILE_CHARS);
        }
    },
    writeProjectFile: {
        effect: 'write',
        component: 'projects',
        publishes: 'project',
        available: linked,
        definition: {
            name: 'writeProjectFile',
            description: 'Create or replace one text file in the linked project\'s workspace. To change an existing file, read it with readProjectFile first in this same task; a file that changed since you read it is refused. The previous version stays in the project\'s history.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file path.' },
                    content: { type: 'string', description: 'The whole new file.' }
                },
                required: ['path', 'content']
            }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'file.edit', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        async _current(path, ctx) {
            const projects = requireOptional('../../projectService', { feature: 'projects' });
            if (!projects) return { missing: true };
            try {
                const file = await projects.readWorkspaceFile({
                    userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), purpose: 'portal'
                });
                return { hash: sha(file.bytes) };
            } catch (error) {
                if (error?.code === 'NOT_FOUND') return { missing: true };
                throw error;
            }
        },
        /** After a crash: the file holding exactly this content means the write happened. */
        async reconcile({ path, content }, ctx) {
            const current = await this._current(path, ctx);
            if (!current.missing && current.hash === sha(Buffer.from(String(content ?? '')))) {
                return { state: 'done', result: `Wrote ${String(path)}.` };
            }
            return { state: 'unknown' };
        },
        async run({ path, content }, ctx) {
            const projects = requireOptional('../../projectService', { feature: 'projects' });
            if (!projects) return 'Not written: projects are not available on this installation.';
            const text = String(content ?? '');
            if (text.length > WRITE_CHARS) return `Not written: the file is longer than ${WRITE_CHARS} characters.`;
            const current = await this._current(path, ctx);
            if (!current.missing) {
                const seen = ctx.fileHashes.get(String(path));
                if (!seen) return 'Not written: that file exists. Read it with readProjectFile first.';
                if (seen !== current.hash) return 'Not written: the file changed since you read it. Read it again before deciding.';
            }
            await projects.writeWorkspaceFile({
                userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), bytes: Buffer.from(text)
            });
            ctx.fileHashes.set(String(path), sha(Buffer.from(text)));
            return `Wrote ${String(path)}.`;
        }
    }
};
