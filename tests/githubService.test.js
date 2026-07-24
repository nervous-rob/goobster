/**
 * GitHub REST wrapper (services/githubService.js): repo parsing, request
 * shape (URL, auth, API-version headers), error mapping, and the size-capped
 * file fetch. No network — global.fetch is mocked.
 */
const integrationsConfig = require('../config/integrationsConfig');
const githubService = require('../services/githubService');
const { GitHubError } = require('../services/githubService');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        json: async () => body
    };
}

describe('githubService', () => {
    let originalToken;

    beforeEach(() => {
        originalToken = integrationsConfig.github.token;
        global.fetch = jest.fn();
    });

    afterEach(() => {
        integrationsConfig.github.token = originalToken;
        delete global.fetch;
    });

    describe('parseRepo', () => {
        test('accepts owner/name, URLs, and .git suffixes', () => {
            expect(githubService.parseRepo('nervous-rob/goobster')).toBe('nervous-rob/goobster');
            expect(githubService.parseRepo('https://github.com/nervous-rob/goobster')).toBe('nervous-rob/goobster');
            expect(githubService.parseRepo('git@github.com:nervous-rob/goobster.git')).toBe('nervous-rob/goobster');
            expect(githubService.parseRepo('  owner/repo.name  ')).toBe('owner/repo.name');
        });

        test('rejects malformed references', () => {
            for (const bad of ['', 'justaname', 'a/b/c', 'owner/', 'owner/re po']) {
                expect(() => githubService.parseRepo(bad)).toThrow(GitHubError);
            }
        });
    });

    test('sends auth and version headers when a token is configured', async () => {
        integrationsConfig.github.token = 'ghp_test123';
        global.fetch.mockResolvedValue(jsonResponse({ full_name: 'o/r' }));

        await githubService.getRepo('o/r');

        const [url, options] = global.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.github.com/repos/o/r');
        expect(options.headers.Authorization).toBe('Bearer ghp_test123');
        expect(options.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    });

    test('omits Authorization when keyless', async () => {
        integrationsConfig.github.token = null;
        global.fetch.mockResolvedValue(jsonResponse({ full_name: 'o/r' }));

        await githubService.getRepo('o/r');

        const [, options] = global.fetch.mock.calls[0];
        expect(options.headers.Authorization).toBeUndefined();
    });

    test('maps HTTP failures to coded GitHubErrors', async () => {
        integrationsConfig.github.token = null;

        global.fetch.mockResolvedValueOnce(jsonResponse({}, { status: 404 }));
        await expect(githubService.getRepo('o/missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });

        global.fetch.mockResolvedValueOnce(jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
        await expect(githubService.getRepo('o/r')).rejects.toMatchObject({ code: 'RATE_LIMITED' });

        global.fetch.mockRejectedValueOnce(new Error('network down'));
        await expect(githubService.getRepo('o/r')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    test('code search requires a token', async () => {
        integrationsConfig.github.token = null;
        await expect(githubService.searchCode('o/r', 'foo')).rejects.toMatchObject({ code: 'TOKEN_REQUIRED' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    describe('getFileContent', () => {
        test('decodes base64 content', async () => {
            integrationsConfig.github.token = null;
            global.fetch.mockResolvedValue(jsonResponse({
                path: 'src/app.js',
                size: 11,
                encoding: 'base64',
                content: Buffer.from('hello world').toString('base64')
            }));

            const file = await githubService.getFileContent('o/r', '/src/app.js', { ref: 'main' });
            expect(file.content).toBe('hello world');
            expect(file.path).toBe('src/app.js');

            const [url] = global.fetch.mock.calls[0];
            expect(String(url)).toBe('https://api.github.com/repos/o/r/contents/src/app.js?ref=main');
        });

        test('refuses oversized files and directories', async () => {
            integrationsConfig.github.token = null;

            global.fetch.mockResolvedValueOnce(jsonResponse({ path: 'big.bin', size: 10_000_000, encoding: 'base64', content: '' }));
            await expect(githubService.getFileContent('o/r', 'big.bin')).rejects.toMatchObject({ code: 'TOO_LARGE' });

            global.fetch.mockResolvedValueOnce(jsonResponse([{ path: 'dir/a.js' }]));
            await expect(githubService.getFileContent('o/r', 'dir')).rejects.toMatchObject({ code: 'IS_DIRECTORY' });
        });
    });
});
