import express from 'express';
import path from 'path';
import fs from 'fs/promises';

const router = express.Router();
const configPath = path.join(__dirname, '../../../config.json');

// Get configuration
router.get('/', async (req, res) => {
  try {
    const config = require(configPath);
    // Remove sensitive information
    const safeConfig = {
      ...config,
      token: undefined,
      openaiKey: undefined,
      azureSql: undefined
    };
    res.json(safeConfig);
  } catch (error) {
    console.error('Failed to fetch configuration:', error);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Update configuration
router.put('/', async (req, res) => {
  try {
    const currentConfig = require(configPath);
    const updatedConfig = {
      ...currentConfig,
      imageGeneration: {
        ...currentConfig.imageGeneration,
        ...req.body.imageGeneration
      },
      adventureSettings: {
        ...currentConfig.adventureSettings,
        ...req.body.adventureSettings
      },
      systemPrompts: {
        ...currentConfig.systemPrompts,
        ...req.body.systemPrompts
      }
    };

    // Preserve sensitive information
    updatedConfig.token = currentConfig.token;
    updatedConfig.openaiKey = currentConfig.openaiKey;
    updatedConfig.azureSql = currentConfig.azureSql;

    await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2));
    
    // Return the safe version of the config
    const safeConfig = {
      ...updatedConfig,
      token: undefined,
      openaiKey: undefined,
      azureSql: undefined
    };
    res.json(safeConfig);
  } catch (error) {
    console.error('Failed to update configuration:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

export default router; 