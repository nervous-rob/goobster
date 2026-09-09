const { skipReasonFor } = require('../../scripts/lib/liveCredentials');

/**
 * Skip a live provider describe when its env var is absent. The skip
 * reason is in the suite title so CI summaries can show it.
 */
function describeLive(providerId, fn) {
    const reason = skipReasonFor(providerId);
    const title = reason
        ? `${providerId} live — skipped (${reason})`
        : `${providerId} live`;
    (reason ? describe.skip : describe)(title, fn);
    return reason;
}

const PING = 'Reply with the single word pong and nothing else.';

module.exports = { describeLive, PING };
