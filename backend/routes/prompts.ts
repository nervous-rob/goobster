import express from 'express';
import { query } from '../azureDb';

const router = express.Router();

interface Conversation {
  id: number;
}

interface User {
  id: number;
  username: string;
  activeConversationId: number;
}

// Get all prompts
router.get('/', async (req, res) => {
  try {
    const result = await query`SELECT * FROM prompts`;
    res.json(result.recordset);
  } catch (error) {
    console.error('Failed to fetch prompts:', error);
    res.status(500).json({ error: 'Failed to fetch prompts' });
  }
});

// Delete a prompt
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // First check if any users have active conversations using this prompt
    const activeUsersResult = await query<User>`
      SELECT u.* 
      FROM users u
      JOIN conversations c ON u.activeConversationId = c.id
      WHERE c.promptId = ${id}
    `;
    
    if (activeUsersResult.recordset.length > 0) {
      const usernames = activeUsersResult.recordset.map(u => u.username).join(', ');
      return res.status(400).json({
        error: 'Cannot delete prompt',
        message: `This prompt is currently being used in active conversations by the following users: ${usernames}. Please wait until they finish their conversations.`
      });
    }
    
    // If no active conversations, proceed with deletion
    // First get all conversation IDs for this prompt
    const conversationsResult = await query<Conversation>`
      SELECT id FROM conversations WHERE promptId = ${id}
    `;
    
    // Delete messages for all related conversations
    for (const conv of conversationsResult.recordset) {
      await query`DELETE FROM messages WHERE conversationId = ${conv.id}`;
    }
    
    // Then delete the conversations
    await query`DELETE FROM conversations WHERE promptId = ${id}`;
    
    // Finally delete the prompt
    await query`DELETE FROM prompts WHERE id = ${id}`;
    
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete prompt:', error);
    res.status(500).json({ error: 'Failed to delete prompt' });
  }
});

export default router; 