// TODO: Add proper handling for party creation validation
// TODO: Add proper handling for party size limits
// TODO: Add proper handling for party member roles
// TODO: Add proper handling for party state persistence
// TODO: Add proper handling for party creation timeouts
// TODO: Add proper handling for party cleanup
// TODO: Add proper handling for party permissions
// TODO: Add proper handling for party metadata
// TODO: Add proper handling for party events
// TODO: Add proper handling for party error recovery

const { SlashCommandBuilder } = require('discord.js');
const PartyManager = require('../../services/adventure/managers/partyManager');
const { logger, responseFormatter } = require('../../services/adventure/utils');
const { getConnection, executeTransaction } = require('../../azureDb');
const sql = require('mssql');

const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('createparty')
        .setDescription('Create a new adventure party')
        .addStringOption(option =>
            option.setName('adventurername')
                .setDescription('Your adventurer name')
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(100))
        .addStringOption(option =>
            option.setName('backstory')
                .setDescription('Your character\'s backstory')
                .setRequired(false)
                .setMaxLength(4000))
        .addBooleanOption(option => 
            option.setName('forcecleanup')
                .setDescription('Force cleanup any previous corrupted party data')
                .setRequired(false)),

    async execute(interaction) {
        const userId = interaction.user.id;
        
        try {
            await interaction.deferReply();

            // Validate database connection first
            try {
                await executeTransaction(async (transaction) => {
                    // Test the connection with a simple query
                    await transaction.request().query('SELECT 1');
                });
            } catch (dbError) {
                logger.error('Database connection failed', {
                    error: dbError.message,
                    stack: dbError.stack
                });
                throw new Error('Unable to connect to the database. Please try again later.');
            }
            
            // Get and validate the adventurer name
            const adventurerName = interaction.options.getString('adventurername')?.trim();
            if (!adventurerName || adventurerName.length === 0) {
                throw new Error('Please provide a valid adventurer name');
            }
            
            // Validate backstory length if provided
            const backstory = interaction.options.getString('backstory')?.trim() || null;
            if (backstory && backstory.length > 4000) {
                throw new Error('Backstory must be 4000 characters or less');
            }
            
            // Check if force cleanup is requested
            const forceCleanup = interaction.options.getBoolean('forcecleanup');
            
            // Log the input parameters for debugging
            logger.debug('Creating party with parameters', {
                userId,
                adventurerName,
                backstoryLength: backstory ? backstory.length : 0,
                forceCleanup: !!forceCleanup
            });

            // Ensure user exists in database
            try {
                await executeTransaction(async (transaction) => {
                    logger.debug('Checking if user exists in database', { userId });
                    
                    const userResult = await transaction.request()
                        .input('discordId', sql.VarChar(255), userId)
                        .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');

                    if (userResult.recordset.length === 0) {
                        // Create new user
                        logger.info('User not found, creating new user record', { 
                            userId, 
                            username: interaction.user.username 
                        });
                        
                        const insertResult = await transaction.request()
                            .input('discordUsername', sql.NVarChar(255), interaction.user.username)
                            .input('discordId', sql.VarChar(255), userId)
                            .input('username', sql.NVarChar(50), interaction.user.username)
                            .query(`
                                INSERT INTO users (discordUsername, discordId, username) 
                                VALUES (@discordUsername, @discordId, @username);
                                SELECT SCOPE_IDENTITY() as id;
                            `);
                            
                            // Verify the user was created successfully    
                            if (!insertResult.recordset || !insertResult.recordset[0]) {
                                logger.error('Failed to create user - no ID returned', { userId });
                                throw new Error('Failed to create user account - database error');
                            }
                            
                            logger.info('Successfully created user', { 
                                userId, 
                                internalId: insertResult.recordset[0].id 
                            });
                        } else {
                            logger.debug('User already exists in database', { 
                                userId, 
                                internalId: userResult.recordset[0].id 
                            });
                        }
                    });
                } catch (error) {
                    logger.error('Error ensuring user exists', {
                        error: error.message,
                        stack: error.stack,
                        userId
                    });
                    throw new Error('Failed to create user account. Please try again.');
                }
                
                // Get the internal user ID (this should exist after the above block)
                let internalUserId;
                try {
                    await executeTransaction(async (transaction) => {
                        const userResult = await transaction.request()
                            .input('discordId', sql.VarChar(255), userId)
                            .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                        if (!userResult.recordset || userResult.recordset.length === 0 || !userResult.recordset[0].id) {
                            logger.error('Could not find internal user ID after creation/check', { userId });
                            throw new Error('Failed to retrieve user account details.');
                        }
                        // Ensure the ID is parsed as an integer
                        const rawInternalId = userResult.recordset[0].id;
                        internalUserId = parseInt(rawInternalId, 10);
                        
                        if (isNaN(internalUserId)) {
                            logger.error('Failed to parse internal user ID as integer', { userId, rawInternalId });
                            throw new Error('Internal error: Invalid user account ID format.');
                        }
                        logger.debug('Retrieved and parsed internal user ID for party creation', { userId, internalUserId });
                    });
                } catch (error) {
                     logger.error('Error retrieving internal user ID', {
                        error: error.message,
                        stack: error.stack,
                        userId
                    });
                    throw new Error('Failed to retrieve user account details. Please try again.');
                }

                // If force cleanup is requested, do a direct database cleanup
                if (forceCleanup) {
                    try {
                        await interaction.editReply({ content: 'Cleaning up any previous party data...' });
                        
                        // Try more direct database cleanup first for efficiency
                        await executeTransaction(async (transaction) => {
                            logger.info('Performing direct database cleanup', { userId });
                            
                            // Set longer timeout
                            transaction.request().timeout = 120000; // 2 minutes
                            
                            // Get internal userId
                            const userResult = await transaction.request()
                                .input('discordId', sql.VarChar(255), userId)
                                .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                                
                            if (userResult.recordset && userResult.recordset.length > 0) {
                                const internalUserId = userResult.recordset[0].id;
                                
                                // Identify parties this user is involved in (leader or member)
                                const partyIdsResult = await transaction.request()
                                    .input('userId', sql.Int, internalUserId)
                                    .query(`
                                        SELECT DISTINCT p.id AS partyId
                                        FROM parties p
                                        LEFT JOIN partyMembers pm ON p.id = pm.partyId
                                        WHERE p.leaderId = @userId OR pm.userId = @userId;
                                    `);
                                
                                const partyIdsToClean = partyIdsResult.recordset.map(r => r.partyId);

                                if (partyIdsToClean.length > 0) {
                                    logger.info('Identified parties for cleanup', { userId, internalUserId, partyIds: partyIdsToClean });

                                    // Create parameters for the IN clause
                                    const partyIdParams = partyIdsToClean.map((id, index) => `@partyId${index}`).join(',');
                                    const request = transaction.request();
                                    partyIdsToClean.forEach((id, index) => {
                                        request.input(`partyId${index}`, sql.Int, id);
                                    });

                                    // Delete from partyAdventures first (FK dependency)
                                    await request.query(`DELETE FROM partyAdventures WHERE partyId IN (${partyIdParams})`);
                                    
                                    // Clone request for next query (or create new)
                                    const request2 = transaction.request();
                                    partyIdsToClean.forEach((id, index) => {
                                        request2.input(`partyId${index}`, sql.Int, id);
                                    });
                                    // Delete party members associated with these parties
                                    await request2.query(`DELETE FROM partyMembers WHERE partyId IN (${partyIdParams})`);
                                    
                                     // Clone request for next query (or create new)
                                     const request3 = transaction.request();
                                     partyIdsToClean.forEach((id, index) => {
                                         request3.input(`partyId${index}`, sql.Int, id);
                                     });
                                    // Delete the parties themselves
                                    await request3.query(`DELETE FROM parties WHERE id IN (${partyIdParams})`);
                                    
                                    // Also clean member entries where user is just a member (if not caught above)
                                    await transaction.request()
                                        .input('userId', sql.Int, internalUserId)
                                        .query('DELETE FROM partyMembers WHERE userId = @userId');
                                
                                } else {
                                     logger.info('No associated parties found for cleanup', { userId, internalUserId });
                                }
                                    
                                logger.info('Direct database cleanup completed', { userId, internalUserId });
                            } else {
                                logger.warn('User not found in database during cleanup', { userId });
                            }
                        });
                        
                        // Then also use the party manager cleanup for a thorough cleanup
                        await partyManager.forceCleanupUserPartyRecords(userId.toString());
                        
                        logger.info('Forced cleanup of user party records completed', { userId });
                        await interaction.editReply({ content: 'Previous party data cleaned up. Creating new party...' });
                    } catch (cleanupError) {
                        logger.error('Error during forced party cleanup', { 
                            error: cleanupError.message,
                            stack: cleanupError.stack,
                            userId 
                        });
                        
                        // Don't fail the command if cleanup fails, just warn and continue
                        await interaction.editReply({ 
                            content: 'Warning: Party cleanup encountered issues but will continue creating new party...' 
                        });
                    }
                }
                
                // Create party using the party manager with retries
                let party;
                let retryCount = 0;
                const maxRetries = 3;
                
                while (!party && retryCount < maxRetries) {
                    try {
                        party = await partyManager.createParty({
                            leaderId: userId.toString(),
                            internalLeaderId: internalUserId,
                            adventurerName,
                            backstory,
                            settings: {
                                maxSize: 4,
                                minPartySize: 1,
                                voiceChannel: interaction.member?.voice?.channel?.id || null
                            }
                        });
                        
                        if (!party || !party.id) {
                            throw new Error('Party created but invalid response');
                        }
                        
                        break; // Success, exit retry loop
                    } catch (error) {
                        retryCount++;
                        
                        // Log the error with more context
                        logger.error('Error during party creation attempt', {
                            attempt: retryCount,
                            error: {
                                message: error.message,
                                code: error.code,
                                state: error.state,
                                stack: error.stack
                            },
                            userId,
                            adventurerName
                        });
                        
                        // If this is the last retry, throw the error
                        if (retryCount === maxRetries) {
                            // Provide a more user-friendly error message
                            if (error.message.includes('already have an active party')) {
                                throw new Error('You already have an active party. Please disband it first with `/disbandparty` or use the force cleanup option.');
                            } else if (error.message.includes('Failed to create party record')) {
                                throw new Error('Unable to create your party. Please try again in a few moments.');
                            } else {
                                throw error; // Pass through other errors
                            }
                        }
                        
                        // If the error is about an existing party, try a more aggressive cleanup
                        if (error.message && error.message.includes('already have an active party')) {
                            try {
                                await interaction.editReply({ content: 'Existing party detected. Performing additional cleanup...' });
                                
                                // Run a deeper, more direct cleanup
                                await executeTransaction(async (transaction) => {
                                    logger.info('Performing deep cleanup after existing party error', { userId });
                                    
                                    // Set longer timeout
                                    transaction.request().timeout = 120000; // 2 minutes
                                    
                                    // Get internal userId
                                    const userResult = await transaction.request()
                                        .input('discordId', sql.VarChar(255), userId)
                                        .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                                        
                                    if (userResult.recordset && userResult.recordset.length > 0) {
                                        const internalUserId = userResult.recordset[0].id;
                                        
                                        // More aggressive cleanup: delete party members
                                        await transaction.request()
                                            .input('userId', sql.Int, internalUserId)
                                            .query(`
                                                -- First find all party IDs this user is part of
                                                DECLARE @UserPartyIds TABLE (PartyId INT);
                                                
                                                -- Get parties where user is a member
                                                INSERT INTO @UserPartyIds
                                                SELECT DISTINCT partyId 
                                                FROM partyMembers WITH (NOLOCK)
                                                WHERE userId = @userId;
                                                
                                                -- Get parties where user is leader
                                                INSERT INTO @UserPartyIds
                                                SELECT DISTINCT id 
                                                FROM parties WITH (NOLOCK)
                                                WHERE leaderId = @userId
                                                AND NOT EXISTS (SELECT 1 FROM @UserPartyIds WHERE PartyId = id);
                                                
                                                -- Delete members of these parties
                                                DELETE FROM partyMembers
                                                WHERE partyId IN (SELECT PartyId FROM @UserPartyIds);
                                                
                                                -- Delete user from other parties
                                                DELETE FROM partyMembers
                                                WHERE userId = @userId;
                                                
                                                -- Delete the parties
                                                DELETE FROM parties
                                                WHERE id IN (SELECT PartyId FROM @UserPartyIds)
                                                OR leaderId = @userId;
                                            `);
                                            
                                        logger.info('Performed emergency deep cleanup', { 
                                            userId, 
                                            internalUserId,
                                            attempt: retryCount
                                        });
                                    }
                                });
                                
                                await interaction.editReply({ content: 'Deep cleanup completed. Retrying party creation...' });
                            } catch (deepCleanupError) {
                                logger.error('Error during deep cleanup', {
                                    error: deepCleanupError,
                                    userId
                                });
                                
                                // Even if this fails, we'll still retry
                                await interaction.editReply({ content: 'Cleanup encountered issues. Retrying anyway...' });
                            }
                        }
                        
                        // Simple delay before retry (exponential backoff)
                        const delay = Math.pow(2, retryCount) * 500;
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
                
                if (!party) {
                    throw new Error('Failed to create party after multiple attempts. Please try again later.');
                }
                
                // Format party data for response
                const response = responseFormatter.formatPartyCreation({
                    partyId: party.id,
                    leaderId: userId,
                    leaderName: interaction.user.username,
                    adventurerName,
                    backstory,
                    memberCount: party.members.length,
                    maxSize: party.settings.maxSize || 4
                });
                
                // Respond to the user
                await interaction.editReply(response);

            } catch (error) {
                logger.error('Failed to create party', { 
                    error: {
                        message: error.message,
                        code: error.code,
                        state: error.state,
                        stack: error.stack
                    },
                    userId,
                    adventurerName: interaction.options.getString('adventurername')
                });

                // Use the error message directly if it's a handled error
                let errorMessage = 'Failed to create the party. Please try again later.';
                
                // Only override with specific message if we have one
                if (error.message && (
                    error.message.includes('Please provide a valid adventurer name') ||
                    error.message.includes('Adventurer name cannot be empty') ||
                    error.message.includes('Adventurer name must be') ||
                    error.message.includes('already have an active party') ||
                    error.message.includes('Unable to create your party') ||
                    error.message.includes('The service is experiencing high demand') ||
                    error.message.includes('Something went wrong with party creation') ||
                    error.message.includes('Unable to connect to the database')
                )) {
                    errorMessage = error.message;
                }
                
                if (interaction.deferred) {
                    await interaction.editReply({ content: errorMessage });
                } else {
                    await interaction.reply({ content: errorMessage, ephemeral: true });
                }
            }
        },
    };