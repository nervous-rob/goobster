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
    }

    /**
     * Convert database row to Adventure model
     * @param {Object} row Database row
     * @returns {Adventure} Adventure instance
     * @protected
     */
    _toModel(row) {
        return new Adventure({
            id: row.id,
            title: row.title,
            description: row.description,
            createdBy: row.createdBy,
            settings: JSON.parse(row.settings),
            theme: row.theme,
            setting: JSON.parse(row.setting),
            plotSummary: row.plotSummary,
            plotPoints: JSON.parse(row.plotPoints),
            keyElements: JSON.parse(row.keyElements),
            winCondition: JSON.parse(row.winCondition),
            currentState: JSON.parse(row.currentState),
            status: row.status,
            metadata: JSON.parse(row.metadata),
        });
    }

    /**
     * Convert Adventure model to database row
     * @param {Adventure} model Adventure instance
     * @returns {Object} Database row
     * @protected
     */
    _fromModel(model) {
        return {
            title: model.title,
            description: model.description,
            createdBy: model.createdBy,
            settings: JSON.stringify(model.settings),
            theme: model.theme,
            setting: JSON.stringify(model.setting),
            plotSummary: model.plotSummary,
            plotPoints: JSON.stringify(model.plotPoints),
            keyElements: JSON.stringify(model.keyElements),
            winCondition: JSON.stringify(model.winCondition),
            currentState: JSON.stringify(model.currentState),
            status: model.status,
            metadata: JSON.stringify(model.metadata),
        };
    }

    /**
     * Create a new adventure
     * @param {Object} transaction Transaction object
     * @param {Adventure} adventure Adventure instance
     * @returns {Promise<Adventure>} Created adventure with ID
     */
    async create(transaction, adventure) {
        const data = this._fromModel(adventure);
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

        const result = await this.executeQuery(transaction, query, {
            title: { type: sql.NVarChar, value: data.title },
            description: { type: sql.NVarChar, value: data.description },
            createdBy: { type: sql.NVarChar, value: data.createdBy },
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

        if (!result.recordset?.[0]) {
            throw new Error('Failed to create adventure record');
        }

        // Set the ID from the database and return the complete adventure
        adventure.id = result.recordset[0].insertedId;
        return adventure;
    }

    /**
     * Find active adventures for a user
     * @param {Object} transaction Transaction object
     * @param {string} userId User ID
     * @returns {Promise<Array<Adventure>>} Active adventures
     */
    async findActiveByUser(transaction, userId) {
        return this.findAll(
            transaction,
            'createdBy = @userId AND status = @status',
            { userId, status: 'active' }
        );
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
}

module.exports = new AdventureRepository(); 