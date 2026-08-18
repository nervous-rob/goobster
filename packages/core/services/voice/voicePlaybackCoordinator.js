/**
 * Shared borrow/restore contract for the per-guild voice connection.
 *
 * A Discord voice connection plays exactly one AudioPlayer at a time, so
 * any speech playback (TTS replies, /speak, DJ chatter) that subscribes its
 * own player evicts whatever was playing before it - usually music, whose
 * player then sits in AutoPaused (NoSubscriberBehavior.Pause) with nobody
 * ever handing the connection back. These helpers make that hand-back
 * explicit: capture the displaced player before speaking, and restore it
 * once speech ends (re-subscribing an AutoPaused player resumes it
 * automatically).
 *
 * The same pattern already existed ad hoc in notificationSounds.js (cues)
 * and commands/music/aidj.js (speakWithDuck); TTS engines now share it.
 */

/**
 * The player currently subscribed to a connection, if any.
 */
function getSubscribedPlayer(connection) {
    return connection?.state?.subscription?.player || null;
}

/**
 * Capture the player that speech playback is about to displace.
 * Returns null when nothing is subscribed, or when the subscriber is the
 * speech player itself (back-to-back replies must not "restore" the TTS
 * player and lose track of the music player displaced earlier).
 *
 * @param {Object} connection - Discord voice connection
 * @param {Object} ownPlayer - the speech AudioPlayer that will subscribe
 * @returns {Object|null} the displaced player to restore afterwards
 */
function captureDisplacedPlayer(connection, ownPlayer) {
    const current = getSubscribedPlayer(connection);
    return current && current !== ownPlayer ? current : null;
}

/**
 * Hand the connection back to the displaced player after speech ends.
 * A no-op when there was nothing to restore, or when something else (a
 * newer speech player, a notification cue) claimed the subscription in the
 * meantime - the newest claimant owns the hand-back then.
 *
 * @param {Object} connection - Discord voice connection
 * @param {Object} ownPlayer - the speech AudioPlayer being released
 * @param {Object|null} displacedPlayer - result of captureDisplacedPlayer
 * @returns {boolean} whether the displaced player got the connection back
 */
function restoreDisplacedPlayer(connection, ownPlayer, displacedPlayer) {
    if (!displacedPlayer || displacedPlayer === ownPlayer) return false;
    try {
        if (getSubscribedPlayer(connection) !== ownPlayer) return false;
        connection.subscribe(displacedPlayer);
        return true;
    } catch {
        return false; // connection already torn down
    }
}

module.exports = {
    getSubscribedPlayer,
    captureDisplacedPlayer,
    restoreDisplacedPlayer
};
