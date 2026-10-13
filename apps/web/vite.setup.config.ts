import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const brand = requireCjs('./brand.config.cjs') as { productName: string };

/** The product name for setup.html and src/lib/brand.ts (apps/web/brand.config.cjs is the rename point). */
function brandPlugin(): Plugin {
    return {
        name: 'goobster-setup-brand',
        transformIndexHtml(html) {
            return html.replace(/%PRODUCT_NAME%/g, brand.productName);
        }
    };
}

/** The manager serves `/manager/` from index.html, so the bundle's page is renamed to match. */
function renameEntryPlugin(): Plugin {
    return {
        name: 'goobster-setup-entry',
        enforce: 'post',
        generateBundle(_options, bundle) {
            const page = bundle['setup.html'];
            if (!page) this.error('The setup build produced no setup.html');
            page.fileName = 'index.html';
        }
    };
}

/**
 * The setup client (documentation/setup_wizard.md): the page the installation
 * manager serves at /manager/, built into dist/setup beside the portal. It is
 * its own entry with no feature chunks; nothing in it is a feature's, so every
 * file is core (scripts/lib/frontendChunks.js checkSetupClient). The portal
 * build (vite.config.ts) runs this one after it finishes.
 */
export default defineConfig({
    root,
    plugins: [react(), brandPlugin(), renameEntryPlugin()],
    base: '/manager/',
    define: { __PRODUCT_NAME__: JSON.stringify(brand.productName) },
    publicDir: false,
    build: {
        outDir: path.join(root, 'dist', 'setup'),
        emptyOutDir: true,
        sourcemap: false,
        manifest: false,
        rollupOptions: { input: path.join(root, 'setup.html') }
    }
});
