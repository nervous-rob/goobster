/**
 * Party Repository
 * Handles database operations for parties
 */

const BaseRepository = require('./baseRepository');
const Party = require('../models/Party');
const logger = require('../utils/logger');
const sql = require('mssql');

class PartyRepository extends BaseRepository {
    constructor() {
        super('parties');
    }

    /**
     * Convert database row to Party model
     * @param {Object} row Database row
     * @returns {Party} Party instance
     * @protected
     */
    _toModel(row) {
        // First create the party instance
        const party = new Party({
            id: row.id,
            leaderId: row.leaderId,
            leaderName: row.memberName,
            leaderBackstory: row.memberBackstory,
            settings: JSON.parse(row.settings || '{}'),
            status: row.adventureStatus,
            createdAt: row.createdAt,
            lastUpdated: row.lastUpdated,
            isActive: row.isActive
        });

        // If we have member data in the row, add it
        if (row.memberId) {
            const isLeader = row.memberId === row.leaderId;
            party.addMember({
                userId: row.memberId,
                adventurerName: row.memberName,
                backstory: row.memberBackstory,
                role: isLeader ? 'leader' : (row.memberRole || 'member')
            });
        }

        return party;
    }

    /**
     * Convert Party model to database row
     * @param {Party} model Party instance
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        return {
            leaderId: model.leaderId,
            settings: JSON.stringify(model.settings || {}),
            adventureStatus: model.status || 'RECRUITING',
            isActive: model.isActive ?? true,
            lastUpdated: model.lastUpdated || new Date()
        };
    }

    /**
     * Find party by member
     * @param {Object} transaction Transaction object
     * @param {string} userId User ID
     * @returns {Promise<Party>} Party instance
     */
    async findByMember(transaction, userId) {
        const query = `
            SELECT p.*, 
                   pm.userId as memberId, 
                   pm.adventurerName as memberName, 
                   pm.backstory as memberBackstory, 
                   pm.memberType as memberRole,
                   pm.joinedAt as memberJoinedAt
            FROM ${this.tableName} p
            INNER JOIN partyMembers pm ON p.id = pm.partyId
            WHERE pm.userId = @userId
            AND p.isActive = 1
            AND p.adventureStatus != 'DISBANDED'
        `;
        const result = await this.executeQuery(transaction, query, {
            userId: {
                value: userId.toString(),
                type: sql.NVarChar
            }
        });
        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
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
     * @param {Party} partyData Party instance
     * @returns {Promise<Party>} Created party with ID
     */
    async create(transaction, partyData) {
        const data = this._fromModel(partyData);
        const query = `
            DECLARE @PartyId TABLE (id INT);

            -- Insert the party
            INSERT INTO ${this.tableName} (
                leaderId,
                settings,
                adventureStatus,
                isActive,
                createdAt,
                lastUpdated
            )
            OUTPUT INSERTED.id INTO @PartyId(id)
            VALUES (
                @leaderId,
                @settings,
                @adventureStatus,
                @isActive,
                GETDATE(),
                GETDATE()
            );

            -- Add the leader as the first member
            INSERT INTO partyMembers (
                partyId,
                userId,
                adventurerName,
                backstory,
                memberType,
                joinedAt,
                lastUpdated
            )
            SELECT
                p.id,
                @leaderId,
                @leaderName,
                @leaderBackstory,
                'leader',
                GETDATE(),
                GETDATE()
            FROM @PartyId p;

            -- Return the created party with members
            SELECT p.*, 
                   pm.userId as memberId, 
                   pm.adventurerName as memberName, 
                   pm.backstory as memberBackstory, 
                   pm.memberType as memberRole,
                   pm.joinedAt as memberJoinedAt
            FROM ${this.tableName} p
            INNER JOIN @PartyId pid ON p.id = pid.id
            INNER JOIN partyMembers pm ON p.id = pm.partyId;
        `;

        try {
            // Validate required fields
            if (!partyData.leaderName) {
                throw new Error('Adventurer name is required');
            }

            const params = {
                leaderId: { 
                    value: partyData.leaderId.toString(),
                    type: sql.NVarChar
                },
                leaderName: {
                    value: partyData.leaderName,
                    type: sql.NVarChar
                },
                leaderBackstory: {
                    value: partyData.leaderBackstory || null,
                    type: sql.NVarChar
                },
                settings: {
                    value: data.settings,
                    type: sql.NVarChar
                },
                adventureStatus: {
                    value: data.adventureStatus,
                    type: sql.NVarChar
                },
                isActive: {
                    value: data.isActive,
                    type: sql.Bit
                }
            };

            const result = await this.executeQuery(transaction, query, params);
            if (!result.recordset?.[0]) {
                throw new Error('Failed to create party record');
            }

            // Convert the result to a Party model
            const partyRecord = result.recordset[0];
            const createdParty = this._toModel(partyRecord);

            return createdParty;
        } catch (error) {
            logger.error('Database error in party creation', { 
                error,
                partyInfo: {
                    leaderId: partyData.leaderId,
                    leaderName: partyData.leaderName,
                    status: data.adventureStatus
                }
            });
            throw error;
        }
    }

    /**
     * Add member to party
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @param {Object} member Member details
     * @returns {Promise<boolean>} Success status
     */
    async addMember(transaction, partyId, member) {
        const query = `
            INSERT INTO partyMembers (
                partyId, userId, adventurerName, backstory, memberType, joinedAt
            )
            VALUES (
                @partyId, @userId, @adventurerName, @backstory, @memberType, GETDATE()
            );
        `;

        const params = {
            partyId: {
                value: partyId,
                type: sql.Int
            },
            userId: {
                value: member.userId.toString(),
                type: sql.NVarChar
            },
            adventurerName: {
                value: member.adventurerName,
                type: sql.NVarChar
            },
            backstory: {
                value: member.backstory || null,
                type: sql.NVarChar
            },
            memberType: {
                value: member.role || 'member',
                type: sql.NVarChar
            }
        };

        await this.executeQuery(transaction, query, params);
        return true;
    }

    /**
     * Get party with members
     * @param {Object} transaction Transaction object
     * @param {number} partyId Party ID
     * @returns {Promise<Party>} Party with members
     */
    async getWithMembers(transaction, partyId) {
        const query = `
            SELECT p.*, 
                   pm.userId as memberId, 
                   pm.adventurerName as memberName, 
                   pm.backstory as memberBackstory, 
                   pm.memberType as memberRole,
                   pm.joinedAt as memberJoinedAt
            FROM ${this.tableName} p
            LEFT JOIN partyMembers pm ON p.id = pm.partyId
            WHERE p.id = @partyId;
        `;

        const result = await this.executeQuery(transaction, query, {
            partyId: { type: sql.Int, value: partyId }
        });

        if (!result.recordset.length) {
            return null;
        }

        // Create party from first row
        const party = this._toModel(result.recordset[0]);
        
        // Add any additional members from other rows
        result.recordset.slice(1).forEach(row => {
            if (row.memberId && !party.members.some(m => m.userId === row.memberId)) {
                const isLeader = row.memberId === party.leaderId;
                party.addMember({
                    userId: row.memberId,
                    adventurerName: row.memberName,
                    backstory: row.memberBackstory,
                    role: isLeader ? 'leader' : (row.memberRole || 'member')
                });
            }
        });

        return party;
    }

    /**
     * Remove member from party
     * @param {Object} transaction Transaction object
     * @param {string} partyId Party ID
     * @param {string} userId User ID
     * @returns {Promise<Party>} Updated party
     */
    async removeMember(transaction, partyId, userId) {
        const party = await this.findById(transaction, partyId);
        if (!party) {
            throw new Error('Party not found');
        }

        const member = party.members.find(m => m.id === userId);
        if (!member) {
            throw new Error('Member not found');
        }

        // Add to history
        if (!party.memberHistory) {
            party.memberHistory = [];
        }
        party.memberHistory.push({
            ...member,
            leftAt: new Date(),
        });

        // Remove from active members
        party.members = party.members.filter(m => m.id !== userId);

        // Update leader if needed
        if (userId === party.leaderId && party.members.length > 0) {
            party.leaderId = party.members[0].id;
            party.members[0].role = 'leader';
        }

        // Update status if needed
        if (party.members.length === 0) {
            party.status = 'disbanded';
        }

        return this.update(transaction, partyId, party);
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
     * Update member details
     * @param {Object} transaction Transaction object
     * @param {string} partyId Party ID
     * @param {string} userId User ID
     * @param {Object} updates Member updates
     * @returns {Promise<Party>} Updated party
     */
    async updateMemberDetails(transaction, partyId, userId, updates) {
        const party = await this.findById(transaction, partyId);
        if (!party) {
            throw new Error('Party not found');
        }

        const memberIndex = party.members.findIndex(m => m.id === userId);
        if (memberIndex === -1) {
            throw new Error('Member not found');
        }

        party.members[memberIndex] = {
            ...party.members[memberIndex],
            ...updates,
            lastUpdated: new Date(),
        };

        return this.update(transaction, partyId, party);
    }
}

module.exports = new PartyRepository(); 