import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Card,
  TextField,
  Typography,
  Switch,
  FormControlLabel,
  Snackbar,
  Alert,
  CircularProgress,
  Select,
  MenuItem,
  FormControl,
  InputLabel
} from '@mui/material';
import { configApi } from '../services/api';

interface Config {
  imageGeneration: {
    enabled: boolean;
    model: string;
    style: string;
    quality: string;
  };
  adventureSettings: {
    maxPartySize: number;
    turnTimeoutMinutes: number;
    autoEndEnabled: boolean;
  };
  systemPrompts: {
    adventureInit: string;
    sceneGeneration: string;
    decisionMaking: string;
  };
}

export default function Config() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Config>({
    imageGeneration: {
      enabled: false,
      model: 'dall-e-3',
      style: 'vivid',
      quality: 'standard'
    },
    adventureSettings: {
      maxPartySize: 4,
      turnTimeoutMinutes: 10,
      autoEndEnabled: true
    },
    systemPrompts: {
      adventureInit: '',
      sceneGeneration: '',
      decisionMaking: ''
    }
  });
  const [saveStatus, setSaveStatus] = useState<{
    open: boolean;
    severity: 'success' | 'error';
    message: string;
  }>({
    open: false,
    severity: 'success',
    message: ''
  });

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const response = await configApi.get();
      setConfig({
        imageGeneration: {
          enabled: response?.imageGeneration?.enabled ?? false,
          model: response?.imageGeneration?.model ?? 'dall-e-3',
          style: response?.imageGeneration?.style ?? 'vivid',
          quality: response?.imageGeneration?.quality ?? 'standard'
        },
        adventureSettings: {
          maxPartySize: response?.adventureSettings?.maxPartySize ?? 4,
          turnTimeoutMinutes: response?.adventureSettings?.turnTimeoutMinutes ?? 10,
          autoEndEnabled: response?.adventureSettings?.autoEndEnabled ?? true
        },
        systemPrompts: {
          adventureInit: response?.systemPrompts?.adventureInit ?? '',
          sceneGeneration: response?.systemPrompts?.sceneGeneration ?? '',
          decisionMaking: response?.systemPrompts?.decisionMaking ?? ''
        }
      });
    } catch (error) {
      console.error('Failed to load config:', error);
      setSaveStatus({
        open: true,
        severity: 'error',
        message: 'Failed to load configuration'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      const updatedConfig = await configApi.update(config);
      setConfig(updatedConfig);
      setSaveStatus({
        open: true,
        severity: 'success',
        message: 'Configuration saved successfully'
      });
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveStatus({
        open: true,
        severity: 'error',
        message: 'Failed to save configuration'
      });
    }
  };

  if (loading) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>Configuration</Typography>

      <Card sx={{ mb: 3, p: 2 }}>
        <Typography variant="h6" gutterBottom>Image Generation</Typography>
        <Box sx={{ pl: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={config.imageGeneration.enabled}
                onChange={(e) => setConfig({
                  ...config,
                  imageGeneration: {
                    ...config.imageGeneration,
                    enabled: e.target.checked
                  }
                })}
              />
            }
            label="Enable Image Generation"
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Model</InputLabel>
            <Select
              value={config.imageGeneration.model}
              label="Model"
              onChange={(e) => setConfig({
                ...config,
                imageGeneration: {
                  ...config.imageGeneration,
                  model: e.target.value
                }
              })}
            >
              <MenuItem value="dall-e-3">DALL-E 3</MenuItem>
              <MenuItem value="dall-e-2">DALL-E 2</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Style</InputLabel>
            <Select
              value={config.imageGeneration.style}
              label="Style"
              onChange={(e) => setConfig({
                ...config,
                imageGeneration: {
                  ...config.imageGeneration,
                  style: e.target.value
                }
              })}
            >
              <MenuItem value="vivid">Vivid</MenuItem>
              <MenuItem value="natural">Natural</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth>
            <InputLabel>Quality</InputLabel>
            <Select
              value={config.imageGeneration.quality}
              label="Quality"
              onChange={(e) => setConfig({
                ...config,
                imageGeneration: {
                  ...config.imageGeneration,
                  quality: e.target.value
                }
              })}
            >
              <MenuItem value="standard">Standard</MenuItem>
              <MenuItem value="hd">HD</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Card>

      <Card sx={{ mb: 3, p: 2 }}>
        <Typography variant="h6" gutterBottom>Adventure Settings</Typography>
        <Box sx={{ pl: 2 }}>
          <TextField
            type="number"
            fullWidth
            label="Max Party Size"
            value={config.adventureSettings.maxPartySize}
            onChange={(e) => setConfig({
              ...config,
              adventureSettings: {
                ...config.adventureSettings,
                maxPartySize: parseInt(e.target.value)
              }
            })}
            sx={{ mb: 2 }}
          />
          <TextField
            type="number"
            fullWidth
            label="Turn Timeout (minutes)"
            value={config.adventureSettings.turnTimeoutMinutes}
            onChange={(e) => setConfig({
              ...config,
              adventureSettings: {
                ...config.adventureSettings,
                turnTimeoutMinutes: parseInt(e.target.value)
              }
            })}
            sx={{ mb: 2 }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={config.adventureSettings.autoEndEnabled}
                onChange={(e) => setConfig({
                  ...config,
                  adventureSettings: {
                    ...config.adventureSettings,
                    autoEndEnabled: e.target.checked
                  }
                })}
              />
            }
            label="Enable Auto-End for Inactive Parties"
          />
        </Box>
      </Card>

      <Card sx={{ mb: 3, p: 2 }}>
        <Typography variant="h6" gutterBottom>System Prompts</Typography>
        <Box sx={{ pl: 2 }}>
          <TextField
            fullWidth
            multiline
            rows={4}
            label="Adventure Initialization"
            value={config.systemPrompts.adventureInit}
            onChange={(e) => setConfig({
              ...config,
              systemPrompts: {
                ...config.systemPrompts,
                adventureInit: e.target.value
              }
            })}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            multiline
            rows={4}
            label="Scene Generation"
            value={config.systemPrompts.sceneGeneration}
            onChange={(e) => setConfig({
              ...config,
              systemPrompts: {
                ...config.systemPrompts,
                sceneGeneration: e.target.value
              }
            })}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            multiline
            rows={4}
            label="Decision Making"
            value={config.systemPrompts.decisionMaking}
            onChange={(e) => setConfig({
              ...config,
              systemPrompts: {
                ...config.systemPrompts,
                decisionMaking: e.target.value
              }
            })}
          />
        </Box>
      </Card>

      <Button 
        variant="contained" 
        onClick={handleSave}
        size="large"
      >
        Save Configuration
      </Button>

      <Snackbar
        open={saveStatus.open}
        autoHideDuration={6000}
        onClose={() => setSaveStatus({ ...saveStatus, open: false })}
      >
        <Alert 
          onClose={() => setSaveStatus({ ...saveStatus, open: false })} 
          severity={saveStatus.severity}
        >
          {saveStatus.message}
        </Alert>
      </Snackbar>
    </Box>
  );
} 