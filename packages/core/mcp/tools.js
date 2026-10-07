/**
 * Read-only MCP tools over one person's private workspace.
 *
 * Every handler takes the token's user id and reads only that person's
 * DM scope (`dm:<userId>`), their projects, their inbox, and their
 * research. Guild memories and other people's rows are out of reach.
 * There is no write tool, and the descriptors say so (`readOnlyHint`).
 *
 * Semantic memory recall runs only when OpenAI embeddings are configured.
 * A local Ollama embed call is not made from here: its client timeout is
 * two minutes, and a down daemon must not stall an MCP client. Keyword
 * search always runs.
 */

const { dmScopeId } = require('../utils/dmScope');
const mcpConfig = require('../config/mcpConfig');
const { KINDS } = require('../services/selfDocsService');
const { surfaceActive, GateError } = require('../features/gate');
const { features } = require('../features/featureState');

const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

function clip(text, max = mcpConfig.maxResultChars) {
    const value = String(text ?? '');
    if (value.length <= max) return value;
    return `${value.slice(0, max)}\n… truncated.`;
}

function boundedInt(value, def, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function textArg(value, max) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function likeContains(value) {
    return `%${String(value).replace(/[#%_]/g, '#$&')}%`;
}

function tool(name, description, properties, required = []) {
    return {
        name,
        description,
        inputSchema: {
            type: 'object',
            properties,
            required,
            additionalProperties: false
        },
        annotations: { ...READ_ONLY }
    };
}

const TOOLS = [
    tool('list_docs',
        'List Goobster\'s own documentation (the manual for this installation). '
        + 'Use kind "skill" for step-by-step procedures.',
        {
            kind: { type: 'string', enum: KINDS, description: 'Optional kind filter.' }
        }),
    tool('search_docs',
        'Search Goobster\'s documentation for how a feature, command, or setting works.',
        {
            query: { type: 'string', description: 'What you need to know, in plain words.' },
            kind: { type: 'string', enum: KINDS },
            limit: { type: 'integer', description: 'Max results, 1-8. Default 5.' }
        },
        ['query']),
    tool('read_doc',
        'Read one Goobster document, or one section of it, by slug or title.',
        {
            slug: { type: 'string', description: 'Document slug, path, or title from list_docs or search_docs.' },
            section: { type: 'string', description: 'Optional heading to narrow to.' },
            offset: { type: 'integer', description: '1-based line to start at.' },
            limit: { type: 'integer', description: 'Max lines, up to 800. Default 400.' }
        },
        ['slug']),
    tool('search_memories',
        'Search this person\'s private memories (their DM scope with Goobster). '
        + 'Does not search server channels.',
        {
            query: { type: 'string' },
            limit: { type: 'integer', description: 'Max memories, 1-20. Default 8.' }
        },
        ['query']),
    tool('list_facts',
        'List facts Goobster has stored about this person in their private scope.',
        {
            limit: { type: 'integer', description: 'Max facts, 1-50. Default 20.' }
        }),
    tool('search_knowledge',
        'Search this person\'s knowledge notes. Without a project, that is their personal graph. '
        + 'With a project slug, that project\'s notes, when they can open the project.',
        {
            query: { type: 'string', description: 'Words to match. Empty returns the most salient notes.' },
            project: { type: 'string', description: 'Optional project slug or name.' },
            limit: { type: 'integer', description: 'Max notes, 1-20. Default 8.' }
        }),
    tool('list_projects',
        'List projects this person owns or collaborates on. Metadata only.',
        {}),
    tool('get_project',
        'Read one project\'s name, description, and counts. Does not return file contents.',
        {
            project: { type: 'string', description: 'Project slug or name.' },
            owner: { type: 'string', description: 'Owner id when the same slug exists on more than one project.' }
        },
        ['project']),
    tool('list_project_files',
        'List file names and sizes in a project workspace. Does not return file contents.',
        {
            project: { type: 'string' },
            owner: { type: 'string' }
        },
        ['project']),
    tool('list_inbox',
        'List this person\'s inbox items (reminders, task results, notices).',
        {
            unread: { type: 'boolean' },
            limit: { type: 'integer', description: 'Max items, 1-30. Default 15.' }
        }),
    tool('get_inbox_item',
        'Read one inbox item this person owns.',
        {
            id: { type: 'integer' }
        },
        ['id']),
    tool('list_expeditions',
        'List this person\'s Spitball research expeditions.',
        {
            limit: { type: 'integer', description: 'Max expeditions, 1-30. Default 10.' }
        }),
    tool('get_expedition',
        'Read one expedition: topic, status, summary, and accepted source titles.',
        {
            id: { type: 'integer' }
        },
        ['id']),
    tool('list_briefs',
        'List research briefs this person owns.',
        {
            limit: { type: 'integer', description: 'Max briefs, 1-30. Default 10.' }
        }),
    tool('get_brief',
        'Read one research brief: summary, findings, limitations, and citations.',
        {
            id: { type: 'integer' }
        },
        ['id'])
];

/**
 * Which tools a token scope may see and call. `read` is everything; `docs`
 * is the manual only. An unrecognized scope gets nothing, so a bad row
 * fails closed.
 */
const DOC_TOOLS = Object.freeze(['list_docs', 'search_docs', 'read_doc']);

/**
 * Whether the installation's feature state offers this MCP tool: its owning
 * feature, and any feature it also requires, must be active. Evaluated on
 * every listing and every call, never cached. A tool nobody owns fails
 * closed rather than being served.
 */
function toolAvailable(name) {
    try {
        return surfaceActive('mcpTool', name);
    } catch (error) {
        if (error instanceof GateError) return false;
        throw error;
    }
}

function allowedToolNames(scope = 'read') {
    if (scope === 'read') return TOOLS.map(entry => entry.name);
    if (scope === 'docs') return [...DOC_TOOLS];
    return [];
}

function toolDescriptors({ scope = 'read' } = {}) {
    const allowed = new Set(allowedToolNames(scope));
    return TOOLS
        .filter(entry => allowed.has(entry.name) && toolAvailable(entry.name))
        .map(entry => ({ ...entry, annotations: { ...entry.annotations } }));
}

function toolNames() {
    return TOOLS.filter(entry => toolAvailable(entry.name)).map(entry => entry.name);
}

function asText(text, isError = false) {
    const result = { content: [{ type: 'text', text: clip(text) }] };
    if (isError) result.isError = true;
    return result;
}

function serviceMessage(error) {
    if (error?.status && error?.code && error?.message) return error.message;
    const message = String(error?.message || '');
    if (message && message.length < 300 && !/\b(select|insert|update|delete)\b/i.test(message)) return message;
    return 'The tool failed.';
}

async function includeOperatorDocs(userId) {
    try {
        const account = await require('../services/identityService').getAccount(userId);
        return account?.status === 'active' && account?.role === 'operator';
    } catch {
        return false;
    }
}

async function withDocs(userId, run) {
    const selfDocs = require('../services/selfDocsService');
    const config = require('../config/selfDocsConfig');
    if (!config.enabled) return asText('Documentation search is turned off on this installation.', true);
    await selfDocs.ensureSeeded();
    const includeOperator = await includeOperatorDocs(userId);
    return run(selfDocs, includeOperator);
}

function formatDocList(docs) {
    if (!docs.length) return 'No documents are seeded.';
    return docs.map(doc => {
        const bits = [`- ${doc.title} (slug: ${doc.slug}, kind: ${doc.kind})`];
        if (doc.summary) bits.push(`  ${doc.summary}`);
        return bits.join('\n');
    }).join('\n');
}

function formatDocSearch(query, result) {
    if (!result.results.length) return `No documentation matches "${query}".`;
    return result.results.map((hit, i) => (
        `[${i + 1}] ${hit.headingPath} — ${hit.kind}, ${hit.relPath} (slug: ${hit.slug})\n${hit.content}`
    )).join('\n\n');
}

async function searchMemories(userId, args) {
    const query = textArg(args.query, 500);
    if (!query) return asText('search_memories needs a query.', true);
    const limit = boundedInt(args.limit, 8, 1, 20);
    const guildId = dmScopeId(userId);
    const db = require('../db');
    const keywordRows = await db.all(
        `SELECT content, authorName, createdAt FROM memory_embeddings
         WHERE guildId = @guildId AND content LIKE @like ESCAPE '#'
         ORDER BY createdAt DESC LIMIT @limit`,
        { guildId, like: likeContains(query), limit }
    );
    const seen = new Set(keywordRows.map(row => row.content));
    const semantic = [];
    const embeddingService = require('../services/embeddingService');
    if (embeddingService.getBackend() === 'openai') {
        try {
            const recalled = await require('../services/memoryService').recall({
                guildId, query, limit, authorId: null
            });
            for (const row of recalled) {
                if (seen.has(row.content)) continue;
                seen.add(row.content);
                semantic.push(row);
            }
        } catch {
            // Keyword hits still stand when the embedding call fails.
        }
    }
    const lines = [];
    for (const row of keywordRows) {
        lines.push(`- [${row.createdAt}] ${row.authorName || 'unknown'} (keyword): ${row.content}`);
    }
    for (const row of semantic) {
        lines.push(`- [${row.createdAt}] ${row.authorName || 'unknown'} (semantic): ${row.content}`);
    }
    if (!lines.length) return asText(`No private memories match "${query}".`);
    return asText(lines.slice(0, limit).join('\n'));
}

async function listFacts(userId, args) {
    const limit = boundedInt(args.limit, 20, 1, 50);
    const facts = await require('../services/factsService').listFactsForScope({
        guildId: dmScopeId(userId),
        subjectType: 'USER',
        subjectId: String(userId),
        limit
    });
    if (!facts.length) return asText('No private facts are stored.');
    return asText(facts.map(fact => `- ${fact.content}`).join('\n'));
}

async function knowledgeScope(userId, project) {
    if (!project) {
        return { guildId: dmScopeId(userId), scopeKey: `USER:${userId}`, label: 'personal notes' };
    }
    const projectService = require('../services/projectService');
    const row = await projectService.resolveProject({ userId, project });
    const coords = projectService.knowledgeCoords(row);
    return { guildId: coords.guildId, scopeKey: coords.scopeKey, label: `project ${row.slug}` };
}

function formatNodes(nodes, label) {
    if (!nodes.length) return `No notes in ${label}.`;
    return nodes.map(node => {
        const body = textArg(node.content || '', 600);
        return `- [${node.type}] ${node.label}${body ? `: ${body}` : ''}`;
    }).join('\n');
}

async function searchKnowledge(userId, args) {
    const knowledge = require('../services/knowledgeGraphService');
    const scope = await knowledgeScope(userId, textArg(args.project, 120) || null);
    const limit = boundedInt(args.limit, 8, 1, 20);
    const query = textArg(args.query, 300);
    const nodes = query
        ? await knowledge.searchNodes({ ...scope, query, limit })
        : await knowledge.topNodes(scope.guildId, scope.scopeKey, limit);
    return asText(`${scope.label}\n${formatNodes(nodes, scope.label)}`);
}

function formatProject(project) {
    const bits = [`- ${project.name} (slug: ${project.slug}, role: ${project.role})`];
    if (project.description) bits.push(`  ${project.description}`);
    bits.push(`  updated ${project.updatedAt}, jobs ${project.totalJobs}, members ${project.memberCount}`);
    return bits.join('\n');
}

async function listProjects(userId) {
    const projects = await require('../services/projectService').listProjects(userId);
    if (!projects.length) return asText('No projects.');
    return asText(projects.map(formatProject).join('\n'));
}

async function findProject(userId, args) {
    const project = textArg(args.project, 120);
    if (!project) {
        const error = new Error('project');
        error.status = 400;
        error.code = 'BAD_PROJECT';
        error.message = 'Name the project by slug or name.';
        throw error;
    }
    const projects = await require('../services/projectService').listProjects(userId);
    const owner = textArg(args.owner, 80);
    const matches = projects.filter(row => row.slug === project || row.name === project);
    const picked = owner ? matches.filter(row => row.ownerId === owner) : matches;
    if (picked.length === 1) return picked[0];
    if (picked.length > 1) {
        const error = new Error('ambiguous');
        error.status = 400;
        error.code = 'AMBIGUOUS';
        error.message = 'More than one project has that name. Pass owner.';
        throw error;
    }
    const error = new Error('missing');
    error.status = 404;
    error.code = 'NOT_FOUND';
    error.message = 'No such project.';
    throw error;
}

async function getProject(userId, args) {
    return asText(formatProject(await findProject(userId, args)));
}

async function listProjectFiles(userId, args) {
    const project = await findProject(userId, args);
    const listing = await require('../services/projectService').listFiles({
        userId,
        project: project.slug,
        owner: project.ownerId
    });
    const files = (listing.files || []).slice(0, 100);
    if (!files.length) return asText(`${project.slug}: no files.`);
    const lines = files.map(file => `- ${file.path} (${file.size} bytes)`);
    const extra = (listing.files || []).length - files.length;
    if (extra > 0) lines.push(`… ${extra} more files omitted.`);
    return asText(lines.join('\n'));
}

function formatInboxItem(item, { full = false } = {}) {
    const body = item.body ? textArg(item.body, full ? 4000 : 400) : '';
    return [
        `#${item.id} [${item.kind}] ${item.title}${item.read ? '' : ' (unread)'}`,
        item.createdAt ? `at ${item.createdAt}` : '',
        body
    ].filter(Boolean).join('\n');
}

async function listInbox(userId, args) {
    const page = await require('../services/inboxService').list({
        userId,
        unread: args.unread === true,
        limit: boundedInt(args.limit, 15, 1, 30)
    });
    if (!page.items.length) return asText(args.unread === true ? 'No unread inbox items.' : 'The inbox is empty.');
    return asText(page.items.map(item => formatInboxItem(item)).join('\n\n'));
}

async function getInboxItem(userId, args) {
    const item = await require('../services/inboxService').get({
        userId,
        itemId: boundedInt(args.id, 0, 0, Number.MAX_SAFE_INTEGER)
    });
    return asText(formatInboxItem(item, { full: true }));
}

function formatExpedition(row) {
    const lines = [
        `#${row.id} [${row.status}] ${row.seed}`,
        row.intent ? `intent: ${row.intent}` : '',
        `depth ${row.depth}, cycle ${row.currentCycle}/${row.maxCycles}, sources ${row.sourcesAccepted}, notes ${row.notesCreated}`,
        row.summary ? `summary: ${textArg(row.summary, 2000)}` : '',
        row.stopReason ? `stopped: ${row.stopReason}` : ''
    ];
    return lines.filter(Boolean).join('\n');
}

async function listExpeditions(userId, args) {
    const rows = await require('../services/spitballExpeditionService').listExpeditions({
        userId,
        limit: boundedInt(args.limit, 10, 1, 30)
    });
    if (!rows.length) return asText('No expeditions.');
    return asText(rows.map(formatExpedition).join('\n\n'));
}

async function getExpedition(userId, args) {
    const service = require('../services/spitballExpeditionService');
    const id = boundedInt(args.id, 0, 0, Number.MAX_SAFE_INTEGER);
    const row = await service.getExpedition(id, { userId });
    const sources = await service.listSources(id, { userId, acceptedOnly: true });
    const sourceLines = sources.slice(0, 30).map(source => {
        const title = source.title || source.url || 'untitled';
        return `- ${title}${source.url ? ` (${source.url})` : ''}`;
    });
    const extra = sources.length - sourceLines.length;
    const body = [
        formatExpedition(row),
        sourceLines.length ? `Accepted sources:\n${sourceLines.join('\n')}` : 'No accepted sources.',
        extra > 0 ? `… ${extra} more sources omitted.` : ''
    ].filter(Boolean).join('\n\n');
    return asText(body);
}

async function listBriefs(userId, args) {
    const rows = await require('../services/expeditionBriefService').listForUser({
        userId,
        limit: boundedInt(args.limit, 10, 1, 30)
    });
    if (!rows.length) return asText('No research briefs.');
    return asText(rows.map(row => (
        `#${row.id} expedition ${row.expeditionId} [${row.status}]`
        + `${row.quality ? ` quality ${row.quality}` : ''}`
        + `${row.findings ? `, ${row.findings} findings` : ''}`
    )).join('\n'));
}

function blockText(block) {
    if (!block) return '';
    return textArg(block.text || block.generated || '', 2000);
}

async function getBrief(userId, args) {
    const detail = await require('../services/expeditionBriefService').get(
        boundedInt(args.id, 0, 0, Number.MAX_SAFE_INTEGER),
        { userId }
    );
    const meta = detail.brief;
    if (!detail.rendered) {
        return asText(`Brief #${meta.id} is ${meta.status}${meta.errorCode ? ` (${meta.errorCode})` : ''}.`);
    }
    const rendered = detail.rendered;
    const lines = [
        `Brief #${meta.id} (expedition ${meta.expeditionId}, ${meta.status}`
        + `${detail.quality?.status ? `, quality ${detail.quality.status}` : ''})`,
        blockText(rendered.summary) ? `Summary: ${blockText(rendered.summary)}` : '',
        (rendered.findings || []).length
            ? `Findings:\n${rendered.findings.map(finding => `- ${blockText(finding)}`).join('\n')}`
            : '',
        (rendered.limitations || []).length
            ? `Limitations:\n${rendered.limitations.map(item => `- ${blockText(item)}`).join('\n')}`
            : '',
        (rendered.citations || []).length
            ? `Citations:\n${rendered.citations.slice(0, 30).map(citation => {
                const label = citation.title || citation.url || citation.n || 'source';
                return `- ${label}${citation.url ? ` (${citation.url})` : ''}`;
            }).join('\n')}`
            : ''
    ];
    return asText(lines.filter(Boolean).join('\n\n'));
}

const HANDLERS = {
    list_docs: async (userId, args) => withDocs(userId, async (selfDocs, includeOperator) => {
        const kind = KINDS.includes(args.kind) ? args.kind : null;
        const docs = await selfDocs.listDocs({ kind, includeOperator });
        return asText(formatDocList(docs));
    }),
    search_docs: async (userId, args) => withDocs(userId, async (selfDocs, includeOperator) => {
        const query = textArg(args.query, 500);
        if (!query) return asText('search_docs needs a query.', true);
        const kind = KINDS.includes(args.kind) ? args.kind : null;
        const result = await selfDocs.search({
            query,
            kind,
            limit: boundedInt(args.limit, 5, 1, 8),
            includeOperator
        });
        return asText(formatDocSearch(query, result));
    }),
    read_doc: async (userId, args) => withDocs(userId, async (selfDocs, includeOperator) => {
        const slug = textArg(args.slug, 300);
        if (!slug) return asText('read_doc needs a slug.', true);
        const result = await selfDocs.readDoc({
            ref: slug,
            section: textArg(args.section, 200) || null,
            offset: args.offset,
            limit: boundedInt(args.limit, 400, 1, 800),
            includeOperator
        });
        if (!result) return asText(`No document matches "${slug}".`, true);
        const { doc, window } = result;
        return asText(`${doc.title} (${doc.relPath}), lines ${window.startLine}-${window.endLine} of ${window.totalLines}\n\n${window.content}`);
    }),
    search_memories: searchMemories,
    list_facts: listFacts,
    search_knowledge: searchKnowledge,
    list_projects: listProjects,
    get_project: getProject,
    list_project_files: listProjectFiles,
    list_inbox: listInbox,
    get_inbox_item: getInboxItem,
    list_expeditions: listExpeditions,
    get_expedition: getExpedition,
    list_briefs: listBriefs,
    get_brief: getBrief
};

/**
 * Run one tool for the authenticated user.
 * Unknown names are a protocol error. A service refusal is `isError`.
 */
async function callTool(userId, name, args, { scope = 'read' } = {}) {
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : null;
    if (!handler) {
        const error = new Error('unknown tool');
        error.rpcCode = -32602;
        error.publicMessage = `Unknown tool: ${name}`;
        throw error;
    }
    if (!allowedToolNames(scope).includes(name)) {
        const error = new Error('tool out of scope');
        error.rpcCode = -32602;
        error.publicMessage = `This token's "${scope}" scope does not include ${name}.`;
        throw error;
    }
    // After the token's own scope, before any handler (and so any read) runs.
    if (!toolAvailable(name)) {
        const error = new Error('tool unavailable');
        error.rpcCode = -32602;
        error.publicMessage = `${name} is not available on this installation.`;
        throw error;
    }
    try {
        return await handler(userId, args || {});
    } catch (error) {
        if (error?.rpcCode) throw error;
        if (!(error?.status && error?.code)) {
            console.warn(`[mcp] ${name} failed: ${error?.message || error}`);
        }
        return asText(serviceMessage(error), true);
    }
}

function describeServer() {
    return {
        enabled: features.isActive('mcp'),
        endpoint: mcpConfig.path,
        readOnly: true,
        tools: toolNames(),
        resources: true
    };
}

module.exports = {
    TOOLS,
    DOC_TOOLS,
    toolDescriptors,
    toolNames,
    allowedToolNames,
    toolAvailable,
    callTool,
    clip,
    includeOperatorDocs,
    describeServer
};
