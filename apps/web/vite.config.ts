import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const docsBuilder = requireCjs('./docs/build.cjs');
const frontendChunks = requireCjs('../../scripts/lib/frontendChunks.js');

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

/**
 * Feature boundaries in the bundle (scripts/lib/frontendChunks.js): label the
 * module graph once it is built, then name every chunk (and its stylesheet)
 * that only one feature's rooms reach `assets/feature-<id>-…`. Rollup's own
 * code splitting is unchanged; only the file names carry the owner.
 */
function featureChunksPlugin(): Plugin {
    const rooms = requireCjs('./src/lib/rooms.cjs');
    const catalog = requireCjs('../../packages/core/features/catalog.js');
    const entries = new Map<string, string>(frontendChunks.featureRouteModules(rooms)
        .map(({ module, feature }: { module: string; feature: string }) => [path.join(root, 'src', module), feature]));
    const requires = frontendChunks.requiresOf(catalog);
    let labels = new Map<string, string>();
    const featureOf = (moduleIds: readonly string[]) => frontendChunks.chunkFeature(moduleIds, labels) as string | null;
    return {
        name: 'goobster-feature-chunks',
        apply: 'build',
        buildEnd() {
            for (const module of entries.keys()) {
                if (!this.getModuleInfo(module)) this.error(`lib/rooms.cjs names ${path.relative(root, module)}, which the build never loaded`);
            }
            labels = frontendChunks.labelModules({
                moduleIds: this.getModuleIds(),
                getModuleInfo: (id: string) => this.getModuleInfo(id),
                entries,
                requires
            });
        },
        closeBundle() {
            const dist = path.join(root, 'dist');
            const frontend = Object.fromEntries(catalog.FEATURE_IDS.map((id: string) => [id, catalog.FEATURES[id].payload?.frontend || []]));
            const analysis = frontendChunks.analyseDist(dist, { requires, frontend });
            if (analysis.violations.length) {
                this.error(`feature chunk closure broken: ${JSON.stringify(analysis.violations.slice(0, 10))}`);
            }
            frontendChunks.writeFeatureChunks(dist, analysis);
        },
        outputOptions(options) {
            return {
                ...options,
                chunkFileNames: (chunk) => {
                    const feature = featureOf(chunk.moduleIds);
                    return feature ? `assets/feature-${feature}-[name]-[hash].js` : 'assets/[name]-[hash].js';
                },
                assetFileNames: (asset) => {
                    const origin = (asset.originalFileNames || [])[0];
                    const feature = origin && /\.css$/.test(asset.names?.[0] || '') ? featureOf([path.resolve(root, origin)]) : null;
                    return feature ? `assets/feature-${feature}-[name]-[hash][extname]` : 'assets/[name]-[hash][extname]';
                }
            };
        }
    };
}

export default defineConfig({
    plugins: [react(), stableCssPlugin(), documentationPlugin(), featureChunksPlugin()],
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
        sourcemap: true,
        manifest: true
    }
});
