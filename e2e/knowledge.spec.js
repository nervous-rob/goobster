/**
 * Knowledge and Memory (documentation/knowledge_and_memory.md, ADR 0008).
 * The curation contract itself is proven in tests/knowledgeCuration.test.js;
 * these specs click the React rooms: Knowledge opens on Notes, the three
 * registered views, one server-side projection shared by Notes and Map,
 * the Keep action, the personal-memory views inside Settings → Memory &
 * privacy, and the deletion copy that says what a delete leaves behind.
 */
const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('Knowledge opens on Notes, with Map and Research as registered views', async ({ page }) => {
    await openRoom(page, /Knowledge/);
    await expect(page).toHaveURL(/\/app\/knowledge\/notes$/);
    await expect(page.getByRole('heading', { name: /^Knowledge/ })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Knowledge views' });
    await expect(tabs.getByRole('link', { name: /Notes/ })).toHaveAttribute('aria-current', 'page');
    await expect(tabs.getByRole('link', { name: /Map/ })).toBeVisible();
    await expect(tabs.getByRole('link', { name: /Research/ })).toContainText('Expeditions');
    // The personal-memory tabs left this room.
    await expect(page.getByRole('button', { name: 'About you' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Facts' })).toHaveCount(0);

    await tabs.getByRole('link', { name: /Map/ }).click();
    await expect(page).toHaveURL(/\/app\/knowledge\/map$/);
    await expect(page.locator('[data-tour="knowledge-map"]')).toBeVisible();

    await tabs.getByRole('link', { name: /Research/ }).click();
    await expect(page).toHaveURL(/\/app\/knowledge\/research$/);
    await expect(page.getByRole('button', { name: '+ New expedition' })).toBeVisible();
    await expect(page.getByText(C.EXPEDITION_SEED)).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/app\/knowledge\/map$/);
    // The bare path and the legacy alias both land on Notes with state kept.
    await page.goto('/app/knowledge?x=1#frag');
    await expect(page).toHaveURL(/\/app\/knowledge\/notes\?x=1#frag$/);
    await page.goto('/app/spitball/map');
    await expect(page).toHaveURL(/\/app\/knowledge\/map$/);
});

test('Notes and Map share one projection: distilled memory is out of the default view, legacy rows stay listed', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    const notes = page.locator('[data-tour="knowledge-notes"]');
    await expect(notes.locator('[data-tour="knowledge-notes-count"]')).toHaveText('2 notes');
    // Kept research output and the unsorted legacy row are listed…
    await expect(notes.getByText(C.NOTE_LABEL)).toBeVisible();
    const legacy = notes.locator('.notes-row').filter({ hasText: C.LEGACY_NOTE_LABEL });
    await expect(legacy).toBeVisible();
    await expect(legacy.locator('.curation-badge')).toHaveText('unsorted');
    // …what Goobster distilled is not, and the room says so instead of hiding it silently.
    await expect(notes.getByText(C.DISTILLED_NOTE_LABEL)).toHaveCount(0);
    await expect(notes.getByText(C.FACT_CONTENT)).toHaveCount(0);
    await expect(notes.getByText(/2 distilled notes Goobster inferred about you are not shown here/)).toBeVisible();

    // All retained knowledge is the inspection path for every row.
    await notes.getByRole('button', { name: /All retained knowledge/ }).click();
    await expect(notes.locator('[data-tour="knowledge-notes-count"]')).toHaveText('4 notes');
    await expect(notes.getByText(C.DISTILLED_NOTE_LABEL)).toBeVisible();
    // The mirrored fact is listed too, badged as memory (its label is the fact text).
    const factRow = notes.locator('.notes-row').filter({ hasText: C.FACT_CONTENT });
    await expect(factRow).toHaveCount(1);
    await expect(factRow.locator('.curation-badge')).toHaveText('memory');
    const distilled = notes.locator('.notes-row').filter({ hasText: C.DISTILLED_NOTE_LABEL });
    await expect(distilled.locator('.curation-badge')).toHaveText('memory');
    await notes.getByRole('tablist', { name: 'Filter by curation' }).getByRole('button', { name: /^memory/ }).click();
    await expect(notes.locator('[data-tour="knowledge-notes-count"]')).toHaveText('2 notes');
    await expect(notes.getByText(C.NOTE_LABEL)).toHaveCount(0);

    // The Map counts the same rows under the same projection.
    await page.getByRole('navigation', { name: 'Knowledge views' }).getByRole('link', { name: /Map/ }).click();
    const map = page.locator('[data-tour="knowledge-map"]');
    await expect(map.locator('[data-tour="knowledge-map-count"]')).toContainText('2 notes · 1 kept · 2 memory · 1 unsorted');
    await expect(map.getByText('2 distilled notes not mapped here')).toBeVisible();
    await map.getByRole('button', { name: /All retained knowledge/ }).click();
    await expect(map.locator('[data-tour="knowledge-map-count"]')).toContainText('4 notes');
});

test('Keep files an unsorted legacy note with saved knowledge without touching its source', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    const notes = page.locator('[data-tour="knowledge-notes"]');
    const legacy = notes.locator('.notes-row').filter({ hasText: C.LEGACY_NOTE_LABEL });
    await expect(legacy.locator('.curation-badge')).toHaveText('unsorted');
    await legacy.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByText(`“${C.LEGACY_NOTE_LABEL}” kept with your knowledge.`)).toBeVisible();
    await expect(legacy.locator('.curation-badge')).toHaveCount(0);
    await expect(legacy.getByRole('button', { name: 'Keep' })).toHaveCount(0);
    // Provenance is untouched: the meta line still says a tool wrote it.
    await expect(legacy.locator('.notes-row-sub')).toContainText('tool');
    // The scope-wide counts moved with it.
    await expect(notes.getByRole('button', { name: /Your notes/ }).locator('.notes-chip-count')).toHaveText('2');

    const scope = `dm:${C.OWNER}`;
    const all = await page.request.get(`/api/app/spitball/notes?scope=${encodeURIComponent(scope)}&view=all`).then((r) => r.json());
    const row = all.notes.find((note) => note.label === C.LEGACY_NOTE_LABEL);
    expect(row.curation).toBe('saved');
    expect(row.source).toBe('tool');
    expect(all.curation).toEqual({ saved: 2, memory: 2, unclassified: 0 });
});

test('deleting a note says what stays; the memory it came from is untouched', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    const notes = page.locator('[data-tour="knowledge-notes"]');
    await notes.getByRole('button', { name: /All retained knowledge/ }).click();
    const distilled = notes.locator('.notes-row').filter({ hasText: C.DISTILLED_NOTE_LABEL });
    await distilled.getByRole('button', { name: `Delete ${C.DISTILLED_NOTE_LABEL}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Raw memories and chat transcripts it was distilled from are not deleted');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Note deleted.')).toBeVisible();
    await expect(notes.getByText(C.DISTILLED_NOTE_LABEL)).toHaveCount(0);

    const scope = `dm:${C.OWNER}`;
    const memories = await page.request.get(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}`).then((r) => r.json());
    expect(memories.memories.map((m) => m.content)).toContain(C.MEMORY_CONTENT);
});

test('Personal memory lives in Settings → Memory & privacy, reachable from Chat and Knowledge', async ({ page }) => {
    await openRoom(page, /Knowledge/);
    await page.locator('[data-tour="knowledge-personal-memory"]').click();
    await expect(page).toHaveURL(/\/app\/settings\/memory#memory-report$/);
    const panel = page.locator('#personal-memory');
    await expect(panel.getByRole('tab', { name: 'About you' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText('Facts about you', { exact: true })).toBeVisible();
    await expect(panel.getByText('Distilled notes', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Knowledge → Notes' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Back to Knowledge/ })).toBeVisible();

    await panel.getByRole('tab', { name: 'Facts' }).click();
    await expect(panel.getByText(C.FACT_CONTENT)).toBeVisible();
    await panel.getByRole('tab', { name: 'Memories' }).click();
    await expect(panel.getByText(C.MEMORY_CONTENT)).toBeVisible();

    // The deletion rules are stated, not implied.
    await expect(page.locator('#deletion-rules')).toContainText('Delete a memory');
    await expect(page.locator('#deletion-rules')).toContainText('Forget me');
    // No server scopes on this installation - the advanced inspector stays out of the way.
    await expect(page.locator('#memory-scopes')).toHaveCount(0);

    // Chat offers the same shortcut.
    await openRoom(page, /Chat/);
    await page.locator('[data-tour="chat-personal-memory"]').click();
    await expect(page).toHaveURL(/\/app\/settings\/memory#memory-report$/);
    await expect(page.getByRole('link', { name: /Back to Chat/ })).toBeVisible();
});

test('forgetting a fact removes its Map copy but leaves raw memories', async ({ page }) => {
    await page.goto('/app/settings/memory');
    const panel = page.locator('#personal-memory');
    await panel.getByRole('tab', { name: 'Facts' }).click();
    const fact = panel.locator('.list-row').filter({ hasText: C.FACT_CONTENT });
    await expect(fact).toBeVisible();
    await fact.getByRole('button', { name: /Forget fact/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('The memories it was distilled from stay');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Fact forgotten.')).toBeVisible();
    await expect(panel.getByText(C.FACT_CONTENT)).toHaveCount(0);

    const scope = `dm:${C.OWNER}`;
    const all = await page.request.get(`/api/app/spitball/notes?scope=${encodeURIComponent(scope)}&view=all`).then((r) => r.json());
    expect(all.notes.some((note) => note.label === C.FACT_CONTENT)).toBe(false);
    const memories = await page.request.get(`/api/app/memory/memories?scope=${encodeURIComponent(scope)}`).then((r) => r.json());
    expect(memories.memories.map((m) => m.content)).toContain(C.MEMORY_CONTENT);
});
