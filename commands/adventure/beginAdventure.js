const { SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const adventureConfig = require('../../config/adventureConfig');

const openai = new OpenAI({
    apiKey: config.openaiKey
});

// Enable debug logging
adventureConfig.DEBUG.ENABLED = true;  // Enable debugging
adventureConfig.DEBUG.LOG_LEVEL = 'ERROR';  // Set to ERROR to see error messages

const ADVENTURE_INIT_PROMPT = `
Create a fantasy adventure that incorporates the following party members and their backstories:

{{PARTY_MEMBERS}}

Create an adventure that ties these characters together, using their backstories and characteristics. The adventure should have the following structure. Be concise but specific:

{
    "theme": "brief theme that connects to party members' backgrounds (max 100 chars)",
    "setting": {
        "geography": "specific location that relates to party members' origins",
        "era": "time period",
        "culture": "cultural element that considers party backgrounds"
    },
    "plotSummary": "main story that incorporates party members' backgrounds (max 4000 chars)",
    "plotPoints": [
        "major event 1 involving party members",
        "major event 2 involving party members",
        "major event 3 involving party members"
    ],
    "keyElements": {
        "characters": ["character1 from party backstories", "character2 from party backstories"],
        "items": ["important item1 possibly tied to party members"],
        "antagonist": "main opposing force that relates to party backgrounds"
    },
    "winCondition": {
        "primary": "main objective that aligns with party goals (max 1000 chars)",
        "secondary": ["optional goal 1 tied to party members", "optional goal 2 tied to party members"],
        "failureConditions": ["failure 1", "failure 2"],
        "requiredElements": ["required item/state 1"]
    },
    "initialSituation": {
        "location": {
            "place": "specific location relevant to party",
            "landmarks": ["landmark1", "landmark2"],
            "surroundings": "immediate environment"
        },
        "environment": {
            "timeOfDay": "morning|afternoon|evening|night|dawn|dusk",
            "weather": "sunny|rainy|cloudy|stormy|clear",
            "season": "current season",
            "visibility": "visibility condition"
        },
        "elements": {
            "threats": ["immediate threat"],
            "opportunities": ["available opportunity"],
            "allies": ["potential ally"],
            "hazards": ["environmental hazard"]
        }
    },
    "initialChoices": [
        "choice 1 that considers party composition (max 500 chars)",
        "choice 2",
        "choice 3"
    ]
}

Ensure all elements are specific and memorable enough to track throughout the story.
Each choice should lead to different outcomes.
Use exactly this JSON structure with no additional fields.`;

// Add function to truncate strings to specific lengths
function truncateString(str, maxLength) {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

// Add the missing validateContentLengths function
function validateContentLengths(content) {
    const limits = {
        theme: 100,
        plotSummary: 4000,
        'winCondition.primary': 1000,
        'initialSituation.description': 4000,
        initialChoices: 500
    };

    try {
        for (const [field, limit] of Object.entries(limits)) {
            if (field.includes('.')) {
                const [parent, child] = field.split('.');
                if (content[parent]?.[child]?.length > limit) {
                    content[parent][child] = truncateString(content[parent][child], limit);
                }
            } else if (Array.isArray(content[field])) {
                content[field] = content[field].map(item => 
                    truncateString(item, limit)
                );
            } else if (content[field]?.length > limit) {
                content[field] = truncateString(content[field], limit);
            }
        }
        return content;
    } catch (error) {
        debugLog('ERROR', 'Error in validateContentLengths:', error);
        throw error;
    }
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

// Add function to validate and process adventure content
async function processAdventureContent(content) {
    try {
        // Validate required fields
        const requiredFields = [
            'theme', 'setting', 'plotSummary', 'plotPoints', 
            'keyElements', 'winCondition', 'initialSituation'
        ];
        
        for (const field of requiredFields) {
            if (!content[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Validate content lengths first
        content = validateContentLengths(content);

        // Then create processed content with the validated/truncated values
        const processedContent = {
            theme: content.theme,
            setting: JSON.stringify({
                geography: content.setting.geography || 'unknown',
                era: content.setting.era || 'unknown',
                culture: content.setting.culture || 'unknown'
            }),
            plotSummary: content.plotSummary,
            plotPoints: JSON.stringify(
                content.plotPoints.slice(0, adventureConfig.PROGRESS.MAX_PLOT_POINTS)
            ),
            keyElements: JSON.stringify({
                characters: content.keyElements.characters || [],
                items: content.keyElements.items || [],
                antagonist: content.keyElements.antagonist || 'unknown'
            }),
            winCondition: JSON.stringify({
                primary: content.winCondition.primary,
                secondary: content.winCondition.secondary || [],
                failureConditions: content.winCondition.failureConditions || [],
                requiredElements: content.winCondition.requiredElements || []
            }),
            initialState: JSON.stringify({
                location: {
                    place: content.initialSituation.location.place,
                    landmarks: content.initialSituation.location.landmarks || [],
                    surroundings: content.initialSituation.location.surroundings
                },
                environment: {
                    timeOfDay: content.initialSituation.environment.timeOfDay,
                    weather: content.initialSituation.environment.weather,
                    season: content.initialSituation.environment.season,
                    visibility: content.initialSituation.environment.visibility
                },
                elements: {
                    threats: content.initialSituation.elements.threats || [],
                    opportunities: content.initialSituation.elements.opportunities || [],
                    allies: content.initialSituation.elements.allies || [],
                    hazards: content.initialSituation.elements.hazards || []
                },
                progress: {
                    plotPointsEncountered: [],
                    objectivesCompleted: [],
                    keyElementsFound: []
                },
                recentEvents: [
                    `The adventure begins in ${content.initialSituation.location.place}`,
                    `Current conditions: ${content.initialSituation.environment.weather} and ${content.initialSituation.environment.visibility}`
                ]
            })
        };

        return processedContent;
    } catch (error) {
        debugLog('ERROR', 'Failed to process adventure content', error);
        throw new Error('Failed to process adventure content');
    }
}

// Add function to format party members for prompt
function formatPartyMembersForPrompt(members) {
    return members.map(member => {
        let text = `- ${member.adventurerName}`;
        if (member.backstory) {
            text += `: ${member.backstory}`;
        }
        return text;
    }).join('\n');
}

// Modify the generateAdventureContent function
async function generateAdventureContent(partyMembers) {
    try {
        const partyMembersText = formatPartyMembersForPrompt(partyMembers);
        const prompt = ADVENTURE_INIT_PROMPT.replace('{{PARTY_MEMBERS}}', partyMembersText);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 2000,
        });

        debugLog('INFO', 'Raw GPT Response:', completion.choices[0].message.content);

        try {
            // Clean the response by removing markdown code block markers
            const cleanedContent = completion.choices[0].message.content
                .replace(/```json\n/g, '')
                .replace(/```\n/g, '')
                .replace(/```/g, '')
                .trim();

            return JSON.parse(cleanedContent);
        } catch (parseError) {
            debugLog('ERROR', 'Failed to parse GPT response:', {
                error: parseError.message,
                content: completion.choices[0].message.content
            });
            throw new Error('Failed to parse adventure content');
        }
    } catch (apiError) {
        debugLog('ERROR', 'OpenAI API error:', apiError);
        throw new Error('Failed to generate adventure content');
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
        let transaction;
        try {
            await interaction.deferReply();
            await getConnection();

            const username = interaction.user.username;
            const partyId = interaction.options.getInteger('partyid');

            // Start transaction
            transaction = new sql.Transaction();
            await transaction.begin();  // Ensure transaction is begun before use

            // Get user ID
            const userResult = await transaction.request()
                .input('username', sql.NVarChar, username)
                .query('SELECT id FROM users WHERE username = @username');
            
            if (!userResult.recordset.length) {
                throw new Error('User not found');
            }
            const userId = userResult.recordset[0].id;

            // Check party status and membership
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

            // Get all party members and their details
            const membersResult = await transaction.request()
                .input('partyId', sql.Int, partyId)
                .query(`
                    SELECT adventurerName, backstory
                    FROM partyMembers
                    WHERE partyId = @partyId
                    ORDER BY joinedAt ASC
                `);

            // Generate adventure content using GPT-4o with party member details
            const adventureContent = await generateAdventureContent(membersResult.recordset);
            const processedContent = await processAdventureContent(adventureContent);

            // Create adventure entry
            const adventureResult = await transaction.request()
                .input('partyId', sql.Int, partyId)
                .input('theme', sql.NVarChar, processedContent.theme)
                .input('setting', sql.NVarChar, processedContent.setting)
                .input('plotSummary', sql.NVarChar, processedContent.plotSummary)
                .input('plotPoints', sql.NVarChar, processedContent.plotPoints)
                .input('keyElements', sql.NVarChar, processedContent.keyElements)
                .input('winCondition', sql.NVarChar, processedContent.winCondition)
                .input('currentState', sql.NVarChar, processedContent.initialState)
                .query(`
                    INSERT INTO adventures (
                        partyId, theme, setting, plotSummary, plotPoints,
                        keyElements, winCondition, currentState
                    )
                    VALUES (
                        @partyId, @theme, @setting, @plotSummary, @plotPoints,
                        @keyElements, @winCondition, @currentState
                    );
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
            const initialState = JSON.parse(processedContent.initialState);

            await transaction.request()
                .input('adventureId', sql.Int, adventureId)
                .input('partyMemberId', sql.Int, firstMember.id)
                .input('situation', sql.NVarChar, initialState.location.surroundings)
                .input('choices', sql.NVarChar, JSON.stringify(adventureContent.initialChoices))
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
                description: processedContent.theme,
                fields: [
                    {
                        name: 'Setting',
                        value: JSON.parse(processedContent.setting).geography
                    },
                    {
                        name: 'Plot',
                        value: processedContent.plotSummary
                    },
                    {
                        name: 'Initial State',
                        value: `Location: ${adventureContent.initialSituation.location.place}\nTime: ${adventureContent.initialSituation.environment.timeOfDay}\nWeather: ${adventureContent.initialSituation.environment.weather}\nVisibility: ${adventureContent.initialSituation.environment.visibility}`
                    },
                    {
                        name: 'Objectives',
                        value: JSON.parse(processedContent.winCondition).primary
                    },
                    {
                        name: '\u200B',
                        value: '\u200B'
                    },
                    {
                        name: `${firstMember.adventurerName}'s Turn`,
                        value: initialState.location.surroundings
                    },
                    {
                        name: 'Available Choices',
                        value: adventureContent.initialChoices.map((choice, index) => 
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
            debugLog('ERROR', 'Error in beginAdventure', {
                error: error.message,
                stack: error.stack,
                name: error.name,
                code: error.code
            });
            
            if (transaction) {
                try {
                    await transaction.rollback();
                    debugLog('INFO', 'Transaction rolled back successfully');
                } catch (rollbackError) {
                    debugLog('ERROR', 'Error rolling back transaction', {
                        error: rollbackError.message,
                        stack: rollbackError.stack
                    });
                }
            }

            const errorMessages = {
                'User not found': 'You need to be registered first. Use /register to get started.',
                'Party not found': 'Could not find a party with that ID.',
                'You are not a member of this party': 'You must be a member of the party to begin the adventure.',
                'Party is no longer active': 'This party is no longer active.',
                'Adventure has already begun': 'This party\'s adventure has already started.',
                'Need at least one party member to begin': 'You need at least one party member to begin the adventure.',
                'Failed to process adventure content': 'Failed to process adventure content. Please try again.',
                'ENOTBEGUN': 'Database transaction failed to start. Please try again.',
                'TransactionError': 'Database transaction error. Please try again.'
            };
            
            const errorMessage = errorMessages[error.message] || errorMessages[error.code] || 'Failed to begin adventure. Please try again.';
            
            if (!interaction.deferred) {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            } else {
                await interaction.editReply({ content: errorMessage });
            }
        }
    },
}; 