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
    await openRoom(page, /Spitball/);
    await expect(page.getByRole('heading', { name: 'Spitball' })).toBeVisible();

    await page.getByRole('button', { name: 'Expeditions' }).click();
    await expect(page.getByText(C.EXPEDITION_SEED)).toBeVisible();
    await expect(page.getByText(/completed/i).first()).toBeVisible();

    await page.getByText(C.EXPEDITION_SEED).click();
    await expect(page.getByText(C.EXPEDITION_SUMMARY).first()).toBeVisible();
    await expect(page.getByRole('link', { name: C.SOURCE_TITLE })).toBeVisible();
    await page.getByRole('button', { name: /1 claim/ }).click();
    await expect(page.getByText(C.CLAIM_TEXT)).toBeVisible();

    await page.getByRole('button', { name: '← Expeditions' }).click();
    await page.getByRole('button', { name: 'Notes' }).click();
    await expect(page.getByText(C.NOTE_LABEL)).toBeVisible();
    await expect(page.getByText(/parametrizes cells/i)).toBeVisible();
});

test('project Parlor → transcript → project knowledge', async ({ page }) => {
    await openRoom(page, /Parlor/);
    await expect(page.getByText(C.PERSONA_NAME).first()).toBeVisible();
    await expect(page.getByText('Salon on ingest')).toBeVisible();
    await page.getByText('Salon on ingest').click();
    await expect(page.getByText(C.PARLOR_USER_MESSAGE)).toBeVisible();
    await expect(page.getByText(C.PARLOR_REPLY)).toBeVisible();

    await openRoom(page, /Observatory/);
    await expect(page.getByRole('heading', { name: 'The Observatory' })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(C.PROJECT_NAME) }).click();
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();

    await page.getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByLabel(/Chat about/i).getByText(C.PARLOR_USER_MESSAGE)).toBeVisible();
    await expect(page.getByLabel(/Chat about/i).getByText(C.PARLOR_REPLY)).toBeVisible();
    await page.getByRole('button', { name: 'Hide chat' }).click();

    await page.getByRole('button', { name: 'Knowledge' }).click();
    await expect(page.getByText(C.PROJECT_KNOWLEDGE_LABEL)).toBeVisible();
    await expect(page.getByText(C.PROJECT_KNOWLEDGE_CONTENT)).toBeVisible();
});

test('project job → artifact → Attention notice', async ({ page }) => {
    await openRoom(page, /Observatory/);
    await page.getByRole('button', { name: new RegExp(C.PROJECT_NAME) }).click();
    await expect(page.getByText('❌ FAILED')).toBeVisible();
    await expect(page.getByText(/Job #/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
    await page.getByRole('button', { name: 'Browse all files in Explorer' }).click();
    await page.getByRole('button', { name: '📁 out' }).click();
    await expect(page.getByRole('button', { name: /result\.json/ })).toBeVisible();

    await openRoom(page, /Noticed/);
    await expect(page.getByRole('heading', { name: 'Noticed' })).toBeVisible();
    await expect(page.getByText(C.NOTICE_TITLE)).toBeVisible();
    await expect(page.getByText(C.NOTICE_DETAIL)).toBeVisible();

    await page.getByRole('button', { name: 'why?' }).click();
    await expect(page.getByRole('heading', { name: 'Why he raised this' })).toBeVisible();
    await expect(page.getByText('Urgency')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Acted' }).click();
    await expect(page.getByText(C.NOTICE_TITLE)).toHaveCount(0);
});
