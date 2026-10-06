/** Descriptor text for projects, execution, MCP and the knowledge features. See adapters.js for the rules. */
module.exports = {
    projects: {
        title: 'Projects',
        summary: 'Workshop projects: rooms, members, files, assets, plans, missions, triggers and applets. Organisation works without code execution.',
        legacy: {
            kind: 'flag',
            semantics: 'env-bool-or-boolean',
            note: 'GOOBSTER_PROJECTS_ENABLED 0/false off or 1/true on, then projects.enabled true/false, default on (config/observatoryConfig.js projectsEnabled).'
        },
        apiKeys: [],
        configKeys: ['projects.enabled'],
        docs: ['documentation/projects.md']
    },
    observatory: {
        title: 'Observatory',
        summary: 'Code execution inside projects: runs, background jobs and video rendering. Needs Projects and the Sandbox.',
        legacy: {
            kind: 'flag',
            semantics: 'env-on-or-true',
            note: 'GOOBSTER_OBSERVATORY_ENABLED 1/true, or observatory.enabled === true, default off (config/observatoryConfig.js enabled).'
        },
        apiKeys: [],
        configKeys: ['observatory.enabled', 'observatory.ffmpegCommand'],
        docs: ['documentation/projects.md', 'documentation/code_sandbox.md']
    },
    sandbox: {
        title: 'Sandbox',
        summary: 'The code-execution runner behind the runCode tool, with isolation, limits and an approved package overlay.',
        legacy: {
            kind: 'flag',
            semantics: 'env-on-or-true',
            note: 'GOOBSTER_SANDBOX_ENABLED 1/true, or sandbox.enabled === true, default off (config/sandboxConfig.js enabled).'
        },
        apiKeys: [],
        configKeys: ['sandbox.enabled', 'sandbox.scope', 'sandbox.approverUserIds'],
        docs: ['documentation/code_sandbox.md']
    },
    mcp: {
        title: 'MCP server',
        summary: 'A read-only Model Context Protocol endpoint over one person\'s workspace. Exposes only the features that are available; requires none of them.',
        legacy: {
            kind: 'flag',
            semantics: 'tri-state',
            note: 'GOOBSTER_MCP_ENABLED (any value except 0/false/no/off turns it on), then mcp.enabled, default off (config/mcpConfig.js enabled).'
        },
        apiKeys: [],
        configKeys: ['mcp.enabled', 'mcp.maxTokensPerUser', 'mcp.requestsPerMinute', 'mcp.defaultTokenDays'],
        docs: ['documentation/mcp.md'],
        helpUrl: 'https://modelcontextprotocol.io'
    },
    knowledge: {
        title: 'Knowledge',
        summary: 'The Spitball editing surface: notes, transfers, note attachments and the Knowledge room.',
        apiKeys: [],
        configKeys: [],
        docs: ['documentation/user_knowledge_graph.md', 'documentation/spitball_expeditions.md']
    },
    expeditions: {
        title: 'Expeditions',
        summary: 'Autonomous, budgeted research runs over the knowledge graph, with briefs. Depends on Knowledge.',
        legacy: {
            kind: 'flag',
            semantics: 'off-only-when-false',
            note: 'On unless GOOBSTER_SPITBALL_ENABLED is 0/false or spitball.enabled === false (config/spitballConfig.js enabled).'
        },
        apiKeys: [
            {
                name: 'PERPLEXITY_API_KEY',
                configPath: 'perplexity.apiKey',
                purpose: 'Better web search for research cycles; Expeditions fall back to Wikipedia without it.',
                required: false
            }
        ],
        configKeys: ['spitball.enabled', 'spitball.maxActiveExpeditionsPerUser'],
        docs: ['documentation/spitball_expeditions.md']
    }
};
