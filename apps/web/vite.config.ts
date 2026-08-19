import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Concatenate the token sheet + React extras to a non-hashed /app/next/style.css. */
function syncStableCss() {
    const legacy = fs.readFileSync(path.join(root, 'src/legacy.css'), 'utf8');
    const extra = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8')
        .replace(/@import\s+['"][^'"]+['"];\s*/u, '');
    const publicDir = path.join(root, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(
        path.join(publicDir, 'style.css'),
        `/* Generated from src/legacy.css + src/styles.css. Do not edit. */\n${legacy}\n${extra}`
    );
}

function stableCssPlugin(): Plugin {
    return {
        name: 'goobster-stable-css',
        configResolved() {
            syncStableCss();
        },
        buildStart() {
            syncStableCss();
        }
    };
}

export default defineConfig({
    plugins: [react(), stableCssPlugin()],
    base: '/app/next/',
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:3000',
            '/app/vendor': 'http://127.0.0.1:3000'
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    }
});
