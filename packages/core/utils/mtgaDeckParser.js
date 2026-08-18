/**
 * Parser for Magic: The Gathering Arena's "Export to clipboard" deck text.
 *
 * Arena exports look like this (the About block and the set/collector
 * suffixes are optional, and older exports omit the section headers
 * entirely - a blank line then separates maindeck from sideboard):
 *
 *   About
 *   Name My Izzet Aggro
 *
 *   Deck
 *   4 Lightning Strike (DMU) 137
 *   20 Mountain (DMU) 269
 *
 *   Sideboard
 *   2 Abrade (VOW) 139
 *
 * Commander/Brawl exports add "Commander" and "Companion" sections. Card
 * names may contain apostrophes, commas, and the "//" of split cards; the
 * set/collector suffix is only treated as such when it matches Arena's
 * exact "(SET) number" shape at the end of the line, so a card name that
 * happens to end in parentheses is never truncated.
 *
 * Parsing is deterministic and dependency-free: no card database is
 * consulted, so anything shaped like a card line is accepted verbatim.
 */

const SECTION_NAMES = new Map([
    ['deck', 'main'],
    ['mainboard', 'main'],
    ['main', 'main'],
    ['sideboard', 'sideboard'],
    ['commander', 'commander'],
    ['companion', 'companion']
]);

// "4 Lightning Strike (DMU) 137" -> count, name, set code, collector number.
// The suffix match is anchored at the end of the line; collector numbers can
// carry letters (e.g. "331a", "GR-8").
const CARD_LINE = /^(\d{1,3})\s+(.+?)(?:\s+\(([A-Za-z0-9]{2,8})\)\s+([A-Za-z0-9-]{1,10}))?$/;

const MAX_TEXT_LENGTH = 40000;
const MAX_LINES_PER_DECK = 500;
const MAX_COUNT_PER_LINE = 250;

/** Machine-readable parse failure (status/code, the web error contract). */
class DeckParseError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DeckParseError';
        this.status = 400;
        this.code = code;
    }
}

/**
 * Parse one Arena deck export.
 * @param {string} text - the pasted export text
 * @returns {{ name: string|null, cards: Array<{ board: string, count: number,
 *   name: string, setCode: string|null, collectorNumber: string|null }>,
 *   counts: Object, rawText: string }}
 * @throws {DeckParseError} when nothing card-shaped is found
 */
function parseDeck(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) {
        throw new DeckParseError('EMPTY_DECK', 'Paste a deck first.');
    }
    if (raw.length > MAX_TEXT_LENGTH) {
        throw new DeckParseError('DECK_TOO_LARGE',
            `That paste is too large (max ${MAX_TEXT_LENGTH} characters per deck).`);
    }

    const lines = raw.split(/\r?\n/);
    if (lines.length > MAX_LINES_PER_DECK) {
        throw new DeckParseError('DECK_TOO_LARGE',
            `That deck has too many lines (max ${MAX_LINES_PER_DECK}).`);
    }

    let deckName = null;
    let inAbout = false;
    // Header-less exports: the first block is the maindeck and a blank line
    // switches to the sideboard. Explicit section headers always win.
    let sawHeader = false;
    let board = 'main';
    let blankBreaks = 0;
    const cards = [];
    const problems = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (!sawHeader && cards.length > 0) blankBreaks += 1;
            inAbout = false;
            continue;
        }

        const lower = trimmed.toLowerCase();
        if (lower === 'about') {
            inAbout = true;
            continue;
        }
        if (inAbout) {
            const nameMatch = trimmed.match(/^name\s+(.+)$/i);
            if (nameMatch) deckName = nameMatch[1].trim();
            // Other About lines (theme, etc.) are ignored.
            continue;
        }
        if (SECTION_NAMES.has(lower)) {
            sawHeader = true;
            board = SECTION_NAMES.get(lower);
            continue;
        }

        const match = trimmed.match(CARD_LINE);
        if (!match) {
            problems.push(trimmed.slice(0, 80));
            continue;
        }
        const count = Number(match[1]);
        if (count < 1 || count > MAX_COUNT_PER_LINE) {
            problems.push(trimmed.slice(0, 80));
            continue;
        }
        cards.push({
            board: sawHeader ? board : (blankBreaks >= 1 ? 'sideboard' : 'main'),
            count,
            name: match[2].trim(),
            setCode: match[3] ? match[3].toUpperCase() : null,
            collectorNumber: match[4] || null
        });
    }

    if (cards.length === 0) {
        throw new DeckParseError('NO_CARDS',
            'No card lines found - paste the text Arena copies with "Export to clipboard" '
            + '(lines like "4 Lightning Strike (DMU) 137").');
    }
    // A paste that is mostly noise is more likely the wrong clipboard than
    // a deck with a few odd lines - refuse instead of importing garbage.
    if (problems.length > cards.length) {
        throw new DeckParseError('NOT_A_DECK',
            `Most of that paste doesn't look like deck lines (e.g. "${problems[0]}").`);
    }

    const counts = { main: 0, sideboard: 0, commander: 0, companion: 0 };
    for (const card of cards) counts[card.board] += card.count;

    return { name: deckName, cards, counts, rawText: raw.trim() };
}

/**
 * Split a paste that may contain several Arena exports back-to-back (each
 * deck starts at an "About" or "Deck" header after the first) and parse
 * each. A paste with a single deck yields a one-element array.
 * @param {string} text
 * @returns {Array<ReturnType<typeof parseDeck>>}
 * @throws {DeckParseError}
 */
function parseDeckList(text) {
    const raw = String(text ?? '');
    if (raw.length > MAX_TEXT_LENGTH) {
        throw new DeckParseError('DECK_TOO_LARGE',
            `That paste is too large (max ${MAX_TEXT_LENGTH} characters).`);
    }
    const lines = raw.split(/\r?\n/);
    const chunks = [];
    let current = [];
    let sawContent = false;
    for (const line of lines) {
        const lower = line.trim().toLowerCase();
        // A new "About" always starts a new deck; a new "Deck" only does when
        // the current chunk already has card lines under a Deck section
        // (i.e. we've clearly moved into a second export).
        const startsNewDeck = sawContent && (
            lower === 'about'
            || (lower === 'deck' && current.some(l => SECTION_NAMES.has(l.trim().toLowerCase())))
        );
        if (startsNewDeck) {
            chunks.push(current.join('\n'));
            current = [line];
            sawContent = true;
            continue;
        }
        current.push(line);
        if (lower) sawContent = true;
    }
    if (current.some(l => l.trim())) chunks.push(current.join('\n'));

    if (chunks.length === 0) {
        throw new DeckParseError('EMPTY_DECK', 'Paste a deck first.');
    }
    return chunks.map(chunk => parseDeck(chunk));
}

module.exports = { parseDeck, parseDeckList, DeckParseError, MAX_TEXT_LENGTH };
