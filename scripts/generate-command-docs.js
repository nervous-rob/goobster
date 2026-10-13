#!/usr/bin/env node
/**
 * Regenerate documentation/commands.md from the slash commands themselves.
 *
 *   npm run docs:commands
 *
 * Every command file under apps/bot/commands is loaded and its builder
 * serialised, so the reference carries exactly the names, descriptions,
 * subcommands and options Discord registers - the hand-written version had
 * drifted to commands that no longer existed. tests/commandDocsSync.test.js
 * fails when a command is added or removed without re-running this.
 *
 * The assistant's name appears as whatever identity.assistantName resolves
 * to on the machine that runs this (the default when config.json is absent).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'apps/bot/commands');
const OUTPUT = path.join(ROOT, 'documentation/commands.md');

// config.json is gitignored; the command modules tolerate a minimal one.
const configPath = path.join(ROOT, 'config.json');
let createdConfig = false;
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({ clientId: '0', guildIds: ['0'], token: 'docs-placeholder' }, null, 2));
    createdConfig = true;
}

const { listCommandFiles } = require('@goobster/core/utils/commandDeployment');
const inventory = require('@goobster/core/features/inventory');

const CATEGORY_LABELS = {
    chat: 'Chat',
    economy: 'Economy',
    image: 'Images',
    music: 'Music & audio',
    settings: 'Settings',
    tavern: 'Tavern & adventures',
    utility: 'Utility',
    voice: 'Voice'
};
const OPTION_TYPES = { 3: 'text', 4: 'integer', 5: 'yes/no', 6: 'user', 7: 'channel', 8: 'role', 9: 'user or role', 10: 'number', 11: 'attachment' };

function categoryLabel(folder) {
    return CATEGORY_LABELS[folder] || folder.charAt(0).toUpperCase() + folder.slice(1);
}

function escapeCell(text) {
    return String(text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function optionsTable(options) {
    const plain = (options || []).filter((o) => o.type !== 1 && o.type !== 2);
    if (!plain.length) return [];
    const rows = ['| Option | Type | Required | Description |', '|---|---|---|---|'];
    for (const o of plain) {
        const type = OPTION_TYPES[o.type] || String(o.type);
        const choices = o.choices?.length ? ` Choices: ${o.choices.map((c) => `\`${c.name}\``).join(', ')}.` : '';
        rows.push(`| \`${o.name}\` | ${type} | ${o.required ? 'yes' : 'no'} | ${escapeCell(o.description)}${choices} |`);
    }
    return rows;
}

function subcommandSections(name, options, prefix = '') {
    const out = [];
    for (const o of options || []) {
        if (o.type === 2) {
            out.push(...subcommandSections(name, o.options, `${prefix}${o.name} `));
        } else if (o.type === 1) {
            out.push(`#### \`/${name} ${prefix}${o.name}\``, '', escapeCell(o.description), '');
            const table = optionsTable(o.options);
            if (table.length) out.push(...table, '');
        }
    }
    return out;
}

function commandSection(entry, command) {
    const json = command.data.toJSON();
    const claim = inventory.ownerOf(entry.kind, entry.key);
    const owner = claim ? [claim.owner, ...(claim.alsoRequires || [])].filter(Boolean).join('` + `') : null;
    if (json.type && json.type !== 1) {
        return [
            `### Right-click menu: ${json.name}`,
            '',
            `A ${json.type === 3 ? 'message' : 'user'} context menu${owner ? ` (feature: \`${owner}\`)` : ''}. Source: \`${entry.key}\`.`,
            ''
        ];
    }
    const flags = [];
    if (command.dmAllowed) flags.push('works in DMs');
    if (owner) flags.push(`feature: \`${owner}\``);
    const out = [
        `### \`/${json.name}\``,
        '',
        escapeCell(json.description) + (flags.length ? ` *(${flags.join('; ')})*` : ''),
        ''
    ];
    const table = optionsTable(json.options);
    if (table.length) out.push(...table, '');
    out.push(...subcommandSections(json.name, json.options));
    return out;
}

function main() {
    const { active } = listCommandFiles(COMMANDS_DIR);
    const byFolder = new Map();
    let total = 0;
    for (const entry of active) {
        const command = require(entry.filePath);
        if (!command?.data || typeof command.data.toJSON !== 'function') continue;
        if (!byFolder.has(entry.folder)) byFolder.set(entry.folder, []);
        byFolder.get(entry.folder).push({ entry, command });
        total++;
    }
    const folders = [...byFolder.keys()].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
    const lines = [
        '---',
        'title: "Slash command reference"',
        'kind: reference',
        `summary: Every Discord slash command and right-click menu, by category, with its description, subcommands and options - generated from apps/bot/commands by npm run docs:commands. Which commands work in DMs, which feature each belongs to, and how /help presents the same list inside Discord.`,
        'tags: [commands, discord, slash, reference, help, generated]',
        '---',
        '',
        '# Slash command reference',
        '',
        `Generated from \`apps/bot/commands\` by \`npm run docs:commands\`; do not edit by hand. ${total} commands and menus in ${folders.length} categories.`,
        '',
        'Inside Discord, `/help` shows the same commands grouped the same way, built from what the running bot has loaded, and `/help category:` lists one category with each command\'s description. A command marked *works in DMs* is registered globally and answers in direct messages as well as servers; every other command is server-only. A command whose feature is turned off on an installation ([features.md](features.md)) is not registered there and does not appear in `/help`.',
        ''
    ];
    lines.push('## Categories', '');
    for (const folder of folders) {
        const serialised = byFolder.get(folder).map(({ command }) => command.data.toJSON());
        const names = serialised.filter((j) => !j.type || j.type === 1).map((j) => `\`/${j.name}\``);
        const menus = serialised.filter((j) => j.type && j.type !== 1).length;
        lines.push(`- **${categoryLabel(folder)}** (${names.length}): ${names.join(', ')}${menus ? ` and ${menus} right-click ${menus === 1 ? 'menu' : 'menus'}` : ''}`);
    }
    lines.push('');
    for (const folder of folders) {
        lines.push(`## ${categoryLabel(folder)}`, '');
        const items = byFolder.get(folder).sort((a, b) => a.command.data.toJSON().name.localeCompare(b.command.data.toJSON().name));
        for (const { entry, command } of items) lines.push(...commandSection(entry, command));
    }
    fs.writeFileSync(OUTPUT, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    console.log(`Wrote ${path.relative(ROOT, OUTPUT)}: ${total} commands in ${folders.length} categories.`);
}

try {
    main();
} finally {
    if (createdConfig) fs.unlinkSync(configPath);
}
// Timers started at module load keep the process alive.
process.exit(0);
