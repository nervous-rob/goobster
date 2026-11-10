/**
 * Outside connectors in a responsibility (documentation/delegated_connectors.md,
 * DA-11d).
 *
 * Goobster ships no connector, so the journeys run against the test double
 * the fixture installs (a fake notebook). The installation's owner sees the
 * connector's manifest, grants a named resource on it for reading and
 * writing, and sees that a write cannot be undone and how many a day are
 * allowed. Revoking the connector deletes their credential and the very
 * next authorization is refused. Somebody who is not the owner is not
 * offered connectors while they are in the pilot.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const GRANTING = '99000000000011401';
const REVOKING = '99000000000011402';
const OUTSIDER = '99000000000011403';

async function seed(page, body) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-connector', { data: body });
    expect(seeded.ok(), await seeded.text()).toBe(true);
}

/**
 * Turning a responsibility on takes the person's confirmation receipt for
 * the revision they were shown (ADR 0023): confirm, then act with it.
 */
async function activate(page, responsibility) {
    const confirmation = await page.request.post('/api/app/assistant/confirmations', {
        data: { subject: 'responsibility', id: responsibility.id, action: 'activate', revision: responsibility.revision, surface: 'portal' }
    });
    expect(confirmation.ok(), await confirmation.text()).toBe(true);
    return page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
        data: { action: 'activate', expectedRevision: responsibility.revision, receipt: (await confirmation.json()).receipt }
    });
}

test.describe('outside connectors in a responsibility', () => {
    test('the owner reads the manifest, grants one named resource and activates it with the limits spelled out', async ({ page }) => {
        await seed(page, { userId: GRANTING, name: 'Keeper', owner: true });
        await login(page, { userId: GRANTING, name: 'Keeper' });
        await page.goto('/app/assistant');

        const card = page.getByTestId('connector-row');
        await expect(card).toContainText('Test notebook');
        await expect(card.getByTestId('connector-status')).toHaveText('connected');
        await expect(card).toContainText('Can read: search');
        await expect(card).toContainText('Can write: append');
        await expect(card).toContainText('(checked with the service after a crash)');
        await expect(card).toContainText('Can write: clear');
        await expect(card).toContainText('(stops for your review after a crash)');
        await expect(card.getByTestId('connector-decision')).toContainText('Not a shipped connector');

        await page.getByTestId('responsibility-title').fill('Keep the garden notebook');
        const section = page.getByTestId('responsibility-connectors');
        await expect(section).toBeVisible();
        // Nothing is granted until a resource is named and an action chosen.
        await expect(page.getByTestId('responsibility-reach-note')).toHaveCount(0);
        await page.getByTestId('responsibility-connector-write-notebook').check();
        await page.getByTestId('responsibility-connector-read-notebook').check();
        await expect(page.getByTestId('responsibility-connector-read-note')).toContainText('cannot write outside this installation');
        await expect(page.getByTestId('responsibility-reach-note')).toContainText('cannot be undone from here');
        await expect(page.getByTestId('responsibility-external-budget')).toHaveValue('2');

        // A grant names its resource: there is no wildcard.
        await page.getByTestId('responsibility-save').click();
        await expect(page.getByText('Name the resource it may use in Test notebook')).toBeVisible();
        await expect(page.getByTestId('responsibility-row')).toHaveCount(0);
        await page.getByTestId('responsibility-connector-resource-notebook').fill('*');
        await page.getByTestId('responsibility-save').click();
        await expect(page.getByTestId('responsibility-row')).toHaveCount(0);
        await page.getByTestId('responsibility-connector-resource-notebook').fill('garden');
        await page.getByTestId('responsibility-external-budget').fill('1');
        await page.getByTestId('responsibility-save').click();

        const row = page.getByTestId('responsibility-row');
        await expect(row).toContainText('read, write to an outside service: garden in notebook');
        await expect(row.getByTestId('responsibility-connector-reach')).toContainText('cannot be undone from here');
        await expect(row.getByTestId('responsibility-connector-reach')).toContainText('at most 1 outside operations a day');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');

        await row.getByRole('button', { name: 'Activate' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('read, write to an outside service: garden in notebook');
        await expect(dialog).toContainText('Writes to outside services are made as you and cannot be undone from here; at most 1 outside operations a day.');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
    });

    test('revoking a connector deletes the credential and the very next authorization is refused', async ({ page }) => {
        await seed(page, { userId: REVOKING, name: 'Revoker', owner: true });
        await login(page, { userId: REVOKING, name: 'Revoker' });
        const drafted = await page.request.post('/api/app/assistant/responsibilities', {
            data: { title: 'Keep the notebook', operations: [{ operation: 'external.write', resource: { kind: 'external', ids: ['notebook:garden'] } }] }
        });
        expect(drafted.ok(), await drafted.text()).toBe(true);
        const { responsibility } = await drafted.json();
        const activated = await activate(page, responsibility);
        expect(activated.ok(), await activated.text()).toBe(true);
        const authorize = async () => (await page.request.post('/e2e/fixtures/assistant-connector/authorize', { data: { userId: REVOKING } })).json();
        expect(await authorize()).toEqual({ ok: true, code: null });

        await page.goto('/app/assistant');
        const card = page.getByTestId('connector-row');
        await expect(card.getByTestId('connector-status')).toHaveText('connected');
        await card.getByTestId('connector-revoke').click();
        await expect(page.getByRole('dialog')).toContainText('Your Notion credential is deleted now');
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();

        await expect(card.getByTestId('connector-status')).toHaveText('not connected');
        await expect(card.getByTestId('connector-revoke')).toBeDisabled();
        await expect(card).toContainText('Connect Notion under Settings, Integrations, to use it.');
        // It is no longer offered in the draft form, and the next call is refused.
        await expect(page.getByTestId('responsibility-connectors')).toHaveCount(0);
        expect(await authorize()).toEqual({ ok: false, code: 'RESOURCE_UNAVAILABLE' });
    });

    test('somebody who is not the owner is not offered connectors during the pilot', async ({ page }) => {
        await seed(page, { userId: OUTSIDER, name: 'Visitor' });
        await login(page, { userId: OUTSIDER, name: 'Visitor' });
        const listed = page.waitForResponse((response) => response.url().includes('/api/app/assistant/connectors'));
        await page.goto('/app/assistant');
        expect(await (await listed).json()).toEqual({ allowed: false, connectors: [] });
        await expect(page.getByTestId('responsibility-draft')).toBeVisible();
        await expect(page.getByTestId('connector-row')).toHaveCount(0);
        await expect(page.getByTestId('responsibility-connectors')).toHaveCount(0);

        // The server holds the line too: such a grant cannot be activated.
        const drafted = await page.request.post('/api/app/assistant/responsibilities', {
            data: { title: 'Write for me', operations: [{ operation: 'external.write', resource: { kind: 'external', ids: ['notebook:garden'] } }] }
        });
        expect(drafted.ok(), await drafted.text()).toBe(true);
        const { responsibility } = await drafted.json();
        // Without the person's confirmation receipt the route refuses outright
        // (ADR 0023); with one, the pilot gate still does.
        const bare = await page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
            data: { action: 'activate', expectedRevision: responsibility.revision }
        });
        expect(bare.status()).toBe(403);
        expect(JSON.stringify(await bare.json())).toContain('HUMAN_CONFIRMATION_REQUIRED');
        const activated = await activate(page, responsibility);
        expect(activated.status()).toBe(409);
        expect(JSON.stringify(await activated.json())).toContain('PILOT_ONLY');
    });
});
