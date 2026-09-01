const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2024
            }
        },
        rules: {
            // Existing code frequently keeps unused error vars in catch blocks
            // and unused function args for interface consistency.
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                varsIgnorePattern: '^_'
            }],
            // The codebase intentionally uses empty catch for best-effort cleanup.
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-console': 'off'
        }
    },
    {
        // The monorepo boundary: core is shared by every app and must never
        // reach into one. Apps import core; never the other way around.
        files: ['packages/core/**/*.js'],
        rules: {
            'no-restricted-modules': ['error', {
                patterns: ['@goobster/bot*', '**/apps/**']
            }]
        }
    },
    {
        // Panel + Activity + web app clients: browser ES modules, not Node CommonJS
        files: [
            'apps/bot/web/public/**/*.js',
            'apps/bot/web/activity/**/*.js',
            'apps/web/src/**/*.js',
            'apps/web/public/**/*.js'
        ],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser
            }
        }
    },
    {
        // Dual-use helpers (Jest require + Vite import). CommonJS with
        // both Node and browser globals (Buffer / btoa).
        files: ['apps/web/src/**/*.cjs'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.browser
            }
        }
    },
    {
        // AudioWorklet scripts run in the AudioWorkletGlobalScope, which has
        // its own globals (registerProcessor, sampleRate, the processor base
        // class) and no window/document.
        files: ['apps/web/public/liveAudioWorklet.js'],
        languageOptions: {
            sourceType: 'script',
            globals: {
                AudioWorkletProcessor: 'readonly',
                registerProcessor: 'readonly',
                sampleRate: 'readonly',
                currentTime: 'readonly'
            }
        }
    },
    {
        files: ['tests/**/*.js', '**/*.test.js'],
        languageOptions: {
            globals: {
                ...globals.jest
            }
        }
    },
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'cache/**',
            'logs/**',
            'coverage/**',
            'apps/web/dist/**'
        ]
    }
];
