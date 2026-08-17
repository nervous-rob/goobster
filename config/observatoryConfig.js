require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../config.json');
} catch {
    // config.json optional at load time
}

const observatory = fileConfig.observatory || {};

/** Clamp a numeric knob into [min, max], falling back to def when unset/invalid. */
function bounded(value, def, min, max) {
    // Number(null) and Number('') are 0, which would read as "the operator
    // asked for the tightest possible limit" rather than "not configured".
    if (value === null || value === undefined || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

/**
 * Centralized configuration for the Observatory (the `observatory` tool):
 * persistent, per-user simulation projects layered ON TOP of the code
 * sandbox. Resolution order matches config/sandboxConfig.js: environment
 * variable first, then config.json, then a default.
 *
 * The whole feature is OPT-IN (`observatory.enabled`, default off) and it
 * additionally requires the sandbox itself to be enabled - the Observatory
 * grants persistence, never new execution powers. Every limit has a hard
 * ceiling so a config typo can never remove a guardrail.
 */
module.exports = {
    /** Master switch. Off = the observatory tool is not registered at all. */
    enabled: process.env.GOOBSTER_OBSERVATORY_ENABLED === '1'
        || process.env.GOOBSTER_OBSERVATORY_ENABLED === 'true'
        || observatory.enabled === true,

    /**
     * Where the tool may run: 'web' (default - only the authenticated web
     * app chat, the smallest audience) or 'everywhere' (Discord chat too).
     */
    scope: (process.env.GOOBSTER_OBSERVATORY_SCOPE || observatory.scope) === 'everywhere'
        ? 'everywhere'
        : 'web',

    /** Projects one user may keep. */
    maxProjectsPerUser: bounded(observatory.maxProjectsPerUser, 5, 1, 200),
    /** Disk quota per project workspace (MB), enforced before every run. */
    // Real observational data (NIRCam cutouts run hundreds of MB) needs a
    // real shelf; this is a cap, not an allocation - disk is only spent on
    // what a project actually stores.
    maxProjectMb: bounded(observatory.maxProjectMb, 1024, 1, 102_400),
    /** Background jobs one user may have RUNNING at once. */
    maxActiveJobsPerUser: bounded(observatory.maxActiveJobsPerUser, 1, 1, 50),
    /**
     * Checkpoint resumes per job: a background job killed at the sandbox's
     * timeout wall is restarted from its own checkpoint.json at most this
     * many times, converting "one huge run" into many small legal runs.
     */
    maxResumes: bounded(observatory.maxResumes, 12, 0, 500),
    /** Files listed / collected from a project workspace per query. */
    maxWorkspaceFiles: bounded(observatory.maxWorkspaceFiles, 50, 1, 5_000),
    /** Frames the render pipeline will stitch into one video. */
    maxRenderFrames: bounded(observatory.maxRenderFrames, 2_000, 2, 100_000),
    /** Default (and clamp range for the requested) render framerate. */
    renderFps: bounded(observatory.renderFps, 24, 1, 120),

    /** ffmpeg binary used by the frame->video render pipeline. */
    ffmpegCommand: process.env.GOOBSTER_OBSERVATORY_FFMPEG
        || observatory.ffmpegCommand
        || 'ffmpeg'
};
