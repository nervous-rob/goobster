/**
 * The spoken briefing (DA-7c; documentation/delegated_conversation.md,
 * "Hearing a briefing"; delegated_assistant_architecture.md section 13.1;
 * ADR 0024).
 *
 * `compose()` turns the Home projection (assistantHomeService.project) into
 * a few sentences written to be heard: the same counts Home shows, the
 * titles under Needs you and up to three findings. It reads nothing itself
 * and decides nothing: every number comes from the projection, and a
 * section the projection could not read is said to be unknown, never zero.
 *
 * `brief()` reads the projection for one person, composes it, and records
 * that the updates it names reached them (`deliveredRevision`, ADR 0017).
 * Delivery is not acknowledgment: nothing is marked seen, read, reviewed
 * or decided, so Home and the Inbox show the same thing afterwards.
 *
 * Who may hear it is the caller's check (utils/tools/assistant.js): only
 * the person's own voice session, never a shared voice channel.
 */

const logger = require('../../utils/logger');

/** Needs-you titles spoken; Home previews the same number. */
const MAX_NEEDS_YOU = 5;
const MAX_FINDINGS = 3;
const TITLE_MAX = 140;
const SUMMARY_MAX = 220;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];

/** A count the way a person says it; digits past twelve. */
function sayNumber(count) {
    const n = Number(count);
    return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * A title or summary as words only: no link, markup or line break, cut at
 * a word, and without closing punctuation (the sentence around it adds its
 * own). Empty when nothing speakable is left.
 */
function speakable(value, max) {
    let text = String(value == null ? '' : value)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<?(?:https?:\/\/|www\.)[^\s>]*>?/gi, ' ')
        .replace(/[*_`#>|~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > max) {
        const cut = text.slice(0, max);
        const space = cut.lastIndexOf(' ');
        text = (space > max / 2 ? cut.slice(0, space) : cut).trim();
    }
    return text.replace(/[\s.,;:!?-]+$/, '');
}

/** The first sentence of a summary, when it has one. */
function firstSentence(value) {
    const text = speakable(value, 2000);
    const end = text.search(/[.!?](\s|$)/);
    return speakable(end > 0 ? text.slice(0, end) : text, SUMMARY_MAX);
}

/** "forty minutes ago", from a timestamp and now. */
function ago(iso, now) {
    const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
    if (!Number.isFinite(minutes)) return null;
    if (minutes < 1) return 'less than a minute ago';
    if (minutes < 90) return `${sayNumber(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${sayNumber(hours)} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${sayNumber(days)} day${days === 1 ? '' : 's'} ago`;
}

function statusSentence(projection) {
    const counts = projection.responsibilities?.counts || null;
    if (projection.hostPaused && projection.availability !== 'unavailable') {
        return 'The host has stopped all delegated work for now. Nothing is lost, and it continues when they resume it.';
    }
    switch (projection.availability) {
    case 'unavailable': return 'Delegated work is turned off on this installation.';
    case 'attention_off': return 'Attention is off, so nothing is delegated and no new work starts.';
    case 'none_delegated': return 'Nothing is delegated yet.';
    case 'paused': {
        if (!counts) return 'Your responsibilities are paused.';
        const held = counts.paused + counts.needsReview;
        return `${capitalize(sayNumber(held))} ${held === 1 ? 'responsibility is' : 'responsibilities are'} paused or waiting for review, and nothing is running.`;
    }
    case 'unknown': return 'I could not read the state of your responsibilities just now.';
    default:
        return counts
            ? `I am looking after ${sayNumber(counts.active)} ${counts.active === 1 ? 'responsibility' : 'responsibilities'}.`
            : 'I am looking after your responsibilities.';
    }
}

/**
 * The briefing for one Home projection. Pure: the same projection gives
 * the same words.
 * @param {Object} projection - what `assistantHomeService.project()` returned
 * @param {{ now?: Date }} [options]
 * @returns {{
 *   text: string,
 *   counts: { needsAction: number|null, unseen: number|null, running: number|null, blocked: number|null, degraded: number|null },
 *   needsYou: string[],
 *   findings: Array<{ id: number, revision: number, title: string }>,
 *   mentioned: Array<{ id: number, revision: number }>,
 *   partial: string[]
 * }}
 */
function compose(projection, { now = new Date() } = {}) {
    const counts = projection.counts || {};
    const available = projection.availability !== 'unavailable';
    const processes = (projection.components || []).find(component => component.id === 'processes');
    const processCount = (field) => (available && processes && typeof processes[field] === 'number' ? processes[field] : null);
    const blocked = processCount('blocked');
    const degraded = processCount('degraded');
    const sentences = [statusSentence(projection)];
    const mentioned = new Map();
    const mention = (update) => {
        if (update && Number.isInteger(Number(update.id)) && Number(update.revision) >= 1) {
            mentioned.set(Number(update.id), { id: Number(update.id), revision: Number(update.revision) });
        }
    };

    // Needs you: Home's count, then the titles it previews.
    const needs = [];
    if (counts.needsAction == null) {
        sentences.push('I could not read what is waiting on you just now.');
    } else if (counts.needsAction === 0) {
        sentences.push('Nothing is waiting on you.');
    } else {
        for (const item of (projection.needsYou || []).slice(0, MAX_NEEDS_YOU)) {
            const title = speakable(item.title, TITLE_MAX);
            if (!title) continue;
            needs.push(title);
            mention(item.update);
        }
        sentences.push(`${capitalize(sayNumber(counts.needsAction))} ${counts.needsAction === 1 ? 'thing needs' : 'things need'} you.`);
        if (needs.length === 1 && counts.needsAction === 1) {
            sentences.push(`It is: ${needs[0]}.`);
        } else {
            needs.forEach((title, index) => sentences.push(`${ORDINALS[index]}: ${title}.`));
        }
        const rest = counts.needsAction - needs.length;
        if (rest > 0 && needs.length > 0) sentences.push(`And ${sayNumber(rest)} more in your Inbox.`);
        else if (rest > 0) sentences.push('They are in your Inbox.');
    }

    // What changed: Home's unseen count, then up to three findings.
    const findings = [];
    if (available) {
        if (counts.unseen == null) {
            sentences.push('I could not read your updates just now.');
        } else if (counts.unseen === 0) {
            sentences.push('There is nothing new that you have not reviewed.');
        } else {
            sentences.push(`You have ${sayNumber(counts.unseen)} ${counts.unseen === 1 ? 'update' : 'updates'} you have not reviewed.`);
        }
        const brief = projection.brief || [];
        for (const item of brief.slice(0, MAX_FINDINGS)) {
            const title = speakable(item.title, TITLE_MAX);
            if (!title) continue;
            const summary = firstSentence(item.summary);
            findings.push({ id: Number(item.id), revision: Number(item.revision), title });
            mention(item);
            sentences.push(summary && summary.toLowerCase() !== title.toLowerCase() ? `${title}. ${summary}.` : `${title}.`);
        }
        if (findings.length) {
            sentences.splice(sentences.length - findings.length, 0, findings.length === 1 ? 'The newest finding:' : 'The newest findings:');
            if (brief.length > findings.length) sentences.push('There are more on Home.');
        }
    }

    // Work in progress and processes in trouble, as Home labels them: not
    // working, and running with a problem, are two counts.
    if (available) {
        if (counts.running == null) {
            sentences.push('I could not read what is running just now.');
        } else if (counts.running > 0) {
            sentences.push(`${capitalize(sayNumber(counts.running))} ${counts.running === 1 ? 'piece of work is' : 'pieces of work are'} running.`);
        } else if (projection.availability === 'ready' && !projection.hostPaused) {
            sentences.push('Nothing is running right now.');
        }
        if (blocked > 0) {
            sentences.push(`${capitalize(sayNumber(blocked))} of your processes ${blocked === 1 ? 'is' : 'are'} not working.`);
        }
        if (degraded > 0) {
            sentences.push(`${capitalize(sayNumber(degraded))} of your processes ${degraded === 1 ? 'is' : 'are'} running with a problem.`);
        }
    }

    // Freshness, by the rule Home uses: said only when the picture may be old.
    const freshness = projection.freshness || { state: 'unknown', lastPassAt: null };
    if (available && freshness.state !== 'current'
        && projection.availability !== 'none_delegated' && projection.availability !== 'attention_off') {
        const when = freshness.lastPassAt ? ago(freshness.lastPassAt, now) : null;
        sentences.push(when
            ? `This was last checked ${when}, so it may be out of date.`
            : 'This has not been checked yet since the installation started.');
    }
    const partial = [...(projection.partial || [])];
    if (partial.length) sentences.push('Some of this could not be read just now, so treat what I did not mention as unknown.');

    return {
        text: sentences.join(' '),
        counts: {
            needsAction: counts.needsAction ?? null,
            unseen: counts.unseen ?? null,
            running: counts.running ?? null,
            blocked,
            degraded
        },
        needsYou: needs,
        findings,
        mentioned: [...mentioned.values()],
        partial
    };
}

/**
 * One person's briefing, read now.
 * @param {{ userId: string, now?: Date }} params
 * @returns {Promise<ReturnType<typeof compose>>}
 */
async function brief({ userId, now = new Date() }) {
    const projection = await require('../assistantHomeService').project({ userId: String(userId), now });
    const briefing = compose(projection, { now });
    // Saying it is a delivery, and only that. A failure here costs nothing
    // the person was told: the briefing is still the projection's.
    if (briefing.mentioned.length) {
        const updates = require('../assistantUpdateService');
        for (const update of briefing.mentioned) {
            try {
                await updates.markDelivered({ userId: String(userId), id: update.id, revision: update.revision });
            } catch (error) {
                logger.warn?.(`[assistant briefing] delivery not recorded: ${error.message}`);
            }
        }
    }
    return briefing;
}

module.exports = { compose, brief, sayNumber, MAX_NEEDS_YOU, MAX_FINDINGS };
