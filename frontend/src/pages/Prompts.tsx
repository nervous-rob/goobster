import { useState, useEffect } from 'react';
import { 
  Box, 
  Button, 
  Card, 
  IconButton, 
  List, 
  ListItem, 
  ListItemText, 
  TextField, 
  Typography,
  Snackbar,
  Alert
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { promptsApi } from '../services/api';

interface Prompt {
  id: number;
  text: string;
  label?: string;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newPrompt, setNewPrompt] = useState({ text: '', label: '' });
  const [error, setError] = useState<{
    open: boolean;
    message: string;
  }>({
    open: false,
    message: ''
  });

  useEffect(() => {
    loadPrompts();
  }, []);

  const loadPrompts = async () => {
    try {
      const response = await promptsApi.getAll();
      setPrompts(response.data);
    } catch (error) {
      console.error('Failed to load prompts:', error);
      setError({
        open: true,
        message: 'Failed to load prompts'
      });
    }
  };

  const handleCreate = async () => {
    try {
      await promptsApi.create(newPrompt);
      setNewPrompt({ text: '', label: '' });
      loadPrompts();
    } catch (error) {
      console.error('Failed to create prompt:', error);
      setError({
        open: true,
        message: 'Failed to create prompt'
      });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await promptsApi.delete(id);
      loadPrompts();
    } catch (error: any) {
      console.error('Failed to delete prompt:', error);
      // Check if it's our specific error about active conversations
      const errorMessage = error.response?.data?.message || 'Failed to delete prompt';
      setError({
        open: true,
        message: errorMessage
      });
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>Prompts</Typography>
      
      <Card sx={{ mb: 3, p: 2 }}>
        <TextField
          fullWidth
          multiline
          rows={3}
          label="New Prompt Text"
          value={newPrompt.text}
          onChange={(e) => setNewPrompt({ ...newPrompt, text: e.target.value })}
          sx={{ mb: 2 }}
        />
        <TextField
          fullWidth
          label="Label (optional)"
          value={newPrompt.label}
          onChange={(e) => setNewPrompt({ ...newPrompt, label: e.target.value })}
          sx={{ mb: 2 }}
        />
        <Button 
          variant="contained" 
          onClick={handleCreate}
          disabled={!newPrompt.text.trim()}
        >
          Create Prompt
        </Button>
      </Card>

      <List>
        {prompts.map((prompt) => (
          <ListItem
            key={prompt.id}
            sx={{ 
              bgcolor: 'background.paper',
              mb: 1,
              borderRadius: 1,
              boxShadow: 1
            }}
            secondaryAction={
              <IconButton edge="end" onClick={() => handleDelete(prompt.id)}>
                <DeleteIcon />
              </IconButton>
            }
          >
            <ListItemText 
              primary={prompt.text}
              secondary={prompt.label}
              primaryTypographyProps={{
                sx: { whiteSpace: 'pre-wrap' }
              }}
            />
          </ListItem>
        ))}
      </List>

      <Snackbar
        open={error.open}
        autoHideDuration={6000}
        onClose={() => setError({ ...error, open: false })}
      >
        <Alert 
          onClose={() => setError({ ...error, open: false })} 
          severity="error"
          sx={{ width: '100%' }}
        >
          {error.message}
        </Alert>
      </Snackbar>
    </Box>
  );
} 