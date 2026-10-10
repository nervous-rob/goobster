#!/usr/bin/env node
'use strict';

/**
 * Disposable-host proof for #331–#333. Drive the shipped privileged helper against
 * the installed OS service, exiting the helper after a real registration/removal
 * command succeeds but before it returns. No fault hook is added to production code.
 * The normal helper then retries; retained data and a sibling sentinel must survive.
 * Requires an explicit installation id and must run with the installer privileges.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kinds = require('../apps/manager/platform/serviceKinds');

const EXIT_INTERRUPTED = 86;
const platform = process.platform;
const definition = kinds.forPlatform(platform);
const helperFile = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function interruptedCommand(file, args, operation) {
    const name = path.basename(file).toLowerCase();
    const verb = args[0];
    if (platform === 'win32') return name === 'sc.exe' && verb === (operation === 'service.register' ? 'create' : 'stop');
    if (platform === 'darwin') return name === 'launchctl' && verb === (operation === 'service.register' ? 'bootstrap' : 'bootout');
    return name === 'systemctl' && verb === (operation === 'service.register' ? 'enable' : 'disable');
}

function helper(doc, hostCopy, operation, interrupt) {
    const shipped = path.join(doc.roots.code, 'current', 'app', 'apps', 'manager', 'privileged', helperFile);
    const handler = require(shipped).createHandler({
        payloadRoot: path.join(doc.roots.code, 'current', 'app'),
        hostCandidates: hostCopy ? [hostCopy] : [],
        exec(file, args, options = {}) {
            const result = spawnSync(file, args, { ...options, encoding: 'utf8', timeout: options.timeoutMs || options.timeout || 180_000 });
            if (result.error) throw result.error;
            if (interrupt && result.status === 0 && interruptedCommand(file, args, operation)) {
                fs.writeSync(1, `INTERRUPTED ${operation} after ${path.basename(file)} ${args[0]}\n`);
                process.exit(EXIT_INTERRUPTED);
            }
            return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
        }
    });
    const input = operation === 'service.register'
        ? definition.registerInput({ name: definition.serviceName, layout: doc.layout, codeRoot: doc.roots.code,
            runtimeUser: doc.runtimeUser || definition.account.fallbackName, installationId: doc.installationId,
            roots: doc.roots, mode: 'payload', nodePath: process.execPath, elevated: true })
        : definition.unregisterInput({ name: definition.serviceName, installationId: doc.installationId });
    return handler.handle(operation, input);
}

async function waitHealth(port, want) {
    for (let i = 0; i < 120; i++) {
        const healthy = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
            .then(r => r.ok, () => false);
        if (healthy === want) return;
        await sleep(1000);
    }
    throw new Error(`health did not become ${want ? 'ready' : 'unavailable'}`);
}

async function main() {
    const args = process.argv.slice(2);
    const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
    const store = option('--store');
    assert.ok(store && option('--confirm'), 'usage: --store <manager store> --confirm <installation id> [--port 3100]');
    const doc = JSON.parse(fs.readFileSync(path.join(store, 'installation.json'), 'utf8'));
    assert.equal(doc.installationId, option('--confirm'), 'installation confirmation must match');
    if (args.includes('--child')) {
        helper(doc, option('--host-copy'), option('--operation'), true);
        throw new Error('the requested interruption boundary was never reached');
    }
    const port = Number(option('--port') || 3100);
    await waitHealth(port, true);
    if (process.env.GOOBSTER_NATIVE_BROWSER_PROOF === '1') {
        const { chromium } = require('@playwright/test');
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            const response = await page.goto(`http://127.0.0.1:${option('--manager-port') || 3400}/manager/`);
            assert.ok(response && response.ok(), 'the installed manager must load in the browser');
            await page.close();
        } finally { await browser.close(); }
        for (let i = 0; i < 5; i++) {
            await sleep(1000);
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
            assert.ok(response.ok, 'the installed API must keep serving after the browser exits');
        }
        console.log('PASS: the installed API remains healthy after closing the manager page and browser process');
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-service-proof-'));
    const retained = path.join(doc.roots.data, 'service-proof-retained.txt');
    assert.ok(!fs.existsSync(retained), 'proof sentinel must not replace existing data');
    const foreign = path.join(scratch, 'unrelated.txt');
    fs.writeFileSync(retained, 'keep this installation data');
    fs.writeFileSync(foreign, 'keep this unrelated file');
    let hostCopy = null;
    if (platform === 'win32') {
        const xml = require('../apps/manager/platform/windowsServiceXml');
        hostCopy = path.join(scratch, xml.HOST_FILE_NAME);
        fs.copyFileSync(xml.servicePaths(doc.roots).exe, hostCopy);
    }
    const assertRetained = () => {
        assert.equal(fs.readFileSync(retained, 'utf8'), 'keep this installation data');
        assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep this unrelated file');
    };
    const interrupt = operation => {
        const child = spawnSync(process.execPath, [__filename, '--child', '--store', store, '--confirm', doc.installationId,
            '--operation', operation, ...(hostCopy ? ['--host-copy', hostCopy] : [])], { encoding: 'utf8', timeout: 240_000 });
        assert.equal(child.status, EXIT_INTERRUPTED, `helper did not reach ${operation} interruption: ${child.stderr || child.stdout}`);
        assert.ok(child.stdout.includes(`INTERRUPTED ${operation}`), 'interruption evidence missing');
        process.stdout.write(child.stdout);
    };
    try {
        helper(doc, hostCopy, 'service.unregister', false);
        await waitHealth(port, false);
        interrupt('service.register');
        helper(doc, hostCopy, 'service.register', false);
        await waitHealth(port, true);
        assertRetained();
        console.log('PASS: retry after interrupted native registration restores the owned service and retains data');
        interrupt('service.unregister');
        helper(doc, hostCopy, 'service.unregister', false);
        await waitHealth(port, false);
        assertRetained();
        assert.ok(!fs.existsSync(definition.installedPath(definition.serviceName, { roots: doc.roots })), 'owned service definition remains after retry');
        console.log('PASS: retry after interrupted native removal stops the service and retains data');
    } finally {
        // Leave the existing proof journey in its original installed/running state.
        helper(doc, hostCopy, 'service.register', false);
        await waitHealth(port, true);
        fs.rmSync(retained, { force: true });
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
