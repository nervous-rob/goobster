import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const docsBuilder = createRequire(import.meta.url)('./docs/build.cjs');

/** Only the explicit shipped Markdown manifest can enter the public bundle. */
function documentationPlugin(): Plugin {
    const id = 'virtual:goobster-docs';
    const resolved = `\0${id}`;
    const repoRoot = path.resolve(root, '../..');
    const manifestPath = path.join(root, 'docs/manifest.json');
    return {
        name: 'goobster-documentation',
        resolveId(source) { if (source === id) return resolved; },
        load(source) {
            if (source !== resolved) return;
            const groups = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const corpus = docsBuilder.buildDocumentation(repoRoot, groups);
            this.addWatchFile(manifestPath);
            for (const page of corpus.pages) this.addWatchFile(path.join(repoRoot, page.source));
            return `export default ${JSON.stringify(corpus)};`;
        },
        handleHotUpdate({ file, server }) {
            if (file !== manifestPath && file !== path.join(repoRoot, 'README.md')
                && !file.startsWith(path.join(repoRoot, 'documentation') + path.sep)) return;
            const module = server.moduleGraph.getModuleById(resolved);
            if (module) server.moduleGraph.invalidateModule(module);
            server.ws.send({ type: 'full-reload' });
            return [];
        }
    };
}

/** Concatenate the token sheet + React extras to a non-hashed /app/style.css. */
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
    plugins: [react(), stableCssPlugin(), documentationPlugin()],
    base: '/app/',
    resolve: {
        alias: {
            '@music-lab': path.join(root, 'src/music-lab')
        }
    },
    optimizeDeps: {
        include: ['tone']
    },
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
