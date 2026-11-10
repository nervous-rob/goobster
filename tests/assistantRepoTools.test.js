/**
 * Repository work in delegated runs (DA-11a): commitProjectRepo,
 * pushProjectRepo and openPullRequest.
 *
 * "GitHub" is a local bare repository reached through a file:// transport
 * base, so commit, branch and push are done by the real git on PATH; the
 * GitHub API (branch protection, pull requests) is a small fake. The model
 * is scripted. No provider, no network.
 *
 * The properties under test: a run works only on branches its grant names,
 * and never on the base, default or a protected branch; a push is never
 * forced and a rejected one is a result, not a retry; after a crash a
 * commit, a push and a pull request are each reconciled against the world
 * before anything is done again; pushes and pull requests are capped by
 * `externalOperations` with a small default; only the acting person's own
 * GitHub connection is used; the tools stay behind the pilot gate; and the
 * report says a remote effect cannot be undone.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-repo-tools-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const projects = require('@goobster/core/services/projectService');
const { ObservatoryService, PROJECTS_ROOT } = projects;
const { ProjectRepoService } = require('@goobster/core/services/projectRepoService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const updates = require('@goobster/core/services/assistantUpdateService');
const policies = require('@goobster/core/services/attentionPolicyService');
const access = require('@goobster/core/services/assistantAccessService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { useState } = require('./helpers/featureFixtures');

/** The installation's owner (an operator account), and somebody who is not. */
const A = `76${String(process.pid).padStart(8, '0')}00000001`;
const B = `76${String(process.pid).padStart(8, '0')}00000002`;
const REPO = 'acme/x';
const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-assistant-repo-runs-${process.pid}`);
const REMOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-assistant-remotes-'));
const SEED_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid',
    GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(REMOTES, 'no-global')
};
const CONFIG = {
    enabled: true, projectsEnabled: true, scope: 'everywhere',
    maxProjectsPerUser: 5, maxMembersPerProject: 5, maxProjectMb: 8, maxActiveJobsPerUser: 2, maxResumes: 2,
    maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8, maxUploadMb: 2, maxRenderFrames: 10, renderFps: 24,
    ffmpegCommand: 'ffmpeg', historyEnabled: true, historyMaxFileMb: 8, historyMaxMb: 64, gitCommand: 'git',
    reposEnabled: true, maxReposPerProject: 2, repoCloneDepth: 50, repoMaxMb: 64
};

function git(args, cwd = REMOTES) {
    return execFileSync('git', args, { cwd, env: SEED_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

const BARE = path.join(REMOTES, `${REPO}.git`);
/** What "GitHub" has: the commit a branch points at, its log, and every branch. */
const remote = {
    head: (branch) => {
        try { return git(['--git-dir', BARE, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); } catch { return null; }
    },
    log: (branch) => git(['--git-dir', BARE, 'log', '--format=%an <%ae>%n%B', branch]),
    branches: () => git(['--git-dir', BARE, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).sort(),
    /** Somebody else pushes a commit to a branch. */
    push: (branch, file, body) => {
        const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-assistant-seed-'));
        git(['clone', '-q', BARE, seed]);
        try { git(['checkout', '-q', branch], seed); } catch { git(['checkout', '-q', '-b', branch], seed); }
        fs.writeFileSync(path.join(seed, file), body);
        git(['add', '-A'], seed);
        git(['commit', '-q', '-m', `someone else: ${file}`], seed);
        git(['push', '-q', 'origin', branch], seed);
        fs.rmSync(seed, { recursive: true, force: true });
    }
};

function makeRemote() {
    fs.rmSync(path.join(REMOTES, 'acme'), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(BARE), { recursive: true });
    git(['init', '-q', '--bare', '--initial-branch=main', BARE]);
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-assistant-seed-'));
    git(['init', '-q', '--initial-branch=main', seed]);
    fs.writeFileSync(path.join(seed, 'README.md'), '# hi\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['push', '-q', BARE, 'main'], seed);
    fs.rmSync(seed, { recursive: true, force: true });
}

/** The fake GitHub API and whose connection was asked for. */
let hub;
const notFound = () => Object.assign(new Error('Not Found'), { code: 'NOT_FOUND' });
const service = new ObservatoryService({
    config: CONFIG,
    sandbox: new SandboxService({
        enabled: true, scope: 'everywhere', timeoutMs: 15_000, maxCpuSeconds: 15, maxMemoryMb: 2048,
        maxWriteMb: 16, maxOutputBytes: 64 * 1024, maxOutputFiles: 8, maxFileSizeBytes: 8 * 1024 * 1024,
        runsPerWindow: 1000, maxConcurrent: 4, retentionHours: 24, allowNetwork: false,
        requireStrongIsolation: false, pythonCommand: 'python3', extraBinds: [], runsDir: SANDBOX_ROOT
    })
});
service.repos = new ProjectRepoService({
    config: CONFIG,
    projects: service,
    transportBase: `file://${REMOTES}/`,
    token: async (userId) => { hub.tokensAskedFor.push(String(userId)); return hub.connected.has(String(userId)) ? `token-of-${userId}` : null; },
    allowlist: async () => [],
    identity: async () => ({ login: 'dana', id: 4242 }),
    repoInfo: async () => ({ sizeKb: 12, defaultBranch: hub.defaultBranch }),
    github: (token) => ({
        getBranch: async (repo, branch) => {
            hub.tokensUsed.add(token);
            if (hub.down) throw Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' });
            if (hub.protected.has(branch)) return { name: branch, protected: true };
            if (!remote.head(branch)) throw notFound();
            return { name: branch, protected: false };
        },
        listPullRequests: async (repo, { head }) => {
            hub.tokensUsed.add(token);
            if (hub.down) throw Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' });
            return hub.pulls.filter(pr => `acme:${pr.head.ref}` === head);
        },
        createPullRequest: async (repo, input) => {
            hub.tokensUsed.add(token);
            const pr = {
                number: 8 + hub.pulls.length, html_url: `https://github.com/${repo}/pull/${8 + hub.pulls.length}`,
                title: input.title, body: input.body, draft: Boolean(input.draft), head: { ref: input.head }, base: { ref: input.base }
            };
            hub.created.push({ repo, ...input });
            hub.pulls.push(pr);
            return pr;
        }
    })
});

const realRepos = projects.repos;
beforeAll(() => { projects.repos = service.repos; });

afterAll(async () => {
    projects.repos = realRepos;
    initiatives.stopListening();
    useState();
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await db.closeConnection();
    for (const dir of [path.join(PROJECTS_ROOT, A), SANDBOX_ROOT, REMOTES]) fs.rmSync(dir, { recursive: true, force: true });
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

let pid;
let slug;
const clone = (...rel) => path.join(PROJECTS_ROOT, A, slug, 'repos', 'x', ...rel);
const at = () => ({ userId: A, project: slug, name: 'x' });
const cloneGit = (args) => execFileSync('git', args, {
    env: { ...SEED_ENV, GIT_DIR: path.join(PROJECTS_ROOT, A, `${slug}.repos`, 'x.git'), GIT_WORK_TREE: clone() },
    stdio: ['ignore', 'pipe', 'pipe']
}).toString().trim();

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    for (const table of [
        'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
        'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations', 'work_failures',
        'project_repos', 'project_members', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    fs.rmSync(path.join(PROJECTS_ROOT, A), { recursive: true, force: true });
    hub = { defaultBranch: 'main', protected: new Set(), down: false, pulls: [], created: [], connected: new Set([A]), tokensAskedFor: [], tokensUsed: new Set() };
    makeRemote();
    slug = (await service.createProject({ userId: A, name: 'Garden' })).slug;
    await service.repos.clone({ userId: A, project: slug, repo: REPO });
    pid = Number((await db.get('SELECT id FROM observatory_projects WHERE userId = @u AND slug = @s', { u: A, s: slug })).id);
});

const repository = (branches = ['goobster/*']) => ({ kind: 'repository', projectId: String(pid), ids: [REPO], branches });
const ALL = (branches) => ['repo.commit', 'repo.push', 'pr.create'].map(operation => ({ operation, resource: repository(branches) }));

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, or a final text. */
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const FINISH = [call('finish', { outcome: 'finding', title: 'Done with the branch', summary: 'See below.' })];

/** An active responsibility linked to the project, with one piece of work queued. */
async function queued({ userId = A, operations = ALL(), budgets = undefined } = {}) {
    // Pushing is an external write: Attention has to be at "delegate" with GitHub writes allowed.
    await policies.enroll({ userId, initiative: 'delegate' });
    await policies.setBoundary({ userId, category: 'github', externalWrite: true });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Keep the notes repository tidy', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `repo-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the notes repository tidy', operations, attentionItemId: item, projectId: pid, ...(budgets ? { budgets } : {}) }
    });
    const grant = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    return { grant, initiative: await another(grant, item) };
}

/** One more queued piece of work under the same responsibility. */
async function another(grant, item = grant.attentionItemId) {
    await db.run('UPDATE attention_items SET goal = @goal WHERE id = @id', { id: item, goal: `Keep the notes repository tidy, take ${++goalSeq}` });
    const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
    const row = await initiatives.get({ userId: grant.ownerUserId, id });
    return (await initiatives.act({ userId: grant.ownerUserId, id, action: 'queue', expectedRevision: row.revision })).initiative;
}

/** A claimed initiative with its run row, as a worker that died would have left it. */
async function crashed(initiative) {
    const claimed = await initiatives.claim({ id: initiative.id });
    const runId = await db.insert(
        `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
         VALUES (@i, @r, @rev, @u, @u, @u)`,
        { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
    );
    const inFlight = (tool, args) => db.insert(
        `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
         VALUES (@runId, @u, @tool, @hash, 1, 'write', 'DISPATCHED')`,
        { runId, u: A, tool, hash: runs.argsHash(args) }
    );
    return { runId, inFlight, resume: () => runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken }) };
}

const operations = () => db.all('SELECT id, runId, tool, status, refusalCode, operation, resourceKind, resourceId, resultText FROM assistant_run_operations ORDER BY id', {});
const repoOps = async () => (await operations()).filter(op => op.tool !== 'finish');
const edit = (rel, body) => fs.writeFileSync(clone(rel), body);
const NOTES = { repository: 'x', branch: 'goobster/notes' };

/** A commit on a work branch made by the person's own hand, outside any run. */
async function committed(branch = NOTES.branch, file = 'notes.md') {
    await service.repos.checkout({ ...at(), branch });
    edit(file, `${file} on ${branch}\n`);
    return service.repos.commit({ ...at(), message: `add ${file}` });
}

describe('a run with repository grants', () => {
    test('commits to a work branch, pushes it and opens a draft pull request, and the report says what left the installation', async () => {
        const { initiative } = await queued();
        edit('notes.md', 'frost on the 14th\n');
        edit('scratch.txt', 'not part of this\n');
        const snapshot = jest.spyOn(service.history, 'commitQuietly');
        script(
            [call('commitProjectRepo', { ...NOTES, message: 'Add frost notes', paths: ['repos/x/notes.md'] })],
            [call('pushProjectRepo', NOTES)],
            [call('openPullRequest', { ...NOTES, title: 'Add frost notes', body: 'Notes for the garden plan.' })],
            FINISH
        );
        expect((await runner.tick({ wait: true })).results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });

        const ops = await repoOps();
        expect(ops.map(op => `${op.tool}:${op.status}`)).toEqual(['commitProjectRepo:SUCCEEDED', 'pushProjectRepo:SUCCEEDED', 'openPullRequest:SUCCEEDED']);
        expect(ops.map(op => op.operation)).toEqual(['repo.commit', 'repo.push', 'pr.create']);
        expect(ops.every(op => op.resourceKind === 'repository' && op.resourceId === REPO)).toBe(true);

        // On GitHub: the work branch, committed as the person, carrying the operation's trailer. main is untouched.
        expect(remote.branches()).toEqual(['goobster/notes', 'main']);
        const log = remote.log('goobster/notes');
        expect(log).toContain('dana <4242+dana@users.noreply.github.com>');
        expect(log).toContain('Add frost notes');
        expect(log).toContain(`Goobster-Operation: ${ops[0].runId}:${ops[0].id}`);
        expect(remote.log('main')).not.toContain('Add frost notes');
        // Only the named path was committed; the workspace was snapshotted before the branch switch.
        expect(cloneGit(['show', '--stat', '--format=', 'HEAD'])).toMatch(/notes\.md/);
        expect(cloneGit(['status', '--porcelain'])).toBe('?? scratch.txt');
        expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ slug }), expect.objectContaining({ message: expect.stringMatching(/before switching/) }));

        // The pull request: a draft into the branch the clone started from, marked with the operation.
        expect(hub.created).toEqual([expect.objectContaining({ repo: REPO, head: 'goobster/notes', base: 'main', draft: true, title: 'Add frost notes' })]);
        expect(hub.created[0].body).toContain('Notes for the garden plan.');
        expect(hub.created[0].body).toContain(`Goobster-Operation: ${ops[2].runId}:${ops[2].id}`);

        // Only the acting person's own GitHub connection was ever asked for or used.
        expect([...new Set(hub.tokensAskedFor)]).toEqual([A]);
        expect([...hub.tokensUsed]).toEqual([`token-of-${A}`]);

        // The report is built from the journal: it names each change and says the remote ones cannot be undone.
        const [update] = (await updates.list({ userId: A })).updates;
        expect(update.componentIds).toEqual(expect.arrayContaining(['projects']));
        expect(update.summary).toMatch(/Committed [0-9a-f]{7} on goobster\/notes in acme\/x\. It is in the project's clone only until it is pushed\./);
        expect(update.summary).toMatch(/Pushed goobster\/notes \([0-9a-f]{7}\) to acme\/x on GitHub\. That cannot be undone from here\./);
        expect(update.summary).toMatch(/Opened draft pull request #8 for goobster\/notes on acme\/x \(https:\/\/github\.com\/acme\/x\/pull\/8\)\. That cannot be undone from here\./);
        expect(initiative.id).toBeTruthy();
    }, 60_000);

    test('cannot work outside its branch patterns, on the base or default branch, or on a protected branch', async () => {
        await queued();
        await committed('goobster/notes');
        await committed('feature/x', 'feature.md');
        hub.protected.add('goobster/locked');
        const push = jest.spyOn(service.repos, 'push');
        const commit = jest.spyOn(service.repos, 'commit');
        script(
            [call('pushProjectRepo', { repository: 'x', branch: 'feature/x' }),
                call('pushProjectRepo', { repository: 'x', branch: 'main' }),
                call('commitProjectRepo', { repository: 'x', branch: 'main', message: 'm', paths: ['repos/x/a.md'] }),
                call('pushProjectRepo', { repository: 'x', branch: 'goobster/locked' }),
                call('commitProjectRepo', { repository: 'x', branch: 'goobster/locked', message: 'm', paths: ['repos/x/a.md'] }),
                call('openPullRequest', { repository: 'x', branch: 'goobster/locked', title: 't' }),
                call('pushProjectRepo', { repository: 'x', branch: 'goobster/bad..name' }),
                call('pushProjectRepo', { repository: 'nope', branch: 'goobster/notes' })],
            'Nothing could be done.'
        );
        await runner.tick({ wait: true });
        expect((await repoOps()).map(op => op.refusalCode)).toEqual([
            'OPERATION_OUT_OF_SCOPE', 'BASE_BRANCH', 'BASE_BRANCH', 'PROTECTED_BRANCH', 'PROTECTED_BRANCH', 'PROTECTED_BRANCH', 'BAD_BRANCH', 'NO_SUCH_REPO'
        ]);
        expect(push).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(remote.branches()).toEqual(['main']);
        expect(hub.created).toEqual([]);
    }, 60_000);

    test('the default branch is refused even when the grant names it, and a branch GitHub cannot vouch for is refused', async () => {
        const { grant } = await queued({ operations: ALL(['goobster/*', 'trunk']) });
        await committed('trunk');
        await committed('goobster/notes');
        hub.defaultBranch = 'trunk';
        const push = jest.spyOn(service.repos, 'push');
        script([call('pushProjectRepo', { repository: 'x', branch: 'trunk' })], 'Refused.');
        await runner.tick({ wait: true });

        hub.defaultBranch = 'main';
        hub.down = true;
        await another(grant);
        script([call('pushProjectRepo', NOTES)], 'Refused.');
        await runner.tick({ wait: true });

        // Without a GitHub connection nothing is asked of GitHub at all.
        hub.down = false;
        hub.connected.clear();
        await another(grant);
        script([call('pushProjectRepo', NOTES)], 'Refused.');
        await runner.tick({ wait: true });

        expect((await repoOps()).map(op => `${op.status}:${op.refusalCode}`)).toEqual(['REFUSED:DEFAULT_BRANCH', 'REFUSED:BRANCH_UNVERIFIED', 'REFUSED:NO_GITHUB']);
        expect(push).not.toHaveBeenCalled();
        expect(remote.branches()).toEqual(['main']);
    }, 60_000);

    test('a push is never forced: GitHub being ahead is a result the run reports, not something it retries', async () => {
        await queued();
        await committed();
        remote.push('goobster/notes', 'theirs.md', 'someone else got there first\n');
        const theirs = remote.head('goobster/notes');
        script([call('pushProjectRepo', NOTES)], [call('openPullRequest', { ...NOTES, title: 'Add notes' })], FINISH);
        await runner.tick({ wait: true });

        const ops = await repoOps();
        expect(ops[0]).toMatchObject({ tool: 'pushProjectRepo', status: 'SUCCEEDED' });
        expect(ops[0].resultText).toMatch(/^Not pushed \(REJECTED\): GitHub has commits on that branch this clone does not have, and a push is never forced\.$/);
        expect(ops[1].resultText).toMatch(/^Not opened: goobster\/notes on GitHub is not the commit in the clone/);
        expect(remote.head('goobster/notes')).toBe(theirs);
        expect(hub.created).toEqual([]);
        // Nothing changed, so the report claims no change.
        const listed = (await updates.list({ userId: A })).updates;
        expect(listed.map(update => update.summary).join(' ')).not.toMatch(/Changed:/);
    }, 60_000);

    test('once it has read private knowledge a run can still commit in a project that is the person\'s alone, but nothing leaves the installation', async () => {
        await queued({ operations: [...ALL(), { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } }] });
        await committed();
        edit('private.md', 'from my notes\n');
        const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
        const realExecute = toolsRegistry.execute.bind(toolsRegistry);
        jest.spyOn(toolsRegistry, 'execute').mockImplementation(async (name, args) => (
            name === 'lookupNotes' ? 'a private note about the garden' : realExecute(name, args)
        ));
        const push = jest.spyOn(service.repos, 'push');
        script(
            [call('lookupNotes', { query: 'garden' })],
            [call('commitProjectRepo', { ...NOTES, message: 'Add what I found', paths: ['repos/x/private.md'] })],
            [call('pushProjectRepo', NOTES), call('openPullRequest', { ...NOTES, title: 'Add notes' })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await repoOps()).map(op => `${op.tool}:${op.refusalCode || op.status}`)).toEqual([
            'lookupNotes:SUCCEEDED', 'commitProjectRepo:SUCCEEDED', 'pushProjectRepo:PRIVATE_CONTEXT', 'openPullRequest:PRIVATE_CONTEXT'
        ]);
        expect(push).not.toHaveBeenCalled();
        expect(remote.branches()).toEqual(['main']);
        expect(hub.created).toEqual([]);
        // The refusals cost nothing.
        expect(await runs._externalUsed((await db.get('SELECT id FROM assistant_responsibilities', {})).id, Number.MAX_SAFE_INTEGER)).toBe(0);
    }, 60_000);

    test('commits only files inside the clone, and says so when there is nothing to commit', async () => {
        await queued();
        edit('notes.md', 'x\n');
        script(
            [call('commitProjectRepo', { ...NOTES, message: 'm', paths: ['docs/plan.md'] }),
                call('commitProjectRepo', { ...NOTES, message: 'm', paths: ['repos/x/'] }),
                call('commitProjectRepo', { ...NOTES, message: 'm', paths: ['repos/x/../../secret'] }),
                call('commitProjectRepo', { ...NOTES, message: 'm', paths: [] }),
                call('commitProjectRepo', { ...NOTES, message: 'm', paths: ['repos/x/README.md'] }),
                call('commitProjectRepo', { ...NOTES, message: 'm', paths: ['repos/x/absent.md'] })],
            'Nothing committed.'
        );
        await runner.tick({ wait: true });
        const texts = (await repoOps()).map(op => op.resultText);
        expect(texts[0]).toMatch(/^Not committed: docs\/plan\.md is not a file inside repos\/x\//);
        expect(texts[1]).toMatch(/^Not committed: repos\/x\/ is not a file inside/);
        expect(texts[2]).toMatch(/^Not committed \(BAD_PATH\)/);
        expect(texts[3]).toMatch(/^Not committed: name the files/);
        expect(texts[4]).toBe('Not committed: those paths have no changes to commit.');
        expect(texts[5]).toMatch(/^Not committed \(NO_MATCH\)/);
        expect(cloneGit(['log', '--format=%s'])).toBe('seed');
    }, 60_000);
});

describe('after a crash', () => {
    test('a push that reached GitHub is found there and not pushed again', async () => {
        const { initiative } = await queued();
        const made = await committed();
        await service.repos.push({ ...at(), branch: NOTES.branch });
        const work = await crashed(initiative);
        await work.inFlight('pushProjectRepo', NOTES);
        const push = jest.spyOn(service.repos, 'push');
        const asked = jest.spyOn(service.repos, 'remoteHead');
        script([call('pushProjectRepo', NOTES)], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(asked).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        const [op] = await repoOps();
        expect(op).toMatchObject({ status: 'SUCCEEDED' });
        expect(op.resultText).toBe(`Pushed goobster/notes (${made.short}) to acme/x on GitHub. That cannot be undone from here.`);
        expect((await updates.list({ userId: A })).updates[0].summary).toContain('That cannot be undone from here.');
    }, 60_000);

    test('a push that never left is made once, after GitHub was asked', async () => {
        const { initiative } = await queued();
        const made = await committed();
        const work = await crashed(initiative);
        await work.inFlight('pushProjectRepo', NOTES);
        const order = [];
        const realHead = service.repos.remoteHead.bind(service.repos);
        const realPush = service.repos.push.bind(service.repos);
        jest.spyOn(service.repos, 'remoteHead').mockImplementation((args) => { order.push('ask'); return realHead(args); });
        const push = jest.spyOn(service.repos, 'push').mockImplementation((args) => { order.push('push'); return realPush(args); });
        script([call('pushProjectRepo', NOTES)], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(push).toHaveBeenCalledTimes(1);
        expect(order[0]).toBe('ask');
        expect(remote.head('goobster/notes')).toBe(made.hash);
        expect((await repoOps()).map(op => op.status)).toEqual(['SUCCEEDED']);
    }, 60_000);

    test('a push GitHub cannot settle stops for review instead of being tried again', async () => {
        const { initiative } = await queued();
        await committed();
        remote.push('goobster/notes', 'theirs.md', 'a different commit is there\n');
        const theirs = remote.head('goobster/notes');
        const work = await crashed(initiative);
        await work.inFlight('pushProjectRepo', NOTES);
        const push = jest.spyOn(service.repos, 'push');
        script([call('pushProjectRepo', NOTES)], 'carried on');
        expect(await work.resume()).toMatchObject({ status: 'REVIEW', stopCode: 'OPERATION_UNCERTAIN' });
        expect(push).not.toHaveBeenCalled();
        expect(remote.head('goobster/notes')).toBe(theirs);
        expect((await repoOps()).map(op => op.status)).toEqual(['UNCERTAIN']);

        // The same when GitHub cannot be asked at all.
        const tool = runs.TOOLS.pushProjectRepo;
        jest.spyOn(service.repos, 'remoteHead').mockRejectedValue(Object.assign(new Error('down'), { code: 'NETWORK' }));
        await expect(tool.reconcile(NOTES, { run: { id: 1 }, opId: 1, actor: A, project: { id: pid, slug, ownerId: A } })).rejects.toMatchObject({ code: 'NETWORK' });
    }, 60_000);

    test('a commit is found by its trailer and not made twice; one that never happened is made once', async () => {
        const { initiative } = await queued();
        const work = await crashed(initiative);
        const landed = { ...NOTES, message: 'Add notes', paths: ['repos/x/notes.md'] };
        const absent = { ...NOTES, message: 'Add more', paths: ['repos/x/more.md'] };
        const landedId = await work.inFlight('commitProjectRepo', landed);
        await work.inFlight('commitProjectRepo', absent);
        // The first commit landed before the worker died.
        await service.repos.checkout({ ...at(), branch: NOTES.branch });
        edit('notes.md', 'n\n');
        await service.repos.commit({ ...at(), message: 'Add notes', paths: ['notes.md'], trailers: { 'Goobster-Operation': `${work.runId}:${landedId}` } });
        edit('more.md', 'm\n');
        const commit = jest.spyOn(service.repos, 'commit');
        script([call('commitProjectRepo', landed)], [call('commitProjectRepo', absent)], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit.mock.calls[0][0]).toMatchObject({ paths: ['more.md'] });
        expect(cloneGit(['log', '--format=%s', 'goobster/notes'])).toBe('Add more\nAdd notes\nseed');
        expect((await repoOps()).map(op => op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    }, 60_000);

    test('a pull request is looked up on GitHub first: adopted when it is this one, never opened twice', async () => {
        const { initiative } = await queued();
        await committed();
        await service.repos.push({ ...at(), branch: NOTES.branch });
        const work = await crashed(initiative);
        const args = { ...NOTES, title: 'Add notes' };
        const opId = await work.inFlight('openPullRequest', args);
        hub.pulls.push({
            number: 31, html_url: 'https://github.com/acme/x/pull/31', title: 'Add notes', draft: true,
            body: `Notes.\n\nGoobster-Operation: ${work.runId}:${opId}`, head: { ref: 'goobster/notes' }, base: { ref: 'main' }
        });
        script([call('openPullRequest', args)], [call('openPullRequest', { ...args, title: 'Again' })], FINISH);
        expect(await work.resume()).toMatchObject({ status: 'COMPLETED' });
        expect(hub.created).toEqual([]);
        const ops = await repoOps();
        expect(ops[0].resultText).toMatch(/^Opened draft pull request #31 for goobster\/notes on acme\/x/);
        // A second call for the same branch finds it open and leaves it alone.
        expect(ops[1].resultText).toBe('Not opened: pull request #31 is already open for goobster/notes: https://github.com/acme/x/pull/31');

        // Somebody else's pull request for the branch settles it too; no answer from GitHub does not.
        const tool = runs.TOOLS.openPullRequest;
        const ctx = { run: { id: work.runId }, opId: 999_999, actor: A, project: { id: pid, slug, ownerId: A } };
        expect(await tool.reconcile(args, ctx)).toMatchObject({ state: 'done', result: expect.stringMatching(/^Not opened: pull request #31 is already open/) });
        hub.pulls = [];
        expect(await tool.reconcile(args, ctx)).toEqual({ state: 'absent' });
        hub.down = true;
        await expect(tool.reconcile(args, ctx)).rejects.toMatchObject({ code: 'NETWORK' });
    }, 60_000);

    test('a pull request GitHub cannot be asked about stops for review', async () => {
        const { initiative } = await queued();
        await committed();
        await service.repos.push({ ...at(), branch: NOTES.branch });
        const work = await crashed(initiative);
        const args = { ...NOTES, title: 'Add notes' };
        await work.inFlight('openPullRequest', args);
        hub.down = true;
        script([call('openPullRequest', args)], 'carried on');
        expect(await work.resume()).toMatchObject({ status: 'REVIEW', stopCode: 'OPERATION_UNCERTAIN' });
        expect(hub.created).toEqual([]);
    }, 60_000);
});

describe('the externalOperations budget', () => {
    const branches = ['goobster/a', 'goobster/b', 'goobster/c'];
    async function threeBranches() {
        for (const branch of branches) await committed(branch, `${branch.split('/')[1]}.md`);
    }

    test('defaults to two pushes or pull requests a day across the responsibility, and a refused or declined call costs nothing', async () => {
        const { grant } = await queued();
        await threeBranches();
        script(
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/a' })],
            // Declined (nothing to push) and refused (outside the grant): neither reached GitHub.
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/none' }), call('pushProjectRepo', { repository: 'x', branch: 'feature/x' })],
            FINISH
        );
        await runner.tick({ wait: true });
        let ops = await repoOps();
        expect(ops.map(op => op.refusalCode || op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'OPERATION_OUT_OF_SCOPE']);
        expect(ops[1].resultText).toBe('Not pushed: the clone has no branch goobster/none yet. Commit to it first.');

        // The cap is the responsibility's for the day, not one run's.
        await another(grant);
        script(
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/a' })],
            [call('openPullRequest', { repository: 'x', branch: 'goobster/a', title: 'A' })],
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/b' })],
            [call('openPullRequest', { repository: 'x', branch: 'goobster/b', title: 'B' })],
            FINISH
        );
        await runner.tick({ wait: true });
        ops = (await repoOps()).slice(3);
        expect(ops.map(op => op.refusalCode || op.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'EXTERNAL_BUDGET', 'EXTERNAL_BUDGET']);
        expect(ops[0].resultText).toMatch(/^Not pushed: GitHub already has [0-9a-f]{7} on goobster\/a\.$/);
        expect(ops[1].resultText).toMatch(/^Opened draft pull request #8/);
        expect(remote.branches()).toEqual(['goobster/a', 'main']);
        expect(hub.created).toHaveLength(1);

        // Tomorrow (UTC) it starts again; a local commit never counted.
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        expect(await runs._externalUsed(grant.id, Number.MAX_SAFE_INTEGER)).toBe(2);
        expect(await runs._externalUsed(grant.id, Number.MAX_SAFE_INTEGER, tomorrow)).toBe(0);
    }, 90_000);

    test('honours the grant\'s own number up to a fixed ceiling, and counts an attempt whose outcome is unknown', async () => {
        const { grant, initiative } = await queued({ budgets: { externalOperations: 1 } });
        await threeBranches();
        expect(runs.externalBudget({ budgetsJson: '{"externalOperations":1}' })).toBe(1);
        expect(runs.externalBudget({ budgetsJson: '{"externalOperations":0}' })).toBe(0);
        expect(runs.externalBudget({ budgetsJson: '{"externalOperations":500}' })).toBe(runs.MAX_EXTERNAL_OPERATIONS);
        expect(runs.externalBudget({ budgetsJson: '{}' })).toBe(runs.DEFAULT_EXTERNAL_OPERATIONS);
        expect([runs.DEFAULT_EXTERNAL_OPERATIONS, runs.MAX_EXTERNAL_OPERATIONS]).toEqual([2, 20]);

        // A push that failed without saying whether it landed uses the budget.
        jest.spyOn(service.repos, 'push').mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'NETWORK' }));
        script(
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/a' })],
            [call('pushProjectRepo', { repository: 'x', branch: 'goobster/b' })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await repoOps()).map(op => op.refusalCode || op.status)).toEqual(['FAILED', 'EXTERNAL_BUDGET']);
        expect(await runs._externalUsed(grant.id, Number.MAX_SAFE_INTEGER)).toBe(1);
        expect(remote.branches()).toEqual(['main']);
        expect(initiative.id).toBeTruthy();
    }, 90_000);

    test('a budget of zero grants the operation but allows none', async () => {
        await queued({ budgets: { externalOperations: 0 } });
        await committed('goobster/a', 'a.md');
        script([call('pushProjectRepo', { repository: 'x', branch: 'goobster/a' })], 'No budget.');
        await runner.tick({ wait: true });
        expect((await repoOps())[0]).toMatchObject({ status: 'REFUSED', refusalCode: 'EXTERNAL_BUDGET' });
        expect(remote.branches()).toEqual(['main']);
    }, 60_000);
});

describe('who gets the tools', () => {
    const offeredTo = (chat) => chat.mock.calls[0][1].functions.map(tool => tool.name);

    test('a run is offered only the repository tools its grant names', async () => {
        await queued({ operations: [{ operation: 'repo.commit', resource: repository() }] });
        await committed();
        const chat = script([call('pushProjectRepo', NOTES)], 'Not mine to do.');
        await runner.tick({ wait: true });
        expect((await repoOps())[0]).toMatchObject({ tool: 'pushProjectRepo', status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' });
        expect(remote.branches()).toEqual(['main']);
        const names = offeredTo(chat);
        expect(names).toContain('commitProjectRepo');
        expect(names).not.toContain('pushProjectRepo');
        expect(names).not.toContain('openPullRequest');
    }, 60_000);

    test('a grant without repositories is offered none of them', async () => {
        await queued({ operations: [{ operation: 'read', resource: { kind: 'project', ids: [String(pid)] } }] });
        const chat = script('Nothing to do.');
        await runner.tick({ wait: true });
        const names = offeredTo(chat);
        expect(names).toContain('readProjectFile');
        expect(names.filter(name => /Repo|PullRequest/.test(name))).toEqual([]);
    }, 60_000);

    test('only the installation\'s owner can activate or use them until the pilot decision is recorded', async () => {
        // Somebody who is not the owner cannot activate such a grant.
        await db.run("INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@pid, @b, @a)", { pid, b: B, a: A });
        await policies.enroll({ userId: B, initiative: 'delegate' });
        const { responsibility } = await responsibilities.create({
            userId: B, body: { title: 'Push for me', operations: ALL(), projectId: pid }
        });
        await expect(responsibilities.act({ userId: B, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision }))
            .rejects.toMatchObject({ code: 'PILOT_ONLY' });

        // The owner's run loses the tools the moment they stop being the owner.
        await queued();
        await committed();
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        const ctx = { run: { id: 1, ownerUserId: A }, opId: 1, actor: A, project: { id: pid, slug, ownerId: A } };
        expect(await runs.TOOLS.pushProjectRepo.guard(NOTES, ctx)).toBe('PILOT_ONLY');
        expect(await runs.TOOLS.commitProjectRepo.guard(NOTES, ctx)).toBe('PILOT_ONLY');
        expect(await runs.TOOLS.openPullRequest.guard(NOTES, ctx)).toBe('PILOT_ONLY');
        const chat = script([call('pushProjectRepo', NOTES)], 'Not available.');
        await runner.tick({ wait: true });
        expect(offeredTo(chat).filter(name => /Repo|PullRequest/.test(name))).toEqual([]);
        expect((await repoOps())[0]).toMatchObject({ status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' });
        expect(remote.branches()).toEqual(['main']);
        expect(hub.tokensAskedFor.filter(id => id !== A)).toEqual([]);
    }, 60_000);
});

describe('what projectRepoService answers for unattended work', () => {
    test('branchPolicy reads default and protection from GitHub and fails closed', async () => {
        await committed();
        expect(await service.repos.branchPolicy({ ...at(), branch: 'goobster/notes' })).toMatchObject({
            repo: REPO, branch: 'goobster/notes', base: 'main', defaultBranch: 'main', isDefault: false, exists: false, protected: false
        });
        expect(await service.repos.branchPolicy({ ...at(), branch: 'main' })).toMatchObject({ isDefault: true, exists: true });
        hub.protected.add('release');
        expect(await service.repos.branchPolicy({ ...at(), branch: 'release' })).toMatchObject({ protected: true });
        hub.down = true;
        await expect(service.repos.branchPolicy({ ...at(), branch: 'goobster/notes' })).rejects.toMatchObject({ code: 'BRANCH_UNVERIFIED' });
        hub.down = false;
        hub.defaultBranch = null;
        await expect(service.repos.branchPolicy({ ...at(), branch: 'goobster/notes' })).rejects.toMatchObject({ code: 'BRANCH_UNVERIFIED' });
        hub.connected.clear();
        await expect(service.repos.branchPolicy({ ...at(), branch: 'goobster/notes' })).rejects.toMatchObject({ code: 'NO_GITHUB' });
    }, 60_000);

    test('remoteHead compares the clone with GitHub without fetching; onBranch pins a write to its branch', async () => {
        const made = await committed();
        expect(await service.repos.remoteHead({ ...at(), branch: 'goobster/notes' })).toMatchObject({ local: made.hash, remote: null, remoteIsAncestor: false });
        expect(await service.repos.remoteHead({ ...at(), branch: 'goobster/none' })).toMatchObject({ local: null, remote: null });
        await service.repos.push({ ...at(), branch: 'goobster/notes', onBranch: 'goobster/notes' });
        expect(await service.repos.remoteHead({ ...at(), branch: 'goobster/notes' })).toMatchObject({ local: made.hash, remote: made.hash });
        edit('second.md', 's\n');
        const second = await service.repos.commit({ ...at(), message: 'second', onBranch: 'goobster/notes', trailers: { 'Goobster-Operation': '7:9' } });
        expect(await service.repos.remoteHead({ ...at(), branch: 'goobster/notes' })).toMatchObject({ local: second.hash, remote: made.hash, remoteIsAncestor: true });

        expect(await service.repos.findCommitByTrailer({ ...at(), branch: 'goobster/notes', key: 'Goobster-Operation', value: '7:9' })).toEqual({ hash: second.hash, short: second.short });
        expect(await service.repos.findCommitByTrailer({ ...at(), branch: 'goobster/notes', key: 'Goobster-Operation', value: '7:90' })).toBeNull();
        expect(await service.repos.findCommitByTrailer({ ...at(), branch: 'goobster/none', key: 'Goobster-Operation', value: '7:9' })).toBeNull();
        await expect(service.repos.commit({ ...at(), message: 'm', trailers: { 'Bad key': 'x' } })).rejects.toMatchObject({ code: 'BAD_TRAILER' });
        await expect(service.repos.commit({ ...at(), message: 'm', trailers: { Key: 'line\nbreak' } })).rejects.toMatchObject({ code: 'BAD_TRAILER' });

        // The clone moved to another branch: a write that named its branch refuses.
        await service.repos.checkout({ ...at(), branch: 'main' });
        edit('stray.md', 's\n');
        await expect(service.repos.commit({ ...at(), message: 'm', onBranch: 'goobster/notes' })).rejects.toMatchObject({ code: 'BRANCH_CHANGED' });
        await expect(service.repos.push({ ...at(), branch: 'goobster/notes', onBranch: 'goobster/notes' })).rejects.toMatchObject({ code: 'BRANCH_CHANGED' });
        expect(remote.head('goobster/notes')).toBe(made.hash);
    }, 60_000);
});
