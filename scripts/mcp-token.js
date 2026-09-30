#!/usr/bin/env node
/**
 * Create, list, or revoke a read-only MCP token without the portal.
 *
 *   npm run mcp:token -- create --user <principal id> --label "Cursor"
 *   npm run mcp:token -- list --user <principal id>
 *   npm run mcp:token -- revoke --user <principal id> --id <token id>
 *
 * `create` prints the secret on stdout once. Everything else goes to stderr.
 */

const mcpTokenService = require('@goobster/core/services/mcpTokenService');
const db = require('@goobster/core/db');

function args(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) out[key] = true;
            else {
                out[key] = next;
                i += 1;
            }
        } else {
            out._.push(token);
        }
    }
    return out;
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

async function main() {
    const parsed = args(process.argv.slice(2));
    const command = parsed._[0];
    const userId = parsed.user ? String(parsed.user) : '';
    if (!command || !userId) {
        fail('Usage: npm run mcp:token -- <create|list|revoke> --user <principal id> [--label text] [--id n]');
        return;
    }
    try {
        if (command === 'create') {
            const created = await mcpTokenService.create({ userId, label: parsed.label });
            process.stderr.write(
                `Saved token ${created.id} (${created.tokenPrefix}…) for ${userId}. `
                + 'This is the only time the secret is shown.\n'
            );
            process.stdout.write(`${created.token}\n`);
            return;
        }
        if (command === 'list') {
            const tokens = await mcpTokenService.list({ userId });
            if (!tokens.length) {
                process.stderr.write(`No active MCP tokens for ${userId}.\n`);
                return;
            }
            for (const token of tokens) {
                process.stdout.write(
                    `${token.id}\t${token.tokenPrefix}…\t${token.label}\tcreated ${token.createdAt}`
                    + `${token.lastUsedAt ? `\tlast used ${token.lastUsedAt}` : ''}\n`
                );
            }
            return;
        }
        if (command === 'revoke') {
            const result = await mcpTokenService.revoke({ userId, id: parsed.id });
            process.stderr.write(`Revoked token ${result.id}.\n`);
            return;
        }
        fail(`Unknown command "${command}". Use create, list, or revoke.`);
    } catch (error) {
        fail(error?.message || String(error));
    }
}

main().finally(() => db.closeConnection().catch(() => {}));
