/**
 * Appearance: the accent palette, the surface treatment, the navigation
 * layout, the page width, the icon style, the text size and the density. All preview live,
 * all save to the account and keep a device copy, and all are painted before
 * the app mounts on reload. The top-bar layout keeps the
 * same "Rooms" landmark and Settings link the sidebar exposes, so the
 * rest of the portal (and its tests) address navigation the same way.
 */
/* global document, getComputedStyle */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Later specs address the sidebar; put the account back however a run ended.
test.afterEach(async ({ page }) => {
    await page.request.patch('/api/app/settings/appearance', {
        data: { changes: { accent: 'blueberry', surface: 'tinted', navLayout: 'sidebar', pageWidth: 'centered', iconStyle: 'emoji' } }
    }).catch(() => {});
});

async function accentOf(page) {
    return page.evaluate(() => document.documentElement.getAttribute('data-accent'));
}

async function accentRgb(page) {
    return page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--accent').trim());
}

// The page surface, resolved to sRGB through a canvas (the stylesheet
// declares it in oklch, and <body> animates its background).
async function surfaceRgb(page) {
    return page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:fixed;transition:none;background-color:var(--bg)';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return { r, g, b };
    });
}

test('accent previews live, saves to the account, and survives a reload', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');

    const swatches = page.getByRole('radiogroup', { name: 'Accent color' });
    await expect(swatches.getByRole('radio', { name: 'Blueberry' })).toHaveAttribute('aria-checked', 'true');
    const before = await accentRgb(page);
    // The mark and the favicon are the berry in the painted accent.
    const brand = page.locator('#sidebar .brand-logo');
    const favicon = page.locator('link[rel="icon"]');
    await expect(brand).toHaveAttribute('src', '/app/icons/berry/blueberry.svg');
    await expect(favicon).toHaveAttribute('href', '/app/icons/berry/blueberry.svg');

    await swatches.getByRole('radio', { name: 'Mint' }).click();
    expect(await accentOf(page)).toBe('mint');
    const previewed = await accentRgb(page);
    expect(previewed).not.toBe(before);
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expect(brand).toHaveAttribute('src', '/app/icons/berry/mint.svg');
    await expect(favicon).toHaveAttribute('href', '/app/icons/berry/mint.svg');
    await expect(page.locator('.accent-swatches')).toBeVisible();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_accent_mint_berry.png' });

    // Discard paints the stored accent back.
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await accentOf(page)).toBe('blueberry');
    expect(await accentRgb(page)).toBe(before);
    await expect(brand).toHaveAttribute('src', '/app/icons/berry/blueberry.svg');

    await swatches.getByRole('radio', { name: 'Sunset' }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.accent).toBe('sunset');
    expect(await page.evaluate(() => localStorage.getItem('goobster-accent'))).toBe('sunset');

    await page.reload();
    expect(await accentOf(page)).toBe('sunset');
    await expect(page.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Sunset' }))
        .toHaveAttribute('aria-checked', 'true');
    await expect(brand).toHaveAttribute('src', '/app/icons/berry/sunset.svg');
    await expect(favicon).toHaveAttribute('href', '/app/icons/berry/sunset.svg');
    expect((await page.request.get('/app/icons/berry/sunset.svg')).status()).toBe(200);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_accent_sunset.png' });
});

test('the accent follows light and dark surfaces', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Ocean' }).click();
    const dark = await accentRgb(page);
    await page.getByRole('radio', { name: /Light/ }).click();
    await expect(page.locator('body')).toHaveClass(/light/);
    const light = await accentRgb(page);
    expect(light).not.toBe(dark);
    expect(await accentOf(page)).toBe('ocean');
});

test('the whitespace is tinted by theme and accent together', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    const swatches = page.getByRole('radiogroup', { name: 'Accent color' });

    // Dark: Sunset warms the page (red above blue), Ocean cools it (blue
    // above red); both stay dark.
    await swatches.getByRole('radio', { name: 'Sunset' }).click();
    const darkSunset = await surfaceRgb(page);
    await swatches.getByRole('radio', { name: 'Ocean' }).click();
    const darkOcean = await surfaceRgb(page);
    expect(darkSunset.r).toBeGreaterThan(darkSunset.b);
    expect(darkOcean.b).toBeGreaterThan(darkOcean.r);
    for (const c of [darkSunset, darkOcean]) expect(Math.max(c.r, c.g, c.b)).toBeLessThan(40);

    // Light: same hue relationship, both stay near white.
    await page.getByRole('radio', { name: /Light/ }).click();
    await expect(page.locator('body')).toHaveClass(/light/);
    const lightOcean = await surfaceRgb(page);
    await swatches.getByRole('radio', { name: 'Sunset' }).click();
    const lightSunset = await surfaceRgb(page);
    expect(lightSunset.r).toBeGreaterThan(lightSunset.b);
    expect(lightOcean.b).toBeGreaterThan(lightOcean.r);
    for (const c of [lightSunset, lightOcean]) expect(Math.min(c.r, c.g, c.b)).toBeGreaterThan(225);

    // The browser chrome follows the page surface.
    const themeColor = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);
    expect(themeColor).toMatch(/^rgb\(/);
    const [r, , b] = themeColor.match(/\d+/g).map(Number);
    expect(r).toBeGreaterThan(b);
});

test('the neutral surface keeps the fixed greys under any accent', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    const swatches = page.getByRole('radiogroup', { name: 'Accent color' });
    const surfaces = page.getByRole('radiogroup', { name: 'Surface' });
    await expect(surfaces.getByRole('radio', { name: 'Tinted' })).toHaveAttribute('aria-checked', 'true');

    await swatches.getByRole('radio', { name: 'Sunset' }).click();
    const tinted = await surfaceRgb(page);
    expect(tinted.r).toBeGreaterThan(tinted.b);

    // Neutral previews live: the same accent, the original navy-grey page.
    await surfaces.getByRole('radio', { name: 'Neutral' }).click();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-surface'))).toBe('neutral');
    const neutralSunset = await surfaceRgb(page);
    expect(neutralSunset).toEqual({ r: 15, g: 17, b: 23 });
    await swatches.getByRole('radio', { name: 'Ocean' }).click();
    expect(await surfaceRgb(page)).toEqual(neutralSunset);
    // The accent itself still changes with the swatch.
    expect(await accentOf(page)).toBe('ocean');

    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.surface).toBe('neutral');
    expect(await page.evaluate(() => localStorage.getItem('goobster-surface'))).toBe('neutral');

    // Painted before React mounts, so a reload never flashes the tinted page.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-surface'))).toBe('neutral');
    expect(await surfaceRgb(page)).toEqual(neutralSunset);
    await expect(page.getByRole('radiogroup', { name: 'Surface' }).getByRole('radio', { name: 'Neutral' }))
        .toHaveAttribute('aria-checked', 'true');
    const themeColor = await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);
    expect(themeColor).toBe('rgb(15, 17, 23)');
});

test('the Music Lab follows the theme, the accent and the portal font', async ({ page }) => {
    await login(page);
    await page.request.patch('/api/app/settings/appearance', { data: { changes: { theme: 'light', accent: 'blueberry' } } });
    await page.evaluate(() => localStorage.setItem('goobster-theme', 'light'));
    await page.goto('/app/conservatory/chords');
    const play = page.locator('.play-button').first();
    await expect(play).toBeVisible();

    const read = () => page.evaluate(() => {
        const resolve = (v) => {
            const probe = document.createElement('span');
            probe.style.cssText = `position:fixed;transition:none;color:${v}`;
            document.body.appendChild(probe);
            const out = getComputedStyle(probe).color;
            probe.remove();
            return out;
        };
        const engine = document.querySelector('.rhythm-engine');
        const button = document.querySelector('.play-button');
        return {
            engineBg: getComputedStyle(engine).backgroundColor,
            raise: resolve('var(--bg-raise)'),
            buttonBg: getComputedStyle(button).backgroundColor,
            accent: resolve('var(--accent)'),
            buttonInk: getComputedStyle(button).color,
            ink: resolve('var(--accent-ink)'),
            titleFont: getComputedStyle(document.querySelector('.re-title')).fontFamily,
            bodyFont: getComputedStyle(document.body).fontFamily
        };
    });

    const light = await read();
    expect(light.engineBg).toBe(light.raise);
    expect(light.buttonBg).toBe(light.accent);
    expect(light.buttonInk).toBe(light.ink);
    expect(light.titleFont).toBe(light.bodyFont);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_music_lab_light.png' });

    await page.request.patch('/api/app/settings/appearance', { data: { changes: { accent: 'mint' } } });
    await page.reload();
    await expect(play).toBeVisible();
    const mint = await read();
    expect(mint.buttonBg).toBe(mint.accent);
    expect(mint.buttonBg).not.toBe(light.buttonBg);

    await page.request.patch('/api/app/settings/appearance', { data: { changes: { theme: 'dark' } } });
    await page.evaluate(() => localStorage.setItem('goobster-theme', 'dark'));
    await page.reload();
    await expect(play).toBeVisible();
    const dark = await read();
    expect(dark.engineBg).toBe(dark.raise);
    expect(dark.engineBg).not.toBe(light.engineBg);
    expect(dark.buttonInk).toBe(dark.ink);
});

test('navigation layout previews live and moves the rooms to a top bar', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#topbar')).toHaveCount(0);

    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    const topbar = page.locator('#topbar');
    await expect(topbar).toBeVisible();
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await expect(page.locator('.app')).toHaveClass(/nav-top/);

    // Same landmark and entries as the sidebar; the bar sits above the stage.
    const nav = topbar.getByRole('navigation', { name: 'Rooms' });
    await expect(nav.getByRole('link', { name: /Chat/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Activity/ })).toBeVisible();
    const barBox = await topbar.boundingBox();
    const stageBox = await page.locator('#stage').boundingBox();
    expect(barBox.y).toBe(0);
    expect(stageBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    expect(stageBox.x).toBeLessThan(20);

    // Discard puts the sidebar back without saving anything.
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(topbar).toHaveCount(0);

    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.navLayout).toBe('top');

    // Persisted: a reload renders the bar straight away, and the account
    // menu carries what the sidebar footer held.
    await page.reload();
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_settings.png' });

    await page.locator('#topbar').getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Chat/ }).click();
    await expect(page).toHaveURL(/\/app\/chat/);
    await expect(page.locator('#topbar a.nav-btn[data-room="chat"]')).toHaveClass(/active/);
    // The room header's ☰ opens a drawer this layout does not have, so it hides.
    await expect(page.locator('.icon-action.menu-btn').first()).toBeHidden();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_chat.png' });

    await page.getByRole('button', { name: 'Account menu' }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu.getByRole('menuitem', { name: /Usage/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Documentation/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Settings stays one click away from the bar (the tutorial anchor too).
    await page.locator('#topbar [data-tour="nav-settings"]').click();
    await expect(page).toHaveURL(/\/app\/settings/);

    // Back to the sidebar.
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Sidebar/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
});

test('with the bar on top, rooms centre on one column across a wide window', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await login(page);
    await page.request.patch('/api/app/settings/appearance', { data: { changes: { navLayout: 'top' } } });

    const centred = async (selector) => {
        const box = await page.locator(selector).first().boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs(box.x - (1920 - box.x - box.width))).toBeLessThanOrEqual(2);
        return box;
    };

    // Reading rooms fill a 1200px column instead of the sidebar-era 900px cap,
    // and the header's title starts where the column does.
    for (const [path, content] of [['/app/', '.home-shell'], ['/app/tools', '.tools-grid'], ['/app/activity/inbox', '.list-card'], ['/app/projects', '.obs-view']]) {
        await page.goto(path);
        const box = await centred(content);
        expect(box.width).toBeGreaterThan(1100);
        const header = await page.locator(path === '/app/' ? '.home-toolbar' : '.pane-header').first().evaluate((el) =>
            [...el.children].map((c) => c.getBoundingClientRect()).find((r) => r.width > 0).left);
        expect(Math.abs(header - box.x)).toBeLessThanOrEqual(2);
    }

    // People keeps its narrower reading column, centred inside the page
    // column rather than squeezed by the gutters (they pad the pane body,
    // which used to carry the cap itself and collapsed to nothing).
    await page.goto('/app/people/friends');
    const people = await centred('.people-column');
    expect(Math.round(people.width)).toBe(780);
    await expect(page.getByRole('heading', { name: 'Find someone' })).toBeVisible();
    const search = await page.getByRole('searchbox', { name: 'Find someone to add as a friend' }).boundingBox();
    expect(Math.round(search.width)).toBe(780);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_wide_people.png' });

    // Workspaces centre as one wider frame, and the bar lines up with it.
    await page.goto('/app/chat');
    const panel = await page.locator('#pane-chat .conversations-panel').boundingBox();
    const study = await page.locator('#pane-chat .study-main').boundingBox();
    expect(Math.round(panel.x)).toBe(220);
    expect(Math.round(study.x + study.width)).toBe(1700);
    const brand = await page.locator('#topbar .brand').boundingBox();
    expect(Math.abs(brand.x - panel.x)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_wide_chat.png' });

    await page.goto('/app/tools');
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_wide_tools.png' });
});

test('page width: full width lets every room reach the edges of a wide window', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await login(page);
    await page.request.patch('/api/app/settings/appearance', { data: { changes: { navLayout: 'top' } } });
    await page.goto('/app/settings/appearance');
    await expect(page.locator('#topbar')).toBeVisible();
    const pageWidth = () => page.evaluate(() => document.documentElement.getAttribute('data-page-width'));

    const widths = page.getByRole('radiogroup', { name: 'Page width' });
    await expect(widths.getByRole('radio', { name: /Centred/ })).toHaveAttribute('aria-checked', 'true');
    // Centred: Settings is a 1480px frame, so its side column starts at 220px.
    expect(Math.round((await page.locator('.settings-nav').boundingBox()).x)).toBe(220);

    // Previews live: the frame lets go and the column starts at the edge.
    await widths.getByRole('radio', { name: /Full width/ }).click();
    expect(await pageWidth()).toBe('full');
    expect(Math.round((await page.locator('.settings-nav').boundingBox()).x)).toBe(0);

    // Discard puts the frame back without saving anything.
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await pageWidth()).toBe('centered');
    expect(Math.round((await page.locator('.settings-nav').boundingBox()).x)).toBe(220);

    await widths.getByRole('radio', { name: /Full width/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.pageWidth).toBe('full');

    // Persisted: a reload paints it before the app mounts, and every kind of
    // room uses the window: a reading room, a workspace, and the bar itself.
    await page.reload();
    expect(await pageWidth()).toBe('full');
    await page.goto('/app/');
    const home = await page.locator('.home-shell').first().boundingBox();
    expect(home.width).toBeGreaterThan(1800);
    await page.goto('/app/chat');
    const panel = await page.locator('#pane-chat .conversations-panel').boundingBox();
    const study = await page.locator('#pane-chat .study-main').boundingBox();
    expect(Math.round(panel.x)).toBe(0);
    expect(Math.round(study.x + study.width)).toBe(1920);
    const brand = await page.locator('#topbar .brand').boundingBox();
    expect(brand.x).toBeLessThan(20);
    // The thread's measure widens from 780px once a conversation is open.
    const log = page.locator('#pane-chat .chat-log');
    if (await log.count()) expect(Math.round((await log.boundingBox()).width)).toBe(1120);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_full_width_chat.png' });

    // The thread widens in the sidebar layout as well; the rooms do not change there.
    await page.request.patch('/api/app/settings/appearance', { data: { changes: { navLayout: 'sidebar' } } });
    await page.goto('/app/chat');
    await expect(page.locator('#sidebar')).toBeVisible();
    expect(await pageWidth()).toBe('full');
    if (await log.count()) expect(Math.round((await log.boundingBox()).width)).toBe(1120);
});

test('icon style previews live, saves, paints before mount, and every language draws every glyph', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    const nav = page.locator('#sidebar nav[aria-label="Rooms"]');
    const iconStyle = () => page.evaluate(() => document.documentElement.getAttribute('data-icon-style') || 'emoji');

    // Emoji by default: the sidebar carries text glyphs and no SVG.
    await expect.poll(iconStyle).toBe('emoji');
    await expect(nav.locator('svg.glyph')).toHaveCount(0);
    await expect(nav.locator('.glyph-emoji').first()).toContainText('💬');

    // Previews live: picking Blocks swaps every room icon for an SVG.
    const picker = page.getByRole('radiogroup', { name: 'Icon style' });
    await picker.getByRole('radio', { name: /Blocks/ }).click();
    await expect.poll(iconStyle).toBe('blocks');
    await expect(nav.locator('.glyph-emoji')).toHaveCount(0);
    expect(await nav.locator('svg.glyph-blocks').count()).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_icon_style_blocks.png' });

    // Discard puts the emoji back without saving.
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect.poll(iconStyle).toBe('emoji');
    await expect(nav.locator('svg.glyph')).toHaveCount(0);

    // Every language draws every registry glyph: the picker's own sample
    // cards and, once painted, the sidebar, the settings nav and the view
    // tabs never fall back to emoji.
    for (const style of ['mono', 'blocks', 'sigils', 'pixel', 'neon', 'constellation']) {
        await picker.locator(`[data-icon-style="${style}"]`).click();
        await expect.poll(iconStyle).toBe(style);
        await expect(page.locator('#sidebar .glyph-emoji, .settings-nav .glyph-emoji')).toHaveCount(0);
        expect(await page.locator(`#sidebar svg.glyph-${style}`).count()).toBeGreaterThanOrEqual(6);
    }
    await picker.getByRole('radio', { name: /Pixel/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.iconStyle).toBe('pixel');

    // Persisted: a reload paints the style before the app mounts.
    await page.reload();
    await expect.poll(iconStyle).toBe('pixel');
    await expect(nav.locator('svg.glyph-pixel').first()).toBeVisible();
    await page.goto('/app/activity/inbox');
    await expect(page.locator('.activity-tab svg.glyph-pixel').first()).toBeVisible();
    await expect(page.locator('.activity-tab .glyph-emoji')).toHaveCount(0);
    await page.goto('/app/tools');
    await expect(page.locator('.tools-card-icon svg.glyph-pixel').first()).toBeVisible();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_icon_style_pixel_tools.png' });

    await page.goto('/app/settings/appearance');
    await picker.getByRole('radio', { name: /Emoji/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(nav.locator('svg.glyph')).toHaveCount(0);
});

test('text size and density paint live, save, and survive a reload', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    const rootFont = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const bodyFont = () => page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    const rowPadding = () => page.locator('.settings-field').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    const baseRoot = await rootFont();
    const baseBody = await bodyFont();
    const basePadding = await rowPadding();

    // Text size moves the root font and the portal's text follows (it is sized in rem).
    await page.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Large' }).click();
    expect(await rootFont()).toBeGreaterThan(baseRoot);
    expect(await bodyFont()).toBeGreaterThan(baseBody);
    await page.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Small' }).click();
    expect(await rootFont()).toBeLessThan(baseRoot);
    expect(await bodyFont()).toBeLessThan(baseBody);

    // Compact tightens the rows.
    await page.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' }).click();
    expect(await rowPadding()).toBeLessThan(basePadding);

    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values).toMatchObject({ textSize: 's', density: 'compact' });

    await page.reload();
    expect(await rootFont()).toBeLessThan(baseRoot);
    expect(await rowPadding()).toBeLessThan(basePadding);

    await page.getByRole('radiogroup', { name: 'Text size' }).getByRole('radio', { name: 'Medium' }).click();
    await page.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Comfortable' }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    expect(await rootFont()).toBe(baseRoot);
    expect(await rowPadding()).toBe(basePadding);
});

test('the top bar scrolls sideways on a phone instead of opening a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await page.goto('/app/chat');
    const topbar = page.locator('#topbar');
    await expect(topbar).toBeVisible();
    const nav = topbar.locator('.topbar-nav');
    const scrollable = await nav.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    await expect(page.locator('.icon-action.menu-btn').first()).toBeHidden();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_mobile.png' });

    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Sidebar/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
});
