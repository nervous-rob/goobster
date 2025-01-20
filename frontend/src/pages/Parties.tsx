import { useState, useEffect } from 'react';
import { 
  Box, 
  Button, 
  Card, 
  IconButton, 
  List, 
  ListItem, 
  ListItemText, 
  Typography,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import InfoIcon from '@mui/icons-material/Info';
import { partiesApi } from '../services/api';

interface PartyMember {
  id: number;
  name: string;
  role: string;
  status: string;
}

interface Party {
  id: number;
  name: string;
  status: string;
  members: PartyMember[];
  currentState?: string;
  plotSummary?: string;
  adventureId?: number;
}

export default function Parties() {
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadParties();
  }, []);

  const loadParties = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await partiesApi.getAll();
      setParties(Array.isArray(data) ? data : []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load parties';
      setError(message);
      setParties([]);
    } finally {
      setLoading(false);
    }
  };

  const handleEndParty = async (id: number) => {
    try {
      setError(null);
      await partiesApi.end(id);
      await loadParties();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to end party';
      setError(message);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'active':
        return 'success';
      case 'completed':
        return 'info';
      case 'failed':
        return 'error';
      default:
        return 'default';
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>Parties</Typography>
      
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <List>
        {parties.length > 0 ? (
          parties.map((party) => (
            <Card key={party.id} sx={{ mb: 2 }}>
              <ListItem
                sx={{ 
                  borderRadius: 1,
                  '& .MuiListItemText-secondary': {
                    display: 'flex',
                    gap: 1,
                    alignItems: 'center',
                    flexWrap: 'wrap'
                  }
                }}
                secondaryAction={
                  <Box>
                    <IconButton 
                      edge="end" 
                      onClick={() => {
                        setSelectedParty(party);
                        setDetailsOpen(true);
                      }}
                      sx={{ mr: 1 }}
                    >
                      <InfoIcon />
                    </IconButton>
                    {party.status.toLowerCase() === 'active' && (
                      <IconButton 
                        edge="end" 
                        onClick={() => handleEndParty(party.id)}
                        color="error"
                      >
                        <DeleteIcon />
                      </IconButton>
                    )}
                  </Box>
                }
              >
                <ListItemText 
                  primary={party.name}
                  secondary={
                    <>
                      <Chip 
                        label={party.status} 
                        size="small" 
                        color={getStatusColor(party.status) as any}
                      />
                      {party.members.map((member) => (
                        <Chip 
                          key={member.id}
                          label={`${member.name} (${member.role})`}
                          size="small"
                          variant="outlined"
                        />
                      ))}
                    </>
                  }
                />
              </ListItem>
            </Card>
          ))
        ) : (
          <Typography variant="body1" sx={{ textAlign: 'center', py: 4 }}>
            {error ? 'Unable to load parties' : 'No parties available'}
          </Typography>
        )}
      </List>

      <Dialog 
        open={detailsOpen} 
        onClose={() => setDetailsOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {selectedParty?.name} Details
        </DialogTitle>
        <DialogContent dividers>
          {selectedParty && (
            <Box>
              <Typography variant="h6" gutterBottom>Current State</Typography>
              <Typography paragraph>{selectedParty.currentState || 'No current state'}</Typography>

              <Typography variant="h6" gutterBottom>Plot Summary</Typography>
              <Typography paragraph>{selectedParty.plotSummary || 'No plot summary available'}</Typography>

              <Typography variant="h6" gutterBottom>Party Members</Typography>
              <List>
                {selectedParty.members.map((member) => (
                  <ListItem key={member.id}>
                    <ListItemText
                      primary={member.name}
                      secondary={`${member.role} - ${member.status}`}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailsOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
} 