/**
 * Chat's New chat button: one click from an open conversation lands on an
 * empty chat (it used to take two - the first click bounced back to the
 * conversation it was leaving).
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('one click on New chat leaves an open conversation for an empty chat', async ({ page }) => {
    const { conversations } = await page.request.get('/api/app/chat/conversations').then((r) => r.json());
    const chat = conversations.find((c) => c.title === C.CHAT_TITLE);
    expect(chat).toBeTruthy();
    await page.goto(`/app/chat/${chat.id}`);
    await expect(page.getByText(C.CHAT_ANSWER_BODY)).toBeVisible();

    await page.getByRole('button', { name: /New chat/ }).click();
    await expect(page).toHaveURL(/\/app\/chat$/);
    await expect(page.getByText(C.CHAT_ANSWER_BODY)).toHaveCount(0);

    // The route still drives the room: Back reopens the conversation.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/app/chat/${chat.id}$`));
    await expect(page.getByText(C.CHAT_ANSWER_BODY)).toBeVisible();
});
