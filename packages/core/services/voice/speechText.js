/**
 * Text sanitation for anything spoken aloud with TTS.
 *
 * URLs must never be narrated - a spoken reply reading out
 * "aitch tee tee pee ess colon slash slash..." is useless noise. Markdown
 * links keep their label; bare URLs (http(s)://, www., and Discord's
 * <url> embed-suppressed form) are removed entirely. Markdown syntax
 * (bold markers, backticks, heading hashes, list bullets) is dropped too,
 * keeping the words.
 *
 * This is the safety net. The plan is upstream: every voiced surface puts
 * spokenReplyContract (utils/chat/promptFragments) in its prompt so the
 * model does not write links, tables, or lists in the first place.
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

// Inline Markdown markers a TTS voice would otherwise pronounce ("asterisk
// asterisk"). Content is kept, only the syntax goes.
const INLINE_MARKUP_REGEX = /\*\*|__|~~|`/g;
// Block prefixes that only make sense at the start of a line: headings,
// bullets, numbered items, blockquotes. Numbered markers are matched
// conservatively (1-3 digits) so a sentence like "in 1999. Then" survives.
const LINE_PREFIX_REGEX = /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d{1,3}[.)][ \t]+|>[ \t]?)/;

/**
 * Drop Markdown syntax from text that is about to be spoken, keeping the
 * words. `atLineStart` says whether the chunk begins a line - the streamed
 * TTS feed splits at whitespace, so a mid-sentence "3. " must not be
 * mistaken for a list marker.
 * @param {string} text
 * @param {{ atLineStart?: boolean }} [opts]
 * @returns {string}
 */
function stripMarkupForSpeech(text, { atLineStart = true } = {}) {
    if (!text) return '';
    let out = String(text);
    if (atLineStart) out = out.replace(LINE_PREFIX_REGEX, '');
    // Prefixes after an embedded newline are always real line starts.
    out = out.replace(/\n[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d{1,3}[.)][ \t]+|>[ \t]?)/g, '\n');
    return out.replace(INLINE_MARKUP_REGEX, '');
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
    // Whether the next chunk begins a line (nothing emitted yet, or the
    // previous chunk ended with a newline) - the only place a list marker
    // or heading hash can legitimately be one.
    let atLineStart = true;

    // Emissions from write() always end at a whitespace split, so leading
    // whitespace on a later emission (e.g. the space left behind by a
    // stripped URL) is always a duplicate and safe to drop.
    const emit = (text) => {
        if (!text) return '';
        let out = stripMarkupForSpeech(stripUrls(text), { atLineStart });
        if (text.trim()) atLineStart = /\n[ \t]*$/.test(text);
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
    stripMarkupForSpeech,
    createStreamingUrlStripper
};
