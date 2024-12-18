const { SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const adventureConfig = require('../../config/adventureConfig');

const openai = new OpenAI({
    apiKey: config.openaiKey
});

const ADVENTURE_INIT_PROMPT = `
Create a fantasy adventure with the following required elements. Each element must be specific and memorable enough to track throughout the story:

1. Theme/Setting Requirements:
- A unique theme (max 100 characters)
- A specific geographical setting
- A clear time period or era
- Distinct cultural elements

2. Plot Elements:
- A compelling plot summary
- 3-5 major plot points that must be encountered
- Key characters or factions involved
- Important items or artifacts
- A clear antagonist or opposing force

3. Win Condition Requirements:
- Primary objective (must be specific and measurable)
- Optional secondary objectives
- Clear failure conditions
- Required items or states to achieve victory

4. Initial Situation Requirements:
Location:
- Must use "in" or "at" to specify exact location
- Include relevant landmarks or features
- Describe the immediate surroundings

Time and Environment:
- Time of day (morning, afternoon, evening, night, dawn, or dusk)
- Weather conditions (sunny, rainy, cloudy, stormy, or clear)
- Season or climate effects
- Visibility conditions

Threats and Opportunities:
- Immediate dangers or threats
- Available resources or advantages
- Potential allies or enemies nearby
- Environmental hazards or benefits

Format the response as JSON with the following structure:
{
    "theme": "brief theme description (max 100 chars)",
    "setting": {
        "geography": "geographical setting",
        "era": "time period",
        "culture": "cultural elements"
    },
    "plotSummary": "detailed plot summary",
    "plotPoints": [
        "major plot point 1",
        "major plot point 2",
        "major plot point 3"
    ],
    "keyElements": {
        "characters": ["character1", "character2"],
        "items": ["item1", "item2"],
        "antagonist": "main opposing force"
    },
    "winCondition": {
        "primary": "main objective",
        "secondary": ["optional objective 1", "optional objective 2"],
        "failureConditions": ["failure 1", "failure 2"],
        "requiredElements": ["required item/state 1", "required item/state 2"]
    },
    "initialSituation": {
        "location": {
            "place": "specific location",
            "landmarks": ["landmark1", "landmark2"],
            "surroundings": "immediate environment"
        },
        "environment": {
            "timeOfDay": "specific time",
            "weather": "specific condition",
            "season": "current season",
            "visibility": "visibility condition"
        },
        "elements": {
            "threats": ["threat1", "threat2"],
            "opportunities": ["opportunity1", "opportunity2"],
            "allies": ["potential ally1", "potential ally2"],
            "hazards": ["hazard1", "hazard2"]
        }
    },
    "initialChoices": ["choice1", "choice2", "choice3"]
}

Keep the theme concise and focused.
Each choice should be distinct and lead to different potential outcomes.
All elements should be trackable and referenceable throughout the adventure.
`;

// Add function to truncate strings to specific lengths
function truncateString(str, maxLength) {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

// Add debug logging function
function debugLog(level, message, data = null) {
    if (!adventureConfig.DEBUG.ENABLED) return;
    
    const logLevels = {
        'ERROR': 0,
        'WARN': 1,
        'INFO': 2,
        'DEBUG': 3
    };
    
    if (logLevels[level] <= logLevels[adventureConfig.DEBUG.LOG_LEVEL]) {
        if (data) {
            console.log(`[${level}] ${message}:`, JSON.stringify(data, null, 2));
        } else {
            console.log(`[${level}] ${message}`);
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('beginadventure')
        .setDescription('Begin the adventure with your party.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
        ),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            await getConnection();

            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');

            // Start transaction
            const transaction = new sql.Transaction();
            await transaction.begin();

            try {
                // Get user ID
                const userResult = await transaction.request()
                    .input('username', sql.NVarChar, username)
                    .query('SELECT id FROM users WHERE username = @username');
                
                if (!userResult.recordset.length) {
                    throw new Error('User not found');
                }
                const userId = userResult.recordset[0].id;

                // Check if party exists and user is a member
                const partyResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('userId', sql.Int, userId)
                    .query(`
                        SELECT p.*, 
                               pm.id as membershipId,
                               (SELECT COUNT(*) FROM partyMembers WHERE partyId = @partyId) as memberCount
                        FROM parties p
                        LEFT JOIN partyMembers pm ON p.id = pm.partyId AND pm.userId = @userId
                        WHERE p.id = @partyId
                    `);

                if (!partyResult.recordset.length) {
                    throw new Error('Party not found');
                }

                const party = partyResult.recordset[0];
                if (!party.membershipId) {
                    throw new Error('You are not a member of this party');
                }
                if (!party.isActive) {
                    throw new Error('Party is no longer active');
                }
                if (party.adventureStatus !== 'RECRUITING') {
                    throw new Error('Adventure has already begun');
                }
                if (party.memberCount < 1) {
                    throw new Error('Need at least one party member to begin');
                }

                // Generate adventure content using GPT-4
                const completion = await openai.chat.completions.create({
                    model: "gpt-4",
                    messages: [{ role: "user", content: ADVENTURE_INIT_PROMPT }]
                });

                const adventureContent = JSON.parse(completion.choices[0].message.content);

                // Validate and truncate content if necessary
                const validatedContent = {
                    theme: truncateString(adventureContent.theme, 100),
                    plotSummary: truncateString(adventureContent.plotSummary, 4000),
                    winCondition: truncateString(adventureContent.winCondition, 1000),
                    initialSituation: truncateString(adventureContent.initialSituation, 4000),
                    initialChoices: adventureContent.initialChoices.map(choice => truncateString(choice, 500))
                };

                // Create adventure entry
                const adventureResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .input('theme', sql.NVarChar, validatedContent.theme)
                    .input('plotSummary', sql.NVarChar, validatedContent.plotSummary)
                    .input('winCondition', sql.NVarChar, validatedContent.winCondition)
                    .input('currentState', sql.NVarChar, JSON.stringify({
                        location: validatedContent.initialSituation.match(/(?:in|at) (.*?)(?:\.|\s|$)/i)?.[1] || 'unknown',
                        timeOfDay: validatedContent.initialSituation.match(/(?:morning|afternoon|evening|night|dawn|dusk)/i)?.[0] || 'unknown',
                        weather: validatedContent.initialSituation.match(/(?:sunny|rainy|cloudy|stormy|clear)/i)?.[0] || 'unknown',
                        threats: validatedContent.initialSituation.match(/(?:danger|threat|enemy|monster|trap)/gi) || [],
                        opportunities: validatedContent.initialSituation.match(/(?:treasure|reward|ally|help|resource)/gi) || [],
                        recentEvents: [],
                        environmentalEffects: validatedContent.initialSituation.match(/(?:effect|affect|influence)/gi) || []
                    }))
                    .query(`
                        INSERT INTO adventures (partyId, theme, plotSummary, winCondition, currentState)
                        VALUES (@partyId, @theme, @plotSummary, @winCondition, @currentState);
                        SELECT SCOPE_IDENTITY() AS adventureId;
                    `);

                const adventureId = adventureResult.recordset[0].adventureId;

                // Initialize adventurer states
                await transaction.request()
                    .input('adventureId', sql.Int, adventureId)
                    .query(`
                        INSERT INTO adventurerStates (adventureId, partyMemberId, health, status, conditions, inventory)
                        SELECT 
                            @adventureId, 
                            id,
                            ${adventureConfig.HEALTH.DEFAULT},
                            '${adventureConfig.CHARACTER_STATUS.ACTIVE}',
                            '[]',
                            '[]'
                        FROM partyMembers
                        WHERE partyId = ${partyId}
                    `);

                // Create initial state object
                const initialState = {
                    location: validatedContent.initialSituation.match(/(?:in|at) (.*?)(?:\.|\s|$)/i)?.[1] || 'unknown',
                    timeOfDay: validatedContent.initialSituation.match(/(?:morning|afternoon|evening|night|dawn|dusk)/i)?.[0] || 'unknown',
                    weather: validatedContent.initialSituation.match(/(?:sunny|rainy|cloudy|stormy|clear)/i)?.[0] || 'unknown',
                    threats: validatedContent.initialSituation.match(/(?:danger|threat|enemy|monster|trap)/gi) || [],
                    opportunities: validatedContent.initialSituation.match(/(?:treasure|reward|ally|help|resource)/gi) || [],
                    recentEvents: [],
                    environmentalEffects: validatedContent.initialSituation.match(/(?:effect|affect|influence)/gi) || []
                };

                // Update adventure with initial state
                await transaction.request()
                    .input('adventureId', sql.Int, adventureId)
                    .input('currentState', sql.NVarChar, JSON.stringify(initialState))
                    .query(`
                        UPDATE adventures
                        SET currentState = @currentState
                        WHERE id = @adventureId
                    `);

                // Create initial decision point
                const firstMemberResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT TOP 1 id, adventurerName
                        FROM partyMembers
                        WHERE partyId = @partyId
                        ORDER BY joinedAt ASC
                    `);

                const firstMember = firstMemberResult.recordset[0];
                await transaction.request()
                    .input('adventureId', sql.Int, adventureId)
                    .input('partyMemberId', sql.Int, firstMember.id)
                    .input('situation', sql.NVarChar, validatedContent.initialSituation)
                    .input('choices', sql.NVarChar, JSON.stringify(validatedContent.initialChoices))
                    .query(`
                        INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                        VALUES (@adventureId, @partyMemberId, @situation, @choices)
                    `);

                // Update party status
                await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        UPDATE parties
                        SET adventureStatus = 'IN_PROGRESS'
                        WHERE id = @partyId
                    `);

                await transaction.commit();

                // Create response embed
                const embed = {
                    color: 0x0099ff,
                    title: '🎮 Adventure Begins!',
                    description: validatedContent.theme,
                    fields: [
                        {
                            name: 'Plot',
                            value: validatedContent.plotSummary
                        },
                        {
                            name: 'Win Condition',
                            value: validatedContent.winCondition
                        },
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${firstMember.adventurerName}'s Turn`,
                            value: validatedContent.initialSituation
                        },
                        {
                            name: 'Available Choices',
                            value: validatedContent.initialChoices.map((choice, index) => 
                                `${index + 1}. ${choice}`
                            ).join('\n')
                        }
                    ],
                    footer: {
                        text: `Use /makedecision to choose your action`
                    }
                };

                await interaction.editReply({ embeds: [embed] });

            } catch (error) {
                await transaction.rollback();
                throw error;
            }

        } catch (error) {
            debugLog('ERROR', 'Error in beginAdventure', error);
            const errorMessages = {
                'User not found': 'You need to be registered first. Use /register to get started.',
                'Party not found': 'Could not find a party with that ID.',
                'You are not a member of this party': 'You must be a member of the party to begin the adventure.',
                'Party is no longer active': 'This party is no longer active.',
                'Adventure has already begun': 'This party\'s adventure has already started.',
                'Need at least one party member to begin': 'You need at least one party member to begin the adventure.'
            };
            
            const errorMessage = errorMessages[error.message] || 'Failed to begin adventure. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 