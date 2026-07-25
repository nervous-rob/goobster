/**
 * Static content for the Goobster Tavern: stats, difficulty bands, Callings
 * (archetypes), the resident NPC cast, and the daily rumor pool. Pure data +
 * tiny pure helpers - no database, no Discord.
 *
 * Adventure campaigns are NOT defined here: they live as YAML directories
 * under campaigns/ (built-in) and data/tavern/campaigns/ (custom), loaded and
 * validated by services/tavern/questLoader.js.
 */

/** The four stats. Every check is d20 + stat (+ situational bonus) vs a DC. */
const STATS = Object.freeze({
    might: { key: 'might', name: 'Might', emoji: '💪', covers: 'force, endurance, fighting, intimidation' },
    finesse: { key: 'finesse', name: 'Finesse', emoji: '🤸', covers: 'stealth, reflexes, precision, trickery' },
    wits: { key: 'wits', name: 'Wits', emoji: '🧠', covers: 'knowledge, investigation, magic, planning' },
    heart: { key: 'heart', name: 'Heart', emoji: '❤️', covers: 'charm, courage, empathy, willpower' }
});

const STAT_KEYS = Object.freeze(Object.keys(STATS));

/** Points to distribute across the four stats at creation (each +0..+3). */
const STAT_POOL = 6;
const STAT_MAX = 3;

/** Difficulty bands. */
const DIFFICULTY = Object.freeze({
    routine: 10,
    challenging: 13,
    difficult: 16,
    heroic: 19,
    legendary: 22
});

const DEFAULT_MAX_HEALTH = 10;
const STARTING_SPARK = 1;
const SPARK_CAP = 5;

/**
 * Callings: broad archetypes, not rulebook classes. Each has an
 * always-available move (narrative permission) and one once-per-adventure
 * "big moment" move. In Tavern Alpha the big move guarantees your next check
 * succeeds - the flavor tells you how it looks when your Calling does it.
 */
const CALLINGS = Object.freeze({
    vanguard: {
        key: 'vanguard', name: 'Vanguard', emoji: '🛡️',
        blurb: 'Protector, fighter, bodyguard.',
        alwaysMove: { name: 'Stand Fast', text: 'When you shield someone else from harm, describe how - you take the hit on your own terms.' },
        bigMove: { name: 'Unbreakable', text: 'Once per adventure: plant your feet and simply refuse to fail. Your next check succeeds.' },
        advancement: 'Guardian techniques, battlefield presence, legendary stubbornness.'
    },
    scoundrel: {
        key: 'scoundrel', name: 'Scoundrel', emoji: '🗡️',
        blurb: 'Trickster, thief, duelist, swindler.',
        alwaysMove: { name: 'Sticky Fingers', text: 'You may always have palmed one small, plausible object from a scene you have visited.' },
        bigMove: { name: 'The Old Switcheroo', text: 'Once per adventure: reveal the con was running all along. Your next check succeeds.' },
        advancement: 'Heists, disguises, impossible escapes, better hats.'
    },
    mystic: {
        key: 'mystic', name: 'Mystic', emoji: '🔮',
        blurb: 'Mage, witch, psychic, alchemist.',
        alwaysMove: { name: 'Second Sight', text: 'Once per scene, sense whether something present is magical, haunted, or lying about being either.' },
        bigMove: { name: 'The Veil Parts', text: 'Once per adventure: channel raw power past all safety margins. Your next check succeeds.' },
        advancement: 'Rituals, familiars, prophecy management, tasteful ominousness.'
    },
    guide: {
        key: 'guide', name: 'Guide', emoji: '🧭',
        blurb: 'Ranger, healer, scholar, diplomat.',
        alwaysMove: { name: 'I Know the Way', text: 'You always know one true, useful fact about a place, creature, or custom the party encounters.' },
        bigMove: { name: 'Steady Hands', text: 'Once per adventure: talk an ally (or yourself) through the impossible. Your next check succeeds.' },
        advancement: 'Field medicine, lore, wayfinding, friends in strange places.'
    },
    tinkerer: {
        key: 'tinkerer', name: 'Tinkerer', emoji: '⚙️',
        blurb: 'Inventor, mechanic, artificer.',
        alwaysMove: { name: 'Jury-Rig', text: 'Once per scene, turn a plausible object into a useful temporary tool.' },
        bigMove: { name: 'Overclock', text: 'Once per adventure: push a device past design limits. Your next check succeeds; the smoke is decorative. Probably.' },
        advancement: 'Gadgets, constructs, explosives, odd vehicles.'
    },
    troubadour: {
        key: 'troubadour', name: 'Troubadour', emoji: '🎻',
        blurb: 'Performer, morale-maker, storyteller.',
        alwaysMove: { name: 'Know the Tune', text: 'You have heard a song, story, or scandal about anyone with a reputation - and can recall one verse of it.' },
        bigMove: { name: 'Showstopper', text: 'Once per adventure: seize the scene and make it yours. Your next check succeeds.' },
        advancement: 'Repertoire, renown, rivals, an increasingly dramatic instrument.'
    }
});

/**
 * The resident cast. Secrets are here as future adventure fuel - they are
 * never rendered to players by any view.
 */
const NPCS = Object.freeze({
    marnie: {
        key: 'marnie', name: 'Marnie Quill', title: 'Proprietor', emoji: '🍺',
        description: 'Warm, perceptive, and absolutely knows more than she says. Keeps the Tavern neutral ground - always.',
        role: 'Onboarding, quest recommendations, emotional anchor.',
        chatter: [
            'First visit? Fire\'s that way, quest board\'s the other. Both bite less than they look.',
            'The rain on those windows isn\'t always from this world\'s weather. Don\'t worry about it.',
            'I don\'t take sides. I take coats, and occasionally confessions.'
        ],
        secret: 'The Tavern moves between worlds only because she permits it.'
    },
    bix: {
        key: 'bix', name: 'Bix Copperthumb', title: 'Quartermaster', emoji: '🪙',
        description: 'A goblin-like inventory genius with a tendency to label dangerous objects incorrectly.',
        role: 'Gear, crafting, rewards, item identification.',
        chatter: [
            'That crate marked JAM? Do not open the crate marked JAM.',
            'Everything\'s inventoried. Some of it is inventoried as "misc, screaming".',
            'Adventurer discount today: same price, but I say something nice about your boots.'
        ],
        secret: 'Owes money to a dragon-run logistics company.'
    },
    caldra: {
        key: 'caldra', name: 'Sister Caldra', title: 'Hearthkeeper', emoji: '🕯️',
        description: 'A kind healer and historian who remembers every guest - sometimes before they arrive.',
        role: 'Recovery, lore, character relationships.',
        chatter: [
            'Sit. You\'ve been holding that wound like a grudge. Both come out tonight.',
            'I remember your story. Parts of it you haven\'t told yet, I think. Tea?',
            'The hearth never judges. That\'s my job, and I choose not to.'
        ],
        secret: 'She is slowly forgetting her original name.'
    },
    albert: {
        key: 'albert', name: 'Albert E. Littlefield', title: 'Keeper of the Impractical Beacon', emoji: '🔦',
        description: 'A highly qualified, somewhat singed lighthouse engineer who maintains a lamp on the Tavern roof despite the complete lack of nearby shipping lanes.',
        role: 'Weather omens, emergency warnings, electrical contraptions.',
        chatter: [
            'The beacon is fine. The beacon is FINE. Please stop asking why it\'s humming.',
            'No, there\'s no sea nearby. Yes, the lamp points at one anyway. I have professional concerns.',
            'Lamp maintenance tip: never let it go out. That\'s the whole tip. No pressure.'
        ],
        secret: 'The beacon calls something from beyond the known map, and the lamp must never be allowed to go out.'
    }
});

/** Daily rumor pool - one surfaces per guild per UTC day. */
const RUMORS = Object.freeze([
    'They say the bell tower at Brinewatch has gone silent, and the tide sounds wrong without it.',
    'A sealed letter from Lady Vell sits behind the bar. Marnie won\'t say who it\'s for. It hums faintly.',
    'Bix has started labeling one crate "ABSOLUTELY JAM" - which is somehow less reassuring.',
    'The chandelier moved again last night. Three guests swear it was politely holding the door.',
    'Sister Caldra greeted a traveler by name before they came in. They had never been here. She poured their usual.',
    'Albert was seen on the roof at midnight, arguing with the beacon. Witnesses say the beacon argued back.',
    'The cellar rats have formed a committee. They have minutes. They would like them read aloud.',
    'A fisherman two worlds over claims a drowned choir sings under the old chapel when the moon is thin.',
    'Someone paid their tab in coins that were warm to the touch and smelled of lamp oil.',
    'The Map Room door was open this morning. There is no Map Room. Yet.',
    'A duke\'s guard stopped by asking questions. Marnie answered all of them with soup.',
    'The dartboard has started predicting the weather. It is more accurate than Albert, which infuriates him.',
    'Guests keep hearing a bell ring underwater in their dreams. The dreams smell of salt and old bronze.',
    'Bix is offering a reward for whoever "misplaced" a bag of self-shuffling cards. The cards are winning.',
    'A lighthouse spirit, recently freed somewhere, is reportedly "just delighted" to be out. Experts are concerned.',
    'The Moon Tax Office sent a wanted notice. Marnie pinned it upside down, which is apparently legally binding.'
]);

/** Rain/weather flavor for the Common Room opening line, varied by day. */
const WEATHER_LINES = Object.freeze([
    'Rain raps against stained glass.',
    'Fog presses friendly faces to the windows. Probably faces.',
    'The hearth crackles; somewhere above, the beacon hums its one long note.',
    'Snow that belongs to some other world dusts the sills and refuses to melt.',
    'The evening is warm, the windows amber, the chandelier suspiciously attentive.',
    'Thunder rolls in the distance - applause, Marnie insists, from a show long finished.',
    'Salt wind rattles the shutters, though no map places the Tavern near a sea.'
]);

/**
 * Deterministic small hash for daily rotation (per guild + UTC date).
 * @param {string} text
 * @returns {number} non-negative integer
 */
function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

/**
 * The rumor of the day for a guild (deterministic, no storage needed).
 * @param {string} guildId
 * @param {Date} [date]
 * @returns {string}
 */
function dailyRumor(guildId, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return RUMORS[hashText(`${guildId}|${day}|rumor`) % RUMORS.length];
}

/**
 * The weather/ambience line of the day for a guild.
 * @param {string} guildId
 * @param {Date} [date]
 * @returns {string}
 */
function dailyWeather(guildId, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return WEATHER_LINES[hashText(`${guildId}|${day}|weather`) % WEATHER_LINES.length];
}

/**
 * A rotating line of NPC chatter (varies by day and guild).
 * @param {{chatter: string[]}} npc
 * @param {string} guildId
 * @param {Date} [date]
 * @returns {string}
 */
function npcChatter(npc, guildId, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return npc.chatter[hashText(`${guildId}|${day}|${npc.key}`) % npc.chatter.length];
}

module.exports = {
    STATS,
    STAT_KEYS,
    STAT_POOL,
    STAT_MAX,
    DIFFICULTY,
    DEFAULT_MAX_HEALTH,
    STARTING_SPARK,
    SPARK_CAP,
    CALLINGS,
    NPCS,
    RUMORS,
    WEATHER_LINES,
    dailyRumor,
    dailyWeather,
    npcChatter,
    hashText
};
