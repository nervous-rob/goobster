/**
 * Shared model-facing prompt fragments.
 *
 * Surface-specific prompts (Tavern narrator, Spitball pipeline, attention
 * triage) stay next to their callers. Anything that must not drift — identity
 * fallback, the retired slash-protocol ban, portal/parlor rich rendering,
 * personality-directive labels, NL→cron — lives here.
 */

const FALLBACK_PERSONALITY = 'You are Goobster, a quirky and clever Discord bot.';

/** Retired reply protocol. Live search/image are tools; searchFlow still parses slips. */
const SLASH_PROTOCOL_BAN = 'Never emit /search or /generate slash text; those are tools now.';

/**
 * Mini-app sandbox + Observatory read bridge. Shared by the web portal chat
 * pack and parlor rendering so the two surfaces cannot teach different APIs.
 */
const MINI_APP_BRIDGE =
    'Mini-apps run on an opaque origin and cannot fetch /api/app themselves. '
    + 'An app asset rendered inside its own project may read that project\'s workspace with no meta tag. '
    + 'Cross-project reads still declare <meta name="goobster-observatory-read" content="other-project-slug">. '
    + 'Then const port = await connectToGoobster(); request(port, { type: \'observatory.read\', project, path, responseType: \'json\'|\'text\'|\'dataurl\' }). '
    + 'The user is prompted the first time for a cross-project read. Never ask for allow-same-origin.';

/**
 * How rich replies render on a web surface.
 * @param {{ surface?: 'portal'|'parlor' }} [opts]
 * @returns {string}
 */
function richRenderingContract({ surface = 'portal' } = {}) {
    if (surface === 'parlor') {
        return `RENDERING (the parlor renders rich replies):
- LaTeX math renders beautifully: use \\( ... \\) for inline math and \\[ ... \\] or $$ ... $$ for display math. Prefer LaTeX over ASCII art for any formula.
- Mini-apps: a fenced \`\`\`html code block containing ONE complete, self-contained HTML document (all CSS and JS inline, no external network resources) renders as a live, interactive, sandboxed app right in the discussion. When the user asks you to build something visual, interactive, or playable - a demo, visualization, simulator, calculator, game, or mock-up - put the full document in such a block instead of describing it, attaching a file, or linking anywhere. The few-short-paragraphs rule does not apply to that code block. ${MINI_APP_BRIDGE}`;
    }
    return `WEB PORTAL: This chat renders Markdown, LaTeX (\\( inline \\), \\[ display \\]), and a fenced html block as a live mini-app. Prefer those over ASCII when they help. ${MINI_APP_BRIDGE}`;
}

/**
 * Operator/user personality overlay. Chat, voice, and leftover command
 * paths must use the same SERVER vs DM label (DM scope is not a guild).
 * @param {{ isGuild?: boolean, directive?: string|null }} opts
 * @returns {string|null}
 */
function personalityDirectiveBlock({ isGuild = true, directive = null } = {}) {
    const text = String(directive || '').trim();
    if (!text) return null;
    return `${isGuild ? 'SERVER' : 'DM'} DIRECTIVE (wins on conflict):\n${text}`;
}

/**
 * System prompt for the cheap NL → 5-part cron converter used by /automation
 * and /digest schedule. UTC; respond with the expression or INVALID.
 */
const CRON_FROM_NL_SYSTEM = `You are a cron expression converter. Convert any natural language scheduling description into a cron expression.
Only respond with the cron expression, nothing else.
Format: minute hour day-of-month month day-of-week

Always use the standard 5-part cron format with EXACTLY one space between each part (no extra spaces).
The format must be strictly: "m h dom mon dow" where each part is separated by exactly one space.

Examples:
- "every day at 9am" -> "0 9 * * *"
- "every Monday at 3:30pm" -> "30 15 * * 1"
- "every hour" -> "0 * * * *"
- "every 30 minutes" -> "*/30 * * * *"
- "at 2:45pm on weekdays" -> "45 14 * * 1-5"
- "weekday mornings" -> "0 9 * * 1-5"
- "weekend afternoons" -> "0 14 * * 0,6"

Be flexible and creative in interpreting the input. If the input is ambiguous, make a reasonable assumption.
If you're unsure about the exact interpretation, choose a reasonable default that matches the spirit of the request.

IMPORTANT: Your response must ONLY be a 5-part cron expression with one space between each part, matching this pattern: "m h dom mon dow"
If the input is completely invalid or impossible to interpret, respond with "INVALID"`;

/**
 * Grounded /recall answer prompt. Graph notes are primary; raw memories
 * are supporting excerpts; the legacy facts table is a last-resort mirror.
 * @param {{ memoryLines?: string[], graphExcerpt?: string|null, legacyFacts?: string[] }} opts
 * @returns {string}
 */
function groundedRecallPrompt({ memoryLines = [], graphExcerpt = null, legacyFacts = [] } = {}) {
    const parts = [
        'You are Goobster, answering a question from this server\'s knowledge graph and long-term memory. '
        + 'Answer ONLY from the notes and excerpts below — never invent details. '
        + 'Knowledge-graph notes are distilled; memory excerpts are raw conversation (newest context wins on conflicts). '
        + 'If they do not fully answer the question, say what you do remember and be upfront about the gaps. '
        + 'Mention who said things and roughly when, when that helps. Keep it under 150 words, with your usual light personality.'
    ];
    if (graphExcerpt) {
        parts.push(`SERVER NOTES (knowledge graph):\n${graphExcerpt}`);
    }
    if (memoryLines.length > 0) {
        parts.push(`MEMORY EXCERPTS (retrieved by similarity):\n${memoryLines.join('\n')}`);
    }
    if (!graphExcerpt && legacyFacts.length > 0) {
        parts.push(`LEGACY SERVER FACTS (compatibility mirror — use only if the excerpts do not cover it):\n${legacyFacts.map(f => `- ${f}`).join('\n')}`);
    }
    return parts.join('\n\n');
}

module.exports = {
    FALLBACK_PERSONALITY,
    SLASH_PROTOCOL_BAN,
    MINI_APP_BRIDGE,
    CRON_FROM_NL_SYSTEM,
    richRenderingContract,
    personalityDirectiveBlock,
    groundedRecallPrompt
};
