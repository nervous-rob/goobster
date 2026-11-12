const path = require('node:path');
const os = require('node:os');
process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `project-assets-tool-${process.pid}.sqlite`);
process.env.GOOBSTER_SELF_DOCS_EMBEDDINGS = '0';
const db = require('@goobster/core/db');
const config = require('@goobster/core/config/observatoryConfig');
const sandbox = require('@goobster/core/config/sandboxConfig');
const { features } = require('@goobster/core/features/featureState');
const registry = require('@goobster/core/utils/toolsRegistry');
const assets = require('@goobster/core/services/projectAssetService');
const applets = require('@goobster/core/services/webAppletService');
const { buildNativeToolGuidance, buildPromptBasedToolPrompt } = require('@goobster/core/utils/toolPromptBuilder');
const original = { enabled: config.enabled, projectsEnabled: config.projectsEnabled, scope: config.scope, sandbox: sandbox.enabled };
const USER = `project-tool-${process.pid}`;
const context = { user: { id: USER }, channelId: `web:${USER}` };
const call = args => registry.execute('projectAssets', { ...args, interactionContext: context });
let serial = 0;
let project;
beforeEach(async () => {
    config.enabled = false; config.projectsEnabled = true; config.scope = 'web'; sandbox.enabled = false; features.refresh();
    project = `lab-${serial++}`;
    await db.run('INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)', { userId: USER, slug: project, name: project });
});
afterAll(async () => {
    config.enabled = original.enabled; config.projectsEnabled = original.projectsEnabled; config.scope = original.scope; sandbox.enabled = original.sandbox; features.refresh();
    await db.closeConnection();
});

test('projectAssets remains offered without execution, and honors web scope', async () => {
    const web = await registry.getDefinitions(undefined, { isWeb: true });
    expect(web.map(d => d.name)).toContain('projectAssets');
    expect(web.map(d => d.name)).not.toContain('observatory');
    expect((await registry.getDefinitions()).map(d => d.name)).not.toContain('projectAssets');
    const result = await registry.execute('projectAssets', { action: 'list_projects', interactionContext: { user: { id: USER }, channelId: 'discord:1' } });
    expect(result).toMatchObject({ ok: false, code: 'WEB_ONLY' });
    config.projectsEnabled = false;
    expect(await call({ action: 'list_projects' })).toMatchObject({ ok: false, code: 'PROJECTS_DISABLED' });
});

test('incognito omits projectAssets and rejects stale calls, including executePlan steps', async () => {
    const incognito = { ...context, skipHistory: true };
    const definitions = await registry.getDefinitions(undefined, { isWeb: true });
    const { toolPolicy } = require('@goobster/core/services/personalPolicyService');
    const normalPolicy = await toolPolicy(context);
    const privatePolicy = await toolPolicy(incognito);
    expect(definitions.filter(def => normalPolicy.allows(def.name)).map(def => def.name)).toContain('projectAssets');
    expect(definitions.filter(def => privatePolicy.allows(def.name)).map(def => def.name)).not.toContain('projectAssets');

    const args = { action: 'save_app', project, name: 'Private content', language: 'html', code: '<html>Do not store this</html>' };
    const staleResult = await registry.execute('projectAssets', { ...args, interactionContext: incognito });
    expect(staleResult).toMatch(/^❌.*disabled in incognito/);
    const planResult = await registry.execute('executePlan', {
        interactionContext: incognito, stopOnError: true,
        plan: [{ name: 'projectAssets', args }]
    });
    expect(planResult).toMatch(/^❌/);
    expect(planResult).toContain('disabled in incognito');
    expect(planResult).toContain('0/1 steps completed successfully');
    expect(await assets.list({ userId: USER, project })).toHaveLength(0);
});

test('saves, reads, deduplicates and versions complete source directly', async () => {
    const input = { action: 'save_app', project, name: 'Counter', language: 'html', code: '<html><title>Counter</title><button>1</button></html>' };
    expect(await call(input)).toMatchObject({ ok: true, slug: 'counter', version: 1 });
    expect(await call(input)).toMatchObject({ ok: true, deduped: true, version: 1 });
    expect(await call({ ...input, slug: 'counter', code: '<html><title>Counter</title><button>2</button></html>' })).toMatchObject({ ok: true, version: 2 });
    expect(await call({ action: 'get_asset', project, slug: 'counter', version: 1 })).toContain('<button>1</button>');
    expect((await call({ action: 'list_assets', project, kind: 'app' })).assets).toHaveLength(1);
});

test('files a pinned app exactly and rejects access to another user’s pin or project', async () => {
    const source = '<!doctype html><html><title>Original</title><script>const untouched = true;</script></html>';
    const pin = await applets.pin({ userId: USER, title: 'Original', language: 'html', source });
    expect(await call({ action: 'file_app', project, appletId: pin.id })).toMatchObject({ ok: true, slug: 'original' });
    expect((await assets.get({ userId: USER, project, asset: 'original' })).source).toBe(source);
    const other = await applets.pin({ userId: 'another-user', title: 'Private', language: 'html', source: '<html>private</html>' });
    expect(await call({ action: 'file_app', project, appletId: other.id })).toMatchObject({ ok: false });
    await db.run('INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)', { userId: 'another-user', slug: 'private-lab', name: 'Private' });
    expect(await call({ action: 'save_app', project: 'private-lab', name: 'No', code: source })).toMatchObject({ ok: false });
});

test('every provider gets specific routing and prompt-based schemas retain enum and required fields', async () => {
    const definitions = await registry.getDefinitions(undefined, { isWeb: true });
    const prompt = buildPromptBasedToolPrompt(definitions);
    expect(prompt).toContain('"required":["action"]');
    expect(prompt).toContain('"file_app"');
    for (const guide of [prompt, buildNativeToolGuidance()]) {
        expect(guide).toContain('projectAssets');
        expect(guide).toContain('Call tools directly by default');
        expect(guide).toContain('A Project Mission is not executePlan');
        expect(guide).not.toContain('Multiple independent actions → List them as sequential steps');
    }
});

test('the project tool guide is indexed and discoverable through self-documentation', async () => {
    const docs = require('@goobster/core/services/selfDocsService');
    await docs.seed();
    const { results } = await docs.search({ query: 'file existing Chat app projectAssets file_app', kind: 'skill', limit: 8 });
    expect(results.some(hit => hit.relPath === 'documentation/skills/project-tools.md')).toBe(true);
});

test('executePlan counts returned failures and stops dependent work even inside forEach', async () => {
    const result = await registry.execute('executePlan', { stopOnError: true, interactionContext: context, plan: [
        { name: 'projectAssets', args: { action: 'list_projects' } },
        { name: 'projectAssets', forEach: '${step1.projects}', args: { action: 'save_app', project: 'missing-project', name: 'No', code: '<html>No</html>' } },
        { name: 'projectAssets', args: { action: 'save_note', project, name: 'Must not run', code: 'Unexpected side effect' } }
    ] });
    expect(result).toContain('1/2 steps completed successfully');
    expect(result).toMatch(/^❌/);
    expect(result).toContain('Execution stopped');
    expect((await call({ action: 'list_assets', project })).assets).toHaveLength(0);
});


test.each([false, true])('executePlan cancellation settles a hung step and prevents later steps (stopOnError=%s)', async (stopOnError) => {
    const controller = new AbortController();
    let finish;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const tool = require('@goobster/core/utils/tools/projectAssets').projectAssets;
    const spy = jest.spyOn(tool, 'execute').mockImplementation(() => {
        started();
        return new Promise(resolve => { finish = resolve; });
    });
    try {
        const result = registry.execute('executePlan', {
            stopOnError,
            interactionContext: { ...context, abortSignal: controller.signal },
            plan: [
                { name: 'projectAssets', args: { action: 'list_projects' } },
                { name: 'projectAssets', args: { action: 'list_projects' } }
            ]
        });
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        await ready;
        controller.abort();
        await rejected;
        // Even a late completion must never resume the cancelled batch.
        finish({ ok: true });
        await new Promise(resolve => setImmediate(resolve));
        expect(spy).toHaveBeenCalledTimes(1);
        await expect(registry.execute('projectAssets', {
            interactionContext: { ...context, abortSignal: controller.signal }
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(spy).toHaveBeenCalledTimes(1);
    } finally {
        spy.mockRestore();
    }
});
