/**
 * The pilot rehearsal (DA-6; documentation/delegated_pilot.md).
 *
 * Drives the integrated delegated-work flow the personal pilot will use,
 * end to end, against a throwaway database: one owner, one project, the
 * pilot's three responsibilities (keep knowledge current, advance approved
 * work, keep recurring work healthy) and the eight things the pilot must be
 * able to rely on (SPEC section 11 journeys A to G, plus the host's
 * controls and the record). Every service is the real one. What is not
 * real is everything outside the installation: the model is a script, and
 * a search, a note lookup, a workspace file, a followed page, a Notion
 * page and a Discord message are fixtures held in memory. No provider, no
 * key, no network.
 *
 * It proves the plumbing holds together, never that a model behaves: that
 * is the evaluation set's job (documentation/delegated_evaluation.md).
 *
 * `rehearse()` needs an empty database and refuses anything else, because
 * it presses the host's stop-all and records a pilot decision on the way.
 * `scripts/pilot-rehearsal.js` gives it one.
 */
'use strict';

const path = require('node:path');

const HOUR = 3600000;
const DAY = 24 * HOUR;

const JOURNEYS = [
    { id: 'A', title: 'A source change improves knowledge and project state' },
    { id: 'B', title: 'A conversation becomes authorized progress' },
    { id: 'C', title: 'A broken import is repaired or escalated' },
    { id: 'D', title: 'A quiet process is told apart from an obsolete one' },
    { id: 'E', title: 'Authority, concurrency and partial availability' },
    { id: 'F', title: 'Review and delivery stay consistent' },
    { id: 'G', title: 'The Inbox is told apart from Needs you' },
    { id: 'H', title: 'The host\'s controls, the pilot gate and the record' }
];

const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

class RehearsalError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RehearsalError';
        this.code = code;
    }
}

/**
 * Run the rehearsal.
 *
 * @param {Object} [options]
 * @param {Function} [options.onJourney]  called with each journey's record as it finishes
 * @returns {Promise<{ ok: boolean, prompt: string, journeys: Object[], checks: { total: number, failed: number }, outcomes: Object|null }>}
 */
async function rehearse({ onJourney = null } = {}) {
    const db = require('@goobster/core/db');
    const aiService = require('@goobster/core/services/aiService');
    const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
    const modelCallScope = require('@goobster/core/utils/modelCallScope');
    const identity = require('@goobster/core/services/identityService');
    const instanceState = require('@goobster/core/services/instanceStateService');
    const policies = require('@goobster/core/services/attentionPolicyService');
    const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
    const initiatives = require('@goobster/core/services/assistantInitiativeService');
    const runs = require('@goobster/core/services/assistantRunService');
    const runner = require('@goobster/core/services/assistantRunnerService');
    const updates = require('@goobster/core/services/assistantUpdateService');
    const gates = require('@goobster/core/services/assistantGateService');
    const home = require('@goobster/core/services/assistantHomeService');
    const steward = require('@goobster/core/services/assistantStewardService');
    const control = require('@goobster/core/services/assistantControlService');
    const access = require('@goobster/core/services/assistantAccessService');
    const delivery = require('@goobster/core/services/assistantDeliveryService');
    const outcomes = require('@goobster/core/services/assistantOutcomeService');
    const processes = require('@goobster/core/services/assistantProcessService');
    const lifecycle = require('@goobster/core/services/assistantProcessLifecycleService');
    const inbox = require('@goobster/core/services/inboxService');
    const kg = require('@goobster/core/services/knowledgeGraphService');
    const missions = require('@goobster/core/services/projectMissionService');
    const projects = require('@goobster/core/services/projectService');
    const parlor = require('@goobster/core/services/parlorService');
    const perplexity = require('@goobster/core/services/perplexityService');
    const followedSources = require('@goobster/core/services/followedSourceService');
    const { features } = require('@goobster/core/features/featureState');

    const off = ['assistant', 'projects', 'knowledge'].filter(id => features.enforcedOff(id));
    if (off.length) throw new RehearsalError('FEATURE_OFF', `The rehearsal needs these features switched on: ${off.join(', ')}.`);
    const existing = await db.get('SELECT COUNT(*) AS n FROM assistant_responsibilities', {});
    if (Number(existing?.n || 0) > 0) {
        throw new RehearsalError('NOT_EMPTY', 'The rehearsal only runs against an empty database: this one already holds delegated responsibilities.');
    }

    const started = Date.now();
    // The rehearsal's clock only moves forward: each periodic pass is a minute
    // after the last unless a journey needs a later one.
    let clock = started;
    const soon = (ms) => new Date(clock + ms);
    const journeys = [];
    const prompt = runs.promptVersion().label;

    /* ------------------------------------------------------------------ */
    /* Everything outside the installation, held in memory                 */
    /* ------------------------------------------------------------------ */

    const restore = [];
    const swap = (target, name, replacement) => {
        const own = Object.prototype.hasOwnProperty.call(target, name);
        const original = target[name];
        target[name] = replacement;
        restore.push(() => { if (own) target[name] = original; else delete target[name]; });
        return original;
    };

    const seen = { modelCalls: 0, searches: 0, lookups: 0, checks: 0, dms: [] };
    const model = { rounds: [] };
    let callNo = 0;
    const call = (name, args = {}) => ({ id: `rehearsal-${++callNo}`, name, arguments: JSON.stringify(args) });
    swap(aiService, 'chat', async () => {
        seen.modelCalls += 1;
        const next = model.rounds.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        if (next instanceof Error) throw next;
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
    swap(perplexity, 'search', async (query) => { seen.searches += 1; return `No results for "${query}".`; });
    const execute = toolsRegistry.execute;
    swap(toolsRegistry, 'execute', async function seededExecute(name, args) {
        if (name === 'lookupNotes') {
            seen.lookups += 1;
            return 'From the person\'s notes:\n\n"Ferry timetable": First crossing 07:30. Last crossing 19:00.';
        }
        return execute.call(this, name, args);
    });
    const files = new Map();
    const notFound = () => Object.assign(new Error('No such file.'), { code: 'NOT_FOUND', status: 404 });
    swap(projects, 'readWorkspaceFile', async ({ slug, relativePath }) => {
        const key = `${slug}/${relativePath}`;
        if (!files.has(key)) throw notFound();
        const bytes = Buffer.from(files.get(key));
        return { relativePath, name: path.basename(relativePath), mime: 'text/markdown', bytes, size: bytes.length };
    });
    swap(projects, 'writeWorkspaceFile', async ({ slug, relativePath, bytes }) => {
        files.set(`${slug}/${relativePath}`, Buffer.from(bytes).toString('utf8'));
        return { relativePath };
    });
    swap(followedSources, 'fetch', async () => {
        seen.checks += 1;
        return { status: 200, text: '<html><body><main><h1>Ferry timetable</h1><p>Winter timetable: first crossing 07:10.</p></main></body></html>', headers: {} };
    });
    delivery.attach({
        gateway: {
            isGoobsterGateway: true,
            kind: 'local',
            sendDm: async (userId, message) => { seen.dms.push({ userId, message }); return { ok: true }; }
        }
    });
    restore.push(() => delivery.detach());

    /** One pass of the runner with the model following `rounds`. */
    async function tick(...rounds) {
        model.rounds = [...rounds];
        try {
            const out = await runner.tick({ wait: true });
            return { ...out, first: out.results?.[0] || null };
        } finally {
            model.rounds = [];
        }
    }
    const finish = (title, summary, outcome = 'finding') => [call('finish', { outcome, title, summary })];

    /* ------------------------------------------------------------------ */
    /* Small readers                                                       */
    /* ------------------------------------------------------------------ */

    const initiativeRow = (id) => db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id: Number(id) });
    const runRows = (initiativeId) => db.all('SELECT * FROM assistant_runs WHERE initiativeId = @id ORDER BY id', { id: Number(initiativeId) });
    const journal = (runId) => db.all(
        'SELECT tool, operation, resourceKind, effect, status, refusalCode, resultText FROM assistant_run_operations WHERE runId = @id ORDER BY id',
        { id: Number(runId) }
    );
    const noteRow = (id) => db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: Number(id) });
    const listUpdates = async (userId) => (await updates.list({ userId, limit: 100 })).updates;
    const needsYou = async (userId) => Number((await inbox.list({ userId, view: 'needs_you', limit: 50 })).needsYou);
    /** The steward's periodic pass, as the running installation makes it every five minutes. */
    const sweep = async (ms = 60000) => {
        clock += ms;
        const result = await steward.sweep({ now: new Date(clock), retention: false });
        if (result.skipped) throw new RehearsalError('PASS_SKIPPED', `The periodic pass did not run (${result.reason}).`);
        return result;
    };
    let lastSeen = 0;
    /** One periodic pass, and the work it newly proposed under `grant`. */
    const look = async (grant) => {
        const result = await sweep();
        const rows = await db.all(
            "SELECT id FROM assistant_initiatives WHERE responsibilityId = @rid AND id > @after AND status = 'CANDIDATE' ORDER BY id",
            { rid: grant.id, after: lastSeen }
        );
        const newest = await db.get('SELECT MAX(id) AS id FROM assistant_initiatives', {});
        lastSeen = Number(newest?.id || 0);
        return { proposed: rows.map(row => Number(row.id)), pass: result };
    };
    const queue = async (userId, id) => {
        const current = await initiatives.get({ userId, id });
        return (await initiatives.act({ userId, id, action: 'queue', expectedRevision: current.revision })).initiative;
    };
    const delegate = async (userId, body) => {
        const { responsibility } = await responsibilities.create({ userId, body });
        return (await responsibilities.act({
            userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision
        })).responsibility;
    };
    const cardFor = (userId, updateId) => gates.card({ userId, ref: String(updateId) });
    const decide = async (userId, updateId, option, card = null) => {
        const shown = card || await cardFor(userId, updateId);
        return gates.decide({ userId, ref: String(updateId), option, occurrence: shown.occurrence, revision: shown.revision, surface: 'home' });
    };
    const refused = async (work) => {
        try { await work(); return null; } catch (error) { return error?.code || error?.message || 'ERROR'; }
    };

    async function journey(id, work) {
        const record = { ...JOURNEYS.find(entry => entry.id === id), checks: [], notCovered: [] };
        const check = (name, ok, detail = null) => {
            record.checks.push({ name, ok: Boolean(ok), ...(ok || detail == null ? {} : { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }) });
            return Boolean(ok);
        };
        try {
            await work({ check, skip: (what) => record.notCovered.push(what) });
        } catch (error) {
            check('the journey ran to its end', false, `${error?.code || error?.name || 'Error'}: ${String(error?.message || error).slice(0, 300)}`);
        }
        record.ok = record.checks.length > 0 && record.checks.every(entry => entry.ok);
        journeys.push(record);
        if (onJourney) onJourney(record);
        return record;
    }

    /* ------------------------------------------------------------------ */
    /* The pilot's world: one owner, one project, three responsibilities   */
    /* ------------------------------------------------------------------ */

    const world = {};
    let outcomeSummary = null;

    try {
        // Discord-shaped ids, so the digest has a channel to go out on (the fake gateway).
        const owner = '960000000000000001';
        const member = '960000000000000002';
        await identity.ensureLegacyPrincipal({ discordId: owner, displayName: 'Pilot owner' });
        await identity.grantAccount({ principalId: owner, entitlement: 'bootstrap', role: 'operator' });
        await identity.ensureLegacyPrincipal({ discordId: member, displayName: 'Collaborator' });
        await identity.grantAccount({ principalId: member, entitlement: 'bootstrap', role: 'member' });
        await policies.enroll({ userId: owner, initiative: 'assist' });
        await policies.enroll({ userId: member, initiative: 'assist' });
        await instanceState.set(steward.HEARTBEAT_KEY, { at: new Date().toISOString() });
        const scope = `dm:${owner}`;
        const projectId = Number(await db.insert(
            "INSERT INTO observatory_projects (userId, slug, name) VALUES (@owner, 'crossing', 'Island crossing')", { owner }
        ));
        const readProject = { operation: 'read', resource: { kind: 'project', ids: [String(projectId)] } };
        Object.assign(world, { owner, member, scope, projectId });

        const automation = async (name, { nextRunIn = 20 * HOUR } = {}) => {
            const id = Number(await db.insert(
                `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
                 VALUES (@owner, @scope, @channel, @name, 'rehearsal', '0 3 * * *', @nextRun)`,
                { owner, scope, channel: `inbox:${owner}`, name, nextRun: utc(soon(nextRunIn)) }
            ));
            return { kind: 'automation', id, ref: `automation:${id}`, name };
        };
        let fires = 0;
        const ran = async (item, outcome, { code = null, at = new Date(), key = null } = {}) => {
            fires += 1;
            await processes.record({
                processKind: item.kind, processId: item.id, ownerUserId: owner, occurrenceKey: key || `fire:r${fires}`,
                phase: item.kind === 'followed_source' ? 'execution' : 'outcome', outcome, reasonCode: code, observedAt: at
            });
            if (item.kind === 'automation') {
                await db.run('UPDATE automations SET nextRun = @next WHERE id = @id', { id: item.id, next: utc(new Date(at.getTime() + 20 * HOUR)) });
            }
        };
        const failing = async (item, code) => {
            if (item.kind === 'followed_source') {
                for (const back of [2, 1, 0]) {
                    const at = soon(-back * DAY - 2 * HOUR);
                    await ran(item, 'failed', { code, at, key: `day:${utc(at).slice(0, 10)}` });
                }
                return;
            }
            for (const hours of [3, 2, 1]) await ran(item, 'failed', { code, at: soon(-hours * HOUR) });
            await db.run('UPDATE automations SET nextRun = @next WHERE id = @id', { id: item.id, next: utc(soon(20 * HOUR)) });
        };
        const repairOf = (item) => db.get(
            'SELECT * FROM assistant_process_repairs WHERE processKind = @kind AND processId = @id ORDER BY id DESC LIMIT 1',
            { kind: item.kind, id: String(item.id) }
        );
        const processUpdate = (item, prefix) => db.get(
            'SELECT * FROM assistant_updates WHERE audienceUserId = @owner AND identityKey = @key', { owner, key: `${prefix}:${item.ref}` }
        );
        const stageOf = (item) => db.get(
            'SELECT * FROM assistant_process_lifecycle WHERE processKind = @kind AND processId = @id', { kind: item.kind, id: String(item.id) }
        );
        const automationRow = (item) => db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id: item.id });

        /* -------------------------------------------------------------- */
        /* A. A source change improves knowledge and project state         */
        /* -------------------------------------------------------------- */

        await journey('A', async ({ check }) => {
            const note = await kg.createUserNote({
                guildId: scope, userId: owner, label: 'Ferry timetable', content: 'First crossing 07:30. Last crossing 19:00.'
            });
            const sourceId = Number(await db.insert(
                `INSERT INTO followed_sources (userId, projectId, url, label, kind, initialized)
                 VALUES (@owner, @projectId, 'https://rehearsal.invalid/ferry-news', 'Ferry operator news', 'feed', 1)`,
                { owner, projectId }
            ));
            let entryNo = 0;
            const entry = async (title, text, kept) => {
                entryNo += 1;
                return Number(await db.insert(
                    `INSERT INTO followed_source_entries (sourceId, entryKey, url, title, contentHash, extractedText, isChange, kept)
                     VALUES (@sourceId, @key, @url, @title, @hash, @text, 1, @kept)`,
                    {
                        sourceId, key: `rehearsal-${entryNo}`, url: `https://rehearsal.invalid/ferry-news/${entryNo}`,
                        title, hash: `rehearsal-hash-${entryNo}`, text, kept: kept ? 1 : 0
                    }
                ));
            };
            const keep = (id) => db.run('UPDATE followed_source_entries SET kept = 1 WHERE id = @id', { id });
            await entry('Summer timetable confirmed', 'The summer timetable is unchanged.', true);

            const grant = await delegate(owner, {
                title: 'Keep what I know about the crossing current',
                outcome: 'My notes and the project say what the operator currently publishes.',
                projectId,
                scopes: { sources: ['followed_source'] },
                rules: { interruption: 'digest' },
                operations: [
                    readProject,
                    { operation: 'read', resource: { kind: 'process', ids: [`followed_source:${sourceId}`] } },
                    { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } },
                    { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } },
                    { operation: 'kg.saved.propose', resource: { kind: 'knowledge', ids: ['personal'] } },
                    { operation: 'file.edit', resource: { kind: 'project', ids: [String(projectId)], paths: ['docs'] } }
                ]
            });
            Object.assign(world, { knowledge: grant, note, sourceId, entry, keep });

            const first = await look(grant);
            check('what the person kept before delegating is history, not work', first.proposed.length === 0, first);

            const fresh = await entry('Winter timetable from 4 January', 'From 4 January the first crossing is 07:10 and the last is 18:40.', false);
            const unkept = await look(grant);
            check('a change the person has not kept proposes nothing', unkept.proposed.length === 0, unkept);
            await keep(fresh);
            const kept = await look(grant);
            if (!check('keeping the change proposes one piece of work', kept.proposed.length === 1, kept)) return;
            const [id] = kept.proposed;
            check('proposed work waits for the person to start it', (await initiativeRow(id)).status === 'CANDIDATE');
            await queue(owner, id);

            const out = await tick(
                [call('lookupNotes', { query: 'ferry timetable' })],
                [call('addGeneratedNote', { title: 'Winter ferry timetable 2027', content: 'From 4 January the first crossing is 07:10 and the last is 18:40.' })],
                [call('proposeNoteChange', {
                    id: note.id, revision: note.revision, content: 'First crossing 07:10. Last crossing 18:40.',
                    rationale: 'The operator published the winter timetable.'
                })],
                [call('writeProjectFile', { path: 'docs/timetable.md', content: '# Timetable\nWinter: first 07:10, last 18:40.\n' })],
                finish('The winter timetable starts on 4 January', 'First crossing 07:10, last 18:40. Source: Ferry operator news.')
            );
            check('the run completes with a finding', out.first?.status === 'COMPLETED', out.first);
            const [run] = await runRows(id);
            const calls = run ? await journal(run.id) : [];
            check('every tool call is in the journal as succeeded', calls.length === 5 && calls.every(row => row.status === 'SUCCEEDED'),
                calls.map(row => `${row.tool}:${row.status}`));
            const generated = await db.get("SELECT COUNT(*) AS n FROM kg_nodes WHERE guildId = @scope AND curation <> 'saved'", { scope });
            check('a generated note was added', Number(generated.n) === 1, generated);
            check('the project file was written inside the granted folder', files.get('crossing/docs/timetable.md')?.includes('07:10'));
            const untouched = await noteRow(note.id);
            check('the saved note is untouched until the person decides', untouched.content === 'First crossing 07:30. Last crossing 19:00.' && untouched.revision === note.revision);
            const sets = await db.all('SELECT * FROM kg_change_sets WHERE userId = @owner ORDER BY id', { owner });
            check('one change to the saved note is proposed', sets.length === 1 && sets[0].status === 'PROPOSED', sets.map(set => set.status));

            // The request is filed in the Inbox by the next periodic pass.
            await sweep();
            const mine = (await listUpdates(owner)).filter(update => update.initiativeId === id);
            const finding = mine.find(update => update.kind === 'finding');
            check('the run is reported as one finding', mine.filter(update => update.kind === 'finding').length === 1, mine.map(update => update.kind));
            check('one request is waiting in Needs you', await needsYou(owner) === 1);
            if (finding) await updates.acknowledge({ userId: owner, items: [{ id: finding.id, revision: finding.revision }] });
            const view = await home.project({ userId: owner, now: soon(0) });
            check('reading the finding does not answer the request', view.counts.needsAction === 1 && view.needsYou.length === 1, view.counts);

            const card = await cardFor(owner, sets[0]?.updateId);
            check('the request shows what would change', card?.kind === 'note_proposal' && Array.isArray(card.diff) && card.diff.length > 0);
            await decide(owner, sets[0].updateId, 'apply', card);
            const applied = await noteRow(note.id);
            check('applying it changes the saved note once', applied.content === 'First crossing 07:10. Last crossing 18:40.' && applied.revision === note.revision + 1);
            check('a second press is refused as settled', await refused(() => decide(owner, sets[0].updateId, 'apply', card)) === 'STALE_GATE');
            check('nothing is left in Needs you', await needsYou(owner) === 0);
            const again = await look(grant);
            check('looking at the same change again proposes nothing', again.proposed.length === 0, again);
            world.noteRevision = applied.revision;
        });

        /* -------------------------------------------------------------- */
        /* B. A conversation becomes authorized progress                   */
        /* -------------------------------------------------------------- */

        await journey('B', async ({ check }) => {
            const conversation = await parlor.ensureProjectConversation({
                project: { id: projectId, ownerId: owner, name: 'Island crossing' }, members: []
            });
            const say = async (content) => (await parlor.postMessage({
                userId: owner, userName: 'Pilot owner', conversationId: conversation.id, content, notify: false
            })).id;
            const plan = { userId: owner, project: 'crossing' };
            await missions.create({
                ...plan,
                title: 'Plan the winter crossing',
                objective: 'Decide which crossings to book for the winter.',
                successCriteria: ['A written comparison of the crossings exists'],
                steps: [{ kind: 'agent', title: 'Write the comparison', actionParams: { artifacts: ['docs/comparison.md'] } }]
            });
            await say('Goobster, can you look up the harbour parking prices?');

            const grant = await delegate(owner, {
                title: 'Carry the crossing plan forward',
                outcome: 'Approved plan steps get done and what I ask for in the project gets looked into.',
                projectId,
                scopes: { sources: ['project_chat'] },
                operations: [
                    readProject,
                    { operation: 'file.edit', resource: { kind: 'project', ids: [String(projectId)], paths: ['docs'] } },
                    { operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(projectId)] } }
                ]
            });
            world.work = grant;
            world.say = say;
            world.conversationId = conversation.id;
            const open = () => db.all(
                "SELECT * FROM assistant_initiatives WHERE responsibilityId = @id AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING') ORDER BY id", { id: grant.id }
            );
            await look(grant);
            check('a plan nobody approved and a request made before delegating propose nothing', (await open()).length === 0, await open());

            const unconfirmed = await refused(() => missions.approve(plan));
            check('the plan cannot be approved without the person\'s own confirmation', unconfirmed === 'HUMAN_ONLY', String(unconfirmed));
            const receipt = await missions.mintApprovalReceipt({ ...plan, origin: 'portal' });
            await missions.approve({ ...plan, receiptId: receipt.id, nonce: receipt.nonce });
            const startedPlan = await missions.start(plan);
            const stepId = startedPlan.steps[0].id;
            await look(grant);
            const proposed = await open();
            if (!check('approving and starting the plan proposes its assistant step', proposed.length === 1 && proposed[0].sourceKind === 'project_plan_step', proposed.map(row => row.sourceKind))) return;
            await queue(owner, proposed[0].id);

            const out = await tick(
                [call('writeProjectFile', { path: 'docs/comparison.md', content: '# Crossings\nThe 07:10 leaves time for the connection.\n' })],
                [call('reportStepResult', {
                    outcome: 'done', title: 'Wrote the comparison', summary: 'Compared the morning crossings.',
                    artifacts: ['docs/comparison.md'], criteria: ['c1']
                })]
            );
            check('the step run completes', out.first?.status === 'COMPLETED', out.first);
            const step = await db.get('SELECT * FROM project_mission_steps WHERE id = @id', { id: stepId });
            check('the step is done under delegated authority, with its artifact verified', step.status === 'DONE' && step.authorizationKind === 'delegated'
                && files.has('crossing/docs/comparison.md'), { status: step.status, authorizationKind: step.authorizationKind });
            const mission = await db.get('SELECT status FROM project_missions WHERE id = @id', { id: step.missionId });
            check('the plan moves to review, not to done on the assistant\'s word', mission.status === 'REVIEW', mission);
            const evidence = await db.get('SELECT COUNT(*) AS n FROM project_mission_evidence WHERE missionId = @id', { id: step.missionId });
            check('evidence is linked to the plan', Number(evidence.n) >= 1, evidence);
            // The plan's review is the person's: the next pass files it in Needs you, and only they complete it.
            await sweep();
            const review = (await inbox.list({ userId: owner, view: 'needs_you', limit: 10 })).items;
            check('the plan\'s review is filed in Needs you', review.length === 1 && review[0].update?.gate?.kind === 'project_review', review.map(item => item.title));
            const done = await missions.mintApprovalReceipt({ ...plan, origin: 'portal', kind: 'complete' });
            await missions.complete({ ...plan, verdict: 'met', notes: 'Rehearsal.', receiptId: done.id, nonce: done.nonce });
            const settled = await sweep();
            check('completing the plan as the person settles that request', settled.gates.resolved === 1 && await needsYou(owner) === 0, settled.gates);

            await say('We should compare the two harbours some time.');
            const remark = await look(grant);
            check('a remark that asks for nothing proposes nothing', remark.proposed.length === 0, remark);
            await say('Goobster, can you compare the two harbours for parking?');
            const asked = await look(grant);
            if (!check('asking in the project conversation proposes one piece of work', asked.proposed.length === 1, asked)) return;
            await say('Goobster, can you compare the two harbours for parking?');
            const twice = await look(grant);
            check('asking the same thing again while it is open does not duplicate it', twice.proposed.length === 0, twice);
            await queue(owner, asked.proposed[0]);
            const answered = await tick(finish('North harbour is cheaper to park at', 'North harbour: 4 a day. South harbour: 9 a day.'));
            check('the request is answered once', answered.first?.status === 'COMPLETED' && answered.started === 1, answered.first);

            await say('Goobster, please research winter storm cancellations');
            const next = await look(grant);
            if (!check('a second request is proposed', next.proposed.length === 1, next)) return;
            const steerId = await say('Goobster, never mind');
            const steered = await look(grant);
            const stopped = await initiativeRow(next.proposed[0]);
            check('changing direction stops the open request and proposes nothing new', steered.proposed.length === 0
                && stopped.status === 'SUPERSEDED' && stopped.stopCode === 'STEERED'
                && stopped.supersededBy === `parlor:${conversation.id}:${steerId}`, { status: stopped.status, stopCode: stopped.stopCode });
            const told = (await listUpdates(owner)).find(update => /^Changed direction: 1 request stopped/.test(update.title));
            check('the person is told what was stopped', Boolean(told));
            const idle = await tick();
            check('nothing stopped is run afterwards', idle.started === 0, idle);
        });

        /* -------------------------------------------------------------- */
        /* C. A broken import is repaired or escalated                     */
        /* -------------------------------------------------------------- */

        await journey('C', async ({ check }) => {
            const imported = await automation('Nightly import');
            const exported = await automation('Weekly export');
            const topicId = Number(await db.insert(
                "INSERT INTO kg_nodes (guildId, scopeKey, type, label, curation) VALUES (@scope, @key, 'concept', 'Ferry timetable page topic', 'saved')",
                { scope, key: `USER:${owner}` }
            ));
            const pageId = Number(await db.insert(
                `INSERT INTO followed_sources (userId, topicNodeId, url, label, kind, initialized, lastHash, lastText, lastCheckedAt)
                 VALUES (@owner, @topicId, 'https://rehearsal.invalid/timetable', 'Ferry timetable page', 'page', 1, 'rehearsal-baseline', 'The page as last fetched.', @checked)`,
                { owner, topicId, checked: utc(soon(-2 * HOUR)) }
            ));
            const page = { kind: 'followed_source', id: pageId, ref: `followed_source:${pageId}`, name: 'Ferry timetable page' };
            await processes.putContract({ userId: owner, kind: 'followed_source', id: pageId, body: { purpose: 'Tell me when the timetable changes' } });
            Object.assign(world, { imported, exported, page });

            await policies.setBoundary({ userId: owner, category: 'schedule', proactiveCompute: true });
            const grant = await delegate(owner, {
                title: 'Keep my recurring work running',
                outcome: 'What I rely on keeps running, and what no longer matters is paused.',
                budgets: { repairAttempts: 1 },
                operations: [{ operation: 'process.repair', resource: { kind: 'process', ids: [page.ref] } }]
            });
            world.upkeep = grant;

            // Outside the grant: three failures open an incident and a repair is offered, not made.
            await failing(imported, 'PROVIDER_TIMEOUT');
            const opened = await sweep();
            check('three failed runs open one incident', opened.incidents.opened === 1, opened.incidents);
            const offered = await processUpdate(imported, 'process_repair');
            const offer = offered ? await cardFor(owner, offered.id) : null;
            check('outside any grant the repair is offered, with nothing changed', offer?.options?.map(option => option.id).join() === 'approve,decline'
                && (await repairOf(imported))?.status !== 'VERIFYING', offer?.options);
            await decide(owner, offered.id, 'approve', offer);
            check('approving it schedules one more run', (await repairOf(imported))?.status === 'VERIFYING', await repairOf(imported));
            await ran(imported, 'ok', { at: soon(60000) });
            await sweep(2 * 60000);
            check('a run that works is the verification', (await repairOf(imported))?.status === 'OBSERVING', (await repairOf(imported))?.status);

            // Inside the grant: the incident is work the responsibility takes.
            await failing(page, 'SOURCE_UNAVAILABLE');
            // One pass opens the incident; the next proposes the work.
            await sweep();
            const looked = await look(grant);
            if (!check('a failing process the grant names becomes proposed repair work', looked.proposed.length === 1, looked)) return;
            check('nothing is offered to the person for it', !(await processUpdate(page, 'process_repair'))?.gateJson);
            await queue(owner, looked.proposed[0]);
            const before = seen.checks;
            const repaired = await tick(
                [call('repairProcess', { action: 'rerun', diagnosis: 'The page was unreachable three days running; it may be back.' })],
                finish('Checked the timetable page again', 'It answered this time. Watching its next check.')
            );
            check('the repair run completes', repaired.first?.status === 'COMPLETED', repaired.first);
            const attempt = await repairOf(page);
            check('the repair is the assistant\'s, under the responsibility, and was checked once', attempt?.actorKind === 'assistant'
                && Number(attempt.responsibilityId) === grant.id && seen.checks === before + 1,
            { actorKind: attempt?.actorKind, status: attempt?.status, checks: seen.checks - before });
            await sweep();
            const verified = await repairOf(page);
            check('it is verified by the check that followed, not by the report', Boolean(verified?.verifiedAt) && ['OBSERVING', 'SUCCEEDED'].includes(verified.status),
                { status: verified?.status, verifiedAt: verified?.verifiedAt });
            const source = await db.get('SELECT url, enabled FROM followed_sources WHERE id = @id', { id: pageId });
            check('running it again changed nothing about the process', source.url === 'https://rehearsal.invalid/timetable' && Number(source.enabled) === 1, source);

            // A repair that does not work is escalated, never repeated.
            await failing(exported, 'PROVIDER_TIMEOUT');
            await sweep();
            const second = await processUpdate(exported, 'process_repair');
            await decide(owner, second.id, 'approve');
            await ran(exported, 'failed', { code: 'PROVIDER_TIMEOUT', at: soon(60000) });
            await sweep(2 * 60000);
            const failed = await repairOf(exported);
            check('a repair whose check fails is recorded as failed', failed?.status === 'FAILED' && failed.direction === 'asked',
                { status: failed?.status, direction: failed?.direction });
            const ask = await cardFor(owner, (await processUpdate(exported, 'process_repair')).id);
            check('the person is asked what to do instead of a second attempt', ask?.options?.map(option => option.id).join() === 'pause,leave', ask?.options);
            await decide(owner, ask.ref, 'pause', ask);
            check('choosing to pause it pauses it', Number((await automationRow(exported)).isEnabled) === 0, await automationRow(exported));
            check('nothing about repairs is left in Needs you', await needsYou(owner) === 0, await needsYou(owner));

            // The first repair is only called fixed once its next scheduled run has worked too.
            await ran(imported, 'ok', { at: soon(20 * HOUR) });
            await sweep(20 * HOUR + 60000);
            const held = await repairOf(imported);
            check('a repair is only called fixed once the next scheduled run works', held?.status === 'SUCCEEDED' && held.actorKind === 'person',
                { status: held?.status, actorKind: held?.actorKind });
        });

        /* -------------------------------------------------------------- */
        /* D. A quiet process is told apart from an obsolete one           */
        /* -------------------------------------------------------------- */

        await journey('D', async ({ check }) => {
            const monthly = await automation('Monthly harbour report', { nextRunIn: 9 * DAY });
            await ran(monthly, 'ok', { at: soon(-21 * DAY) });
            await db.run('UPDATE automations SET nextRun = @next WHERE id = @id', { id: monthly.id, next: utc(soon(9 * DAY)) });
            const watch = await automation('Booking window watch');
            const countdown = await automation('Launch countdown');
            let goals = 0;
            const purposeOver = async (item) => {
                goals += 1;
                const itemId = Number(await db.insert(
                    "INSERT INTO attention_items (guildId, userId, kind, subject, state) VALUES (@scope, @owner, 'goal', @subject, 'resolved')",
                    { scope, owner, subject: `rehearsal goal ${goals}` }
                ));
                await processes.putContract({ userId: owner, kind: item.kind, id: item.id, body: { purpose: 'Tell me when the booking window opens', attentionItemId: itemId } });
                await ran(item, 'ok', { at: soon(-HOUR) });
            };
            await purposeOver(watch);
            await purposeOver(countdown);
            const grant = await delegate(owner, {
                title: 'Pause recurring work that has served its purpose',
                operations: [{ operation: 'process.pause', resource: { kind: 'process', ids: [countdown.ref] } }]
            });
            world.tidy = grant;

            const judged = (await sweep()).incidents;
            const quiet = await processes.get({ userId: owner, kind: monthly.kind, id: monthly.id });
            check('a monthly job that has been quiet for three weeks is healthy', quiet.assessment.execution === 'healthy'
                && quiet.assessment.relevance !== 'retirement_candidate' && !quiet.incident, quiet.assessment);
            check('nothing is said about it', !(await processUpdate(monthly, 'process_relevance')) && !(await processUpdate(monthly, 'process_incident')));

            const asked = await processUpdate(watch, 'process_relevance');
            const card = asked ? await cardFor(owner, asked.id) : null;
            check('a working process whose purpose is over is asked about, not switched off', card?.options?.map(option => option.id).join() === 'pause,keep'
                && Number((await automationRow(watch)).isEnabled) === 1, card?.options);
            const paused = await stageOf(countdown);
            check('one the grant names is paused by the assistant, with nothing deleted', judged.paused === 1 && paused?.stage === 'PAUSED'
                && paused.actorKind === 'assistant' && Number(paused.responsibilityId) === grant.id
                && Number((await automationRow(countdown)).isEnabled) === 0, { paused: judged.paused, stage: paused?.stage, actorKind: paused?.actorKind });
            check('and says so without asking', (await processUpdate(countdown, 'process_relevance'))?.gateJson == null);

            await decide(owner, asked.id, 'keep', card);
            const quietAgain = (await sweep()).incidents;
            check('a process the person chose to keep is not asked about again', Number((await automationRow(watch)).isEnabled) === 1
                && quietAgain.relevance === 0 && await needsYou(owner) === 0, quietAgain);

            const act = (item, action) => lifecycle.act({ userId: owner, kind: item.kind, id: item.id, action });
            const resumed = await act(countdown, 'resume');
            check('the person can resume what the assistant paused', resumed.process.enabled === true, resumed.process);
            const left = (await sweep()).incidents;
            check('and it is left alone afterwards', left.paused === 0 && Number((await automationRow(countdown)).isEnabled) === 1, left);
            await act(watch, 'pause');
            const archived = await act(watch, 'archive');
            const restored = await act(watch, 'restore');
            const definition = await db.get('SELECT name, promptText, schedule FROM automations WHERE id = @id', { id: watch.id });
            check('archive then restore keeps the definition and leaves it paused', archived.lifecycle.stage === 'archived'
                && restored.lifecycle.stage === 'paused' && restored.process.enabled === false && definition.schedule === '0 3 * * *',
            { archived: archived.lifecycle.stage, restored: restored.lifecycle.stage });
        });

        /* -------------------------------------------------------------- */
        /* E. Authority, concurrency and partial availability              */
        /* -------------------------------------------------------------- */

        await journey('E', async ({ check }) => {
            const { knowledge, note, entry, keep } = world;
            const { work, say } = world;
            const ask = async (text) => {
                await say(text);
                const [id] = (await look(work)).proposed;
                return id;
            };

            // A note the person edited since is never overwritten, and a call outside the grant is refused.
            const added = await entry('Easter sailings added', 'Two extra sailings on Easter Monday.', false);
            await look(knowledge);
            await keep(added);
            const [first] = (await look(knowledge)).proposed;
            if (!check('another kept change proposes more work', Boolean(first))) return;
            await queue(owner, first);
            const edited = await kg.updateUserNote({ guildId: scope, userId: owner, nodeId: note.id, content: 'First crossing 07:10. Last crossing 18:40. Book ahead.' });
            const searchesBefore = seen.searches;
            const out = await tick(
                [call('searchWeb', { query: 'easter ferry sailings' })],
                [call('proposeNoteChange', { id: note.id, revision: world.noteRevision, content: 'Overwritten.', rationale: 'Easter sailings.' })],
                [call('proposeNoteChange', {
                    id: note.id, revision: edited.revision, content: 'First crossing 07:10. Last crossing 18:40. Book ahead. Two extra sailings on Easter Monday.',
                    rationale: 'Easter sailings.'
                })],
                finish('Two extra sailings on Easter Monday', 'Proposed adding them to your timetable note.')
            );
            const [run] = await runRows(first);
            const calls = run ? await journal(run.id) : [];
            const search = calls.find(row => row.tool === 'searchWeb');
            check('a search the grant does not cover is refused before anything is sent', search?.status === 'REFUSED' && Boolean(search.refusalCode)
                && seen.searches === searchesBefore, { status: search?.status, refusalCode: search?.refusalCode });
            const stale = calls.filter(row => row.tool === 'proposeNoteChange')[0];
            check('a proposal against an old revision of the note is not filed', /^Not proposed: the note changed since you read it/.test(stale?.resultText || ''), stale?.resultText);
            const sets = await db.all("SELECT * FROM kg_change_sets WHERE userId = @owner AND status = 'PROPOSED' ORDER BY id", { owner });
            check('the run still completes, with one proposal against the current note', out.first?.status === 'COMPLETED' && sets.length === 1
                && Number(sets[0].expectedRevision) === Number(edited.revision), { status: out.first?.status, proposals: sets.length });
            check('the person\'s edit stands', (await noteRow(note.id)).content === 'First crossing 07:10. Last crossing 18:40. Book ahead.');
            world.openProposal = sets[0] || null;

            // Two passes at once start a piece of work once.
            const second = await ask('Goobster, can you check whether there is a fuel surcharge this winter?');
            if (!check('a request in the project conversation is proposed', Boolean(second))) return;
            await queue(owner, second);
            model.rounds = [finish('A fuel surcharge starts in March', '2 per crossing, from the operator\'s notice.')];
            const both = await Promise.all([runner.tick({ wait: true }), runner.tick({ wait: true })]);
            model.rounds = [];
            const startedOnce = both.reduce((total, pass) => total + Number(pass.started || 0), 0);
            check('two runner passes at once start the work once', startedOnce === 1 && (await runRows(second)).length === 1,
                { started: startedOnce, runs: (await runRows(second)).length });

            // A provider that is not there parks the work; it is not a failure and nothing else stops.
            const third = await ask('Goobster, please look into the harbour works planned for April');
            if (!check('another request is proposed', Boolean(third))) return;
            await queue(owner, third);
            const parked = await tick(Object.assign(new Error('No AI provider is configured'), { code: 'NO_PROVIDER' }));
            const waiting = await initiativeRow(third);
            check('with no provider the work waits instead of failing', waiting.status === 'WAITING' && waiting.waitReason === 'dependency'
                && waiting.stopCode === 'NO_PROVIDER', { run: parked.first, status: waiting.status, waitReason: waiting.waitReason, stopCode: waiting.stopCode });
            const view = await home.project({ userId: owner, now: soon(0) });
            check('Home still answers while that work waits', view.availability === 'ready', { availability: view.availability, partial: view.partial });
            // An hour on the provider is back: the periodic pass queues the work again and it runs.
            const back = await sweep(HOUR + 60000);
            const retried = await tick(finish('The north car park is closed in April', 'From the harbour authority\'s notice.'));
            check('once the provider is back the work is queued again and completes', back.requeued === 1 && retried.first?.status === 'COMPLETED'
                && (await initiativeRow(third)).status !== 'WAITING', { requeued: back.requeued, run: retried.first });

            // A model call is never the person's confirmation.
            const { responsibility: draft } = await responsibilities.create({
                userId: owner, body: { title: 'Read my notes', operations: [{ operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } }] }
            });
            const byModel = await refused(() => modelCallScope.run('rehearsal:activate', () => responsibilities.act({
                userId: owner, id: draft.id, action: 'activate', expectedRevision: draft.revision
            })));
            check('a model call cannot activate a responsibility', byModel === 'HUMAN_ONLY', byModel);
            await responsibilities.act({ userId: owner, id: draft.id, action: 'archive', expectedRevision: draft.revision }).catch(() => {});

            // Losing access to a project stops queued work from reading or publishing there.
            const sharedId = Number(await db.insert(
                "INSERT INTO observatory_projects (userId, slug, name) VALUES (@owner, 'shared', 'Shared crossing')", { owner }
            ));
            await db.run(
                "INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@sharedId, @member, 'Collaborator', @owner)",
                { sharedId, member, owner }
            );
            const plan = { userId: owner, project: 'shared' };
            await missions.create({
                ...plan, title: 'Book the group crossing', objective: 'Book for six.', successCriteria: ['A booking summary exists'],
                steps: [{ kind: 'agent', title: 'Write the booking summary', actionParams: { artifacts: ['docs/booking.md'] } }]
            });
            const receipt = await missions.mintApprovalReceipt({ ...plan, origin: 'portal' });
            await missions.approve({ ...plan, receiptId: receipt.id, nonce: receipt.nonce });
            await missions.start(plan);
            const theirs = await delegate(member, {
                title: 'Carry the group booking forward',
                projectId: sharedId,
                operations: [
                    { operation: 'read', resource: { kind: 'project', ids: [String(sharedId)] } },
                    { operation: 'file.edit', resource: { kind: 'project', ids: [String(sharedId)], paths: ['docs'] } },
                    { operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(sharedId)] } }
                ]
            });
            const [step] = await db.all("SELECT id FROM assistant_initiatives WHERE responsibilityId = @id AND status = 'CANDIDATE'", { id: theirs.id });
            if (!check('a collaborator can delegate a step of a shared plan', Boolean(step))) return;
            await queue(member, step.id);
            await db.run('DELETE FROM project_members WHERE projectId = @sharedId AND userId = @member', { sharedId, member });
            const modelBefore = seen.modelCalls;
            const lost = await tick(
                [call('writeProjectFile', { path: 'docs/booking.md', content: 'Booked.' })],
                [call('reportStepResult', { outcome: 'done', title: 'Booked', summary: 'Booked for six.', artifacts: ['docs/booking.md'], criteria: ['c1'] })]
            );
            const blocked = await initiativeRow(step.id);
            check('once they lose access their queued work reads and writes nothing there', blocked.status === 'WAITING' && blocked.waitReason === 'access'
                && !files.has('shared/docs/booking.md') && seen.modelCalls === modelBefore,
            { run: lost.first, status: blocked.status, waitReason: blocked.waitReason, stopCode: blocked.stopCode });
        });

        /* -------------------------------------------------------------- */
        /* F. Review and delivery stay consistent                          */
        /* -------------------------------------------------------------- */

        await journey('F', async ({ check }) => {
            const { knowledge } = world;
            const publish = (summary) => updates.publish({
                audience: { userId: owner }, identityKey: 'rehearsal:storm-watch', kind: 'finding', title: 'Storm warning for Thursday',
                summary, components: ['research'], responsibilityId: knowledge.id, deliver: true
            });
            const one = await publish('Crossings may be cancelled on Thursday.');
            const two = await publish('Crossings may be cancelled on Thursday and Friday.');
            check('news that changes is one update at a new revision, not two updates', two.update.id === one.update.id && two.update.revision === one.update.revision + 1,
                { first: one.update.revision, second: two.update.revision });
            const mirrored = await db.all(
                "SELECT id FROM inbox_items WHERE userId = @owner AND sourceType = 'assistant_update' AND sourceId LIKE @prefix", { owner, prefix: `${one.update.id}:%` }
            );
            check('and one Inbox item', mirrored.length === 1, mirrored.length);
            await updates.acknowledge({ userId: owner, items: [{ id: one.update.id, revision: one.update.revision }] });
            const afterOld = (await listUpdates(owner)).find(update => update.id === one.update.id);
            check('acknowledging the old revision leaves the new one unread', afterOld.unseen === true, { unseen: afterOld.unseen });
            await updates.acknowledge({ userId: owner, items: [{ id: two.update.id, revision: two.update.revision }] });
            const afterNew = (await listUpdates(owner)).find(update => update.id === one.update.id);
            check('acknowledging the current revision reads it', afterNew.unseen === false, { unseen: afterNew.unseen });
            const same = await publish('Crossings may be cancelled on Thursday and Friday.');
            check('saying the same thing again changes nothing', same.changed === false && same.update.revision === two.update.revision, { changed: same.changed });

            const view = await home.project({ userId: owner, now: soon(0) });
            const page = await inbox.list({ userId: owner, view: 'needs_you', limit: 50 });
            const unseen = (await listUpdates(owner)).filter(update => update.unseen).length;
            check('Home and the Inbox count the same requests', view.counts.needsAction === Number(page.needsYou), { home: view.counts.needsAction, inbox: page.needsYou });
            check('Home counts the same unread updates the list holds', view.counts.unseen === unseen, { home: view.counts.unseen, list: unseen });

            // One digest a day for a responsibility set to digest, through the fake gateway.
            // The day after everything so far, so no digest has gone out on it yet.
            const tomorrow = (hour, minute) => {
                const today = new Date(clock);
                return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1, hour, minute, 0));
            };
            await publish('Crossings may be cancelled from Thursday to Saturday.');
            const dmsBefore = seen.dms.length;
            const early = await delivery.sweep({ now: tomorrow(8, 59) });
            check('before the digest time nothing is sent', early.digests === 0 && seen.dms.length === dmsBefore, early);
            const sent = await delivery.sweep({ now: tomorrow(9, 1) });
            const digests = await db.all('SELECT * FROM assistant_digests WHERE userId = @owner', { owner });
            check('at the digest time one digest goes out as one Inbox item and one message', sent.digests === 1 && digests.length === 1
                && seen.dms.length === dmsBefore + 1, { sweep: sent, digests: digests.length, dms: seen.dms.length - dmsBefore });
            const later = await delivery.sweep({ now: tomorrow(20, 0) });
            check('and no second digest that day', later.digests === 0 && seen.dms.length === dmsBefore + 1, later);
        });

        /* -------------------------------------------------------------- */
        /* G. The Inbox is told apart from Needs you                       */
        /* -------------------------------------------------------------- */

        await journey('G', async ({ check }) => {
            const proposal = world.openProposal;
            if (!check('a request is still open from journey E', Boolean(proposal))) return;
            const all = await inbox.list({ userId: owner, view: 'all', limit: 100 });
            const waiting = await inbox.list({ userId: owner, view: 'needs_you', limit: 100 });
            check('the Inbox holds everything; Needs you holds only what waits on a decision', all.items.length > waiting.items.length
                && waiting.items.length === 1 && Number(waiting.needsYou) === 1, { all: all.items.length, needsYou: waiting.items.length });
            check('what is in Needs you is the request, with its decision', waiting.items[0]?.update?.gate?.kind === 'note_proposal', waiting.items[0]?.update?.gate);
            await inbox.markAllRead({ userId: owner });
            const afterRead = await inbox.list({ userId: owner, view: 'all', limit: 100 });
            check('marking everything read reads it', Number(afterRead.unread) === 0, { unread: afterRead.unread });
            check('and does not answer the request', await needsYou(owner) === 1 && (await home.project({ userId: owner, now: soon(0) })).counts.needsAction === 1);
            await decide(owner, proposal.updateId, 'reject');
            const set = await db.get('SELECT status FROM kg_change_sets WHERE id = @id', { id: proposal.id });
            check('dismissing the request settles it and empties Needs you', set.status === 'REJECTED' && await needsYou(owner) === 0, set);
            check('and the note is as the person left it', (await noteRow(world.note.id)).content === 'First crossing 07:10. Last crossing 18:40. Book ahead.');
        });

        /* -------------------------------------------------------------- */
        /* H. The host's controls, the pilot gate and the record           */
        /* -------------------------------------------------------------- */

        await journey('H', async ({ check, skip }) => {
            const { work, say } = world;

            // Stop everything: queued work stays queued and no model is called.
            await say('Goobster, can you check that the printed leaflet matches the winter timetable?');
            const [id] = (await look(work)).proposed;
            if (!check('there is queued work to stop', Boolean(id))) return;
            await queue(owner, id);
            await control.pauseAll();
            const modelBefore = seen.modelCalls;
            const stopped = await tick(finish('Should not run', 'Should not run.'));
            check('with delegated work stopped a runner pass starts nothing', stopped.skipped === 'paused' && Number(stopped.started || 0) === 0
                && seen.modelCalls === modelBefore && (await initiativeRow(id)).status === 'QUEUED', stopped);
            check('Home says the host has stopped it', (await home.project({ userId: owner, now: soon(0) })).hostPaused === true);
            await control.resumeAll();
            const resumed = await tick(finish('The leaflet matches the winter timetable', 'Nothing to change.', 'no_change'));
            check('resuming runs what was waiting', resumed.first?.status === 'COMPLETED' && (await initiativeRow(id)).status !== 'QUEUED', resumed.first);

            // The pilot gate: what is the owner's alone until the host decides otherwise.
            const gated = { title: 'Suggest changes to my notes', operations: [
                { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } },
                { operation: 'kg.saved.propose', resource: { kind: 'knowledge', ids: ['personal'] } }
            ] };
            const tryIt = async () => {
                const { responsibility } = await responsibilities.create({ userId: member, body: gated });
                return responsibilities.act({ userId: member, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision });
            };
            check('the owner holds every pilot capability', (await Promise.all(['conversation', 'sources', 'delivery', 'reach', 'repair'].map(name => access.allows(owner, name)))).every(Boolean));
            check('someone else does not', !(await access.allows(member, 'reach')) && !(await access.allows(member, 'repair')));
            const kept = await refused(tryIt);
            check('and cannot delegate a pilot-only operation', kept === 'PILOT_ONLY', kept);
            await access.recordDecision({ scope: 'everyone' });
            const opened = await refused(tryIt);
            check('recording the decision to open it lets them', opened === null && await access.allows(member, 'reach'), opened);
            await access.recordDecision({ scope: 'owner' });
            check('and recording the decision to keep it closes it again', !(await access.allows(member, 'reach')));

            // A change outside the installation: one append to the Notion page the grant names.
            let fake = null;
            try {
                fake = require(path.join(__dirname, '../../tests/helpers/fakeNotion')).createFakeNotion();
            } catch {
                skip('The Notion write: this checkout has no tests/helpers/fakeNotion.js to stand in for Notion.');
            }
            if (fake) {
                const notionService = require('@goobster/core/services/notionService');
                const pageId = 'a11ce000000000000000000000000001';
                const elsewhere = 'a11ce000000000000000000000000002';
                fake.allow('rehearsal-notion-token');
                fake.addPage({ id: pageId, title: 'Crossing plan', blocks: ['Summer: first crossing 07:30.'] });
                fake.addPage({ id: elsewhere, title: 'Somewhere else', blocks: ['Not part of the grant.'] });
                swap(notionService, '_request', fake.request);
                require('@goobster/core/services/assistant/connectors/notion').internals.forgetKinds();
                await policies.setInitiative(owner, 'delegate');
                await policies.setBoundary({ userId: owner, category: 'general', externalWrite: true });
                await db.run(
                    "INSERT INTO user_integrations (userId, provider, token, accountLabel) VALUES (@owner, 'notion', 'rehearsal-notion-token', 'Rehearsal workspace')",
                    { owner }
                );
                const goalId = Number(await db.insert(
                    "INSERT INTO attention_items (guildId, userId, kind, subject, goal, state) VALUES (@scope, @owner, 'goal', 'rehearsal-notion', 'Keep the shared plan current', 'active')",
                    { scope, owner }
                ));
                const outside = await delegate(owner, {
                    title: 'Keep the shared crossing plan current',
                    attentionItemId: goalId,
                    budgets: { externalOperations: 1 },
                    operations: [
                        { operation: 'read', resource: { kind: 'external', ids: [`notion:${pageId}`] } },
                        { operation: 'external.write', resource: { kind: 'external', ids: [`notion:${pageId}`] } }
                    ]
                });
                world.outside = outside;
                await db.run("UPDATE attention_items SET goal = 'Keep the shared plan current for winter' WHERE id = @id", { id: goalId });
                const [task] = (await look(outside)).proposed;
                if (check('a change to the linked goal proposes work for the Notion responsibility', Boolean(task))) {
                    await queue(owner, task);
                    const out = await tick(
                        [call('readConnector', { connector: 'notion', resource: pageId, operation: 'page', input: {} })],
                        [call('writeConnector', { connector: 'notion', resource: pageId, operation: 'append', input: { text: 'Winter: first crossing 07:10.' } })],
                        [call('writeConnector', { connector: 'notion', resource: elsewhere, operation: 'append', input: { text: 'Should not land.' } })],
                        [call('writeConnector', { connector: 'notion', resource: pageId, operation: 'append', input: { text: 'A second line.' } })],
                        finish('Added the winter times to the shared plan', 'One line appended to the Notion page.')
                    );
                    const [run] = await runRows(task);
                    const writes = (run ? await journal(run.id) : []).filter(row => row.tool === 'writeConnector');
                    const landed = fake.writes();
                    check('the run completes having written to the granted page once', out.first?.status === 'COMPLETED' && landed.length >= 1
                        && writes[0]?.status === 'SUCCEEDED', { run: out.first, writes: writes.map(row => `${row.status}:${row.refusalCode || ''}`) });
                    check('a write to a page the grant does not name is refused', writes[1]?.status === 'REFUSED', writes[1]);
                    check('a second write is refused once the limit on outside changes is spent', writes[2]?.status === 'REFUSED', writes[2]);
                    const texts = fake.texts(pageId);
                    check('what landed carries the reference the journal can be matched to', texts.includes('Winter: first crossing 07:10.')
                        && /^Goobster · ref [0-9a-f]{12}$/.test(texts[texts.length - 1]) && !texts.includes('A second line.')
                        && !fake.texts(elsewhere).includes('Should not land.'), texts);
                }
            }

            // The record: which prompt and model each run was given, and the outcome summary.
            const allRuns = await db.all(
                'SELECT r.promptVersion, r.provider, r.model FROM assistant_runs r JOIN assistant_initiatives i ON i.id = r.initiativeId WHERE i.ownerUserId = @owner', { owner }
            );
            check('every run records the prompt version it was given', allRuns.length > 0 && allRuns.every(row => row.promptVersion === prompt),
                [...new Set(allRuns.map(row => row.promptVersion))]);
            check('and the provider and model it was routed to', allRuns.every(row => row.provider && row.model), [...new Set(allRuns.map(row => `${row.provider}/${row.model}`))]);

            outcomeSummary = await outcomes.summarize({ userId: owner, days: 14, now: soon(DAY) });
            const by = (grant) => outcomeSummary.responsibilities.find(row => row.id === grant?.id);
            const knowledgeRow = by(world.knowledge);
            const workRow = by(world.work);
            const upkeepRow = by(world.upkeep);
            check('the outcome summary lists the three pilot responsibilities', Boolean(knowledgeRow && workRow && upkeepRow),
                outcomeSummary.responsibilities.map(row => row.title));
            check('verified progress is the plan step and the repair, nothing else', workRow?.verified.planSteps === 1 && upkeepRow?.verified.repairs === 1
                && knowledgeRow?.verified.total === 0, { work: workRow?.verified, upkeep: upkeepRow?.verified, knowledge: knowledgeRow?.verified });
            check('note proposals are counted by what the person decided', knowledgeRow?.notes.proposed === 2 && knowledgeRow.notes.applied === 1
                && knowledgeRow.notes.dismissed === 1, knowledgeRow?.notes);
            check('refused calls and withdrawn work are counted where they happened', knowledgeRow?.refusals.total === 1 && workRow?.work.withdrawn === 1,
                { refusals: knowledgeRow?.refusals, work: workRow?.work });
            if (world.outside) check('the outside change is counted against its responsibility', by(world.outside)?.changes.outside === 1, by(world.outside)?.changes);
            check('the summary names the prompt and what it does not measure', outcomeSummary.prompt === prompt
                && outcomeSummary.notMeasured.includes('usefulness'), { prompt: outcomeSummary.prompt, notMeasured: outcomeSummary.notMeasured });
            check('no model was paid for: the script made every call', outcomeSummary.totals.cost.tokens === 0, outcomeSummary.totals.cost);
        });
    } finally {
        for (const undo of restore.reverse()) {
            try { undo(); } catch { /* the original stays swapped out only if it was never ours */ }
        }
        try { await control.resumeAll(); } catch { /* nothing was stopped */ }
        try { initiatives.stopListening(); } catch { /* never listening */ }
    }

    const checks = journeys.flatMap(entry => entry.checks);
    return {
        ok: journeys.length === JOURNEYS.length && journeys.every(entry => entry.ok),
        prompt,
        journeys,
        checks: { total: checks.length, failed: checks.filter(entry => !entry.ok).length },
        notCovered: journeys.flatMap(entry => entry.notCovered),
        outcomes: outcomeSummary
    };
}

/** The rehearsal's record as text for a terminal. */
function format(result) {
    const lines = [];
    for (const entry of result.journeys) {
        lines.push(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.id}. ${entry.title}`);
        for (const item of entry.checks) {
            lines.push(`      ${item.ok ? 'ok  ' : 'FAIL'}  ${item.name}${item.ok || !item.detail ? '' : `\n              ${item.detail}`}`);
        }
        for (const note of entry.notCovered) lines.push(`      skip  ${note}`);
    }
    lines.push('');
    lines.push(`${result.checks.total - result.checks.failed} of ${result.checks.total} checks passed on prompt ${result.prompt}.`);
    if (result.outcomes) {
        lines.push('');
        lines.push('Outcome summary for the rehearsal\'s owner (what the Responsibilities page shows for a real pilot):');
        for (const row of result.outcomes.responsibilities) {
            lines.push(`  ${row.title}: runs completed ${row.runs.completed} of ${row.runs.total}, checked results ${row.verified.total}, `
                + `findings reported ${row.reported.findings}, requests ${row.requests.asked}, calls refused ${row.refusals.total}, tokens ${row.cost.tokens}`);
        }
    }
    return lines.join('\n');
}

module.exports = { JOURNEYS, RehearsalError, rehearse, format };
