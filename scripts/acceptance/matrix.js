'use strict';

/**
 * The acceptance matrix as intended (documentation/release_acceptance.md): the cells the workflow
 * runs on hosted runners and the cells no hosted runner can give, each with its reason. The
 * workflow file, the report and the specs read this one list so they cannot drift apart.
 */

const TARGETS = Object.freeze([
    { id: 'linux-x64', runner: 'ubuntu-24.04', os: 'linux' },
    { id: 'linux-arm64', runner: 'ubuntu-24.04-arm', os: 'linux' },
    { id: 'darwin-arm64', runner: 'macos-15', os: 'macos' },
    { id: 'darwin-x64', runner: 'macos-15-intel', os: 'macos' },
    { id: 'win32-x64', runner: 'windows-2022', os: 'windows' }
]);

function hostedCells() {
    const cells = [];
    for (const target of TARGETS.filter((item) => item.os === 'linux')) {
        for (const install of ['new', 'adopt']) {
            for (const db of ['sqlite', 'managed-pg']) {
                for (const features of ['minimal', 'representative']) {
                    cells.push({ platform: target.id, runner: target.runner, install, db, features });
                }
            }
        }
    }
    for (const target of TARGETS.filter((item) => item.os !== 'linux')) {
        cells.push({ platform: target.id, runner: target.runner, install: 'new', db: 'sqlite', features: 'minimal' });
    }
    return cells;
}

/** Cells no hosted runner can run, and why. Rendered as `deferred` in every column. */
const DEFERRED = Object.freeze([
    {
        platform: 'linux-arm64 (Raspberry Pi 4B)', install: 'adopt', db: 'sqlite', features: 'representative',
        reason: 'Pi hardware: no hosted runner is a Raspberry Pi. linux-arm64 itself is proven on the hosted arm runner; the Pi\'s memory, SD-card I/O and thermal limits are not.'
    },
    {
        platform: 'linux-x64', install: 'new', db: 'existing-pg', features: 'representative',
        reason: 'A hosted Postgres service container has a superuser the application is never given; the existing-server path (a role without superuser, extensions pre-created by an administrator) needs a server that matches a real deployment. The driver runs this cell against any server named by GOOBSTER_ACCEPTANCE_PG_URL; it was run locally once (see the results).'
    },
    {
        platform: 'linux-x64', install: 'new', db: 'sqlite', features: 'full',
        reason: 'The full profile with real provider keys: the keys are secrets this workflow never receives, and a full payload without them proves nothing the representative payload does not.'
    },
    {
        platform: 'darwin-arm64', install: 'new', db: 'managed-pg', features: 'minimal',
        reason: 'Desktop PostgreSQL (Docker Desktop on macOS): hosted macOS runners have no container runtime.'
    },
    {
        platform: 'win32-x64', install: 'new', db: 'managed-pg', features: 'minimal',
        reason: 'Desktop PostgreSQL (Docker Desktop on Windows): hosted Windows runners cannot run Linux containers.'
    },
    {
        platform: 'linux-x64', install: 'major upgrade', db: 'sqlite', features: 'minimal',
        reason: 'Major upgrades (a release that changes the database schema, and the recovery decision that follows a failed one): the fake release in this driver changes only a version.'
    }
]);

module.exports = { TARGETS, hostedCells, DEFERRED };
