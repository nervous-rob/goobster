const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('connect a personal key, assign models by function, refresh and disconnect', async ({ page }) => {
    const emptyModels = { chat: null, voiceChat: null, image: null, speech: null, transcription: null, parlor: null, research: null };
    let settings = { connected: false, enabled: false, completionUrl: 'https://openrouter.ai/api/v1/chat/completions', models: { ...emptyModels } };
    let refreshes = 0;
    const saves = [];
    await page.route('**/api/app/settings/personal-ai', async route => {
        if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON();
            saves.push(body);
            settings = { ...settings, connected: true, enabled: body.enabled, completionUrl: body.completionUrl, models: { ...settings.models, ...body.models } };
        } else if (route.request().method() === 'DELETE') {
            settings = { ...settings, connected: false, enabled: false, models: { ...emptyModels } };
        }
        await route.fulfill({ json: settings });
    });
    await page.route('**/api/app/settings/personal-ai/models**', async route => {
        if (new URL(route.request().url()).searchParams.get('refresh') === 'true') refreshes++;
        await route.fulfill({ json: { status: 'live', checkedAt: '2026-10-09T00:00:00Z', models: [
            { id: 'vendor/chat', name: 'Chat model', input: ['text'], output: ['text'], tools: true, functions: ['chat', 'voiceChat', 'parlor', 'research'] },
            { id: 'vendor/image', name: 'Image model', input: ['text'], output: ['image'], tools: false, functions: ['image'] },
            { id: 'vendor/audio', name: 'Audio model', input: ['text', 'audio'], output: ['text', 'audio'], tools: false, functions: ['speech', 'transcription', 'voiceChat', 'chat'] }
        ] } });
    });
    await login(page);
    await page.goto('/app/settings/connections');
    const key = page.getByLabel('Your API key', { exact: true });
    await key.fill('synthetic-test-personal-key');
    await page.getByRole('button', { name: 'Connect personal AI', exact: true }).click();
    await expect(key).toHaveValue('');
    await page.getByLabel('Chat model', { exact: true }).selectOption('vendor/chat');
    await page.getByLabel('Image generation model', { exact: true }).selectOption('vendor/image');
    await expect(page.getByLabel('Image generation model', { exact: true }).locator('option')).toHaveCount(2);
    await page.getByLabel('Read-aloud speech model', { exact: true }).selectOption('vendor/audio');
    await page.getByLabel('Use personal AI for assigned functions').check();
    await page.getByRole('button', { name: 'Save personal AI', exact: true }).click();
    await expect(page.getByText('Personal AI settings saved.', { exact: true })).toBeVisible();
    expect(saves.at(-1)).not.toHaveProperty('apiKey');
    expect(saves.at(-1).models).toMatchObject({ chat: 'vendor/chat', image: 'vendor/image', speech: 'vendor/audio' });
    await page.getByRole('button', { name: 'Refresh personal models', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh personal models', exact: true })).toBeEnabled();
    expect(refreshes).toBe(1);
    await expect(page.getByLabel('Chat model', { exact: true })).toHaveValue('vendor/chat');
    await page.getByRole('button', { name: 'Disconnect personal AI', exact: true }).click();
    await expect(page.getByText('Personal AI disconnected.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect personal AI', exact: true })).toBeVisible();
});
