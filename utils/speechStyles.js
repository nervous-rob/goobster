/**
 * Text-effect helpers for the /speak command. These inject bracketed cues,
 * emphasis, and hesitation into text before it is sent to the TTS engine.
 */

function applyStyle(text, style) {
    const styles = {
        'sing': (text) => `♪ ${text} ♪`,
        'happy': (text) => `[HAPPY] ${text} [laughter]`,
        'sad': (text) => `[SAD] ${text} [sigh]`,
        'angry': (text) => `[ANGRY] ${text}!`,
        'thinking': (text) => `[THOUGHTFUL] Hmm... ${text}`,
        'dramatic': (text) => `[DRAMATIC PAUSE] ... ${text} ...`,
        'movie_trailer': (text) => `[EPIC] In a world... where ${text}`,
        'radio_host': (text) => `[RADIO VOICE] Goooood morning listeners! ${text}`,
        'game_announcer': (text) => `[ANNOUNCER] Ladies and gentlemen... ${text}!`,
        'enthusiastic': (text) => `[EXCITED] WOW! ${text}!`,
        'whisper': (text) => `[whispers] ${text}`,
        'circus': (text) => `[RINGMASTER] Step right up! ${text}!`
    };

    return styles[style] ? styles[style](text) : text;
}

function addRandomEffects(text) {
    const effects = [
        '[laughter]',
        '[sigh]',
        '[clears throat]',
        '[gasp]',
        '[hmm]',
        '[whispers]',
        '[music]',
        '[chuckles]',
        '[yawns]',
        '[sniffs]',
        '[coughs]',
        '[whistles]'
    ];

    const emotions = [
        '[HAPPY]',
        '[EXCITED]',
        '[CURIOUS]',
        '[SURPRISED]',
        '[AMUSED]',
        '[MYSTERIOUS]',
        '[CONFIDENT]',
        '[PLAYFUL]',
        '[ENERGETIC]',
        '[CALM]'
    ];

    const backgrounds = [
        '[crowd murmuring]',
        '[birds chirping]',
        '[rain falling]',
        '[wind blowing]',
        '[crickets chirping]',
        '[distant thunder]',
        '[waves crashing]',
        '[fire crackling]'
    ];

    // Add 1-2 random effects
    const numEffects = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numEffects; i++) {
        const effect = effects[Math.floor(Math.random() * effects.length)];
        const position = Math.random() > 0.5 ? 'start' : 'end';
        text = position === 'start' ? `${effect} ${text}` : `${text} ${effect}`;
    }

    // Maybe add an emotion (30% chance)
    if (Math.random() < 0.3) {
        const emotion = emotions[Math.floor(Math.random() * emotions.length)];
        text = `${emotion} ${text}`;
    }

    // Maybe add background sound (20% chance)
    if (Math.random() < 0.2) {
        const background = backgrounds[Math.floor(Math.random() * backgrounds.length)];
        text = `${text} ${background}`;
    }

    return text;
}

function addEmphasis(text) {
    const words = text.split(' ');
    
    // Randomly capitalize 15-30% of words
    const numToCapitalize = Math.floor(words.length * (Math.random() * 0.15 + 0.15));
    const indexesToCapitalize = new Set();
    
    while (indexesToCapitalize.size < numToCapitalize) {
        const index = Math.floor(Math.random() * words.length);
        // Don't capitalize words that are already part of effects/emotions
        if (!words[index].includes('[') && !words[index].includes(']')) {
            indexesToCapitalize.add(index);
        }
    }

    const modifiedWords = words.map((word, index) => 
        indexesToCapitalize.has(index) ? word.toUpperCase() : word
    );

    return modifiedWords.join(' ');
}

function addHesitation(text) {
    const sentences = text.split(/([.!?]+)/);
    
    // Add hesitation marks with 30% chance per sentence
    const modifiedSentences = sentences.map(sentence => {
        if (sentence.length < 2 || sentence.match(/[.!?]+/)) return sentence;
        
        if (Math.random() < 0.3) {
            const hesitation = Math.random() < 0.5 ? '...' : '—';
            const words = sentence.split(' ');
            const position = Math.floor(Math.random() * words.length);
            words.splice(position, 0, hesitation);
            return words.join(' ');
        }
        return sentence;
    });

    return modifiedSentences.join('');
}

module.exports = {
    applyStyle,
    addRandomEffects,
    addEmphasis,
    addHesitation
};
