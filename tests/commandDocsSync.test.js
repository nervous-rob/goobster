/**
 * documentation/commands.md is generated from the command files
 * (scripts/generate-command-docs.js). This keeps it from drifting: every
 * slash command declared under apps/bot/commands has a section, and no
 * section names a command that no longer exists. Static reads only - no
 * command module is required here.
 */
const fs = require('node:fs');
const path = require('node:path');
const { listCommandFiles } = require('@goobster/core/utils/commandDeployment');

const ROOT = path.join(__dirname, '..');

function declaredSlashCommands() {
    const { active, inactive } = listCommandFiles(path.join(ROOT, 'apps/bot/commands'));
    return [...active, ...inactive]
        .filter((entry) => entry.kind === 'command' && entry.name)
        .map((entry) => entry.name)
        .sort();
}

function documentedSlashCommands() {
    const doc = fs.readFileSync(path.join(ROOT, 'documentation/commands.md'), 'utf8');
    return [...doc.matchAll(/^### `\/([a-z0-9-]+)`$/gm)].map((m) => m[1]).sort();
}

describe('documentation/commands.md matches the command files', () => {
    test('every declared slash command has a section and no section is stale', () => {
        const declared = declaredSlashCommands();
        const documented = documentedSlashCommands();
        const missing = declared.filter((name) => !documented.includes(name));
        const stale = documented.filter((name) => !declared.includes(name));
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
        expect(documented.length).toBe(declared.length);
    });

    test('the reference says it is generated', () => {
        const doc = fs.readFileSync(path.join(ROOT, 'documentation/commands.md'), 'utf8');
        expect(doc).toContain('npm run docs:commands');
    });
});
