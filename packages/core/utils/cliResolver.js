const { spawn } = require('child_process');

/**
 * Shared CLI auto-discovery for external tools (spotdl, yt-dlp).
 *
 * The old per-service probes swallowed every failure mode into a generic
 * "CLI not found", which made real-world breakage undiagnosable: a venv
 * orphaned by an OS Python upgrade exits with ModuleNotFoundError, a binary
 * for the wrong architecture dies with SIGSEGV, a permissions problem is
 * EACCES - all very different fixes. This resolver records *why* each
 * candidate failed and surfaces that in the thrown error, so the Discord
 * reply / logs tell the operator what is actually wrong.
 */

// Generous ceiling: `spotdl --version` imports a heavy Python stack and can
// take >10s on a Raspberry Pi. Without a ceiling one wedged candidate
// (e.g. a binary on an unresponsive network mount) hangs the command forever.
const PROBE_TIMEOUT_MS = 30000;

/** Max length of the stderr detail kept per candidate. */
const REASON_DETAIL_MAX = 160;

function describeSpawnError(err) {
    if (err && err.code === 'ENOENT') return 'not found';
    if (err && err.code === 'EACCES') return 'not executable (EACCES)';
    return (err && (err.code || err.message)) || 'failed to start';
}

/**
 * The most informative stderr line is usually the last non-empty one
 * (Python tracebacks end with the actual exception).
 * @param {string} stderr
 * @returns {string}
 */
function lastStderrLine(stderr) {
    const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    return last.length > REASON_DETAIL_MAX ? `${last.slice(0, REASON_DETAIL_MAX)}...` : last;
}

/**
 * Probe one candidate by running `<cmd> [...baseArgs] --version`.
 * Never rejects. On success, `versionOutput` carries the trimmed stdout so
 * callers can gate version-specific CLI flags.
 * @param {{cmd: string, baseArgs?: string[]}} candidate
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, versionOutput: string} | {ok: false, reason: string}>}
 */
function probeCommand(candidate, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return new Promise(resolve => {
        let probe;
        try {
            probe = spawn(candidate.cmd, [...(candidate.baseArgs || []), '--version']);
        } catch (err) {
            resolve({ ok: false, reason: describeSpawnError(err) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            probe.kill('SIGKILL');
            settle({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);

        probe.stdout?.on('data', d => {
            if (stdout.length < 4096) stdout += d.toString();
        });
        probe.stderr?.on('data', d => {
            if (stderr.length < 4096) stderr += d.toString();
        });
        probe.on('error', err => settle({ ok: false, reason: describeSpawnError(err) }));
        probe.on('close', (code, signal) => {
            if (code === 0) {
                settle({ ok: true, versionOutput: stdout.trim() });
            } else if (signal) {
                settle({ ok: false, reason: `killed by ${signal}` });
            } else {
                const detail = lastStderrLine(stderr);
                settle({ ok: false, reason: `exited with code ${code}${detail ? `: ${detail}` : ''}` });
            }
        });
    });
}

/**
 * Try candidates in order and return the first whose `--version` probe
 * succeeds. When none work, throw an error that keeps the actionable
 * install hint first and appends what was tried and why each failed.
 *
 * @param {Array<{cmd: string, baseArgs?: string[], label?: string}>} candidates
 * @param {{name: string, installHint: string, timeoutMs?: number}} options
 *        name: CLI name for the error message (e.g. "spotdl");
 *        installHint: actionable install/config guidance;
 *        label: optional per-candidate prefix in diagnostics (e.g. marking
 *        the config.json override so "I set the path!" reports make sense).
 * @returns {Promise<{cmd: string, baseArgs: string[], versionOutput: string}>}
 */
async function resolveCliCommand(candidates, { name, installHint, timeoutMs } = {}) {
    const failures = [];
    for (const candidate of candidates) {
        const result = await probeCommand(candidate, { timeoutMs });
        if (result.ok) {
            return { cmd: candidate.cmd, baseArgs: candidate.baseArgs || [], versionOutput: result.versionOutput };
        }
        const invocation = [candidate.cmd, ...(candidate.baseArgs || [])].join(' ');
        const label = candidate.label ? `${candidate.label} ` : '';
        failures.push(`${label}"${invocation}" (${result.reason})`);
    }

    const diagnostics = `Tried: ${failures.join('; ')}.`;
    console.error(`${name} CLI resolution failed. ${diagnostics}`);
    throw new Error(`${name} CLI not found. ${installHint} ${diagnostics}`);
}

module.exports = { resolveCliCommand, probeCommand };
