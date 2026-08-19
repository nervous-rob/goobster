#!/usr/bin/env node
/**
 * Smoke test: every module must require() cleanly with an empty/minimal
 * config (see documentation/development_standards_and_project_goals.md).
 *
 * Requires every .js module under the source directories and reports any
 * that throw at load time. index.js is excluded because requiring it starts
 * the bot. Exits non-zero when any module fails to load.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = [
    'packages/core/db',
    'packages/core/services',
    'packages/core/utils',
    'packages/core/config',
    'packages/core/gateway',
    'packages/core/web',
    'packages/core/runtimePaths.js',
    'apps/api/server.js',
    'apps/bot/commands',
    'apps/bot/events',
    'apps/bot/web'
];

// config.json is gitignored; modules must tolerate a minimal one.
const configPath = path.join(ROOT, 'config.json');
let createdConfig = false;
if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
        clientId: '0',
        guildIds: ['0'],
        token: 'smoke-test-placeholder'
    }, null, 2));
    createdConfig = true;
}

function collectModules(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // node_modules is obvious; public, activity, and app hold browser
            // ES modules that cannot be require()d from Node.
            if (entry.name === 'node_modules' || entry.name === 'public' || entry.name === 'activity' || entry.name === 'app') continue;
            out.push(...collectModules(full));
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

const failures = [];
let loaded = 0;

for (const dir of SOURCE_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const modules = abs.endsWith('.js') ? [abs] : collectModules(abs);
    for (const modulePath of modules) {
        try {
            require(modulePath);
            loaded++;
        } catch (error) {
            failures.push({ modulePath: path.relative(ROOT, modulePath), error });
        }
    }
}

if (createdConfig) {
    fs.unlinkSync(configPath);
}

console.log(`Smoke require: ${loaded} modules loaded cleanly, ${failures.length} failed.`);
for (const { modulePath, error } of failures) {
    console.error(`\nFAILED: ${modulePath}`);
    console.error(`  ${error.stack?.split('\n').slice(0, 4).join('\n  ')}`);
}

// Timers started at module load (e.g. rate limiter) keep the process alive.
process.exit(failures.length === 0 ? 0 : 1);
