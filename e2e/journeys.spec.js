/**
 * Browser journeys for the three cognitive loops (ADR 0004).
 * Service internals are already proven in tests/cognitiveLoopJourneys.test.js.
 * These specs click the React rooms and assert the wiring.
 */
const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('expedition → claims → notes → evidence', async ({ page }) => {
    await openRoom(page, /Knowledge/);
    await expect(page.getByRole('heading', { name: /^Knowledge/ })).toBeVisible();

    const views = page.getByRole('navigation', { name: 'Knowledge views' });
    await views.getByRole('link', { name: /Research/ }).click();
    await expect(page).toHaveURL(/\/app\/knowledge\/research$/);
    await expect(page.getByText(C.EXPEDITION_SEED)).toBeVisible();
    await expect(page.getByText(/completed/i).first()).toBeVisible();

    await page.getByText(C.EXPEDITION_SEED).click();
    await expect(page.getByText(C.EXPEDITION_SUMMARY).first()).toBeVisible();
    await expect(page.getByRole('link', { name: C.SOURCE_TITLE })).toBeVisible();
    await page.getByRole('button', { name: /1 claim/ }).click();
    await expect(page.getByText(C.CLAIM_TEXT)).toBeVisible();

    await page.getByRole('button', { name: '← Expeditions' }).click();
    await views.getByRole('link', { name: /Notes/ }).click();
    await expect(page).toHaveURL(/\/app\/knowledge\/notes$/);
    const notes = page.locator('[data-tour="knowledge-notes"]');
    await expect(notes.getByText(C.NOTE_LABEL)).toBeVisible();
    await expect(notes.getByText(/parametrizes cells/i)).toBeVisible();
    // Research the person launched is kept knowledge, so it carries no "unsorted" badge.
    await expect(notes.locator('.notes-row').filter({ hasText: C.NOTE_LABEL }).locator('.curation-badge')).toHaveCount(0);
});

test('project Parlor → transcript → project knowledge', async ({ page }) => {
    await openRoom(page, /Discussions/);
    await expect(page.getByText(C.PERSONA_NAME).first()).toBeVisible();
    await expect(page.getByText('Salon on ingest')).toBeVisible();
    await page.getByText('Salon on ingest').click();
    await expect(page.getByText(C.PARLOR_USER_MESSAGE)).toBeVisible();
    await expect(page.getByText(C.PARLOR_REPLY)).toBeVisible();

    await openRoom(page, /Projects/);
    await expect(page.getByRole('heading', { name: /^Projects/ })).toBeVisible();
    // Two projects share this name (ADR 0009); the card names its owner.
    await page.getByTestId(`project-card-${C.OWNER}-${C.PROJECT_SLUG}`).click();
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();

    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByLabel(/Chat about/i).getByText(C.PARLOR_USER_MESSAGE)).toBeVisible();
    await expect(page.getByLabel(/Chat about/i).getByText(C.PARLOR_REPLY)).toBeVisible();
    await page.getByRole('button', { name: 'Hide chat' }).click();

    await page.getByRole('navigation', { name: 'Project views' }).getByRole('link', { name: 'Knowledge', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/${C.PROJECT_SLUG}/knowledge$`));
    await expect(page.getByText(C.PROJECT_KNOWLEDGE_LABEL)).toBeVisible();
    await expect(page.getByText(C.PROJECT_KNOWLEDGE_CONTENT)).toBeVisible();
});

test('project run → output → Attention notice', async ({ page }) => {
    await openRoom(page, /Projects/);
    await page.getByTestId(`project-card-${C.OWNER}-${C.PROJECT_SLUG}`).click();
    // Inbox Ask also seeds a failed Python run in this shared project.
    const run = page.getByTestId(/^run-\d+$/).filter({ hasText: /bash ·/ });
    await expect(run.getByText('❌ FAILED')).toBeVisible();
    await expect(run.getByText(/Run #\d+/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Outputs' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse all files' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/${C.PROJECT_SLUG}/files$`));
    await page.getByRole('button', { name: '📁 out' }).click();
    await expect(page.getByRole('button', { name: /result\.json/ })).toBeVisible();

    await openRoom(page, /Activity/);
    await page.getByRole('navigation', { name: 'Activity views' }).getByRole('link', { name: /Attention/ }).click();
    await expect(page.getByRole('heading', { name: /^Attention/ })).toBeVisible();
    const notice = page.locator('[id^="notice-"]').filter({ hasText: C.NOTICE_TITLE });
    await expect(notice.getByText(C.NOTICE_TITLE)).toBeVisible();
    await expect(notice.getByText(C.NOTICE_DETAIL)).toBeVisible();

    await notice.getByRole('button', { name: 'why?' }).click();
    await expect(page.getByRole('heading', { name: 'Why he raised this' })).toBeVisible();
    await expect(page.getByText('Urgency')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await notice.getByRole('button', { name: 'Acted' }).click();
    await expect(page.getByText(C.NOTICE_TITLE)).toHaveCount(0);
});

test('project plan draft → approve → review → complete', async ({ page }) => {
    await openRoom(page, /Projects/);
    await page.getByTestId(`project-card-${C.OWNER}-${C.PROJECT_SLUG}`).click();
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();
    await expect(page.getByText(/No open plan/)).toBeVisible();
    await page.getByRole('button', { name: 'Start one' }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/${C.PROJECT_SLUG}/plan$`));

    await expect(page.getByText('Start a plan')).toBeVisible();
    await page.getByPlaceholder('pgvector at one million notes').fill(C.MISSION_TITLE);
    await page.getByPlaceholder(/Determine whether pgvector/).fill(C.MISSION_OBJECTIVE);
    await page.getByPlaceholder(/A reproducible benchmark/).fill(
        `${C.MISSION_CRITERION_1}\n${C.MISSION_CRITERION_2}`
    );
    await page.getByRole('button', { name: 'Draft plan' }).click();

    await expect(page.getByRole('heading', { name: C.MISSION_TITLE })).toBeVisible();
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();
    await expect(page.getByText(C.MISSION_CRITERION_1)).toBeVisible();

    await page.getByPlaceholder('Step title').fill(C.MISSION_STEP);
    await page.getByRole('button', { name: 'Add step' }).click();
    await expect(page.getByText(C.MISSION_STEP)).toBeVisible();

    await page.getByRole('button', { name: 'Approve & start' }).click();
    await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();
    await expect(page.getByText('READY', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('REVIEW', { exact: true })).toBeVisible();

    await page.getByPlaceholder(/What the evidence shows/).fill(C.MISSION_REVIEW);
    await page.getByRole('button', { name: 'Complete plan' }).click();

    await expect(page.getByText('Start a plan')).toBeVisible();
    await page.getByText(/Earlier plans/).click();
    await expect(page.getByText(C.MISSION_TITLE)).toBeVisible();
});
