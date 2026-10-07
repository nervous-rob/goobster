'use strict';

/**
 * A stand-in for a local Ollama server (the pattern of e2e/setupHarness.js): /api/tags lists one model,
 * /api/chat answers one fixed sentence, streamed or not. It lets the first chat turn run with no
 * provider key and no network; the reply is a constant, so no user content ever reaches the evidence.
 */

const http = require('node:http');

const REPLY = 'Hello from the fake model. The new installation answers.';
const MODEL = 'llama3.2:3b';

function startFakeOllama({ port }) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push(`${req.method} ${req.url.split('?')[0]}`);
            if (req.method === 'GET' && req.url.startsWith('/api/tags')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL }] }));
                return;
            }
            if (req.method === 'POST' && req.url.startsWith('/api/chat')) {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch { /* not JSON */ }
                const done = { model: MODEL, done: true, prompt_eval_count: 4, eval_count: 9 };
                if (parsed.stream) {
                    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
                    for (const word of REPLY.split(/(?<= )/)) res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: word }, done: false })}\n`);
                    res.end(`${JSON.stringify({ ...done, message: { role: 'assistant', content: '' } })}\n`);
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ...done, message: { role: 'assistant', content: REPLY } }));
                }
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"error":"not found"}');
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${port}`,
            requests,
            chatRequests: () => requests.filter((line) => line.startsWith('POST /api/chat')).length,
            close: () => new Promise((done) => server.close(done))
        }));
    });
}

module.exports = { startFakeOllama, REPLY, MODEL };
