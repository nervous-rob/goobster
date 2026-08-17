/**
 * The SSRF-hardened download helper (utils/safeFetch.js).
 *
 * Three separately testable stages: URL assessment (shape + allowlist),
 * DNS resolution with a pinned public address, and the byte-capped,
 * redirect-refusing transfer. Transfer tests run against a real loopback
 * HTTP server by composing the stages the way a caller would - the address
 * policy itself is never weakened to make that possible.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SafeFetchError, assessUrl, resolvePinned, fetchToFile, isForbiddenAddress } = require('../utils/safeFetch');

describe('address policy', () => {
    const forbidden = [
        '127.0.0.1', '127.9.9.9',              // loopback
        '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC1918
        '169.254.169.254',                     // link-local / cloud metadata
        '100.64.0.1', '100.127.255.254',       // CGNAT
        '0.0.0.0', '0.1.2.3',                  // this-network
        '192.0.0.1', '192.0.2.44',             // IETF, TEST-NET-1
        '198.18.0.1', '198.51.100.7', '203.0.113.9', // benchmarking, TEST-NETs
        '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', // multicast/reserved
        '::1', '::',                           // v6 loopback/unspecified
        'fc00::1', 'fd12:3456::1',             // unique-local
        'fe80::1',                             // link-local
        'ff02::1',                             // multicast
        '2001:db8::1',                         // documentation
        '::ffff:127.0.0.1', '::ffff:10.0.0.1', // v4-mapped private
        '64:ff9b::127.0.0.1',                  // NAT64 of loopback
        'not-an-ip', ''                        // garbage never connects
    ];
    test.each(forbidden)('refuses %s', (ip) => {
        expect(isForbiddenAddress(ip)).toBe(true);
    });

    const allowed = [
        '93.184.216.34', '8.8.8.8', '130.167.181.5', '172.15.0.1', '172.32.0.1',
        '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1',
        '2606:4700::6810:84e5', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8'
    ];
    test.each(allowed)('allows public %s', (ip) => {
        expect(isForbiddenAddress(ip)).toBe(false);
    });
});

describe('assessUrl', () => {
    const codeOf = (fn) => {
        try { fn(); } catch (error) { return error.code; }
        return null;
    };

    test('accepts a plain https URL and reports allowlist membership', () => {
        const off = assessUrl('https://mast.stsci.edu/some/product.fits', ['zenodo.org']);
        expect(off.host).toBe('mast.stsci.edu');
        expect(off.allowlisted).toBe(false);
        const on = assessUrl('https://MAST.STSCI.EDU/x', ['mast.stsci.edu']);
        expect(on.allowlisted).toBe(true);
    });

    test('refuses everything that is not plain https on 443', () => {
        expect(codeOf(() => assessUrl('http://example.com/'))).toBe('HTTPS_ONLY');
        expect(codeOf(() => assessUrl('ftp://example.com/'))).toBe('HTTPS_ONLY');
        expect(codeOf(() => assessUrl('file:///etc/passwd'))).toBe('HTTPS_ONLY');
        expect(codeOf(() => assessUrl('https://example.com:8443/'))).toBe('PORT_REFUSED');
        expect(codeOf(() => assessUrl('https://user:pass@example.com/'))).toBe('NO_CREDENTIALS');
        expect(codeOf(() => assessUrl('not a url'))).toBe('BAD_URL');
        expect(codeOf(() => assessUrl(''))).toBe('BAD_URL');
    });

    test('literal-IP URLs hit the address policy immediately', () => {
        expect(codeOf(() => assessUrl('https://127.0.0.1/x'))).toBe('ADDRESS_FORBIDDEN');
        expect(codeOf(() => assessUrl('https://169.254.169.254/latest/meta-data/'))).toBe('ADDRESS_FORBIDDEN');
        expect(codeOf(() => assessUrl('https://[::1]/x'))).toBe('ADDRESS_FORBIDDEN');
        expect(assessUrl('https://8.8.8.8/x').host).toBe('8.8.8.8');
    });
});

describe('resolvePinned', () => {
    test('pins the first address when every record is public', async () => {
        const lookup = async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '2606:4700::1', family: 6 }
        ];
        await expect(resolvePinned('example.com', { lookup }))
            .resolves.toEqual({ address: '93.184.216.34', family: 4 });
    });

    test('one private record poisons the whole name (no routing by luck)', async () => {
        const lookup = async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.7', family: 4 }
        ];
        await expect(resolvePinned('evil.example', { lookup }))
            .rejects.toMatchObject({ code: 'ADDRESS_FORBIDDEN' });
    });

    test('resolution failures and empty answers are DNS errors', async () => {
        await expect(resolvePinned('nope.example', { lookup: async () => { throw new Error('NXDOMAIN'); } }))
            .rejects.toMatchObject({ code: 'DNS_FAILED' });
        await expect(resolvePinned('empty.example', { lookup: async () => [] }))
            .rejects.toMatchObject({ code: 'DNS_FAILED' });
    });
});

describe('fetchToFile (loopback server, http transport injected)', () => {
    let server;
    let port;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-fetch-test-'));
    const dest = (name) => path.join(tmpDir, name);

    beforeAll((done) => {
        server = http.createServer((req, res) => {
            if (req.url === '/ok.csv') {
                res.writeHead(200, { 'Content-Type': 'text/csv' });
                res.end('wavelength,depth\n4.26,2.44\n');
            } else if (req.url === '/redirect') {
                res.writeHead(302, { Location: 'http://169.254.169.254/latest/' });
                res.end();
            } else if (req.url === '/big') {
                // Chunked (no Content-Length at all): the cap must count
                // received bytes, not trust any advertised size.
                res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                const chunk = Buffer.alloc(64 * 1024);
                for (let i = 0; i < 16; i++) res.write(chunk);
                res.end();
            } else if (req.url === '/html') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html>nope</html>');
            } else {
                res.writeHead(404);
                res.end();
            }
        }).listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });
    afterAll((done) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        server.close(done);
    });

    const urlFor = (pathname) => {
        // What a caller composes: an assessed URL + a pinned address. The
        // loopback address is injected here precisely because the policy
        // stages (tested above) would never produce it.
        const url = new URL(`https://fetch-test.example${pathname}`);
        url.port = String(port);
        return url;
    };
    const opts = (pathname, name, extra = {}) => ({
        url: urlFor(pathname),
        address: '127.0.0.1',
        destPath: dest(name),
        maxBytes: 64 * 1024,
        timeoutMs: 5_000,
        transport: http,
        ...extra
    });

    test('downloads to the destination and reports bytes + content type', async () => {
        const result = await fetchToFile(opts('/ok.csv', 'ok.csv'));
        expect(result.contentType).toBe('text/csv');
        expect(fs.readFileSync(dest('ok.csv'), 'utf8')).toContain('4.26');
        expect(result.bytes).toBe(fs.statSync(dest('ok.csv')).size);
    });

    test('refuses redirects outright (the classic allowlist escape)', async () => {
        await expect(fetchToFile(opts('/redirect', 'redir.bin')))
            .rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
        expect(fs.existsSync(dest('redir.bin'))).toBe(false);
    });

    test('caps RECEIVED bytes, not the Content-Length the server claims', async () => {
        await expect(fetchToFile(opts('/big', 'big.bin', { maxBytes: 4096 })))
            .rejects.toMatchObject({ code: 'TOO_LARGE' });
        expect(fs.existsSync(dest('big.bin'))).toBe(false);
    });

    test('enforces the content-type allowlist when given one', async () => {
        await expect(fetchToFile(opts('/html', 'page.html', { allowedContentTypes: ['text/csv', 'application/json'] })))
            .rejects.toMatchObject({ code: 'TYPE_REFUSED' });
        await expect(fetchToFile(opts('/ok.csv', 'ok2.csv', { allowedContentTypes: ['text/'] })))
            .resolves.toMatchObject({ contentType: 'text/csv' });
    });

    test('non-200 answers fail cleanly and leave no file behind', async () => {
        await expect(fetchToFile(opts('/missing', 'missing.bin')))
            .rejects.toMatchObject({ code: 'HTTP_ERROR' });
        expect(fs.existsSync(dest('missing.bin'))).toBe(false);
    });

    test('SafeFetchError carries the status+code contract', async () => {
        try {
            await fetchToFile(opts('/missing', 'x.bin'));
        } catch (error) {
            expect(error).toBeInstanceOf(SafeFetchError);
            expect(error.status).toBe(502);
            return;
        }
        throw new Error('expected a SafeFetchError');
    });
});
