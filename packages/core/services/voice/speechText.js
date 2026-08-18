/**
 * Text sanitation for anything spoken aloud with TTS.
 *
 * URLs must never be narrated - a spoken reply reading out
 * "aitch tee tee pee ess colon slash slash..." is useless noise. Markdown
 * links keep their label; bare URLs (http(s)://, www., and Discord's
 * <url> embed-suppressed form) are removed entirely.
 */

// [label](https://...) -> label
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(\s*<?(?:https?:\/\/|www\.)[^)\s]*>?\s*\)/gi;
// <https://...> (embed-suppressed) and bare http(s)://... or www....
// Bare matches stop before trailing punctuation so sentence periods and
// closing parens/quotes around a link survive the removal.
const URL_REGEX = /<(?:https?:\/\/|www\.)[^\s>]*>|(?:https?:\/\/|www\.)[^\s]*[^\s.,!?;:)\]}"']/gi;
const WHITESPACE_REGEX = /\s/;

/**
 * Remove URLs without trimming, so streamed chunks keep their
 * inter-chunk spacing intact.
 */
function stripUrls(text) {
    if (!text) return '';
    return String(text)
        .replace(MARKDOWN_LINK_REGEX, '$1')
        .replace(URL_REGEX, '')
        .replace(/\(\s*\)/g, '')      // parens emptied by a removed URL
        .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Sanitize a complete reply for speech: strip URLs and tidy the edges.
 * @param {string} text
 * @returns {string} speakable text ('' when nothing speakable remains)
 */
function stripUrlsForSpeech(text) {
    return stripUrls(text).replace(/ +([,.!?;:])/g, '$1').trim();
}

/**
 * Stateful URL stripper for streamed TTS text (the realtime engine feeds
 * LLM deltas straight into the TTS socket, and a URL can arrive split
 * across many deltas). URLs never contain whitespace, so the trailing
 * unfinished "word" is held back until the next whitespace - or flush() -
 * proves it complete; everything before it is stripped and released.
 *
 * @returns {{ write: function(string): string, flush: function(): string }}
 */
function createStreamingUrlStripper() {
    let pending = '';
    let emitted = false;

    // Emissions from write() always end at a whitespace split, so leading
    // whitespace on a later emission (e.g. the space left behind by a
    // stripped URL) is always a duplicate and safe to drop.
    const emit = (text) => {
        let out = stripUrls(text);
        if (emitted) out = out.replace(/^[ \t]+/, '');
        if (out) emitted = true;
        return out;
    };

    return {
        /** Feed a delta; returns the text that is now safe to speak. */
        write(delta) {
            if (!delta) return '';
            pending += delta;
            let split = -1;
            for (let i = pending.length - 1; i >= 0; i--) {
                if (WHITESPACE_REGEX.test(pending[i])) {
                    split = i;
                    break;
                }
            }
            if (split === -1) return '';
            const ready = pending.slice(0, split + 1);
            pending = pending.slice(split + 1);
            return emit(ready);
        },
        /** End of input: release whatever is still held back. */
        flush() {
            const rest = pending;
            pending = '';
            return emit(rest);
        }
    };
}

module.exports = {
    stripUrlsForSpeech,
    createStreamingUrlStripper
};
