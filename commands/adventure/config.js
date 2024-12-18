module.exports = {
    // Party configuration
    PARTY_SIZE: {
        MIN: 1,
        MAX: 6
    },

    // Adventure states
    ADVENTURE_STATUS: {
        RECRUITING: 'RECRUITING',
        IN_PROGRESS: 'IN_PROGRESS',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED'
    },

    // Character states
    CHARACTER_STATUS: {
        ACTIVE: 'ACTIVE',
        INJURED: 'INJURED',
        INCAPACITATED: 'INCAPACITATED',
        DEAD: 'DEAD'
    },

    // Turn order configuration
    TURN_ORDER: {
        ROUND_ROBIN: 'ROUND_ROBIN',  // Each player gets one turn in sequence
        RANDOM: 'RANDOM',            // Random player selection
        STORY_DRIVEN: 'STORY_DRIVEN' // Let GPT-4 decide based on narrative
    },

    // Default turn order method
    DEFAULT_TURN_ORDER: 'ROUND_ROBIN',

    // Health configuration
    HEALTH: {
        DEFAULT: 100,
        MIN: 0,
        MAX: 100
    },

    // State schema for adventure currentState
    STATE_SCHEMA: {
        location: String,
        timeOfDay: String,
        weather: String,
        threats: Array,
        opportunities: Array,
        recentEvents: Array,
        environmentalEffects: Array
    }
}; 