const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const registry = require('../packages/core/models/registry');
test.use({ hasTouch: true });

// The HTTP boundary is mocked so these journeys need no provider account.
// The actual catalog/discovery and settings writes have integration coverage.
async function catalogFixtures(page, { savedModel = 'gpt-6-sol', status = 'live' } = {}) {
    await page.route('**/api/app/settings', async route => {
        const response = await route.fetch();
        const settings = await response.json();
        Object.assign(settings.sections.chat.values, {
            provider: 'openai', model: savedModel, reasoningEffort: null, thoughtful: false,
            parlorProvider: null, parlorModel: null, researchProvider: null, researchModel: null
        });
        settings.sections.chat.providers = [
            { key: 'openai', name: 'OpenAI', configured: true, isDefault: true, chatModel: 'gpt-6-sol' },
            { key: 'anthropic', name: 'Anthropic Claude', configured: true, chatModel: 'claude-sonnet-5' }
        ];
        settings.sections.chat.effective = { provider: 'openai', providerName: 'OpenAI', model: savedModel };
        settings.sections.chat.thoughtfulAvailable = false;
        await route.fulfill({ response, json: settings });
    });
    await page.route('**/api/app/chat/model-catalog?**', async route => {
        const url = new URL(route.request().url());
        const provider = url.searchParams.get('provider');
        const ids = provider === 'anthropic' ? ['claude-sonnet-5'] : ['gpt-6-sol', 'gpt-4o', 'gpt-5'];
        const models = ids.map(id => ({
            ...registry.get(provider, id),
            availability: status === 'live' ? (id === 'gpt-5' ? 'not-listed' : 'listed') : 'unknown',
            selectable: status !== 'live' || id !== 'gpt-5'
        }));
        await route.fulfill({ json: {
            version: 1, provider, workflow: url.searchParams.get('workflow'), models,
            discovery: { status, checkedAt: status === 'live' ? '2026-09-22T00:00:00Z' : null },
            unregisteredCount: 3
        } });
    });
}

test('catalog drives model choices, effort, sampling and feature pickers', async ({ page }) => {
    await catalogFixtures(page);
    await login(page);
    await page.goto('/app/settings/chat');
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(model).toBeEnabled();
    await expect(model.locator('option')).toHaveCount(3); // default plus two listed models
    await expect(model).toHaveValue('gpt-6-sol');
    await expect(page.getByLabel('Temperature', { exact: true })).toBeDisabled();
    await page.getByRole('radio', { name: 'None', exact: true }).click();
    await expect(page.getByLabel('Temperature', { exact: true })).toBeEnabled();
    await expect(page.getByRole('radio', { name: 'Max', exact: true })).toBeVisible();

    await model.selectOption('gpt-4o');
    await expect(page.getByRole('radiogroup', { name: 'Reasoning effort' }).getByRole('radio')).toHaveCount(1);
    await expect(page.getByLabel('Temperature', { exact: true })).toBeEnabled();
    await page.getByLabel('Model platform', { exact: true }).selectOption('anthropic');
    await expect(model).toHaveValue('');
    await expect(model.locator('option')).toHaveCount(2);
    await expect(page.getByLabel('Temperature', { exact: true })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Max', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Parlor model', exact: true }).locator('option')).toHaveCount(3);
    await expect(page.getByRole('combobox', { name: 'Research model', exact: true }).locator('option')).toHaveCount(3);
});

test('model details work on hover, keyboard and touch without mobile overflow', async ({ page }) => {
    await catalogFixtures(page);
    await login(page);
    await page.goto('/app/settings/chat');
    const about = page.locator('#model').getByRole('button', { name: 'About this model' });
    const details = page.getByRole('region', { name: 'GPT-6 Sol details' }).first();
    await about.hover();
    await expect(details).toBeVisible();
    await expect(details).toContainText('1,050,000 tokens');
    await about.focus();
    await about.press('Escape');
    await expect(details).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await about.tap();
    await expect(details).toBeVisible();
    const box = await details.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: test.info().outputPath('model-details-mobile.png') });
});

test('an outage preserves an unknown saved choice and explains how to repair it', async ({ page }) => {
    await catalogFixtures(page, { savedModel: 'old-unregistered-model', status: 'unavailable' });
    await login(page);
    await page.goto('/app/settings/chat');
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(model).toHaveValue('old-unregistered-model');
    await expect(page.locator('#model')).toContainText('availability is unverified');
    await expect(page.locator('#model')).toContainText('no supported profile');
    await model.selectOption('gpt-6-sol');
    await expect(page.locator('#model')).not.toContainText('no supported profile');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
});
