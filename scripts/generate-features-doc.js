#!/usr/bin/env node
/**
 * Generate documentation/features.md from the feature catalog and inventory
 * (#321, installer P1.6). The document is derived, never hand-edited:
 *
 *   node scripts/generate-features-doc.js            # rewrite documentation/features.md
 *   node scripts/generate-features-doc.js --check    # exit 1 when the committed file is stale
 *   node scripts/generate-features-doc.js --stdout   # print instead of writing
 *
 * It states what each feature is, what it needs and what it owns. It never
 * states whether a feature is available: availability is per installation
 * and is shown in the portal (Tools, rooms, tutorials) and to Goobster
 * through the self-docs annotations, so nothing here can go stale on one.
 *
 * `--check` runs as part of `npm run docs:check` (and so in CI) and from
 * tests/featureGatingPortal.test.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const catalog = require('@goobster/core/features/catalog');
const inventory = require('@goobster/core/features/inventory');
const { envVarFor } = require('@goobster/core/features/featureState');

const OUTPUT = path.join(__dirname, '..', 'documentation', 'features.md');

function ownerId(claim) {
    return typeof claim === 'string' ? claim : claim.owner;
}

/** Everything a feature owns in the inventory, as name lists. */
function ownedBy(id) {
    const owned = (map) => Object.entries(map).filter(([, claim]) => ownerId(claim) === id).map(([name]) => name).sort();
    const tutorials = Object.entries(inventory.tutorials)
        .filter(([, entry]) => entry.owner === id).map(([name]) => name).sort();
    const routes = inventory.routeRules.filter((rule) => ownerId(rule) === id).length;
    return {
        commands: owned(inventory.commands).length,
        contextMenus: owned(inventory.contextMenus).length,
        aiTools: owned(inventory.aiTools),
        mcpTools: owned(inventory.mcpTools),
        rooms: owned(inventory.rooms),
        tutorials,
        routeRules: routes,
        wsPaths: owned(inventory.wsPaths)
    };
}

function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

function code(list) {
    return list.map((item) => `\`${item}\``).join(', ');
}

function docLink(relPath) {
    const file = relPath.replace(/^documentation\//, '');
    return `[${file}](${file})`;
}

function ownsLine(id) {
    const owned = ownedBy(id);
    const parts = [];
    if (owned.commands) parts.push(plural(owned.commands, 'slash command'));
    if (owned.contextMenus) parts.push(plural(owned.contextMenus, 'context-menu command'));
    if (owned.aiTools.length) parts.push(`${plural(owned.aiTools.length, 'chat tool')} (${code(owned.aiTools)})`);
    if (owned.mcpTools.length) parts.push(`${plural(owned.mcpTools.length, 'MCP tool')} (${code(owned.mcpTools)})`);
    if (owned.rooms.length) parts.push(`${plural(owned.rooms.length, 'portal room')} (${code(owned.rooms)})`);
    if (owned.tutorials.length) parts.push(plural(owned.tutorials.length, 'guided tour'));
    if (owned.routeRules) parts.push(plural(owned.routeRules, 'portal route group'));
    if (owned.wsPaths.length) parts.push(`${plural(owned.wsPaths.length, 'WebSocket path')} (${code(owned.wsPaths)})`);
    return parts.length ? parts.join('; ') : 'No surfaces of its own.';
}

function switchLines(descriptor) {
    const lines = [];
    const legacy = descriptor.legacySwitch;
    if (legacy) {
        const where = [legacy.configPath ? `\`${legacy.configPath}\`` : null, legacy.envVar ? `\`${legacy.envVar}\`` : null]
            .filter(Boolean).join(' or ');
        if (where) lines.push(`- **Switch today:** ${where}${typeof legacy.defaultOn === 'boolean' ? `, default ${legacy.defaultOn ? 'on' : 'off'}` : ''}.`);
    }
    if (descriptor.kind !== 'pseudo-owner') {
        lines.push(`- **Host override:** \`${envVarFor(descriptor.id)}=0\` turns it off for one process; \`data/features.json\` records the installation's choice (see [feature_state.md](feature_state.md)).`);
    }
    return lines;
}

function keyLines(descriptor) {
    const lines = [];
    if (descriptor.apiKeys.length) {
        lines.push('- **Credentials:**');
        for (const key of descriptor.apiKeys) {
            const where = key.configPath ? ` / \`${key.configPath}\`` : '';
            lines.push(`  - \`${key.name}\`${where} (${key.required ? 'required' : 'optional'}): ${key.purpose}`);
        }
    }
    if (descriptor.configKeys.length) lines.push(`- **Config keys:** ${code(descriptor.configKeys)}`);
    if (descriptor.systemDependencies.length) {
        const required = new Set(descriptor.requiredSystemDependencies);
        lines.push(`- **System dependencies:** ${descriptor.systemDependencies
            .map((name) => `\`${name}\`${required.has(name) ? ' (required)' : ''}`).join(', ')}`);
    }
    return lines;
}

function titleOf(id) {
    return catalog.FEATURES[id].title;
}

function section(id) {
    const descriptor = catalog.FEATURES[id];
    const lines = [`## ${descriptor.title}`, '', `Feature id: \`${id}\`. ${descriptor.summary}`, ''];
    lines.push(`- **Kind:** ${descriptor.kind === 'pseudo-owner' ? 'always available' : descriptor.kind}`);
    if (descriptor.kind !== 'pseudo-owner') {
        lines.push(`- **Fresh install default:** ${descriptor.freshDefault}`);
    }
    lines.push(`- **Depends on:** ${descriptor.dependsOn.length ? descriptor.dependsOn.map((dep) => `${titleOf(dep)} (\`${dep}\`)`).join(', ') : 'nothing'}`);
    lines.push(`- **Owns:** ${ownsLine(id)}`);
    lines.push(...switchLines(descriptor));
    lines.push(...keyLines(descriptor));
    if (descriptor.docs.length) lines.push(`- **Documentation:** ${descriptor.docs.map(docLink).join(', ')}`);
    if (descriptor.helpUrl) lines.push(`- **Provider help:** <${descriptor.helpUrl}>`);
    lines.push('- **Reference:** [configuration.md](configuration.md) for every key, [commands.md](commands.md) for the commands.');
    lines.push('');
    return lines.join('\n');
}

function overviewTable() {
    const rows = ['| Feature | Id | Depends on | Commands | Chat tools | Rooms | Tours |', '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
    for (const id of catalog.FEATURE_IDS) {
        const owned = ownedBy(id);
        const deps = catalog.FEATURES[id].dependsOn.map((dep) => `\`${dep}\``).join(', ') || '-';
        rows.push(`| ${titleOf(id)} | \`${id}\` | ${deps} | ${owned.commands + owned.contextMenus} | ${owned.aiTools.length} | ${owned.rooms.length} | ${owned.tutorials.length} |`);
    }
    return rows.join('\n');
}

function render() {
    const intro = [
        '---',
        'title: Feature catalog',
        'kind: reference',
        'summary: Every Goobster feature, what it depends on, what it owns, which keys and system tools it needs, and where it is documented. Generated from the feature catalog; availability on a given installation is never stated here.',
        'tags: [features, catalog, installer, configuration]',
        '---',
        '',
        '<!-- Generated by scripts/generate-features-doc.js from packages/core/features/catalog.js and inventory.js. Do not edit by hand; run `node scripts/generate-features-doc.js`. `npm run docs:check` fails when this file is stale. -->',
        '',
        '# Features',
        '',
        'Goobster is one program made of optional features. This page lists each one: what it is, what it depends on, what it owns, and which keys and system tools it needs. It is generated from the feature catalog, so the names here match the code.',
        '',
        '**Whether a feature is available is a fact about one installation, not about this file.** A host can leave a feature out, turn it off, or leave it waiting on a dependency or a missing tool. The portal shows that state where it matters: unavailable rooms leave the navigation, the Tools page marks an unavailable tool and says why, and guided tours for an unavailable feature are listed as unavailable. When Goobster reads his own documentation, a document about an unavailable feature is annotated with a one-line "not available on this installation" note. A document is never hidden for being unavailable, because it still explains how to enable the feature. How the state is decided and stored is described in [feature_state.md](feature_state.md); what each surface belongs to is in [feature_inventory.md](feature_inventory.md).',
        '',
        'See [configuration.md](configuration.md) for every config key and environment variable, [configuration_guide.md](configuration_guide.md) for a walkthrough, and [commands.md](commands.md) for the slash commands.',
        '',
        '## At a glance',
        '',
        overviewTable(),
        ''
    ];
    const sections = catalog.FEATURE_IDS.map(section);
    return `${intro.join('\n')}\n${sections.join('\n')}`.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

function main(argv = process.argv.slice(2)) {
    const text = render();
    if (argv.includes('--stdout')) {
        process.stdout.write(text);
        return 0;
    }
    if (argv.includes('--check')) {
        let current = null;
        try { current = fs.readFileSync(OUTPUT, 'utf8'); } catch { /* missing counts as stale */ }
        if (current === text) {
            console.log('documentation/features.md is up to date.');
            return 0;
        }
        console.error('documentation/features.md is stale. Run: node scripts/generate-features-doc.js');
        return 1;
    }
    fs.writeFileSync(OUTPUT, text);
    console.log('Wrote documentation/features.md');
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { render, main, OUTPUT };
