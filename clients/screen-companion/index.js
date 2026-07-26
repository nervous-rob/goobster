#!/usr/bin/env node
/**
 * Goobster screen-vision companion.
 *
 * Runs on YOUR machine and holds an outbound WebSocket to your Goobster
 * instance. When you talk to Goobster (text chat or a voice session), he may
 * ask this app for ONE screenshot of your primary display plus the active
 * window's title/app name, and uses it as visual context for his answer.
 *
 * Privacy: nothing is captured or sent unless Goobster requests a frame,
 * which only happens when you address him. Every capture is logged to this
 * console. Stop the app (Ctrl+C) and Goobster is blind again. Unpair fully
 * with /screenvision unlink in Discord.
 *
 * First run (pair):  node index.js --server https://your-goobster-host --code XXXX-XXXX [--label "Gaming PC"]
 * After that:        node index.js
 *
 * The token is saved in companion.config.json next to this file.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');

const CONFIG_PATH = path.join(__dirname, 'companion.config.json');
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--server') args.server = argv[++i];
        else if (argv[i] === '--code') args.code = argv[++i];
        else if (argv[i] === '--label') args.label = argv[++i];
    }
    return args;
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Normalize --server input into http(s) and ws(s) base URLs. */
function serverUrls(server) {
    let base = String(server).replace(/\/+$/, '');
    if (base.startsWith('ws://')) base = 'http://' + base.slice(5);
    if (base.startsWith('wss://')) base = 'https://' + base.slice(6);
    if (!/^https?:\/\//.test(base)) base = 'https://' + base;
    const wsBase = base.replace(/^http/, 'ws');
    return { httpBase: base, wsBase };
}

/** Exchange a one-time /screenvision link code for a client token. */
async function pair(server, code, label) {
    const { httpBase } = serverUrls(server);
    log(`Pairing with ${httpBase} ...`);
    const response = await fetch(`${httpBase}/api/screen/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, label: label || os.hostname() })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body?.error?.message || `Pairing failed (HTTP ${response.status})`);
    }
    saveConfig({ server, token: body.token });
    log(`Paired successfully (Discord user ${body.userId}). Token saved to ${CONFIG_PATH}`);
}

/**
 * Best-effort foreground window metadata: { windowTitle, appName }.
 * Every path degrades to nulls - a capture never fails because the
 * platform helper is missing.
 */
function getActiveWindow() {
    return new Promise((resolve) => {
        const done = (windowTitle, appName) => resolve({
            windowTitle: windowTitle?.trim() || null,
            appName: appName?.trim() || null
        });
        const run = (cmd, args, onOutput) => {
            execFile(cmd, args, { timeout: 3000 }, (error, stdout) => {
                if (error) return done(null, null);
                onOutput(String(stdout));
            });
        };

        if (process.platform === 'win32') {
            const script = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;using System.Text;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int c);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\';'
                + '$h=[FG]::GetForegroundWindow();$sb=New-Object System.Text.StringBuilder 512;[FG]::GetWindowText($h,$sb,512)|Out-Null;'
                + '$p=0;[FG]::GetWindowThreadProcessId($h,[ref]$p)|Out-Null;'
                + '$proc=Get-Process -Id $p -ErrorAction SilentlyContinue;'
                + 'Write-Output ($sb.ToString()+"|"+$proc.ProcessName)';
            run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], (out) => {
                const [title, app] = out.split('|');
                done(title, app);
            });
        } else if (process.platform === 'darwin') {
            run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], (app) => {
                run('osascript', ['-e', 'tell application "System Events" to tell (first application process whose frontmost is true) to get name of front window'], (title) => {
                    done(title, app);
                });
            });
        } else {
            // Linux (X11): xdotool when available
            run('xdotool', ['getactivewindow', 'getwindowname'], (title) => {
                execFile('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 3000 }, (error, pidOut) => {
                    let app = null;
                    if (!error) {
                        try {
                            app = fs.readFileSync(`/proc/${pidOut.trim()}/comm`, 'utf8');
                        } catch { /* process gone */ }
                    }
                    done(title, app);
                });
            });
        }
    });
}

async function captureFrame() {
    const [image, meta] = await Promise.all([
        screenshot({ format: 'jpg' }),
        getActiveWindow()
    ]);
    return { image, meta };
}

function connect(config) {
    const { wsBase } = serverUrls(config.server);
    const url = `${wsBase}/api/screen/ws`;
    let reconnectDelay = RECONNECT_MIN_MS;
    let authFailed = false;

    const open = () => {
        log(`Connecting to ${url} ...`);
        const socket = new WebSocket(url);

        socket.on('open', () => {
            socket.send(JSON.stringify({
                type: 'hello',
                token: config.token,
                agent: 'goobster-screen-companion/1.0'
            }));
        });

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }

            if (message.type === 'ready') {
                reconnectDelay = RECONNECT_MIN_MS;
                log('Connected. Goobster can now request screenshots when you talk to him. Ctrl+C to stop.');
            } else if (message.type === 'capture') {
                log('Capture requested by Goobster...');
                try {
                    const { image, meta } = await captureFrame();
                    socket.send(JSON.stringify({
                        type: 'frame',
                        requestId: message.requestId,
                        format: 'image/jpeg',
                        data: image.toString('base64'),
                        meta
                    }));
                    log(`Sent frame (${Math.round(image.length / 1024)} KB${meta.appName ? `, app: ${meta.appName}` : ''}${meta.windowTitle ? `, window: "${meta.windowTitle}"` : ''})`);
                } catch (error) {
                    log(`Capture failed: ${error.message}`);
                    socket.send(JSON.stringify({
                        type: 'capture_error',
                        requestId: message.requestId,
                        message: error.message
                    }));
                }
            } else if (message.type === 'error') {
                log(`Server error: ${message.code} - ${message.message}`);
                if (message.code === 'AUTH_FAILED') authFailed = true;
            } else if (message.type === 'bye') {
                log(`Server closed the connection: ${message.message}`);
            }
        });

        const scheduleReconnect = () => {
            if (authFailed) {
                log('Authentication failed - your pairing was revoked or replaced. Run /screenvision link in Discord and re-pair with --code.');
                process.exit(1);
            }
            log(`Disconnected. Reconnecting in ${Math.round(reconnectDelay / 1000)}s ...`);
            setTimeout(open, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        };

        socket.on('close', scheduleReconnect);
        socket.on('error', (error) => {
            log(`Socket error: ${error.message}`);
            socket.terminate();
        });
    };

    open();
}

(async () => {
    const args = parseArgs(process.argv);

    if (args.code) {
        if (!args.server) {
            console.error('Pairing needs both --server and --code, e.g.\n  node index.js --server https://your-goobster-host --code XXXX-XXXX');
            process.exit(1);
        }
        try {
            await pair(args.server, args.code, args.label);
        } catch (error) {
            console.error(`Pairing failed: ${error.message}`);
            process.exit(1);
        }
    }

    const config = loadConfig();
    if (!config?.token || !config?.server) {
        console.error(`No pairing found (${CONFIG_PATH}). Run /screenvision link in Discord, then:\n  node index.js --server https://your-goobster-host --code XXXX-XXXX`);
        process.exit(1);
    }

    connect(config);
})();
