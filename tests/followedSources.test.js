const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-sources-${process.pid}.sqlite`);
jest.mock('@goobster/core/services/aiService', () => ({ listProviders: () => [{ key: 'ollama', isDefault: true, chatModel: 'fixture' }], generateText: jest.fn(async () => { throw new Error('No provider'); }) }));
const db = require('@goobster/core/db');
const { FollowedSourceService } = require('@goobster/core/services/followedSourceService');
const { FollowedSourceFetcher, requestText } = require('@goobster/core/services/followedSourceFetcher');
const { parseFeed, normalizePage, pageChange } = require('@goobster/core/utils/followedSourceContent');
const policy = require('@goobster/core/services/attentionPolicyService');
const { AttentionService } = require('@goobster/core/services/attentionService');
const U = '800000000000000011', V = '800000000000000012';
let now, service, fetchSource, projectId, topicId;
const response = text => ({ status: 200, text, headers: { etag: '"v1"', 'last-modified': 'Sat, 26 Sep 2026 10:00:00 GMT' } });
const feed = (ids = [1]) => `<rss><channel>${ids.map(n => `<item><guid>${n}</guid><title>Change ${n}</title><link>https://example.org/item/${n}</link><pubDate>2026-09-${String(n + 1).padStart(2, '0')}T00:00:00Z</pubDate><description>New evidence for research item ${n}.</description></item>`).join('')}</channel></rss>`;
const page = extra => `<html><body><nav>Ignore navigation</nav><main><h1>Research</h1><p>The original article has a useful opening paragraph.</p>${extra || ''}</main></body></html>`;
const addition = '<h2>New result</h2><p>A substantial new finding explains how observations changed our original expectation.</p>';
const create = (params = {}) => service.create({ userId: U, projectId, url: 'https://example.org/feed', label: 'Research feed', kind: 'feed', ...params });
const row = source => db.get('SELECT * FROM followed_sources WHERE id = @id', { id: source.id });
async function poll(source, text) { now += 3600_001; if (text) fetchSource.mockResolvedValue(response(text)); return service.poll(await row(source)); }
async function candidates() { return service.candidates({ userId: U, policy: await policy.get(U), now }); }
beforeEach(async () => {
    for (const table of ['followed_sources', 'source_fetch_hosts', 'attention_notices', 'attention_feedback', 'attention_policies', 'attention_state', 'observatory_projects', 'kg_nodes', 'work_failures', 'instance_state']) await db.run(`DELETE FROM ${table}`);
    now = Date.parse('2026-09-26T12:00:00Z');
    fetchSource = jest.fn(async () => response(feed()));
    service = new FollowedSourceService({ fetch: fetchSource, now: () => now });
    projectId = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'test', 'Test project')", { userId: U });
    topicId = await db.insert("INSERT INTO kg_nodes (guildId, scopeKey, type, label, curation) VALUES (@guildId, @scopeKey, 'concept', 'Research topic', 'saved')", { guildId: `dm:${U}`, scopeKey: `USER:${U}` });
    await policy.enroll({ userId: U, initiative: 'observe' });
});
afterAll(async () => { await require('@goobster/core/services/eventBusService').close(); await db.closeConnection(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); });

test('creates a private follow without fetching, enrolling or spending', async () => {
    await db.run('DELETE FROM attention_policies');
    const source = await create();
    expect(source).toMatchObject({ label: 'Research feed', initialized: false, enabled: true });
    expect(fetchSource).not.toHaveBeenCalled();
    expect(await policy.get(U)).toBeNull();
    expect((await service.list({ userId: U, projectId })).attentionEnabled).toBe(false);
    await expect(service.check({ userId: U, sourceId: source.id })).rejects.toMatchObject({ code: 'FOLLOW_PAUSED' });
});
test('first check establishes a baseline; repeated GUIDs never generate a notice', async () => {
    const source = await create();
    expect(await poll(source, feed([1, 2]))).toEqual({ status: 'baseline' });
    expect(await candidates()).toEqual([]);
    await poll(source, feed([2, 1]));
    expect(await candidates()).toEqual([]);
    expect((await db.get('SELECT COUNT(*) AS n FROM followed_source_entries')).n).toBe(2);
});
test('five changes after downtime retain provenance but surface only the latest, once', async () => {
    const source = await create(); await poll(source, feed([1]));
    now += 7 * 86400_000; await poll(source, feed([2, 5, 1, 6, 3, 4]));
    const next = await candidates();
    expect(next).toHaveLength(1); expect(next[0].title).toContain('Change 6');
    expect((await db.all('SELECT * FROM followed_source_entries WHERE isChange = 1'))).toHaveLength(5);
    const attention = new AttentionService();
    attention._generators.clear(); attention.registerGenerator('followed_source', { run: () => candidates() });
    const singleton = require('@goobster/core/services/followedSourceService');
    const spy = jest.spyOn(singleton, 'canRaise').mockImplementation((...args) => service.canRaise(...args));
    const result = await attention.sweepUser({ policy: await policy.get(U), deliver: false });
    expect(result.raised).toBe(1); expect(result.notices[0].disposition).toBe('inbox');
    expect((await attention.sweepUser({ policy: await policy.get(U), deliver: false })).raised).toBe(0);
    await attention.actOnNotice({ userId: U, noticeId: result.notices[0].id, action: 'act' });
    expect((await service.list({ userId: U, projectId })).sources[0].metrics.acted).toBe(1);
    spy.mockRestore();
});
test('page whitespace, navigation and dates are ignored; a new heading and paragraph raises once', async () => {
    const source = await create({ kind: 'page' });
    await poll(source, page('<time>2026-09-25</time>'));
    await poll(source, page('<time>2026-09-26</time>').replace('Ignore navigation', 'Different navigation').replace('original article', 'original\n     article'));
    expect(await candidates()).toHaveLength(0);
    await poll(source, page(addition + '<h2>Another result</h2><p>A second substantial paragraph adds details about further observations and evidence.</p>'));
    expect(await candidates()).toHaveLength(1);
    expect((await candidates())[0].title).toContain('New result');
    await poll(source, page(addition + '<h2>Another result</h2><p>A second substantial paragraph adds details about further observations and evidence.</p>'));
    expect((await db.get('SELECT COUNT(*) AS n FROM followed_source_entries')).n).toBe(1);
});
test('Atom identities, CDATA, namespaces, dates and safe links normalize', () => {
    const entries = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example,1</id><title>New &amp; useful</title><updated>2026-09-26T00:00:00Z</updated><link href="/paper"/><content><![CDATA[<p>Evidence here.</p>]]></content></entry></feed>', 'https://example.org/feed');
    expect(entries[0]).toMatchObject({ title: 'New & useful', url: 'https://example.org/paper', text: 'Evidence here.', guid: 'tag:example,1' });
    expect(() => parseFeed('<!DOCTYPE feed><feed/>', 'https://example.org/')).toThrow();
    expect(pageChange(normalizePage(page()).text, normalizePage(page('<p>An extra paragraph without a new heading is not a qualifying region.</p>')))).toBeNull();
});
test('conditional 304 keeps the baseline and sends saved validators', async () => {
    const source = await create(); await poll(source, feed());
    fetchSource.mockResolvedValue({ status: 304, headers: {}, text: '' });
    await poll(source);
    expect(fetchSource).toHaveBeenLastCalledWith(expect.objectContaining({ etag: '"v1"' }));
    expect((await row(source)).etag).toBe('"v1"'); expect(await candidates()).toEqual([]);
});
test('private and forged targets are refused; project membership loss stops checks and reads', async () => {
    await expect(create({ userId: V })).rejects.toMatchObject({ status: 404 });
    const source = await create({ projectId: null, topicNodeId: topicId });
    await expect(service.require(V, source.id)).rejects.toMatchObject({ status: 404 });
    await expect(create({ userId: V, projectId: null, topicNodeId: topicId })).rejects.toMatchObject({ status: 404 });
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@projectId, @userId, @owner)', { projectId, userId: V, owner: U });
    await policy.enroll({ userId: V, initiative: 'observe' });
    const other = await create({ userId: V });
    await db.run('DELETE FROM project_members WHERE userId = @userId', { userId: V });
    expect(await service.candidates({ userId: V, policy: await policy.get(V) })).toEqual([]);
    await expect(service.require(V, other.id)).rejects.toMatchObject({ status: 404 });
    expect(fetchSource).not.toHaveBeenCalled();
});
test('revocation during network I/O cannot persist content', async () => {
    const source = await create();
    fetchSource.mockImplementation(async () => { await service.remove({ userId: U, sourceId: source.id }); return response(feed([2])); });
    await poll(source);
    expect(await db.all('SELECT * FROM followed_source_entries')).toEqual([]);
});
test('disabled research boundaries and restore pause prevent polling', async () => {
    await create(); await policy.setBoundary({ userId: U, category: 'research', proactiveRead: false });
    expect(await candidates()).toEqual([]); expect(fetchSource).not.toHaveBeenCalled();
    await policy.setBoundary({ userId: U, category: 'research', proactiveRead: true });
    await require('@goobster/core/services/instanceStateService').set('paused', { reason: 'restore' });
    expect(await candidates()).toEqual([]); expect(fetchSource).not.toHaveBeenCalled();
});
test('atomic claims prevent duplicate fetches, and source pause invalidates an in-flight response', async () => {
    const source = await create();
    let release; fetchSource.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = service.poll(await row(source));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    expect(await service.poll(await row(source))).toEqual({ status: 'waiting' });
    await service.setEnabled({ userId: U, sourceId: source.id, enabled: false });
    release(response(feed())); await first;
    expect(await db.all('SELECT * FROM followed_source_entries')).toEqual([]);
});
test('failed fetches write a safe work ledger row and back off', async () => {
    const source = await create(); fetchSource.mockRejectedValue(new Error('secret=do-not-record'));
    expect((await poll(source)).status).toBe('failed');
    const failures = await db.all('SELECT * FROM work_failures');
    expect(failures).toHaveLength(1); expect(failures[0]).toMatchObject({ kind: 'followed_source', actor: U });
    expect(JSON.stringify(failures)).not.toContain('do-not-record');
    expect((await row(source)).nextCheckAt).toBeTruthy();
});
test('pause, keep and source removal preserve per-owner boundaries and delete evidence', async () => {
    const source = await create(); await poll(source); await poll(source, feed([1, 2]));
    const entry = await db.get('SELECT * FROM followed_source_entries WHERE isChange = 1');
    await expect(service.keep({ userId: V, sourceId: source.id, entryId: entry.id })).rejects.toMatchObject({ status: 404 });
    await service.keep({ userId: U, sourceId: source.id, entryId: entry.id });
    await service.setEnabled({ userId: U, sourceId: source.id, enabled: false });
    const view = (await service.list({ userId: U, projectId })).sources[0];
    expect(view.metrics.kept).toBe(1); expect(view.disabledCount).toBe(1);
    expect(await candidates()).toEqual([]);
    await service.remove({ userId: V, sourceId: source.id }); expect(await row(source)).toBeTruthy();
    await service.remove({ userId: U, sourceId: source.id }); expect(await db.all('SELECT * FROM followed_source_entries')).toEqual([]);
});
test('pause counts only enabled-to-paused transitions, including after resume', async () => {
    const source = await create();
    const setEnabled = enabled => service.setEnabled({ userId: U, sourceId: source.id, enabled });
    await setEnabled(true);
    expect(await row(source)).toMatchObject({ enabled: 1, disabledCount: 0 });
    await setEnabled(false); await setEnabled(false);
    expect(await row(source)).toMatchObject({ enabled: 0, disabledCount: 1 });
    await setEnabled(true); await setEnabled(true);
    expect(await row(source)).toMatchObject({ enabled: 1, disabledCount: 1 });
    await setEnabled(false);
    expect(await row(source)).toMatchObject({ enabled: 0, disabledCount: 2 });
});
test('robots denies, caches and enforces a shared host interval with validators', async () => {
    const request = jest.fn(async url => response(url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /private\nCrawl-delay: 10' : feed()));
    const f = new FollowedSourceFetcher({ request, now: () => now });
    await expect(f.fetch({ url: 'https://example.org/private' })).rejects.toMatchObject({ code: 'ROBOTS_DENIED' });
    now += 11000;
    await f.fetch({ url: 'https://example.org/feed', etag: '"stored"' });
    expect(request).toHaveBeenLastCalledWith('https://example.org/feed', { headers: { 'If-None-Match': '"stored"' } });
    await expect(f.fetch({ url: 'https://example.org/other' })).rejects.toMatchObject({ code: 'FETCH_DEFERRED' });
    expect(request).toHaveBeenCalledTimes(2);
});
test('robots server failures fail closed; missing robots allow a later bounded request', async () => {
    const request = jest.fn(async () => ({ status: 503, text: '', headers: {} }));
    const f = new FollowedSourceFetcher({ request, now: () => now });
    await expect(f.fetch({ url: 'https://example.org/feed' })).rejects.toMatchObject({ code: 'ROBOTS_UNAVAILABLE' });
    now += 3000; request.mockResolvedValue({ status: 404, text: '', headers: {} });
    await expect(f.fetch({ url: 'https://example.org/feed' })).rejects.toMatchObject({ code: 'FETCH_DEFERRED' });
    now += 3000; request.mockResolvedValue(response(feed()));
    expect((await f.fetch({ url: 'https://example.org/feed' })).status).toBe(200);
});
test('source URL policy refuses credentials, HTTP and private literals before network work', async () => {
    for (const url of ['http://example.org', 'https://127.0.0.1', 'https://user:password@example.org']) await expect(create({ url })).rejects.toBeTruthy();
    const transport = { request: jest.fn() };
    await expect(requestText('https://127.0.0.1', { transport })).rejects.toBeTruthy();
    expect(transport.request).not.toHaveBeenCalled();
});

test('network transport pins DNS, bounds bytes, rejects redirects and times out', async () => {
    const { EventEmitter } = require('node:events');
    function transport(status, text, headers = { 'content-type': 'application/xml' }) {
        return { request: jest.fn((_options, callback) => {
            const req = new EventEmitter(); req.destroy = jest.fn();
            req.end = () => queueMicrotask(() => {
                const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.destroy = jest.fn();
                callback(res); res.emit('data', Buffer.from(text)); res.emit('end');
            });
            return req;
        }) };
    }
    const resolve = jest.fn(async () => ({ address: '93.184.215.14', family: 4 }));
    const ok = transport(200, 'abc');
    expect((await requestText('https://example.org/feed', { resolve, transport: ok })).text).toBe('abc');
    expect(ok.request).toHaveBeenCalledWith(expect.objectContaining({ hostname: '93.184.215.14', servername: 'example.org' }), expect.any(Function));
    await expect(requestText('https://example.org/feed', { resolve, transport: transport(302, '', { location: 'http://127.0.0.1/' }) })).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });
    await expect(requestText('https://example.org/feed', { resolve, transport: transport(200, 'abcdef'), maxBytes: 5 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const stalled = { request: () => { const req = new EventEmitter(); req.destroy = jest.fn(); req.end = () => {}; return req; } };
    await expect(requestText('https://example.org/feed', { resolve, transport: stalled, timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(requestText('https://example.org/feed', { resolve, transport: transport(200, 'bytes', { 'content-type': 'image/png' }) })).rejects.toMatchObject({ code: 'TYPE_REFUSED' });
    await expect(requestText('https://example.org/feed', { resolve: () => new Promise(() => {}), timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(requestText('https://example.org/feed', { resolve: async () => { const e = new Error('private DNS'); e.code = 'ADDRESS_FORBIDDEN'; throw e; }, transport: ok })).rejects.toMatchObject({ code: 'ADDRESS_FORBIDDEN' });
});
test('private research preparation creates one draft with no provider call', async () => {
    const source = await create(); await poll(source); await poll(source, feed([2, 1]));
    const entry = await db.get('SELECT * FROM followed_source_entries WHERE isChange = 1');
    const ai = require('@goobster/core/services/aiService'); ai.generateText.mockClear();
    const first = await service.prepareResearch({ userId: U, sourceId: source.id, entryId: entry.id });
    const again = await service.prepareResearch({ userId: U, sourceId: source.id, entryId: entry.id });
    expect(first).toEqual(again);
    const draft = await db.get('SELECT * FROM spitball_expeditions WHERE id = @id', { id: first.expeditionId });
    expect(draft).toMatchObject({ status: 'DRAFT', projectId: null, userId: U });
    expect(draft.intent).toContain(entry.url); expect(ai.generateText).not.toHaveBeenCalled();
});
test('privacy report includes provenance, and erasure deletes only the owner’s follows', async () => {
    const source = await create(); await poll(source); await poll(source, feed([2, 1]));
    const otherProject = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'other', 'Other')", { userId: V });
    const other = await create({ userId: V, projectId: otherProject });
    const privacy = require('@goobster/core/services/privacyService');
    const report = await privacy.buildUserReport({ userId: U, guildId: `dm:${U}` });
    expect(report.followedSources).toHaveLength(1); expect(report.followedSourceEntries).toHaveLength(2);
    await privacy.forgetUser({ userId: U });
    expect(await db.all('SELECT * FROM followed_source_entries')).toEqual([]);
    expect(await row(other)).toBeTruthy();
    expect(await db.get('SELECT * FROM admission_locks WHERE resource = @resource', { resource: `followed_sources:${U}` })).toBeUndefined();
});

test('portal API authenticates the session and ignores forged user ids', async () => {
    const express = require('express');
    const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
    const app = express();
    app.use(createWebAppApp(createWebAppContext({ config: { webapp: { enabled: true, devMode: true } }, deps: { followedSources: service }, logger: { error() {} } })));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        expect((await fetch(`${base}/api/app/followed-sources?projectId=${projectId}`)).status).toBe(401);
        const login = await fetch(`${base}/api/app/auth/dev-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: U, name: 'Source reader' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const result = await fetch(`${base}/api/app/followed-sources`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ userId: V, projectId, url: 'https://example.org/feed', kind: 'feed' }) });
        expect(result.status).toBe(200);
        const source = await result.json(); expect((await row(source)).userId).toBe(U);
        expect(fetchSource).not.toHaveBeenCalled();
        const badOrigin = await fetch(`${base}/api/app/followed-sources/${source.id}`, { method: 'DELETE', headers: { cookie, Origin: 'https://unrelated.example' } });
        expect(badOrigin.status).toBe(403);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
