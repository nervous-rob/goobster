module.exports = {
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    verbose: true,
    testTimeout: 10000,
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1'
    }
}; 