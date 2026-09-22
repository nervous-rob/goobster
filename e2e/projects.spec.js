/**
 * Projects (ADR 0009, documentation/projects.md "The portal pane").
 * Organization-versus-execution is proven in tests/projectOrganization.test.js;
 * these specs click the React room: the list links to owner-qualified
 * addresses, a project and its view survive refresh / Back / deep links,
 * two owners with one slug are told apart (and a slug-only link asks),
 * direct creation with a goal, the Plan / Run vocabulary, and Unfiled apps.
 */
const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

const MINE = `/app/projects/${C.OWNER}/${C.PROJECT_SLUG}`;
const THEIRS = `/app/projects/${C.MEMBER}/${C.PROJECT_SLUG}`;

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('the list links each project to its owner-qualified address; opening one lands on Overview', async ({ page }) => {
    await openRoom(page, /Projects/);
    await expect(page).toHaveURL(/\/app\/projects$/);
    await expect(page.getByRole('heading', { name: /^Projects/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New project' })).toBeVisible();

    // Two rows share the name; the cards say who owns each and link differently.
    const mine = page.getByTestId(`project-card-${C.OWNER}-${C.PROJECT_SLUG}`);
    const theirs = page.getByTestId(`project-card-${C.MEMBER}-${C.PROJECT_SLUG}`);
    await expect(mine).toContainText('owner');
    await expect(mine).toContainText(C.PROJECT_GOAL);
    await expect(theirs).toContainText('collaborator');
    await expect(theirs).toContainText(C.MEMBER_NAME);
    await expect(mine).toHaveAttribute('href', `${MINE}/overview`);
    await expect(theirs).toHaveAttribute('href', `${THEIRS}/overview`);
    // Vocabulary: runs, not jobs.
    await expect(mine).toContainText(/\d+ runs?\b/);
    await expect(page.getByText(/\bjob\(s\)/)).toHaveCount(0);

    await mine.click();
    await expect(page).toHaveURL(new RegExp(`${MINE}/overview$`));
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();
    await expect(page.locator('[data-tour="project-goal"]')).toContainText(C.PROJECT_GOAL);
    const tabs = page.getByRole('navigation', { name: 'Project views' });
    await expect(tabs.getByRole('link', { name: /Overview/ })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Plan', 'Conversation', 'Knowledge', 'Files', 'Apps', 'Runs', 'People', 'Automations']) {
        // The icon is aria-hidden, so the accessible name is the view's name alone.
        await expect(tabs.getByRole('link', { name, exact: true })).toBeVisible();
    }
    // Plan / Run words on the Overview; the old ones are gone.
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Latest runs' })).toBeVisible();
    await expect(page.getByText(/Run #\d+/)).toBeVisible();
    await expect(page.getByText(/Job #\d+/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Outputs' })).toBeVisible();
});

test('the active view lives in the URL: tabs, refresh, Back/Forward and deep links agree', async ({ page }) => {
    await page.goto(`${MINE}/overview`);
    const tabs = page.getByRole('navigation', { name: 'Project views' });
    await tabs.getByRole('link', { name: /Runs/ }).click();
    await expect(page).toHaveURL(new RegExp(`${MINE}/runs$`));
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(page.getByText('❌ FAILED')).toBeVisible();
    await expect(page.getByText(/Run #\d+/)).toBeVisible();

    await tabs.getByRole('link', { name: /Files/ }).click();
    await expect(page).toHaveURL(new RegExp(`${MINE}/files$`));
    await expect(page.getByRole('button', { name: '📁 out' })).toBeVisible();

    // Refresh keeps the project and the view.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${MINE}/files$`));
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();
    await expect(tabs.getByRole('link', { name: /Files/ })).toHaveAttribute('aria-current', 'page');

    // Back walks the views; Forward returns.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${MINE}/runs$`));
    await expect(tabs.getByRole('link', { name: /Runs/ })).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${MINE}/overview$`));
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${MINE}/runs$`));

    // Deep links: the bare detail path opens Overview; an old segment name
    // still resolves; an unknown one falls back to Overview.
    await page.goto(`${MINE}?from=inbox#top`);
    await expect(page).toHaveURL(new RegExp(`${MINE}/overview\\?from=inbox#top$`));
    await page.goto(`${MINE}/mission`);
    await expect(tabs.getByRole('link', { name: /Plan/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Start a plan')).toBeVisible();
    await page.goto(`${MINE}/bogus`);
    await expect(page).toHaveURL(new RegExp(`${MINE}/overview$`));

    // Back to the list from the header.
    await page.getByRole('link', { name: '← Projects' }).click();
    await expect(page).toHaveURL(/\/app\/projects$/);
});

test('two owners, one slug: the address tells them apart and a slug-only link asks instead of guessing', async ({ page }) => {
    await page.goto(`${THEIRS}/overview`);
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();
    await expect(page.locator('[data-tour="project-goal"]')).toContainText(C.TWIN_PROJECT_GOAL);
    await expect(page.locator('.obs-status-line')).toContainText(`owner ${C.MEMBER_NAME}`);
    // A collaborator has no owner-only actions.
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    await page.goto(`${MINE}/overview`);
    await expect(page.locator('[data-tour="project-goal"]')).toContainText(C.PROJECT_GOAL);
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();

    // The resolver: ambiguous → chooser naming each owner.
    await page.goto(`/app/projects/${C.PROJECT_SLUG}`);
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.PROJECT_SLUG}$`));
    const chooser = page.locator('[data-tour="project-resolver-chooser"]');
    await expect(chooser).toBeVisible();
    await expect(chooser.getByTestId(`project-choice-${C.OWNER}`)).toContainText('yours');
    await expect(chooser.getByTestId(`project-choice-${C.MEMBER}`)).toContainText(`owner ${C.MEMBER_NAME}`);
    await chooser.getByTestId(`project-choice-${C.MEMBER}`).click();
    await expect(page).toHaveURL(new RegExp(`${THEIRS}/overview$`));
    await expect(page.locator('[data-tour="project-goal"]')).toContainText(C.TWIN_PROJECT_GOAL);

    // Unknown slug: says so, with a way back.
    await page.goto('/app/projects/no-such-project');
    await expect(page.locator('[data-tour="project-resolver-missing"]')).toContainText('No project called');
    await page.getByRole('link', { name: '← All projects' }).click();
    await expect(page).toHaveURL(/\/app\/projects$/);
});

test('creating a project is a form with a name and a goal - no model call - and opens the new project', async ({ page }) => {
    await openRoom(page, /Projects/);
    await page.getByRole('button', { name: '+ New project' }).click();
    const form = page.locator('[data-tour="project-create-form"]');
    await expect(form.getByRole('heading', { name: 'New project' })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Create project' })).toBeDisabled();
    await form.getByPlaceholder('Emergence study').fill('Coral bleaching atlas');
    await form.getByPlaceholder(/What should this project/).fill('Map every reef survey we can find.');
    await form.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/coral-bleaching-atlas/overview$`));
    await expect(page.getByRole('heading', { name: /Coral bleaching atlas/ })).toBeVisible();
    await expect(page.locator('[data-tour="project-goal"]')).toContainText('Map every reef survey we can find.');
    await expect(page.getByText(/No runs yet/)).toBeVisible();

    // A unique slug resolves straight through the slug-only path.
    await page.goto('/app/projects/coral-bleaching-atlas');
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/coral-bleaching-atlas/overview$`));

    // Leave the seed alone for the other specs.
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: /Delete|OK|Confirm/ }).last().click();
    await expect(page).toHaveURL(/\/app\/projects$/);
    await expect(page.getByText('Coral bleaching atlas')).toHaveCount(0);
});

test('Conversation and People are views (the dock and modal stay secondary); Unfiled apps is on the list', async ({ page }) => {
    await page.goto(`${MINE}/conversation`);
    const conversation = page.locator('[data-tour="project-conversation"]');
    await expect(conversation.getByText(C.PARLOR_USER_MESSAGE)).toBeVisible();
    await expect(conversation.getByText(C.PARLOR_REPLY)).toBeVisible();
    // No dock toggle on the Conversation view itself.
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Project views' }).getByRole('link', { name: /People/ }).click();
    await expect(page).toHaveURL(new RegExp(`${MINE}/people$`));
    await expect(page.getByRole('heading', { name: 'People on this project' })).toBeVisible();
    await expect(page.locator('[data-tour="project-people"]')).toContainText('You');
    await expect(page.locator('[data-tour="project-people"]')).toContainText('owner');

    // The dock still opens beside any other view.
    await page.getByRole('navigation', { name: 'Project views' }).getByRole('link', { name: /Knowledge/ }).click();
    await expect(page.getByText(C.PROJECT_KNOWLEDGE_LABEL)).toBeVisible();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel(/Chat about/i).getByText(C.PARLOR_REPLY)).toBeVisible();
    await page.getByRole('button', { name: 'Hide chat' }).click();

    await page.getByRole('link', { name: '← Projects' }).click();
    const unfiled = page.locator('[data-tour="project-unfiled-apps"]');
    await expect(unfiled).toContainText('Unfiled apps');
    await expect(unfiled).toContainText('generated apps only');
});
