/**
 * Adventure Repository
 * Handles database operations for adventures
 */

const BaseRepository = require('./baseRepository');
const Adventure = require('../models/Adventure');
const logger = require('../utils/logger');
const sql = require('mssql');

class AdventureRepository extends BaseRepository {
    constructor() {
        super('adventures');
        // Define which fields should be stored as JSON
        this.jsonFields = [
            'settings',
            'setting',
            'plotSummary',
            'plotPoints',
            'keyElements',
            'winCondition',
            'currentState',
            'metadata'
        ];
    }

    /**
     * Convert database row to Adventure model
     * @param {Object} row Database row
     * @returns {Adventure} Adventure instance
     * @protected
     */
    _toModel(row) {
        try {
            const parseJSON = (field) => {
                try {
                    return JSON.parse(row[field] || '{}');
                } catch (err) {
                    logger.warn(`Failed to parse ${field}, using empty object`, { error: err });
                    return {};
                }
            };

            return new Adventure({
                id: row.id,
                title: row.title,
                description: row.description,
                createdBy: row.createdBy,
                settings: parseJSON('settings'),
                theme: row.theme,
                setting: parseJSON('setting'),
                plotSummary: parseJSON('plotSummary'),
                plotPoints: parseJSON('plotPoints'),
                keyElements: parseJSON('keyElements'),
                winCondition: parseJSON('winCondition'),
                currentState: parseJSON('currentState'),
                status: row.status,
                metadata: parseJSON('metadata'),
            });
        } catch (error) {
            logger.error('Failed to convert row to Adventure model', { error, row });
            throw error;
        }
    }

    /**
     * Convert Adventure model to database row
     * @param {Adventure} model Adventure instance
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        try {
            const data = {
                title: model.title,
                description: model.description,
                createdBy: model.createdBy,
                theme: model.theme,
                status: model.status,
            };

            // Stringify JSON fields
            for (const field of this.jsonFields) {
                try {
                    const value = model[field];
                    // If already a string and valid JSON, keep as is
                    if (typeof value === 'string') {
                        try {
                            JSON.parse(value);
                            data[field] = value;
                        } catch {
                            data[field] = JSON.stringify(value);
                        }
                    } else {
                        data[field] = JSON.stringify(value || {});
                    }
                } catch (err) {
                    logger.error(`Failed to stringify ${field}`, { error: err });
                    data[field] = '{}';
                }
            }

            return data;
        } catch (error) {
            logger.error('Failed to convert Adventure model to row', { error, modelId: model.id });
            throw error;
        }
    }

    /**
     * Create a new adventure
     * @param {Object} transaction Transaction object
     * @param {Adventure} adventure Adventure instance
     * @param {number} internalUserId The internal user ID (users.id) of the creator
     * @returns {Promise<Adventure>} Created adventure with ID
     */
    async create(transaction, adventure, internalUserId) {
        console.time('adventure_repo_create_total');
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Starting adventure create in repository`);
        
        // Ensure internalUserId is a valid number
        const parsedUserId = parseInt(internalUserId, 10);
        if (isNaN(parsedUserId)) {
            logger.error('Invalid internalUserId in create adventure', { 
                providedId: internalUserId,
                adventureId: adventure.id 
            });
            throw new Error('Invalid creator ID format for adventure creation');
        }
        
        // Ensure the adventure object has the internal user ID
        adventure.createdBy = parsedUserId;
        
        // Log to help debug
        logger.debug('Creating adventure with internal user ID', { 
            internalUserId: parsedUserId,
            adventureDataCreatedBy: adventure.createdBy
        });
        
        console.time('adventure_model_to_data');
        const data = this._fromModel(adventure);
        console.timeEnd('adventure_model_to_data');
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Model converted to data object`);
        
        // Double-check that createdBy is set in the data object
        if (!data.createdBy) {
            logger.error('createdBy missing from adventure data after _fromModel', {
                parsedUserId,
                originalCreatedBy: adventure.createdBy
            });
            data.createdBy = parsedUserId; // Force it to be set
        }
        
        // Log the data size for performance analysis
        const dataSizes = {};
        for (const key in data) {
            const value = data[key];
            if (typeof value === 'string') {
                dataSizes[key] = value.length;
            }
        }
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Data sizes:`, dataSizes);
        
        const query = `
            DECLARE @InsertedId TABLE (id INT);

            INSERT INTO ${this.tableName} (
                title, description, createdBy, settings, theme,
                setting, plotSummary, plotPoints, keyElements,
                winCondition, currentState, status, metadata
            )
            OUTPUT INSERTED.id INTO @InsertedId(id)
            VALUES (
                @title, @description, @createdBy, @settings, @theme,
                @setting, @plotSummary, @plotPoints, @keyElements,
                @winCondition, @currentState, @status, @metadata
            );

            SELECT a.*, i.id as insertedId
            FROM ${this.tableName} a
            INNER JOIN @InsertedId i ON a.id = i.id;
        `;

        console.log(`[DB-METRICS] ${new Date().toISOString()} - Executing DB query for adventure creation`);
        console.time('adventure_db_insert');
        const result = await this.executeQuery(transaction, query, {
            title: { type: sql.NVarChar, value: data.title },
            description: { type: sql.NVarChar, value: data.description },
            createdBy: { type: sql.Int, value: parsedUserId }, // Use the parsed ID directly
            settings: { type: sql.NVarChar, value: data.settings },
            theme: { type: sql.NVarChar, value: data.theme },
            setting: { type: sql.NVarChar, value: data.setting },
            plotSummary: { type: sql.NVarChar, value: data.plotSummary },
            plotPoints: { type: sql.NVarChar, value: data.plotPoints },
            keyElements: { type: sql.NVarChar, value: data.keyElements },
            winCondition: { type: sql.NVarChar, value: data.winCondition },
            currentState: { type: sql.NVarChar, value: data.currentState },
            status: { type: sql.NVarChar, value: data.status },
            metadata: { type: sql.NVarChar, value: data.metadata }
        });
        console.timeEnd('adventure_db_insert');
        console.log(`[DB-METRICS] ${new Date().toISOString()} - DB query execution completed`);

        if (!result.recordset?.[0]) {
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Failed to create adventure record - no recordset returned`);
            throw new Error('Failed to create adventure record');
        }

        // Set the ID from the database
        adventure.id = result.recordset[0].insertedId;
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Adventure ID set: ${adventure.id}`);

        // If we have a party ID in the settings, create the party-adventure relationship
        if (adventure.settings.partyId) {
            console.time('adventure_party_link');
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Linking party to adventure in repository`);
            await this.linkPartyToAdventure(transaction, adventure.id, adventure.settings.partyId);
            console.timeEnd('adventure_party_link');
            console.log(`[DB-METRICS] ${new Date().toISOString()} - Party linked to adventure in repository`);
        }

        console.timeEnd('adventure_repo_create_total');
        console.log(`[DB-METRICS] ${new Date().toISOString()} - Repository adventure create completed`);
        return adventure;
    }

    /**
     * Link a party to an adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} partyId Party ID
     * @returns {Promise<void>}
     */
    async linkPartyToAdventure(transaction, adventureId, partyId) {
        const query = `
            INSERT INTO partyAdventures (partyId, adventureId, joinedAt)
            VALUES (@partyId, @adventureId, GETDATE());

            -- Update party status and link adventure ID
            UPDATE parties
            SET adventureStatus = 'ACTIVE',
                adventureId = @adventureId,
                lastUpdated = GETDATE()
            WHERE id = @partyId;
        `;

        await this.executeQuery(transaction, query, {
            partyId: { type: sql.Int, value: parseInt(partyId, 10) },
            adventureId: { type: sql.Int, value: parseInt(adventureId, 10) }
        });
    }

    /**
     * Unlink a party from an adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} partyId Party ID
     * @returns {Promise<void>}
     */
    async unlinkPartyFromAdventure(transaction, adventureId, partyId) {
        const query = `
            -- Remove the party-adventure relationship
            DELETE FROM partyAdventures
            WHERE partyId = @partyId AND adventureId = @adventureId;

            -- Update party status to disbanded
            UPDATE parties
            SET adventureStatus = 'DISBANDED',
                isActive = 0,
                lastUpdated = GETDATE()
            WHERE id = @partyId;
        `;

        await this.executeQuery(transaction, query, {
            partyId: { type: sql.Int, value: parseInt(partyId, 10) },
            adventureId: { type: sql.Int, value: parseInt(adventureId, 10) }
        });
    }

    /**
     * Find active adventures for a user
     * @param {Object} transaction Transaction object
     * @param {number} internalUserId Internal user ID (users.id)
     * @returns {Promise<Array<Adventure>>} Active adventures
     */
    async findActiveByUser(transaction, internalUserId) {
        return this.findAll(
            transaction,
            'createdBy = @internalUserId AND status = @status',
            { 
                internalUserId: { type: sql.Int, value: internalUserId },
                status: 'active' 
            }
        );
    }

    /**
     * Find the last adventure created by a user
     * @param {Object} transaction Transaction object
     * @param {number|string} internalUserId Internal user ID (users.id)
     * @returns {Promise<Adventure|null>} The most recent adventure or null if none found
     */
    async findLastAdventureByUser(transaction, internalUserId) {
        // Handle null or undefined userId
        if (!internalUserId) {
            logger.warn('Null or undefined internalUserId passed to findLastAdventureByUser', { internalUserId });
            return null;
        }

        // Ensure internalUserId is a number 
        const parsedId = parseInt(internalUserId, 10);
        if (isNaN(parsedId)) {
            logger.error('Invalid internal user ID format in findLastAdventureByUser', { 
                internalUserId, 
                parsedId
            });
            return null;
        }
        
        const query = `
            SELECT TOP(1) *
            FROM ${this.tableName}
            WHERE createdBy = @internalUserId
            ORDER BY createdAt DESC;
        `;

        const result = await this.executeQuery(transaction, query, {
            internalUserId: { type: sql.Int, value: parsedId }
        });

        return result.recordset[0] ? this._toModel(result.recordset[0]) : null;
    }

    /**
     * Find adventures by party
     * @param {Object} transaction Transaction object
     * @param {string} partyId Party ID
     * @returns {Promise<Array<Adventure>>} Adventures
     */
    async findByParty(transaction, partyId) {
        const query = `
            SELECT a.*
            FROM ${this.tableName} a
            JOIN partyAdventures pa ON a.id = pa.adventureId
            WHERE pa.partyId = @partyId
        `;
        const result = await this.executeQuery(transaction, query, { partyId });
        return result.recordset.map(row => this._toModel(row));
    }

    /**
     * Update adventure state
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} state New state
     * @returns {Promise<Adventure>} Updated adventure
     */
    async updateState(transaction, adventureId, state) {
        const query = `
            UPDATE ${this.tableName}
            SET currentState = @state,
                lastUpdated = GETDATE()
            WHERE id = @adventureId;
        `;
        await this.executeQuery(transaction, query, {
            adventureId,
            state: JSON.stringify(state),
        });
        return this.findById(transaction, adventureId);
    }

    /**
     * Complete an adventure
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {Object} summary Completion summary
     * @returns {Promise<Adventure>} Completed adventure
     */
    async complete(transaction, adventureId, summary) {
        const query = `
            UPDATE ${this.tableName}
            SET status = 'completed',
                completedAt = GETDATE(),
                summary = @summary
            WHERE id = @adventureId;
        `;
        await this.executeQuery(transaction, query, {
            adventureId,
            summary: JSON.stringify(summary),
        });
        return this.findById(transaction, adventureId);
    }

    /**
     * Update adventure status
     * @param {Object} transaction Transaction object
     * @param {string} adventureId Adventure ID
     * @param {string} status New status
     * @returns {Promise<void>}
     */
    async updateStatus(transaction, adventureId, status) {
        const query = `
            UPDATE ${this.tableName}
            SET status = @status,
                lastUpdated = GETDATE(),
                completedAt = CASE 
                    WHEN @status IN ('completed', 'failed') THEN GETDATE()
                    ELSE completedAt
                END
            WHERE id = @adventureId;
        `;

        await this.executeQuery(transaction, query, {
            adventureId: { type: sql.Int, value: parseInt(adventureId, 10) },
            status: { type: sql.VarChar, value: status }
        });
    }
}

module.exports = new AdventureRepository();