/**
 * Findings shared with a project's members
 * (documentation/delegated_project_findings.md, architecture 13.5).
 *
 * The installation's owner delegates "take requests in this project's
 * conversations, and share what you find with its members". A request made
 * there is done by a scripted model; the collaborator sees the finding on
 * Home with whose assistant found it, someone outside the project sees
 * nothing, and once the collaborator is removed it is gone for them.
 * Anyone but the owner is refused the sharing choice until the pilot
 * decision is recorded.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const OWNER = '99000000000000451';
const MEMBER = '99000000000000452';
const OUTSIDER = '99000000000000453';
const TITLE = 'Framework X and framework Y compared';

async function seed(page) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-project-audience', {
        data: { ownerId: OWNER, memberId: MEMBER, outsiderId: OUTSIDER, project: 'Shared lab' }
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

async function say(page, conversationId, text) {
    const said = await page.request.post('/e2e/fixtures/assistant-conversation/say', {
        data: { userId: OWNER, name: 'Ada', conversationId, text }
    });
    expect(said.ok(), await said.text()).toBe(true);
    return said.json();
}

test.describe('findings shared with a project', () => {
    test.describe.configure({ mode: 'serial' });

    test('the owner shares a finding with the project; a member sees whose assistant found it, an outsider nothing, and a removed member loses it', async ({ browser }) => {
        const owner = await (await browser.newContext()).newPage();
        const member = await (await browser.newContext()).newPage();
        const outsider = await (await browser.newContext()).newPage();
        const { conversationId, slug } = await seed(owner);

        await login(owner, { userId: OWNER, name: 'Ada' });
        await owner.goto('/app/assistant');
        await owner.getByTestId('responsibility-title').fill('Look into what the project asks for');
        await owner.getByTestId('responsibility-project').selectOption({ label: 'Shared lab' });
        await owner.getByTestId('responsibility-project-requests').check();
        await owner.getByTestId('responsibility-share-findings').check();
        await expect(owner.getByTestId('responsibility-share-hint')).toContainText('the work is not given your private notes');
        await owner.getByTestId('responsibility-save').click();
        const row = owner.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-shares')).toContainText('project\'s members');
        await row.getByRole('button', { name: 'Activate' }).click();
        await owner.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');

        expect(await say(owner, conversationId, 'Goobster, compare framework X and framework Y')).toMatchObject({ proposed: 1 });
        await owner.reload();
        const work = owner.getByTestId('initiative-row');
        await work.getByRole('button', { name: 'Start' }).click();
        await owner.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(work.getByTestId('initiative-status')).toHaveText('queued');
        const ran = await (await owner.request.post('/e2e/fixtures/assistant-conversation/run')).json();
        expect(ran).toMatchObject({ started: 1 });

        // The owner has their own notice, and says it was shared.
        await owner.goto('/app/');
        const mine = owner.getByTestId('assistant-brief-item').filter({ hasText: TITLE });
        await expect(mine.first()).toContainText('Shared with the members of "Shared lab"');

        // A collaborator sees it on Home, with whose assistant found it.
        await login(member, { userId: MEMBER, name: 'Bo' });
        await member.goto('/app/');
        const finding = member.getByTestId('assistant-brief-item').filter({ hasText: TITLE });
        await expect(finding).toHaveCount(1);
        await expect(finding.getByTestId('assistant-brief-producer')).toHaveText('Shared with this project by Ada\'s assistant');
        await expect(finding.getByTestId('assistant-brief-conversation')).toHaveAttribute('href', new RegExp(`/discussions/${conversationId}$`));

        // Someone outside the project sees nothing.
        await login(outsider, { userId: OUTSIDER, name: 'Cy' });
        await outsider.goto('/app/');
        await expect(outsider.getByTestId('assistant-brief-item').filter({ hasText: TITLE })).toHaveCount(0);

        // Removing the collaborator ends it for them.
        const removed = await owner.request.delete(`/api/app/projects/${slug}/members/${MEMBER}`);
        expect(removed.ok(), await removed.text()).toBe(true);
        await member.goto('/app/');
        await expect(member.getByTestId('assistant-brief-item').filter({ hasText: TITLE })).toHaveCount(0);
    });

    test('anyone but the owner is refused the sharing choice until the pilot decision is recorded', async ({ browser }) => {
        const member = await (await browser.newContext()).newPage();
        const { projectId } = await seed(member);

        await login(member, { userId: MEMBER, name: 'Bo' });
        const refused = await member.request.post('/api/app/assistant/responsibilities', {
            data: {
                title: 'Share what it finds', projectId,
                scopes: { sources: ['project_chat'], audience: 'project' },
                operations: [{ operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } }]
            }
        });
        expect(refused.status()).toBe(409);
        expect(await refused.json()).toMatchObject({ error: { code: 'PILOT_ONLY', details: { capability: 'reach' } } });
    });
});
