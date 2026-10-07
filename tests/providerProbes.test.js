const net = require('node:net');
const {
    probe, describeTargets, smtpTargetFromUrl, ProbeInputError, TARGET_IDS
} = require('../packages/core/services/providerProbeService');

const PLANTED = 'sk-planted-secret-PROBE-0123456789';
const CLOUD = ['openai', 'anthropic', 'gemini'];

function recordingFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), init });
        return handler(url, init, calls.length);
    };
    fn.calls = calls;
    return fn;
}

const answer = (status, headers = {}, extra = {}) => ({
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    body: { cancel: async () => { } },
    text: async () => `provider said: key ${PLANTED} is wrong`,
    json: async () => ({ error: { message: `bad key ${PLANTED}` } }),
    ...extra
});

const neverResolves = () => (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

describe('provider probes', () => {
    describe('cloud-provider parity', () => {
        test.each(CLOUD)('%s: a valid credential is OK and sent only to the canonical host', async (target) => {
            const fetch = recordingFetch(() => answer(200));
            const out = await probe(target, { credentials: { apiKey: PLANTED }, fetch });
            expect(out).toMatchObject({ target, ok: true, code: 'OK' });
            expect(typeof out.latencyMs).toBe('number');
            expect(fetch.calls).toHaveLength(1);
            const { url, init } = fetch.calls[0];
            expect(new URL(url).protocol).toBe('https:');
            expect(new URL(url).hostname).toBe(describeTargets().find(t => t.target === target).sendsCredentialTo);
            expect(init.method).toBe('GET');
            expect(init.redirect).toBe('manual');
            expect(init.body).toBeUndefined();
            expect(JSON.stringify(init.headers)).toContain(PLANTED);
            expect(url).not.toContain(PLANTED);
        });

        test('the three cloud chat providers return the same outcome codes for the same statuses', async () => {
            const table = { 200: 'OK', 401: 'AUTH_FAILED', 403: 'AUTH_FAILED', 429: 'RATE_LIMITED', 302: 'UNREACHABLE', 503: 'UNREACHABLE', 418: 'UNKNOWN' };
            for (const [status, code] of Object.entries(table)) {
                const results = [];
                for (const target of CLOUD) {
                    const out = await probe(target, { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(Number(status))) });
                    results.push({ code: out.code, ok: out.ok, keys: Object.keys(out).sort() });
                }
                for (const r of results) expect(r).toEqual(results[0]);
                expect(results[0].code).toBe(code);
            }
        });

        test.each(CLOUD)('%s: 401 is AUTH_FAILED, not ok', async (target) => {
            const out = await probe(target, { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(401)) });
            expect(out).toMatchObject({ ok: false, code: 'AUTH_FAILED' });
        });
    });

    describe('outcomes', () => {
        test('429 is RATE_LIMITED and says the credential was not rejected', async () => {
            const out = await probe('openai', { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(429)) });
            expect(out).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
            expect(out.detail).toMatch(/not rejected/);
        });

        test('a GitHub 403 with an exhausted rate limit is RATE_LIMITED, other 403 is AUTH_FAILED', async () => {
            const limited = await probe('github', { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(403, { 'x-ratelimit-remaining': '0' })) });
            expect(limited.code).toBe('RATE_LIMITED');
            const denied = await probe('github', { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(403, { 'x-ratelimit-remaining': '41' })) });
            expect(denied.code).toBe('AUTH_FAILED');
        });

        test('a redirect is reported UNREACHABLE and never followed', async () => {
            const fetch = recordingFetch(() => answer(302, { location: 'https://evil.example/steal' }));
            const out = await probe('anthropic', { credentials: { apiKey: PLANTED }, fetch });
            expect(out).toMatchObject({ ok: false, code: 'UNREACHABLE' });
            expect(out.detail).toMatch(/not followed/);
            expect(fetch.calls).toHaveLength(1);
        });

        test('a hung provider ends in TIMEOUT within the bound', async () => {
            const out = await probe('gemini', { credentials: { apiKey: PLANTED }, fetch: neverResolves(), timeoutMs: 500 });
            expect(out).toMatchObject({ ok: false, code: 'TIMEOUT' });
        });

        test('a network failure is UNREACHABLE and its message is not echoed', async () => {
            const fetch = recordingFetch(() => { throw new Error(`getaddrinfo ENOTFOUND api.openai.com key=${PLANTED}`); });
            const out = await probe('openai', { credentials: { apiKey: PLANTED }, fetch });
            expect(out).toMatchObject({ ok: false, code: 'UNREACHABLE' });
            expect(JSON.stringify(out)).not.toContain(PLANTED);
            expect(JSON.stringify(out)).not.toContain('ENOTFOUND');
        });

        test('the result never contains the credential or anything the provider said', async () => {
            for (const status of [200, 401, 429, 302, 500]) {
                for (const target of TARGET_IDS.filter(t => t !== 'ollama' && t !== 'mail')) {
                    const out = await probe(target, { credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(status)) });
                    expect(JSON.stringify(out)).not.toContain(PLANTED);
                    expect(JSON.stringify(out)).not.toContain('provider said');
                }
            }
        });

        test('every target answers with the same result shape', async () => {
            const fetch = recordingFetch(() => answer(200));
            for (const target of TARGET_IDS.filter(t => t !== 'mail')) {
                const out = await probe(target, { credentials: { apiKey: PLANTED }, endpoint: { host: 'http://127.0.0.1:11434' }, fetch });
                expect(Object.keys(out).sort()).toEqual(['code', 'detail', 'latencyMs', 'ok', 'target', 'whatItDoes']);
            }
        });
    });

    describe('target specifics', () => {
        test('each cloud target authenticates with its own header and sends nothing else', async () => {
            const header = async (target) => {
                const fetch = recordingFetch(() => answer(200));
                await probe(target, { credentials: { apiKey: PLANTED }, fetch });
                return fetch.calls[0].init.headers;
            };
            expect((await header('openai')).Authorization).toBe(`Bearer ${PLANTED}`);
            expect((await header('anthropic'))['x-api-key']).toBe(PLANTED);
            expect((await header('anthropic'))['anthropic-version']).toBeTruthy();
            expect((await header('gemini'))['x-goog-api-key']).toBe(PLANTED);
            expect((await header('elevenlabs'))['xi-api-key']).toBe(PLANTED);
            expect((await header('github')).Authorization).toBe(`Bearer ${PLANTED}`);
            expect((await header('cursor')).Authorization).toBe(`Bearer ${PLANTED}`);
            expect((await header('perplexity')).Authorization).toBe(`Bearer ${PLANTED}`);
        });

        test('Ollama sends no credential and goes to the configured host', async () => {
            const fetch = recordingFetch(() => answer(200));
            const out = await probe('ollama', { credentials: { apiKey: PLANTED }, endpoint: { host: 'http://127.0.0.1:11434/' }, fetch });
            expect(out.ok).toBe(true);
            expect(fetch.calls[0].url).toBe('http://127.0.0.1:11434/api/tags');
            expect(JSON.stringify(fetch.calls[0].init)).not.toContain(PLANTED);
        });

        test('an unreachable Ollama is UNREACHABLE', async () => {
            const fetch = recordingFetch(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); });
            const out = await probe('ollama', { endpoint: { host: 'http://127.0.0.1:11434' }, fetch });
            expect(out).toMatchObject({ ok: false, code: 'UNREACHABLE' });
        });

        test('Ollama hosts with embedded credentials or foreign schemes are refused before sending', async () => {
            const fetch = recordingFetch(() => answer(200));
            for (const host of ['http://user:pw@127.0.0.1:11434', 'file:///etc/passwd', 'not a url', '']) {
                await expect(probe('ollama', { endpoint: { host }, fetch })).rejects.toMatchObject({ code: 'BAD_HOST' });
            }
            expect(fetch.calls).toHaveLength(0);
        });

        test('Resend mail probe uses the key against api.resend.com only', async () => {
            const fetch = recordingFetch(() => answer(200));
            const out = await probe('mail', { mail: { provider: 'resend' }, credentials: { apiKey: PLANTED }, fetch });
            expect(out).toMatchObject({ target: 'mail', ok: true, code: 'OK' });
            expect(fetch.calls[0].url).toBe('https://api.resend.com/domains');
            expect((await probe('mail', { mail: { provider: 'resend' }, credentials: { apiKey: PLANTED }, fetch: recordingFetch(() => answer(401)) })).code).toBe('AUTH_FAILED');
        });
    });

    describe('input errors are raised before anything is sent', () => {
        test('unknown target, missing credential, malformed credential', async () => {
            const fetch = recordingFetch(() => answer(200));
            await expect(probe('nope', { fetch })).rejects.toBeInstanceOf(ProbeInputError);
            await expect(probe('constructor', { fetch })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
            await expect(probe('openai', { fetch })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
            await expect(probe('openai', { credentials: { apiKey: '' }, fetch })).rejects.toMatchObject({ code: 'NO_CREDENTIAL' });
            for (const bad of ['short', 'has space inside key', 'line\nbreak-in-key', 'x'.repeat(5000), 'sk-\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9']) {
                await expect(probe('openai', { credentials: { apiKey: bad }, fetch })).rejects.toMatchObject({ code: 'BAD_CREDENTIAL' });
            }
            expect(fetch.calls).toHaveLength(0);
        });

        test('the error message never contains the credential', async () => {
            try {
                await probe('openai', { credentials: { apiKey: `${PLANTED} with space` }, fetch: recordingFetch(() => answer(200)) });
                throw new Error('expected a refusal');
            } catch (err) {
                expect(err.code).toBe('BAD_CREDENTIAL');
                expect(err.message).not.toContain(PLANTED);
            }
        });
    });

    describe('describeTargets', () => {
        test('names where the credential goes before it is sent', () => {
            const targets = describeTargets();
            expect(targets.map(t => t.target)).toEqual(TARGET_IDS);
            for (const t of targets) expect(t.whatItDoes.length).toBeGreaterThan(20);
            expect(targets.find(t => t.target === 'openai').sendsCredentialTo).toBe('api.openai.com');
            expect(targets.find(t => t.target === 'ollama').sendsCredentialTo).toBeNull();
            expect(targets.find(t => t.target === 'ollama').needsCredential).toBe(false);
        });
    });

    describe('SMTP probe', () => {
        function fakeSmtp(script) {
            const seen = [];
            const server = net.createServer((socket) => {
                socket.setEncoding('utf8');
                if (script.greeting) socket.write(script.greeting);
                socket.on('data', (data) => {
                    seen.push(data);
                    if (/^EHLO/i.test(data)) socket.write(script.ehlo || '250 ok\r\n');
                    if (/^QUIT/i.test(data)) socket.end('221 bye\r\n');
                });
                socket.on('error', () => { });
            });
            return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
        }
        const close = (server) => new Promise(resolve => server.close(resolve));

        test('connects, says EHLO, quits, and never authenticates', async () => {
            const smtp = await fakeSmtp({ greeting: '220 fake ESMTP\r\n', ehlo: '250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n' });
            try {
                const out = await probe('mail', { mail: { host: '127.0.0.1', port: smtp.port, secure: false }, timeoutMs: 3000 });
                expect(out).toMatchObject({ target: 'mail', ok: true, code: 'OK' });
                const wire = smtp.seen.join('');
                expect(wire).toMatch(/^EHLO /);
                expect(wire).not.toMatch(/AUTH|MAIL FROM|RCPT|DATA/i);
            } finally {
                await close(smtp.server);
            }
        });

        test('a refused connection is UNREACHABLE', async () => {
            const smtp = await fakeSmtp({ greeting: '220 x\r\n' });
            const { port } = smtp;
            await close(smtp.server);
            const out = await probe('mail', { mail: { host: '127.0.0.1', port, secure: false }, timeoutMs: 3000 });
            expect(out).toMatchObject({ ok: false, code: 'UNREACHABLE' });
        });

        test('a silent server is TIMEOUT', async () => {
            const smtp = await fakeSmtp({});
            try {
                const out = await probe('mail', { mail: { host: '127.0.0.1', port: smtp.port, secure: false }, timeoutMs: 500 });
                expect(out).toMatchObject({ ok: false, code: 'TIMEOUT' });
            } finally {
                await close(smtp.server);
            }
        });

        test('a non-220 greeting is UNKNOWN and an EHLO refusal is UNKNOWN', async () => {
            const refuse = await fakeSmtp({ greeting: '554 go away\r\n' });
            try {
                expect((await probe('mail', { mail: { host: '127.0.0.1', port: refuse.port }, timeoutMs: 3000 })).code).toBe('UNKNOWN');
            } finally {
                await close(refuse.server);
            }
            const noEhlo = await fakeSmtp({ greeting: '220 hi\r\n', ehlo: '502 nope\r\n' });
            try {
                expect((await probe('mail', { mail: { host: '127.0.0.1', port: noEhlo.port }, timeoutMs: 3000 })).code).toBe('UNKNOWN');
            } finally {
                await close(noEhlo.server);
            }
        });

        test('bad hosts and ports are refused before connecting', async () => {
            for (const mail of [{ host: '', port: 25 }, { host: 'bad host', port: 25 }, { host: 'mail.example.com', port: 0 }, { host: 'mail.example.com', port: 70000 }, {}]) {
                await expect(probe('mail', { mail })).rejects.toMatchObject({ code: 'BAD_HOST' });
            }
        });

        test('smtpTargetFromUrl returns host, port and TLS mode without the userinfo', () => {
            const parsed = smtpTargetFromUrl(`smtps://user:${PLANTED}@mail.example.com`);
            expect(parsed).toEqual({ host: 'mail.example.com', port: 465, secure: true });
            expect(JSON.stringify(parsed)).not.toContain(PLANTED);
            expect(smtpTargetFromUrl('smtp://mail.example.com:2525')).toEqual({ host: 'mail.example.com', port: 2525, secure: false });
            expect(smtpTargetFromUrl('smtp://mail.example.com')).toEqual({ host: 'mail.example.com', port: 587, secure: false });
            expect(smtpTargetFromUrl('https://mail.example.com')).toBeNull();
            expect(smtpTargetFromUrl('garbage')).toBeNull();
        });
    });
});
