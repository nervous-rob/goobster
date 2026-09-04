const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.GOOBSTER_E2E_PORT || 4173);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
    testDir: './e2e',
    testMatch: '*.spec.js',
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    expect: { timeout: 12_000 },
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: BASE_URL,
        headless: true,
        viewport: { width: 1280, height: 800 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'node e2e/server.js',
        url: `${BASE_URL}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
            ...process.env,
            GOOBSTER_E2E_PORT: String(PORT)
        }
    }
});
