/**
 * Feature ownership inventory (#316, P1.1).
 *
 * packages/core/features/inventory.js claims every optional surface for one
 * feature id. This spec enumerates the same surfaces from the code itself
 * (readdir, regex over the sources, the tool registry, the portal's Express
 * router stacks, schema.sql, the room and tutorial catalogs) and compares in
 * both directions: an unclaimed surface fails, a stale claim fails, and a
 * route rule that never wins a match fails. Nothing here is a hand-kept
 * count.
 *
 * When this spec fails for a surface you just added, add it to the matching
 * section of the inventory and pick its owner (`core` when it must stay
 * available with every optional feature off).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inventory = require('@goobster/core/features/inventory');

const ROOT = path.resolve(__dirname, '..');
const {
    FEATURE_IDS, FEATURES, commands, contextMenus, runtimeSteps, eventGates, interactionTypes,
    aiTools, mcpTools, mcpResources, routeRules, wsPaths, staticAssets, rooms, tutorials, tables,
    legacySwitches, systemDependencies, knownGaps, ownerOf
} = inventory;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function walkJs(relativeDir, { skip = [] } = {}) {
    const found = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(ROOT, full).split(path.sep).join('/');
            if (skip.some((prefix) => rel.startsWith(prefix))) continue;
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.js')) found.push(rel);
        }
    };
    visit(path.join(ROOT, relativeDir));
    return found;
}

function matches(source, regex, group = 1) {
    return [...source.matchAll(regex)].map((m) => m[group]).filter(Boolean);
}

/** Fail with one message naming every unclaimed and every stale identifier. */
function assertSameSet(label, actual, claimed, where) {
    const actualSet = new Set(actual);
    const claimedSet = new Set(claimed);
    const unclaimed = [...actualSet].filter((id) => !claimedSet.has(id)).sort();
    const stale = [...claimedSet].filter((id) => !actualSet.has(id)).sort();
    const problems = [];
    if (unclaimed.length) {
        problems.push(`Unclaimed ${label}: ${unclaimed.join(', ')}. Add each to \`${where}\` in packages/core/features/inventory.js.`);
    }
    if (stale.length) {
        problems.push(`Stale ${label} (claimed by the inventory but not found in the code): ${stale.join(', ')}.`);
    }
    if (problems.length) throw new Error(`\n${problems.join('\n')}`);
}

function ownersIn(value) {
    if (value == null) return [];
    if (typeof value === 'string') return [{ owner: value, alsoRequires: [] }];
    return [{ owner: value.owner, alsoRequires: value.alsoRequires || [] }];
}

describe('feature inventory module', () => {
    test('requires nothing and reads no config or database', () => {
        const source = read('packages/core/features/inventory.js');
        expect(source).not.toMatch(/\brequire\s*\(/);
        expect(source).not.toMatch(/^\s*import\s/m);
    });

    test('ownerOf resolves every kind and rejects unknown kinds', () => {
        expect(ownerOf('command', 'economy/wheel.js')).toEqual({ owner: 'gambling', alsoRequires: ['exchange'] });
        expect(ownerOf('command', 'nope/none.js')).toBeNull();
        expect(ownerOf('aiTool', 'runCode')).toEqual({ owner: 'sandbox', alsoRequires: [] });
        expect(ownerOf('table', 'tavern_lore').owner).toBe('tavern');
        expect(ownerOf('table', 'memory_vec_1536').owner).toBe('core');
        expect(ownerOf('table', 'no_such_table')).toBeNull();
        expect(ownerOf('tutorial', 'trading.basics')).toEqual({ owner: 'exchange', alsoRequires: ['discord'] });
        expect(ownerOf('staticAsset', '/app/icons/goobster.svg').owner).toBe('core');
        expect(ownerOf('staticAsset', '/anything/else')).toBeNull();
        expect(ownerOf('route', 'POST /api/app/projects/:slug/chat').owner).toBe('observatory');
        expect(ownerOf('route', '/api/app/projects/:slug/chat', 'GET')).toEqual({ owner: 'projects', alsoRequires: [] });
        expect(ownerOf('route', 'GET /api/app/not-a-router')).toBeNull();
        expect(ownerOf('wsPath', '/api/activity/ws')).toEqual({ owner: 'discordActivity', alsoRequires: ['gambling'] });
        expect(ownerOf('route', 'GET /api/activity/music/casino')).toEqual({ owner: 'discordActivity', alsoRequires: ['gambling'] });
        expect(ownerOf('route', 'GET /api/activity/config')).toEqual({ owner: 'discordActivity', alsoRequires: [] });
        expect(ownerOf('table', 'table_games')).toEqual({ owner: 'gambling', alsoRequires: ['discordActivity'] });
        expect(() => ownerOf('banana', 'x')).toThrow(/unknown kind/);
    });
});

describe('feature graph', () => {
    test('FEATURE_IDS are unique and FEATURES has exactly those ids', () => {
        expect(new Set(FEATURE_IDS).size).toBe(FEATURE_IDS.length);
        expect(Object.keys(FEATURES).sort()).toEqual([...FEATURE_IDS].sort());
        for (const feature of Object.values(FEATURES)) {
            expect(['on', 'off', 'always']).toContain(feature.freshDefault);
            expect(['pseudo-owner', 'adapter', 'feature']).toContain(feature.kind);
            expect(Array.isArray(feature.dependsOn)).toBe(true);
        }
        expect(FEATURES.core).toMatchObject({ kind: 'pseudo-owner', freshDefault: 'always' });
    });

    test('dependsOn targets exist, are acyclic, and never include core', () => {
        const ids = new Set(FEATURE_IDS);
        expect(FEATURES.core.dependsOn).toEqual([]);
        for (const [id, feature] of Object.entries(FEATURES)) {
            for (const dep of feature.dependsOn) {
                if (!ids.has(dep)) throw new Error(`${id} depends on unknown feature "${dep}".`);
                if (dep === 'core') throw new Error(`${id} must not depend on core; core is always available.`);
                if (dep === id) throw new Error(`${id} depends on itself.`);
            }
        }
        const state = new Map();
        const visit = (id, trail) => {
            if (state.get(id) === 'done') return;
            if (state.get(id) === 'active') throw new Error(`Dependency cycle: ${[...trail, id].join(' -> ')}`);
            state.set(id, 'active');
            for (const dep of FEATURES[id].dependsOn) visit(dep, [...trail, id]);
            state.set(id, 'done');
        };
        for (const id of FEATURE_IDS) visit(id, []);
    });

    function transitiveDeps(id, seen = new Set()) {
        for (const dep of FEATURES[id].dependsOn) {
            if (!seen.has(dep)) {
                seen.add(dep);
                transitiveDeps(dep, seen);
            }
        }
        return seen;
    }

    test('every owner and alsoRequires entry is a feature id, and alsoRequires never repeats the owner or a hard dependency', () => {
        const ids = new Set(FEATURE_IDS);
        const claims = [];
        const collect = (section, map) => {
            for (const [key, value] of Object.entries(map)) {
                for (const claim of ownersIn(value)) claims.push({ where: `${section}.${key}`, ...claim });
            }
        };
        collect('commands', commands);
        collect('contextMenus', contextMenus);
        collect('runtimeSteps', runtimeSteps);
        collect('eventGates', eventGates);
        collect('interactionTypes', interactionTypes);
        collect('aiTools', aiTools);
        collect('mcpTools', mcpTools);
        collect('mcpResources', mcpResources);
        collect('wsPaths', wsPaths);
        collect('staticAssets', staticAssets);
        collect('rooms', rooms);
        collect('tables.exact', tables.exact);
        collect('systemDependencies', systemDependencies);
        routeRules.forEach((rule, index) => {
            claims.push({ where: `routeRules[${index}] ${rule.pattern}`, owner: rule.owner, alsoRequires: rule.alsoRequires || [] });
        });
        tables.prefixes.forEach((entry) => {
            claims.push({ where: `tables.prefixes.${entry.prefix}`, owner: entry.owner, alsoRequires: [] });
        });
        for (const [id, entry] of Object.entries(tutorials)) {
            claims.push({ where: `tutorials.${id}`, owner: entry.owner, alsoRequires: entry.requires });
        }

        const problems = [];
        for (const claim of claims) {
            if (!ids.has(claim.owner)) problems.push(`${claim.where}: unknown owner "${claim.owner}"`);
            for (const extra of claim.alsoRequires) {
                if (!ids.has(extra)) problems.push(`${claim.where}: unknown alsoRequires "${extra}"`);
                else if (extra === claim.owner) problems.push(`${claim.where}: alsoRequires repeats its owner "${extra}"`);
                else if (ids.has(claim.owner) && transitiveDeps(claim.owner).has(extra)) {
                    problems.push(`${claim.where}: alsoRequires "${extra}" is already a hard dependency of "${claim.owner}"`);
                }
            }
        }
        expect(problems).toEqual([]);
        expect(claims.length).toBeGreaterThan(0);
    });

    test('legacy switches, system dependencies and known gaps are well formed', () => {
        const ids = new Set(FEATURE_IDS);
        const problems = [];
        for (const [id, sw] of Object.entries(legacySwitches)) {
            if (!ids.has(id) || id === 'core') problems.push(`legacySwitches.${id}: not a switchable feature id`);
            if (typeof sw.configPath !== 'string' || !sw.configPath) problems.push(`legacySwitches.${id}: missing configPath`);
            if (typeof sw.defaultOn !== 'boolean') problems.push(`legacySwitches.${id}: defaultOn must be boolean`);
            if (FEATURES[id] && FEATURES[id].legacySwitch !== sw.configPath) {
                problems.push(`legacySwitches.${id}.configPath "${sw.configPath}" differs from FEATURES.${id}.legacySwitch "${FEATURES[id].legacySwitch}"`);
            }
        }
        for (const [id, feature] of Object.entries(FEATURES)) {
            if (feature.legacySwitch && !legacySwitches[id]) problems.push(`FEATURES.${id}.legacySwitch has no legacySwitches entry`);
        }
        for (const [name, value] of Object.entries(systemDependencies)) {
            const extra = typeof value === 'object' ? value.softConsumers || [] : [];
            for (const consumer of extra) {
                if (!ids.has(consumer)) problems.push(`systemDependencies.${name}: unknown softConsumer "${consumer}"`);
            }
        }
        for (const gap of knownGaps) {
            if (!/^#\d+$/.test(gap.issue) || !gap.surface || !gap.note) problems.push(`knownGaps entry is malformed: ${JSON.stringify(gap)}`);
        }
        expect(problems).toEqual([]);
    });
});

describe('known gaps', () => {
    test('every remaining row names the issue that will close it (a cheap guard against rot)', () => {
        expect(knownGaps.length).toBeGreaterThan(0);
        for (const gap of knownGaps) {
            expect({ surface: gap.surface, issue: gap.issue }).toEqual({ surface: gap.surface, issue: expect.stringMatching(/^#\d+$/) });
            expect(typeof gap.note).toBe('string');
            expect(gap.note.length).toBeGreaterThan(0);
        }
    });

    test('rows that were fixed are not carried any more', () => {
        const surfaces = knownGaps.map((gap) => gap.surface);
        expect(surfaces).not.toContain('runtimeSteps');
        expect(surfaces).not.toContain('aiTools');
        expect(surfaces).not.toContain('interactionTypes.collector:clear_search_button');
        expect(surfaces).not.toContain('runtimeSteps.exchangeRiskEngine');
        expect(surfaces).not.toContain('mcpResources.goobster://briefs/{id}');
    });
});

describe('slash commands and context menus', () => {
    test('every file under apps/bot/commands/<category>/ is claimed exactly once', () => {
        const base = path.join(ROOT, 'apps/bot/commands');
        const files = [];
        for (const category of fs.readdirSync(base)) {
            const dir = path.join(base, category);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const file of fs.readdirSync(dir)) {
                if (file.endsWith('.js')) files.push(`${category}/${file}`);
            }
        }
        const overlap = Object.keys(commands).filter((key) => key in contextMenus);
        expect(overlap).toEqual([]);
        assertSameSet('command files', files, [...Object.keys(commands), ...Object.keys(contextMenus)],
            'commands (or contextMenus for a context-menu file)');
    });

    test('files claimed as context menus define a context menu command', () => {
        for (const key of Object.keys(contextMenus)) {
            expect(read(`apps/bot/commands/${key}`)).toMatch(/ContextMenuCommandBuilder/);
        }
    });
});

describe('runtime steps', () => {
    test('every step() name in coreRuntime.js (and the synthetic paused entry) is claimed', () => {
        const source = read('packages/core/runtime/coreRuntime.js');
        const names = [
            ...matches(source, /\bstep\('([^']+)'/g),
            ...matches(source, /\bskipped\.push\('([^']+)'\)/g)
        ];
        expect(names.length).toBeGreaterThan(0);
        assertSameSet('runtime steps', names, Object.keys(runtimeSteps), 'runtimeSteps');
    });
});

describe('events and interactions', () => {
    test('every Discord client listener and event file is claimed', () => {
        const index = read('apps/bot/index.js');
        const listeners = [...index.matchAll(/\b(?:client|readyClient)\.(?:on|once)\(\s*(?:Events\.(\w+)|['"](\w+)['"])/g)]
            .map((m) => m[1] || m[2]);
        const eventFiles = fs.readdirSync(path.join(ROOT, 'apps/bot/events'))
            .filter((file) => file.endsWith('.js'))
            .map((file) => file.replace(/\.js$/, ''));
        expect(listeners.length).toBeGreaterThan(0);
        expect(eventFiles.length).toBeGreaterThan(0);

        const claimedListeners = Object.keys(eventGates).filter((key) => !key.includes('#') && !key.includes(':'));
        assertSameSet('event listeners', [...listeners, ...eventFiles], claimedListeners, 'eventGates');
    });

    test('messageCreate gates are claimed in execution order and still present', () => {
        const source = read('apps/bot/events/messageCreate.js');
        const markers = [
            ['messageCreate#01 reply-tail record', 'replyDetection.recordMessage(message)'],
            ['messageCreate#02 ignore bots', 'message.author.bot'],
            ['messageCreate#03 partial resolve', 'message.partial'],
            ['messageCreate#04 DM direct chat', 'handleDirectMessage(message)'],
            ['messageCreate#05 activity counters', 'activityService.recordMessage'],
            ['messageCreate#06 agent mission-control threads', 'agentTrackerService'],
            ['messageCreate#07 address detection', 'fetchRepliedToMessage(message)'],
            ['messageCreate#08 reply-to-edit', 'maybeHandleImageEditReply(message, repliedTo)'],
            ['messageCreate#09 explicit address', 'handleExplicitMention(message'],
            ['messageCreate#10 GBA advice inbox', 'maybeCaptureAdvice'],
            ['messageCreate#11 reply detection', 'replyDetection.shouldRespond'],
            ['messageCreate#12 dynamic response', 'intentDetectionHandler.shouldRespond']
        ];
        const claimedGates = Object.keys(eventGates).filter((key) => key.startsWith('messageCreate#'));
        expect(claimedGates).toEqual(markers.map(([key]) => key));

        let cursor = source.indexOf('async execute(message)');
        expect(cursor).toBeGreaterThan(-1);
        for (const [key, marker] of markers) {
            const at = source.indexOf(marker, cursor);
            if (at === -1) {
                throw new Error(`${key}: expected "${marker}" after the previous gate in events/messageCreate.js. A gate was moved, removed or inserted; update the inventory and this spec.`);
            }
            cursor = at;
        }
    });

    test('other event subscribers are claimed and still present', () => {
        const subscribers = {
            'messageReactionAdd:issue-capture': ['packages/core/utils/chat/reactions.js', '📋'],
            'domainEventBus:attention': ['packages/core/services/personalHeartbeatService.js', "domainEventBus.subscribe('*'"],
            'domainEventBus:watches': ['packages/core/services/attentionWatchService.js', "domainEventBus.subscribe('*'"],
            'eventBusService:settings-cache': ['packages/core/services/eventBusService.js', "emitter.on('event'"]
        };
        const claimed = Object.keys(eventGates).filter((key) => /^[A-Za-z]+:/.test(key));
        assertSameSet('event subscribers', Object.keys(subscribers), claimed, 'eventGates');
        for (const [key, [file, marker]] of Object.entries(subscribers)) {
            if (!read(file).includes(marker)) throw new Error(`${key}: "${marker}" no longer appears in ${file}.`);
        }

        const subscribingFiles = [...walkJs('packages/core'), ...walkJs('apps/bot'), ...walkJs('apps/api')]
            .filter((file) => /\bdomainEventBus\.subscribe\(/.test(read(file)))
            .sort();
        const expected = Object.values(subscribers).map(([file]) => file)
            .filter((file) => /domainEventBus\.subscribe/.test(read(file))).sort();
        assertSameSet('domainEventBus subscribers (files)', subscribingFiles, expected, 'eventGates (and this spec\'s subscriber table)');
    });

    test('every button router token is claimed', () => {
        const source = read('apps/bot/events/interactionCreate.js');
        const tokens = matches(source, /\btype === '(\w+)'/g);
        expect(tokens.length).toBeGreaterThan(0);
        const claimed = Object.keys(interactionTypes).filter((key) => !key.startsWith('collector:'));
        assertSameSet('interaction router tokens', tokens, claimed, 'interactionTypes');
    });

    test('collector-scoped custom ids are still defined in the code', () => {
        const haystack = [
            ...walkJs('apps/bot/commands'),
            ...walkJs('packages/core/utils'),
            ...walkJs('packages/core/services')
        ].map(read).join('\n');
        const stale = Object.keys(interactionTypes)
            .filter((key) => key.startsWith('collector:'))
            .map((key) => key.slice('collector:'.length))
            .filter((id) => !haystack.includes(`'${id}'`) && !haystack.includes(`"${id}"`));
        if (stale.length) throw new Error(`Stale collector custom ids: ${stale.join(', ')}.`);
    });
});

describe('AI tools, MCP tools and resources', () => {
    test('every registered AI tool (plus provider web_search) is claimed', () => {
        const { TOOL_ORDER } = require('@goobster/core/utils/toolsRegistry');
        expect(TOOL_ORDER.length).toBeGreaterThan(0);
        expect(read('packages/core/services/openaiService.js')).toContain("type: 'web_search'");
        assertSameSet('AI tools', [...TOOL_ORDER, 'web_search'], Object.keys(aiTools), 'aiTools');
    });

    test('every MCP tool and GBA harness tool is claimed', () => {
        const { TOOLS } = require('@goobster/core/mcp/tools');
        const { toolDefinitions } = require('../clients/gba-mcp/lib/tools');
        const names = [
            ...TOOLS.map((tool) => tool.name),
            ...toolDefinitions({ allowMemory: true }).map((tool) => `gba:${tool.name}`)
        ];
        expect(names.length).toBeGreaterThan(0);
        assertSameSet('MCP tools', names, Object.keys(mcpTools), 'mcpTools');
    });

    test('every MCP resource template is claimed', () => {
        const { listResourceTemplates } = require('@goobster/core/mcp/resources');
        const uris = listResourceTemplates('read').resourceTemplates.map((t) => t.uriTemplate);
        expect(uris.length).toBeGreaterThan(0);
        assertSameSet('MCP resources', uris, Object.keys(mcpResources), 'mcpResources');
    });
});

describe('HTTP surface', () => {
    const SURFACES = ['portal', 'activity', 'screenVision', 'gba', 'webhooks', 'internal', 'mcp', 'health', 'panel', 'sandboxRunner'];
    let routes;
    let statics;
    let webDist;

    function prefixOf(layer) {
        if (layer.regexp.fast_slash) return '';
        const keys = (layer.keys || []).map((key) => key.name);
        let next = 0;
        return layer.regexp.source
            .replace(/^\^/, '')
            .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
            .replace(/\$$/, '')
            .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${keys[next++] || 'param'}`)
            .replace(/\\\//g, '/');
    }

    function routePath(value) {
        if (typeof value === 'string') return value;
        return value.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
    }

    function walkStack(stack, prefix, surface, out) {
        for (const layer of stack) {
            if (layer.route) {
                for (const candidate of [].concat(layer.route.path)) {
                    for (const method of Object.keys(layer.route.methods)) {
                        out.routes.push({ surface, method: method.toUpperCase(), path: `${prefix}${routePath(candidate)}` });
                    }
                }
            } else if (layer.handle && layer.handle.stack) {
                walkStack(layer.handle.stack, `${prefix}${prefixOf(layer)}`, surface, out);
            } else if (layer.name === 'serveStatic') {
                const mount = `${prefix}${prefixOf(layer)}`;
                out.statics.push({ surface, label: surface === 'panel' ? `panel:${mount || '/'}` : (mount || '/') });
            }
        }
    }

    const stackOf = (app) => app.stack || app._router.stack;

    beforeAll(() => {
        webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-inventory-dist-'));
        fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>stub</title>');

        const express = require('express');
        const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
        const { createMcpApp } = require('@goobster/core/mcp/http');
        const mcpConfig = require('@goobster/core/config/mcpConfig');
        const activity = require('../apps/bot/web/activityApi');
        const { createScreenVisionApp } = require('../apps/bot/web/screenVisionApi');
        const { createGbaRunApp } = require('../apps/bot/web/gbaRunApi');
        const { createIntegrationsApp } = require('../apps/bot/web/integrationsApi');
        const { createInternalGatewayApi } = require('../apps/bot/web/internalGatewayApi');
        const { createHealthApp, createPanelApp } = require('../apps/bot/web/server');
        const { createSandboxApp } = require('../apps/sandbox/server');

        const gateway = { sendDm: async () => {}, sendToChannel: async () => {} };
        const portal = createWebAppApp(createWebAppContext({
            gateway,
            config: { webapp: { enabled: true, devMode: true } },
            deps: { webDistDir: webDist }
        }));
        const mcpHost = express.Router();
        mcpHost.use(mcpConfig.path, createMcpApp({ logger: silentLogger }));

        const out = { routes: [], statics: [] };
        walkStack(stackOf(portal), '', 'portal', out);
        walkStack(stackOf(activity.createActivityApp(activity.createActivityContext({
            client: {}, config: { activity: { enabled: true } }, tableManager: {}, botPlayer: null, logger: silentLogger
        }))), '', 'activity', out);
        walkStack(stackOf(createScreenVisionApp({ logger: silentLogger })), '', 'screenVision', out);
        walkStack(stackOf(createGbaRunApp({ logger: silentLogger })), '', 'gba', out);
        walkStack(stackOf(createIntegrationsApp({ client: {}, logger: silentLogger })), '', 'webhooks', out);
        walkStack(stackOf(createInternalGatewayApi({ client: {}, logger: silentLogger })), '', 'internal', out);
        walkStack(stackOf(mcpHost), '', 'mcp', out);
        walkStack(stackOf(createHealthApp({ logger: silentLogger })), '', 'health', out);
        walkStack(stackOf(createPanelApp({
            client: {}, voiceService: {}, logger: silentLogger, deps: { panelService: {} }
        })), '', 'panel', out);
        walkStack(stackOf(createSandboxApp({ sandbox: {}, logger: silentLogger })), '', 'sandboxRunner', out);
        routes = out.routes;
        statics = out.statics;
    });

    afterAll(() => {
        if (webDist) fs.rmSync(webDist, { recursive: true, force: true });
    });

    test('the walker found routes on every mounted surface', () => {
        for (const surface of SURFACES) {
            expect({ surface, found: routes.filter((r) => r.surface === surface).length > 0 }).toEqual({ surface, found: true });
        }
    });

    test('every mounted route matches a routeRules entry', () => {
        const unclaimed = [...new Set(routes
            .filter((route) => !ownerOf('route', route.path, route.method))
            .map((route) => `${route.method} ${route.path}`))].sort();
        if (unclaimed.length) {
            throw new Error(`\nUnclaimed routes: ${unclaimed.join(', ')}. Add a rule to \`routeRules\` in packages/core/features/inventory.js (rules are ordered; the first match wins).`);
        }
    });

    test('every route rule is the first match for at least one route', () => {
        const wins = new Map();
        for (const route of routes) {
            const index = routeRules.findIndex((rule) =>
                (!rule.method || rule.method === route.method) && rule.pattern.test(route.path));
            if (index >= 0) wins.set(index, (wins.get(index) || 0) + 1);
        }
        const dead = routeRules
            .map((rule, index) => ({ rule, index }))
            .filter(({ index }) => !wins.has(index))
            .map(({ rule, index }) => `#${index} ${rule.method || '*'} ${rule.pattern}`);
        if (dead.length) {
            throw new Error(`\nDead route rules (never the first match for a mounted route): ${dead.join('; ')}.`);
        }
    });

    test('static mounts and public client files are claimed by exact key, and every claim is real', () => {
        const publicDir = path.join(ROOT, 'apps/web/public');
        const publicEntries = fs.readdirSync(publicDir).map((name) => `/app/${name}`);
        const mountLabels = statics.map((entry) => entry.label);
        expect(mountLabels.length).toBeGreaterThan(0);

        const getRoutes = routes.filter((route) => route.method === 'GET').map((route) => route.path);
        const mustBeClaimed = [...new Set([...mountLabels, ...publicEntries])];
        const claimedKeys = Object.keys(staticAssets);
        const unclaimed = mustBeClaimed.filter((label) => !claimedKeys.includes(label)).sort();
        if (unclaimed.length) {
            throw new Error(`\nUnclaimed static assets: ${unclaimed.join(', ')}. Add each exact key to \`staticAssets\` in packages/core/features/inventory.js.`);
        }
        // Vite writes apps/web/public/style.css on build (gitignored), so it is
        // present after `npm run build:web` and absent on a clean checkout.
        const generated = ['/app/style.css'];
        const real = new Set([...mustBeClaimed, ...getRoutes, ...generated]);
        const stale = claimedKeys.filter((key) => !real.has(key)).sort();
        if (stale.length) throw new Error(`\nStale static assets (no mount, public file or GET route): ${stale.join(', ')}.`);
    });

    test('every WebSocket server path is claimed', () => {
        const serverFiles = [
            ...walkJs('packages/core'),
            ...walkJs('apps/bot', { skip: ['apps/bot/web/activity/'] }),
            ...walkJs('apps/api'),
            ...walkJs('apps/sandbox')
        ].filter((file) => /new WebSocketServer\(/.test(read(file)));
        expect(serverFiles.length).toBeGreaterThan(0);
        const paths = serverFiles.flatMap((file) => matches(read(file), /'(\/api\/[A-Za-z0-9/_-]*\/(?:ws|live))'/g));
        assertSameSet('WebSocket paths', paths, Object.keys(wsPaths), 'wsPaths');
    });
});

describe('data model and portal catalogs', () => {
    const schemaTables = () => matches(
        read('packages/core/db/schema.sql'),
        /CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g
    );

    test('every table in schema.sql resolves to an owner', () => {
        const names = schemaTables();
        expect(names.length).toBeGreaterThan(0);
        const unclaimed = names.filter((name) => !ownerOf('table', name));
        if (unclaimed.length) {
            throw new Error(`\nUnclaimed tables: ${unclaimed.join(', ')}. Add each to \`tables.exact\` (or a \`tables.prefixes\` entry) in packages/core/features/inventory.js.`);
        }
    });

    test('exact table claims exist in schema.sql and every prefix matches a table', () => {
        const names = new Set(schemaTables());
        const stale = Object.keys(tables.exact).filter((name) => !names.has(name)).sort();
        if (stale.length) throw new Error(`\nStale tables (not in schema.sql): ${stale.join(', ')}.`);
        const dead = tables.prefixes
            .filter((entry) => ![...names].some((name) => name.startsWith(entry.prefix)))
            .map((entry) => entry.prefix);
        if (dead.length) throw new Error(`\nDead table prefixes (match no table): ${dead.join(', ')}.`);
    });

    test('every portal room is claimed and its catalog requirements agree with the inventory', () => {
        const { ROOMS } = require('../apps/web/src/lib/rooms.cjs');
        assertSameSet('portal rooms', ROOMS.map((room) => room.id), Object.keys(rooms), 'rooms');
        for (const room of ROOMS) {
            const claim = ownerOf('room', room.id);
            if (room.requires?.discord) {
                expect({ room: room.id, discord: claim.alsoRequires.includes('discord') }).toEqual({ room: room.id, discord: true });
            }
            if (room.requires?.feature === 'projects') {
                expect({ room: room.id, owner: claim.owner }).toEqual({ room: room.id, owner: 'projects' });
            }
        }
    });

    test('every tutorial is claimed and its catalog requirements agree with the inventory', () => {
        const { TUTORIALS } = require('@goobster/core/config/tutorialCatalog');
        assertSameSet('tutorials', TUTORIALS.map((tutorial) => tutorial.id), Object.keys(tutorials), 'tutorials');
        for (const tutorial of TUTORIALS) {
            const claim = ownerOf('tutorial', tutorial.id);
            if (tutorial.requires?.discord) {
                expect({ tutorial: tutorial.id, discord: claim.alsoRequires.includes('discord') }).toEqual({ tutorial: tutorial.id, discord: true });
            }
            if (tutorial.requires?.feature === 'projects') {
                expect({ tutorial: tutorial.id, owner: claim.owner }).toEqual({ tutorial: tutorial.id, owner: 'projects' });
            }
        }
    });
});
