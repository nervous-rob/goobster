/**
 * Song Studio journey: build a song with the wizard, then exercise the
 * arranger affordances that live purely in the browser — clip selection and
 * the Delete key, undo/redo, split at the playhead, track duplication,
 * export/import round trip, and the two-step song delete.
 *
 * Nothing here starts audio: Tone.js needs a user gesture per context and
 * headless playback timing is not what these checks are about.
 */
/* global document, getComputedStyle */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const IMPORT_INPUT = 'input[type=file][aria-label="Import a song file"]';

async function buildSongWithWizard(page) {
    await page.goto('/app/conservatory/studio');
    await page.getByRole('button', { name: /New song with the wizard/ }).click();
    await page.getByRole('button', { name: /Next — Feel/ }).click();
    await page.getByRole('button', { name: /Next — Fill/ }).click();
    await page.getByRole('button', { name: /Next — Review/ }).click();
    await page.getByRole('button', { name: 'Generate song' }).click();
    await expect(page.locator('.st-clip:not(.ghost)').first()).toBeVisible();
}

test.describe('Song Studio', () => {
    test.beforeEach(async ({ page }) => {
        await login(page);
        await buildSongWithWizard(page);
    });

    test('lab fits inside the portal pane without horizontal overflow', async ({ page }) => {
        const overflow = await page.evaluate(() => {
            const body = document.querySelector('.conservatory-body') || document.documentElement;
            return body.scrollWidth - body.clientWidth;
        });
        expect(overflow).toBeLessThanOrEqual(0);
    });

    test('Delete key removes the selected clip and undo/redo restore it', async ({ page }) => {
        const clips = page.locator('.st-clip:not(.ghost)');
        const before = await clips.count();
        const melody = page.locator('.st-clip', { hasText: 'Melody Wisp' }).first();
        await melody.click();
        await expect(melody).toHaveClass(/selected/);

        await page.keyboard.press('Delete');
        await expect(clips).toHaveCount(before - 1);

        await page.keyboard.press('Control+z');
        await expect(clips).toHaveCount(before);

        await page.getByRole('button', { name: 'Redo' }).click();
        await expect(clips).toHaveCount(before - 1);

        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(clips).toHaveCount(before);
    });

    test('split at the playhead cuts the selected clip', async ({ page }) => {
        const kicks = page.locator('.st-clip', { hasText: 'Kick Stomper' });
        const before = await kicks.count();
        await page.locator('.st-tick').nth(9).click();
        await kicks.first().click();
        const split = page.getByRole('button', { name: /Split at bar 10/ });
        await expect(split).toBeEnabled();
        await split.click();
        await expect(kicks).toHaveCount(before + 1);
    });

    test('duplicate track clones the performer with its clips', async ({ page }) => {
        const heads = page.locator('.st-track-head:not(.st-corner):not(.st-add-head)');
        const before = await heads.count();
        await page.locator('.st-track-name').first().click();
        await page.getByRole('button', { name: 'Duplicate track' }).click();
        await expect(heads).toHaveCount(before + 1);
        await expect(page.locator('.st-track-label', { hasText: '(copy)' })).toHaveCount(1);
    });

    test('BPM is typed as a draft and clamped on commit', async ({ page }) => {
        const bpm = page.locator('#studio-bpm');
        await bpm.click({ clickCount: 3 });
        await bpm.pressSequentially('125');
        await bpm.press('Enter');
        await expect(bpm).toHaveValue('125');
        await bpm.click({ clickCount: 3 });
        await bpm.pressSequentially('7');
        await bpm.press('Tab');
        await expect(bpm).toHaveValue('40');
    });

    test('export and import round-trip a song as a fresh copy', async ({ page }) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-studio-'));
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: 'Export' }).click()
        ]);
        const file = path.join(dir, download.suggestedFilename());
        await download.saveAs(file);
        const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(exported.format).toBe('goobster-studio-song');
        expect(exported.version).toBe(1);

        const options = page.locator('#st-project option');
        const before = await options.count();
        await page.locator(IMPORT_INPUT).setInputFiles(file);
        await expect(options).toHaveCount(before + 1);
        await expect(page.locator('.st-handoff-note')).toContainText('Imported');
        await expect(page.locator('#st-project')).not.toHaveValue(exported.project.id);

        const bad = path.join(dir, 'bad.json');
        fs.writeFileSync(bad, '{"hello":"world"}');
        await page.locator(IMPORT_INPUT).setInputFiles(bad);
        await expect(page.locator('.st-handoff-note.error')).toBeVisible();
        await expect(options).toHaveCount(before + 1);
    });

    test('deleting a song takes two clicks', async ({ page }) => {
        const options = page.locator('#st-project option');
        const before = await options.count();
        const del = page.getByRole('button', { name: /^Delete$|Really delete\?/ });
        await del.click();
        await expect(del).toHaveText(/Really delete\?/);
        await expect(options).toHaveCount(before);
        await del.click();
        await expect(options).toHaveCount(before - 1);
    });

    test('playhead stays aligned with the header column on a phone', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        const tick = page.locator('.st-tick').first();
        await tick.scrollIntoViewIfNeeded();
        await tick.click();
        const geometry = await page.evaluate(() => ({
            head: document.querySelector('.st-track-head').getBoundingClientRect().width,
            playhead: parseFloat(getComputedStyle(document.querySelector('.st-playhead')).left)
        }));
        expect(Math.abs(geometry.head - geometry.playhead)).toBeLessThan(1);
    });
});
