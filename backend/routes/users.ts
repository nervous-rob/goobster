import express from 'express';
import { query, queryWithTransaction, getConnection } from '../azureDb';
import * as mssql from 'mssql';

const router = express.Router();

interface User {
    id: number;
    username: string;
    joinedAt: Date;
    activeConversationId: number | null;
}

// Get all users
router.get('/', async (req, res) => {
    try {
        const result = await query<User>`
            SELECT id, username, joinedAt, activeConversationId
            FROM users
            ORDER BY username
        `;
        res.json(result.recordset);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get single user
router.get('/:id', async (req, res) => {
    try {
        const result = await query<User>`
            SELECT id, username, joinedAt, activeConversationId
            FROM users
            WHERE id = ${req.params.id}
        `;
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(result.recordset[0]);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Create user
router.post('/', async (req, res) => {
    const { username } = req.body;
    try {
        const result = await query<User>`
            INSERT INTO users (username)
            VALUES (${username})
            OUTPUT INSERTED.id, INSERTED.username, INSERTED.joinedAt, INSERTED.activeConversationId
        `;
        res.status(201).json(result.recordset[0]);
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update user
router.put('/:id', async (req, res) => {
    const { username, activeConversationId } = req.body;
    try {
        const result = await query<User>`
            UPDATE users
            SET username = ${username},
                activeConversationId = ${activeConversationId}
            OUTPUT INSERTED.id, INSERTED.username, INSERTED.joinedAt, INSERTED.activeConversationId
            WHERE id = ${req.params.id}
        `;
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(result.recordset[0]);
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Delete user and all associated data
router.delete('/:id', async (req, res) => {
    const userId = req.params.id;
    try {
        // Start a transaction
        const transaction = new mssql.Transaction(await getConnection());
        await transaction.begin();

        try {
            // 0. First set activeConversationId to NULL to break circular reference
            await queryWithTransaction(
                transaction,
                ['UPDATE users SET activeConversationId = NULL WHERE id = @p0'],
                userId
            );

            // 1. Delete decision points first
            await queryWithTransaction(
                transaction,
                [`
                    DELETE dp
                    FROM decisionPoints dp
                    INNER JOIN adventures a ON dp.adventureId = a.id
                    INNER JOIN parties p ON a.partyId = p.id
                    INNER JOIN partyMembers pm ON pm.partyId = p.id
                    WHERE pm.userId = @p0
                `],
                userId
            );

            // 2. Delete adventure images (they depend on adventures)
            await queryWithTransaction(
                transaction,
                [`
                    DELETE ai
                    FROM adventureImages ai
                    INNER JOIN adventures a ON ai.adventureId = a.id
                    INNER JOIN parties p ON a.partyId = p.id
                    INNER JOIN partyMembers pm ON pm.partyId = p.id
                    WHERE pm.userId = @p0
                `],
                userId
            );

            // 3. Delete adventurer states (they depend on adventures)
            await queryWithTransaction(
                transaction,
                [`
                    DELETE ast
                    FROM adventurerStates ast
                    INNER JOIN adventures a ON ast.adventureId = a.id
                    INNER JOIN parties p ON a.partyId = p.id
                    INNER JOIN partyMembers pm ON pm.partyId = p.id
                    WHERE pm.userId = @p0
                `],
                userId
            );

            // 4. Delete adventures
            await queryWithTransaction(
                transaction,
                [`
                    DELETE a
                    FROM adventures a
                    INNER JOIN parties p ON a.partyId = p.id
                    INNER JOIN partyMembers pm ON pm.partyId = p.id
                    WHERE pm.userId = @p0
                `],
                userId
            );

            // 5. Delete party members
            await queryWithTransaction(
                transaction,
                ['DELETE FROM partyMembers WHERE userId = @p0'],
                userId
            );

            // 6. Delete parties where this user was the only member
            await queryWithTransaction(
                transaction,
                [`
                    DELETE p
                    FROM parties p
                    LEFT JOIN partyMembers pm ON p.id = pm.partyId
                    WHERE pm.id IS NULL
                `],
                userId
            );

            // 7. Delete messages (they depend on conversations)
            await queryWithTransaction(
                transaction,
                ['DELETE m FROM messages m INNER JOIN conversations c ON m.conversationId = c.id WHERE c.userId = @p0'],
                userId
            );

            // 8. Delete conversations
            await queryWithTransaction(
                transaction,
                ['DELETE FROM conversations WHERE userId = @p0'],
                userId
            );

            // 9. Delete prompts
            await queryWithTransaction(
                transaction,
                ['DELETE FROM prompts WHERE userId = @p0'],
                userId
            );

            // 10. Finally, delete the user
            const result = await queryWithTransaction(
                transaction,
                ['DELETE FROM users WHERE id = @p0'],
                userId
            );

            // Commit the transaction
            await transaction.commit();

            if (result.rowsAffected[0] === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
            res.status(204).send();
        } catch (error) {
            // Rollback on error
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default router; 