const { SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const adventureConfig = require('../../config/adventureConfig');
const VoiceService = require('../../services/voice');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, NoSubscriberBehavior, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const MusicService = require('../../services/voice/musicService');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { chunkMessage } = require('../../utils');
const { createAudioPlayer, createAudioResource } = require('@discordjs/voice');

// Initialize voice service
const voiceService = new VoiceService(config);

// Initialize music service with config
const musicService = new MusicService(require('../../config'));

// Define the DECISION_PROMPT template
const DECISION_PROMPT = `
You are continuing an ongoing adventure. You must maintain consistency with all established elements and advance the story meaningfully while respecting character states and recent events. The genre and theme should match the established setting and the party members' backgrounds.

Adventure Context:
Theme: {theme}
Setting: {setting}
Plot Summary: {plotSummary}
Major Plot Points: {plotPoints}
Key Elements: {keyElements}
Win Condition: {winCondition}

Current Adventure State:
Location: {currentState.location}
Time: {currentState.timeOfDay}
Weather: {currentState.weather}
Recent Events: {currentState.recentEvents}
Environmental Effects: {currentState.environmentalEffects}

Party Status:
{partyStatus}

Current Situation: {situation}
Player Choice: {chosenOption}
{additionalAction}

Generate the consequences and next decision point while following these STRICT rules:

1. GAME ENDING CONDITIONS (STRICTLY ENFORCE THESE):
   Victory Requirements (ALL must be met):
   - Primary win condition fully achieved
   - At least 50% of party members must be ACTIVE
   - All critical objectives completed
   - No remaining critical threats
   - Party has necessary resources to survive return journey

   Defeat Triggers (ANY will end the game):
   - All party members INCAPACITATED or DEAD
   - Critical quest item/location/NPC destroyed
   - Win condition becomes impossible to achieve
   - Party resources depleted below survival threshold
   - Time limit exceeded (if applicable)
   - Critical mission failure

   Partial Victory (When Applicable):
   - Primary objective partially achieved
   - Some party members survived
   - Some critical objectives completed
   - Situation prevents full completion

2. DIFFICULTY: Maintain consistent challenge level
   - No "lucky" solutions or deus ex machina events
   - Actions must have realistic consequences based on party capabilities
   - Environmental and enemy threats must pose genuine challenges
   - Resources should deplete naturally (health, items, etc.)
   - Each decision should have meaningful risk vs reward

3. OBJECTIVE TRACKING:
   - Every decision must measurably progress OR hinder objectives
   - Track distance from win condition (metaphorically or literally)
   - Note any new obstacles between party and objectives
   - Identify if any objectives become impossible
   - Update resource counts and availability

4. PROGRESSION REQUIREMENTS:
   - Actions must have clear cause-and-effect relationships
   - Choices should have meaningful trade-offs
   - Resources spent must match action difficulty
   - Skills/abilities must be consistent with character states
   - Track time progression if mission has time constraints

5. GENERAL RULES:
   - Maintain theme and setting consistency
   - Use key elements purposefully
   - Respect established lore and physics
   - Keep character actions within their capabilities
   - Environmental effects must impact decisions
   - CHECK FOR ENDING CONDITIONS AFTER EVERY MAJOR EVENT
{customRule}

Format the response as JSON with the following structure:
{
    "consequence": {
        "narration": "concise, narratable description of main events (max 200 words)",
        "details": "additional important details that shouldn't be narrated but should be shown in text",
        "atmosphere": "mood and tone for voice selection (e.g., epic, mysterious, dramatic)",
        "immediateEffects": "brief summary of immediate results",
        "emotionalImpact": "how characters feel about the events",
        "plotProgress": "how this advances or hinders story progress",
        "keyElementsUsed": ["element1", "element2"],
        "objectiveProgress": {
            "completedObjectives": ["objective1", "objective2"],
            "failedObjectives": ["objective3"],
            "remainingObjectives": ["objective4", "objective5"],
            "newObstacles": ["obstacle1", "obstacle2"],
            "resourcesUsed": ["resource1", "resource2"],
            "distanceFromWinCondition": "description of progress/distance from win"
        }
    },
    "stateChanges": [
        {
            "adventurerId": number,
            "changes": {
                "health": number (0-100),
                "status": "ACTIVE|INJURED|INCAPACITATED|DEAD",
                "conditions": ["condition1", "condition2"],
                "inventory": ["item1", "item2"],
                "resources": {
                    "stamina": number (0-100),
                    "mana": number (0-100),
                    "supplies": number (0-100)
                }
            },
            "reason": "explanation of changes"
        }
    ],
    "nextSituation": {
        "narration": "concise description of the new situation (max 100 words)",
        "details": "additional environmental or situational details for text display",
        "location": "specific location",
        "timeOfDay": "specific time",
        "weather": "specific condition",
        "activeThreats": ["threat description"],
        "availableOpportunities": ["opportunity description"],
        "visibility": "visibility condition",
        "atmosphere": "mood and tone description",
        "challengeLevel": "TRIVIAL|EASY|MODERATE|HARD|EXTREME",
        "requiredResources": ["resource1", "resource2"],
        "consequences": {
            "success": "outcome if choices succeed",
            "failure": "outcome if choices fail",
            "criticalFailure": "worst case scenario"
        }
    },
    "nextChoices": [
        "concise choice 1 (max 50 words)",
        "concise choice 2 (max 50 words)",
        "concise choice 3 (max 50 words)"
    ],
    "gameState": {
        "isEnding": boolean,
        "endType": "NONE|VICTORY|DEFEAT|PARTIAL_VICTORY",
        "endReason": "explanation if game is ending",
        "partyViability": "STRONG|STABLE|WEAKENED|CRITICAL",
        "objectiveViability": "ACHIEVABLE|CHALLENGING|UNLIKELY|IMPOSSIBLE"
    }
}

Notes:
- Keep narrations concise and engaging for voice delivery
- Include additional details in the 'details' fields for text display
- Use clear, engaging language that flows naturally when spoken
- Maintain appropriate pacing and dramatic timing
- Focus on key details that drive the story forward
- Ensure all responses are character-focused and emotionally resonant
{customNote}
`;

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

const openai = new OpenAI({
    apiKey: config.openaiKey
});

// Add function to format decision prompt
function formatDecisionPrompt(adventure, currentState, situation, chosenOption, partyStatus, customAction, choiceNum) {
    const additionalAction = customAction ? `Additional Action: ${customAction}` : '';
    const customRule = choiceNum === 4 
        ? '11. Creative and fair handling of the custom action based on the current situation and party capabilities'
        : '11. Integration of any additional custom action with the chosen option';
    const customNote = choiceNum === 4 
        ? '- Handle the custom action in a way that respects both player creativity and world constraints'
        : '';

    return DECISION_PROMPT
        .replace('{theme}', adventure.theme)
        .replace('{setting}', adventure.setting)
        .replace('{plotSummary}', adventure.plotSummary)
        .replace('{plotPoints}', adventure.plotPoints)
        .replace('{keyElements}', adventure.keyElements)
        .replace('{winCondition}', adventure.winCondition)
        .replace('{currentState.location}', JSON.stringify(currentState.location))
        .replace('{currentState.timeOfDay}', currentState.environment.timeOfDay)
        .replace('{currentState.weather}', currentState.environment.weather)
        .replace('{currentState.recentEvents}', JSON.stringify(currentState.recentEvents))
        .replace('{currentState.environmentalEffects}', JSON.stringify(currentState.elements))
        .replace('{partyStatus}', JSON.stringify(partyStatus))
        .replace('{situation}', situation)
        .replace('{chosenOption}', chosenOption)
        .replace('{additionalAction}', additionalAction)
        .replace('{customRule}', customRule)
        .replace('{customNote}', customNote);
}

// Add function to clean JSON response
function cleanJsonResponse(response) {
    try {
        // First clean up any markdown or extra whitespace
        let cleaned = response;
        
        // Remove markdown code blocks if present
        if (cleaned.startsWith('```json\n')) {
            cleaned = cleaned.slice(8); // Remove ```json\n prefix
        }
        if (cleaned.endsWith('\n```')) {
            cleaned = cleaned.slice(0, -4); // Remove \n``` suffix
        }
        
        // Remove any remaining markdown code block markers
        cleaned = cleaned.replace(/```/g, '');
        
        // Trim whitespace
        cleaned = cleaned.trim();
        
        // Try to parse and re-stringify to ensure valid JSON
        const parsed = JSON.parse(cleaned);
        
        // Validate required fields
        if (!parsed.consequence || !parsed.stateChanges || !parsed.nextSituation || !parsed.nextChoices || !parsed.gameState) {
            throw new Error('Response missing required fields');
        }
        
        return JSON.stringify(parsed);
    } catch (error) {
        debugLog('ERROR', 'Failed to clean JSON response', {
            original: response,
            error: error.message
        });
        
        // Try to extract just the JSON content if there's extra text
        try {
            const jsonStart = response.indexOf('{');
            const jsonEnd = response.lastIndexOf('}') + 1;
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const jsonContent = response.slice(jsonStart, jsonEnd);
                const parsed = JSON.parse(jsonContent);
                return JSON.stringify(parsed);
            }
        } catch (secondError) {
            debugLog('ERROR', 'Failed second attempt to parse JSON', {
                error: secondError.message
            });
        }
        
        throw new Error('Failed to parse response from AI. Please try again.');
    }
}

// Add function to truncate text for Discord embeds
function truncateForDiscord(text, maxLength = 1024) {
    if (!text) return 'No information available.';
    
    try {
        // Use the centralized chunking function
        const chunks = chunkMessage(text);
        
        // If we have chunks, return the first one truncated to maxLength
        if (chunks.length > 0) {
            const firstChunk = chunks[0];
            if (firstChunk.length <= maxLength) {
                return firstChunk;
            }
            return firstChunk.substring(0, maxLength - 3) + '...';
        }
        
        // Fallback to simple truncation if chunking fails
        return text.length > maxLength 
            ? text.substring(0, maxLength - 3) + '...' 
            : text;
    } catch (error) {
        console.error('Error truncating text for Discord:', {
            error: error.message || 'Unknown error',
            stack: error.stack || 'No stack trace available',
            textLength: text?.length
        });
        
        // Fallback to simple truncation
        return text.length > maxLength 
            ? text.substring(0, maxLength - 3) + '...' 
            : text;
    }
}

// Add function to format text for narration
function formatForNarration(text) {
    if (!text) return '';
    
    return text
        .replace(/\*\*/g, '')           // Remove bold markdown
        .replace(/\*/g, '')             // Remove italic markdown
        .replace(/`/g, '')              // Remove code markdown
        .replace(/\n\n/g, '. ')         // Replace double newlines with period and space
        .replace(/\n/g, ' ')            // Replace single newlines with space
        .replace(/\s+/g, ' ')           // Replace multiple spaces with single space
        .replace(/\[\[/g, '')           // Remove any special brackets
        .replace(/\]\]/g, '')
        .replace(/\(\(/g, '')
        .replace(/\)\)/g, '')
        .trim();                        // Remove leading/trailing whitespace
}

// Add function to select voice based on context
function selectVoiceForContext(context, partyStatus, situation) {
    // Map of context types to voice names
    const voiceMap = {
        // Narrator voices for different scenarios
        'default': 'en-US-JennyNeural',
        'epic': 'en-US-GuyNeural',
        'mysterious': 'en-US-DavisNeural',
        'friendly': 'en-US-AmberNeural',
        'dramatic': 'en-US-ChristopherNeural',
        'battle': 'en-US-BrianNeural',
        'somber': 'en-US-SaraNeural',
        // Character voices for specific roles
        'warrior': 'en-US-JasonNeural',
        'mage': 'en-US-TonyNeural',
        'rogue': 'en-US-AriaNeural',
        'healer': 'en-US-JaneNeural',
        'noble': 'en-US-SteffanNeural',
        'merchant': 'en-US-NancyNeural'
    };

    // Determine voice based on multiple context factors
    let voiceType = 'default';
    
    // Check atmosphere for voice selection
    if (context.atmosphere) {
        const atmosphere = context.atmosphere.toLowerCase();
        
        // Battle/Combat scenarios
        if (atmosphere.includes('battle') || atmosphere.includes('combat') || atmosphere.includes('fight')) {
            voiceType = 'battle';
        }
        // Epic/Grand moments
        else if (atmosphere.includes('epic') || atmosphere.includes('grand') || atmosphere.includes('legendary')) {
            voiceType = 'epic';
        }
        // Mysterious/Suspenseful situations
        else if (atmosphere.includes('mysterious') || atmosphere.includes('suspense') || atmosphere.includes('eerie')) {
            voiceType = 'mysterious';
        }
        // Peaceful/Social interactions
        else if (atmosphere.includes('friendly') || atmosphere.includes('peaceful') || atmosphere.includes('calm')) {
            voiceType = 'friendly';
        }
        // Dramatic/Intense moments
        else if (atmosphere.includes('dramatic') || atmosphere.includes('intense') || atmosphere.includes('urgent')) {
            voiceType = 'dramatic';
        }
        // Somber/Serious situations
        else if (atmosphere.includes('somber') || atmosphere.includes('sad') || atmosphere.includes('grave')) {
            voiceType = 'somber';
        }
    }

    // Check for specific character interactions
    if (situation && situation.toLowerCase().includes('merchant')) {
        voiceType = 'merchant';
    } else if (situation && situation.toLowerCase().includes('noble')) {
        voiceType = 'noble';
    }

    // Check party status for combat situations
    if (partyStatus) {
        const hasInjuredMembers = partyStatus.some(member => 
            member.status === 'INJURED' || member.health < 50
        );
        const hasCriticalMembers = partyStatus.some(member => 
            member.status === 'INCAPACITATED' || member.health < 25
        );

        if (hasCriticalMembers) {
            voiceType = 'dramatic'; // Use dramatic voice for critical situations
        } else if (hasInjuredMembers && voiceType === 'default') {
            voiceType = 'somber'; // Use somber voice when party is injured
        }
    }

    return voiceMap[voiceType];
}

// Add function for getting next player in round-robin order
async function getNextPlayer(transaction, adventureId, currentPlayerId) {
    const result = await transaction.request()
        .input('adventureId', sql.Int, adventureId)
        .input('currentPlayerId', sql.Int, currentPlayerId)
        .query(`
            WITH PlayerOrder AS (
                SELECT 
                    pm.id,
                    pm.adventurerName,
                    ROW_NUMBER() OVER (ORDER BY pm.joinedAt) as turnOrder
                FROM partyMembers pm
                JOIN adventurerStates ast ON pm.id = ast.partyMemberId
                WHERE ast.adventureId = @adventureId
                    AND ast.status != 'DEAD'
                    AND ast.status != 'INCAPACITATED'
            )
            SELECT id, adventurerName
            FROM PlayerOrder
            WHERE turnOrder = (
                SELECT (turnOrder % (SELECT COUNT(*) FROM PlayerOrder)) + 1
                FROM PlayerOrder
                WHERE id = @currentPlayerId
            )
        `);
    
    return result.recordset[0];
}

// Add mood detection function
function getMoodFromContext(context) {
    if (!context.atmosphere) return 'exploration'; // default

    const atmosphere = context.atmosphere.toLowerCase();
    
    if (atmosphere.includes('battle') || atmosphere.includes('combat')) {
        return 'battle';
    } else if (atmosphere.includes('mystery') || atmosphere.includes('enigma')) {
        return 'mystery';
    } else if (atmosphere.includes('victory') || atmosphere.includes('triumph')) {
        return 'celebration';
    } else if (atmosphere.includes('danger') || atmosphere.includes('threat')) {
        return 'danger';
    } else if (atmosphere.includes('peaceful') || atmosphere.includes('calm')) {
        return 'peaceful';
    } else if (atmosphere.includes('sad') || atmosphere.includes('sorrow')) {
        return 'sad';
    } else if (atmosphere.includes('dramatic') || atmosphere.includes('intense')) {
        return 'dramatic';
    }
    
    return 'exploration';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('makedecision')
        .setDescription('Make a decision in your adventure.')
        .addIntegerOption(option =>
            option.setName('partyid')
                .setDescription('The ID of your party')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('choice')
                .setDescription('Choose 1-3 for given options, or 4 for custom action')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(4)
        )
        .addStringOption(option =>
            option.setName('customaction')
                .setDescription('Optional: Describe what else you want to do (required for choice 4)')
                .setRequired(false)
        ),

    async execute(interaction) {
        let voiceConnection = null;
        let audioPlayer = null;
        let narrationPlayer = null;

        try {
            await interaction.deferReply();
            console.log('Starting makeDecision command execution...');
            const username = interaction.user.tag.split('#')[0];
            const partyId = interaction.options.getInteger('partyid');
            const choiceNum = interaction.options.getInteger('choice');
            const customAction = interaction.options.getString('customaction');

            // Validate that choice 4 includes a custom action
            if (choiceNum === 4 && !customAction) {
                await interaction.editReply({
                    content: 'When choosing option 4 (custom action), you must describe what you want to do using the customaction option.',
                    ephemeral: true
                });
                return;
            }

            let transaction;
            let committed = false;

            try {
                await getConnection();
                transaction = new sql.Transaction();
                await transaction.begin();

                // Get user ID and verify membership
                const userResult = await transaction.request()
                    .input('username', sql.NVarChar, username)
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT u.id as userId, pm.id as partyMemberId, pm.adventurerName
                        FROM users u
                        LEFT JOIN partyMembers pm ON u.id = pm.userId AND pm.partyId = @partyId
                        WHERE u.username = @username
                    `);

                if (!userResult.recordset.length || !userResult.recordset[0].partyMemberId) {
                    throw new Error('Not a party member');
                }

                const { userId, partyMemberId, adventurerName } = userResult.recordset[0];

                // Get current adventure
                const adventureResult = await transaction.request()
                    .input('partyId', sql.Int, partyId)
                    .query(`
                        SELECT a.id as adventureId, 
                               a.theme,
                               a.setting,
                               a.plotSummary,
                               a.plotPoints,
                               a.keyElements,
                               a.winCondition,
                               a.currentState,
                               p.adventureStatus
                        FROM adventures a
                        JOIN parties p ON a.partyId = p.id
                        WHERE p.id = @partyId
                    `);

                if (!adventureResult.recordset.length) {
                    throw new Error('No active adventure');
                }

                const adventure = adventureResult.recordset[0];

                // Get current decision point
                const decisionResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT TOP 1 id, partyMemberId, situation, choices
                        FROM decisionPoints
                        WHERE adventureId = @adventureId
                        AND resolvedAt IS NULL
                        ORDER BY createdAt DESC
                    `);

                if (!decisionResult.recordset.length) {
                    throw new Error('No pending decisions');
                }

                const currentDecision = decisionResult.recordset[0];
                if (currentDecision.partyMemberId !== partyMemberId) {
                    throw new Error('Not your turn');
                }

                let chosenOption = '';
                if (choiceNum === 4) {
                    chosenOption = customAction;
                } else {
                    const choices = JSON.parse(currentDecision.choices);
                    if (choiceNum > choices.length) {
                        throw new Error(`Invalid choice number. Available choices are 1-${choices.length}, or 4 for custom action.`);
                    }
                    chosenOption = choices[choiceNum - 1];
                }

                // Get party status
                const partyStatusResult = await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .query(`
                        SELECT pm.id, pm.adventurerName, ast.*
                        FROM adventurerStates ast
                        JOIN partyMembers pm ON ast.partyMemberId = pm.id
                        WHERE ast.adventureId = @adventureId
                    `);

                const partyStatus = partyStatusResult.recordset.map(member => ({
                    id: member.id,
                    name: member.adventurerName,
                    health: member.health,
                    status: member.status,
                    conditions: member.conditions ? JSON.parse(member.conditions) : [],
                    inventory: member.inventory ? JSON.parse(member.inventory) : []
                }));

                // Generate consequence and next situation
                const prompt = formatDecisionPrompt(
                    adventure,
                    JSON.parse(adventure.currentState),
                    currentDecision.situation,
                    chosenOption,
                    partyStatus,
                    customAction,
                    choiceNum
                );

                console.log('Sending prompt to OpenAI...', { adventureId: adventure.adventureId, decisionId: currentDecision.id });
                
                let completion;
                try {
                    completion = await openai.chat.completions.create({
                        model: "gpt-4o",  // Fixed model name
                        messages: [{ role: "user", content: prompt }]
                    });
                } catch (openaiError) {
                    console.error('OpenAI API Error:', {
                        error: openaiError.message,
                        stack: openaiError.stack,
                        response: openaiError.response?.data
                    });
                    throw new Error(`OpenAI API error: ${openaiError.message}`);
                }

                if (!completion?.choices?.[0]?.message?.content) {
                    console.error('Invalid OpenAI response:', completion);
                    throw new Error('Received invalid response from OpenAI');
                }

                console.log('Received OpenAI response, parsing JSON...');
                
                let response;
                try {
                    response = JSON.parse(cleanJsonResponse(completion.choices[0].message.content));
                } catch (parseError) {
                    console.error('JSON Parse Error:', {
                        error: parseError.message,
                        content: completion.choices[0].message.content
                    });
                    throw new Error('Failed to parse AI response');
                }

                console.log('Successfully parsed response, processing game updates...');
                
                // Process the response and update game state
                const nextPlayer = await getNextPlayer(transaction, adventure.adventureId, partyMemberId);

                // Update adventurer states based on response
                for (const stateChange of response.stateChanges) {
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, stateChange.adventurerId)
                        .input('health', sql.Int, stateChange.changes.health)
                        .input('status', sql.NVarChar, stateChange.changes.status)
                        .input('conditions', sql.NVarChar, JSON.stringify(stateChange.changes.conditions || []))
                        .input('inventory', sql.NVarChar, JSON.stringify(stateChange.changes.inventory || []))
                        .query(`
                            UPDATE adventurerStates
                            SET health = @health,
                                status = @status,
                                conditions = @conditions,
                                inventory = @inventory,
                                lastUpdated = GETDATE()
                            WHERE adventureId = @adventureId
                            AND partyMemberId = @partyMemberId
                        `);
                }

                // Mark current decision as resolved
                await transaction.request()
                    .input('decisionId', sql.Int, currentDecision.id)
                    .input('choiceMade', sql.NVarChar, chosenOption)
                    .input('consequence', sql.NVarChar, JSON.stringify(response.consequence))
                    .input('plotProgress', sql.NVarChar, response.consequence.plotProgress || null)
                    .input('keyElementsUsed', sql.NVarChar, JSON.stringify(response.consequence.keyElementsUsed || []))
                    .input('resolvedAt', sql.DateTime, new Date())
                    .query(`
                        UPDATE decisionPoints
                        SET resolvedAt = @resolvedAt,
                            choiceMade = @choiceMade,
                            consequence = @consequence,
                            plotProgress = @plotProgress,
                            keyElementsUsed = @keyElementsUsed
                        WHERE id = @decisionId
                    `);

                // Add game state check before creating next decision point
                if (response.gameState.isEnding) {
                    // Update adventure status based on end type
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('status', sql.NVarChar, response.gameState.endType)
                        .input('endReason', sql.NVarChar, response.gameState.endReason)
                        .query(`
                            UPDATE adventures
                            SET status = @status,
                                endReason = @endReason,
                                completedAt = GETDATE()
                            WHERE id = @adventureId
                        `);
                } else {
                    // Create next decision point only if game isn't ending
                    await transaction.request()
                        .input('adventureId', sql.Int, adventure.adventureId)
                        .input('partyMemberId', sql.Int, nextPlayer.id)
                        .input('situation', sql.NVarChar, response.nextSituation.narration)
                        .input('choices', sql.NVarChar, JSON.stringify(response.nextChoices))
                        .query(`
                            INSERT INTO decisionPoints (adventureId, partyMemberId, situation, choices)
                            VALUES (@adventureId, @partyMemberId, @situation, @choices)
                        `);
                }

                // Update adventure state
                const newState = {
                    ...JSON.parse(adventure.currentState),
                    location: response.nextSituation.location,
                    environment: {
                        timeOfDay: response.nextSituation.timeOfDay,
                        weather: response.nextSituation.weather,
                        visibility: response.nextSituation.visibility
                    },
                    recentEvents: [
                        response.consequence.narration,
                        ...(JSON.parse(adventure.currentState).recentEvents || []).slice(0, 4)
                    ]
                };

                await transaction.request()
                    .input('adventureId', sql.Int, adventure.adventureId)
                    .input('currentState', sql.NVarChar, JSON.stringify(newState))
                    .query(`
                        UPDATE adventures
                        SET currentState = @currentState
                        WHERE id = @adventureId
                    `);

                // Set up voice connection if user is in a voice channel
                const voiceChannel = interaction.member.voice.channel;
                
                if (voiceChannel) {
                    try {
                        // Check bot permissions
                        const permissions = voiceChannel.permissionsFor(interaction.client.user);
                        if (!permissions.has('Connect') || !permissions.has('Speak')) {
                            throw new Error('I need permissions to join and speak in your voice channel.');
                        }

                        // Create voice connection with proper error handling
                        try {
                            voiceConnection = joinVoiceChannel({
                                channelId: voiceChannel.id,
                                guildId: voiceChannel.guild.id,
                                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                                selfDeaf: false
                            });

                            // Set up connection error handler
                            voiceConnection.on('error', error => {
                                console.error('Voice connection error:', {
                                    error: error.message,
                                    stack: error.stack,
                                    channelId: voiceChannel.id
                                });
                            });

                            // Wait for connection to be ready
                            await Promise.race([
                                entersState(voiceConnection, VoiceConnectionStatus.Ready, 30_000),
                                new Promise((_, reject) => 
                                    setTimeout(() => reject(new Error('Voice connection timeout')), 30000)
                                )
                            ]);

                            // Create separate players for background music and narration
                            audioPlayer = createAudioPlayer({
                                behaviors: {
                                    noSubscriber: NoSubscriberBehavior.Play
                                }
                            });
                            
                            narrationPlayer = createAudioPlayer({
                                behaviors: {
                                    noSubscriber: NoSubscriberBehavior.Play
                                }
                            });

                            // Subscribe both players to the connection
                            voiceConnection.subscribe(audioPlayer);
                            voiceConnection.subscribe(narrationPlayer);

                            // Set up audio player error handlers
                            audioPlayer.on('error', error => {
                                console.error('Background music error:', {
                                    error: error.message,
                                    stack: error.stack
                                });
                            });

                            narrationPlayer.on('error', error => {
                                console.error('Narration error:', {
                                    error: error.message,
                                    stack: error.stack
                                });
                            });

                            // Determine the appropriate background music based on context
                            const mood = getMoodFromContext(response.consequence);
                            const backgroundMusicPath = path.join(process.cwd(), 'data', 'music', `${mood}.mp3`);

                            // Verify the background music exists
                            try {
                                await fs.access(backgroundMusicPath);
                            } catch (error) {
                                throw new Error(`Background music for mood "${mood}" not found. Please run /generateallmusic first.`);
                            }

                            // Play the background music at reduced volume
                            const musicResource = createAudioResource(backgroundMusicPath, {
                                inputType: StreamType.Arbitrary,
                                inlineVolume: true
                            });
                            musicResource.volume.setVolume(0.3); // Set background music to 30% volume
                            audioPlayer.play(musicResource);

                            // Generate and play narration
                            try {
                                const narrationText = response.consequence.narration;
                                const narrationStream = await voiceService.generateNarration(narrationText);
                                
                                const narrationResource = createAudioResource(narrationStream, {
                                    inputType: StreamType.Arbitrary,
                                    inlineVolume: true
                                });
                                narrationResource.volume.setVolume(1.0); // Keep narration at full volume
                                narrationPlayer.play(narrationResource);

                                // Wait for narration to finish
                                await new Promise((resolve) => {
                                    narrationPlayer.on(AudioPlayerStatus.Idle, () => {
                                        resolve();
                                    });
                                });

                            } catch (narrationError) {
                                console.error('Narration generation error:', narrationError);
                                // Continue with background music only if narration fails
                            }

                        } catch (voiceError) {
                            console.error('Voice setup error:', {
                                error: voiceError.message,
                                stack: voiceError.stack,
                                channelId: voiceChannel.id
                            });
                            throw new Error('Failed to set up voice connection. Please try again.');
                        }

                    } catch (voiceError) {
                        console.error('Error in voice narration:', voiceError);
                        // Continue with text-only response if voice fails
                    } finally {
                        // Cleanup function for voice resources
                        const cleanup = async () => {
                            if (narrationPlayer) {
                                try {
                                    narrationPlayer.stop();
                                } catch (cleanupError) {
                                    console.error('Error stopping narration player:', cleanupError);
                                }
                            }
                            if (audioPlayer) {
                                try {
                                    audioPlayer.stop();
                                } catch (cleanupError) {
                                    console.error('Error stopping audio player:', cleanupError);
                                }
                            }
                            if (voiceConnection) {
                                try {
                                    voiceConnection.destroy();
                                } catch (cleanupError) {
                                    console.error('Error destroying voice connection:', cleanupError);
                                }
                            }
                        };

                        // Set up cleanup on process exit
                        process.once('SIGINT', cleanup);
                        process.once('SIGTERM', cleanup);
                    }
                }

                // Create response embed
                const embed = {
                    color: 0x0099ff,
                    title: `Decision for ${adventurerName}`,
                    description: `Chose: ${chosenOption}${customAction ? `\nAdditional Action: ${customAction}` : ''}`,
                    fields: [
                        {
                            name: 'What Happened',
                            value: truncateForDiscord(response.consequence.narration)
                        },
                        {
                            name: 'Additional Details',
                            value: truncateForDiscord(response.consequence.details || 'No additional details.')
                        },
                        {
                            name: 'Objective Progress',
                            value: truncateForDiscord(
                                `Completed: ${response.consequence.objectiveProgress.completedObjectives.join(', ') || 'None'}\n` +
                                `Failed: ${response.consequence.objectiveProgress.failedObjectives.join(', ') || 'None'}\n` +
                                `Remaining: ${response.consequence.objectiveProgress.remainingObjectives.join(', ') || 'None'}\n` +
                                `New Obstacles: ${response.consequence.objectiveProgress.newObstacles.join(', ') || 'None'}\n` +
                                `Progress: ${response.consequence.objectiveProgress.distanceFromWinCondition}`
                            )
                        },
                        {
                            name: 'Resources Used',
                            value: truncateForDiscord(
                                response.consequence.objectiveProgress.resourcesUsed.join(', ') || 'No resources used'
                            )
                        },
                        {
                            name: 'Game State',
                            value: truncateForDiscord(
                                `Party Status: ${response.gameState.partyViability}\n` +
                                `Objective Status: ${response.gameState.objectiveViability}\n` +
                                (response.gameState.isEnding ? `Ending: ${response.gameState.endType}\n${response.gameState.endReason}` : 'Adventure Continues')
                            )
                        },
                        {
                            name: '\u200B',
                            value: '\u200B'
                        },
                        {
                            name: `${nextPlayer.adventurerName}'s Turn`,
                            value: truncateForDiscord(response.nextSituation.narration)
                        },
                        {
                            name: 'Situation Details',
                            value: truncateForDiscord(response.nextSituation.details || 'No additional details.')
                        },
                        {
                            name: 'Current State',
                            value: truncateForDiscord(
                                `Location: ${response.nextSituation.location}\nTime: ${response.nextSituation.timeOfDay}\nWeather: ${response.nextSituation.weather}\nVisibility: ${response.nextSituation.visibility}`
                            )
                        },
                        {
                            name: 'Active Threats',
                            value: truncateForDiscord(
                                response.nextSituation.activeThreats.length > 0 
                                    ? response.nextSituation.activeThreats.join('\n')
                                    : 'No immediate threats.'
                            )
                        },
                        {
                            name: 'Available Opportunities',
                            value: truncateForDiscord(
                                response.nextSituation.availableOpportunities.length > 0
                                    ? response.nextSituation.availableOpportunities.join('\n')
                                    : 'No special opportunities available.'
                            )
                        },
                        {
                            name: 'Available Choices',
                            value: truncateForDiscord(
                                response.nextChoices.map((choice, index) => 
                                    `${index + 1}. ${choice}`
                                ).join('\n')
                            )
                        }
                    ]
                };

                await interaction.editReply({ embeds: [embed] });

                await transaction.commit();
                committed = true;

            } catch (error) {
                if (!committed && transaction) {
                    try {
                        await transaction.rollback();
                    } catch (rollbackError) {
                        debugLog('ERROR', 'Error rolling back transaction', {
                            error: rollbackError.message,
                            stack: rollbackError.stack
                        });
                    }
                }

                let errorMessage = 'Failed to process decision.';
                if (error.message) {
                    switch (error.message) {
                        case 'Not a party member':
                            errorMessage = 'You are not a member of this party.';
                            break;
                        case 'No active adventure':
                            errorMessage = 'There is no active adventure for this party.';
                            break;
                        case 'Adventure is not in progress':
                            errorMessage = 'This adventure is not currently in progress.';
                            break;
                        case 'No pending decisions':
                            errorMessage = 'There are no pending decisions to make.';
                            break;
                        case 'Not your turn':
                            errorMessage = 'It is not your turn to make a decision.';
                            break;
                        case 'Custom action is required when using choice 4':
                            errorMessage = 'When using choice 4, you must provide a custom action.';
                            break;
                        default:
                            if (error.message.includes('Invalid choice number')) {
                                errorMessage = error.message;
                            } else {
                                console.error('Unexpected error in makeDecision:', {
                                    error: error.message,
                                    stack: error.stack,
                                    username,
                                    partyId,
                                    choiceNum,
                                    customAction
                                });
                            }
                    }
                }

                const errorEmbed = {
                    color: 0xFF0000,
                    title: 'Error Processing Decision',
                    description: errorMessage,
                    fields: []
                };

                if (process.env.NODE_ENV === 'development') {
                    errorEmbed.fields.push({
                        name: 'Debug Info',
                        value: `Error: ${error.message}\nStack: ${error.stack}`
                    });
                }

                await interaction.editReply({ embeds: [errorEmbed] });
            }
        } catch (error) {
            console.error('Critical error in makeDecision command:', {
                error: error.message || 'Unknown error',
                stack: error.stack || 'No stack trace available',
                context: {
                    username: interaction.user.tag,
                    partyId: interaction.options.getInteger('partyid'),
                    choiceNum: interaction.options.getInteger('choice'),
                    customAction: interaction.options.getString('customaction')
                }
            });
            
            try {
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply('A critical error occurred. Please try again later.');
                }
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
        } finally {
            // Cleanup voice resources
            if (audioPlayer) {
                try {
                    audioPlayer.stop();
                } catch (cleanupError) {
                    console.error('Error stopping audio player:', cleanupError);
                }
            }
            if (voiceConnection) {
                try {
                    voiceConnection.destroy();
                } catch (cleanupError) {
                    console.error('Error destroying voice connection:', cleanupError);
                }
            }
        }
    }
}; 