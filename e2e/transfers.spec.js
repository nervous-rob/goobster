/**
 * Explicit transfers (ADR 0010; documentation/projects.md "Moving knowledge
 * into a project"). The ledger semantics are proven in
 * tests/knowledgeTransfers.test.js; these specs click the hops in the React
 * rooms: an answer saved as a note lands in Knowledge → Notes and never in
 * Personal memory; the picker is owner-qualified and refuses a memory row; a
 * private project takes a reference only its owner sees; a shared project
 * takes a published copy whose audience is named before anything is sent;
 * refresh and Back keep the project the transfer opened; Use in discussion
 * posts a transcript message; deleting the original names every scope it
 * reached and leaves the published copy alone.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

const SCOPE = `dm:${C.OWNER}`;
const MINE = `/app/projects/${C.OWNER}/${C.PROJECT_SLUG}`;
const THEIRS = `/app/projects/${C.MEMBER}/${C.PROJECT_SLUG}`;

async function knowledgeNotes(page, view = 'knowledge') {
    return page.request
        .get(`/api/app/spitball/notes?scope=${encodeURIComponent(SCOPE)}&view=${view}`)
        .then((r) => r.json());
}

async function savedNote(page) {
    const { notes } = await knowledgeNotes(page, 'all');
    return notes.find((note) => note.label === C.CHAT_ANSWER_HEADING) || null;
}

async function projectNotes(page, ownerId) {
    return page.request
        .get(`/api/app/projects/${C.PROJECT_SLUG}/knowledge/notes?owner=${ownerId}`)
        .then((r) => r.json());
}

function savedRow(page) {
    return page.locator('[data-tour="knowledge-notes"] .notes-row').filter({ hasText: C.CHAT_ANSWER_HEADING });
}

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('an assistant answer is saved as a note: it lands in Knowledge → Notes, not in Personal memory', async ({ page }) => {
    const { conversations } = await page.request.get('/api/app/chat/conversations').then((r) => r.json());
    const chat = conversations.find((c) => c.title === C.CHAT_TITLE);
    expect(chat).toBeTruthy();
    await page.goto(`/app/chat/${chat.id}`);
    await expect(page.getByText(C.CHAT_ANSWER_BODY)).toBeVisible();

    // The generated app in the same chat still offers Save to project… -
    // organization, not execution - and only assistant turns offer Save as note.
    await expect(page.locator('button.code-copy[title="Save to project…"]')).toBeVisible();
    const question = page.locator('.msg.user').filter({ hasText: C.CHAT_QUESTION });
    await question.hover();
    await expect(question.getByRole('button', { name: /Save as note/ })).toHaveCount(0);

    const answer = page.locator('.msg.assistant').filter({ hasText: C.CHAT_ANSWER_BODY });
    await answer.hover();
    await answer.getByRole('button', { name: /Save as note/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Save as note' })).toBeVisible();
    // Title from the answer's heading, body from the answer - editable, no model call.
    await expect(page.getByTestId('save-note-title')).toHaveValue(C.CHAT_ANSWER_HEADING);
    await expect(dialog.locator('#save-note-content')).toHaveValue(new RegExp(C.CHAT_ANSWER_BODY.replace(/[()^+]/g, '\\$&')));
    await page.getByTestId('save-note-submit').click();
    await expect(page.getByText(`Saved “${C.CHAT_ANSWER_HEADING}” to your notes.`)).toBeVisible();
    const done = page.getByTestId('save-note-done');
    await expect(done).toContainText('Knowledge → Notes');
    await expect(done).toContainText('not with what Goobster inferred about you');
    // The next hop is offered on the note just made.
    await expect(page.getByTestId('save-note-add-to-project')).toBeVisible();
    await dialog.getByRole('button', { name: 'Open Notes' }).click();

    await expect(page).toHaveURL(/\/app\/knowledge\/notes$/);
    const row = savedRow(page);
    await expect(row).toBeVisible();
    await expect(row.locator('.curation-badge')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Add to project…' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Use in discussion…' })).toBeVisible();

    // One server projection: saved knowledge, never the memory view.
    const knowledge = await knowledgeNotes(page, 'knowledge');
    const note = knowledge.notes.find((n) => n.label === C.CHAT_ANSWER_HEADING);
    expect(note).toMatchObject({ curation: 'saved', source: 'user' });
    const memory = await knowledgeNotes(page, 'memory');
    expect(memory.notes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(false);
    // Provenance points back at the message; the transparency report counts it.
    const report = await page.request.get(`/api/app/memory/report?scope=${encodeURIComponent(SCOPE)}`).then((r) => r.json());
    expect(report.knowledgeGraph.transfers.savedAnswers).toBe(1);

    // The Map draws the same projection (labels live on a canvas, so the
    // server-side constellation is the thing to check): in the knowledge
    // view, absent from the memory view, with no client-side filter.
    await page.getByRole('navigation', { name: 'Knowledge views' }).getByRole('link', { name: /Map/ }).click();
    const map = page.locator('[data-tour="knowledge-map"]');
    await expect(map.locator('[data-tour="knowledge-map-count"]')).toContainText(`${knowledge.curation.saved} kept`);
    const constellation = (view) => page.request
        .get(`/api/app/memory/constellation?scope=${encodeURIComponent(SCOPE)}&view=${view}`)
        .then((r) => r.json());
    expect((await constellation('knowledge')).nodes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(true);
    expect((await constellation('memory')).nodes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(false);
});

test('the picker is owner-qualified and refuses memory; a private project takes a reference only its owner sees', async ({ page }) => {
    const fixture = await page.request.post('/e2e/fixtures/distilled-note', { data: { userId: C.OWNER } }).then((r) => r.json());
    await page.goto('/app/knowledge/notes');
    const notes = page.locator('[data-tour="knowledge-notes"]');
    await notes.getByRole('button', { name: /All retained knowledge/ }).click();
    // A distilled row is listed as memory and has no transfer actions at all.
    const distilled = notes.locator('.notes-row').filter({ hasText: C.TRANSFER_MEMORY_LABEL });
    await expect(distilled.locator('.curation-badge')).toHaveText('memory');
    await expect(distilled.getByRole('button', { name: 'Add to project…' })).toHaveCount(0);
    await expect(distilled.getByRole('button', { name: 'Use in discussion…' })).toHaveCount(0);
    // …and the server refuses it even when asked directly.
    const refused = await page.request.post(`/api/app/spitball/notes/${fixture.id}/transfers`, {
        data: { target: 'project', project: C.PROJECT_SLUG, owner: C.OWNER, mode: 'copy' }
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe('NOT_KNOWLEDGE');
    await page.request.delete(`/api/app/spitball/notes/${fixture.id}?scope=${encodeURIComponent(SCOPE)}`);

    await savedRow(page).getByRole('button', { name: 'Add to project…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add to project…' })).toBeVisible();
    await expect(dialog).toContainText('Nothing is sent to a model');
    const picker = page.getByTestId('transfer-project');
    // Two owners share the slug; each option says whose it is.
    await expect(picker.locator(`option[value="${C.OWNER}:${C.PROJECT_SLUG}"]`)).toHaveText(`${C.PROJECT_NAME} (${C.PROJECT_SLUG} · private)`);
    await expect(picker.locator(`option[value="${C.MEMBER}:${C.PROJECT_SLUG}"]`)).toHaveText(`${C.PROJECT_NAME} (${C.PROJECT_SLUG} · ${C.MEMBER_NAME}'s)`);

    await picker.selectOption(`${C.OWNER}:${C.PROJECT_SLUG}`);
    const reference = dialog.getByRole('radio', { name: /Reference/ });
    await expect(reference).toBeEnabled();
    await reference.check();
    await expect(page.getByTestId('transfer-audience')).toHaveCount(0);
    await expect(page.getByTestId('transfer-submit')).toHaveText('Reference in project');
    await page.getByTestId('transfer-submit').click();
    await expect(dialog.getByRole('heading', { name: `Referenced in ${C.PROJECT_NAME}` })).toBeVisible();
    await expect(page.getByTestId('transfer-done')).toContainText('only you can see it there');
    await page.getByTestId('transfer-open-project').click();

    // The transfer opens the project's Knowledge view at its owner-qualified address.
    await expect(page).toHaveURL(new RegExp(`${MINE}/knowledge$`));
    const references = page.getByTestId('project-knowledge-references');
    await expect(references).toContainText(C.CHAT_ANSWER_HEADING);
    await expect(references).toContainText('reference · only you');
    await expect(page.getByTestId('project-knowledge-audience')).toContainText('only you');
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${MINE}/knowledge$`));
    await expect(page.getByTestId('project-knowledge-references')).toContainText(C.CHAT_ANSWER_HEADING);

    // Nothing was written into the project scope: the reference resolves at read time.
    const mine = await projectNotes(page, C.OWNER);
    expect(mine.notes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(false);
    expect(mine.references.map((n) => n.label)).toContain(C.CHAT_ANSWER_HEADING);
    expect(mine.audience.private).toBe(true);
});

test('a private note entering a shared project is a published copy: the audience is named, the original stays private, refresh and Back keep the project', async ({ page, browser }) => {
    await page.goto('/app/knowledge/notes');
    await savedRow(page).getByRole('button', { name: 'Add to project…' }).click();
    const dialog = page.getByRole('dialog');
    await page.getByTestId('transfer-project').selectOption(`${C.MEMBER}:${C.PROJECT_SLUG}`);
    // Frieda's project has other readers, so a reference is not on offer.
    const reference = dialog.getByRole('radio', { name: /Reference/ });
    await expect(reference).toBeDisabled();
    await expect(dialog).toContainText('Only for a private project you own');
    await expect(dialog.getByRole('radio', { name: /Publish a copy/ })).toBeChecked();
    // Who will read it, and exactly what, before anything is sent.
    await expect(page.getByTestId('transfer-audience')).toContainText(`you and ${C.MEMBER_NAME}`);
    const preview = page.getByTestId('transfer-preview');
    await expect(preview).toContainText(C.CHAT_ANSWER_HEADING);
    await expect(preview).toContainText(C.CHAT_ANSWER_BODY);
    await expect(page.getByTestId('transfer-submit')).toHaveText('Publish copy');
    await page.getByTestId('transfer-submit').click();
    await expect(dialog.getByRole('heading', { name: `Published to ${C.PROJECT_NAME}` })).toBeVisible();
    const done = page.getByTestId('transfer-done');
    await expect(done).toContainText(`Readers: you and ${C.MEMBER_NAME}`);
    await expect(done).toContainText('Your original is untouched');
    await page.getByTestId('transfer-open-project').click();

    await expect(page).toHaveURL(new RegExp(`${THEIRS}/knowledge$`));
    await expect(page.getByRole('heading', { name: new RegExp(C.PROJECT_NAME) })).toBeVisible();
    const copies = page.getByTestId('project-knowledge-notes');
    await expect(copies).toContainText(C.CHAT_ANSWER_HEADING);
    await expect(copies).toContainText('copy · published by you');
    await expect(page.getByTestId('project-knowledge-audience')).toContainText(`you and ${C.MEMBER_NAME}`);
    // Refresh keeps the project and the view; Back returns to the notes.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${THEIRS}/knowledge$`));
    await expect(page.getByTestId('project-knowledge-notes')).toContainText(C.CHAT_ANSWER_HEADING);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/knowledge\/notes$/);
    await expect(savedRow(page)).toBeVisible();

    // The copy is a different row in the project scope; the original is still Rob's alone.
    const original = await savedNote(page);
    const theirs = await projectNotes(page, C.MEMBER);
    const copy = theirs.notes.find((n) => n.label === C.CHAT_ANSWER_HEADING);
    expect(copy).toMatchObject({ publishedBy: C.OWNER, publishedFrom: C.CHAT_ANSWER_HEADING, canRemove: true });
    expect(copy.id).not.toBe(original.id);
    expect(theirs.references).toEqual([]);

    // Frieda reads the copy - and who published it - but never Rob's original.
    const friedaContext = await browser.newContext();
    const frieda = await friedaContext.newPage();
    try {
        await login(frieda, { userId: C.MEMBER, name: C.MEMBER_NAME });
        const hers = await frieda.request
            .get(`/api/app/projects/${C.PROJECT_SLUG}/knowledge/notes?owner=${C.MEMBER}`)
            .then((r) => r.json());
        const seen = hers.notes.find((n) => n.label === C.CHAT_ANSWER_HEADING);
        expect(seen).toMatchObject({ id: copy.id, publishedBy: C.OWNER });
        const herNotes = await frieda.request
            .get(`/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${C.MEMBER}`)}&view=all`)
            .then((r) => r.json());
        expect(herNotes.notes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(false);
        await frieda.goto(`${THEIRS}/knowledge`);
        const row = frieda.getByTestId(`project-note-${copy.id}`);
        await expect(row).toContainText(`published by ${C.OWNER_NAME}`);
        await expect(frieda.getByTestId('project-knowledge-audience')).toContainText(`you and ${C.OWNER_NAME}`);
    } finally {
        await friedaContext.close();
    }
});

test('Use in discussion posts the note as a message from you; no persona turn runs', async ({ page }) => {
    const { conversations } = await page.request.get('/api/app/parlor/conversations').then((r) => r.json());
    const salon = conversations.find((c) => c.title === 'Salon on ingest');
    const before = await page.request.get(`/api/app/parlor/conversations/${salon.id}/messages`).then((r) => r.json());

    await page.goto('/app/knowledge/notes');
    await savedRow(page).getByRole('button', { name: 'Use in discussion…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Use in discussion…' })).toBeVisible();
    await page.getByTestId('transfer-discussion').selectOption(String(salon.id));
    await expect(page.getByTestId('transfer-audience')).toContainText('only you');
    await expect(page.getByTestId('transfer-audience')).toContainText('posted as a message from you');
    await expect(page.getByTestId('transfer-preview')).toContainText(C.CHAT_ANSWER_BODY);
    await page.getByTestId('transfer-submit').click();
    await expect(dialog.getByRole('heading', { name: 'Posted to Salon on ingest' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open discussion' }).click();

    await expect(page).toHaveURL(new RegExp(`/app/discussions/${salon.id}$`));
    await expect(page.getByText(C.CHAT_ANSWER_BODY).first()).toBeVisible();

    const after = await page.request.get(`/api/app/parlor/conversations/${salon.id}/messages`).then((r) => r.json());
    expect(after.messages.length).toBe(before.messages.length + 1);
    const posted = after.messages[after.messages.length - 1];
    expect(posted.role).toBe('user');
    expect(posted.userId).toBe(C.OWNER);
    expect(posted.content).toContain(C.CHAT_ANSWER_HEADING);
    expect(posted.content).toContain(C.CHAT_ANSWER_BODY);
});

test('deleting the original names every scope it reached; the published copy and the transcript message stay', async ({ page }) => {
    await page.goto('/app/knowledge/notes');
    const original = await savedNote(page);
    await savedRow(page).getByRole('button', { name: `Delete ${C.CHAT_ANSWER_HEADING}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete note' })).toBeVisible();
    const scopes = page.getByTestId('delete-note-scopes');
    // The private reference goes with the note; the copy and the message are named, not touched.
    await expect(scopes).toContainText(`${C.PROJECT_NAME} (your private project) — referenced there`);
    await expect(scopes).toContainText(`(${C.MEMBER_NAME}'s project) — a published copy, readable by you and ${C.MEMBER_NAME}`);
    await expect(scopes).toContainText('Tick to remove that copy too; otherwise it stays in the project.');
    await expect(scopes).toContainText('Salon on ingest — posted as a message from you');
    await expect(scopes.getByRole('checkbox')).toHaveCount(1);
    await expect(scopes.getByRole('checkbox')).not.toBeChecked();
    await page.getByTestId('delete-note-confirm').click();
    await expect(page.getByText('Note deleted.')).toBeVisible();
    await expect(savedRow(page)).toHaveCount(0);

    const gone = await savedNote(page);
    expect(gone).toBeNull();
    // Reference: gone with the note. Copy: still in Frieda's project, with the title it was published under.
    const mine = await projectNotes(page, C.OWNER);
    expect(mine.references).toEqual([]);
    const theirs = await projectNotes(page, C.MEMBER);
    const copy = theirs.notes.find((n) => n.label === C.CHAT_ANSWER_HEADING);
    expect(copy).toMatchObject({ publishedBy: C.OWNER, publishedFrom: C.CHAT_ANSWER_HEADING });
    expect(copy.id).not.toBe(original.id);
    await page.goto(`${THEIRS}/knowledge`);
    await expect(page.getByTestId('project-knowledge-notes')).toContainText(C.CHAT_ANSWER_HEADING);
    // Transcript: the message is part of the discussion.
    const { conversations } = await page.request.get('/api/app/parlor/conversations').then((r) => r.json());
    const salon = conversations.find((c) => c.title === 'Salon on ingest');
    const messages = await page.request.get(`/api/app/parlor/conversations/${salon.id}/messages`).then((r) => r.json());
    expect(messages.messages.some((m) => m.content.includes(C.CHAT_ANSWER_BODY))).toBe(true);
    // The Map and the counts moved with the note, no stale vector behind.
    const knowledge = await knowledgeNotes(page, 'all');
    expect(knowledge.notes.some((n) => n.label === C.CHAT_ANSWER_HEADING)).toBe(false);
});
