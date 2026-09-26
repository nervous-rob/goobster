/** Public HTTPS fetches with durable, instance-wide host politeness. No redirects or credentials. */
const https = require('node:https');
const robotsParser = require('robots-parser');
const db = require('../db');
const { assessUrl, resolvePinned } = require('../utils/safeFetch');
const AGENT = 'Goobster-Follow/1.0';
const utc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ms = text => Date.parse(`${String(text || '').replace(' ', 'T')}Z`) || 0;
class SourceFetchError extends Error {
    constructor(code, message, retryAt = null) { super(message); this.code = code; this.retryAt = retryAt; }
}
async function requestText(raw, { headers = {}, maxBytes = 1024 * 1024, timeoutMs = 8000, transport = https, resolve = resolvePinned } = {}) {
    const { url, host } = assessUrl(raw);
    let timer;
    const pinned = await Promise.race([
        resolve(host),
        new Promise((_ok, reject) => { timer = setTimeout(() => reject(new SourceFetchError('TIMEOUT', 'DNS lookup timed out.')), timeoutMs); })
    ]).finally(() => clearTimeout(timer));
    return new Promise((resolveResult, reject) => {
        let done = false;
        let response;
        let request;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error) { response?.destroy(); request?.destroy(); reject(error); }
            else resolveResult(value);
        };
        timer = setTimeout(() => finish(new SourceFetchError('TIMEOUT', 'Source request timed out.')), timeoutMs);
        request = transport.request({ hostname: pinned.address, servername: host, port: 443,
            path: url.pathname + url.search, method: 'GET',
            headers: { ...headers, Host: host, 'User-Agent': AGENT, 'Accept-Encoding': 'identity', Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain' }
        }, res => {
            response = res;
            if (done) { res.destroy(); return; }
            const status = res.statusCode;
            if ([304, 404, 410, 401, 403].includes(status)) {
                res.destroy();
                finish(null, { status, headers: res.headers, text: '' });
                return;
            }
            if (status !== 200) return finish(new SourceFetchError(status >= 300 && status < 400 ? 'REDIRECT_REFUSED' : 'HTTP_ERROR', `Source returned HTTP ${status}. Use its final URL.`));
            const type = String(res.headers['content-type'] || '').split(';')[0].trim();
            if (!/^(text\/(html|plain|xml)|application\/(rss\+xml|atom\+xml|xml|xhtml\+xml))$/.test(type)) return finish(new SourceFetchError('TYPE_REFUSED', 'Source is not HTML, XML or plain text.'));
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') return finish(new SourceFetchError('ENCODING_REFUSED', 'Source requires an unsupported content encoding.'));
            const chunks = [];
            let bytes = 0;
            res.on('data', chunk => {
                if (done) return;
                bytes += chunk.length;
                if (bytes > maxBytes) return finish(new SourceFetchError('TOO_LARGE', 'Source exceeds the response size limit.'));
                chunks.push(chunk);
            });
            res.on('error', () => finish(new SourceFetchError('FETCH_FAILED', 'Source transfer failed.')));
            res.on('aborted', () => finish(new SourceFetchError('FETCH_FAILED', 'Source transfer was interrupted.')));
            res.on('end', () => finish(null, { status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', () => finish(new SourceFetchError('FETCH_FAILED', 'Could not fetch the source.')));
        request.end();
    });
}
class FollowedSourceFetcher {
    constructor({ request = requestText, now = Date.now } = {}) { this.request = request; this.now = now; }
    async reserve(host, delayMs = 2000) {
        const now = this.now();
        await db.run('INSERT INTO source_fetch_hosts (host) VALUES (@host) ON CONFLICT (host) DO NOTHING', { host });
        const claimed = await db.run(`UPDATE source_fetch_hosts SET nextRequestAt = @next
            WHERE host = @host AND (nextRequestAt IS NULL OR nextRequestAt <= @now)`,
        { host, now: utc(now), next: utc(now + Math.max(2000, delayMs)) });
        if (!claimed.changes) {
            const row = await db.get('SELECT nextRequestAt FROM source_fetch_hosts WHERE host = @host', { host });
            throw new SourceFetchError('FETCH_DEFERRED', 'Waiting for the source host’s request interval.', ms(row?.nextRequestAt));
        }
    }
    async fetch(source) {
        const { url, host } = assessUrl(source.url);
        const robotsUrl = new URL('/robots.txt', url).href;
        let cache = await db.get('SELECT * FROM source_fetch_hosts WHERE host = @host', { host });
        if (!cache?.robotsCheckedAt || this.now() - ms(cache.robotsCheckedAt) > 24 * 3600_000) {
            await this.reserve(host);
            const result = await this.request(robotsUrl, { maxBytes: 512 * 1024 });
            if (![200, 404, 410, 401, 403].includes(result.status)) throw new SourceFetchError('ROBOTS_UNAVAILABLE', 'Robots rules could not be checked.');
            const text = result.status === 200 ? result.text : [401, 403].includes(result.status) ? 'User-agent: *\nDisallow: /' : '';
            await db.run('UPDATE source_fetch_hosts SET robotsText = @text, robotsCheckedAt = @now WHERE host = @host', { host, text, now: utc(this.now()) });
            cache = { robotsText: text, robotsCheckedAt: utc(this.now()) };
            const delay = Number(robotsParser(robotsUrl, text).getCrawlDelay(AGENT)) * 1000 || 2000;
            await db.run('UPDATE source_fetch_hosts SET nextRequestAt = @next WHERE host = @host AND (nextRequestAt IS NULL OR nextRequestAt < @next)', { host, next: utc(this.now() + Math.max(2000, delay)) });
        }
        const robots = robotsParser(robotsUrl, cache.robotsText || '');
        if (robots.isAllowed(url.href, AGENT) !== true) throw new SourceFetchError('ROBOTS_DENIED', 'The source’s robots rules disallow fetching this page.');
        const delay = Number(robots.getCrawlDelay(AGENT)) * 1000 || 2000;
        await this.reserve(host, delay);
        const headers = {};
        if (source.etag) headers['If-None-Match'] = source.etag;
        if (source.lastModified) headers['If-Modified-Since'] = source.lastModified;
        return this.request(url.href, { headers });
    }
}
module.exports = new FollowedSourceFetcher();
module.exports.FollowedSourceFetcher = FollowedSourceFetcher;
module.exports.SourceFetchError = SourceFetchError;
module.exports.requestText = requestText;
module.exports.utc = utc;
