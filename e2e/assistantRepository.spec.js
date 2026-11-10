/**
 * Repository work in a responsibility (documentation/delegated_runs.md,
 * DA-11a).
 *
 * The installation's owner drafts a responsibility that may commit, push
 * and open pull requests in a repository cloned into their project, on the
 * branches they name. The form, the row and the activation dialog all say
 * that a push or a pull request cannot be undone, and how many a day are
 * allowed. Somebody who is not the owner is not offered repository work
 * while it is in the pilot.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const OWNER = '99000000000001101';
const OTHER = '99000000000001102';

async function seed(page, body) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-repository', { data: body });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

test.describe('repository work in a responsibility', () => {
    test('the owner grants commit, push and pull requests on named branches, with the limits spelled out', async ({ page }) => {
        await seed(page, { userId: OWNER, name: 'Maintainer', project: 'Field notes', owner: true });
        await login(page, { userId: OWNER, name: 'Maintainer' });
        await page.goto('/app/assistant');

        await page.getByTestId('responsibility-title').fill('Keep the notes repository tidy');
        await page.getByTestId('responsibility-project').selectOption({ label: 'Field notes' });
        const section = page.getByTestId('responsibility-repository');
        await expect(section).toBeVisible();
        // Nothing is granted until a repository is chosen.
        await expect(page.getByTestId('responsibility-repo-push')).toHaveCount(0);
        await page.getByTestId('responsibility-repo').selectOption('notes');
        await expect(page.getByTestId('responsibility-branches')).toHaveValue('goobster/*');
        await expect(section).toContainText('Never on main, the repository\'s default branch or a protected branch');
        await page.getByTestId('responsibility-repo-commit').check();
        // A commit stays in the project: the limits on leaving it appear with push.
        await expect(page.getByTestId('responsibility-reach-note')).toHaveCount(0);
        await page.getByTestId('responsibility-repo-push').check();
        await page.getByTestId('responsibility-repo-pr').check();
        await expect(page.getByTestId('responsibility-reach-note')).toContainText('cannot be undone from here');
        await expect(page.getByTestId('responsibility-external-budget')).toHaveValue('2');

        // The branches are part of the grant: it cannot be saved without them.
        await page.getByTestId('responsibility-branches').fill('');
        await page.getByTestId('responsibility-save').click();
        await expect(page.getByText('Name the branches it may work on')).toBeVisible();
        await expect(page.getByTestId('responsibility-row')).toHaveCount(0);
        await page.getByTestId('responsibility-branches').fill('goobster/*');
        await page.getByTestId('responsibility-external-budget').fill('1');
        await page.getByTestId('responsibility-save').click();

        const row = page.getByTestId('responsibility-row');
        await expect(row).toContainText('commit, push, open pull requests: acme/notes on goobster/*');
        await expect(row.getByTestId('responsibility-reach')).toContainText('cannot be undone from here');
        await expect(row.getByTestId('responsibility-reach')).toContainText('at most 1 a day');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');

        await row.getByRole('button', { name: 'Activate' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('commit, push, open pull requests: acme/notes on goobster/*');
        await expect(dialog).toContainText('Pushes and pull requests go to GitHub as you and cannot be undone from here; at most 1 a day.');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
    });

    test('somebody who is not the owner is not offered repository work during the pilot', async ({ page }) => {
        await seed(page, { userId: OTHER, name: 'Contributor', project: 'Side notes' });
        await login(page, { userId: OTHER, name: 'Contributor' });
        const access = page.waitForResponse((response) => response.url().includes('/api/app/assistant/access'));
        await page.goto('/app/assistant');
        expect((await (await access).json()).capabilities.reach).toBe(false);
        await page.getByTestId('responsibility-project').selectOption({ label: 'Side notes' });
        await expect(page.getByText('It may read this project.')).toBeVisible();
        await expect(page.getByTestId('responsibility-repository')).toHaveCount(0);

        // The server holds the line too: such a grant cannot be activated.
        const drafted = await page.request.post('/api/app/assistant/responsibilities', {
            data: {
                title: 'Push for me',
                operations: [{ operation: 'repo.push', resource: { kind: 'repository', projectId: String((await seedProject(page)).id), ids: ['acme/notes'], branches: ['goobster/*'] } }]
            }
        });
        expect(drafted.ok(), await drafted.text()).toBe(true);
        const { responsibility } = await drafted.json();
        const activated = await page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
            data: { action: 'activate', expectedRevision: responsibility.revision }
        });
        expect(activated.status()).toBe(409);
        expect(JSON.stringify(await activated.json())).toContain('PILOT_ONLY');
    });
});

/** The project the fixture made for the signed-in person. */
async function seedProject(page) {
    const listed = await (await page.request.get('/api/app/observatory/projects')).json();
    return listed.projects.find((project) => project.name === 'Side notes');
}
