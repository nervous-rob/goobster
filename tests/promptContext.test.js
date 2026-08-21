/**
 * Shared conversational prompt pack: depth heuristic, budgets, retrieval.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-prompt-context-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const kg = require('@goobster/core/services/knowledgeGraphService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const {
    classifyDepth,
    buildConversationalPrompt,
    retrieveNotes
} = require('@goobster/core/utils/chat/promptContext');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '910000000000000001';
const SCOPE = dmScopeId(USER);

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_edges');
    await db.run('DELETE FROM kg_nodes');
});

describe('classifyDepth', () => {
    test('keeps greetings and acks on the light path', () => {
        expect(classifyDepth('hey')).toBe('light');
        expect(classifyDepth('thanks!')).toBe('light');
        expect(classifyDepth('ok')).toBe('light');
        expect(classifyDepth('gm')).toBe('light');
    });

    test('treats ordinary questions as medium', () => {
        expect(classifyDepth("what's 2+2?")).toBe('medium');
        expect(classifyDepth('can you ping the lab?')).toBe('medium');
    });

    test('treats personal history cues as rich', () => {
        expect(classifyDepth('do you remember my homelab setup?')).toBe('rich');
        expect(classifyDepth('what did we decide last time about the deploy?')).toBe('rich');
    });
});

describe('buildConversationalPrompt', () => {
    test('light turns skip retrieved notes and stay small', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            type: 'fact',
            label: 'tea',
            content: 'Prefers Earl Grey',
            salience: 0.9,
            source: 'tool'
        });

        const { prompt, depth, retrievedChars } = await buildConversationalPrompt({
            mode: 'chat',
            basePrompt: 'You are Goobster.',
            query: 'hey',
            guildId: SCOPE,
            userId: USER,
            userName: 'Rob',
            botName: 'Goobster',
            isGuild: false
        });

        expect(depth).toBe('light');
        expect(retrievedChars).toBe(0);
        expect(prompt).not.toContain('Earl Grey');
        expect(prompt).toContain('HOW TO TALK');
        expect(prompt).toContain('lookupNotes');
        expect(prompt.length).toBeLessThan(1800);
    });

    test('rich turns include graph notes for the speaker', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            type: 'fact',
            label: 'homelab',
            content: 'Four Raspberry Pis',
            salience: 0.95,
            source: 'tool'
        });

        const { prompt, depth } = await buildConversationalPrompt({
            mode: 'chat',
            basePrompt: 'You are Goobster.',
            query: 'do you remember my homelab setup?',
            guildId: SCOPE,
            userId: USER,
            userName: 'Rob',
            botName: 'Goobster',
            isGuild: false
        });

        expect(depth).toBe('rich');
        expect(prompt).toContain('Four Raspberry Pis');
        expect(prompt).toContain('THINGS YOU ALREADY KNOW');
        expect(prompt).toContain('use naturally');
    });

    test('an unattended turn is told why it is happening', async () => {
        // Automations, watches, and the web portal all describe their own
        // situation. A watch's description carries the evidence it woke up
        // for, so this block has to reach the model - it was silently
        // dropped before, leaving those turns with no idea why they ran.
        const { prompt } = await buildConversationalPrompt({
            mode: 'chat',
            basePrompt: 'You are Goobster.',
            query: 'Inspect the run output and compare it against the hypothesis.',
            guildId: SCOPE,
            userId: USER,
            userName: 'Rob',
            botName: 'Goobster',
            isGuild: false,
            sourceDescription: 'A condition Rob asked you to watch for just happened.\n'
                + 'WHAT HAPPENED:\nObservatory job #7 finished with status COMPLETED.\n'
                + 'Tail of its output:\nlambda=0.38 absent'
        });

        expect(prompt).toContain('SITUATION:');
        expect(prompt).toContain('Observatory job #7');
        expect(prompt).toContain('lambda=0.38 absent');
        // The framing comes before the behavioural contract, so the model
        // knows the context of the request before it is told how to answer.
        expect(prompt.indexOf('SITUATION:')).toBeLessThan(prompt.indexOf('HOW TO TALK'));
    });

    test('an ordinary turn gains no situation block', async () => {
        const { prompt } = await buildConversationalPrompt({
            mode: 'chat',
            basePrompt: 'You are Goobster.',
            query: 'how are you?',
            guildId: SCOPE,
            userId: USER,
            userName: 'Rob',
            botName: 'Goobster',
            isGuild: false
        });
        expect(prompt).not.toContain('SITUATION:');
    });
});

describe('lookupNotes tool', () => {
    test('returns speaker notes for about=me', async () => {
        const scopeKey = kg.resolveScopeKey({ subjectType: 'USER', subjectId: USER });
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey,
            type: 'fact',
            label: 'tea',
            content: 'Prefers Earl Grey',
            salience: 0.9,
            source: 'tool'
        });

        const result = await toolsRegistry.execute('lookupNotes', {
            query: 'tea preference',
            about: 'me',
            interactionContext: { user: { id: USER } }
        });
        expect(result).toContain('Earl Grey');
    });
});

describe('retrieveNotes', () => {
    test('server about uses guild-wide graph, not the user scope', async () => {
        await kg.upsertNode({
            guildId: SCOPE,
            scopeKey: '',
            type: 'concept',
            label: 'deploy culture',
            content: 'Ship on Fridays anyway',
            source: 'monologue'
        });
        const found = await retrieveNotes({
            guildId: SCOPE,
            userId: USER,
            query: 'deploy culture',
            depth: 'rich',
            about: 'server',
            includeMemories: false
        });
        expect(found.graph).toContain('Ship on Fridays anyway');
    });
});
