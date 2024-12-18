module.exports = {
    // Debug configuration
    DEBUG: {
        ENABLED: true,
        LOG_LEVEL: 'ERROR'
    },

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
        ROUND_ROBIN: 'ROUND_ROBIN',
        RANDOM: 'RANDOM',
        STORY_DRIVEN: 'STORY_DRIVEN'
    },

    // Default turn order method
    DEFAULT_TURN_ORDER: 'ROUND_ROBIN',

    // Health configuration
    HEALTH: {
        DEFAULT: 100,
        MIN: 0,
        MAX: 100
    },

    // Story tracking configuration
    STORY: {
        MAX_RECENT_EVENTS: 5,
        MAX_TRACKED_ELEMENTS: 20,
        REQUIRED_ELEMENTS: {
            LOCATION: true,
            TIME_OF_DAY: true,
            WEATHER: true,
            THREATS: true,
            OPPORTUNITIES: true
        }
    },

    // State schema for adventure currentState
    STATE_SCHEMA: {
        location: {
            place: String,
            landmarks: Array,
            surroundings: String
        },
        environment: {
            timeOfDay: String,
            weather: String,
            season: String,
            visibility: String
        },
        elements: {
            threats: Array,
            opportunities: Array,
            allies: Array,
            hazards: Array
        },
        progress: {
            plotPointsEncountered: Array,
            objectivesCompleted: Array,
            keyElementsFound: Array
        },
        recentEvents: Array
    },

    // Time of day options
    TIME_OF_DAY: [
        'morning',
        'afternoon',
        'evening',
        'night',
        'dawn',
        'dusk'
    ],

    // Weather conditions
    WEATHER_CONDITIONS: [
        'sunny',
        'rainy',
        'cloudy',
        'stormy',
        'clear'
    ],

    // Progress tracking
    PROGRESS: {
        MIN_PLOT_POINTS: 3,
        MAX_PLOT_POINTS: 5,
        MAX_SECONDARY_OBJECTIVES: 3,
        MAX_FAILURE_CONDITIONS: 3
    }
}; 