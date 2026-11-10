/**
 * What counts as a request made to Goobster in a conversation (ADR 0021).
 *
 * The rule is fixed text matching, with no model: owner decision 4 says
 * DA-4 acts only on explicit requests addressed to Goobster, and that
 * reading a conversation for what people might want arrives with DA-8. A
 * rule a person can read is one they can predict.
 *
 * A message is a request when both hold:
 *  1. it addresses the assistant by the name this installation gives him
 *     (`identity.assistantName`, "Goobster" unless changed): the name
 *     opens or closes the message
 *     ("Goobster, ...", "Hey Goobster ...", "... , Goobster?"), or it
 *     @-mentions him anywhere ("@Goobster");
 *  2. what is left asks for a piece of work: an optional polite form
 *     ("can you", "please", "I need you to" ...) followed by one of the
 *     work verbs below ("look into", "compare", "research" ...).
 *
 * A message is steering when it addresses Goobster and what is left opens
 * with a change of direction ("actually", "instead", "scratch that",
 * "stop", "never mind", "don't" ...), or is a request that ends with
 * "instead". Steering may carry a replacement request in the same message
 * ("actually, compare Fastify and Hono").
 *
 * Mentioning Goobster in passing, asking him a question, or talking about
 * work without asking him for it proposes nothing.
 */

const ASSISTANT_NAME = 'Goobster';

/** The name this installation gives its assistant (`identity.assistantName`). */
function assistantName() {
    try {
        return String(require('../../config/identityConfig').assistantName || '').trim() || ASSISTANT_NAME;
    } catch {
        return ASSISTANT_NAME;
    }
}

/** Words that may come before the name without changing who is addressed. */
const GREETINGS = ['hey', 'hi', 'hello', 'ok', 'okay', 'so', 'and', 'also', 'thanks', 'thank you', 'please'];

/** Polite forms that may come before the work verb. */
const POLITE = [
    'can you', 'could you', 'would you', 'will you', 'please',
    'i need you to', 'i want you to', "i'd like you to", 'i would like you to',
    'we need you to', 'we want you to', "we'd like you to", 'we would like you to',
    'go ahead and', 'go and', 'kindly'
];

/** The work a person can ask for. One of these must lead the request. */
const WORK_VERBS = [
    'look into', 'look at', 'look up', 'look for', 'research', 'investigate', 'find out', 'find', 'figure out',
    'work out', 'compare', 'check', 'review', 'summarize', 'summarise', 'draft', 'write up', 'write',
    'analyze', 'analyse', 'evaluate', 'assess', 'test', 'verify', 'dig into', 'dig up', 'explore', 'survey',
    'list', 'collect', 'gather', 'track down', 'benchmark', 'document', 'outline', 'prepare', 'read up on',
    'study', 'see if', 'see whether', 'see what', 'see how', 'put together', 'map out', 'audit', 'measure'
];

/** Openers that change direction. */
const STEERING = [
    'instead', 'actually', 'scratch that', 'scrap that', 'never mind', 'nevermind', 'forget that', 'forget it',
    'forget about that', 'forget about it', 'stop', 'cancel that', 'cancel it', 'change of plan',
    'change of plans', 'drop that', 'drop it', 'hold off', 'on second thought'
];

/** Openers that call work off; the clause they open is not a request. */
const NEGATIONS = ["don't", 'do not', 'dont', 'no need to', 'no need for', "you don't need to", 'you do not need to'];

const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (list) => [...list].sort((a, b) => b.length - a.length).map(escape).join('|').replace(/ /g, '\\s+');

const SEPARATORS = '[\\s,:;.!?\\u2013\\u2014-]';
const POLITE_RE = new RegExp(`^(?:(?:${alternation(POLITE)})${SEPARATORS}+)+`, 'iu');
const WORK_RE = new RegExp(`^(?:${alternation(WORK_VERBS)})(?![\\p{L}\\p{N}])`, 'iu');
const STEER_RE = new RegExp(`^(?:${alternation(STEERING)})(?![\\p{L}\\p{N}])${SEPARATORS}*`, 'iu');
const NEGATION_RE = new RegExp(`^(?:${alternation(NEGATIONS)})(?![\\p{L}\\p{N}])${SEPARATORS}*`, 'iu');
const TRAILING_INSTEAD_RE = /(?:^|[\s,])instead[.!?]*$/iu;
/** Where a new clause may start inside a steering message. */
const CLAUSE_RE = /[,;:.!?\u2013\u2014]\s+|\s+-\s+|\s+(?:and|but|then|so)\s+/iu;

function normalize(text) {
    return String(text ?? '').normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Strip the address from a message.
 * @returns {string|null} what is left, or null when Goobster is not addressed
 */
function addressed(text, name = assistantName()) {
    const value = normalize(text);
    const who = escape(name);
    const lead = new RegExp(`^(?:(?:${alternation(GREETINGS)})${SEPARATORS}+)*@?${who}(?![\\p{L}\\p{N}])${SEPARATORS}*`, 'iu');
    const leading = lead.exec(value);
    if (leading) return value.slice(leading[0].length).trim();
    const trail = new RegExp(`${SEPARATORS}+@?${who}${SEPARATORS}*$`, 'iu');
    const trailing = trail.exec(value);
    if (trailing) return value.slice(0, trailing.index).trim();
    const mention = new RegExp(`(^|[^\\w@])@${who}(?![\\p{L}\\p{N}])${SEPARATORS}*`, 'iu');
    const mentioned = mention.exec(value);
    if (mentioned) return `${value.slice(0, mentioned.index)}${mentioned[1]}${value.slice(mentioned.index + mentioned[0].length)}`.trim();
    return null;
}

/** Does this clause open by asking for work? */
function asksForWork(clause) {
    const rest = String(clause || '').trim().replace(POLITE_RE, '');
    return WORK_RE.test(rest);
}

/**
 * Classify one message.
 * @param {string} text
 * @param {string} [name]
 * @returns {{ addressed: boolean, steer: boolean, request: boolean, text: string }}
 *   `text` is the normalized remainder used to tell two requests apart.
 */
function parse(text, name = assistantName()) {
    const rest = addressed(text, name);
    if (rest === null || !rest) return { addressed: rest !== null, steer: false, request: false, text: '' };
    const negation = NEGATION_RE.exec(rest);
    const steering = negation || STEER_RE.exec(rest);
    if (!steering) {
        // "Compare Koa instead" changes direction as plainly as "instead, compare Koa".
        const replaces = TRAILING_INSTEAD_RE.test(rest);
        return { addressed: true, steer: replaces && asksForWork(rest), request: asksForWork(rest), text: rest.toLowerCase() };
    }
    let remainder = rest.slice(steering[0].length).trim();
    // Steering openers stack ("actually, never mind, ...").
    for (let next = NEGATION_RE.exec(remainder) || STEER_RE.exec(remainder); next && next[0]; next = NEGATION_RE.exec(remainder) || STEER_RE.exec(remainder)) {
        remainder = remainder.slice(next[0].length).trim();
    }
    const clauses = remainder.split(CLAUSE_RE).map(clause => clause.trim()).filter(Boolean);
    // "Don't research X" calls X off: the clause a negation opens is never
    // the replacement. A later clause may be ("don't bother, compare Y").
    const candidates = negation ? clauses.slice(1) : clauses;
    return {
        addressed: true,
        steer: true,
        request: candidates.some(asksForWork),
        text: remainder.toLowerCase()
    };
}

module.exports = { ASSISTANT_NAME, assistantName, POLITE, WORK_VERBS, STEERING, NEGATIONS, normalize, addressed, asksForWork, parse };
