/**
 * Party Repository
 * Handles database operations for parties
 */

const BaseRepository = require('./baseRepository');
const Party = require('../models/Party');
const logger = require('../utils/logger');
const sql = require('mssql');
const { executeTransaction } = require('../../../azureDb');

class PartyRepository extends BaseRepository {
    constructor() {
        super('parties');
    }

    /**
     * Utility to get internal user ID from discord ID
     * @param {Object} transaction Transaction object
     * @param {string} discordId Discord User ID
     * @param {boolean} createUserIfNotFound Whether to create a user record if not found
     * @returns {Promise<number|null>} Internal User ID (INT) or null
     * @private
     */
    async _getInternalUserId(transaction, discordId, createUserIfNotFound = false) {
        if (!discordId) {
            logger.warn('Attempted to get internal ID for null/undefined discordId');
            return null;
        }
        const discordIdStr = discordId.toString().trim();

        const getUserQuery = `
            SELECT id as internalUserId
            FROM users WITH (NOLOCK)
            WHERE discordId = @discordId;
        `;
        
        try {
            const userResult = await this.executeQuery(transaction, getUserQuery, {
                discordId: { value: discordIdStr, type: sql.VarChar(255) }
            });

            if (userResult?.recordset?.[0]?.internalUserId) {
                return userResult.recordset[0].internalUserId;
            }

            if (createUserIfNotFound) {
                logger.info('User not found, attempting to create user record', { discordId: discordIdStr });
                const createUserQuery = `
                    INSERT INTO users (discordId, username, discordUsername)
                    OUTPUT INSERTED.id as internalUserId
                    VALUES (@discordId, @username, @username);
                `;
                const createResult = await this.executeQuery(transaction, createUserQuery, {
                    discordId: { value: discordIdStr, type: sql.VarChar(255) },
                    username: { value: `User_${discordIdStr.substring(0, 8)}`, type: sql.NVarChar(100) }
                });
                
                if (!createResult?.recordset?.[0]?.internalUserId) {
                    logger.error('Failed to create user during ID lookup', { discordId: discordIdStr });
                    throw new Error('Could not create or find user account');
                }
                const internalUserId = createResult.recordset[0].internalUserId;
                logger.info('Created new user', { discordId: discordIdStr, internalUserId });
                return internalUserId;
            } else {
                logger.debug('User not found in database during ID lookup', { discordId: discordIdStr });
                return null;
            }
        } catch (error) {
            logger.error('Error looking up internal user ID', { 
                error: error.message,
                discordId: discordIdStr 
            });
            throw error;
        }
    }

    /**
     * Convert database row to Party model
     * @param {Object} row Database row
     * @returns {Party} Party instance
     * @protected
     */
    _toModel(row) {
        // Handle potential BigInt conversion for leaderId
        const leaderIdStr = row.leaderId ? row.leaderId.toString() : null;
        const memberIdStr = row.memberId ? row.memberId.toString() : null;

        const partyData = {
            id: row.id,
            leaderId: leaderIdStr, // Use string representation for the model
            settings: JSON.parse(row.settings || '{}'),
            adventureStatus: row.adventureStatus,
            createdAt: row.createdAt,
            lastUpdated: row.lastUpdated,
            isActive: row.isActive,
            adventureId: row.adventureId // Include adventureId if present
        };
        
        // Get adventurer name and backstory from the first member (should be leader if available)
        partyData.adventurerName = row.memberName || 'Unknown'; // Default name if none found
        partyData.leaderBackstory = row.memberBackstory || null;

        // Create the party instance
        const party = new Party(partyData);

        // If we have member data, add it
        if (row.memberId && row.memberName) { // Check internal ID exists too
            try {
                const memberDiscordIdStr = (row.memberDiscordId || row.memberId).toString(); // Prefer Discord ID
                const isLeader = memberDiscordIdStr === leaderIdStr;
                party.addMember({
                    userId: memberDiscordIdStr, // Use Discord ID for the model member
                    adventurerName: row.memberName,
                    backstory: row.memberBackstory,
                    memberType: isLeader ? 'leader' : (row.memberRole || 'member')
                });
            } catch (error) {
                logger.warn('Failed to add member during model conversion', {
                    error: error.message,
                    partyId: row.id,
                    memberId: row.memberId, // Log internal ID
                    memberDiscordId: row.memberDiscordId, // Log discord ID
                    memberName: row.memberName
                });
            }
        }

        return party;
    }

    /**
     * Convert Party model to database row
     * Requires internalLeaderId to be passed explicitly
     * @param {Party} model Party instance
     * @param {number} internalLeaderId Internal User ID (INT)
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model, internalLeaderId) {
        if (!internalLeaderId) {
            logger.error('Missing internalLeaderId in _fromModel', {
                modelId: model.id,
                modelLeaderId: model.leaderId
            });
            throw new Error('Internal Leader ID is required for database conversion');
        }

        return {
            leaderId: internalLeaderId, // Use the INT internal ID for the DB
            settings: JSON.stringify(model.settings || { maxSize: 4, minPartySize: 1 }),
            adventureStatus: model.status || 'RECRUITING',
            isActive: model.isActive ?? true,
            lastUpdated: model.lastUpdated || new Date(),
            adventureId: model.adventureId || null // Ensure adventureId is included
        };
    }

    /**
     * Find party by member's Discord ID
     * @param {Object} transaction Transaction object
     * @param {string} discordId User's Discord ID
     * @returns {Promise<Party|null>} Party instance or null
     */
    async findByMember(transaction, discordId) {
        if (!discordId) {
            logger.debug('findByMember called with empty discordId');
            return null;
        }

        try {
            // Get the internal user ID first
            const internalUserId = await this._getInternalUserId(transaction, discordId);

            if (!internalUserId) {
                logger.debug('User not found, cannot find party by member', { discordId });
                return null;
            }

            // Now use the internal user ID to find the party
            const query = `
                SELECT p.*, 
                       u.discordId as memberDiscordId, -- Get discord ID for model conversion
                       pm.userId as memberId, -- Keep internal ID for checks
                       pm.adventurerName as memberName, 
                       pm.backstory as memberBackstory, 
                       pm.memberType as memberRole,
                       pm.joinedAt as memberJoinedAt -- Removed pa.adventureId
                FROM ${this.tableName} p
                INNER JOIN dbo.PartyMembers pm ON p.id = pm.partyId
                INNER JOIN users u ON pm.userId = u.id -- Join users table
                WHERE pm.userId = @internalUserId
                  AND p.isActive = 1
                  AND p.adventureStatus != 'DISBANDED';
            `;

            const result = await this.executeQuery(transaction, query, {
                internalUserId: { value: internalUserId, type: sql.Int }
            });

            if (!result?.recordset?.[0]) {
                return null;
            }
            
            // We need the leader's discord ID for the model, fetch it
            const leaderInternalId = result.recordset[0].leaderId;
            const leaderUserQuery = `SELECT discordId FROM users WHERE id = @leaderInternalId`;
            const leaderUserResult = await this.executeQuery(transaction, leaderUserQuery, { leaderInternalId: { value: leaderInternalId, type: sql.Int }});
            const leaderDiscordId = leaderUserResult.recordset?.[0]?.discordId;

            // Add leaderDiscordId to the row for _toModel
            const partyRow = {
                 ...result.recordset[0],
                 leaderId: leaderDiscordId || leaderInternalId // Fallback to internal ID if lookup fails
            };

            // Convert to model using the combined data
            const party = this._toModel(partyRow);

            // We might need to add other members if the join only returned one row
            // (e.g., if the user found was not the leader)
            if (result.recordset.length > 1) {
                 result.recordset.slice(1).forEach(row => {
                    if (row.memberId && !party.members.some(m => m.userId === row.memberId.toString())) {
                         const memberDiscordId = row.memberDiscordId || row.memberId.toString();
                         party.addMember({
                            userId: memberDiscordId,
                            adventurerName: row.memberName,
                            backstory: row.memberBackstory,
                            memberType: memberDiscordId === party.leaderId ? 'leader' : (row.memberRole || 'member')
                        });
                    }
                 });
            }

            return party;
        } catch (error) {
            logger.error('Error in findByMember', { 
                error: error.message, 
                discordId 
            });
            return null; // Return null on error as per original logic
        }
    }

    /**
     * Find parties by adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @returns {Promise<Array<Party>>} Party instances
     */
    async findByAdventure(transaction, adventureId) {
        return this.findAll(transaction, 'adventureId = @adventureId', { adventureId });
    }

    /**
     * Create a new party
     * @param {Object} transaction Transaction object
     * @param {Party} partyInstance Party instance (uses Discord IDs)
     * @param {number} internalLeaderId The internal User ID (INT) of the leader
     * @returns {Promise<Party>} Created party with ID
     */
    async create(transaction, partyInstance, internalLeaderId) {
        try {
            const { leaderId: leaderDiscordId, adventurerName, backstory, settings, adventureStatus } = partyInstance;
            
            if (!leaderDiscordId || !adventurerName) {
                throw new Error('Leader Discord ID and adventurer name are required');
            }
            
            // Validate the passed internalLeaderId
            if (!internalLeaderId || typeof internalLeaderId !== 'number') {
                logger.error('Invalid internalLeaderId passed to repository create method', { internalLeaderId, leaderDiscordId });
                throw new Error('Internal error: Invalid internal leader ID for party creation.');
            }

            // Use internal ID for the query
            const query = `
                -- Check for existing active parties using internal ID
                IF EXISTS (
                    SELECT 1 
                    FROM ${this.tableName} WITH (NOLOCK)
                    WHERE leaderId = @internalLeaderId 
                      AND isActive = 1 
                      AND adventureStatus != 'DISBANDED'
                )
                BEGIN
                    THROW 50000, 'User already has an active party', 1;
                END

                -- Create party and get ID
                DECLARE @PartyIdTable TABLE (id INT); -- Declare as a table variable
                
                INSERT INTO ${this.tableName} (
                    leaderId, settings, adventureStatus, isActive, createdAt, lastUpdated, adventureId
                )
                OUTPUT INSERTED.id INTO @PartyIdTable(id) -- Output into the table variable
                VALUES (
                    @internalLeaderId, @settings, @adventureStatus, 1, GETDATE(), GETDATE(), NULL
                );

                -- Get the single party ID from the table variable
                DECLARE @PartyId INT;
                SELECT @PartyId = id FROM @PartyIdTable;

                -- Add leader as first member using internal ID
                INSERT INTO dbo.PartyMembers (
                    partyId, userId, adventurerName, backstory, memberType, joinedAt, lastUpdated
                )
                VALUES (
                    @PartyId, @internalLeaderId, @adventurerName, @backstory, 'leader', GETDATE(), GETDATE()
                );

                -- Return complete party data with Discord ID for leader
                SELECT p.*, 
                       u.discordId as memberDiscordId, -- Get discord ID for model
                       pm.userId as memberId, -- Internal ID
                       pm.adventurerName as memberName, 
                       pm.backstory as memberBackstory, 
                       pm.memberType as memberRole,
                       pm.joinedAt as memberJoinedAt
                FROM ${this.tableName} p
                INNER JOIN dbo.PartyMembers pm ON p.id = pm.partyId
                INNER JOIN users u ON pm.userId = u.id -- Join users table
                WHERE p.id = @PartyId;
            `;

            const params = {
                internalLeaderId: { value: internalLeaderId, type: sql.Int },
                settings: { value: JSON.stringify(settings || { maxSize: 4, minPartySize: 1 }), type: sql.NVarChar(sql.MAX) },
                adventureStatus: { value: adventureStatus || 'RECRUITING', type: sql.VarChar(20) },
                adventurerName: { value: adventurerName, type: sql.NVarChar(100) },
                backstory: { value: backstory || null, type: sql.NVarChar(sql.MAX) }
            };

            const result = await this.executeQuery(transaction, query, params);

            if (!result?.recordset?.[0]) {
                logger.error('No records returned from party creation', { params });
                throw new Error('Failed to create party record - no data returned');
            }
            
             // Convert the DB row (using internal IDs) back to a model (using discord IDs)
             const partyRow = {
                 ...result.recordset[0],
                 leaderId: leaderDiscordId // Use the original discord ID for the model
             };

            return this._toModel(partyRow);
        } catch (error) {
            logger.error('Error during party creation', { 
                error: error.message, 
                leaderDiscordId: partyInstance?.leaderId,
                stack: error.stack 
            });
            if (error.message.includes('User already has an active party')) {
                throw new Error('You already have an active party. Please disband it first.');
            }
            throw error;
        }
    }

    /**
     * Add member to party
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @param {Object} member Member details (using Discord ID for userId)
     * @param {string} member.userId User's Discord ID
     * @param {string} member.adventurerName Character name
     * @param {string} [member.backstory] Character backstory
     * @param {string} [member.memberType] Member type
     * @returns {Promise<boolean>} Success status
     */
    async addMember(transaction, partyId, member) {
        const { userId: discordId, adventurerName, backstory, memberType } = member;
        
        if (!discordId || !adventurerName) {
             throw new Error('Discord ID and Adventurer Name are required to add a member.');
        }
        
        try {
            // Get internal user ID, create user if needed
            const internalUserId = await this._getInternalUserId(transaction, discordId, true);
            if (!internalUserId) {
                throw new Error(`Failed to find or create user for member: ${discordId}`);
            }

            // Check if user is already in any active party using internal ID
            const checkQuery = `
                SELECT 1 FROM dbo.PartyMembers
                WHERE userId = @internalUserId
                  AND partyId IN (SELECT id FROM ${this.tableName} WHERE isActive = 1 AND adventureStatus != 'DISBANDED');
            `;
            const checkResult = await this.executeQuery(transaction, checkQuery, {
                internalUserId: { value: internalUserId, type: sql.Int }
            });
            if (checkResult.recordset[0].memberCount > 0) {
                throw new Error('User is already a member of an active party.');
            }

            // Now add the new member using internal ID
            const insertQuery = `
                INSERT INTO dbo.PartyMembers (
                    partyId, userId, adventurerName, backstory, memberType, joinedAt, lastUpdated
                )
                VALUES (
                    @partyId, @internalUserId, @adventurerName, @backstory, @memberType, GETDATE(), GETDATE()
                );
            `;
            const insertResult = await this.executeQuery(transaction, insertQuery, {
                partyId: { value: partyId, type: sql.Int },
                internalUserId: { value: internalUserId, type: sql.Int },
                adventurerName: { value: adventurerName, type: sql.NVarChar(100) },
                backstory: { value: backstory || null, type: sql.NVarChar(sql.MAX) },
                memberType: { value: memberType || 'member', type: sql.NVarChar(50) }
            });

            return insertResult.rowsAffected[0] > 0;
        } catch (error) {
            logger.error('Failed to add member to dbo.PartyMembers table', { 
                 error: error.message,
                 partyId, 
                 discordId, 
                 internalUserId 
            });
            throw error;
        }
    }

    /**
     * Get party with members (returns Party model with Discord IDs)
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @returns {Promise<Party|null>} Party with members, or null if not found
     */
    async getWithMembers(transaction, partyId) {
        // Added processId generation for logging consistency
        const processId = Math.random().toString(36).substring(2, 10);
        logger.debug(`[${processId}] getWithMembers started`, { partyId });
        console.time(`[${processId}] getWithMembers Total`);

        const query = `
            SELECT p.*, 
                   u.discordId as memberDiscordId, -- Get discord ID for model conversion
                   pm.userId as memberId, -- Keep internal ID
                   pm.adventurerName as memberName, 
                   pm.backstory as memberBackstory, 
                   pm.memberType as memberRole,
                   pm.joinedAt as memberJoinedAt
            FROM ${this.tableName} p
            LEFT JOIN dbo.PartyMembers pm ON p.id = pm.partyId
            LEFT JOIN users u ON pm.userId = u.id -- Join users table
            WHERE p.id = @partyId;
        `;

        logger.debug(`[${processId}] Executing query to get party with members`);
        console.time(`[${processId}] getWithMembers DB Query`);
        const result = await this.executeQuery(transaction, query, {
            partyId: { type: sql.Int, value: partyId }
        });
        console.timeEnd(`[${processId}] getWithMembers DB Query`);
        logger.debug(`[${processId}] DB Query finished`, { recordCount: result?.recordset?.length || 0 });

        if (!result?.recordset?.length) {
             console.timeEnd(`[${processId}] getWithMembers Total`);
             logger.warn(`[${processId}] No records found for party`, { partyId });
             return null;
        }

        // Start synchronous processing timing
        console.time(`[${processId}] getWithMembers Sync Processing`);

        // Find the leader row to get the leader's discord ID
        console.time(`[${processId}] getWithMembers Find Leader`);
        const leaderInternalId = result.recordset[0].leaderId;
        const leaderRow = result.recordset.find(r => r.memberId === leaderInternalId);
        const leaderDiscordId = leaderRow?.memberDiscordId || leaderInternalId.toString(); // Fallback
        console.timeEnd(`[${processId}] getWithMembers Find Leader`);
        
        // Create the base party model using the leader's discord ID
        logger.debug(`[${processId}] Creating base party model`);
        console.time(`[${processId}] getWithMembers Create Model (_toModel)`);
        const partyData = {
             ...result.recordset[0], // Base party data
             leaderId: leaderDiscordId,
             adventurerName: leaderRow?.memberName || 'Unknown Leader',
             leaderBackstory: leaderRow?.memberBackstory
        };
        const party = this._toModel(partyData); // Calls Party constructor, which might parse JSON
        console.timeEnd(`[${processId}] getWithMembers Create Model (_toModel)`);
        logger.debug(`[${processId}] Base party model created`);

        // --- Optimization: Pre-build a Set of existing member IDs for faster lookup ---
        const existingMemberIds = new Set(party.members.map(m => m.userId));
        // --- End Optimization ---

        // Add all members (including leader) from the result set
        logger.debug(`[${processId}] Starting member hydration loop`, { recordCount: result.recordset.length });
        console.time(`[${processId}] getWithMembers Member Hydration Loop`);
        result.recordset.forEach(row => {
            const memberIdStr = row.memberId ? row.memberId.toString() : null;
            const memberDiscordId = row.memberDiscordId ? row.memberDiscordId.toString() : memberIdStr;
            
            if (!memberDiscordId) {
                logger.warn(`[${processId}] Skipping member hydration due to missing ID`, { partyId: party?.id, rowData: row });
                return; 
            }

            // --- Optimization: Use Set for O(1) duplicate check ---
            if (row.memberName && !existingMemberIds.has(memberDiscordId)) {
                 try {
                     // Add member to the Party object
                     party.addMember({
                         userId: memberDiscordId,
                         adventurerName: row.memberName,
                         backstory: row.memberBackstory,
                         memberType: memberDiscordId === leaderDiscordId ? 'leader' : (row.memberRole || 'member')
                     });
                     // Add the newly added member's ID to the Set to prevent re-adding if it appears again in results
                     existingMemberIds.add(memberDiscordId); 
                 } catch(addError) {
                      logger.warn(`[${processId}] Failed to add member during getWithMembers hydration`, {
                           error: addError.message, partyId, memberDiscordId
                      });
                 }
            }
            // --- End Optimization ---
        });
        console.timeEnd(`[${processId}] getWithMembers Member Hydration Loop`);
        logger.debug(`[${processId}] Member hydration loop finished`, { finalMemberCount: party.members.length });

        // End synchronous processing timing
        console.timeEnd(`[${processId}] getWithMembers Sync Processing`);
        console.timeEnd(`[${processId}] getWithMembers Total`);
        logger.info(`[${processId}] getWithMembers finished successfully`, { partyId, finalMemberCount: party.members.length });

        return party;
    }

    /**
     * Remove member from party using Discord ID
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @param {string} discordId User's Discord ID
     * @returns {Promise<Party>} Updated party (with Discord IDs)
     */
    async removeMember(transaction, partyId, discordId) {
        const internalUserId = await this._getInternalUserId(transaction, discordId);
        if (!internalUserId) {
            throw new Error(`User not found: ${discordId}`);
        }

        // Get the party first to check if the user is the leader
        const party = await this.getWithMembers(transaction, partyId);
        if (!party) {
            throw new Error(`Party not found: ${partyId}`);
        }
        if (party.leaderId === discordId) {
            throw new Error('Cannot remove the party leader. Disband the party instead.');
        }
        
        // Delete the member using internal ID
        const deleteQuery = `
            DELETE FROM dbo.PartyMembers
            WHERE partyId = @partyId AND userId = @internalUserId;
        `;
        await this.executeQuery(transaction, deleteQuery, {
            partyId: { type: sql.Int, value: partyId },
            internalUserId: { type: sql.Int, value: internalUserId }
        });

        // Return the potentially updated party state
        return this.getWithMembers(transaction, partyId);
    }

    /**
     * Remove all members from a party
     * @param {Object} transaction Transaction object
     * @param {string} partyId Party ID
     * @returns {Promise<void>}
     */
    async removeAllMembers(transaction, partyId) {
        const query = `
            -- Remove all members
            DELETE FROM dbo.PartyMembers
            WHERE partyId = @partyId;
        `;

        await this.executeQuery(transaction, query, {
            partyId: { type: sql.Int, value: parseInt(partyId, 10) }
        });
    }

    /**
     * Update party progress
     * @param {Object} transaction Transaction object
     * @param {string} partyId Party ID
     * @param {string} type Progress type
     * @param {Object} data Progress data
     * @returns {Promise<Party>} Updated party
     */
    async updateProgress(transaction, partyId, type, data) {
        const party = await this.findById(transaction, partyId);
        if (!party) {
            throw new Error('Party not found');
        }

        if (!party.progress) {
            party.progress = {
                milestones: [],
                achievements: [],
                statistics: {},
            };
        }

        switch (type) {
            case 'milestone':
                party.progress.milestones.push({
                    ...data,
                    timestamp: new Date(),
                });
                break;
            case 'achievement':
                party.progress.achievements.push({
                    ...data,
                    timestamp: new Date(),
                });
                break;
            case 'statistic':
                party.progress.statistics[data.key] = 
                    (party.progress.statistics[data.key] || 0) + data.value;
                break;
            default:
                throw new Error('Invalid progress type');
        }

        return this.update(transaction, partyId, party);
    }

    /**
     * Update member details using Discord ID
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @param {string} discordId User's Discord ID
     * @param {Object} updates Member updates (e.g., { adventurerName: 'New Name' })
     * @returns {Promise<boolean>} Success status
     */
    async updateMemberDetails(transaction, partyId, discordId, updates) {
         const internalUserId = await this._getInternalUserId(transaction, discordId);
         if (!internalUserId) {
             throw new Error(`User not found: ${discordId}`);
         }
 
         const setClauses = [];
         const params = {
             partyId: { type: sql.Int, value: partyId },
             internalUserId: { type: sql.Int, value: internalUserId }
         };
 
         // Build SET clauses and params safely
         if (updates.adventurerName !== undefined) {
             setClauses.push('adventurerName = @adventurerName');
             params.adventurerName = { type: sql.NVarChar(100), value: updates.adventurerName };
         }
         if (updates.backstory !== undefined) {
             setClauses.push('backstory = @backstory');
             params.backstory = { type: sql.NVarChar(sql.MAX), value: updates.backstory };
         }
         if (updates.memberType !== undefined) {
             setClauses.push('memberType = @memberType');
             params.memberType = { type: sql.NVarChar(50), value: updates.memberType };
         }
 
         if (setClauses.length === 0) {
             logger.warn('No valid fields provided for updateMemberDetails', { partyId, discordId, updates });
             return false; // Nothing to update
         }
 
         setClauses.push('lastUpdated = GETDATE()'); // Always update timestamp
 
         const query = `
             UPDATE dbo.PartyMembers
             SET ${setClauses.join(', ')}
             WHERE partyId = @partyId AND userId = @internalUserId;
         `;
 
         const result = await this.executeQuery(transaction, query, params);
         return result.rowsAffected[0] > 0;
    }

    /**
     * Update party details (e.g., settings, status)
     * Accepts Party model with Discord ID, fetches internal ID for update.
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @param {Party} party Party model instance (with Discord leaderId)
     * @returns {Promise<Party>} Updated party model (with Discord IDs)
     */
    async update(transaction, partyId, party) {
        const parentProcessId = party.processId || 'unknown'; // Get processId if available from party model
        logger.debug(`[${parentProcessId}] PartyRepository.update started`, { partyId });
        console.time(`[${parentProcessId}] RepoUpdate_${partyId}_Total`);
        console.time(`[${parentProcessId}] RepoUpdate_${partyId}_GetInternalId`);
        const internalLeaderId = await this._getInternalUserId(transaction, party.leaderId); // Step 1: Lookup leader ID
        console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_GetInternalId`);
        if (!internalLeaderId) {
             console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_Total`); // End total timer on error
             throw new Error(`Leader user not found: ${party.leaderId}`);
        }

        // Use _fromModel with the internal leader ID
        const data = this._fromModel(party, internalLeaderId); // Step 2: Convert model to DB format

        const query = `
            UPDATE ${this.tableName}
            SET leaderId = @internalLeaderId,
                settings = @settings,
                adventureStatus = @adventureStatus,
                isActive = @isActive,
                lastUpdated = GETDATE()
                -- adventureId is intentionally not updated here, use link/unlink methods
            WHERE id = @partyId;
        `;

        // Execute the update query
        let result;
        try {
            console.time(`[${parentProcessId}] RepoUpdate_${partyId}_ExecuteUpdate`);
            result = await this.executeQuery(transaction, query, { // Step 4: Execute UPDATE
                partyId: { type: sql.Int, value: partyId },
                internalLeaderId: { type: sql.Int, value: data.leaderId }, // Use the INT ID
                settings: { type: sql.NVarChar(sql.MAX), value: data.settings },
                adventureStatus: { type: sql.VarChar(20), value: data.adventureStatus },
                isActive: { type: sql.Bit, value: data.isActive }
            });
            console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_ExecuteUpdate`);
        } catch (error) {
            console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_ExecuteUpdate`); // End update timer on error
            console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_Total`); // End total timer on error
            logger.error(`[${parentProcessId}] Error executing party update query`, { partyId, error: error.message });
            throw error; // Rethrow the error
        }

        // Return success status
        const success = result.rowsAffected[0] > 0;
        console.timeEnd(`[${parentProcessId}] RepoUpdate_${partyId}_Total`);
        logger.debug(`[${parentProcessId}] PartyRepository.update finished`, { partyId, success });
        return success; // Step 5: Return boolean
    }

    /**
     * Find the last active party created by a leader (using Discord ID)
     * @param {Object} transaction Transaction object
     * @param {string} leaderDiscordId Leader's Discord ID
     * @returns {Promise<Party|null>} Last active party or null
     */
    async findLastPartyByLeader(transaction, leaderDiscordId) {
        if (!leaderDiscordId) {
            logger.warn('findLastPartyByLeader called with undefined leaderDiscordId');
            return null;
        }

        try {
             const internalLeaderId = await this._getInternalUserId(transaction, leaderDiscordId);
             if (!internalLeaderId) {
                 logger.debug('Leader not found in DB for findLastPartyByLeader', { leaderDiscordId });
                 return null;
             }

            const query = `
                SELECT TOP(1) p.id
                FROM ${this.tableName} p
                WHERE p.leaderId = @internalLeaderId
                  AND p.isActive = 1
                  AND p.adventureStatus != 'DISBANDED'
                ORDER BY p.createdAt DESC;
            `;

            const result = await this.executeQuery(transaction, query, {
                internalLeaderId: { value: internalLeaderId, type: sql.Int }
            });

            if (!result?.recordset?.[0]?.id) {
                return null;
            }

            // Get the full party data using the found ID
            return this.getWithMembers(transaction, result.recordset[0].id);
        } catch (error) {
            logger.error('Error in findLastPartyByLeader', { 
                error: error.message,
                leaderDiscordId,
                stack: error.stack
             });
            return null; // Return null on error as per original logic
        }
    }

    /**
     * Forcefully clean all party-related data for a user (using Discord ID)
     * This method bypasses normal safeguards to handle corrupted or inconsistent data
     * @param {Object} transaction Transaction object
     * @param {string} discordId User's Discord ID to clean data for
     * @returns {Promise<boolean>} Operation result
     */
    async forceCleanupUserData(transaction, discordId) {
        if (!discordId) {
            logger.warn('Null or undefined discordId passed to forceCleanupUserData');
            return true;
        }

        const discordIdStr = discordId.toString();
        logger.info('Starting force cleanup of all party data for user', { discordId: discordIdStr });

        try {
            const internalUserId = await this._getInternalUserId(transaction, discordIdStr);
            
            // If user doesn't exist, there's nothing to clean
            if (!internalUserId) {
                logger.info('User not found during cleanup, nothing to do.', { discordId: discordIdStr });
                return true;
            }

            // Find all parties where the user is a member or leader
            const findPartiesQuery = `
                SELECT p.id
                FROM ${this.tableName} p
                WHERE p.leaderId = @internalUserId
                UNION
                SELECT pm.partyId
                FROM dbo.PartyMembers pm
                WHERE pm.userId = @internalUserId;
            `;
            const partiesResult = await this.executeQuery(transaction, findPartiesQuery, {
                internalUserId: { value: internalUserId, type: sql.Int }
            });
            const partyIds = partiesResult.recordset.map(p => p.id);

            logger.debug('Parties identified for cleanup', { discordId: discordIdStr, internalUserId, partyIds });

            // Delete memberships first
            const deleteMembersQuery = `
                DELETE FROM dbo.PartyMembers WHERE userId = @internalUserId;
            `;
            await this.executeQuery(transaction, deleteMembersQuery, { 
                internalUserId: { value: internalUserId, type: sql.Int } 
            });
            logger.debug('Deleted user memberships', { discordId: discordIdStr, internalUserId });

            // If the user was a leader of any parties, delete those parties and their remaining members
            if (partyIds.length > 0) {
                 // Ensure partyIds are integers
                 const safePartyIds = partyIds.filter(id => Number.isInteger(id));
                 if (safePartyIds.length > 0) {
                     const partyIdList = safePartyIds.join(',');
                     
                     // Delete remaining members from these parties
                     const deleteOtherMembersQuery = `
                         DELETE FROM dbo.PartyMembers WHERE partyId IN (${partyIdList});
                     `;
                     await this.executeQuery(transaction, deleteOtherMembersQuery);
                     logger.debug('Deleted remaining members from led parties', { discordId: discordIdStr, partyIds: safePartyIds });

                     // Delete the parties themselves
                     const deletePartiesQuery = `
                         DELETE FROM ${this.tableName} WHERE id IN (${partyIdList});
                     `;
                     await this.executeQuery(transaction, deletePartiesQuery);
                     logger.debug('Deleted led parties', { discordId: discordIdStr, partyIds: safePartyIds });
                 }
            }

            logger.info('Force cleanup completed successfully', { discordId: discordIdStr });
            return true;
        } catch (error) {
            logger.error('Error during force cleanup of party data', { 
                error: error.message, 
                discordId: discordIdStr,
                stack: error.stack 
            });
            // Don't rethrow, allow transaction to potentially continue if part of a larger operation
            return false; 
        }
    }

    // Remove the specialized parameter handling from executeQuery
    // Let the calling methods define the types explicitly
    async executeQuery(transaction, query, parameters = {}) {
        try {
            if (!transaction) {
                logger.error('Invalid transaction object provided to executeQuery');
                throw new Error('Database transaction is required');
            }
            
            let request;
            if (typeof transaction.request === 'function') {
                request = transaction.request();
            } else if (transaction.transaction && typeof transaction.transaction.request === 'function') {
                 // Handle nested transaction wrapper
                 request = transaction.transaction.request();
            } else if (transaction.connection && typeof transaction.connection.request === 'function'){
                 // Handle connection object case
                 request = transaction.connection.request();
                 request.transaction = transaction; // Associate with transaction
            } else {
                 // Fallback: create request directly from transaction (might be sql.Transaction)
                 request = new sql.Request(transaction);
            }
            
            request.timeout = 60000; // Set 60-second timeout
            
            // Add parameters with explicit types
            if (parameters) {
                for (const [key, param] of Object.entries(parameters)) {
                    if (param && typeof param === 'object' && 'value' in param && 'type' in param) {
                        request.input(key, param.type, param.value);
                    } else {
                         // Log a warning if type is not specified - this might lead to errors
                         logger.warn('Parameter type not explicitly specified in executeQuery', {
                              key, paramValue: param, query: query.split('\n')[0]
                         });
                         // Attempt a default guess (not recommended)
                         let type = sql.NVarChar;
                         if (typeof param === 'number') type = sql.Int;
                         if (typeof param === 'boolean') type = sql.Bit;
                         if (param instanceof Date) type = sql.DateTime;
                         request.input(key, type, param);
                    }
                }
            }
            
            logger.debug(`Executing query for ${this.tableName}`, { 
                queryFirstLine: query.split('\n')[0].trim(),
                paramCount: Object.keys(parameters).length,
                params: Object.keys(parameters).join(', ')
            });
            
            return await request.query(query);
            
        } catch (error) {
            logger.error(`Query error for ${this.tableName}`, {
                error: {
                    code: error.code || error.number,
                    message: error.message,
                    stack: error.stack,
                    state: error.state
                },
                queryFirstLine: query.split('\n')[0].trim(),
                parameters: Object.keys(parameters || {})
            });
            throw error;
        }
    }
}

module.exports = new PartyRepository(); 