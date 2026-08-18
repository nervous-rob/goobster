/**
 * Guardrails for the optional split topology. The files are the contract
 * in documentation/reactive_web_architecture.md — they must not quietly
 * become "two full bots on one token."
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const SPLIT_DIR = path.join(__dirname, '..', 'deploy', 'split');

function loadCompose(name) {
    const raw = fs.readFileSync(path.join(SPLIT_DIR, name), 'utf8');
    return YAML.parse(raw);
}

describe('deploy/split compose contract', () => {
    test('phase 0 compose is core + web, one Node process, no published RPC', () => {
        const compose = loadCompose('docker-compose.yml');
        expect(Object.keys(compose.services).sort()).toEqual(['core', 'web']);
        expect(compose.services.core.environment.GOOBSTER_ROLE).toBe('all');
        expect(compose.services.core.expose).toEqual(['3000']);
        expect(compose.services.core.ports).toBeUndefined();
        expect(compose.services.web.ports).toEqual(['3000:80']);
        expect(compose.services.web.environment.GOOBSTER_UPSTREAM).toBe('core:3000');
    });

    test('phase 2 compose names bot + api + web and does not publish the RPC port', () => {
        const compose = loadCompose('docker-compose.split.yml');
        expect(Object.keys(compose.services).sort()).toEqual(['api', 'bot', 'web']);
        expect(compose.services.bot.environment.GOOBSTER_ROLE).toBe('bot');
        expect(compose.services.api.environment.GOOBSTER_ROLE).toBe('api');
        expect(compose.services.bot.expose).toEqual(['3001']);
        expect(compose.services.bot.ports).toBeUndefined();
        expect(compose.services.api.environment.GOOBSTER_BOT_RPC).toBe('http://bot:3001');
        expect(compose.services.web.environment.GOOBSTER_UPSTREAM).toBe('api:3000');
        expect(compose.services.web.ports).toEqual(['3000:80']);
    });

    test('nginx front door keeps /api and WebSockets on the Node upstream', () => {
        const nginx = fs.readFileSync(path.join(SPLIT_DIR, 'nginx.conf'), 'utf8');
        expect(nginx).toMatch(/location \/api\//);
        expect(nginx).toMatch(/proxy_set_header Upgrade/);
        expect(nginx).toMatch(/proxy_buffering off/);
        expect(nginx).toMatch(/location \/app\//);
        expect(nginx).toMatch(/GOOBSTER_UPSTREAM/);
    });
});
