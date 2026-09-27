/**
 * Song Studio shared songs: two browsers on one song. The owner saves a
 * wizard song to the server and adds a collaborator; the collaborator opens
 * it from their empty Studio; edits made on either side show up on the
 * other within a moment; presence dots follow the selected track; the
 * collaborator leaves; the owner reloads and the song is still there.
 *
 * A second journey covers the inside of one track: two people editing the
 * same track at once without clobbering each other, a pointer cursor in the
 * piano roll, and the shared transport (Play on one side is announced on
 * the other; Stop on the far side stops the near one). Each browser still
 * renders its own audio, so what is asserted is the room's transport state,
 * not sound.
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

/**
 * Owner (Rob) builds a song, shares it and adds Sam; Sam opens it from the
 * empty Studio. Resolves once both browsers report two people in the room.
 */
async function openSharedSong(browser) {
    const ownerContext = await browser.newContext();
    const friendContext = await browser.newContext();
    const owner = await ownerContext.newPage();
    const friend = await friendContext.newPage();

    await login(owner, { userId: OWNER, name: 'Rob' });
    await buildSongWithWizard(owner);
    const ownerClips = owner.locator('.st-clip:not(.ghost)');
    const clipCount = await ownerClips.count();
    // A unique name so the friend picks this song, not one from an earlier journey.
    const songName = `Session ${Date.now().toString(36)}`;
    await owner.locator('#st-name').fill(songName);

    // Songs shared by earlier journeys in this run are still on the server.
    const sharedBefore = await owner.locator('#st-project optgroup[label="Shared"] option').count();
    await owner.getByTestId('studio-share-toggle').click();
    await expect(owner.getByTestId('studio-share-panel')).toBeVisible();
    await owner.getByTestId('studio-share-save').click();
    await expect(owner.getByTestId('studio-collab-status')).toContainText('Shared · just you');
    await expect(owner.locator('#st-project optgroup[label="Shared"] option')).toHaveCount(sharedBefore + 1);
    await expect(owner.locator('#st-project optgroup[label="This browser"] option')).toHaveCount(0);
    await expect(ownerClips).toHaveCount(clipCount);

    await owner.locator('#st-share-search').fill(FRIEND);
    await owner.getByTestId('studio-share-add-id').click();
    await expect(owner.getByTestId('studio-share-members').locator('.st-share-member')).toHaveCount(2);

    await login(friend, { userId: FRIEND, name: 'Sam' });
    await friend.goto('/app/conservatory/studio');
    const offered = friend.getByTestId('studio-empty-shared').getByRole('button', { name: songName });
    await expect(offered).toHaveCount(1);
    await offered.click();
    const friendClips = friend.locator('.st-clip:not(.ghost)');
    await expect(friendClips).toHaveCount(clipCount);
    await expect(friend.getByTestId('studio-collab-status')).toContainText('Shared · 2 here');
    await expect(owner.getByTestId('studio-collab-status')).toContainText('Shared · 2 here');

    return { ownerContext, friendContext, owner, friend, ownerClips, friendClips, clipCount };
}

test.describe('Song Studio shared songs', () => {
    test('two people edit one song live', async ({ browser }) => {
        test.setTimeout(120_000);
        const { ownerContext, friendContext, owner, friend, ownerClips, friendClips, clipCount } = await openSharedSong(browser);

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

    test('inside one track: notes merge, cursors show, playback follows the room', async ({ browser }) => {
        test.setTimeout(120_000);
        const { ownerContext, friendContext, owner, friend } = await openSharedSong(browser);

        // --- Owner switches the melody to a written lead and opens the roll ---
        await owner.locator('.st-clip', { hasText: 'Melody Wisp' }).first().click();
        await owner.getByRole('button', { name: /Written lead/ }).click();
        const ownerEditor = owner.locator('.st-melody-editor');
        await expect(ownerEditor).toBeVisible();
        const rootLabel = (await ownerEditor.locator('.st-me-row-label.root').first().textContent()).trim();
        const cellOn = (editor, step) => editor.locator(`button[aria-label^="${rootLabel}, bar 1 step ${step}"]`);

        // --- Same track, same moment: Sam renames it while Rob writes a note ---
        // Entity-level last-writer-wins would let whichever arrived second
        // overwrite the other's field; field-level track edits keep both.
        await friend.locator('.st-track-name', { hasText: 'Melody Wisp' }).click();
        await Promise.all([
            friend.locator('#st-track-name').fill('Lead Line'),
            cellOn(ownerEditor, 1).click()
        ]);
        await expect(ownerEditor.locator('.re-panel-head h3')).toContainText('Lead Line');
        await expect(ownerEditor.locator('.re-panel-head p').first()).toContainText('1 notes written');
        await expect(friend.locator('.st-track-label', { hasText: 'Lead Line' })).toHaveCount(1);

        // Sam opens the same roll: the note Rob wrote is there.
        await friend.getByRole('button', { name: /Open melody editor/ }).click();
        const friendEditor = friend.locator('.st-melody-editor');
        await expect(friendEditor).toBeVisible();
        await expect(cellOn(friendEditor, 1)).toHaveClass(/head/);

        // Both write at once on different steps; both notes survive on both sides.
        await Promise.all([
            cellOn(ownerEditor, 3).click(),
            cellOn(friendEditor, 5).click()
        ]);
        for (const editor of [ownerEditor, friendEditor]) {
            await expect(cellOn(editor, 1)).toHaveClass(/head/);
            await expect(cellOn(editor, 3)).toHaveClass(/head/);
            await expect(cellOn(editor, 5)).toHaveClass(/head/);
            await expect(editor.locator('.re-panel-head p').first()).toContainText('3 notes written');
        }

        // --- Cursor presence: Sam's pointer shows up in Rob's roll ---
        await cellOn(friendEditor, 7).hover();
        const samCursor = ownerEditor.locator('.st-me-cell.peer-cursor');
        await expect(samCursor).toHaveCount(1);
        await expect(samCursor).toHaveAttribute('data-peer', 'Sam');
        await expect(samCursor).toHaveAttribute('aria-label', new RegExp(`^${rootLabel}, bar 1 step 7`));
        await expect(ownerEditor.getByTestId('melody-peer-cursors')).toContainText('Sam · bar 1');
        // And the other way round: Rob's pointer is still on the step he last tapped.
        const robCursor = friendEditor.locator('.st-me-cell.peer-cursor');
        await expect(robCursor).toHaveCount(1);
        await expect(robCursor).toHaveAttribute('data-peer', 'Rob');
        await expect(robCursor).toHaveAttribute('aria-label', new RegExp(`^${rootLabel}, bar 1 step 3`));

        // Sam leaves the roll: the ring goes away on Rob's side.
        await friend.locator('.st-melody-editor h3').hover();
        await expect(samCursor).toHaveCount(0);

        // --- Shared transport: Rob presses Play; Sam's browser hears about it ---
        // Sam has not unlocked audio, so Sam's browser cannot start sound on
        // its own — it names who is playing and offers to join.
        await owner.getByRole('button', { name: 'Play' }).click();
        await expect(owner.locator('.re-status-text.on', { hasText: 'Playing' })).toBeVisible();
        await expect(friend.getByTestId('studio-collab-playing')).toContainText('Rob');
        await expect(friend.locator('.st-handoff-note')).toContainText('Rob pressed Play');
        await friend.getByTestId('studio-share-toggle').click();
        await expect(friend.getByTestId('studio-share-transport')).toContainText('Rob is playing');

        // Sam joins at the live step; Stop on Sam's side stops Rob too.
        await friend.getByRole('button', { name: 'Play' }).click();
        await expect(friend.locator('.re-status-text.on', { hasText: 'Playing' })).toBeVisible();
        await friend.getByRole('button', { name: 'Stop and rewind' }).click();
        await expect(friend.locator('.re-status-text', { hasText: 'Playing' })).toHaveCount(0);
        await expect(owner.locator('.re-status-text', { hasText: 'Playing' })).toHaveCount(0);
        await expect(owner.getByTestId('studio-collab-playing')).toHaveCount(0);
        await expect(friend.getByTestId('studio-share-transport')).not.toContainText('is playing');

        // Sync off: Sam's Play stays private — Rob's transport does not move.
        await friend.getByTestId('studio-share-follow').uncheck();
        await expect(friend.getByTestId('studio-share-transport')).toContainText('private');
        await friend.getByRole('button', { name: 'Play' }).click();
        await expect(friend.locator('.re-status-text.on', { hasText: 'Playing' })).toBeVisible();
        await friend.waitForTimeout(400);
        await expect(owner.locator('.re-status-text', { hasText: 'Playing' })).toHaveCount(0);
        await friend.getByRole('button', { name: 'Stop and rewind' }).click();

        await ownerContext.close();
        await friendContext.close();
    });
});
