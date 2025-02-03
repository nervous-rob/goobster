// TODO: Add proper error handling for database operations
// TODO: Add proper validation for API requests
// TODO: Add proper authentication middleware
// TODO: Add proper rate limiting
// TODO: Add proper logging system
// TODO: Add proper health check endpoints
// TODO: Add proper monitoring for server status
// TODO: Add proper cleanup for expired sessions
// TODO: Add proper handling for WebSocket connections
// TODO: Add proper handling for server shutdown

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { query } from './azureDb';
import configRouter from './routes/config';
import promptsRouter from './routes/prompts';
import imagesRouter from './routes/images';
import usersRouter from './routes/users';

interface DbParty {
  id: number;
  createdAt: Date;
  isActive: boolean;
  status: string;
  plotSummary: string | null;
  currentState: string | null;
  adventureId: number | null;
}

interface DbMember {
  id: number;
  partyId: number;
  name: string;
  role: string;
  status: string | null;
}

const app = express();
app.use(cors());
app.use(express.json());

// API routes
app.use('/api/prompts', promptsRouter);
app.use('/api/images', imagesRouter);
app.use('/api/users', usersRouter);

// Parties endpoints
app.get('/api/parties/active', async (req, res) => {
  try {
    // Get parties with their adventures
    const partiesResult = await query<DbParty>`
      SELECT 
        p.id,
        p.createdAt,
        p.isActive,
        p.adventureStatus as status,
        a.plotSummary,
        a.currentState,
        a.id as adventureId
      FROM parties p
      LEFT JOIN adventures a ON a.partyId = p.id
      WHERE p.isActive = 1
    `;

    // Get members for all parties
    const membersResult = await query<DbMember>`
      SELECT 
        pm.id,
        pm.partyId,
        pm.adventurerName as name,
        'Member' as role,
        ast.status
      FROM partyMembers pm
      JOIN parties p ON p.id = pm.partyId
      LEFT JOIN adventures a ON a.partyId = p.id
      LEFT JOIN adventurerStates ast ON ast.partyMemberId = pm.id AND ast.adventureId = a.id
      WHERE p.isActive = 1
    `;

    // Combine the data
    const parties = partiesResult.recordset.map(party => ({
      id: party.id,
      status: party.status || 'RECRUITING',
      currentState: party.currentState,
      plotSummary: party.plotSummary,
      adventureId: party.adventureId,
      members: membersResult.recordset.filter(member => member.partyId === party.id).map(member => ({
        id: member.id,
        name: member.name,
        role: member.role,
        status: member.status || 'ACTIVE'
      }))
    }));

    res.json(parties);
  } catch (error) {
    console.error('Failed to fetch active parties:', error);
    res.status(500).json({ error: 'Failed to fetch active parties' });
  }
});

// Use config routes
app.use('/api/config', configRouter);

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, '../../frontend/dist')));

// Serve React app for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 