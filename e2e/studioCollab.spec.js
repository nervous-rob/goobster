/**
 * Song Studio shared songs: two browsers on one song. The owner saves a
 * wizard song to the server and adds a collaborator; the collaborator opens
 * it from their empty Studio; edits made on either side show up on the
 * other within a moment; presence dots follow the selected track; the
 * collaborator leaves; the owner reloads and the song is still there.
 *
 * No audio is started — collaboration is about the arrangement, and each
 * browser plays its own copy.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const OWNER = '820000000000000001';
const FRIEND = '820000000000000002';

async function buildSongWithWizard(page) {
    await page.goto('/app/conservatory/studio');
    await page.getByRole('button', { name: /New song with the wizard/ }).click();
    await page.getByRole('button', { name: /Next — Feel/ }).click();
    await page.getByRole('button', { name: /Next — Fill/ }).click();
    await page.getByRole('button', { name: /Next — Review/ }).click();
    await page.getByRole('button', { name: 'Generate song' }).click();
    await expect(page.locator('.st-clip:not(.ghost)').first()).toBeVisible();
}

test.describe('Song Studio shared songs', () => {
    test('two people edit one song live', async ({ browser }) => {
        test.setTimeout(120_000);
        const ownerContext = await browser.newContext();
        const friendContext = await browser.newContext();
        const owner = await ownerContext.newPage();
        const friend = await friendContext.newPage();

        // --- Owner: build a song and move it onto the server ---
        await login(owner, { userId: OWNER, name: 'Rob' });
        await buildSongWithWizard(owner);
        const ownerClips = owner.locator('.st-clip:not(.ghost)');
        const clipCount = await ownerClips.count();

        await owner.getByTestId('studio-share-toggle').click();
        await expect(owner.getByTestId('studio-share-panel')).toBeVisible();
        await owner.getByTestId('studio-share-save').click();
        await expect(owner.getByTestId('studio-collab-status')).toContainText('Shared · just you');
        await expect(owner.locator('#st-project optgroup[label="Shared"] option')).toHaveCount(1);
        await expect(owner.locator('#st-project optgroup[label="This browser"] option')).toHaveCount(0);
        await expect(ownerClips).toHaveCount(clipCount);

        // Add the collaborator by id.
        await owner.locator('#st-share-search').fill(FRIEND);
        await owner.getByTestId('studio-share-add-id').click();
        await expect(owner.getByTestId('studio-share-members').locator('.st-share-member')).toHaveCount(2);

        // --- Friend: the song is offered on the empty Studio ---
        await login(friend, { userId: FRIEND, name: 'Sam' });
        await friend.goto('/app/conservatory/studio');
        const offered = friend.getByTestId('studio-empty-shared').getByRole('button');
        await expect(offered).toHaveCount(1);
        await offered.click();
        const friendClips = friend.locator('.st-clip:not(.ghost)');
        await expect(friendClips).toHaveCount(clipCount);
        await expect(friend.getByTestId('studio-collab-status')).toContainText('Shared · 2 here');
        await expect(owner.getByTestId('studio-collab-status')).toContainText('Shared · 2 here');

        // --- Friend deletes a clip; the owner sees it go ---
        const melody = friend.locator('.st-clip', { hasText: 'Melody Wisp' }).first();
        await melody.click();
        await expect(melody).toHaveClass(/selected/);
        await friend.keyboard.press('Delete');
        await expect(friendClips).toHaveCount(clipCount - 1);
        await expect(ownerClips).toHaveCount(clipCount - 1);

        // --- Owner renames a track and changes the tempo; the friend follows ---
        await owner.locator('.st-track-name').first().click();
        await owner.locator('#st-track-name').fill('Thunder Kick');
        await expect(friend.locator('.st-track-label', { hasText: 'Thunder Kick' })).toHaveCount(1);
        const initialBpm = Number(await owner.locator('#studio-bpm').inputValue());
        const ownerBpm = String(initialBpm + 1);
        await owner.getByRole('button', { name: 'Increase BPM' }).click();
        await expect(owner.locator('#studio-bpm')).toHaveValue(ownerBpm);
        await expect(friend.locator('#studio-bpm')).toHaveValue(ownerBpm);

        // --- Presence: the friend's selected track shows a dot on the owner's side ---
        await friend.locator('.st-track-name').nth(1).click();
        const secondRow = owner.locator('.st-row:not(.st-ruler-row):not(.st-add-row)').nth(1);
        await expect(secondRow.locator('.st-track-peers .st-peer-dot')).toHaveCount(1);
        await expect(secondRow.getByTitle('Sam is on this track')).toBeVisible();

        // --- The friend leaves; the owner's roster shrinks ---
        await friend.getByTestId('studio-share-toggle').click();
        await friend.getByTestId('studio-share-leave').click();
        await expect(friend.getByText('No songs yet')).toBeVisible();
        await expect(owner.getByTestId('studio-share-members').locator('.st-share-member')).toHaveCount(1);
        await expect(owner.getByTestId('studio-collab-status')).toContainText('Shared · just you');

        // --- The document is on the server: a reload brings it back with every edit ---
        await owner.reload();
        await expect(owner.locator('.st-clip:not(.ghost)')).toHaveCount(clipCount - 1);
        await expect(owner.locator('.st-track-label', { hasText: 'Thunder Kick' })).toHaveCount(1);
        await expect(owner.locator('#studio-bpm')).toHaveValue(ownerBpm);

        await ownerContext.close();
        await friendContext.close();
    });
});
