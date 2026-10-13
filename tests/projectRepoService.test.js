/**
 * Project repositories (ADR 0015): GitHub clones beside the workspace,
 * driven by the host with the person's own GitHub connection.
 *
 * The remote is a local bare repository reached through a file:// transport
 * base; identity, token and allowlist are injected. The real git on PATH
 * does the work, so clone, commit, push, fast-forward pull, branch, reset
 * and remove are exercised for real.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-repos-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { ObservatoryService, PROJECTS_ROOT } = require('@goobster/core/services/projectService');
const { ProjectRepoService, cleanBranch } = require('@goobster/core/services/projectRepoService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const privacyService = require('@goobster/core/services/privacyService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-project-repos-runs-${process.pid}`);
const REMOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-repo-remotes-'));
const TEST_USERS = [];
const SEED_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid',
    GIT_COMMITTER_NAME: 'seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(REMOTES, 'no-global')
};

function git(args, cwd = REMOTES) {
    return execFileSync('git', args, { cwd, env: SEED_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** A bare "GitHub" repository plus a seed checkout that can push to it. */
function makeRemote(repo, { files = { 'README.md': '# hi\n' } } = {}) {
    const bare = path.join(REMOTES, `${repo}.git`);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(['init', '-q', '--bare', '--initial-branch=main', bare]);
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-repo-seed-'));
    git(['init', '-q', '--initial-branch=main', seed]);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(seed, name), body);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['push', '-q', bare, 'main'], seed);
    const upstream = (name, body, message) => {
        git(['pull', '-q', '--ff-only', bare, 'main'], seed);
        fs.writeFileSync(path.join(seed, name), body);
        git(['add', '-A'], seed);
        git(['commit', '-q', '-m', message], seed);
        git(['push', '-q', bare, 'main'], seed);
    };
    const log = (branch = 'main') => git(['--git-dir', bare, 'log', '--format=%an %ae %s', branch]);
    return { bare, seed, upstream, log };
}

const BASE_CONFIG = {
    enabled: true, projectsEnabled: true, scope: 'everywhere',
    maxProjectsPerUser: 5, maxMembersPerProject: 5, maxProjectMb: 8, maxActiveJobsPerUser: 2, maxResumes: 2,
    maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8, maxUploadMb: 2, maxRenderFrames: 10, renderFps: 24,
    ffmpegCommand: 'ffmpeg', historyEnabled: true, historyMaxFileMb: 8, historyMaxMb: 64, gitCommand: 'git',
    reposEnabled: true, maxReposPerProject: 2, repoCloneDepth: 50, repoMaxMb: 64
};

function makeService(observatory = {}, deps = {}) {
    const config = { ...BASE_CONFIG, ...observatory };
    const service = new ObservatoryService({
        config,
        sandbox: new SandboxService({
            enabled: true, scope: 'everywhere', timeoutMs: 15_000, maxCpuSeconds: 15, maxMemoryMb: 2048,
            maxWriteMb: 16, maxOutputBytes: 64 * 1024, maxOutputFiles: 8, maxFileSizeBytes: 8 * 1024 * 1024,
            runsPerWindow: 1000, maxConcurrent: 4, retentionHours: 24, allowNetwork: false,
            requireStrongIsolation: false, pythonCommand: 'python3', extraBinds: [], runsDir: SANDBOX_ROOT
        })
    });
    service.repos = new ProjectRepoService({
        config,
        projects: service,
        transportBase: `file://${REMOTES}/`,
        token: async () => 'token-of-the-person',
        allowlist: async () => [],
        identity: async () => ({ login: 'dana', id: 4242 }),
        repoInfo: async () => ({ sizeKb: 12, defaultBranch: 'main' }),
        ...deps
    });
    return service;
}

let userSeq = 0;
function nextUser() {
    const id = `${200_000_000_000_000_000n + BigInt(process.pid) * 1000n + BigInt(userSeq++)}`;
    TEST_USERS.push(id);
    return id;
}

const workspace = (userId, slug) => path.join(PROJECTS_ROOT, userId, slug);
const reposDir = (userId, slug) => path.join(PROJECTS_ROOT, userId, `${slug}.repos`);

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject(expected);
    return caught;
}

afterAll(async () => {
    await db.closeConnection();
    for (const userId of TEST_USERS) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    for (const dir of [SANDBOX_ROOT, REMOTES]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('gates', () => {
    test('branch names are legalized before git sees them', () => {
        expect(cleanBranch(' feature/x ')).toBe('feature/x');
        expect(cleanBranch('')).toBeNull();
        for (const bad of ['--output=x', '-n', 'a b', 'a..b', 'x@{1}', 'HEAD', '/x', 'x/', 'x.lock', 'a\u0000b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b']) {
            expect(() => cleanBranch(bad)).toThrow(expect.objectContaining({ code: 'BAD_BRANCH' }));
        }
    });

    test('off without git, off when disabled, and the listing still answers', async () => {
        const noGit = makeService({ gitCommand: 'goobster-no-such-git-binary' });
        expect(noGit.repos.availability()).toEqual({ enabled: false, reason: 'GIT_MISSING' });
        const off = makeService({ reposEnabled: false });
        expect(off.repos.availability()).toEqual({ enabled: false, reason: 'DISABLED' });

        const userId = nextUser();
        const project = await off.createProject({ userId, name: 'Off Lab' });
        expect(await off.repos.list({ userId, project: project.slug })).toMatchObject({ enabled: false, reason: 'DISABLED', repos: [] });
        await expectThrow(
            () => off.repos.clone({ userId, project: project.slug, repo: 'acme/widgets' }),
            { status: 503, code: 'REPOS_DISABLED' }
        );
    });

    test('no connected GitHub account means no remote operation, and the personal allowlist applies', async () => {
        makeRemote('acme/gated');
        const userId = nextUser();
        const noToken = makeService({}, { token: async () => null });
        const project = await noToken.createProject({ userId, name: 'Gate Lab' });
        await expectThrow(
            () => noToken.repos.clone({ userId, project: project.slug, repo: 'acme/gated' }),
            { status: 403, code: 'NO_GITHUB' }
        );
        const listed = makeService({}, { allowlist: async () => ['someone/else'] });
        await expectThrow(
            () => listed.repos.clone({ userId, project: project.slug, repo: 'acme/gated' }),
            { status: 403, code: 'REPO_NOT_ALLOWED' }
        );
        for (const bad of ['', 'acme', 'acme/../x', 'https://gitlab.com/a/b', 'a/b/c']) {
            await expectThrow(
                () => listed.repos.clone({ userId, project: project.slug, repo: bad }),
                { status: 400, code: 'BAD_REPO' }
            );
        }
        expect(fs.existsSync(reposDir(userId, project.slug))).toBe(false);
    });
});

describe('merge and rebase', () => {
    async function setup(name) {
        const remote = makeRemote(`acme/${name}`, { files: { 'a.txt': 'one\n', 'shared.txt': 'base\n' } });
        const service = makeService();
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: `Merge ${name}` });
        await service.repos.clone({ userId, project: slug, repo: `acme/${name}` });
        const args = { userId, project: slug, name };
        const file = (rel) => path.join(workspace(userId, slug), 'repos', name, rel);
        return { remote, service, userId, slug, args, file };
    }

    test('a clean merge, a fast-forward merge and an up-to-date merge', async () => {
        const { remote, service, args, file } = await setup('mergeclean');
        await service.repos.checkout({ ...args, branch: 'feature' });
        fs.writeFileSync(file('feature.txt'), 'f\n');
        await service.repos.commit({ ...args, message: 'feature work' });
        expect(await service.repos.merge(args)).toMatchObject({ result: 'up-to-date', base: 'main' });

        // main moves on with a different file: a true merge commit, authored as the person.
        remote.upstream('main-only.txt', 'm\n', 'main moves');
        const merged = await service.repos.merge(args);
        expect(merged).toMatchObject({ result: 'merged', kind: 'merge', base: 'main', conflicts: [] });
        expect(fs.existsSync(file('main-only.txt'))).toBe(true);
        expect(fs.existsSync(file('feature.txt'))).toBe(true);
        expect(merged.status).toMatchObject({ operation: null, changed: 0 });

        // A branch with no local commits just fast-forwards.
        await service.repos.checkout({ ...args, branch: 'main' });
        await service.repos.checkout({ ...args, branch: 'empty' });
        remote.upstream('later.txt', 'l\n', 'main moves again');
        expect(await service.repos.merge(args)).toMatchObject({ result: 'fast-forwarded' });
        expect(fs.existsSync(file('later.txt'))).toBe(true);
        await expectThrow(() => service.repos.merge({ ...args, branch: 'main-is-not-a-branch' }), { code: 'NO_SUCH_BRANCH' });
    }, 60_000);

    test('a conflicted merge stays in progress until it is continued or aborted', async () => {
        const { remote, service, args, file } = await setup('mergeconflict');
        await service.repos.checkout({ ...args, branch: 'feature' });
        fs.writeFileSync(file('shared.txt'), 'feature side\n');
        await service.repos.commit({ ...args, message: 'feature edit' });
        remote.upstream('shared.txt', 'main side\n', 'main edit');

        const stopped = await service.repos.merge(args);
        expect(stopped).toMatchObject({ result: 'conflicted', conflicts: ['shared.txt'] });
        expect(stopped.status).toMatchObject({ operation: 'merge', conflicts: ['shared.txt'] });
        expect(fs.readFileSync(file('shared.txt'), 'utf8')).toContain('<<<<<<<');
        // Everything that would tangle the state is refused while it is open.
        for (const op of ['pull', 'merge', 'rebase']) {
            await expectThrow(() => service.repos[op](args), { status: 409, code: 'IN_PROGRESS' });
        }
        await expectThrow(() => service.repos.commit({ ...args, message: 'nope' }), { code: 'IN_PROGRESS' });
        await expectThrow(() => service.repos.checkout({ ...args, branch: 'main' }), { code: 'IN_PROGRESS' });
        // Markers left in place are not committed.
        await expectThrow(() => service.repos.continue(args), { status: 409, code: 'UNRESOLVED' });

        fs.writeFileSync(file('shared.txt'), 'both sides\n');
        const finished = await service.repos.continue(args);
        expect(finished).toMatchObject({ result: 'merged', conflicts: [] });
        expect(finished.status).toMatchObject({ operation: null, changed: 0 });
        expect(fs.readFileSync(file('shared.txt'), 'utf8')).toBe('both sides\n');
        const pushed = await service.repos.push({ ...args });
        expect(pushed.pushed).toBe(true);
        expect(remote.log('feature')).toContain('dana 4242+dana@users.noreply.github.com');

        // Abort puts the branch back exactly as it was.
        await service.repos.checkout({ ...args, branch: 'second' });
        fs.writeFileSync(file('shared.txt'), 'second side\n');
        await service.repos.commit({ ...args, message: 'second edit' });
        remote.upstream('shared.txt', 'main again\n', 'main edit 2');
        expect((await service.repos.merge(args)).result).toBe('conflicted');
        const aborted = await service.repos.abort(args);
        expect(aborted).toMatchObject({ aborted: 'merge' });
        expect(aborted.status).toMatchObject({ operation: null, changed: 0 });
        expect(fs.readFileSync(file('shared.txt'), 'utf8')).toBe('second side\n');
        await expectThrow(() => service.repos.abort(args), { status: 409, code: 'NO_OPERATION' });
        await expectThrow(() => service.repos.continue(args), { status: 409, code: 'NO_OPERATION' });
    }, 60_000);

    test('rebase replays unpublished commits, stops on conflicts, and refuses published ones', async () => {
        const { remote, service, args, file } = await setup('rebasing');
        await service.repos.checkout({ ...args, branch: 'topic' });
        fs.writeFileSync(file('topic.txt'), 't\n');
        await service.repos.commit({ ...args, message: 'topic work' });
        remote.upstream('main-only.txt', 'm\n', 'main moves');

        const rebased = await service.repos.rebase(args);
        expect(rebased).toMatchObject({ result: 'rebased', kind: 'rebase', conflicts: [] });
        expect(rebased.status).toMatchObject({ operation: null });
        expect(fs.existsSync(file('main-only.txt'))).toBe(true);
        expect(fs.existsSync(file('topic.txt'))).toBe(true);

        // Dirty trees are refused up front; same-branch rebases make no sense.
        fs.writeFileSync(file('loose.txt'), 'x\n');
        await expectThrow(() => service.repos.rebase(args), { code: 'DIRTY' });
        fs.rmSync(file('loose.txt'));
        await service.repos.checkout({ ...args, branch: 'main' });
        await expectThrow(() => service.repos.rebase(args), { code: 'SAME_BRANCH' });

        // A conflicting rebase stops, and can be continued.
        await service.repos.checkout({ ...args, branch: 'clash' });
        fs.writeFileSync(file('shared.txt'), 'clash side\n');
        await service.repos.commit({ ...args, message: 'clash edit' });
        remote.upstream('shared.txt', 'main side\n', 'main edit');
        const stopped = await service.repos.rebase(args);
        expect(stopped).toMatchObject({ result: 'conflicted', conflicts: ['shared.txt'] });
        expect(stopped.status.operation).toBe('rebase');
        await expectThrow(() => service.repos.continue(args), { code: 'UNRESOLVED' });
        fs.writeFileSync(file('shared.txt'), 'resolved\n');
        expect(await service.repos.continue(args)).toMatchObject({ result: 'rebased' });
        expect((await service.repos.status(args)).status).toMatchObject({ operation: null, changed: 0 });

        // Once the commits are on origin, a rebase would need a forced push: refused, merge instead.
        await service.repos.push(args);
        remote.upstream('another.txt', 'a\n', 'main moves again');
        await expectThrow(() => service.repos.rebase(args), { status: 409, code: 'REBASE_PUBLISHED' });
        expect((await service.repos.merge(args)).result).toBe('merged');

        // reset gets out of a stopped operation too.
        await service.repos.checkout({ ...args, branch: 'clash2' });
        fs.writeFileSync(file('shared.txt'), 'clash 2\n');
        await service.repos.commit({ ...args, message: 'clash 2' });
        remote.upstream('shared.txt', 'main 3\n', 'main edit 3');
        expect((await service.repos.rebase(args)).result).toBe('conflicted');
        await service.repos.push({ ...args, branch: 'clash2' }).catch(() => {});
        const reset = await service.repos.reset(args).catch(error => error);
        expect(reset.status?.operation ?? reset.code).toBeFalsy();
    }, 90_000);
});

describe('branches, comparison, pull requests and CI', () => {
    function fakeGithub(remote) {
        const calls = { created: [] };
        const github = () => ({
            listBranches: async () => [{ name: 'main', protected: true, commit: { sha: 'abcdef123456' } }, { name: 'remote-only', protected: false, commit: { sha: '1234567890ab' } }],
            listPullRequests: async () => [{ number: 7, title: 'Add thing', html_url: 'https://github.com/acme/x/pull/7', state: 'open', draft: false, user: { login: 'dana' }, head: { ref: 'feature', sha: 'sha7' }, base: { ref: 'main' } }],
            getChecks: async (repo, ref) => (ref === 'feature' || ref === 'sha7'
                ? { runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/x/runs/1', output: { title: '3 tests failed' } }, { name: 'e2e', status: 'in_progress' }], statuses: [] }
                : (() => { const error = new Error('nf'); error.code = 'NOT_FOUND'; throw error; })()),
            createPullRequest: async (repo, input) => { calls.created.push({ repo, ...input }); return { number: 8, html_url: 'https://github.com/acme/x/pull/8', title: input.title, draft: input.draft }; }
        });
        return { github, calls };
    }

    test('lists branches, compares them, opens a pull request and reports CI', async () => {
        const remote = makeRemote('acme/x', { files: { 'a.txt': 'one\n' } });
        const { github, calls } = fakeGithub(remote);
        const service = makeService({}, { github });
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Branch Lab' });
        await service.repos.clone({ userId, project: slug, repo: 'acme/x' });
        const args = { userId, project: slug, name: 'x' };
        const file = (rel) => path.join(workspace(userId, slug), 'repos', 'x', rel);

        await service.repos.checkout({ ...args, branch: 'feature' });
        fs.writeFileSync(file('a.txt'), 'one\ntwo\n');
        fs.writeFileSync(file('b.txt'), 'bee\n');
        await service.repos.commit({ ...args, message: 'feature work' });

        const listing = await service.repos.branches(args);
        expect(listing).toMatchObject({ current: 'feature', base: 'main', remoteError: null });
        expect(listing.branches.map(b => b.name)).toEqual(['feature', 'main', 'remote-only']);
        expect(listing.branches[0]).toMatchObject({ current: true, local: true, remote: false, aheadOfBase: 1, behindBase: 0 });
        expect(listing.branches[1]).toMatchObject({ isBase: true, remote: true, protected: true });
        expect(listing.branches[2]).toMatchObject({ local: false, remote: true });

        const cmp = await service.repos.compare(args);
        expect(cmp).toMatchObject({ base: 'main', head: 'feature', ahead: 1, behind: 0, fileCount: 2, additions: 2, deletions: 0, identical: false, truncated: false });
        expect(cmp.files.map(f => f.path).sort()).toEqual(['a.txt', 'b.txt']);
        expect(cmp.patch).toContain('+two');
        expect(cmp.commits[0].message).toBe('feature work');
        remote.upstream('m.txt', 'm\n', 'main moves');
        expect(await service.repos.compare(args)).toMatchObject({ ahead: 1, behind: 1 });
        expect(await service.repos.compare({ ...args, head: 'main', base: 'main' })).toMatchObject({ identical: true });
        await expectThrow(() => service.repos.compare({ ...args, head: 'nope' }), { code: 'NO_SUCH_BRANCH' });

        // A pull request needs the branch on GitHub first; push=true does it.
        await expectThrow(() => service.repos.createPullRequest({ ...args, title: 'Add thing' }), { status: 409, code: 'NOT_PUSHED' });
        await expectThrow(() => service.repos.createPullRequest({ ...args, title: '  ' }), { code: 'EMPTY_TITLE' });
        const pr = await service.repos.createPullRequest({ ...args, title: 'Add thing', body: 'why', push: true, draft: true });
        expect(pr).toMatchObject({ number: 8, head: 'feature', base: 'main', draft: true });
        expect(calls.created[0]).toMatchObject({ repo: 'acme/x', head: 'feature', base: 'main', body: 'why' });
        expect(remote.log('feature')).toContain('feature work');
        await service.repos.checkout({ ...args, branch: 'main' });
        await expectThrow(() => service.repos.createPullRequest({ ...args, title: 't' }), { code: 'SAME_BRANCH' });

        const pulls = await service.repos.pullRequests(args);
        expect(pulls.pulls[0]).toMatchObject({ number: 7, head: 'feature', ci: { state: 'failure', passed: 1 } });
        const ci = await service.repos.ci({ ...args, ref: 'feature' });
        expect(ci).toMatchObject({ state: 'failure', total: 3, pending: ['e2e'] });
        expect(ci.failing[0]).toMatchObject({ name: 'test', summary: '3 tests failed' });
        expect(await service.repos.ci(args)).toMatchObject({ state: 'none', notOnGitHub: true });
    }, 60_000);

    test('GitHub being unreachable degrades the branch list instead of failing it', async () => {
        makeRemote('acme/y');
        const service = makeService({}, { github: () => ({ listBranches: async () => { const e = new Error('x'); e.code = 'UNAVAILABLE'; throw e; } }) });
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Offline Lab' });
        await service.repos.clone({ userId, project: slug, repo: 'acme/y' });
        const listing = await service.repos.branches({ userId, project: slug, name: 'y' });
        expect(listing.branches.map(b => b.name)).toEqual(['main']);
        expect(listing.remoteError).toMatch(/could not be reached/);
    }, 30_000);
});

describe('the clone lifecycle', () => {
    test('clone, commit as the GitHub identity, push, pull, branch, reset, remove', async () => {
        const remote = makeRemote('acme/widgets');
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Repo Lab' });
        const slug = project.slug;
        const ws = workspace(userId, slug);

        const cloned = await service.repos.clone({ userId, project: slug, repo: 'https://github.com/acme/widgets' });
        expect(cloned).toMatchObject({ name: 'widgets', repo: 'acme/widgets', path: 'repos/widgets', clonedBranch: 'main' });
        expect(cloned.status).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changed: 0 });
        expect(fs.readFileSync(path.join(ws, 'repos/widgets/README.md'), 'utf8')).toBe('# hi\n');
        // No .git inside the workspace; the git dir is a sibling of the workspace.
        expect(fs.existsSync(path.join(ws, 'repos/widgets/.git'))).toBe(false);
        expect(fs.existsSync(path.join(reposDir(userId, slug), 'widgets.git', 'HEAD'))).toBe(true);
        // The remote URL never carries a credential.
        const remoteUrl = git(['--git-dir', path.join(reposDir(userId, slug), 'widgets.git'), 'remote', 'get-url', 'origin']);
        expect(remoteUrl).not.toContain('token');
        // Workspace history recorded the clone and sees its files as plain files.
        const history = await service.history.log({ userId, project: slug });
        expect(history.commits[0].message).toBe('cloned acme/widgets into repos/widgets');
        expect(history.commits[0].files).toContain('repos/widgets/README.md');

        // Status sees an uncommitted file.
        fs.writeFileSync(path.join(ws, 'repos/widgets/notes.txt'), 'hello\n');
        const dirty = await service.repos.status({ userId, project: slug, name: 'widgets' });
        expect(dirty.status.changed).toBe(1);
        expect(dirty.status.changes).toEqual([{ code: '??', path: 'notes.txt' }]);

        // Commit is authored as the person's GitHub identity, then pushed (never forced).
        const committed = await service.repos.commit({ userId, project: slug, name: 'widgets', message: 'add notes' });
        expect(committed).toMatchObject({ committed: true, author: 'dana' });
        expect(committed.status.ahead).toBe(1);
        expect(await service.repos.commit({ userId, project: slug, name: 'widgets', message: 'again' }))
            .toMatchObject({ committed: false, reason: 'NO_CHANGES' });
        const pushed = await service.repos.push({ userId, project: slug, name: 'widgets' });
        expect(pushed).toMatchObject({ pushed: true, branch: 'main', compareUrl: null, url: 'https://github.com/acme/widgets/tree/main' });
        expect(remote.log()).toContain('dana 4242+dana@users.noreply.github.com add notes');
        expect(pushed.status.ahead).toBe(0);
        const audit = await db.all(`SELECT action, detail FROM integration_audit WHERE guildId = @scope ORDER BY id`, { scope: `dm:${userId}` });
        expect(audit.map(a => a.action)).toEqual(['project-repo-clone', 'project-repo-push']);
        expect(audit[1].detail).not.toContain('token');

        // Upstream moves on: pull fast-forwards and snapshots the workspace.
        remote.upstream('B.md', 'b\n', 'upstream change');
        const pulled = await service.repos.pull({ userId, project: slug, name: 'widgets' });
        expect(pulled.updated).toBe(true);
        expect(fs.existsSync(path.join(ws, 'repos/widgets/B.md'))).toBe(true);
        expect(await service.repos.pull({ userId, project: slug, name: 'widgets' })).toMatchObject({ updated: false });
        expect((await service.history.log({ userId, project: slug })).commits.map(c => c.message))
            .toEqual(expect.arrayContaining([expect.stringMatching(/^pulled repos\/widgets/)]));

        // A new branch, a commit on it, a push that returns the compare URL.
        const switched = await service.repos.checkout({ userId, project: slug, name: 'widgets', branch: 'feature/x' });
        expect(switched).toMatchObject({ branch: 'feature/x', created: true });
        fs.writeFileSync(path.join(ws, 'repos/widgets/notes.txt'), 'changed\n');
        await service.repos.commit({ userId, project: slug, name: 'widgets', message: 'tweak' });
        const featurePush = await service.repos.push({ userId, project: slug, name: 'widgets' });
        expect(featurePush.compareUrl).toBe('https://github.com/acme/widgets/compare/main...feature%2Fx?expand=1');
        expect(remote.log('feature/x')).toContain('tweak');

        // Back on main with a local-only commit while upstream also moved: the
        // push is rejected, the pull reports divergence, reset goes back to origin.
        expect((await service.repos.checkout({ userId, project: slug, name: 'widgets', branch: 'main' })).created).toBe(false);
        fs.writeFileSync(path.join(ws, 'repos/widgets/local.txt'), 'local\n');
        await service.repos.commit({ userId, project: slug, name: 'widgets', message: 'local only' });
        remote.upstream('C.md', 'c\n', 'upstream 2');
        await expectThrow(() => service.repos.push({ userId, project: slug, name: 'widgets' }), { status: 409, code: 'REJECTED' });
        await expectThrow(() => service.repos.pull({ userId, project: slug, name: 'widgets' }), { status: 409, code: 'DIVERGED' });
        const reset = await service.repos.reset({ userId, project: slug, name: 'widgets' });
        expect(reset.status).toMatchObject({ ahead: 0, behind: 0, changed: 0 });
        expect(fs.existsSync(path.join(ws, 'repos/widgets/local.txt'))).toBe(false);
        expect(fs.existsSync(path.join(ws, 'repos/widgets/C.md'))).toBe(true);
        // The discarded file is still in a workspace snapshot.
        const snapshots = await service.history.log({ userId, project: slug, path: 'repos/widgets/local.txt' });
        expect(snapshots.commits.length).toBeGreaterThan(0);

        // Listing, caps and removal.
        const listing = await service.repos.list({ userId, project: slug });
        expect(listing.repos.map(r => r.name)).toEqual(['widgets']);
        makeRemote('acme/second');
        makeRemote('acme/third');
        await service.repos.clone({ userId, project: slug, repo: 'acme/second' });
        await expectThrow(
            () => service.repos.clone({ userId, project: slug, repo: 'acme/third' }),
            { status: 400, code: 'TOO_MANY_REPOS' }
        );
        await expectThrow(
            () => service.repos.clone({ userId, project: slug, repo: 'acme/widgets', name: 'widgets' }),
            { status: 409, code: 'DUPLICATE_REPO' }
        );
        const removed = await service.repos.remove({ userId, project: slug, name: 'widgets' });
        expect(removed).toMatchObject({ removed: true });
        expect(fs.existsSync(path.join(ws, 'repos/widgets'))).toBe(false);
        expect(fs.existsSync(path.join(reposDir(userId, slug), 'widgets.git'))).toBe(false);
        expect(await db.get('SELECT 1 AS ok FROM project_repos WHERE projectId = @id AND name = @name', { id: project.id, name: 'widgets' })).toBeFalsy();
        await expectThrow(
            () => service.repos.status({ userId, project: slug, name: 'widgets' }),
            { status: 404, code: 'NO_SUCH_REPO' }
        );
    }, 60_000);

    test('a missing repository, a missing branch and an oversized repository are refused cleanly', async () => {
        makeRemote('acme/small');
        const service = makeService();
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Refusal Lab' });
        await expectThrow(
            () => service.repos.clone({ userId, project: slug, repo: 'acme/nope' }),
            { status: 404, code: 'NOT_FOUND' }
        );
        await expectThrow(
            () => service.repos.clone({ userId, project: slug, repo: 'acme/small', branch: 'no-such-branch' }),
            { status: 404, code: 'NO_SUCH_BRANCH' }
        );
        const huge = makeService({}, { repoInfo: async () => ({ sizeKb: 999_999, defaultBranch: 'main' }) });
        await expectThrow(
            () => huge.repos.clone({ userId, project: slug, repo: 'acme/small' }),
            { status: 413, code: 'REPO_TOO_LARGE' }
        );
        // Nothing half-cloned is left behind.
        expect(fs.existsSync(path.join(workspace(userId, slug), 'repos'))).toBe(false);
        expect(fs.existsSync(reposDir(userId, slug))).toBe(false);
        expect((await service.repos.list({ userId, project: slug })).repos).toEqual([]);
    });

    test('the clone counts toward the workspace quota and is undone when it breaks it', async () => {
        makeRemote('acme/fat', { files: { 'blob.bin': 'x'.repeat(1024 * 1024 + 1) } });
        const service = makeService({ maxProjectMb: 1 });
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Quota Lab' });
        await expectThrow(
            () => service.repos.clone({ userId, project: slug, repo: 'acme/fat' }),
            { status: 413, code: 'QUOTA_EXCEEDED' }
        );
        expect(fs.existsSync(path.join(workspace(userId, slug), 'repos', 'fat'))).toBe(false);
    });

    test('deleting the project removes the clones; a collaborator\'s erasure only drops their attribution', async () => {
        makeRemote('acme/shared');
        const service = makeService();
        const ownerId = nextUser();
        const memberId = nextUser();
        const project = await service.createProject({ userId: ownerId, name: 'Shared Repo Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, userName, invitedBy)
             VALUES (@projectId, @userId, 'Dana', @ownerId)`,
            { projectId: project.id, userId: memberId, ownerId }
        );
        const cloned = await service.repos.clone({ userId: memberId, project: project.slug, owner: ownerId, repo: 'acme/shared' });
        expect(cloned.createdBy).toBe(memberId);

        await privacyService.forgetUser({ userId: memberId });
        const row = await db.get('SELECT createdBy FROM project_repos WHERE id = @id', { id: cloned.id });
        expect(row.createdBy).toBeNull();
        expect(fs.existsSync(path.join(reposDir(ownerId, project.slug), 'shared.git'))).toBe(true);

        await service.deleteProject({ userId: ownerId, project: project.slug });
        expect(fs.existsSync(reposDir(ownerId, project.slug))).toBe(false);
        expect(await db.get('SELECT 1 AS ok FROM project_repos WHERE id = @id', { id: cloned.id })).toBeFalsy();
    });
});
