/**
 * Research brief (#254, documentation/research_brief.md). The contract is
 * pinned in tests/expeditionBrief.test.js; this is the primary browser
 * journey: open a finished expedition, write a brief from its stored
 * evidence, read it with its citation and limitations, make a wording edit
 * that is shown as an edit with the original kept, judge the four-part bar,
 * accept it, and export Markdown that says all of that explicitly. Then a
 * second account cannot see the brief at all.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

test('write, read, edit, review, accept and export a research brief; another account gets nothing', async ({ page, browser }) => {
    await login(page);
    await page.goto('/app/knowledge/research');
    await page.locator('.list-row-click').filter({ hasText: C.EXPEDITION_SEED }).click();
    await expect(page.getByRole('button', { name: '← Expeditions' })).toBeVisible();

    // Briefs section on the expedition, empty until the owner asks.
    await expect(page.getByText('Briefs', { exact: true })).toBeVisible();
    await expect(page.getByText('No brief yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Write brief' }).click();

    // The brief view: unreviewed by default, the finding cites the stored claim.
    const view = page.locator('.brief-view');
    await expect(view).toBeVisible();
    await expect(view.getByText(/^Brief #\d+ · ready/)).toBeVisible();
    await expect(view.locator('.badge.brief-quality')).toHaveText('Unreviewed');
    await expect(view.getByText('not accepted')).toBeVisible();
    await expect(view.getByText('not used yet')).toBeVisible();
    const summary = view.locator('.brief-block[data-target="summary"]');
    await expect(summary.locator('.brief-text')).toContainText(C.BRIEF_SUMMARY);
    await expect(summary.locator('.brief-generated-marker')).toHaveText('generated text');
    const finding = view.locator('.brief-block[data-target="finding:F1"]');
    await expect(finding.locator('.brief-text')).toContainText(C.BRIEF_FINDING);
    await expect(finding.locator('.brief-cite')).toHaveText('[1]');
    await expect(view.locator('#brief-source-1')).toContainText(C.CLAIM_TEXT);
    await expect(view.locator('#brief-source-1')).toContainText(C.SOURCE_TITLE);
    await expect(view.getByText(C.BRIEF_LIMITATION)).toBeVisible();
    // The limitations the evidence itself implies are shown as such.
    await expect(view.locator('.brief-evidence-note').filter({ hasText: /publication date|retrieved/ })).toBeVisible();

    // A wording edit is stored separately; the generated text stays readable.
    await summary.getByRole('button', { name: 'Edit' }).click();
    await summary.getByLabel('Edit summary').fill(C.BRIEF_EDITED_SUMMARY);
    await summary.getByLabel('Edit note').fill('shorter');
    await summary.getByRole('button', { name: 'Save edit' }).click();
    await expect(summary.locator('.brief-text')).toContainText(C.BRIEF_EDITED_SUMMARY);
    await expect(summary.locator('.brief-edit-marker')).toHaveText('✎ edited (wording)');
    await summary.getByRole('button', { name: 'show original' }).click();
    await expect(summary.locator('.brief-original')).toContainText(C.BRIEF_SUMMARY);
    await expect(view.getByText('edits: wording', { exact: true })).toBeVisible();

    // The owner judges the four-part bar; a blank review was never a pass.
    await view.locator('#mark-F1').selectOption('supported');
    await view.locator('#gate-noUnsupportedClaims').selectOption('yes');
    await view.locator('#gate-weakEvidenceLabelled').selectOption('yes');
    await view.locator('#gate-disagreementRepresented').selectOption('yes');
    await view.getByRole('button', { name: 'Save review' }).click();
    await expect(view.locator('.badge.brief-quality')).toHaveText('Ready to show a second person');

    // Acceptance is its own record.
    await view.getByRole('button', { name: 'Accept this brief' }).click();
    await expect(view.getByText(/^accepted /)).toBeVisible();
    await expect(view.getByRole('button', { name: 'Withdraw acceptance' })).toBeVisible();
    await expect(view.getByText('not used yet')).toBeVisible();

    // The export carries the edit marker, the original, the citation and the status.
    const href = await view.getByRole('link', { name: 'Export Markdown' }).getAttribute('href');
    const exported = await page.request.get(href);
    expect(exported.ok()).toBe(true);
    expect(exported.headers()['content-disposition']).toMatch(/attachment; filename="research-brief-/);
    const markdown = await exported.text();
    expect(markdown).toContain(`# Research brief: ${C.EXPEDITION_SEED}`);
    expect(markdown).toContain('**Review status:** Ready to show a second person (owner-judged).');
    expect(markdown).toMatch(/\*\*Accepted:\*\* yes \(.* UTC\)\. \*\*Used:\*\* no\./);
    expect(markdown).toContain(C.BRIEF_EDITED_SUMMARY);
    expect(markdown).toContain(`✎ Edited (wording) — shorter. Original generated text: ${C.BRIEF_SUMMARY}`);
    expect(markdown).toContain(`**F1.** ${C.BRIEF_FINDING} [1]`);
    expect(markdown).toContain(`[1] ${C.CLAIM_TEXT}`);
    expect(markdown).toContain(C.SOURCE_URL);
    expect(markdown).toContain(C.BRIEF_LIMITATION);

    // Back on the expedition the brief is listed with its status.
    const briefId = Number(href.match(/briefs\/(\d+)\//)[1]);
    await view.getByRole('button', { name: '← Expedition' }).click();
    const row = page.locator('.list-row-click').filter({ hasText: `brief #${briefId}` });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge.brief-quality')).toHaveText('Ready to show a second person');
    await expect(row.getByText('accepted', { exact: true })).toBeVisible();

    // Another account: the brief, its list and its export do not exist.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await login(otherPage, { userId: C.MEMBER, name: C.MEMBER_NAME });
    for (const path of [`/api/app/spitball/briefs/${briefId}`, href]) {
        const res = await otherPage.request.get(path);
        expect(res.status()).toBe(404);
    }
    await otherPage.goto('/app/knowledge/research');
    await expect(otherPage.getByRole('button', { name: '+ New expedition' })).toBeVisible();
    await expect(otherPage.getByText(C.EXPEDITION_SEED)).toHaveCount(0);
    await other.close();
});
