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
        // Panel + Activity clients: browser ES modules, not Node CommonJS
        files: ['web/public/**/*.js', 'web/activity/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser
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
            'coverage/**'
        ]
    }
];
