/**
 * Jest config for optional live provider checks in `tests/live/`.
 *
 * These hit real APIs when the matching env var is set. They do not read
 * Discord credentials from config.json. Missing keys skip; invalid keys fail.
 */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/tests/live/*.live.test.js'],
    testTimeout: 45000,
    setupFiles: ['<rootDir>/tests/live/setup.js'],
    verbose: true,
    // Live HTTP clients can keep a socket around for a tick; do not hide
    // application leaks in the unit suite, but do not fail the live job on
    // a keep-alive handle either.
    forceExit: true
};
